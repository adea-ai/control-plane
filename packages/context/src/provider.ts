import { createHash, randomUUID } from 'node:crypto'
import {
  ContextContributionSchema,
  ContextProviderPolicySchema,
  ContextProviderReadModelSchema,
  IdentifierSchemas,
  type ContextContribution,
  type ContextProviderCapabilities,
  type ContextProviderReadModel,
} from '@control-plane/contracts'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const MAX_CONTRIBUTION_BYTES = 262_144
export const ContextProviderRequestSchema = z.object({
  workspaceId: IdentifierSchemas.workspaceId,
  scopeDigest: DigestSchema,
  principalRef: z.string().min(1).max(256),
  executionLocation: z.enum(['cloud', 'runtime_node']),
  capability: z.enum(['boundedRetrieval', 'evidenceSearch', 'memoryRecall']),
  objective: z.string().min(1).max(16_384),
  operationId: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
  /** Explicit read deadline; producers always set it and the resolver derives it when absent. */
  deadlineAt: z.iso.datetime().optional(),
  now: z.iso.datetime(),
  policy: ContextProviderPolicySchema,
})

export type ContextProviderRequest = z.output<typeof ContextProviderRequestSchema>

export interface ContextProviderDriver {
  readonly readModel: ContextProviderReadModel
  /**
   * SHA-256 digest identifying the pinned data revisions and adapter configuration
   * validated by retrieve. Change it whenever either changes. Return undefined
   * when that identity cannot be established; such reads are never cached.
   * Do not include credentials or source content in the identity.
   */
  cacheIdentity?(request: ContextProviderRequest): string | undefined
  retrieve(request: ContextProviderRequest): Promise<ContextContribution[]>
}

export interface ContextContributionCache {
  get(key: string): Promise<ContextContribution[] | undefined>
  set(key: string, contributions: ContextContribution[]): Promise<void>
}

export class InMemoryContextContributionCache implements ContextContributionCache {
  readonly #entries = new Map<string, ContextContribution[]>()
  async get(key: string): Promise<ContextContribution[] | undefined> {
    const value = this.#entries.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }
  async set(key: string, contributions: ContextContribution[]): Promise<void> {
    this.#entries.set(key, structuredClone(contributions))
  }
}

export type ContextProviderErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REVOKED'
  | 'PROVIDER_SCOPE_MISMATCH'
  | 'PROVIDER_OUTPUT_INVALID'
  | 'PROVIDER_OUTPUT_STALE'
  | 'PROVIDER_BUDGET_EXCEEDED'

export class ContextProviderResolutionError extends Error {
  constructor(readonly code: ContextProviderErrorCode) {
    super(code)
    this.name = 'ContextProviderResolutionError'
  }
}

export interface ContextProviderPin {
  providerId: string
  connectionId: string
  contractVersion: string
  scopeDigest: string
  revision?: string
  contentDigest?: string
  observedAt?: string
  degraded: boolean
  included: boolean
  omissionReason?: ContextProviderErrorCode | 'NO_ELIGIBLE_PROVIDER'
  provenance: Array<{ sourceRef: string; sourceKind: string; citation?: string }>
  providerMetadata?: ContextContribution['providerMetadata']
}

export interface ContextProviderResolution {
  status: 'disabled' | 'omitted' | 'awaiting_input' | 'included' | 'degraded'
  contributions: ContextContribution[]
  pins: ContextProviderPin[]
  decisionReasons: string[]
}

/**
 * Observability port for resolution outcomes. Implementations must supply bounded
 * label cardinality and isolate exporter failures; the resolver additionally
 * isolates every hook call so a throwing metrics sink can never change a result.
 */
export interface ContextProviderResolutionMetrics {
  recordResolution(outcome: ContextProviderResolution['status'], reasonCategory: string): void
}

const fixedDecisionReasons = new Set(['PROVIDER_SELECTED', 'CACHE_HIT', 'POLICY_DISABLED'])

function resolutionReasonCategory(resolution: ContextProviderResolution): string {
  if (resolution.status === 'disabled') return 'POLICY_DISABLED'
  if (resolution.decisionReasons.includes('CACHE_HIT')) return 'CACHE_HIT'
  if (resolution.decisionReasons.includes('PROVIDER_SELECTED')) return 'PROVIDER_SELECTED'
  return (
    resolution.decisionReasons.find((reason) => !fixedDecisionReasons.has(reason)) ??
    'NO_ELIGIBLE_PROVIDER'
  )
}

export class ContextProviderResolver {
  readonly #providers: ContextProviderDriver[]
  readonly #cache: ContextContributionCache | undefined
  readonly #metrics: ContextProviderResolutionMetrics | undefined
  constructor(
    providers: ContextProviderDriver[],
    options: {
      readonly cache?: ContextContributionCache
      readonly metrics?: ContextProviderResolutionMetrics
    } = {}
  ) {
    this.#providers = [...providers]
    this.#cache = options.cache
    this.#metrics = options.metrics
  }

