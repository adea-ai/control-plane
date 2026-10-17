import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionPlanCompiler, deriveExecutionPlan } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { createProductionChildModelAuthority } from './production-child-model-authority.ts'
import { createProductionChildModelHost } from './production-child-model-host.ts'

const at = '2026-10-08T00:00:00.000Z'
const actor = `user:${randomUUID()}`
const selection = { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 1 }
function fixture() {
  const base = createExecutionPlanTestFixtureInputs()
  const parent = new ExecutionPlanCompiler('1.0.0').compile(base)
  const plan = deriveExecutionPlan(parent, {
    correlation: { ...parent.correlation, requestId: 'req_01JBBCDEF0123456789ABCDEFG' },
    contextPackage: base.contextPackage,
    constraints: structuredClone(parent.constraints),
    runtimeRequirements: structuredClone(parent.runtimeRequirements),
    outputContract: parent.outputContract,
    compiledAt: at,
  })
  const request = {
    executionId: 'exe_01JBBCDEF0123456789ABCDEFG',
    attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    idempotencyKey: 'child:model',
    executionPlan: plan,
  }
  const state = {
    admits: 0,
    selects: 0,
    current: 0,
    denied: false,
    record: {
      workspaceId: plan.correlation.workspaceId,
      parentIntentId: randomUUID(),
      childRequestId: plan.correlation.requestId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      parentExecutionPlanId: parent.executionPlanId,
      parentExecutionPlanDigest: parent.contentDigest,
      canonicalActorPrincipalId: actor,
      productReaderPrincipalId: 'svc_product',
      authorityRevision: 1,
      expiresAt: '2026-10-08T01:00:00.000Z',
      requestedSelection: selection,
    },
  }
  const options = {
    now: () => at,
    readCurrent: async () => state.record,
    product: {
      resolveChildSelection: async (input, child) => {
        state.selects++
        expect(input.principalId).toBe('svc_product')
        expect(child.canonicalActorPrincipalId).toBe(actor)
        expect(child.requestedSelection).toEqual(selection)
        if (state.denied) throw new Error('CHILD_SELECTION_REVOKED')
        return selection
      },
    },
    admit: async (_request, chosen) => {
      state.admits++
      return {
        schemaVersion: 'pi-durable-admission/v1',
        prompt: 'Synthetic child',
        canonicalActorPrincipalId: actor,
        selection: chosen,
        authority: {
          revision: 1,
          principalRef: 'svc_child',
          scopeRef: 'scope:child',
          expiresAt: state.record.expiresAt,
        },
      }
    },
    assertCurrent: async () => {
      state.current++
    },
  }
  return { request, state, options }
}
test('child selection readiness runs before canonical admission; exact selection rechecked on resume', async () => {
  const { request, state, options } = fixture()
  const port = createProductionChildModelAuthority(options)
  const admission = await port.resolveAdmission(request)
  expect(admission.selection).toEqual(selection)
  expect(state.admits).toBe(1)
  expect(state.selects).toBe(2)
  await port.assertAuthority({ request, admission })
  expect(state.selects).toBe(3)
  state.denied = true
  await expect(port.assertAuthority({ request, admission })).rejects.toThrow(
    'CHILD_SELECTION_REVOKED'
  )
  expect(state.admits).toBe(1)
})

test('cancellation rechecks child authority without resolving an unavailable model', async () => {
  const { request, state, options } = fixture()
  const purposes = []
  options.assertCurrent = async (_authority, purpose) => {
    purposes.push(purpose)
    if (state.denied && purpose !== 'cancel') throw new Error('CHILD_FUNDING_UNAVAILABLE')
  }
  const port = createProductionChildModelAuthority(options)
  const admission = await port.resolveAdmission(request)
  state.denied = true
  const selects = state.selects
  await port.assertAuthority({ request, admission }, 'cancel')
  expect(purposes.at(-1)).toBe('cancel')
  expect(state.selects).toBe(selects)
  expect(state.admits).toBe(1)
  await expect(port.assertAuthority({ request, admission })).rejects.toThrow(
    'CHILD_FUNDING_UNAVAILABLE'
  )
})

