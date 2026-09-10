import { createHash } from 'node:crypto'
import { ContextPackageReferenceSchema, ContextPackageSchema } from '@control-plane/context'
import {
  IdentifierSchemas,
  ServiceCallerAssertionSchema,
  ExecutionRequestValidationRequestSchema,
} from '@control-plane/contracts'
import {
  AgentProfileVersionSchema,
  ExecutionConstraintSetSchema,
  SkillVersionSchema,
  composeExecutionConstraints,
  type ExecutionConstraintSet,
} from '@control-plane/domain'
import {
  CapabilityRequirementSchema,
  CapabilityRequirementSetSchema,
  RuntimeCapabilityNameSchema,
  type CapabilityRequirement,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const uniqueBy = <Value>(values: Value[], key: (value: Value) => string) =>
  new Set(values.map(key)).size === values.length

const CorrelationSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId,
    taskId: IdentifierSchemas.taskId,
    agentId: IdentifierSchemas.agentId,
    requestId: IdentifierSchemas.requestId,
  })
  .strict()

const ProfilePinSchema = z.object({
  profileId: IdentifierSchemas.profileId,
  profileVersionId: IdentifierSchemas.profileVersionId,
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  contentDigest: DigestSchema,
})

const SkillPinSchema = z.object({
  skillId: IdentifierSchemas.skillId,
  skillVersionId: IdentifierSchemas.skillVersionId,
  revision: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  semanticVersion: SemverSchema,
  contentDigest: DigestSchema,
})

const ContextPinSchema = ContextPackageReferenceSchema.extend({
  schemaVersion: z.number().int().positive(),
  compilerVersion: SemverSchema,
})

const OutputContractSchema = z.object({ contractRef: z.string().min(1).max(512) }).strict()

export const ExecutionPlanReferenceSchema = z.object({
  executionPlanId: IdentifierSchemas.executionPlanId,
  contentDigest: DigestSchema,
})

export const ExecutionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionPlanId: IdentifierSchemas.executionPlanId,
    contentDigest: DigestSchema,
    compiler: z.object({
      name: z.literal('control-plane-execution-plan'),
      version: SemverSchema,
    }),
    compiledAt: TimestampSchema,
    correlation: CorrelationSchema,
    profile: ProfilePinSchema,
    skills: z
      .array(SkillPinSchema)
      .max(128)
      .refine((values) => uniqueBy(values, (value) => value.skillVersionId)),
    contextPackage: ContextPinSchema,
    runtimeRequirements: CapabilityRequirementSetSchema,
    constraints: ExecutionConstraintSetSchema,
    policySnapshot: ExecutionConstraintSetSchema.shape.policySnapshot,
    outputContract: OutputContractSchema,
    parentExecutionPlan: ExecutionPlanReferenceSchema.optional(),
  })
  .refine((plan) => canonical(plan.policySnapshot) === canonical(plan.constraints.policySnapshot), {
    message: 'ExecutionPlan policy snapshot must match its resolved constraints',
  })

export type ExecutionPlan = z.output<typeof ExecutionPlanSchema>
export type ExecutionPlanReference = z.output<typeof ExecutionPlanReferenceSchema>

const CompilationInputSchema = z
  .object({
    correlation: CorrelationSchema,
    profile: AgentProfileVersionSchema.optional(),
    skills: z.array(SkillVersionSchema).max(128),
    contextPackage: ContextPackageSchema.optional(),
    constraints: ExecutionConstraintSetSchema,
    requestConstraints: z.array(ExecutionConstraintSetSchema).max(32).default([]),
    runtimeRequirements: CapabilityRequirementSetSchema,
    outputContract: OutputContractSchema,
    compiledAt: TimestampSchema,
  })
  .strict()

const ChildInputSchema = z
  .object({
    correlation: CorrelationSchema,
    contextPackage: ContextPackageSchema,
    constraints: ExecutionConstraintSetSchema,
    runtimeRequirements: CapabilityRequirementSetSchema,
    outputContract: OutputContractSchema,
    compiledAt: TimestampSchema,
  })
  .strict()

