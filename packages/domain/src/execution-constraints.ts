import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)
const unique = <Value>(values: Value[]) => new Set(values).size === values.length
const uniqueBy = <Value>(values: Value[], key: (value: Value) => string) =>
  new Set(values.map(key)).size === values.length

export const ToolDefinitionRefSchema = z.object({
  toolId: SlugSchema,
  versionRange: z.string().min(1).max(64),
})

export const ToolRiskClassSchema = z.enum(['safe', 'read', 'write', 'destructive', 'privileged'])
export const ApprovalModeSchema = z.enum(['none', 'per_execution', 'per_operation', 'always'])

export const ToolGrantSchema = z.object({
  tool: ToolDefinitionRefSchema,
  operations: z.array(SlugSchema).min(1).max(128).refine(unique),
  requiredCapabilities: z.array(SlugSchema).max(64).refine(unique).default([]),
  riskClass: ToolRiskClassSchema,
  approval: ApprovalModeSchema,
})
export const ToolOperationRequirementSchema = ToolGrantSchema

export const ToolAccessPolicySchema = z.object({
  default: z.literal('deny'),
  grants: z
    .array(ToolGrantSchema)
    .max(128)
    .refine((grants) => uniqueBy(grants, toolGrantKey), {
      message: 'Tool grants must be unique by tool identity and version range',
    }),
})

export const ModelCapabilitySchema = z.enum([
  'text_generation',
  'vision_input',
  'audio_input',
  'tool_calling',
  'structured_output',
  'reasoning',
  'long_context',
])
export const ModelProviderClassSchema = z.enum(['managed', 'local', 'private_cloud'])

export const LogicalModelAliasSchema = SlugSchema
export const ModelRequirementSchema = z
  .object({
    alias: SlugSchema,
    requiredCapabilities: z.array(ModelCapabilitySchema).max(32).refine(unique),
    providerPolicy: z.object({
      allowedClasses: z.array(ModelProviderClassSchema).min(1).refine(unique),
      deniedProviders: z.array(SlugSchema).max(64).refine(unique),
      dataResidency: z
        .array(z.enum(['us', 'eu', 'global', 'local']))
        .min(1)
        .refine(unique),
    }),
    fallback: z.enum(['none', 'same_alias', 'same_capabilities']),
  })
  .strict()

const PositiveLimitSchema = z.number().int().positive()
export const ExecutionLimitsSchema = z.object({
  budget: z.object({
    currency: z.literal('USD'),
    maximumMicrounits: PositiveLimitSchema,
  }),
  tokens: z.object({ maximumTotal: PositiveLimitSchema }),
  duration: z.object({ maximumMs: PositiveLimitSchema }),
  concurrency: z.object({ maximumParallel: PositiveLimitSchema }),
  childExecutions: z.object({
    maximumTotal: z.number().int().nonnegative(),
    maximumDepth: z.number().int().nonnegative(),
  }),
  sandbox: z.object({
    cpuMillicores: PositiveLimitSchema,
    memoryMebibytes: PositiveLimitSchema,
    storageMebibytes: PositiveLimitSchema,
  }),
})

export const InteractionPolicySchema = z.object({
  approvals: z.enum(['disabled', 'allowed', 'required']),
  userInput: z.enum(['disabled', 'allowed', 'required']),
  destructiveOperations: z.enum(['deny', 'require_approval']),
  approvalExpiryMs: PositiveLimitSchema,
})

export const PolicySnapshotReferenceSchema = z.object({
  policyId: SlugSchema,
  version: PositiveLimitSchema,
  digest: DigestSchema,
})

export const AuthorizationDecisionInputSchema = z.object({
  principalRef: z.string().min(1).max(256),
  action: SlugSchema,
  resourceRef: z.string().min(1).max(512),
  workspaceId: IdentifierSchemas.workspaceId,
  policySnapshot: PolicySnapshotReferenceSchema,
  context: z.record(z.string(), z.unknown()),
})

export const ContextConstraintsSchema = z.object({
  allowedClassifications: z
    .array(z.enum(['public', 'internal', 'confidential', 'restricted']))
    .min(1)
    .refine(unique),
  maximumItems: PositiveLimitSchema,
  maximumBytes: PositiveLimitSchema,
})

export const RuntimeConstraintsSchema = z.object({
  allowedFamilies: z.array(SlugSchema).min(1).max(32).refine(unique),
  allowedLocations: z
    .array(z.enum(['local', 'remote', 'hybrid']))
    .min(1)
    .refine(unique),
  requiredCapabilities: z.array(SlugSchema).max(64).refine(unique),
})

export const ExecutionConstraintSetSchema = z.object({
  schemaVersion: z.literal(1),
  context: ContextConstraintsSchema,
  tools: ToolAccessPolicySchema,
  models: z
    .array(ModelRequirementSchema)
    .min(1)
    .max(32)
    .refine((models) => uniqueBy(models, (model) => model.alias)),
  runtime: RuntimeConstraintsSchema,
  limits: ExecutionLimitsSchema,
  interaction: InteractionPolicySchema,
  policySnapshot: PolicySnapshotReferenceSchema,
})