test('cancellation still refuses changed actor, revision, lineage, expired authority or a denied current grant', async () => {
  for (const fault of ['actor', 'revision', 'lineage', 'expiry', 'clock', 'grant']) {
    const { request, state, options } = fixture()
    const port = createProductionChildModelAuthority(options)
    const admission = await port.resolveAdmission(request)
    state.denied = true
    if (fault === 'actor') state.record.canonicalActorPrincipalId = `user:${randomUUID()}`
    if (fault === 'revision') state.record.authorityRevision++
    if (fault === 'lineage') state.record.parentExecutionPlanDigest = `sha256:${'a'.repeat(64)}`
    if (fault === 'expiry') state.record.expiresAt = at
    if (fault === 'clock') options.now = () => 'invalid'
    if (fault === 'grant')
      options.assertCurrent = async () => {
        throw new Error('CURRENT_GRANT_REVOKED')
      }
    // Recreate only the callback wrapper so the changed clock is read too; the
    // admitted authority and canonical records are the originals.
    await expect(
      createProductionChildModelAuthority(options).assertAuthority({ request, admission }, 'cancel')
    ).rejects.toThrow()
  }
})

test('an audience reader change during the final cancellation read cannot reuse the admitted authority', async () => {
  const { request, state, options } = fixture()
  const port = createProductionChildModelAuthority(options)
  const admission = await port.resolveAdmission(request)
  let reads = 0
  options.readCurrent = async (_request, purpose) => {
    expect(purpose).toBe('cancel')
    if (++reads === 2) state.record.productReaderPrincipalId = 'svc_replacement'
    return state.record
  }
  await expect(
    createProductionChildModelAuthority(options).assertAuthority({ request, admission }, 'cancel')
  ).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_CHANGED')
})

test('child model host verifies the admitted configuration for cancellation without model or funding reads', async () => {
  const { request, state, options } = fixture()
  const admission = await options.admit(request, selection)
  const original = {
    current: state.record,
    plan: request.executionPlan,
    objective: admission.prompt,
    principalRef: admission.authority.principalRef,
    scopeRef: admission.authority.scopeRef,
    allowedPrincipalIds: ['svc_product'],
  }
  const database = new DatabaseSync(':memory:')
  const fundingDirectory = mkdtempSync(join(tmpdir(), 'pi-child-cancel-funding-'))
  let record = structuredClone(original)
  let modelReads = 0
  const purposes = []
  const host = createProductionChildModelHost({
    current: {
      readRecord: async (_ids, purpose) => {
        purposes.push(purpose)
        return record
      },
    },
    product: {
      resolveChildSelection: async () => {
        modelReads++
        throw new Error('TEST_MODEL_REVOKED')
      },
    },
    selections: {},
    // The directory is empty. Cancellation must never try to read funding records.
    fundingDirectory,
    database,
    leasePrincipalRef: 'svc_child_lease',
    modelAlias: 'reasoning.standard',
    now: () => at,
  })
  try {
    await host.assertCurrent({ request, admission }, 'cancel')
    expect(purposes).toEqual(['cancel'])
    expect(modelReads).toBe(0)
    await expect(host.assertCurrent({ request, admission })).rejects.toThrow('TEST_MODEL_REVOKED')
    expect(modelReads).toBe(1)
    for (const mutate of [
      (value) => {
        value.current.canonicalActorPrincipalId = `user:${randomUUID()}`
      },
      (value) => {
        value.current.authorityRevision++
      },
      (value) => {
        value.principalRef = 'svc_other'
      },
      (value) => {
        value.scopeRef = 'scope:other'
      },
      (value) => {
        value.objective = 'Changed objective'
      },
      (value) => {
        value.current.executionPlanDigest = `sha256:${'a'.repeat(64)}`
      },
      (value) => {
        value.current.attemptId = 'att_01JCBCDEF0123456789ABCDEFG'
      },
      (value) => {
        value.current.expiresAt = at
      },
    ]) {
      record = structuredClone(original)
      mutate(record)
      await expect(host.assertCurrent({ request, admission }, 'cancel')).rejects.toThrow(
        'PI_CHILD_MODEL_AUTHORITY_DENIED'
      )
    }
    expect(modelReads).toBe(1)
  } finally {
    database.close()
    rmSync(fundingDirectory, { recursive: true, force: true })
  }
})