  async resolve(input: unknown): Promise<ContextProviderResolution> {
    const resolution = await this.#resolve(input)
    if (this.#metrics !== undefined) {
      try {
        this.#metrics.recordResolution(resolution.status, resolutionReasonCategory(resolution))
      } catch {
        // Metrics export is isolated per emission and can never fail resolution.
      }
    }
    return resolution
  }

  async #resolve(input: unknown): Promise<ContextProviderResolution> {
    const parsed = ContextProviderRequestSchema.parse(input)
    // Every provider read carries a stable operation identity and an explicit deadline;
    // both are derived here — never taken from provider output — and excluded from the
    // cache identity because they are per-read correlation, not request semantics.
    const request: ContextProviderRequest = {
      ...parsed,
      operationId: parsed.operationId ?? `op:${randomUUID()}`,
      deadlineAt:
        parsed.deadlineAt ??
        new Date(Date.parse(parsed.now) + parsed.policy.maximumLatencyMs).toISOString(),
    }
    if (request.policy.mode === 'disabled') return empty('disabled', ['POLICY_DISABLED'])
    const providers = this.#eligible(request)
    let lastError: ContextProviderResolutionError | undefined
    for (const provider of providers) {
      try {
        if (provider.readModel.connection.state === 'revoked')
          throw new ContextProviderResolutionError('PROVIDER_REVOKED')
        if (provider.readModel.health.status === 'unavailable')
          throw new ContextProviderResolutionError('PROVIDER_UNAVAILABLE')
        const identity = this.#cache ? provider.cacheIdentity?.(request) : undefined
        const cacheKey =
          identity === undefined
            ? undefined
            : this.#cacheKey(provider, request, DigestSchema.parse(identity))
        const cached = cacheKey === undefined ? undefined : await this.#cache?.get(cacheKey)
        if (
          cached &&
          identity !== undefined &&
          provider.cacheIdentity?.(request) === identity &&
          this.#cacheKey(provider, request, identity) === cacheKey
        ) {
          const normalizedCached = this.#validate(provider, request, cached)
          return this.#included(provider, normalizedCached, [
            'CACHE_HIT',
            ...this.#selectionReasons(provider, request),
          ])
        }
        const contributions = await withTimeout(
          provider.retrieve(request),
          request.policy.maximumLatencyMs
        )
        const normalized = this.#validate(provider, request, contributions)
        if (
          cacheKey !== undefined &&
          identity !== undefined &&
          provider.cacheIdentity?.(request) === identity &&
          this.#cacheKey(provider, request, identity) === cacheKey
        )
          await this.#cache?.set(cacheKey, normalized)
        return this.#included(provider, normalized, [
          'PROVIDER_SELECTED',
          ...this.#selectionReasons(provider, request),
        ])
      } catch (error) {
        lastError = normalizeError(error)
      }
    }
    return this.#failure(request, lastError)
  }

  #included(
    provider: ContextProviderDriver,
    normalized: ContextContribution[],
    decisionReasons: string[]
  ): ContextProviderResolution {
    return {
      status:
        provider.readModel.health.status === 'degraded' ||
        normalized.some((entry) => entry.degraded)
          ? 'degraded'
          : 'included',
      contributions: normalized,
      decisionReasons,
      pins: normalized.map((entry) => ({
        providerId: entry.providerId,
        connectionId: entry.connectionId,
        contractVersion: entry.contractVersion,
        scopeDigest: entry.scopeDigest,
        revision: entry.revision,
        contentDigest: entry.contentDigest,
        observedAt: entry.observedAt,
        degraded: entry.degraded,
        included: true,
        provenance: entry.provenance.map(({ sourceRef, sourceKind, citation }) => ({
          sourceRef,
          sourceKind,
          ...(citation === undefined ? {} : { citation }),
        })),
        ...(entry.providerMetadata === undefined
          ? {}
          : { providerMetadata: entry.providerMetadata }),
      })),
    }
  }

  #cacheKey(
    provider: ContextProviderDriver,
    request: ContextProviderRequest,
    providerIdentity: string
  ): string {
    // Per-read correlation (operationId, deadlineAt) is deliberately excluded from the
    // cache identity: reuse must not depend on a single read's identity or deadline.
    const { now, operationId: _operationId, deadlineAt: _deadlineAt, ...requestIdentity } = request
    return digest(
      JSON.stringify({
        provider: provider.readModel.definition,
        connection: provider.readModel.connection,
        providerIdentity,
        request: requestIdentity,
        nowBucket: Math.floor(Date.parse(now) / (request.policy.maximumAgeSeconds * 1_000 || 1)),
        adapterVersion: 'context-provider-resolver/5',
      })
    )
  }

  #selectionReasons(provider: ContextProviderDriver, request: ContextProviderRequest): string[] {
    const reasons: string[] = []
    if (request.policy.connectionIds.includes(provider.readModel.connection.connectionId)) {
      reasons.push('EXPLICIT_CONNECTION')
    } else if (request.policy.providerIds.includes(provider.readModel.definition.providerId)) {
      reasons.push('PREFERRED_PROVIDER')
    }
    if (provider.readModel.connection.reachability === 'direct') reasons.push('DIRECT_REACHABILITY')
    if (provider.readModel.health.status === 'healthy') reasons.push('HEALTHY_PROVIDER')
    return reasons
  }

  #eligible(request: ContextProviderRequest): ContextProviderDriver[] {
    const providerPreference = new Map(request.policy.providerIds.map((id, index) => [id, index]))
    const connectionPreference = new Map(
      request.policy.connectionIds.map((id, index) => [id, index])
    )
    return this.#providers
      .filter(({ readModel }) => {
        const { connection, definition } = readModel
        const healthAgeMs = Date.parse(request.now) - Date.parse(readModel.health.checkedAt)
        return (
          connection.workspaceId === request.workspaceId &&
          connection.scopeDigest === request.scopeDigest &&
          connection.principalRef === request.principalRef &&
          connection.executionLocations.includes(request.executionLocation) &&
          healthAgeMs >= 0 &&
          healthAgeMs <= request.policy.maximumProviderHealthAgeSeconds * 1_000 &&
          readModel.health.status !== 'unavailable' &&
          definition.capabilities[request.capability] &&
          (request.policy.connectionIds.length === 0 ||
            request.policy.connectionIds.includes(connection.connectionId)) &&
          (request.policy.providerIds.length === 0 ||
            request.policy.providerIds.includes(definition.providerId))
        )
      })
      .toSorted((left, right) => {
        const leftRank =
          connectionPreference.get(left.readModel.connection.connectionId) ??
          Number.MAX_SAFE_INTEGER
        const rightRank =
          connectionPreference.get(right.readModel.connection.connectionId) ??
          Number.MAX_SAFE_INTEGER
        const leftProviderRank =
          providerPreference.get(left.readModel.definition.providerId) ?? Number.MAX_SAFE_INTEGER
        const rightProviderRank =
          providerPreference.get(right.readModel.definition.providerId) ?? Number.MAX_SAFE_INTEGER
        const healthRank = (status: ContextProviderReadModel['health']['status']) =>
          status === 'healthy' ? 0 : 1
        const freshness = (provider: ContextProviderDriver) =>
          Date.parse(request.now) - Date.parse(provider.readModel.health.checkedAt)
        const latencyRank = (provider: ContextProviderDriver) =>
          ({ low: 0, standard: 1, high: 2 })[provider.readModel.definition.latencyClass]
        const costRank = (provider: ContextProviderDriver) =>
          ({ low: 0, standard: 1, premium: 2 })[provider.readModel.definition.costClass]
        return (
          leftRank - rightRank ||
          leftProviderRank - rightProviderRank ||
          Number(left.readModel.connection.reachability !== 'direct') -
            Number(right.readModel.connection.reachability !== 'direct') ||
          healthRank(left.readModel.health.status) - healthRank(right.readModel.health.status) ||
          freshness(left) - freshness(right) ||
          latencyRank(left) - latencyRank(right) ||
          costRank(left) - costRank(right) ||
          left.readModel.connection.connectionId.localeCompare(
            right.readModel.connection.connectionId
          )
        )
      })
  }

  #validate(
    provider: ContextProviderDriver,
    request: ContextProviderRequest,
    input: unknown
  ): ContextContribution[] {
    const parsed = z.array(ContextContributionSchema).max(128).safeParse(input)
    if (!parsed.success) throw new ContextProviderResolutionError('PROVIDER_OUTPUT_INVALID')
    const normalized: ContextContribution[] = []
    let tokens = 0
    for (const entry of parsed.data) {
      const normalizedEntry = normalizeContributionIntegrity(entry)
      if (
        entry.providerId !== provider.readModel.definition.providerId ||
        entry.connectionId !== provider.readModel.connection.connectionId ||
        entry.contractVersion !== provider.readModel.definition.contractVersion
      )
        throw new ContextProviderResolutionError('PROVIDER_OUTPUT_INVALID')
      if (entry.scopeDigest !== request.scopeDigest)
        throw new ContextProviderResolutionError('PROVIDER_SCOPE_MISMATCH')
      const observedAge = Date.parse(request.now) - Date.parse(entry.observedAt)
      if (
        (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.parse(request.now)) ||
        observedAge < 0 ||
        observedAge > request.policy.maximumAgeSeconds * 1_000
      )
        throw new ContextProviderResolutionError('PROVIDER_OUTPUT_STALE')
      if (
        (entry.kind === 'evidence' && !request.policy.includeEvidence) ||
        (entry.kind === 'memory' && !request.policy.includeMemory)
      )
        throw new ContextProviderResolutionError('PROVIDER_OUTPUT_INVALID')
      normalized.push(normalizedEntry)
      tokens += normalizedEntry.tokenCount
    }
    if (tokens > request.policy.maximumTokens)
      throw new ContextProviderResolutionError('PROVIDER_BUDGET_EXCEEDED')
    return normalized.toSorted(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.contributionId.localeCompare(right.contributionId)
    )
  }

  #failure(
    request: ContextProviderRequest,
    error?: ContextProviderResolutionError
  ): ContextProviderResolution {
    const resolvedError = error ?? new ContextProviderResolutionError('PROVIDER_UNAVAILABLE')
    if (request.policy.failureBehavior === 'fail' || request.policy.mode === 'required') {
      if (request.policy.failureBehavior !== 'await_input') throw resolvedError
    }
    if (request.policy.failureBehavior === 'await_input') {
      return empty('awaiting_input', ['NO_ELIGIBLE_PROVIDER', resolvedError.code])
    }
    return empty('omitted', ['NO_ELIGIBLE_PROVIDER', resolvedError.code])
  }
}

