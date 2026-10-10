import { test, expect } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodePiDurableLeadAdmission, deterministicPiLeadIntentIds } from './node-admission.ts'
import { fencedOperationPolicy, parseLeadProductFence } from '../models/lead-product-fence.ts'

// M18.01.3 pinned rollback-fence consumer (root-approved v2; Adea #1244 proposal at c75e5a1).

const at = '2026-10-08T00:00:00.000Z'
const now = () => new Date(Date.parse(at) + 30 * 60_000).toISOString()
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const actorUserId = '2b1a7e26-8c3f-4f4f-9a1e-77d19b7d5e11'
const canonicalActor = `user:${actorUserId}`
const scopeRef = `adea-product:sha256:${'c'.repeat(64)}`
const caller = {
  kind: 'agent_hq_service',
  principalId: 'svc_adea',
  projectIds: [],
  scopes: ['execution:read', 'execution:cancel', 'execution:accept'],
  workspaceIds: [workspaceId],
}

const fenceV1 = (overrides = {}) => ({
  schemaVersion: 'pi-lead-intent-fence/v1',
  intentId,
  workspaceId,
  dispatchPermitted: false,
  rollbackFence: {
    fencedAt: at,
    reason: 'operator_intervention',
    actor: { kind: 'user', userId: actorUserId },
  },
  ...overrides,
})
const fenceV2 = (overrides = {}) => ({
  ...fenceV1(),
  schemaVersion: 'pi-lead-intent-fence/v2',
  authorityRevision: 7,
  canonicalActorPrincipalId: canonicalActor,
  scopeRef,
  allowedPrincipalIds: ['svc_adea', 'svc_pi-admission'],
  ...overrides,
})

const selectors = { workspaceId, intentId }