for (const field of ['principalRef', 'scopeRef', 'objective']) {
  test(`cancellation refuses ${field} drift during its final canonical reads`, async () => {
    const { request, state, options } = fixture()
    const admission = await options.admit(request, selection)
    const record = {
      current: state.record,
      plan: request.executionPlan,
      objective: admission.prompt,
      principalRef: admission.authority.principalRef,
      scopeRef: admission.authority.scopeRef,
      allowedPrincipalIds: ['svc_product'],
    }
    const database = new DatabaseSync(':memory:')
    const fundingDirectory = mkdtempSync(join(tmpdir(), 'pi-child-cancel-final-read-'))
    const host = createProductionChildModelHost({
      current: { readRecord: async () => structuredClone(record) },
      product: options.product,
      selections: {},
      fundingDirectory,
      database,
      leasePrincipalRef: 'svc_child_lease',
      modelAlias: 'reasoning.standard',
      now: () => at,
    })
    try {
      const port = createProductionChildModelAuthority({
        ...options,
        assertCurrent: host.assertCurrent,
        readCurrent: async () => {
          // Host validation has already read the old accepted identity at the defective head.
          // The model-request projection carries none of these three fields.
          await Promise.resolve()
          record[field] = `changed:${field}`
          return record.current
        },
      })
      await expect(port.assertAuthority({ request, admission }, 'cancel')).rejects.toThrow(
        'PI_CHILD_MODEL_AUTHORITY_DENIED'
      )
      expect(state.selects).toBe(0)
    } finally {
      database.close()
      rmSync(fundingDirectory, { recursive: true, force: true })
    }
  })
}
test('missing current child, changed lineage, expiry or revoked selection cannot allocate', async () => {
  for (const fault of ['missing', 'parent', 'attempt', 'expired', 'revoked']) {
    const { request, state, options } = fixture()
    if (fault === 'missing') state.record = undefined
    if (fault === 'parent') state.record.parentExecutionPlanDigest = `sha256:${'f'.repeat(64)}`
    if (fault === 'attempt') state.record.attemptId = 'att_01JCBCDEF0123456789ABCDEFG'
    if (fault === 'expired') state.record.expiresAt = at
    if (fault === 'revoked') state.denied = true
    await expect(
      createProductionChildModelAuthority(options).resolveAdmission(request)
    ).rejects.toThrow()
    expect(state.admits).toBe(0)
  }
})
test('canonical admission cannot silently replace selected child model or original actor', async () => {
  for (const fault of ['selection', 'actor']) {
    const { request, options } = fixture()
    const admit = options.admit
    options.admit = async (...args) => {
      const value = await admit(...args)
      if (fault === 'selection')
        value.selection = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
      else value.canonicalActorPrincipalId = `user:${randomUUID()}`
      return value
    }
    await expect(
      createProductionChildModelAuthority(options).resolveAdmission(request)
    ).rejects.toThrow('PI_CHILD_MODEL_SELECTION_CHANGED')
  }
})

test('child revoked, expired or changed during model readiness cannot allocate', async () => {
  for (const fault of ['revoked', 'expired', 'actor', 'lineage', 'clock']) {
    const { request, state, options } = fixture()
    const select = options.product.resolveChildSelection
    let invalid = false
    options.now = () => (invalid ? 'invalid' : at)
    options.product.resolveChildSelection = async (...args) => {
      const value = await select(...args)
      if (fault === 'revoked') state.record = undefined
      if (fault === 'expired') state.record.expiresAt = at
      if (fault === 'actor') state.record.canonicalActorPrincipalId = `user:${randomUUID()}`
      if (fault === 'lineage') state.record.parentExecutionPlanDigest = `sha256:${'a'.repeat(64)}`
      if (fault === 'clock') invalid = true
      return value
    }
    await expect(
      createProductionChildModelAuthority(options).resolveAdmission(request)
    ).rejects.toThrow()
    expect(state.admits).toBe(0)
  }
})