export interface FakeContextProviderOptions {
  suffix: string
  workspaceId: string
  scopeDigest: string
  outputScopeDigest?: string
  state: 'active' | 'revoked'
  health: 'healthy' | 'degraded' | 'unavailable'
  capabilities: Partial<ContextProviderCapabilities>
  kind: 'context' | 'evidence' | 'memory'
  tokenCount: number
  delayMs?: number
  expiresAt?: string
  degraded?: boolean
  reachability?: 'direct' | 'remote'
  latencyClass?: 'low' | 'standard' | 'high'
  costClass?: 'low' | 'standard' | 'premium'
}

export function createFakeContextProvider(
  options: FakeContextProviderOptions
): ContextProviderDriver {
  const token = options.suffix.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, 'A')[0] ?? 'A'
  const providerId = `ctp_${token.repeat(26)}`
  const connectionId = `ctc_${token.repeat(26)}`
  const capabilities = {
    boundedRetrieval: true,
    evidenceSearch: false,
    memoryRecall: false,
    healthStatus: true,
    memoryWriteProposal: false,
    memoryWriteCommit: false,
    ...options.capabilities,
  }
  const readModel = ContextProviderReadModelSchema.parse({
    definition: {
      providerId,
      providerType: options.kind === 'memory' ? 'fake-memory' : 'fake-evidence',
      displayName: `Fake ${options.suffix}`,
      contractVersion: '1.0.0',
      latencyClass: options.latencyClass,
      costClass: options.costClass,
      capabilities,
    },
    connection: {
      connectionId,
      providerId,
      workspaceId: options.workspaceId,
      principalRef: 'principal://test/user',
      scopeDigest: options.scopeDigest,
      executionLocations: ['cloud', 'runtime_node'],
      reachability: options.reachability,
      state: options.state,
    },
    health: { status: options.health, checkedAt: '2026-08-25T11:59:00.000Z' },
  })
  return {
    readModel,
    cacheIdentity: () => digest(JSON.stringify({ adapterVersion: 'fake-provider/1', options })),
    async retrieve() {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (options.health === 'unavailable')
        throw new ContextProviderResolutionError('PROVIDER_UNAVAILABLE')
      const content = `${options.kind}-${options.suffix}`
      return [
        ContextContributionSchema.parse({
          providerId,
          connectionId,
          contractVersion: '1.0.0',
          contributionId: `contribution-${options.suffix}`,
          kind: options.kind,
          content,
          tokenCount: options.tokenCount,
          observedAt: '2026-08-25T11:59:00.000Z',
          ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
          scopeDigest: options.outputScopeDigest ?? options.scopeDigest,
          revision: `revision-${options.suffix}`,
          contentDigest: digest(content),
          degraded: options.degraded ?? false,
          provenance: [
            {
              sourceRef: `fixture://${options.suffix}`,
              citation: `fixture ${options.suffix}`,
              sourceKind: options.kind === 'memory' ? 'provider_memory' : 'external_evidence',
            },
          ],
        }),
      ]
    },
  }
}