export type ExecutionPlanErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_PROFILE_VERSION'
  | 'MISSING_SKILL_VERSION'
  | 'MISSING_CONTEXT_PACKAGE'
  | 'INVALID_REFERENCE'
  | 'REVOKED_REFERENCE'
  | 'DEPRECATED_REFERENCE'
  | 'INCOMPATIBLE_REFERENCE'
  | 'CONTRADICTORY_REFERENCE'
  | 'CONTRADICTORY_REQUIREMENTS'
  | 'CONTEXT_CONSTRAINT_VIOLATION'
  | 'CHILD_AUTHORITY_EXPANSION'
  | 'CHILD_CONTEXT_EXPANSION'

export class ExecutionPlanError extends Error {
  constructor(
    readonly code: ExecutionPlanErrorCode,
    readonly reference?: string
  ) {
    super(reference ? `${code}:${reference}` : code)
    this.name = 'ExecutionPlanError'
  }
}

export class ExecutionPlanCompiler {
  constructor(readonly version: string) {
    if (!SemverSchema.safeParse(version).success) throw new Error('INVALID_PLAN_COMPILER_VERSION')
  }

  compile(input: unknown): ExecutionPlan {
    const parsed = parseCompilationInput(input)
    const profile = parsed.profile
    if (!profile) fail('MISSING_PROFILE_VERSION')
    assertLifecycle(profile.lifecycle, profile.profileVersionId)
    const contextPackage = parsed.contextPackage
    if (!contextPackage) fail('MISSING_CONTEXT_PACKAGE')
    const skills = resolveSkills(profile, parsed.skills)
    let constraints: ExecutionConstraintSet
    try {
      constraints = composeExecutionConstraints([
        profile.definition.executionConstraints,
        parsed.constraints,
        ...parsed.requestConstraints,
      ])
    } catch (error) {
      fail('CONTRADICTORY_REQUIREMENTS', safeReason(error))
    }
    assertSkillCompatibility(profile, skills, constraints)
    assertOutputContract(profile.definition.outputContractRefs, parsed.outputContract.contractRef)
    assertContext(contextPackage, constraints)
    const runtimeRequirements = compileRuntimeRequirements(
      parsed.runtimeRequirements,
      profile.definition.capabilityRequirements,
      skills.flatMap((skill) => skill.manifest.requiredCapabilities),
      constraints.runtime.requiredCapabilities
    )
    return finalizePlan({
      schemaVersion: 1,
      compiler: { name: 'control-plane-execution-plan', version: this.version },
      compiledAt: parsed.compiledAt,
      correlation: parsed.correlation,
      profile: {
        profileId: profile.profileId,
        profileVersionId: profile.profileVersionId,
        version: profile.version,
        revision: profile.revision,
        schemaVersion: profile.definition.schemaVersion,
        contentDigest: profile.contentDigest,
      },
      skills: skills
        .map((skill) => ({
          skillId: skill.skillId,
          skillVersionId: skill.skillVersionId,
          revision: skill.revision,
          schemaVersion: skill.manifest.schemaVersion,
          semanticVersion: skill.manifest.semanticVersion,
          contentDigest: skill.manifest.contentDigest,
        }))
        .toSorted((left, right) => left.skillVersionId.localeCompare(right.skillVersionId)),
      contextPackage: contextPin(contextPackage),
      runtimeRequirements,
      constraints: normalizeConstraints(constraints),
      policySnapshot: constraints.policySnapshot,
      outputContract: parsed.outputContract,
    })
  }
}

