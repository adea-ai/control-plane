import { expect, test } from 'bun:test'
import { CanonicalDelegationRuntimeBridge } from '@control-plane/orchestration'
import {
  createProductionChildRuntimeBridge,
  productionChildBridgePorts,
} from './production-child-bridge.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const runtimeConnectionId = id('rtc')
const admission = {
  identity: {
    schemaVersion: 'delegation-runtime-admission/v1',
    parentExecutionId: id('exe'),
    parentAttemptId: id('att'),
    delegationId: id('dlg'),
    childAttemptId: id('att').replace(/G$/, 'H'),
  },
  record: { childExecutionId: id('exe').replace(/G$/, 'H') },
}
admission.plan = { constraints: { limits: { budget: { maximumMicrounits: 5_000_000 } } } }
const budget = {
  schemaVersion: 1,
  workspaceId: id('wsp'),
  executionId: admission.record.childExecutionId,
  attemptId: admission.identity.childAttemptId,
  executionPlanId: id('pln'),
  executionPlanDigest: `sha256:${'a'.repeat(64)}`,
  reservationKey: `runtime-attempt:${admission.identity.childAttemptId}`,
  currency: 'USD',
  maximumMicrounits: 1_000_000,
  maximumTokens: 100_000,
}
function memoryOutcomes() {
  const stored = new Map()
  const saves = []
  return {
    saves,
    stored,
    for: (delegationId) => ({
      load: async () => stored.get(delegationId),
      save: async (record) => {
        saves.push(record.revision)
        stored.set(delegationId, structuredClone(record))
      },
    }),
  }
}
const binding = { binding: 'child-model-binding' }

function options(overrides = {}) {
  const outcomes = memoryOutcomes()
  const calls = []
  const log = (name, value) => {
    calls.push(name)
    return value
  }
  const base = {
    records: {
      get: async () => undefined,
      retainChildRuntimeStart: async () => {},
      getChildRuntimeStart: async () => undefined,
      bindRecoveredChildSession: async () => ({}),
      bindChildSession: async () => ({}),
      recoverTerminalPublication: async () => ({}),
    },
    lifecycle: {
      getExecution: async () => undefined,
      repository: { getAttempt: async () => undefined },
    },
    plans: { get: async () => undefined },
    delegations: { recordChildProgress: async () => ({}) },
    events: { publish: async () => {} },
    runtimeConnectionId,
    context: {
      authority: {
        readRecord: async (input) => {
          log('authority', input)
          return {}
        },
      },
      modelBinding: async (input) => {
        log('binding', input)
        return binding
      },
      runtime: { start: async (request) => log('start', request) },
      usageOutcomes: outcomes.for,
    },
    reserveBudget: async () => log('reserve', budget),
    fundChildAttempt: async (input) => {
      log('fund', input)
    },
  }
  return { calls, outcomes, options: { ...base, ...overrides } }
}

test('builds the canonical bridge with terminal replay always configured', () => {
  const { options: built } = options()
  const bridge = createProductionChildRuntimeBridge(built)
  expect(bridge).toBeInstanceOf(CanonicalDelegationRuntimeBridge)
  expect(bridge.options.childReceipts).toBe(built.records)
  expect(bridge.options.terminalPublisher).toBe(built.events)
  expect(bridge.options.runtimeConnectionId).toBe(runtimeConnectionId)
})

test.each([
  ['records', { records: undefined }],
  ['lifecycle', { lifecycle: undefined }],
  ['plans', { plans: undefined }],
  ['child progress service', { delegations: undefined }],
  ['terminal publisher', { events: undefined }],
  ['budget reservation', { reserveBudget: undefined }],
  ['child funding', { fundChildAttempt: undefined }],
])('refuses to build without %s', (_name, override) => {
  expect(() => createProductionChildRuntimeBridge(options(override).options)).toThrow(
    'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
  )
})