export type ToolAccessPolicy = z.output<typeof ToolAccessPolicySchema>
export type ToolDefinitionRef = z.output<typeof ToolDefinitionRefSchema>
export type ToolOperationRequirement = z.output<typeof ToolOperationRequirementSchema>
export type ModelRequirement = z.output<typeof ModelRequirementSchema>
export type ExecutionLimits = z.output<typeof ExecutionLimitsSchema>
export type InteractionPolicy = z.output<typeof InteractionPolicySchema>
export type PolicySnapshotReference = z.output<typeof PolicySnapshotReferenceSchema>
export type AuthorizationDecisionInput = z.output<typeof AuthorizationDecisionInputSchema>
export type ContextConstraints = z.output<typeof ContextConstraintsSchema>
export type RuntimeConstraints = z.output<typeof RuntimeConstraintsSchema>
export type ExecutionConstraintSet = z.output<typeof ExecutionConstraintSetSchema>

export type ToolAccessDecision =
  | { readonly allowed: false; readonly reason: 'NO_MATCHING_GRANT' | 'OPERATION_NOT_GRANTED' }
  | {
      readonly allowed: true
      readonly riskClass: z.output<typeof ToolRiskClassSchema>
      readonly approval: z.output<typeof ApprovalModeSchema>
    }

export function evaluateToolAccess(
  policyInput: unknown,
  request: { readonly toolId: string; readonly versionRange: string; readonly operation: string }
): ToolAccessDecision {
  const policy = ToolAccessPolicySchema.parse(policyInput)
  const grants = policy.grants.filter(
    (grant) =>
      grant.tool.toolId === request.toolId && grant.tool.versionRange === request.versionRange
  )
  if (grants.length === 0) return { allowed: false, reason: 'NO_MATCHING_GRANT' }
  const grant = grants.find((candidate) => candidate.operations.includes(request.operation))
  if (!grant) return { allowed: false, reason: 'OPERATION_NOT_GRANTED' }
  return { allowed: true, riskClass: grant.riskClass, approval: grant.approval }
}

export function composeExecutionConstraints(inputs: readonly unknown[]): ExecutionConstraintSet {
  if (inputs.length === 0) throw new Error('CONSTRAINT_SET_REQUIRED')
  const constraints = inputs.map((input) => ExecutionConstraintSetSchema.parse(input))
  const [first, ...remaining] = constraints
  if (!first) throw new Error('CONSTRAINT_SET_REQUIRED')
  return remaining.reduce(composePair, first)
}

function composePair(
  left: ExecutionConstraintSet,
  right: ExecutionConstraintSet
): ExecutionConstraintSet {
  assertSamePolicy(left.policySnapshot, right.policySnapshot)
  return ExecutionConstraintSetSchema.parse({
    schemaVersion: 1,
    context: {
      allowedClassifications: intersection(
        left.context.allowedClassifications,
        right.context.allowedClassifications,
        'context:allowedClassifications'
      ),
      maximumItems: Math.min(left.context.maximumItems, right.context.maximumItems),
      maximumBytes: Math.min(left.context.maximumBytes, right.context.maximumBytes),
    },
    tools: composeTools(left.tools, right.tools),
    models: composeModels(left.models, right.models),
    runtime: {
      allowedFamilies: intersection(
        left.runtime.allowedFamilies,
        right.runtime.allowedFamilies,
        'runtime:allowedFamilies'
      ),
      allowedLocations: intersection(
        left.runtime.allowedLocations,
        right.runtime.allowedLocations,
        'runtime:allowedLocations'
      ),
      requiredCapabilities: union(
        left.runtime.requiredCapabilities,
        right.runtime.requiredCapabilities
      ),
    },
    limits: minimumLimits(left.limits, right.limits),
    interaction: {
      approvals: composeInteractionMode(
        left.interaction.approvals,
        right.interaction.approvals,
        'interaction:approvals'
      ),
      userInput: composeInteractionMode(
        left.interaction.userInput,
        right.interaction.userInput,
        'interaction:userInput'
      ),
      destructiveOperations:
        left.interaction.destructiveOperations === 'deny' ||
        right.interaction.destructiveOperations === 'deny'
          ? 'deny'
          : 'require_approval',
      approvalExpiryMs: Math.min(
        left.interaction.approvalExpiryMs,
        right.interaction.approvalExpiryMs
      ),
    },
    policySnapshot: left.policySnapshot,
  })
}

