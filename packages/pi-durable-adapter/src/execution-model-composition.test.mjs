import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { selection as selected } from '../../model-gateway/src/selection-fixtures.mjs'
import { workspacePlan } from './workspace-scope.fixture.mjs'
import { createPiExecutionBoundModelComposition } from './execution-model-composition.ts'
import { createExecutionBoundModelSelectionService } from '@control-plane/model-gateway'

function fixture() {
  const plan = workspacePlan()
  const modelAlias = plan.constraints.models[0].alias
  const selection = {
    ...selected,
    providerModel: openaiProvider().getModels()[0].id,
    workspaceId: plan.correlation.workspaceId,
  }
  const budget = {
    schemaVersion: 1,
    workspaceId: plan.correlation.workspaceId,
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    executionPlanId: plan.executionPlanId,
    executionPlanDigest: plan.contentDigest,
    reservationKey: 'runtime-attempt:att_01JABCDEF0123456789ABCDEFG',
    currency: 'USD',
    maximumTokens: 100,
    maximumMicrounits: 1000,
  }
  const authority = {
    request: {
      executionId: budget.executionId,
      attemptId: budget.attemptId,
      idempotencyKey: 'start:bound-one',
      executionPlan: plan,
      attemptBudget: budget,
    },
    admission: {
      schemaVersion: 'pi-durable-admission/v1',
      prompt: 'Canonical test message',
      canonicalActorPrincipalId: 'user:original-sender',
      selection: {
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
      },
      authority: {
        revision: 1,
        principalRef: 'principal:recorded-owner',
        scopeRef: 'scope:one',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    },
  }
  const price = {
    schemaVersion: 1,
    deploymentId: 'native:bound',
    provider: selection.provider,
    model: selection.providerModel,
    version: 'price:one',
    currency: 'USD',
    fundingSource: 'byo_api',
    validFrom: '2026-10-08T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    maximumInputTokens: 64,
    maximumOutputTokens: 32,
    ratesMicrounitsPerMillionTokens: { input: 1000000, cachedInput: 500000, output: 2000000 },
  }
  const decision = {
    executionPlanId: plan.executionPlanId,
    executionPlanDigest: plan.contentDigest,
    ...authority.admission.selection,
    price,
    grant: {
      schemaVersion: 1,
      authorizationId: 'spend:recorded',
      evidenceRef: 'decision:recorded',
      workspaceId: budget.workspaceId,
      executionId: budget.executionId,
      attemptId: budget.attemptId,
      deploymentId: price.deploymentId,
      credentialRef: selection.credentialRef,
      principalRef: authority.admission.authority.principalRef,
      alias: modelAlias,
      policySnapshotDigest: plan.policySnapshot.digest,
      currency: price.currency,
      fundingSource: price.fundingSource,
      maximumMicrounits: budget.maximumMicrounits,
      maximumTokens: budget.maximumTokens,
      issuedAt: price.validFrom,
      expiresAt: price.validUntil,
    },
  }
  const state = { active: true, bindings: [], leases: 0 }
  const options = {
    selections: {
      resolveSelection: async () => structuredClone(selection),
      assertReady: async () => {},
      withCredential: async (_selection, _authority, operation) => {
        state.leases++
        return operation('synthetic-secret')
      },
    },
    currentExecutionAuthority: {
      assertCurrent: async (binding) => {
        state.bindings.push(structuredClone(binding))
        if (!state.active) throw new Error('CURRENT_AUTHORITY_REVOKED')
      },
    },
    leasePrincipalRef: 'service:model-lease',
    modelAlias,
    ledger: { attemptAllocation: async () => budget },
    readRecordedDecision: async () => decision,
    now: () => '2026-10-08T00:00:00.000Z',
  }
  return { authority, selection, price, decision, state, options }
}

test('native registry and recorded spending resolve the same original-actor execution binding', async () => {
  const f = fixture()
  const ports = createPiExecutionBoundModelComposition(f.options)
  const provider = await ports.resolveProvider(f.authority.admission.selection, f.authority)
  let registry
  const model = await provider.withModels(async (models) => {
    registry = models
    return { id: models.getModel(f.selection.provider, f.selection.providerModel).id }
  })
  expect(model.id).toBe(f.selection.providerModel)
  expect(registry.getProviders()).toHaveLength(0)
  expect(f.state.leases).toBe(1)
  const resolved = await ports.resolvePrice(f.authority)
  const quote = resolved.price.quote({
    requestDigest: `sha256:${'d'.repeat(64)}`,
    maximumOutputTokens: 32,
  })
  const authorization = await ports.assertSpendingAuthorized(f.authority, {
    priceSnapshotDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(f.price)).digest('hex')}`,
    requestDigest: quote.requestDigest,
    currency: quote.currency,
    fundingSource: quote.fundingSource,
    maximumMicrounits: quote.maximumMicrounits,
    maximumTokens: quote.maximumTokens,
    attemptMaximumMicrounits: 1000,
    attemptMaximumTokens: 100,
  })
  await authorization.assertActive()
  expect(f.state.bindings.length).toBeGreaterThan(5)
  expect(new Set(f.state.bindings.map(canonicalJsonStringify)).size).toBe(1)
  expect(f.state.bindings[0].canonicalActorPrincipalId).toBe('user:original-sender')
  expect(f.state.bindings[0].leasePrincipalRef).toBe('service:model-lease')
  f.state.active = false
  await expect(authorization.assertActive()).rejects.toThrow('PROVIDER_POLICY_DENIED')
  await expect(provider.withModels(async () => ({ ok: true }))).rejects.toThrow(
    'PROVIDER_POLICY_DENIED'
  )
  expect(f.state.leases).toBe(1)
})

test('missing actor, stale attempt allocation and unauthorized alias fail before credential use', async () => {
  for (const fault of ['actor', 'attempt', 'alias']) {
    const f = fixture()
    if (fault === 'actor') delete f.authority.admission.canonicalActorPrincipalId
    if (fault === 'attempt')
      f.authority.request.attemptBudget.attemptId = 'att_01JABCDEF0123456789ABCDEFA'
    if (fault === 'alias') f.options.modelAlias = 'model:unadmitted'
    const ports = createPiExecutionBoundModelComposition(f.options)
    await expect(
      ports.resolveProvider(f.authority.admission.selection, f.authority)
    ).rejects.toThrow()
    expect(f.state.leases).toBe(0)
  }
})

async function spendingAuthorization(ports, f) {
  const resolved = await ports.resolvePrice(f.authority)
  const quote = resolved.price.quote({
    requestDigest: `sha256:${'d'.repeat(64)}`,
    maximumOutputTokens: 32,
  })
  return ports.assertSpendingAuthorized(f.authority, {
    priceSnapshotDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(f.price)).digest('hex')}`,
    requestDigest: quote.requestDigest,
    currency: quote.currency,
    fundingSource: quote.fundingSource,
    maximumMicrounits: quote.maximumMicrounits,
    maximumTokens: quote.maximumTokens,
    attemptMaximumMicrounits: 1000,
    attemptMaximumTokens: 100,
  })
}

