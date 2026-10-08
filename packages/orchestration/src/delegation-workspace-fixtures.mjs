import {
  ContextPackageCompiler,
  bindProjectContextPackageToWorkspaceParent,
  contextPackageSerializationFixtures,
} from '@control-plane/context'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { ids, parentPlanInput } from './delegation-fixtures.mjs'

export const now = '2026-08-25T18:01:00.000Z'
export const actor = 'user:original-canonical-actor'
export const workspaceScope = { schemaVersion: 1, kind: 'workspace' }

export function workspaceInput() {
  const input = parentPlanInput()
  const legacy = contextPackageSerializationFixtures.futurePi
  const base = {
    workspaceId: ids.workspaceId,
    executionScope: workspaceScope,
    revision: 4,
    objective: 'Coordinate one bounded project child',
    artifacts: [],
    constraints: {
      ...legacy.constraints,
      allowedStateItemIds: [],
      allowedArtifactIds: [],
    },
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  }
  const compiler = new ContextPackageCompiler('1.0.0')
  const parentContext = compiler.compileWorkspace(base)
  delete input.correlation.projectId
  input.correlation.executionScope = workspaceScope
  input.contextPackage = parentContext
  input.constraints.limits.childExecutions.maximumTotal = 1
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(input)
  const projectContext = compiler.compile({
    objective: base.objective,
    projectState: {
      schemaVersion: 1,
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      revision: 4,
      items: [],
      createdAt: base.compiledAt,
      updatedAt: base.compiledAt,
    },
    expectedProjectStateRevision: 4,
    candidates: [],
    artifacts: [],
    constraints: base.constraints,
    permissions: [],
    successCriteria: base.successCriteria,
    returnContract: base.returnContract,
    budgets: base.budgets,
    compiledAt: base.compiledAt,
  })
  const childContext = bindProjectContextPackageToWorkspaceParent(parentContext, projectContext)
  const childConstraints = structuredClone(parentPlan.constraints)
  childConstraints.limits.budget.maximumMicrounits = 1_000_000
  childConstraints.limits.tokens.maximumTotal = 10_000
  childConstraints.limits.duration.maximumMs = 600_000
  return {
    parentPlan,
    parentContext,
    childContext,
    command: {
      delegationId: ids.delegationId,
      parentExecutionId: ids.parentExecutionId,
      childExecutionId: ids.childExecutionId,
      role: 'researcher',
      profileVersionId: ids.profileVersionId,
      objective: 'Research the bounded project question',
      parentPlan,
      childPlan: {
        correlation: {
          ...parentPlan.correlation,
          projectId: ids.projectId,
          executionScope: { schemaVersion: 1, kind: 'project', projectId: ids.projectId },
          taskId: ids.childTaskId,
          requestId: ids.childRequestId,
        },
        contextPackage: childContext,
        constraints: childConstraints,
        runtimeRequirements: parentPlan.runtimeRequirements.filter(
          (value) => value.capability !== 'execution.scope.workspace.v1'
        ),
        outputContract: parentPlan.outputContract,
        compiledAt: now,
      },
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'manual',
        maximumRetries: 0,
      },
      acceptedAt: now,
      deadlineAt: '2026-08-25T18:10:00.000Z',
    },
  }
}

export function currentSnapshot(input) {
  return {
    workspaceId: input.workspaceId,
    executionScope: input.executionScope,
    callerPrincipalId: input.callerPrincipalId,
    executionPlan: input.executionPlan,
    principalActive: true,
    grantActive: true,
    allowedPrincipalIds: [actor],
    expiresAt: '2026-09-01T00:00:00.000Z',
    ...(input.executionScope.kind === 'project' ? { projectWorkspaceId: ids.workspaceId } : {}),
  }
}
