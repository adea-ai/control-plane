import { createHash, randomUUID } from 'node:crypto'
import {
  ContextContributionSchema,
  ContextProviderPolicySchema,
  ContextAuthoringInputsSchema,
  IdentifierSchemas,
  type ContextContribution,
} from '@control-plane/contracts'
import {
  ProjectStateSchema,
  type ProjectStateItem,
  type ProjectStateRepository,
} from '@control-plane/domain'
import { z } from 'zod'
import { ContextProviderResolver } from './provider.js'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SensitivitySchema = z.enum(['public', 'internal', 'confidential', 'restricted'])
const unique = <Value>(values: Value[]) => new Set(values).size === values.length

const ContextStateItemSchema = z.object({
  itemId: IdentifierSchemas.projectStateItemId,
  itemRevision: z.number().int().positive(),
  key: z.string().min(1).max(256),
  value: z.json(),
  sensitivity: SensitivitySchema,
  freshness: z.object({ observedAt: TimestampSchema, expiresAt: TimestampSchema.optional() }),
  provenance: z.object({
    sourceKind: z.enum(['principal', 'execution', 'artifact', 'system']),
    sourcePrincipalRef: z.string().min(1).max(256).optional(),
    sourceExecutionId: IdentifierSchemas.executionId.optional(),
    artifactRefs: z.array(IdentifierSchemas.artifactId),
    capturedAt: TimestampSchema,
  }),
  usage: z.object({
    bytes: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
  }),
})

const ContextArtifactRefSchema = z.object({
  artifactId: IdentifierSchemas.artifactId,
  contentDigest: DigestSchema,
  mediaType: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative(),
  sensitivity: SensitivitySchema,
})

export const ContextPackageReferenceSchema = z.object({
  contextPackageId: IdentifierSchemas.contextPackageId,
  contentDigest: DigestSchema,
})

export const ContextPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    contextPackageId: IdentifierSchemas.contextPackageId,
    contentDigest: DigestSchema,
    compiler: z.object({
      name: z.literal('control-plane-context'),
      version: z.string().min(1).max(64),
    }),
    compiledAt: TimestampSchema,
    objective: z.string().min(1).max(16_384),
    projectState: z.object({
      workspaceId: IdentifierSchemas.workspaceId,
      projectId: IdentifierSchemas.projectId,
      revision: z.number().int().nonnegative(),
    }),
    stateItems: z.array(ContextStateItemSchema).max(10_000),
    artifactRefs: z.array(ContextArtifactRefSchema).max(10_000),
    constraints: z.object({
      allowedSensitivities: z.array(SensitivitySchema).min(1).refine(unique),
      allowedStateItemIds: z.array(IdentifierSchemas.projectStateItemId).refine(unique),
      allowedArtifactIds: z.array(IdentifierSchemas.artifactId).refine(unique),
    }),
    permissions: z.array(z.string().min(1).max(256)).refine(unique),
    successCriteria: z.array(z.string().min(1).max(4_096)).min(1).max(128),
    returnContract: z.object({ contractRef: z.string().min(1).max(512) }),
    budgets: z.object({
      maximumBytes: z.number().int().positive(),
      maximumTokens: z.number().int().positive(),
    }),
    usage: z.object({
      bytes: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    }),
    truncation: z.object({
      truncated: z.boolean(),
      excluded: z.array(
        z.object({
          ref: z.string().min(1).max(512),
          reason: z.enum(['BUDGET_LIMIT', 'STALE_OPTIONAL']),
        })
      ),
    }),
    providerComposition: z
      .object({
        callerContextRefs: z.array(z.string().min(1).max(512)).max(128),
        localProjectGrantRefs: z.array(z.string().min(1).max(512)).max(128),
        contributions: z.array(ContextContributionSchema).max(128),
        resolution: z
          .object({
            status: z.enum(['disabled', 'omitted', 'included', 'degraded']),
            decisionReasons: z.array(z.string().min(1).max(256)).max(128),
          })
          .optional(),
      })
      .optional(),
    parentContextPackage: ContextPackageReferenceSchema.optional(),
  })
  .refine(
    (package_) =>
      package_.usage.bytes <= package_.budgets.maximumBytes &&
      package_.usage.tokens <= package_.budgets.maximumTokens,
    {
      message: 'ContextPackage usage exceeds its declared budgets',
    }
  )

