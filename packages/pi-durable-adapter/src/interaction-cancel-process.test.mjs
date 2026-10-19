import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import {
  cleanupProcessAdapterFixtures,
  interactionId,
  processAdapterChild,
  processAdapterFixture,
  processInput,
  stopProcessAdapterChild,
} from './adapter-process.fixture.mjs'

async function events(adapter, handle, afterSequence = 0) {
  const result = []
  for await (const event of adapter.progress(handle, { afterSequence })) result.push(event)
  return result
}

async function evidence(directory) {
  return (await readFile(join(directory, 'process-evidence.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

// P1 only: cancellation coverage is deliberately outside this package's admitted scope.
test('pending human input and its accepted follow-up survive distinct SIGKILL boundaries without duplicate sends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-input-process-'))
  const workers = []
  let adapter
  try {
    const pending = processAdapterChild(directory, 'pending_input')
    workers.push(pending)
    const retained = await pending.boundary
    expect(retained.state).toBe('awaiting_input')
    expect(retained.record.detail.pendingInput).toBe(interactionId)
    expect((await stopProcessAdapterChild(pending)).signal).toBe('SIGKILL')

    const setup = processAdapterFixture(directory)
    adapter = new PiDurableRuntimeAdapter(setup.options)
    const handle = await adapter.start(setup.request)
    expect(handle).toEqual(retained.handle)
    expect(adapter.journal.get(handle.handleId)).toEqual(retained.record)
    const beforeWrongInput = adapter.journal.get(handle.handleId)
    await expect(
      adapter.submitInput(handle, {
        ...processInput,
        interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
      })
    ).rejects.toThrow('PI_INPUT_NOT_PENDING')
    expect(adapter.journal.get(handle.handleId)).toEqual(beforeWrongInput)
    expect(await events(adapter, handle)).toEqual(retained.events)
    await adapter.close()
    adapter = undefined

    const accepted = processAdapterChild(directory, 'input_before_native_dispatch')
    workers.push(accepted)
    const interrupted = await accepted.boundary
    expect(interrupted.handle).toEqual(handle)
    expect(interrupted.record.detail.turn).toEqual({
      requestId: `pi-input:${handle.attemptId}:${processInput.idempotencyKey}`,
      input: processInput.text,
    })
    expect(interrupted.record.detail.actions[processInput.idempotencyKey]).toMatch(
      /^sha256:[a-f0-9]{64}$/
    )
    expect(interrupted.events.slice(0, retained.events.length)).toEqual(retained.events)
    const beforeRecovery = await evidence(directory)
    expect(beforeRecovery.filter((entry) => entry.boundary === 'native_send')).toHaveLength(1)
    const followUp = beforeRecovery
      .filter((entry) => entry.boundary === 'before_native_dispatch')
      .at(-1)
    expect(followUp.inferenceKey).toContain(processInput.idempotencyKey)
    expect((await stopProcessAdapterChild(accepted)).signal).toBe('SIGKILL')

    const recovery = processAdapterFixture(directory, 'safe_resume')
    adapter = new PiDurableRuntimeAdapter(recovery.options)
    expect(await adapter.start(recovery.request)).toEqual(handle)
    const pendingRecovery = adapter.journal.get(handle.handleId)
    await adapter.submitInput(handle, processInput)
    expect(adapter.journal.get(handle.handleId)).toEqual(pendingRecovery)
    await expect(
      adapter.submitInput(handle, { ...processInput, text: 'Changed input' })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    expect(adapter.journal.get(handle.handleId)).toEqual(pendingRecovery)
    await adapter.reconcile(handle)
    await adapter.drain()
    const completed = await adapter.status(handle)
    expect(completed.state).toBe('completed')
    expect(completed.result.output).toEqual({ text: 'Restarted adapter answer' })
    const completedEvents = await events(adapter, handle)
    expect(completedEvents.slice(0, interrupted.events.length)).toEqual(interrupted.events)
    expect(new Set(completedEvents.map((event) => event.sequence)).size).toBe(
      completedEvents.length
    )
    expect(completedEvents.filter((event) => event.type === 'interaction')).toHaveLength(1)
    const sends = (await evidence(directory)).filter((entry) => entry.boundary === 'native_send')
    expect(sends).toHaveLength(2)
    expect(sends[0].userInputs).toEqual(['Persistent adapter question'])
    expect(sends[1].userInputs.at(-1)).toBe(processInput.text)
    expect(sends[1].inferenceKey).toBe(followUp.inferenceKey)
    expect(sends[1].inferenceKey).not.toBe(sends[0].inferenceKey)
    const completedRecord = adapter.journal.get(handle.handleId)
    await adapter.close()

    adapter = new PiDurableRuntimeAdapter(recovery.options)
    expect(await adapter.start(recovery.request)).toEqual(handle)
    expect((await adapter.submitInput(handle, processInput)).state).toBe('completed')
    expect(adapter.journal.get(handle.handleId)).toEqual(completedRecord)
    const cursor = retained.events.at(-1).sequence
    expect(await events(adapter, handle, cursor)).toEqual(
      completedEvents.filter((event) => event.sequence > cursor)
    )
    expect((await evidence(directory)).filter((entry) => entry.boundary === 'native_send')).toEqual(
      sends
    )
  } finally {
    await cleanupProcessAdapterFixtures(directory, workers, [adapter])
  }
}, 15000)

// Hold real inference authorization; always release it so this regression cannot strand its own work.
test('cleanup bounds a close waiting on active work, attempts every close, and preserves retained state after a late close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-held-close-regression-'))
  const marker = join(directory, 'retained-state')
  let adapter, release, cleanupOutcome
  let healthyCloses = 0
  try {
    await writeFile(marker, 'retained')
    const setup = processAdapterFixture(directory)
    let entered
    const atBoundary = new Promise((resolve) => {
      entered = resolve
    })
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    const authorize = setup.options.authorizeInference
    setup.options.authorizeInference = async (...args) => {
      entered()
      await barrier
      return authorize(...args)
    }
    adapter = new PiDurableRuntimeAdapter(setup.options)
    await adapter.start(setup.request)
    await atBoundary
    cleanupOutcome = cleanupProcessAdapterFixtures(
      directory,
      [],
      [
        adapter,
        {
          async close() {
            healthyCloses++
          },
        },
      ],
      { closeTimeoutMs: 20 }
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    )
    let timer
    const observed = await Promise.race([
      cleanupOutcome,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), 100)
      }),
    ]).finally(() => clearTimeout(timer))
    expect(healthyCloses).toBe(1)
    expect(observed?.ok).toBe(false)
    expect(observed.error).toBeInstanceOf(AggregateError)
    expect(
      observed.error.errors.some((error) => /Adapter close unconfirmed/.test(error.message))
    ).toBe(true)
    expect(await readFile(marker, 'utf8')).toBe('retained')
    release()
    await adapter.close()
    expect(await readFile(marker, 'utf8')).toBe('retained')
  } finally {
    release?.()
    await cleanupOutcome
    await adapter?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
