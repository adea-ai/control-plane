import { expect, test } from 'bun:test'
import { CanonicalDelegationRuntimeBridge } from '@control-plane/orchestration'
import { createProductionChildRuntimeBridge } from './production-child-bridge.ts'

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
const budget = {
  executionId: admission.record.childExecutionId,
  attemptId: admission.identity.childAttemptId,
}
const binding = { binding: 'child-model-binding' }

function options(overrides = {}) {
  const calls = []
  const log = (name, value) => {
    calls.push(name)
    return value
  }
  const base = {
    records: {
      get: async () => undefined,
      retainChildRuntimeStart: async () => {},
      bindChildSession: async () => ({}),
    },
    lifecycle: { getExecution: async () => undefined },
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
    },
    reserveBudget: async () => log('reserve', budget),
    fundChildAttempt: async (input) => {
      log('fund', input)
    },
  }
  return { calls, options: { ...base, ...overrides } }
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
  ['record receipts', { records: { get: async () => undefined } }],
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
])('refuses to build without the composition %s', (_name, override) => {
  const { options: built } = options()
  built.context = { ...built.context, ...override }
  expect(() => createProductionChildRuntimeBridge(built)).toThrow(
    'PI_PRODUCTION_CHILD_BINDING_REQUIRED'
  )
})

test('refuses a receipt read authority without its native reader and the reverse', () => {
  const reader = { runtimeConnectionId, findExistingHandle: async () => undefined }
  const authority = {
    readerPrincipalId: 'reader',
    audienceRef: 'audience',
    now: () => '2026-10-15T00:00:00.000Z',
    assertQualified: async () => {},
    assertCurrent: async () => ({}),
  }
  expect(() =>
    createProductionChildRuntimeBridge(options({ receiptReadAuthority: authority }).options)
  ).toThrow('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  expect(() =>
    createProductionChildRuntimeBridge(options({ nativeReceiptReader: reader }).options)
  ).toThrow('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  expect(() =>
    createProductionChildRuntimeBridge(
      options({ receiptReadAuthority: authority, nativeReceiptReader: reader }).options
    )
  ).not.toThrow()
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