export function deriveExecutionPlan(parentInput: unknown, input: unknown): ExecutionPlan {
  const parent = parsePlan(parentInput)
  const child = parseChildInput(input)
  if (
    child.correlation.workspaceId !== parent.correlation.workspaceId ||
    child.correlation.projectId !== parent.correlation.projectId ||
    child.correlation.agentId !== parent.correlation.agentId
  ) {
    fail('CHILD_AUTHORITY_EXPANSION', 'correlation')
  }
  if (child.outputContract.contractRef !== parent.outputContract.contractRef) {
    fail('CHILD_AUTHORITY_EXPANSION', 'output-contract')
  }
  assertContextIntegrity(child.contextPackage)
  const sameContext =
    child.contextPackage.contextPackageId === parent.contextPackage.contextPackageId &&
    child.contextPackage.contentDigest === parent.contextPackage.contentDigest
  const derivedContext =
    child.contextPackage.parentContextPackage?.contextPackageId ===
      parent.contextPackage.contextPackageId &&
    child.contextPackage.parentContextPackage.contentDigest === parent.contextPackage.contentDigest
  if (!sameContext && !derivedContext) fail('CHILD_CONTEXT_EXPANSION')
  assertChildConstraints(parent.constraints, child.constraints)
  assertChildRuntimeRequirements(parent.runtimeRequirements, child.runtimeRequirements)
  return finalizePlan({
    ...parent,
    executionPlanId: undefined,
    contentDigest: undefined,
    compiledAt: child.compiledAt,
    correlation: child.correlation,
    contextPackage: contextPin(child.contextPackage),
    runtimeRequirements: normalizeRuntimeRequirements(child.runtimeRequirements),
    constraints: normalizeConstraints(child.constraints),
    policySnapshot: child.constraints.policySnapshot,
    outputContract: child.outputContract,
    parentExecutionPlan: {
      executionPlanId: parent.executionPlanId,
      contentDigest: parent.contentDigest,
    },
  })
}

export interface ExecutionPlanRepository {
  put(plan: ExecutionPlan): Promise<ExecutionPlanReference>
  get(reference: ExecutionPlanReference): Promise<ExecutionPlan | undefined>
}

