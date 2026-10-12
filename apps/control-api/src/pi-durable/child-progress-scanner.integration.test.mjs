import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodePiDurableRuntime } from '../../../../packages/pi-durable-adapter/src/composition.ts'
import {
  governedFixture,
  id,
} from '../../../../packages/pi-durable-adapter/src/governed-delegation.fixture.mjs'
import { PiDurableChildProgressScanner } from './child-progress-scanner.ts'

test('native approval interaction flows from the real adapter into child progress scanning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-scanner-native-approval-'))
  const setup = await governedFixture(directory)
  let runtime
  try {
    runtime = await createNodePiDurableRuntime(setup.options)
    const handle = await runtime.adapter.start(setup.request)
    await runtime.adapter.drain()
    const status = await runtime.adapter.status(handle)
    expect(status.state).toBe('awaiting_input')

    const compiledRequest = JSON.parse(
      setup.database.prepare('SELECT request FROM compiled').get().request
    )
    const interactionId = compiledRequest.approval.interactionId
    expect(setup.state.outcomes[0]).toMatchObject({
      state: 'awaiting_approval',
      interactionId,
    })
    const events = []
    for await (const event of runtime.adapter.progress(handle, { afterSequence: 0 }))
      events.push(event)
    const interactionEvent = events.find((event) => event.type === 'interaction')
    expect(interactionEvent).toMatchObject({
      type: 'interaction',
      data: { interactionId, kind: 'approval', state: 'awaiting_input' },
    })

    const identity = {
      schemaVersion: 'delegation-runtime-admission/v1',
      parentExecutionId: id('exe').replace(/G$/, 'H'),
      parentAttemptId: id('att').replace(/G$/, 'H'),
      delegationId: id('dlg').replace(/G$/, 'H'),
      childAttemptId: handle.attemptId,
    }
    const retainedChild = { identity, handle, canonicalState: 'running' }
    const progress = []
    const scanner = new PiDurableChildProgressScanner({
      listRetainedChildren: async () => [retainedChild],
      assertCurrent: async (record) => expect(record.identity).toEqual(identity),
      retainTerminalResult: async () => {
        throw new Error('UNEXPECTED_TERMINAL_RESULT')
      },
      bridge: {
        recordProgress: async (recordIdentity, input) => {
          expect(recordIdentity).toEqual(identity)
          progress.push(input)
        },
      },
      now: () => status.observedAt,
    })

    expect(await scanner.scan(runtime.adapter)).toMatchObject({ published: 1, blocked: [] })
    expect(progress).toEqual([
      {
        delegationId: identity.delegationId,
        childAttemptId: identity.childAttemptId,
        observedAt: status.observedAt,
        state: 'awaiting_input',
        interaction: { interactionId, kind: 'approval' },
      },
    ])
  } finally {
    await runtime?.close()
    setup.close()
    await rm(directory, { recursive: true, force: true })
  }
})