export type ContextPackage = z.output<typeof ContextPackageSchema>
export type ContextPackageReference = z.output<typeof ContextPackageReferenceSchema>

const CandidateSchema = z.object({
  itemId: IdentifierSchemas.projectStateItemId,
  itemRevision: z.number().int().positive(),
  required: z.boolean(),
  priority: z.number().int(),
  authorized: z.boolean(),
})
const ArtifactCandidateSchema = ContextArtifactRefSchema.extend({
  state: z.enum(['available', 'missing', 'revoked']),
  authorized: z.boolean(),
})
const CompilationInputSchema = z.object({
  objective: z.string().min(1).max(16_384),
  projectState: ProjectStateSchema,
  expectedProjectStateRevision: z.number().int().nonnegative(),
  candidates: z.array(CandidateSchema).max(10_000),
  artifacts: z.array(ArtifactCandidateSchema).max(10_000),
  constraints: ContextPackageSchema.shape.constraints,
  permissions: ContextPackageSchema.shape.permissions,
  successCriteria: ContextPackageSchema.shape.successCriteria,
  returnContract: ContextPackageSchema.shape.returnContract,
  budgets: ContextPackageSchema.shape.budgets,
  compiledAt: TimestampSchema,
})

export type ContextCompilationErrorCode =
  | 'STALE_PROJECT_STATE'
  | 'MISSING_STATE_ITEM'
  | 'STATE_ITEM_VERSION_MISMATCH'
  | 'UNAUTHORIZED_CONTEXT'
  | 'STALE_REQUIRED_CONTEXT'
  | 'MISSING_ARTIFACT'
  | 'REVOKED_ARTIFACT'
  | 'CONTRADICTORY_CONTEXT_REFERENCE'
  | 'REQUIRED_CONTEXT_EXCEEDS_BUDGET'
  | 'CHILD_SCOPE_EXPANSION'
  | 'CHILD_BUDGET_EXPANSION'
  | 'CONTEXT_PROVIDER_INPUT_REQUIRED'

export class ContextCompilationError extends Error {
  constructor(
    readonly code: ContextCompilationErrorCode,
    readonly reference?: string
  ) {
    super(reference ? `${code}:${reference}` : code)
    this.name = 'ContextCompilationError'
  }
}