function suppliedFacadeFixture() {
  const f = fixture()
  f.state.payerActive = true
  f.state.factoryBindings = []
  f.state.facadeReceivers = []
  f.state.physicalSends = 0
  const selections = f.options.selections
  const current = f.options.currentExecutionAuthority
  const forExecution = (binding) => {
    f.state.factoryBindings.push(structuredClone(binding))
    const facade = createExecutionBoundModelSelectionService({
      binding,
      selections,
      currentExecutionAuthority: {
        assertCurrent: async (value) => {
          await current.assertCurrent(value)
          if (!f.state.payerActive) throw new Error('CONFIRMED_PAYER_REVOKED')
        },
      },
    })
    return {
      assertBinding(value) {
        f.state.facadeReceivers.push(this)
        return facade.assertBinding(value)
      },
      resolveSelection(value) {
        f.state.facadeReceivers.push(this)
        return facade.resolveSelection(value)
      },
      assertReady(value) {
        f.state.facadeReceivers.push(this)
        return facade.assertReady(value)
      },
      withCredential(...args) {
        f.state.facadeReceivers.push(this)
        return facade.withCredential(...args)
      },
    }
  }
  // The supplied host facade must be used; these direct/default ports cannot qualify it.
  f.options.selections = {
    resolveSelection: async () => {
      throw new Error('DEFAULT_SELECTION_BYPASS')
    },
    assertReady: async () => {
      throw new Error('DEFAULT_SELECTION_BYPASS')
    },
    withCredential: async () => {
      throw new Error('DEFAULT_SELECTION_BYPASS')
    },
  }
  f.options.currentExecutionAuthority = {
    assertCurrent: async () => {
      throw new Error('DEFAULT_AUTHORITY_BYPASS')
    },
  }
  f.options.forExecution = forExecution
  return f
}

test('supplied confirmed host facade is pinned once and shared by provider registry and every spending recheck', async () => {
  const f = suppliedFacadeFixture()
  const ports = createPiExecutionBoundModelComposition(f.options)
  const provider = await ports.resolveProvider(f.authority.admission.selection, f.authority)
  const authorization = await spendingAuthorization(ports, f)
  await authorization.assertActive()
  await provider.withModels(async (models) => {
    expect(models.getModel(f.selection.provider, f.selection.providerModel).id).toBe(
      f.selection.providerModel
    )
    f.state.physicalSends++ // Callback only; no external provider dispatch in this test.
  })
  expect(f.state.factoryBindings).toHaveLength(1)
  expect(new Set(f.state.facadeReceivers).size).toBe(1)
  expect(f.state.factoryBindings[0]).toEqual({
    schemaVersion: 'execution-model-selection/v1',
    workspaceId: f.authority.request.attemptBudget.workspaceId,
    executionId: f.authority.request.executionId,
    attemptId: f.authority.request.attemptId,
    requestId: f.authority.request.executionPlan.correlation.requestId,
    executionPlanId: f.authority.request.executionPlan.executionPlanId,
    executionPlanDigest: f.authority.request.executionPlan.contentDigest,
    executionPlanSchemaVersion: 2,
    policySnapshotDigest: f.authority.request.executionPlan.policySnapshot.digest,
    principalRef: f.authority.admission.authority.principalRef,
    canonicalActorPrincipalId: f.authority.admission.canonicalActorPrincipalId,
    leasePrincipalRef: f.options.leasePrincipalRef,
    modelAlias: f.options.modelAlias,
    authorityRevision: f.authority.admission.authority.revision,
    ...f.authority.admission.selection,
  })
  expect(f.state.leases).toBe(1)
  expect(f.state.physicalSends).toBe(1)
})

