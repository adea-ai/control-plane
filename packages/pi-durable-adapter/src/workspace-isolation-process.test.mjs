import { expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
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

async function sends(directory) {
  return (await readFile(join(directory, 'process-evidence.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.boundary === 'native_send')
}

// Adapter-store isolation only; product authorization and profile restore have separate owners.
test('distinct workspace processes retain isolated input receipts despite shared idempotency keys and one process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workspace-process-'))
  const firstDirectory = join(directory, 'first')
  const secondDirectory = join(directory, 'second')
  const workers = []
  const adapters = []
  try {
    const first = processAdapterChild(firstDirectory, 'pending_input')
    workers.push(first)
    const a = await first.boundary
    const second = processAdapterChild(secondDirectory, 'pending_input', 'two')
    workers.push(second)
    const b = await second.boundary
    expect(a.state).toBe('awaiting_input')
    expect(b.state).toBe('awaiting_input')
    expect(a.record.detail.pendingInput).toBe(interactionId)
    expect(b.record.detail.pendingInput).toBe(interactionId)
    expect(a.handle.handleId).not.toBe(b.handle.handleId)
    expect(a.handle.externalSessionId).not.toBe(b.handle.externalSessionId)
    const setupA = processAdapterFixture(firstDirectory)
    const setupB = processAdapterFixture(secondDirectory, 'resume', undefined, 'two')
    expect(setupA.request.idempotencyKey).toBe(setupB.request.idempotencyKey)
    expect(setupA.request.executionPlan.correlation.workspaceId).not.toBe(
      setupB.request.executionPlan.correlation.workspaceId
    )
    expect(setupA.request.executionPlan.contentDigest).not.toBe(
      setupB.request.executionPlan.contentDigest
    )
    expect(setupA.request.attemptBudget.workspaceId).toBe(
      setupA.request.executionPlan.correlation.workspaceId
    )
    expect(setupB.request.attemptBudget.workspaceId).toBe(
      setupB.request.executionPlan.correlation.workspaceId
    )
    expect((await stopProcessAdapterChild(first)).signal).toBe('SIGKILL')

    const adapterA = new PiDurableRuntimeAdapter(setupA.options)
    adapters.push(adapterA)
    const adapterB = new PiDurableRuntimeAdapter(setupB.options)
    adapters.push(adapterB)
    expect(await adapterA.start(setupA.request)).toEqual(a.handle)
    expect(await adapterB.start(setupB.request)).toEqual(b.handle)
    const retainedA = adapterA.journal.list()
    const retainedB = adapterB.journal.list()
    expect(retainedA).toEqual([a.record])
    expect(retainedB).toEqual([b.record])
    const sentA = await sends(firstDirectory)
    const sentB = await sends(secondDirectory)
    expect(sentA).toHaveLength(1)
    expect(sentB).toHaveLength(1)
    expect(sentA[0].userInputs).toEqual(['Persistent adapter question'])
    expect(sentB[0].userInputs).toEqual(['Workspace two question'])
    for (const [adapter, foreign] of [
      [adapterA, b.handle],
      [adapterB, a.handle],
    ]) {
      await expect(adapter.status(foreign)).rejects.toThrow('HANDLE_NOT_FOUND')
      await expect(events(adapter, foreign)).rejects.toThrow('HANDLE_NOT_FOUND')
      await expect(adapter.submitInput(foreign, processInput)).rejects.toThrow('HANDLE_NOT_FOUND')
      await expect(adapter.awaitInput(foreign, interactionId)).rejects.toThrow('HANDLE_NOT_FOUND')
    }
    // Knowing the local handle ID does not make the other session/attempt a valid handle.
    await expect(adapterB.status({ ...a.handle, handleId: b.handle.handleId })).rejects.toThrow(
      'PI_HANDLE_MISMATCH'
    )
    expect(adapterA.journal.list()).toEqual(retainedA)
    expect(adapterB.journal.list()).toEqual(retainedB)
    expect(await events(adapterA, a.handle)).toEqual(a.events)
    expect(await events(adapterB, b.handle)).toEqual(b.events)
    expect(await sends(firstDirectory)).toEqual(sentA)
    expect(await sends(secondDirectory)).toEqual(sentB)

    await adapterA.submitInput(a.handle, processInput)
    await adapterA.drain()
    expect((await adapterA.status(a.handle)).state).toBe('completed')
    expect(adapterB.journal.list()).toEqual(retainedB)
    expect((await adapterB.status(b.handle)).state).toBe('awaiting_input')
    expect(await events(adapterB, b.handle)).toEqual(b.events)
    expect(await sends(secondDirectory)).toEqual(sentB)
    const completedA = adapterA.journal.list()
    const eventsA = await events(adapterA, a.handle)
    const sendsA = await sends(firstDirectory)
    expect(sendsA).toHaveLength(2)

    // The key already accepted in A must execute B's own pending turn, not replay A's receipt.
    await adapterB.submitInput(b.handle, processInput)
    await adapterB.drain()
    const statusB = await adapterB.status(b.handle)
    expect(statusB.state).toBe('completed')
    expect(statusB.result.output).toEqual({ text: 'Workspace two answer' })
    expect(adapterA.journal.list()).toEqual(completedA)
    expect(await events(adapterA, a.handle)).toEqual(eventsA)
    expect(await sends(firstDirectory)).toEqual(sendsA)
    const sendsB = await sends(secondDirectory)
    expect(sendsB).toHaveLength(2)
    expect(sendsA[1].userInputs.at(-1)).toBe(processInput.text)
    expect(sendsB[1].userInputs).toEqual(['Workspace two question', processInput.text])
    expect(sendsB[1].inferenceKey).not.toBe(sendsA[1].inferenceKey)
    const completedB = adapterB.journal.list()
    expect(completedB).toHaveLength(1)
    expect(completedB[0].admission.request.attemptBudget.workspaceId).toBe(
      setupB.request.attemptBudget.workspaceId
    )
    expect(completedA[0].admission.request.attemptBudget.workspaceId).toBe(
      setupA.request.attemptBudget.workspaceId
    )
    const eventsB = await events(adapterB, b.handle)
    expect(eventsB.slice(0, b.events.length)).toEqual(b.events)
    expect(new Set(eventsB.map((event) => event.sequence)).size).toBe(eventsB.length)
    const cursor = b.events.at(-1).sequence
    expect(await events(adapterB, b.handle, cursor)).toEqual(
      eventsB.filter((event) => event.sequence > cursor)
    )
    await adapterB.submitInput(b.handle, processInput)
    expect(adapterB.journal.list()).toEqual(completedB)
    expect(await sends(secondDirectory)).toEqual(sendsB)
    expect(second.child.exitCode).toBeNull()
    expect(second.child.signalCode).toBeNull()
  } finally {
    await cleanupProcessAdapterFixtures(directory, workers, adapters)
  }
}, 15000)