export class ContextPackageCompiler {
  constructor(readonly version: string) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      throw new Error('INVALID_CONTEXT_COMPILER_VERSION')
    }
  }

  compile(input: unknown): ContextPackage {
    const parsed = CompilationInputSchema.parse(input)
    if (parsed.projectState.revision !== parsed.expectedProjectStateRevision) {
      fail('STALE_PROJECT_STATE', `revision:${parsed.expectedProjectStateRevision}`)
    }
    assertUniqueCandidates(parsed.candidates)
    assertUniqueArtifacts(parsed.artifacts)
    const stateById = new Map(parsed.projectState.items.map((item) => [item.itemId, item]))
    const artifactsById = new Map(
      parsed.artifacts.map((artifact) => [artifact.artifactId, artifact])
    )
    const selected: ContextPackage['stateItems'] = []
    const selectedArtifacts = new Map<string, ContextPackage['artifactRefs'][number]>()
    const excluded: ContextPackage['truncation']['excluded'] = []
    let bytes = 0
    let tokens = 0
    const candidates = [...parsed.candidates].toSorted(
      (left, right) =>
        Number(right.required) - Number(left.required) ||
        right.priority - left.priority ||
        left.itemId.localeCompare(right.itemId)
    )
    for (const candidate of candidates) {
      const item = stateById.get(candidate.itemId)
      if (!item) fail('MISSING_STATE_ITEM', candidate.itemId)
      if (item.itemRevision !== candidate.itemRevision)
        fail('STATE_ITEM_VERSION_MISMATCH', candidate.itemId)
      assertAuthorizedItem(candidate, item, parsed.constraints)
      if (item.freshness.expiresAt && !isAfter(item.freshness.expiresAt, parsed.compiledAt)) {
        if (candidate.required) fail('STALE_REQUIRED_CONTEXT', candidate.itemId)
        excluded.push({ ref: `state-item:${candidate.itemId}`, reason: 'STALE_OPTIONAL' })
        continue
      }
      const itemUsage = estimateItem(item)
      const itemArtifacts = item.provenance.artifactRefs.map((id) =>
        resolveArtifact(id, artifactsById, parsed.constraints)
      )
      const newArtifacts = itemArtifacts.filter(
        (artifact) => !selectedArtifacts.has(artifact.artifactId)
      )
      const addedBytes =
        itemUsage.bytes + newArtifacts.reduce((sum, value) => sum + value.sizeBytes, 0)
      const addedTokens =
        itemUsage.tokens + newArtifacts.reduce((sum, value) => sum + tokensFor(value.sizeBytes), 0)
      if (
        bytes + addedBytes > parsed.budgets.maximumBytes ||
        tokens + addedTokens > parsed.budgets.maximumTokens
      ) {
        if (candidate.required) fail('REQUIRED_CONTEXT_EXCEEDS_BUDGET', candidate.itemId)
        excluded.push({ ref: `state-item:${candidate.itemId}`, reason: 'BUDGET_LIMIT' })
        continue
      }
      selected.push(toContextItem(item, itemUsage))
      for (const artifact of newArtifacts) selectedArtifacts.set(artifact.artifactId, artifact)
      bytes += addedBytes
      tokens += addedTokens
    }
    return finalizePackage({
      schemaVersion: 1,
      compiler: { name: 'control-plane-context', version: this.version },
      compiledAt: parsed.compiledAt,
      objective: parsed.objective,
      projectState: {
        workspaceId: parsed.projectState.workspaceId,
        projectId: parsed.projectState.projectId,
        revision: parsed.projectState.revision,
      },
      stateItems: selected.toSorted((left, right) => left.itemId.localeCompare(right.itemId)),
      artifactRefs: [...selectedArtifacts.values()].toSorted((left, right) =>
        left.artifactId.localeCompare(right.artifactId)
      ),
      constraints: normalizeConstraints(parsed.constraints),
      permissions: [...parsed.permissions].toSorted(),
      successCriteria: parsed.successCriteria,
      returnContract: parsed.returnContract,
      budgets: parsed.budgets,
      usage: { bytes, tokens },
      truncation: { truncated: excluded.length > 0, excluded },
    })
  }
}

export function deriveContextPackage(parentInput: unknown, input: unknown): ContextPackage {
  const parent = ContextPackageSchema.parse(parentInput)
  const parsed = z
    .object({
      objective: z.string().min(1).max(16_384),
      allowedStateItemIds: z.array(IdentifierSchemas.projectStateItemId).refine(unique),
      allowedArtifactIds: z.array(IdentifierSchemas.artifactId).refine(unique),
      budgets: ContextPackageSchema.shape.budgets,
      successCriteria: ContextPackageSchema.shape.successCriteria,
      returnContract: ContextPackageSchema.shape.returnContract,
      compiledAt: TimestampSchema,
    })
    .parse(input)
  assertSubset(parsed.allowedStateItemIds, parent.constraints.allowedStateItemIds)
  assertSubset(parsed.allowedArtifactIds, parent.constraints.allowedArtifactIds)
  assertSubset(
    parsed.allowedStateItemIds,
    parent.stateItems.map((item) => item.itemId)
  )
  assertSubset(
    parsed.allowedArtifactIds,
    parent.artifactRefs.map((artifact) => artifact.artifactId)
  )
  if (
    parsed.budgets.maximumBytes > parent.budgets.maximumBytes ||
    parsed.budgets.maximumTokens > parent.budgets.maximumTokens
  )
    fail('CHILD_BUDGET_EXPANSION')
  const stateItems = parent.stateItems.filter((item) =>
    parsed.allowedStateItemIds.includes(item.itemId)
  )
  const artifactRefs = parent.artifactRefs.filter((artifact) =>
    parsed.allowedArtifactIds.includes(artifact.artifactId)
  )
  const selectedArtifactIds = new Set(artifactRefs.map((artifact) => artifact.artifactId))
  for (const item of stateItems) {
    if (item.provenance.artifactRefs.some((id) => !selectedArtifactIds.has(id)))
      fail('CHILD_SCOPE_EXPANSION', item.itemId)
  }
  const usage = addProviderUsage(
    calculateUsage(stateItems, artifactRefs),
    parent.providerComposition?.contributions ?? []
  )
  if (usage.bytes > parsed.budgets.maximumBytes || usage.tokens > parsed.budgets.maximumTokens)
    fail('REQUIRED_CONTEXT_EXCEEDS_BUDGET')
  return finalizePackage({
    ...parent,
    contextPackageId: undefined,
    contentDigest: undefined,
    compiledAt: parsed.compiledAt,
    objective: parsed.objective,
    stateItems,
    artifactRefs,
    constraints: {
      allowedSensitivities: parent.constraints.allowedSensitivities,
      allowedStateItemIds: [...parsed.allowedStateItemIds].toSorted(),
      allowedArtifactIds: [...parsed.allowedArtifactIds].toSorted(),
    },
    successCriteria: parsed.successCriteria,
    returnContract: parsed.returnContract,
    budgets: parsed.budgets,
    usage,
    truncation: { truncated: false, excluded: [] },
    parentContextPackage: {
      contextPackageId: parent.contextPackageId,
      contentDigest: parent.contentDigest,
    },
  })
}