function composeTools(left: ToolAccessPolicy, right: ToolAccessPolicy): ToolAccessPolicy {
  const rightByKey = new Map(right.grants.map((grant) => [toolGrantKey(grant), grant]))
  const grants = left.grants.flatMap((leftGrant) => {
    const rightGrant = rightByKey.get(toolGrantKey(leftGrant))
    if (!rightGrant) return []
    const operations = leftGrant.operations.filter((operation) =>
      rightGrant.operations.includes(operation)
    )
    if (operations.length === 0) return []
    return [
      {
        tool: leftGrant.tool,
        operations: operations.toSorted(),
        requiredCapabilities: union(
          leftGrant.requiredCapabilities,
          rightGrant.requiredCapabilities
        ),
        riskClass: stricter(leftGrant.riskClass, rightGrant.riskClass, [
          'safe',
          'read',
          'write',
          'destructive',
          'privileged',
        ]),
        approval: stricter(leftGrant.approval, rightGrant.approval, [
          'none',
          'per_execution',
          'per_operation',
          'always',
        ]),
      },
    ]
  })
  return ToolAccessPolicySchema.parse({ default: 'deny', grants })
}

function composeModels(
  left: ExecutionConstraintSet['models'],
  right: ExecutionConstraintSet['models']
): ExecutionConstraintSet['models'] {
  const rightByAlias = new Map(right.map((model) => [model.alias, model]))
  return left.map((leftModel) => {
    const rightModel = rightByAlias.get(leftModel.alias)
    if (!rightModel) conflict(`model:${leftModel.alias}:alias`)
    return ModelRequirementSchema.parse({
      alias: leftModel.alias,
      requiredCapabilities: union(leftModel.requiredCapabilities, rightModel.requiredCapabilities),
      providerPolicy: {
        allowedClasses: intersection(
          leftModel.providerPolicy.allowedClasses,
          rightModel.providerPolicy.allowedClasses,
          `model:${leftModel.alias}:allowedClasses`
        ),
        deniedProviders: union(
          leftModel.providerPolicy.deniedProviders,
          rightModel.providerPolicy.deniedProviders
        ),
        dataResidency: intersection(
          leftModel.providerPolicy.dataResidency,
          rightModel.providerPolicy.dataResidency,
          `model:${leftModel.alias}:dataResidency`
        ),
      },
      fallback: stricter(leftModel.fallback, rightModel.fallback, [
        'same_capabilities',
        'same_alias',
        'none',
      ]),
    })
  })
}

function minimumLimits(
  left: ExecutionConstraintSet['limits'],
  right: ExecutionConstraintSet['limits']
): ExecutionConstraintSet['limits'] {
  return {
    budget: {
      currency: 'USD',
      maximumMicrounits: Math.min(left.budget.maximumMicrounits, right.budget.maximumMicrounits),
    },
    tokens: { maximumTotal: Math.min(left.tokens.maximumTotal, right.tokens.maximumTotal) },
    duration: { maximumMs: Math.min(left.duration.maximumMs, right.duration.maximumMs) },
    concurrency: {
      maximumParallel: Math.min(
        left.concurrency.maximumParallel,
        right.concurrency.maximumParallel
      ),
    },
    childExecutions: {
      maximumTotal: Math.min(left.childExecutions.maximumTotal, right.childExecutions.maximumTotal),
      maximumDepth: Math.min(left.childExecutions.maximumDepth, right.childExecutions.maximumDepth),
    },
    sandbox: {
      cpuMillicores: Math.min(left.sandbox.cpuMillicores, right.sandbox.cpuMillicores),
      memoryMebibytes: Math.min(left.sandbox.memoryMebibytes, right.sandbox.memoryMebibytes),
      storageMebibytes: Math.min(left.sandbox.storageMebibytes, right.sandbox.storageMebibytes),
    },
  }
}

function toolGrantKey(grant: { tool: { toolId: string; versionRange: string } }): string {
  return `${grant.tool.toolId}@${grant.tool.versionRange}`
}

function intersection<Value extends string>(
  left: readonly Value[],
  right: readonly Value[],
  path: string
): Value[] {
  const result = [...new Set(left.filter((value) => right.includes(value)))].toSorted()
  if (result.length === 0) conflict(path)
  return result
}

function union<Value extends string>(left: readonly Value[], right: readonly Value[]): Value[] {
  return [...new Set([...left, ...right])].toSorted()
}

function stricter<Value extends string>(left: Value, right: Value, order: readonly Value[]): Value {
  const value = order[Math.max(order.indexOf(left), order.indexOf(right))]
  if (!value) throw new Error('CONSTRAINT_ORDER_INVALID')
  return value
}

function composeInteractionMode(
  left: 'disabled' | 'allowed' | 'required',
  right: 'disabled' | 'allowed' | 'required',
  path: string
): 'disabled' | 'allowed' | 'required' {
  if (
    (left === 'disabled' && right === 'required') ||
    (left === 'required' && right === 'disabled')
  ) {
    conflict(path)
  }
  if (left === 'disabled' || right === 'disabled') return 'disabled'
  if (left === 'required' || right === 'required') return 'required'
  return 'allowed'
}

function assertSamePolicy(
  left: ExecutionConstraintSet['policySnapshot'],
  right: ExecutionConstraintSet['policySnapshot']
): void {
  if (
    left.policyId !== right.policyId ||
    left.version !== right.version ||
    left.digest !== right.digest
  ) {
    conflict('policySnapshot')
  }
}

function conflict(path: string): never {
  throw new Error(`CONSTRAINT_CONFLICT:${path}`)
}
