import { ContextPackageCompiler, contextPackageSerializationFixtures } from '@control-plane/context'
import {
  ExecutionPlanCompiler,
  InMemoryExecutionPlanRepository,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { ExecutionLifecycleService, InMemoryExecutionRepository } from '@control-plane/domain'
import { createCanonicalModelExecutionAuthority } from './canonical-model-host.ts'

export const at = '2026-10-08T12:00:00.000Z'
export const expiry = '2026-10-08T13:00:00.000Z'
export const exe = 'exe_01JABCDEF0123456789ABCDEFG'
export const att = 'att_01JABCDEF0123456789ABCDEFG'
export async function fixture() {
  const legacy = contextPackageSerializationFixtures.futurePi
  const context = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId: legacy.projectState.workspaceId,
    executionScope: { schemaVersion: 1, kind: 'workspace' },
    revision: 4,
    objective: 'Workspace model host fixture',
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  })
  const input = createExecutionPlanTestFixtureInputs({ contextPackage: context })
  const { projectId: _projectId, ...correlation } = input.correlation
  const plan = new ExecutionPlanCompiler('1.0.0').compile({
    ...input,
    correlation: {
      ...correlation,
      executionScope: { schemaVersion: 1, kind: 'workspace' },
    },
  })
  const plans = new InMemoryExecutionPlanRepository()
  await plans.put(plan)
  const executions = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executions)
  await lifecycle.createExecution({
    executionId: exe,
    correlation: plan.correlation,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: 2,
    },
    acceptedAt: at,
    deadlineAt: expiry,
  })
  await lifecycle.createAttempt({
    executionId: exe,
    attemptId: att,
    expectedExecutionVersion: 1,
    queuedAt: at,
  })
  const intent = {
    intentId: '11111111-1111-4111-8111-111111111111',
    workspaceId: plan.correlation.workspaceId,
    executionScope: plan.correlation.executionScope,
    executionId: exe,
    attemptId: att,
    canonicalActorPrincipalId: 'actor:original',
    principalRef: 'svc_admission',
    authorityRevision: 1,
    scopeRef: 'scope:workspace',
    expiresAt: expiry,
    selectionRef: `msel_${'2'.repeat(32)}`,
    selectionRevision: 1,
    allowedPrincipalIds: ['svc_transport'],
    messageRef: 'message:original',
  }
  let retained = structuredClone(intent)
  let current = structuredClone(intent)
  let scope = true
  let marker = {
    state: 'ready',
    actorPrincipalId: 'svc_transport',
    intent,
    planPin: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: 2,
    },
  }
  let onProduct = async () => {}
  let onScope = async () => {}
  let scopeExpiry = expiry
  let time = at
  const scopeInputs = []
  const productInputs = []
  const hostOptions = {
    executions,
    plans,
    intents: { getByAttempt: async () => retained, marker: () => marker },
    product: {
      readCurrent: async (request) => {
        await onScope()
        productInputs.push(request)
        await onProduct()
        return current
      },
    },
    scopeAuthority: {
      readCurrent: async (request) => {
        scopeInputs.push(request)
        return {
          ...request,
          principalActive: scope,
          grantActive: scope,
          allowedPrincipalIds: ['actor:original'],
          expiresAt: scopeExpiry,
        }
      },
    },
    leasePrincipalRef: 'svc_lease',
    modelAlias: plan.constraints.models[0].alias,
    now: () => time,
  }
  const host = createCanonicalModelExecutionAuthority(hostOptions)
  const reader = {
    workspaceId: intent.workspaceId,
    executionId: exe,
    attemptId: att,
    principalId: 'svc_transport',
    selectionRef: intent.selectionRef,
    selectionRevision: 1,
  }
  return {
    host,
    hostOptions,
    reader,
    executions,
    lifecycle,
    context,
    plan,
    intent,
    scopeInputs,
    productInputs,
    setCurrent: (value) => {
      current = value
    },
    setRetained: (value) => {
      retained = value
    },
    setMarker: (value) => {
      marker = value
    },
    setScope: (value) => {
      scope = value
    },
    setTime: (value) => {
      time = value
    },
    onProduct: (value) => {
      onProduct = value
    },
    onScope: (value) => {
      onScope = value
    },
    setScopeExpiry: (value) => {
      scopeExpiry = value
    },
  }
}