export const ExecutionValidationCommandScopeSchema = z
  .object({
    callerPrincipalId: ServiceCallerAssertionSchema.shape.servicePrincipalId,
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId,
    operation: z.literal('execution.validate'),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict()

export const ExecutionValidationCommandRecordSchema = z
  .object({
    scope: ExecutionValidationCommandScopeSchema,
    commandId: IdentifierSchemas.commandId,
    requestId: IdentifierSchemas.requestId,
    payloadHash: DigestSchema,
    executionPlan: ExecutionPlanReferenceSchema,
    recordedAt: TimestampSchema,
  })
  .strict()

export type ExecutionValidationCommandScope = z.output<typeof ExecutionValidationCommandScopeSchema>
export type ExecutionValidationCommandRecord = z.output<
  typeof ExecutionValidationCommandRecordSchema
>

export interface ExecutionValidationCommandRepository {
  get(scope: ExecutionValidationCommandScope): Promise<ExecutionValidationCommandRecord | undefined>
  /** Atomically persist the first command/plan pair; reject same-key payload conflicts. */
  commit(
    record: ExecutionValidationCommandRecord,
    plan: ExecutionPlan
  ): Promise<ExecutionValidationCommandRecord>
}

export function executionValidationCommandKey(input: ExecutionValidationCommandScope): string {
  const scope = ExecutionValidationCommandScopeSchema.parse(input)
  return sha256([
    scope.callerPrincipalId,
    scope.workspaceId,
    scope.projectId,
    scope.operation,
    scope.idempotencyKey,
  ]).slice(7)
}

/** Hash semantic inputs, not the caller-supplied hash or retry transport metadata. */
export function executionValidationPayloadHash(input: unknown): string {
  const request = ExecutionRequestValidationRequestSchema.parse(input)
  return sha256({ contractVersion: request.contractVersion, payload: request.payload })
}

export function assertExecutionValidationCommandPlan(
  input: ExecutionValidationCommandRecord,
  planInput: ExecutionPlan
): ExecutionValidationCommandRecord {
  const record = ExecutionValidationCommandRecordSchema.parse(input)
  const plan = assertExecutionPlanIntegrity(planInput)
  if (
    record.scope.workspaceId !== plan.correlation.workspaceId ||
    record.scope.projectId !== plan.correlation.projectId ||
    record.requestId !== plan.correlation.requestId ||
    record.executionPlan.executionPlanId !== plan.executionPlanId ||
    record.executionPlan.contentDigest !== plan.contentDigest
  )
    throw new Error('EXECUTION_VALIDATION_COMMAND_PLAN_MISMATCH')
  return record
}

export class InMemoryExecutionPlanRepository implements ExecutionPlanRepository {
  readonly #plans = new Map<string, ExecutionPlan>()

  async put(input: ExecutionPlan): Promise<ExecutionPlanReference> {
    const plan = assertExecutionPlanIntegrity(input)
    const existing = this.#plans.get(plan.executionPlanId)
    if (existing && existing.contentDigest !== plan.contentDigest) {
      throw new Error('EXECUTION_PLAN_ID_CONFLICT')
    }
    this.#plans.set(plan.executionPlanId, structuredClone(plan))
    return { executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest }
  }

  async get(input: ExecutionPlanReference): Promise<ExecutionPlan | undefined> {
    const reference = ExecutionPlanReferenceSchema.parse(input)
    const plan = this.#plans.get(reference.executionPlanId)
    if (!plan || plan.contentDigest !== reference.contentDigest) return undefined
    return structuredClone(plan)
  }
}

export function assertExecutionPlanIntegrity(input: unknown): ExecutionPlan {
  const plan = parsePlan(input)
  assertPlanIntegrity(plan)
  return plan
}

export class ExecutionPlanAcceptanceValidator {
  constructor(readonly repository: ExecutionPlanRepository) {}

  async validate(input: {
    readonly executionPlan: ExecutionPlanReference & { readonly schemaVersion: number }
    readonly workspaceId: string
    readonly projectId: string
    readonly taskId: string
    readonly agentId: string
  }): Promise<boolean> {
    const plan = await this.repository.get(input.executionPlan)
    return (
      plan !== undefined &&
      plan.schemaVersion === input.executionPlan.schemaVersion &&
      plan.correlation.workspaceId === input.workspaceId &&
      plan.correlation.projectId === input.projectId &&
      plan.correlation.taskId === input.taskId &&
      plan.correlation.agentId === input.agentId
    )
  }
}

function parseCompilationInput(input: unknown): z.output<typeof CompilationInputSchema> {
  const result = CompilationInputSchema.safeParse(input)
  if (!result.success) fail('INVALID_INPUT')
  return result.data
}

function parseChildInput(input: unknown): z.output<typeof ChildInputSchema> {
  const result = ChildInputSchema.safeParse(input)
  if (!result.success) fail('INVALID_INPUT')
  return result.data
}

function parsePlan(input: unknown): ExecutionPlan {
  const result = ExecutionPlanSchema.safeParse(input)
  if (!result.success) fail('INVALID_INPUT')
  return result.data
}

function assertLifecycle(lifecycle: string, reference: string): void {
  if (lifecycle === 'revoked') fail('REVOKED_REFERENCE', reference)
  if (lifecycle === 'deprecated' || lifecycle === 'superseded') {
    fail('DEPRECATED_REFERENCE', reference)
  }
  if (lifecycle !== 'published') fail('INVALID_REFERENCE', reference)
}

function resolveSkills(
  profile: z.output<typeof AgentProfileVersionSchema>,
  supplied: z.output<typeof SkillVersionSchema>[]
): z.output<typeof SkillVersionSchema>[] {
  if (!uniqueBy(supplied, (skill) => skill.skillVersionId)) {
    fail('CONTRADICTORY_REFERENCE', 'duplicate-skill-version')
  }
  const required = profile.definition.skills
  const resolved = required.map((pin) => {
    const skill = supplied.find((candidate) => candidate.skillVersionId === pin.skillVersionId)
    if (!skill) fail('MISSING_SKILL_VERSION', pin.skillVersionId)
    assertLifecycle(skill.lifecycle, skill.skillVersionId)
    if (skill.skillId !== pin.skillId || skill.manifest.contentDigest !== pin.contentDigest) {
      fail('CONTRADICTORY_REFERENCE', pin.skillVersionId)
    }
    return skill
  })
  if (supplied.length !== required.length) fail('CONTRADICTORY_REFERENCE', 'skill-set')
  return resolved
}

function assertSkillCompatibility(
  profile: z.output<typeof AgentProfileVersionSchema>,
  skills: z.output<typeof SkillVersionSchema>[],
  constraints: ExecutionConstraintSet
): void {
  for (const skill of skills) {
    if (
      !skill.manifest.compatibleProfileSchemaVersions.includes(profile.definition.schemaVersion) ||
      !skill.manifest.compatibleContractMajorVersions.includes(1)
    ) {
      fail('INCOMPATIBLE_REFERENCE', skill.skillVersionId)
    }
    for (const required of skill.manifest.requiredTools) {
      if (
        !constraints.tools.grants.some(
          (grant) =>
            grant.tool.toolId === required.toolId &&
            grant.tool.versionRange === required.versionRange
        )
      ) {
        fail('INCOMPATIBLE_REFERENCE', `tool:${required.toolId}`)
      }
    }
  }
}

function assertOutputContract(allowed: string[], requested: string): void {
  if (!allowed.includes(requested)) fail('INCOMPATIBLE_REFERENCE', requested)
}

function assertContext(
  contextPackage: z.output<typeof ContextPackageSchema>,
  constraints: ExecutionConstraintSet
): void {
  if (
    contextPackage.usage.bytes > constraints.context.maximumBytes ||
    contextPackage.stateItems.length > constraints.context.maximumItems ||
    [...contextPackage.stateItems, ...contextPackage.artifactRefs].some(
      (entry) => !constraints.context.allowedClassifications.includes(entry.sensitivity)
    )
  ) {
    fail('CONTEXT_CONSTRAINT_VIOLATION', contextPackage.contextPackageId)
  }
  assertContextIntegrity(contextPackage)
}

function assertContextIntegrity(contextPackage: z.output<typeof ContextPackageSchema>): void {
  const content = omitIdentity(contextPackage, 'contextPackageId')
  const expectedDigest = sha256(normalize(content))
  if (
    contextPackage.contentDigest !== expectedDigest ||
    contextPackage.contextPackageId !== hashIdentifier('ctx', expectedDigest)
  ) {
    fail('CONTRADICTORY_REFERENCE', contextPackage.contextPackageId)
  }
}

function contextPin(contextPackage: z.output<typeof ContextPackageSchema>) {
  return {
    contextPackageId: contextPackage.contextPackageId,
    contentDigest: contextPackage.contentDigest,
    schemaVersion: contextPackage.schemaVersion,
    compilerVersion: contextPackage.compiler.version,
  }
}

function compileRuntimeRequirements(
  requested: readonly CapabilityRequirement[],
  ...implicitGroups: readonly string[][]
) {
  const combined: CapabilityRequirement[] = [...requested]
  for (const capability of implicitGroups.flat()) {
    if (!RuntimeCapabilityNameSchema.safeParse(capability).success) {
      fail('INCOMPATIBLE_REFERENCE', `runtime-capability:${capability}`)
    }
    combined.push({
      capability,
      necessity: 'required',
      minimumSupport: 'supported',
    } as CapabilityRequirement)
  }
  const byCapability = new Map<string, z.output<typeof CapabilityRequirementSchema>>()
  for (const raw of combined) {
    const requirement = CapabilityRequirementSchema.parse(raw)
    const existing = byCapability.get(requirement.capability)
    byCapability.set(requirement.capability, {
      capability: requirement.capability,
      necessity:
        existing?.necessity === 'required' || requirement.necessity === 'required'
          ? 'required'
          : 'optional',
      minimumSupport:
        existing?.minimumSupport === 'supported' || requirement.minimumSupport === 'supported'
          ? 'supported'
          : 'degraded',
    })
  }
  return normalizeRuntimeRequirements([...byCapability.values()])
}

function normalizeRuntimeRequirements(requirements: readonly CapabilityRequirement[]) {
  return CapabilityRequirementSetSchema.parse(requirements).toSorted((left, right) =>
    left.capability.localeCompare(right.capability)
  )
}

function assertChildConstraints(
  parent: ExecutionConstraintSet,
  child: ExecutionConstraintSet
): void {
  let intersection: ExecutionConstraintSet
  try {
    intersection = composeExecutionConstraints([parent, child])
  } catch {
    fail('CHILD_AUTHORITY_EXPANSION')
  }
  if (canonical(normalizeConstraints(intersection)) !== canonical(normalizeConstraints(child))) {
    fail('CHILD_AUTHORITY_EXPANSION')
  }
}

function assertChildRuntimeRequirements(
  parent: readonly z.output<typeof CapabilityRequirementSchema>[],
  child: readonly CapabilityRequirement[]
): void {
  const normalizedChild = normalizeRuntimeRequirements(child)
  const byCapability = new Map(normalizedChild.map((entry) => [entry.capability, entry]))
  for (const parentRequirement of parent) {
    if (parentRequirement.necessity !== 'required') continue
    const childRequirement = byCapability.get(parentRequirement.capability)
    if (
      !childRequirement ||
      childRequirement.necessity !== 'required' ||
      (parentRequirement.minimumSupport === 'supported' &&
        childRequirement.minimumSupport !== 'supported')
    ) {
      fail('CHILD_AUTHORITY_EXPANSION', parentRequirement.capability)
    }
  }
}

function normalizeConstraints(constraints: ExecutionConstraintSet): ExecutionConstraintSet {
  return ExecutionConstraintSetSchema.parse({
    ...constraints,
    context: {
      ...constraints.context,
      allowedClassifications: [...constraints.context.allowedClassifications].toSorted(),
    },
    tools: {
      default: 'deny',
      grants: constraints.tools.grants
        .map((grant) => ({
          ...grant,
          tool: { ...grant.tool },
          operations: [...grant.operations].toSorted(),
          requiredCapabilities: [...grant.requiredCapabilities].toSorted(),
        }))
        .toSorted((left, right) =>
          `${left.tool.toolId}@${left.tool.versionRange}`.localeCompare(
            `${right.tool.toolId}@${right.tool.versionRange}`
          )
        ),
    },
    models: constraints.models
      .map((model) => ({
        ...model,
        requiredCapabilities: [...model.requiredCapabilities].toSorted(),
        providerPolicy: {
          allowedClasses: [...model.providerPolicy.allowedClasses].toSorted(),
          deniedProviders: [...model.providerPolicy.deniedProviders].toSorted(),
          dataResidency: [...model.providerPolicy.dataResidency].toSorted(),
        },
      }))
      .toSorted((left, right) => left.alias.localeCompare(right.alias)),
    runtime: {
      allowedFamilies: [...constraints.runtime.allowedFamilies].toSorted(),
      allowedLocations: [...constraints.runtime.allowedLocations].toSorted(),
      requiredCapabilities: [...constraints.runtime.requiredCapabilities].toSorted(),
    },
    limits: normalize(constraints.limits),
    interaction: normalize(constraints.interaction),
    policySnapshot: normalize(constraints.policySnapshot),
  })
}

function finalizePlan(input: Record<string, unknown>): ExecutionPlan {
  const normalized = normalize(input) as Record<string, unknown>
  const contentDigest = sha256(normalized)
  return ExecutionPlanSchema.parse({
    ...normalized,
    executionPlanId: hashIdentifier('pln', contentDigest),
    contentDigest,
  })
}

function assertPlanIntegrity(plan: ExecutionPlan): void {
  const content = omitIdentity(plan, 'executionPlanId')
  const expectedDigest = sha256(normalize(content))
  if (
    plan.contentDigest !== expectedDigest ||
    plan.executionPlanId !== hashIdentifier('pln', expectedDigest)
  ) {
    throw new Error('EXECUTION_PLAN_INTEGRITY_ERROR')
  }
}

function omitIdentity(value: Record<string, unknown>, idKey: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== idKey && key !== 'contentDigest')
  )
}

function hashIdentifier(prefix: string, digest: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = Buffer.from(digest.slice(7, 39), 'hex')
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return `${prefix}_${output.slice(0, 26)}`
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function canonical(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)])
    )
  }
  return value
}

function safeReason(error: unknown): string | undefined {
  return error instanceof Error ? error.message.slice(0, 256) : undefined
}

function fail(code: ExecutionPlanErrorCode, reference?: string): never {
  throw new ExecutionPlanError(code, reference)
}

export const packageName = 'execution-plan'
