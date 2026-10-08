import { ContextPackageCompiler, contextPackageSerializationFixtures } from '@control-plane/context'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'

export function workspacePlan() {
  const legacy = contextPackageSerializationFixtures.futurePi
  const context = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    executionScope: { schemaVersion: 1, kind: 'workspace' },
    revision: 4,
    objective: 'Canonical workspace lead',
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  })
  const input = createExecutionPlanTestFixtureInputs({
    contextPackage: context,
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const { projectId: _, ...correlation } = input.correlation
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...input,
    correlation: { ...correlation, executionScope: { schemaVersion: 1, kind: 'workspace' } },
  })
}

export function currentScope(input, overrides = {}) {
  return {
    workspaceId: input.workspaceId,
    executionScope: input.executionScope,
    callerPrincipalId: input.callerPrincipalId,
    executionPlan: input.executionPlan,
    principalActive: true,
    grantActive: true,
    allowedPrincipalIds: [input.callerPrincipalId],
    expiresAt: '2027-01-01T00:00:00.000Z',
    ...(input.executionScope.kind === 'project' ? { projectWorkspaceId: input.workspaceId } : {}),
    ...overrides,
  }
}

export function explicitProjectPlan() {
  const input = createExecutionPlanTestFixtureInputs({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...input,
    correlation: {
      ...input.correlation,
      executionScope: { schemaVersion: 1, kind: 'project', projectId: input.correlation.projectId },
    },
  })
}