export function composeProviderContextPackage(
  packageInput: unknown,
  input: {
    callerContextRefs: string[]
    localProjectGrantRefs: string[]
    contributions: ContextContribution[]
    resolution?: NonNullable<ContextPackage['providerComposition']>['resolution']
  }
): ContextPackage {
  const package_ = ContextPackageSchema.parse(packageInput)
  assertPackageIntegrity(package_)
  const composition = z
    .object({
      callerContextRefs: z.array(z.string().min(1).max(512)).max(128),
      localProjectGrantRefs: z.array(z.string().min(1).max(512)).max(128),
      contributions: z.array(ContextContributionSchema).max(128),
      resolution: ContextPackageSchema.shape.providerComposition.unwrap().shape.resolution,
    })
    .parse(input)
  if (
    new Set(composition.contributions.map((entry) => entry.contributionId)).size !==
    composition.contributions.length
  )
    fail('CONTRADICTORY_CONTEXT_REFERENCE', 'provider-contribution')
  const contributions = [...composition.contributions].toSorted(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) ||
      left.kind.localeCompare(right.kind) ||
      left.contributionId.localeCompare(right.contributionId)
  )
  const usage = addProviderUsage(package_.usage, contributions)
  if (usage.bytes > package_.budgets.maximumBytes || usage.tokens > package_.budgets.maximumTokens)
    fail('REQUIRED_CONTEXT_EXCEEDS_BUDGET', 'provider-contribution')
  return finalizePackage({
    ...package_,
    contextPackageId: undefined,
    contentDigest: undefined,
    usage,
    providerComposition: {
      callerContextRefs: [...composition.callerContextRefs].toSorted(),
      localProjectGrantRefs: [...composition.localProjectGrantRefs].toSorted(),
      contributions,
      ...(composition.resolution === undefined ? {} : { resolution: composition.resolution }),
    },
  })
}

export interface ContextPackageRepository {
  put(package_: ContextPackage): Promise<ContextPackageReference>
  get(reference: ContextPackageReference): Promise<ContextPackage | undefined>
  getById(contextPackageId: string): Promise<ContextPackage | undefined>
}

export const ContextAuthoringRequestSchema = ContextAuthoringInputsSchema.extend({
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  projectStateRevision: z.number().int().nonnegative(),
})

type ContextAuthoringRequest = z.output<typeof ContextAuthoringRequestSchema>