test('parseLeadProductFence validates v1 and v2 strictly with canonical freshness and identity', () => {
  expect(parseLeadProductFence(fenceV1(), selectors, () => Date.parse(now())).variant).toBe('v1')
  expect(parseLeadProductFence(fenceV2(), selectors, () => Date.parse(now())).variant).toBe('v2')
  // Future fencedAt is refused by CP's clock (no skew tolerance).
  expect(() =>
    parseLeadProductFence(
      fenceV1({
        rollbackFence: { ...fenceV1().rollbackFence, fencedAt: '2026-10-08T01:00:00.000Z' },
      }),
      selectors,
      () => Date.parse(now())
    )
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  // Non-canonical fencedAt (no round trip) is refused.
  expect(() =>
    parseLeadProductFence(
      fenceV1({
        rollbackFence: { ...fenceV1().rollbackFence, fencedAt: '2026-10-08T00:00:00+00:00' },
      }),
      selectors,
      () => Date.parse(now())
    )
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  // Identity mismatch is refused.
  expect(() =>
    parseLeadProductFence(
      fenceV1({ workspaceId: 'wsp_01JABCDEFG0123456789ABCDEFG' }),
      selectors,
      () => Date.parse(now())
    )
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  // Extra keys are refused by the strict schema (both variants).
  expect(() =>
    parseLeadProductFence(fenceV1({ extra: true }), selectors, () => Date.parse(now()))
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  expect(() =>
    parseLeadProductFence(fenceV2({ extra: true }), selectors, () => Date.parse(now()))
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  // Unknown fence schema versions fall through to the strict admission parse.
  expect(
    parseLeadProductFence(fenceV1({ schemaVersion: 'pi-lead-intent-fence/v9' }), selectors, () =>
      Date.parse(now())
    )
  ).toBeUndefined()
  // Non-fence bodies fall through to the pi-lead-intent/v1 parse.
  expect(
    parseLeadProductFence({ schemaVersion: 'pi-lead-intent/v1' }, selectors, () =>
      Date.parse(now())
    )
  ).toBeUndefined()
  // A pinned v2 body with a malformed principal list is refused.
  expect(() =>
    parseLeadProductFence(
      fenceV2({ allowedPrincipalIds: ['svc_adea', 'svc_adea'] }),
      selectors,
      () => Date.parse(now())
    )
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  // Unknown rollback reason and unknown actor kind are refused.
  expect(() =>
    parseLeadProductFence(
      fenceV1({ rollbackFence: { ...fenceV1().rollbackFence, reason: 'other' } }),
      selectors,
      () => Date.parse(now())
    )
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  expect(() =>
    parseLeadProductFence(
      fenceV1({
        rollbackFence: {
          ...fenceV1().rollbackFence,
          actor: { kind: 'robot', userId: actorUserId },
        },
      }),
      selectors,
      () => Date.parse(now())
    )
  ).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
})

test('fencedOperationPolicy: v1 refuses all actions; v2 observes status/progress and cancels as original actor only', () => {
  const operations = [
    'prepare',
    'dispatch',
    'status',
    'progress',
    'cancel',
    'resume',
    'publication',
  ]
  for (const operation of operations) expect(fencedOperationPolicy('v1')[operation]).toBe('refuse')
  const v2 = fencedOperationPolicy('v2')
  expect(v2.prepare).toBe('refuse')
  expect(v2.dispatch).toBe('refuse')
  expect(v2.resume).toBe('refuse')
  expect(v2.publication).toBe('refuse')
  expect(v2.status).toBe('observe')
  expect(v2.progress).toBe('observe')
  expect(v2.cancel).toBe('cancel-as-actor')
})

async function harness(body) {
  const directory = await mkdtemp(join(tmpdir(), 'lead-fence-consumer-'))
  const database = new DatabaseSync(join(directory, 'node.sqlite'))
  const calls = { productReads: 0, resolvePlan: 0, getExecution: 0, reserve: 0 }
  const authority = new NodePiDurableLeadAdmission({
    database,
    product: {
      readCurrent: async () => {
        calls.productReads += 1
        return typeof body === 'function' ? body() : body
      },
    },
    resolvePlan: async () => {
      calls.resolvePlan += 1
      throw new Error('RESOLVE_PLAN_NOT_EXPECTED')
    },
    plans: {
      get: async () => {
        throw new Error('PLAN_GET_NOT_EXPECTED')
      },
    },
    commandRepository: {},
    planValidator: {},
    executions: {
      getExecution: async () => {
        calls.getExecution += 1
        return undefined
      },
      getAttempt: async () => undefined,
    },
    budgetAdmission: {
      reserve: async () => {
        calls.reserve += 1
        throw new Error('BUDGET_NOT_EXPECTED')
      },
    },
    admissionPrincipalId: 'svc_pi-admission',
    now: () => now(),
  })
  return {
    authority,
    calls,
    cleanup: async () => {
      database.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function bindRetainedMarker(authority, overrides = {}, state = 'ready') {
  const ids = deterministicPiLeadIntentIds(workspaceId, intentId)
  return authority.store.bind({
    intentId,
    workspaceId,
    actorPrincipalId: 'svc_adea',
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    planPin: {
      executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAA',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 2,
    },
    intent: {
      intentId,
      workspaceId,
      messageRef: 'msg_adea_lead',
      authorityRevision: 7,
      principalRef: 'pref_adea',
      canonicalActorPrincipalId: canonicalActor,
      scopeRef,
      expiresAt: '2026-10-08T01:00:00.000Z',
      allowedPrincipalIds: ['svc_adea', 'svc_pi-admission'],
      selectionRef: `msel_${'d'.repeat(32)}`,
      selectionRevision: 1,
      executionScope: { schemaVersion: 1, kind: 'workspace' },
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      ...overrides,
    },
    receivedAt: at,
    state,
  })
}

test('v2 refuses prepare/dispatch/undefined before any attempt, plan, inbox or model path runs', async () => {
  const { authority, calls, cleanup } = await harness(fenceV2())
  try {
    for (const operation of [undefined, 'prepare', 'dispatch']) {
      await expect(
        authority.resolveIntent({ workspaceId, intentId, principal: caller, operation })
      ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    }
    // No second attempt/model send: no plan resolution, no execution read, no budget
    // reservation, and no retained marker was ever created.
    expect(calls.resolvePlan).toBe(0)
    expect(calls.getExecution).toBe(0)
    expect(calls.reserve).toBe(0)
    expect(calls.productReads).toBe(3)
    expect(authority.store.marker(intentId)).toBeUndefined()
  } finally {
    await cleanup()
  }
})

test('minimal v1 refuses every operation (status, progress and cancel included)', async () => {
  const { authority, cleanup } = await harness(fenceV1())
  try {
    for (const operation of [undefined, 'prepare', 'dispatch', 'status', 'progress', 'cancel']) {
      await expect(
        authority.resolveIntent({ workspaceId, intentId, principal: caller, operation })
      ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    }
  } finally {
    await cleanup()
  }
})

test('v2 observation requires a ready retained marker with matching pins and never creates state', async () => {
  const missing = await harness(fenceV2())
  try {
    for (const operation of ['status', 'progress']) {
      await expect(
        missing.authority.resolveIntent({ workspaceId, intentId, principal: caller, operation })
      ).rejects.toThrow('PI_LEAD_MISSING')
    }
    expect(missing.calls.resolvePlan).toBe(0)
    expect(missing.authority.store.marker(intentId)).toBeUndefined()
  } finally {
    await missing.cleanup()
  }

  const pending = await harness(fenceV2())
  try {
    bindRetainedMarker(pending.authority, {}, 'pending')
    await expect(
      pending.authority.resolveIntent({
        workspaceId,
        intentId,
        principal: caller,
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_MISSING')
  } finally {
    await pending.cleanup()
  }

  const ready = await harness(fenceV2())
  try {
    bindRetainedMarker(ready.authority)
    for (const operation of ['status', 'progress']) {
      const result = await ready.authority.resolveIntent({
        workspaceId,
        intentId,
        principal: caller,
        operation,
      })
      expect(result).toMatchObject({
        kind: 'fenced',
        schemaVersion: 'pi-lead-fenced/v1',
        operation,
        fenceVariant: 'v2',
        retainedMatch: true,
        fence: { authorityRevision: 7, scopeRef },
      })
    }
    expect(ready.calls.resolvePlan).toBe(0)
    expect(ready.calls.getExecution).toBe(0)
  } finally {
    await ready.cleanup()
  }
})

test('v2 observation refuses a legacy marker that lacks the canonical actor pin', async () => {
  const { authority, cleanup } = await harness(fenceV2())
  try {
    // A legacy marker: retained before canonical actors and scoped plans were pinned. It is
    // rewritten in place as a schema-v1 plan without an executionScope or canonical actor.
    bindRetainedMarker(authority)
    const stored = authority.store.marker(intentId)
    const { canonicalActorPrincipalId: _actor, executionScope: _scope, ...intent } = stored.intent
    authority.store.database
      .prepare('UPDATE pi_lead_intent_admissions SET record = ? WHERE intent_id = ?')
      .run(
        JSON.stringify({ ...stored, planPin: { ...stored.planPin, schemaVersion: 1 }, intent }),
        intentId
      )
    for (const operation of ['status', 'progress', 'cancel']) {
      await expect(
        authority.resolveIntent({ workspaceId, intentId, principal: caller, operation })
      ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    }
  } finally {
    await cleanup()
  }
})

test('v2 refuses status/progress from a principal outside allowedPrincipalIds', async () => {
  const { authority, cleanup } = await harness(fenceV2())
  try {
    await expect(
      authority.resolveIntent({
        workspaceId,
        intentId,
        principal: { ...caller, principalId: 'svc_intruder' },
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_SCOPE_REJECTED')
  } finally {
    await cleanup()
  }
})

test('v2 cancellation: only the original actor with matching retained pins is admitted', async () => {
  const { authority, cleanup } = await harness(fenceV2())
  try {
    await expect(
      authority.resolveIntent({ workspaceId, intentId, principal: caller, operation: 'cancel' })
    ).rejects.toThrow('PI_LEAD_MISSING')

    bindRetainedMarker(authority)
    // A second principal inside allowedPrincipalIds is not the original actor: cancellation refused.
    await expect(
      authority.resolveIntent({
        workspaceId,
        intentId,
        principal: { ...caller, principalId: 'svc_pi-admission' },
        operation: 'cancel',
      })
    ).rejects.toThrow('PI_LEAD_SCOPE_REJECTED')
    // A principal outside the fence allowlist is refused before any retained state is read.
    await expect(
      authority.resolveIntent({
        workspaceId,
        intentId,
        principal: { ...caller, principalId: 'svc_other' },
        operation: 'cancel',
      })
    ).rejects.toThrow('PI_LEAD_SCOPE_REJECTED')

    const admitted = await authority.resolveIntent({
      workspaceId,
      intentId,
      principal: caller,
      operation: 'cancel',
    })
    expect(admitted).toMatchObject({
      kind: 'fenced',
      operation: 'cancel',
      retainedMatch: true,
      fence: { authorityRevision: 7 },
    })
  } finally {
    await cleanup()
  }

  const stale = await harness(fenceV2({ authorityRevision: 8 }))
  try {
    bindRetainedMarker(stale.authority)
    await expect(
      stale.authority.resolveIntent({
        workspaceId,
        intentId,
        principal: caller,
        operation: 'cancel',
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    await expect(
      stale.authority.resolveIntent({
        workspaceId,
        intentId,
        principal: caller,
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
  } finally {
    await stale.cleanup()
  }

  const rescoped = await harness(fenceV2({ scopeRef: `adea-product:sha256:${'e'.repeat(64)}` }))
  try {
    bindRetainedMarker(rescoped.authority)
    await expect(
      rescoped.authority.resolveIntent({
        workspaceId,
        intentId,
        principal: caller,
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
  } finally {
    await rescoped.cleanup()
  }
})

test('assertCurrent fails closed under a fence; retained status and cancel are verified only by assertFencedBinding', async () => {
  const { authority, cleanup } = await harness(fenceV2())
  try {
    const ids = deterministicPiLeadIntentIds(workspaceId, intentId)
    const admission = {
      intentId,
      workspaceId,
      admittedAttempt: { executionId: ids.executionId, attemptId: ids.attemptId },
    }
    bindRetainedMarker(authority)
    for (const operation of ['status', 'progress', 'cancel', 'prepare', 'dispatch']) {
      await expect(authority.assertCurrent(admission, caller, operation)).rejects.toThrow(
        'PI_LEAD_UNAVAILABLE'
      )
    }
  } finally {
    await cleanup()
  }
})

test('pi-lead-intent/v1 evidence bodies keep the existing admission path and strict parse', async () => {
  // A non-fence body reaches the canonical evidence parser unchanged (strict schema,
  // identity and principal checks, freshness). This proves the union never reroutes
  // the normal evidence path.
  const { authority, cleanup } = await harness({
    schemaVersion: 'pi-lead-intent/v1',
    intentId,
    workspaceId,
    messageRef: 'msg_adea_lead',
    authorityRevision: 7,
    principalRef: 'pref_adea',
    canonicalActorPrincipalId: canonicalActor,
    scopeRef,
    expiresAt: '2026-10-08T01:00:00.000Z',
    allowedPrincipalIds: ['svc_adea'],
    selectionRef: `msel_${'d'.repeat(32)}`,
    selectionRevision: 1,
    prompt: 'hello',
    profileVersionId: 'pfv_01ARZ3NDEKTSV4RRFFQ69G5FAA',
    profileContentDigest: `sha256:${'f'.repeat(64)}`,
    projectId: null,
  })
  try {
    await expect(
      authority.resolveIntent({
        workspaceId,
        intentId,
        principal: { ...caller, scopes: ['execution:read'] },
        operation: 'status',
      })
    ).rejects.toThrow() // reaches plan/status machinery (PI_LEAD_MISSING), not a fence result
    const result = await authority
      .resolveIntent({ workspaceId, intentId, principal: caller, operation: 'status' })
      .catch((error) => error)
    expect(result?.kind === 'fenced').toBe(false)
  } finally {
    await cleanup()
  }
})