test.each([
  ['authority', { authority: undefined }],
  ['model binding', { modelBinding: undefined }],
  ['runtime', { runtime: undefined }],
  ['cost-state store', { usageOutcomes: undefined }],
])('refuses to build without the composition %s', (_name, override) => {
  const { options: built } = options()
  built.context = { ...built.context, ...override }
  expect(() => createProductionChildRuntimeBridge(built)).toThrow(
    'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
  )
})

// Every method the bridge calls on a port, on its start, progress, session-recovery and terminal
// replay paths, is checked when the bridge is built: a missing one refuses with the same code.
test.each(
  Object.entries({
    records: productionChildBridgePorts.records,
    plans: productionChildBridgePorts.plans,
    delegations: productionChildBridgePorts.delegations,
    events: productionChildBridgePorts.events,
    lifecycle: productionChildBridgePorts.lifecycle,
  }).flatMap(([port, names]) => names.map((name) => [port, name]))
)('refuses to build when %s.%s is missing', (port, name) => {
  const { options: built } = options()
  built[port] = { ...built[port], [name]: undefined }
  expect(() => createProductionChildRuntimeBridge(built)).toThrow(
    'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
  )
})

test('refuses to build when the lifecycle repository cannot read an attempt', () => {
  for (const repository of [undefined, {}, { getAttempt: 'getAttempt' }]) {
    const { options: built } = options()
    built.lifecycle = { ...built.lifecycle, repository }
    expect(() => createProductionChildRuntimeBridge(built)).toThrow(
      'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
    )
  }
})

test('refuses to build when the composition authority cannot read a record', () => {
  const { options: built } = options()
  built.context = { ...built.context, authority: {} }
  expect(() => createProductionChildRuntimeBridge(built)).toThrow(
    'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
  )
})

const reader = { runtimeConnectionId, findExistingHandle: async () => undefined }
const receiptAuthority = {
  readerPrincipalId: 'reader',
  audienceRef: 'audience',
  now: () => '2026-10-15T00:00:00.000Z',
  assertQualified: async () => {},
  assertCurrent: async () => ({}),
}

test('refuses a receipt read authority without its native reader and the reverse', () => {
  expect(() =>
    createProductionChildRuntimeBridge(options({ receiptReadAuthority: receiptAuthority }).options)
  ).toThrow('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  expect(() =>
    createProductionChildRuntimeBridge(options({ nativeReceiptReader: reader }).options)
  ).toThrow('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  expect(() =>
    createProductionChildRuntimeBridge(
      options({ receiptReadAuthority: receiptAuthority, nativeReceiptReader: reader }).options
    )
  ).not.toThrow()
})

test.each([
  ...productionChildBridgePorts.receiptReadAuthority.map((name) => [
    `receiptReadAuthority.${name}`,
    {
      receiptReadAuthority: { ...receiptAuthority, [name]: undefined },
      nativeReceiptReader: reader,
    },
  ]),
  ...productionChildBridgePorts.nativeReceiptReader.map((name) => [
    `nativeReceiptReader.${name}`,
    {
      receiptReadAuthority: receiptAuthority,
      nativeReceiptReader: { ...reader, [name]: undefined },
    },
  ]),
  [
    'a native reader bound to another connection',
    {
      receiptReadAuthority: receiptAuthority,
      nativeReceiptReader: { ...reader, runtimeConnectionId: id('rtc').replace(/G$/, 'H') },
    },
  ],
])('refuses to build native receipt recovery with %s missing or unmatched', (_name, override) => {
  expect(() => createProductionChildRuntimeBridge(options(override).options)).toThrow(
    'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
  )
})

test('re-reads the composition authority for the exact child execution and attempt', async () => {
  const { calls, options: built } = options()
  const bridge = createProductionChildRuntimeBridge(built)
  await bridge.options.assertAuthority(admission)
  expect(calls).toEqual(['authority'])
})

