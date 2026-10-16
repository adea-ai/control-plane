import { expect, test } from 'bun:test'
import {
  createProductionChildRuntimeBridge,
  productionChildBridgePorts,
} from '../apps/control-api/src/pi-durable/production-child-bridge.ts'
import { withChildMappingRecovery } from './pi-durable-child-mapping-recovery.fixture.mjs'

// The production builder's bridge on the real SQLite records, lifecycle, plans and publisher. Every
// effect port (runtime start, authority read, reservation, funding, binding) throws, so these tests
// prove that session recovery, progress and terminal replay reach only their own ports.
const builderOptionsFor = (x) => {
  const forbidden = async () => {
    throw new Error('TEST_RECOVERY_CALLED_EFFECT_OR_SPEND')
  }
  const built = {
    records: x.options.records,
    lifecycle: x.options.lifecycle,
    plans: x.options.plans,
    delegations: x.options.delegations,
    events: x.options.terminalPublisher,
    runtimeConnectionId: x.options.runtimeConnectionId,
    context: {
      authority: { readRecord: forbidden },
      modelBinding: forbidden,
      runtime: { start: forbidden },
      usageOutcomes: () => {
        throw new Error('TEST_RECOVERY_TOUCHED_COST_STATE')
      },
    },
    reserveBudget: forbidden,
    fundChildAttempt: forbidden,
    receiptReadAuthority: x.options.receiptReadAuthority,
    nativeReceiptReader: x.options.nativeReceiptReader,
  }
  return built
}

test(
  'the production builder recovers a lost session mapping without start, reservation or funding',
  () =>
    withChildMappingRecovery(async (x) => {
      const bridge = createProductionChildRuntimeBridge(builderOptionsFor(x))
      const first = await bridge.recoverChildSession(x.f.identity)
      expect(first.mapping.externalSessionId).toBe(x.handle.externalSessionId)
      expect(first.handle).toEqual(x.handle)
      // Repeating, and a second bridge built over the same ports (a reopen), converge on one mapping.
      expect(await bridge.recoverChildSession(x.f.identity)).toEqual(first)
      const reopened = createProductionChildRuntimeBridge(builderOptionsFor(x))
      expect((await reopened.recoverChildSession(x.f.identity)).mapping).toEqual(first.mapping)
      await x.assertNoOtherEffects()
    }),
  30000
)

test(
  'the production builder records progress and replays terminal publication exactly once',
  () =>
    withChildMappingRecovery(async (x) => {
      const bridge = createProductionChildRuntimeBridge(builderOptionsFor(x))
      const ids = x.f.ids
      const progress = (state, extra = {}) =>
        bridge.recordProgress(x.f.identity, {
          delegationId: ids.delegationId,
          childAttemptId: ids.childAttemptId,
          state,
          observedAt: '2026-08-25T18:03:00.000Z',
          ...extra,
        })
      await progress('running')
      await progress('completed', { terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG' })
      const completions = async () =>
        (await x.f.storage.events.list()).filter((event) => event.type === 'delegation.completed')
      const published = await completions()
      expect(published).toHaveLength(1)
      expect((await x.records.get(ids.delegationId)).terminalPublication.status).toBe('published')

      // Replay (twice, and from a rebuilt bridge) delivers nothing new and refuses a foreign parent.
      const reopened = createProductionChildRuntimeBridge(builderOptionsFor(x))
      await bridge.recoverTerminalPublication(x.f.identity)
      await reopened.recoverTerminalPublication(x.f.identity)
      await expect(
        reopened.recoverTerminalPublication({
          ...x.f.identity,
          parentAttemptId: x.f.identity.childAttemptId,
        })
      ).rejects.toThrow('DELEGATION_RUNTIME_ADMISSION_DENIED')
      expect(await completions()).toEqual(published)
    }),
  30000
)

test(
  'the production builder refuses a revoked receipt read authority on recovery and starts nothing',
  () =>
    withChildMappingRecovery(async (x) => {
      const bridge = createProductionChildRuntimeBridge(builderOptionsFor(x))
      x.control.allowed = false
      await expect(bridge.recoverChildSession(x.f.identity)).rejects.toThrow(
        'TEST_RECEIPT_READ_REVOKED'
      )
      await x.assertNoOtherEffects()
    }),
  30000
)

// Each port path the bridge calls on the real SQLite ports is guarded at build time, so a port a
// recovery path needs can never be discovered missing only when recovery runs.
const guarded = Object.entries(productionChildBridgePorts).flatMap(([port, names]) =>
  names.map((name) => [port, name])
)
const realPorts = new Set(['records', 'lifecycle', 'plans', 'delegations', 'events'])
test.each(guarded.filter(([port]) => realPorts.has(port)))(
  'refuses to build without %s.%s on the real ports',
  (port, name) =>
    withChildMappingRecovery(async (x) => {
      const built = builderOptionsFor(x)
      // A real SQLite repository keeps its methods on the prototype, so mask the one under test.
      built[port] = new Proxy(built[port], {
        get: (target, key) => (key === name ? undefined : Reflect.get(target, key)),
      })
      expect(() => createProductionChildRuntimeBridge(built)).toThrow(
        'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
      )
    }),
  30000
)