export const ContextAuthoringCommandScopeSchema = z.strictObject({
  principalRef: z.string().min(1).max(256),
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  operation: z.literal('context.author'),
  idempotencyKey: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
})
export const ContextAuthoringCommandRecordSchema = z.object({
  scope: ContextAuthoringCommandScopeSchema,
  payloadHash: DigestSchema,
  contextPackage: ContextPackageReferenceSchema,
})
export type ContextAuthoringCommandScope = z.output<typeof ContextAuthoringCommandScopeSchema>
export function contextAuthoringCommandKey(input: ContextAuthoringCommandScope): string {
  const scope = ContextAuthoringCommandScopeSchema.parse(input)
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.principalRef,
        scope.workspaceId,
        scope.projectId,
        scope.operation,
        scope.idempotencyKey,
      ])
    )
    .digest('hex')
}
export type ContextAuthoringCommandRecord = z.output<typeof ContextAuthoringCommandRecordSchema>
export interface ContextAuthoringCommandRepository {
  get(scope: ContextAuthoringCommandScope): Promise<ContextAuthoringCommandRecord | undefined>
  /** Atomically retain the first command result and its package, or reject a hash conflict. */
  commit(
    record: ContextAuthoringCommandRecord,
    package_: ContextPackage
  ): Promise<ContextAuthoringCommandRecord>
}
const AuthoringDecisionSchema = z.object({
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  principalRef: z.string().min(1).max(256),
  expiresAt: TimestampSchema,
  constraints: ContextPackageSchema.shape.constraints,
  permissions: ContextPackageSchema.shape.permissions,
  budgets: ContextPackageSchema.shape.budgets,
  providerRequest: z
    .object({
      scopeDigest: DigestSchema,
      executionLocation: z.enum(['cloud', 'runtime_node']),
      capability: z.enum(['boundedRetrieval', 'evidenceSearch', 'memoryRecall']),
      policy: ContextProviderPolicySchema,
    })
    .optional(),
})

/** Composition-owned policy and Artifact adapters, never request payload fields. */
export interface ContextAuthoringAuthority {
  authorize(
    principalRef: string,
    request: ContextAuthoringRequest
  ): Promise<z.output<typeof AuthoringDecisionSchema> | undefined>
  resolveArtifact(input: {
    principalRef: string
    workspaceId: string
    projectId: string
    artifactId: string
  }): Promise<
    | (z.output<typeof ContextArtifactRefSchema> & {
        workspaceId: string
        projectId: string
        authorized: boolean
        state: 'available' | 'missing' | 'revoked' | 'unverified' | 'quarantined'
      })
    | undefined
  >
}

/** Pre-validation construction. The authenticated principal is supplied by the host. */
export interface ContextAuthoringCompositionOptions {
  readonly authority: ContextAuthoringAuthority
  readonly providerResolver?: Pick<ContextProviderResolver, 'resolve'>
  readonly now?: () => Date
}

export class ContextPackageAuthoringService {
  readonly #compiler: ContextPackageCompiler

  constructor(
    readonly options: {
      compilerVersion: string
      projectStates: Pick<ProjectStateRepository, 'getAtRevision'>
      packages: ContextPackageRepository
      commands?: ContextAuthoringCommandRepository
      authority: ContextAuthoringAuthority
      providerResolver?: Pick<ContextProviderResolver, 'resolve'>
      now: () => Date
    }
  ) {
    this.#compiler = new ContextPackageCompiler(options.compilerVersion)
  }

  async create(principalInput: string, input: unknown): Promise<ContextPackageReference> {
    return this.options.packages.put(await this.#compile(principalInput, input))
  }

  async createForCommand(
    principalRef: string,
    idempotencyKey: string,
    input: unknown
  ): Promise<ContextPackageReference> {
    const repository = this.options.commands
    if (!repository) throw new Error('CONTEXT_AUTHORING_COMMANDS_NOT_CONFIGURED')
    const request = ContextAuthoringRequestSchema.parse(input)
    const scope = ContextAuthoringCommandScopeSchema.parse({
      principalRef,
      idempotencyKey,
      operation: 'context.author',
      workspaceId: request.workspaceId,
      projectId: request.projectId,
    })
    const payloadHash = sha256(request)
    const replay = (recordInput: ContextAuthoringCommandRecord): ContextPackageReference => {
      const record = ContextAuthoringCommandRecordSchema.parse(recordInput)
      if (canonical(record.scope) !== canonical(scope))
        throw new Error('CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH')
      if (record.payloadHash !== payloadHash) throw new Error('CONTEXT_AUTHORING_COMMAND_CONFLICT')
      return record.contextPackage
    }
    const existing = await repository.get(scope)
    if (existing) return replay(existing)
    const package_ = await this.#compile(
      principalRef,
      request,
      `context-author:${contextAuthoringCommandKey(scope)}`
    )
    return replay(
      await repository.commit(
        {
          scope,
          payloadHash,
          contextPackage: {
            contextPackageId: package_.contextPackageId,
            contentDigest: package_.contentDigest,
          },
        },
        package_
      )
    )
  }