export async function runContextProviderConformance(
  provider: ContextProviderDriver,
  requestInput: unknown
): Promise<{ bounded: boolean; deterministic: boolean; scopePreserved: boolean }> {
  const request = ContextProviderRequestSchema.parse(requestInput)
  const first = await provider.retrieve(request)
  const second = await provider.retrieve(request)
  const normalizedFirst = normalizeConformanceOutput(first)
  const normalizedSecond = normalizeConformanceOutput(second)
  return {
    bounded:
      normalizedFirst !== undefined &&
      first.length <= 128 &&
      normalizedFirst.reduce((sum, contribution) => sum + contribution.tokenCount, 0) <=
        request.policy.maximumTokens,
    deterministic:
      normalizedFirst !== undefined &&
      normalizedSecond !== undefined &&
      JSON.stringify(normalizedFirst) === JSON.stringify(normalizedSecond),
    scopePreserved: first.every((contribution) => contribution.scopeDigest === request.scopeDigest),
  }
}

function normalizeConformanceOutput(
  contributions: readonly ContextContribution[]
): ContextContribution[] | undefined {
  try {
    return contributions.map(normalizeContributionIntegrity)
  } catch {
    return undefined
  }
}

function normalizeContributionIntegrity(entry: ContextContribution): ContextContribution {
  const contentBytes = Buffer.byteLength(entry.content, 'utf8')
  if (contentBytes > MAX_CONTRIBUTION_BYTES || entry.contentDigest !== digest(entry.content))
    throw new ContextProviderResolutionError('PROVIDER_OUTPUT_INVALID')
  return {
    ...entry,
    tokenCount: Math.max(entry.tokenCount, Math.ceil(contentBytes / 4)),
  }
}

function normalizeError(error: unknown): ContextProviderResolutionError {
  return error instanceof ContextProviderResolutionError
    ? error
    : new ContextProviderResolutionError('PROVIDER_UNAVAILABLE')
}

function empty(
  status: ContextProviderResolution['status'],
  decisionReasons = ['NO_ELIGIBLE_PROVIDER']
): ContextProviderResolution {
  return { status, contributions: [], pins: [], decisionReasons }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  maximumLatencyMs: number
): Promise<Value> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ContextProviderResolutionError('PROVIDER_UNAVAILABLE')),
          maximumLatencyMs
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
