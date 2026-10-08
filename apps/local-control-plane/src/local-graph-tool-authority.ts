import { isDeepStrictEqual } from 'node:util'
import { createRequire } from 'node:module'
import { GraphToolPinSchema, type GraphSelection } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import {
  PublishedGraphDefinitionSchema,
  type GraphNodeOperation,
  type PublishedGraphDefinition,
} from '@control-plane/orchestration'
import type { ToolRegistry } from '@control-plane/tool-execution/registry'
import type { LocalControlApiComposition } from './local-api-composition.js'

const semver = createRequire(import.meta.url)('semver') as {
  satisfies(version: string, range: string): boolean
}

export async function authorizeLocalGraphTool(
  operation: GraphNodeOperation,
  options: {
    readonly api: LocalControlApiComposition
    readonly registry: ToolRegistry
    readonly resolveGraph: (
      workspaceId: string,
      reference: GraphSelection
    ) => Promise<PublishedGraphDefinition>
    /** Reconstruct persisted effect identity without granting a new delivery. */
    readonly historicalVerification?: boolean
  }
) {
  const execution = await options.api.executions.getExecution(operation.executionId)
  const attempt = await options.api.executions.getAttempt(operation.attemptId)
  const command = await options.api.commandRepository.getByExecutionId(operation.executionId)
  if (
    operation.kind !== 'tool' ||
    !execution ||
    !attempt ||
    !command ||
    execution.correlation.projectId === undefined ||
    execution.correlation.workspaceId !== operation.workspaceId ||
    execution.correlation.projectId !== command.projectId ||
    command.workspaceId !== operation.workspaceId ||
    operation.workflowId !== 'wfl_' + execution.executionId.slice(4) ||
    operation.threadId !== 'graph:' + execution.executionId ||
    execution.latestAttemptId !== operation.attemptId ||
    attempt.executionId !== execution.executionId ||
    !isDeepStrictEqual(command.executionPlan, execution.executionPlan) ||
    (!options.historicalVerification &&
      (!['running', 'awaiting_input'].includes(execution.state) ||
        !['running', 'awaiting_input'].includes(attempt.state)))
  )
    throw new Error('GRAPH_TOOL_EXECUTION_AUTHORITY_MISMATCH')
  const stored = await options.api.executionPlans.get(execution.executionPlan)
  if (!stored) throw new Error('GRAPH_TOOL_PLAN_MISSING')
  const plan = assertExecutionPlanIntegrity(stored)
  if (!plan.graph || !isDeepStrictEqual(plan.correlation, execution.correlation)) {
    throw new Error('GRAPH_TOOL_PLAN_MISMATCH')
  }
  const graph = PublishedGraphDefinitionSchema.parse(
    await options.resolveGraph(operation.workspaceId, plan.graph)
  )
  if (!isDeepStrictEqual(graph.reference, plan.graph.reference))
    throw new Error('GRAPH_TOOL_PIN_MISMATCH')
  const graphNode = graph.content.nodes.find(({ node: name }) => name === operation.node)
  if (
    !graphNode ||
    graphNode.operation.kind !== 'tool' ||
    graphNode.operation.name !== operation.name ||
    !graphNode.operation.toolPin
  ) {
    throw new Error('GRAPH_TOOL_NODE_MISMATCH')
  }
  const pin = GraphToolPinSchema.parse(graphNode.operation.toolPin)
  if ('toolPin' in operation && !isDeepStrictEqual(operation.toolPin, pin))
    throw new Error('GRAPH_TOOL_PIN_MISMATCH')
  const definition = await options.registry.readDefinition(
    pin.toolDefinitionId,
    operation.workspaceId
  )
  const version = await options.registry.readVersion(pin.toolVersionId, operation.workspaceId)
  if (
    version.toolDefinitionId !== pin.toolDefinitionId ||
    version.contentDigest !== pin.contentDigest ||
    (!options.historicalVerification && !['published', 'deprecated'].includes(version.lifecycle))
  ) {
    throw new Error('GRAPH_TOOL_VERSION_MISMATCH')
  }
  const toolOperation = version.operations.find(({ name }) => name === pin.operation)
  const grants = plan.constraints.tools.grants.filter(
    (grant) =>
      grant.tool.toolId === definition.name &&
      semver.satisfies(version.semanticVersion, grant.tool.versionRange) &&
      grant.operations.includes(pin.operation)
  )
  // Multiple overlapping logical grants cannot silently choose a weaker approval/risk policy.
  if (!toolOperation || grants.length === 0) throw new Error('GRAPH_TOOL_GRANT_DENIED')
  if (
    grants.some((grant) =>
      toolOperation.requiredCapabilities.some(
        (capability) => !grant.requiredCapabilities.includes(capability)
      )
    )
  ) {
    throw new Error('GRAPH_TOOL_CAPABILITY_DENIED')
  }
  const riskCeiling = { safe: 0, read: 0, write: 1, destructive: 2, privileged: 3 } as const
  const operationRisk = { low: 0, medium: 1, high: 2, critical: 3 } as const
  if (
    grants.some((grant) => operationRisk[toolOperation.riskClass] > riskCeiling[grant.riskClass])
  ) {
    throw new Error('GRAPH_TOOL_RISK_DENIED')
  }
  const destructive = grants.some((grant) =>
    ['destructive', 'privileged'].includes(grant.riskClass)
  )
  if (destructive && plan.constraints.interaction.destructiveOperations === 'deny')
    throw new Error('GRAPH_TOOL_POLICY_DENIED')
  const requiresApproval =
    toolOperation.approvalMode === 'always' ||
    grants.some((grant) => grant.approval !== 'none') ||
    plan.constraints.interaction.approvals === 'required' ||
    destructive
  if (requiresApproval && plan.constraints.interaction.approvals === 'disabled')
    throw new Error('GRAPH_TOOL_APPROVAL_DISABLED')
  return {
    projectId: execution.correlation.projectId,
    execution,
    attempt,
    command,
    plan,
    pin,
    definition,
    version,
    toolOperation,
    requiresApproval,
  }
}