  async #compile(
    principalInput: string,
    input: unknown,
    operationId = `context-read:${randomUUID()}`
  ): Promise<ContextPackage> {
    const principalRef = z.string().min(1).max(256).parse(principalInput)
    const request = ContextAuthoringRequestSchema.parse(input)
    const decisionInput = await this.options.authority.authorize(
      principalRef,
      structuredClone(request)
    )
    if (!decisionInput) fail('UNAUTHORIZED_CONTEXT')
    const decision = AuthoringDecisionSchema.parse(decisionInput)
    if (
      decision.principalRef !== principalRef ||
      decision.workspaceId !== request.workspaceId ||
      decision.projectId !== request.projectId
    )
      fail('UNAUTHORIZED_CONTEXT')
    if (!isAfter(decision.expiresAt, this.options.now().toISOString())) fail('UNAUTHORIZED_CONTEXT')
    if (
      request.candidates.some(
        (candidate) => !decision.constraints.allowedStateItemIds.includes(candidate.itemId)
      )
    )
      fail('UNAUTHORIZED_CONTEXT')

    const stateInput = await this.options.projectStates.getAtRevision(
      request.workspaceId,
      request.projectId,
      request.projectStateRevision
    )
    if (!stateInput) fail('STALE_PROJECT_STATE')
    const state = ProjectStateSchema.parse(stateInput)
    if (state.revision !== request.projectStateRevision) fail('STALE_PROJECT_STATE')
    if (state.workspaceId !== request.workspaceId || state.projectId !== request.projectId)
      fail('UNAUTHORIZED_CONTEXT')
    const compiledAt = this.options.now().toISOString()
    const candidatesById = new Map(
      request.candidates.map((candidate) => [candidate.itemId, candidate])
    )
    const artifactIds = [
      ...new Set(
        state.items
          .filter((item) => {
            const candidate = candidatesById.get(item.itemId)
            return (
              candidate !== undefined &&
              (candidate.required ||
                !item.freshness.expiresAt ||
                isAfter(item.freshness.expiresAt, compiledAt))
            )
          })
          .flatMap((item) => item.provenance.artifactRefs)
      ),
    ].toSorted()
    const artifacts: z.output<typeof ArtifactCandidateSchema>[] = []
    for (const artifactId of artifactIds) {
      if (!decision.constraints.allowedArtifactIds.includes(artifactId))
        fail('UNAUTHORIZED_CONTEXT', artifactId)
      const artifact = await this.options.authority.resolveArtifact({
        principalRef,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        artifactId,
      })
      if (!artifact) fail('MISSING_ARTIFACT', artifactId)
      if (
        artifact.workspaceId !== request.workspaceId ||
        artifact.projectId !== request.projectId ||
        artifact.artifactId !== artifactId ||
        artifact.authorized !== true
      )
        fail('UNAUTHORIZED_CONTEXT', artifactId)
      if (artifact.state === 'revoked') fail('REVOKED_ARTIFACT', artifactId)
      if (artifact.state !== 'available') fail('MISSING_ARTIFACT', artifactId)
      artifacts.push(ArtifactCandidateSchema.parse(artifact))
    }
    if (!isAfter(decision.expiresAt, this.options.now().toISOString())) fail('UNAUTHORIZED_CONTEXT')
    const package_ = this.#compiler.compile({
      ...request,
      projectState: state,
      expectedProjectStateRevision: request.projectStateRevision,
      candidates: request.candidates.map((candidate) => ({
        ...candidate,
        authorized: decision.constraints.allowedStateItemIds.includes(candidate.itemId),
      })),
      artifacts,
      constraints: decision.constraints,
      permissions: decision.permissions,
      budgets: {
        maximumBytes: Math.min(request.budgets.maximumBytes, decision.budgets.maximumBytes),
        maximumTokens: Math.min(request.budgets.maximumTokens, decision.budgets.maximumTokens),
      },
      compiledAt,
    })
    if (!decision.providerRequest) return package_
    const resolution = await (
      this.options.providerResolver ?? new ContextProviderResolver([])
    ).resolve({
      ...decision.providerRequest,
      workspaceId: request.workspaceId,
      principalRef,
      objective: request.objective,
      operationId,
      now: this.options.now().toISOString(),
    })
    if (!isAfter(decision.expiresAt, this.options.now().toISOString())) fail('UNAUTHORIZED_CONTEXT')
    if (resolution.status === 'awaiting_input') fail('CONTEXT_PROVIDER_INPUT_REQUIRED')
    return composeProviderContextPackage(package_, {
      callerContextRefs: [],
      localProjectGrantRefs: [],
      contributions: resolution.contributions,
      resolution: { status: resolution.status, decisionReasons: resolution.decisionReasons },
    })
  }
}

