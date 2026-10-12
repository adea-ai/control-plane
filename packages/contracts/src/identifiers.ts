import { z } from 'zod'

export type OpaqueIdentifier<Kind extends string> = string & {
  readonly __identifierKind: Kind
}

/** Opaque identifiers use a fixed canonical suffix after their three-character kind prefix. */
export const OPAQUE_IDENTIFIER_SUFFIX_LENGTH = 26

const opaqueIdentifier = <Kind extends string>(prefix: string, kind: Kind) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{${OPAQUE_IDENTIFIER_SUFFIX_LENGTH}}$`),
      `Expected a canonical opaque ${kind}`
    )
    .transform((value) => value as OpaqueIdentifier<Kind>)

export const IdentifierSchemas = {
  requestId: opaqueIdentifier('req', 'request ID'),
  commandId: opaqueIdentifier('cmd', 'command ID'),
  workspaceId: opaqueIdentifier('wsp', 'workspace ID'),
  projectId: opaqueIdentifier('prj', 'project ID'),
  taskId: opaqueIdentifier('tsk', 'task ID'),
  agentId: opaqueIdentifier('agt', 'Agent ID'),
  profileId: opaqueIdentifier('prf', 'profile ID'),
  profileVersionId: opaqueIdentifier('pfv', 'profile-version ID'),
  skillId: opaqueIdentifier('skl', 'Skill ID'),
  skillVersionId: opaqueIdentifier('skv', 'skill-version ID'),
  executionId: opaqueIdentifier('exe', 'execution ID'),
  delegationId: opaqueIdentifier('dlg', 'delegation ID'),
  delegationGroupId: opaqueIdentifier('dgr', 'delegation-group ID'),
  attemptId: opaqueIdentifier('att', 'attempt ID'),
  workflowId: opaqueIdentifier('wfl', 'workflow ID'),
  interactionId: opaqueIdentifier('int', 'interaction ID'),
  runtimeDefinitionId: opaqueIdentifier('rtd', 'runtime-definition ID'),
  runtimeNodeRefId: opaqueIdentifier('rnr', 'runtime-node reference ID'),
  runtimeConnectionId: opaqueIdentifier('rtc', 'runtime-connection ID'),
  externalSessionId: opaqueIdentifier('ses', 'external-session ID'),
  projectStateItemId: opaqueIdentifier('psi', 'ProjectState-item ID'),
  stateMutationId: opaqueIdentifier('stm', 'state-mutation ID'),
  statePromotionProposalId: opaqueIdentifier('spp', 'state-promotion-proposal ID'),
  contextPackageId: opaqueIdentifier('ctx', 'ContextPackage ID'),
  executionPlanId: opaqueIdentifier('pln', 'ExecutionPlan ID'),
  artifactId: opaqueIdentifier('art', 'Artifact reference ID'),
  toolDefinitionId: opaqueIdentifier('tld', 'tool-definition ID'),
  toolVersionId: opaqueIdentifier('tlv', 'tool-version ID'),
  toolCallId: opaqueIdentifier('tlc', 'tool-call ID'),
  credentialId: opaqueIdentifier('crd', 'credential ID'),
  credentialLeaseId: opaqueIdentifier('crl', 'credential-lease ID'),
  modelCallId: opaqueIdentifier('mdc', 'model-call ID'),
  memoryWriteProposalId: opaqueIdentifier('mwp', 'memory-write-proposal ID'),
  eventId: opaqueIdentifier('evt', 'event ID'),
  traceId: opaqueIdentifier('trc', 'trace ID'),
} as const

export type RequestId = z.output<(typeof IdentifierSchemas)['requestId']>
export type CommandId = z.output<(typeof IdentifierSchemas)['commandId']>
export type WorkspaceId = z.output<(typeof IdentifierSchemas)['workspaceId']>
export type ProjectId = z.output<(typeof IdentifierSchemas)['projectId']>
export type TaskId = z.output<(typeof IdentifierSchemas)['taskId']>
export type AgentId = z.output<(typeof IdentifierSchemas)['agentId']>
export type ProfileId = z.output<(typeof IdentifierSchemas)['profileId']>
export type ProfileVersionId = z.output<(typeof IdentifierSchemas)['profileVersionId']>
export type SkillId = z.output<(typeof IdentifierSchemas)['skillId']>
export type SkillVersionId = z.output<(typeof IdentifierSchemas)['skillVersionId']>
export type ExecutionId = z.output<(typeof IdentifierSchemas)['executionId']>
export type DelegationId = z.output<(typeof IdentifierSchemas)['delegationId']>
export type DelegationGroupId = z.output<(typeof IdentifierSchemas)['delegationGroupId']>
export type AttemptId = z.output<(typeof IdentifierSchemas)['attemptId']>
export type WorkflowId = z.output<(typeof IdentifierSchemas)['workflowId']>
export type InteractionId = z.output<(typeof IdentifierSchemas)['interactionId']>
export type RuntimeDefinitionId = z.output<(typeof IdentifierSchemas)['runtimeDefinitionId']>
export type RuntimeNodeRefId = z.output<(typeof IdentifierSchemas)['runtimeNodeRefId']>
export type RuntimeConnectionId = z.output<(typeof IdentifierSchemas)['runtimeConnectionId']>
export type ExternalSessionId = z.output<(typeof IdentifierSchemas)['externalSessionId']>
export type ProjectStateItemId = z.output<(typeof IdentifierSchemas)['projectStateItemId']>
export type StateMutationId = z.output<(typeof IdentifierSchemas)['stateMutationId']>
export type StatePromotionProposalId = z.output<
  (typeof IdentifierSchemas)['statePromotionProposalId']
>
export type ContextPackageId = z.output<(typeof IdentifierSchemas)['contextPackageId']>
export type ExecutionPlanId = z.output<(typeof IdentifierSchemas)['executionPlanId']>
export type ArtifactId = z.output<(typeof IdentifierSchemas)['artifactId']>
export type ToolDefinitionId = z.output<(typeof IdentifierSchemas)['toolDefinitionId']>
export type ToolVersionId = z.output<(typeof IdentifierSchemas)['toolVersionId']>
export type ToolCallId = z.output<(typeof IdentifierSchemas)['toolCallId']>
export type CredentialId = z.output<(typeof IdentifierSchemas)['credentialId']>
export type CredentialLeaseId = z.output<(typeof IdentifierSchemas)['credentialLeaseId']>
export type ModelCallId = z.output<(typeof IdentifierSchemas)['modelCallId']>
export type MemoryWriteProposalId = z.output<(typeof IdentifierSchemas)['memoryWriteProposalId']>
export type EventId = z.output<(typeof IdentifierSchemas)['eventId']>
export type TraceId = z.output<(typeof IdentifierSchemas)['traceId']>