test.each(['payer', 'current'])(
  'supplied facade %s revocation denies spending and provider use before another lease or callback',
  async (fault) => {
    const f = suppliedFacadeFixture()
    const ports = createPiExecutionBoundModelComposition(f.options)
    const provider = await ports.resolveProvider(f.authority.admission.selection, f.authority)
    const authorization = await spendingAuthorization(ports, f)
    if (fault === 'payer') f.state.payerActive = false
    else f.state.active = false
    await expect(authorization.assertActive()).rejects.toThrow('PROVIDER_POLICY_DENIED')
    await expect(
      provider.withModels(async () => {
        f.state.physicalSends++
      })
    ).rejects.toThrow('PROVIDER_POLICY_DENIED')
    await expect(ports.resolvePrice(f.authority)).rejects.toThrow('PROVIDER_POLICY_DENIED')
    expect(f.state.leases).toBe(0)
    expect(f.state.physicalSends).toBe(0)
    expect(f.state.factoryBindings).toHaveLength(1)
    expect(new Set(f.state.facadeReceivers).size).toBe(1)
  }
)

test('same attempt cannot replace cached authority pins or supply a facade bound to another execution', async () => {
  const f = suppliedFacadeFixture()
  const ports = createPiExecutionBoundModelComposition(f.options)
  await ports.resolveProvider(f.authority.admission.selection, f.authority)
  const changed = structuredClone(f.authority)
  changed.admission.authority.revision++
  await expect(ports.resolveProvider(changed.admission.selection, changed)).rejects.toThrow(
    'PI_EXECUTION_MODEL_BINDING_CHANGED'
  )
  await expect(ports.resolvePrice(changed)).rejects.toThrow('PI_EXECUTION_MODEL_BINDING_CHANGED')
  expect(f.state.factoryBindings).toHaveLength(1)
  expect(f.state.leases).toBe(0)
  const wrong = fixture()
  wrong.options.forExecution = (binding) =>
    createExecutionBoundModelSelectionService({
      selections: wrong.options.selections,
      currentExecutionAuthority: wrong.options.currentExecutionAuthority,
      binding: { ...binding, executionId: 'exe_01JBBCDEF0123456789ABCDEFG' },
    })
  const wrongPorts = createPiExecutionBoundModelComposition(wrong.options)
  await expect(
    wrongPorts.resolveProvider(wrong.authority.admission.selection, wrong.authority)
  ).rejects.toThrow('SELECTION_CHANGED')
  expect(wrong.state.leases).toBe(0)
})

test('trusted facade port works without default authority, bounds retained facades and permits exact terminal cleanup', async () => {
  const f = suppliedFacadeFixture()
  delete f.options.selections
  delete f.options.currentExecutionAuthority
  const ports = createPiExecutionBoundModelComposition({ ...f.options, maximumRetainedFacades: 1 })
  await ports.resolveProvider(f.authority.admission.selection, f.authority)
  const next = structuredClone(f.authority)
  next.request.attemptId = 'att_01JBBCDEF0123456789ABCDEFG'
  next.request.attemptBudget.attemptId = next.request.attemptId
  next.request.attemptBudget.reservationKey = `runtime-attempt:${next.request.attemptId}`
  await expect(ports.resolveProvider(next.admission.selection, next)).rejects.toThrow(
    'PI_EXECUTION_MODEL_FACADE_LIMIT_EXCEEDED'
  )
  ports.forgetTerminalExecution(f.authority)
  await ports.resolveProvider(next.admission.selection, next)
  expect(f.state.factoryBindings).toHaveLength(2)
  expect(f.state.leases).toBe(0)
  expect(() =>
    createPiExecutionBoundModelComposition({ ...f.options, forExecution: undefined })
  ).toThrow('PI_EXECUTION_MODEL_AUTHORITY_REQUIRED')
  const invalid = createPiExecutionBoundModelComposition({ ...f.options, forExecution: () => ({}) })
  await expect(
    invalid.resolveProvider(f.authority.admission.selection, f.authority)
  ).rejects.toThrow('PI_EXECUTION_MODEL_FACADE_INVALID')
})