test('reserves, derives the binding, then funds that reservation, in that order', async () => {
  const funded = []
  const { calls, options: built } = options({
    fundChildAttempt: async (input) => {
      funded.push(input)
    },
  })
  const bridge = createProductionChildRuntimeBridge(built)
  expect(await bridge.options.reserveBudget(admission)).toBe(budget)
  expect(calls).toEqual(['reserve', 'binding'])
  expect(funded).toEqual([{ budget, binding }])
})

test('records the estimate and the reservation as cost state before the binding and the funding', async () => {
  const { calls, outcomes, options: built } = options()
  const bridge = createProductionChildRuntimeBridge(built)
  await bridge.options.reserveBudget(admission)
  expect(calls).toEqual(['reserve', 'binding', 'fund'])
  const stored = outcomes.stored.get(admission.identity.delegationId)
  expect(stored.revision).toBe(1)
  const [entry] = stored.snapshot.entries
  expect(entry.outcome).toMatchObject({
    costState: 'reserved',
    estimated: { currency: 'USD', maximumMicrounits: 5_000_000 },
    reserved: { reservationKey: budget.reservationKey },
  })
  // Replaying the step (a recovery) records nothing new.
  await bridge.options.reserveBudget(admission)
  expect(outcomes.saves).toEqual([1])
})

test('cost state that cannot be recorded derives no binding and funds nothing', async () => {
  const funded = []
  const { calls, options: built } = options({
    fundChildAttempt: async (input) => {
      funded.push(input)
    },
  })
  built.context.usageOutcomes = () => ({
    load: async () => undefined,
    save: async () => {
      throw new Error('TEST_COST_STATE_UNAVAILABLE')
    },
  })
  const bridge = createProductionChildRuntimeBridge(built)
  await expect(bridge.options.reserveBudget(admission)).rejects.toThrow(
    'TEST_COST_STATE_UNAVAILABLE'
  )
  expect(calls).toEqual(['reserve'])
  expect(funded).toEqual([])
})

test('a refused reservation derives no binding and funds nothing', async () => {
  const funded = []
  const { calls, options: built } = options({
    reserveBudget: async () => {
      throw new Error('RUNTIME_BUDGET_ADMISSION_DENIED')
    },
    fundChildAttempt: async (input) => {
      funded.push(input)
    },
  })
  const bridge = createProductionChildRuntimeBridge(built)
  await expect(bridge.options.reserveBudget(admission)).rejects.toThrow(
    'RUNTIME_BUDGET_ADMISSION_DENIED'
  )
  expect(calls).toEqual([])
  expect(funded).toEqual([])
})

test('a binding that cannot be derived funds nothing', async () => {
  const funded = []
  const { options: built } = options({
    fundChildAttempt: async (input) => {
      funded.push(input)
    },
  })
  built.context.modelBinding = async () => {
    throw new Error('PI_CHILD_MODEL_AUTHORITY_DENIED')
  }
  const bridge = createProductionChildRuntimeBridge(built)
  await expect(bridge.options.reserveBudget(admission)).rejects.toThrow(
    'PI_CHILD_MODEL_AUTHORITY_DENIED'
  )
  expect(funded).toEqual([])
})

test('a funding record that is refused fails the reservation step, so nothing starts', async () => {
  const { calls, options: built } = options({
    fundChildAttempt: async () => {
      throw new Error('CHILD_FUNDING_SOURCE_UNAVAILABLE')
    },
  })
  const bridge = createProductionChildRuntimeBridge(built)
  await expect(bridge.options.reserveBudget(admission)).rejects.toThrow(
    'CHILD_FUNDING_SOURCE_UNAVAILABLE'
  )
  expect(calls).not.toContain('start')
})

test('the runtime start is the composition adapter, resolved when called', async () => {
  const { calls, options: built } = options()
  const bridge = createProductionChildRuntimeBridge(built)
  expect(calls).toEqual([])
  const request = { attemptId: admission.identity.childAttemptId }
  await bridge.options.runtime.start(request)
  expect(calls).toEqual(['start'])
})