export class InMemoryContextPackageRepository implements ContextPackageRepository {
  readonly #packages = new Map<string, ContextPackage>()
  async put(input: ContextPackage): Promise<ContextPackageReference> {
    const package_ = assertContextPackageIntegrity(input)
    const existing = this.#packages.get(package_.contextPackageId)
    if (existing && existing.contentDigest !== package_.contentDigest)
      throw new Error('CONTEXT_PACKAGE_ID_CONFLICT')
    this.#packages.set(package_.contextPackageId, structuredClone(package_))
    return { contextPackageId: package_.contextPackageId, contentDigest: package_.contentDigest }
  }
  async get(input: ContextPackageReference): Promise<ContextPackage | undefined> {
    const reference = ContextPackageReferenceSchema.parse(input)
    const package_ = this.#packages.get(reference.contextPackageId)
    if (!package_ || package_.contentDigest !== reference.contentDigest) return undefined
    return structuredClone(package_)
  }
  async getById(contextPackageId: string): Promise<ContextPackage | undefined> {
    return structuredClone(this.#packages.get(contextPackageId))
  }
}

export function assertContextPackageIntegrity(input: unknown): ContextPackage {
  const package_ = ContextPackageSchema.parse(input)
  assertPackageIntegrity(package_)
  return package_
}

function assertUniqueCandidates(candidates: z.output<typeof CandidateSchema>[]): void {
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.itemId)) fail('CONTRADICTORY_CONTEXT_REFERENCE', candidate.itemId)
    seen.add(candidate.itemId)
  }
}

function assertUniqueArtifacts(artifacts: z.output<typeof ArtifactCandidateSchema>[]): void {
  const seen = new Set<string>()
  for (const artifact of artifacts) {
    if (seen.has(artifact.artifactId)) {
      fail('CONTRADICTORY_CONTEXT_REFERENCE', artifact.artifactId)
    }
    seen.add(artifact.artifactId)
  }
}

function assertAuthorizedItem(
  candidate: z.output<typeof CandidateSchema>,
  item: ProjectStateItem,
  constraints: ContextPackage['constraints']
): void {
  if (
    !candidate.authorized ||
    !constraints.allowedStateItemIds.includes(item.itemId) ||
    !constraints.allowedSensitivities.includes(item.sensitivity)
  )
    fail('UNAUTHORIZED_CONTEXT', item.itemId)
}

function resolveArtifact(
  artifactId: string,
  artifacts: Map<string, z.output<typeof ArtifactCandidateSchema>>,
  constraints: ContextPackage['constraints']
): ContextPackage['artifactRefs'][number] {
  const artifact = artifacts.get(artifactId)
  if (!artifact || artifact.state === 'missing') fail('MISSING_ARTIFACT', artifactId)
  if (artifact.state === 'revoked') fail('REVOKED_ARTIFACT', artifactId)
  if (
    !artifact.authorized ||
    !constraints.allowedArtifactIds.includes(artifact.artifactId) ||
    !constraints.allowedSensitivities.includes(artifact.sensitivity)
  )
    fail('UNAUTHORIZED_CONTEXT', artifactId)
  return {
    artifactId: artifact.artifactId,
    contentDigest: artifact.contentDigest,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    sensitivity: artifact.sensitivity,
  }
}

function toContextItem(
  item: ProjectStateItem,
  usage: { bytes: number; tokens: number }
): ContextPackage['stateItems'][number] {
  return {
    itemId: item.itemId,
    itemRevision: item.itemRevision,
    key: item.key,
    value: item.value,
    sensitivity: item.sensitivity,
    freshness: item.freshness,
    provenance: item.provenance,
    usage,
  }
}

function estimateItem(item: ProjectStateItem): { bytes: number; tokens: number } {
  const bytes = Buffer.byteLength(canonical({ key: item.key, value: item.value }), 'utf8') + 48
  return { bytes, tokens: tokensFor(bytes) }
}
function tokensFor(bytes: number): number {
  return Math.ceil(bytes / 4)
}
function calculateUsage(
  items: ContextPackage['stateItems'],
  artifacts: ContextPackage['artifactRefs']
) {
  const bytes =
    items.reduce((sum, item) => sum + item.usage.bytes, 0) +
    artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)
  const tokens =
    items.reduce((sum, item) => sum + item.usage.tokens, 0) +
    artifacts.reduce((sum, artifact) => sum + tokensFor(artifact.sizeBytes), 0)
  return { bytes, tokens }
}
function addProviderUsage(
  usage: { bytes: number; tokens: number },
  contributions: ContextContribution[]
): { bytes: number; tokens: number } {
  return {
    bytes:
      usage.bytes +
      contributions.reduce((sum, contribution) => sum + Buffer.byteLength(contribution.content), 0),
    tokens:
      usage.tokens + contributions.reduce((sum, contribution) => sum + contribution.tokenCount, 0),
  }
}
function normalizeConstraints(
  constraints: ContextPackage['constraints']
): ContextPackage['constraints'] {
  return {
    allowedSensitivities: [...constraints.allowedSensitivities].toSorted(),
    allowedStateItemIds: [...constraints.allowedStateItemIds].toSorted(),
    allowedArtifactIds: [...constraints.allowedArtifactIds].toSorted(),
  }
}
function assertSubset<Value extends string>(
  child: readonly Value[],
  parent: readonly Value[]
): void {
  const expanded = child.find((value) => !parent.includes(value))
  if (expanded) fail('CHILD_SCOPE_EXPANSION', expanded)
}
function finalizePackage(input: Record<string, unknown>): ContextPackage {
  const normalized = normalize(input) as Record<string, unknown>
  const contentDigest = sha256(normalized)
  return ContextPackageSchema.parse({
    ...normalized,
    contextPackageId: hashIdentifier('ctx', contentDigest),
    contentDigest,
  })
}
function assertPackageIntegrity(package_: ContextPackage): void {
  const content = Object.fromEntries(
    Object.entries(package_).filter(
      ([key]) => key !== 'contextPackageId' && key !== 'contentDigest'
    )
  )
  const expectedDigest = sha256(normalize(content))
  if (
    package_.contentDigest !== expectedDigest ||
    package_.contextPackageId !== hashIdentifier('ctx', expectedDigest)
  ) {
    throw new Error('CONTEXT_PACKAGE_INTEGRITY_ERROR')
  }
}
function hashIdentifier(prefix: string, digest: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = Buffer.from(digest.slice(7, 39), 'hex')
  let bits = 0,
    value = 0,
    output = ''
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
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)])
    )
  return value
}
function isAfter(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right)
}
function fail(code: ContextCompilationErrorCode, reference?: string): never {
  throw new ContextCompilationError(code, reference)
}

function serializationFixture(objective: string): ContextPackage {
  return finalizePackage({
    schemaVersion: 1,
    compiler: { name: 'control-plane-context', version: '1.0.0' },
    compiledAt: '2026-08-23T12:00:00.000Z',
    objective,
    projectState: {
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      revision: 1,
    },
    stateItems: [],
    artifactRefs: [],
    constraints: {
      allowedSensitivities: ['public'],
      allowedStateItemIds: [],
      allowedArtifactIds: [],
    },
    permissions: [],
    successCriteria: ['Return normalized output'],
    returnContract: { contractRef: 'contract://adapter-result/v1' },
    budgets: { maximumBytes: 1_024, maximumTokens: 256 },
    usage: { bytes: 0, tokens: 0 },
    truncation: { truncated: false, excluded: [] },
  })
}
export const contextPackageSerializationFixtures = {
  futurePi: serializationFixture('Adapter fixture one'),
  futureAcp: serializationFixture('Adapter fixture two'),
  futureLangGraph: serializationFixture('Adapter fixture three'),
} as const

export const packageName = 'context'
export * from './provider.js'
