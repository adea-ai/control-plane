import { createHash } from 'node:crypto'
import type { ContextProviderDriver, ContextProviderRequest } from '@control-plane/context'
import {
  ContextContributionSchema,
  ContextProviderReadModelSchema,
  type ContextContribution,
  type ContextProviderReadModel,
} from '@control-plane/contracts'
import { GatewayCommandEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SliceSchema = z.object({
  sliceId: z.string().min(1).max(256),
  content: z.string().min(1).max(131_072),
  tokenCount: z.number().int().nonnegative(),
  contentDigest: DigestSchema,
  sourceRef: z.string().min(1).max(1_024),
  citation: z.string().min(1).max(2_048).optional(),
})

export const CortanaContextBundleSchema = z.object({
  contractVersion: z.literal('1.0.0'),
  bundleId: z.string().min(1).max(256),
  bundleDigest: DigestSchema,
  scopeDigest: DigestSchema,
  corpusRevision: z.string().min(1).max(256),
  memoryRevision: z.string().min(1).max(256).optional(),
  embeddingVersion: z.string().min(1).max(128).optional(),
  retrievalVersion: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  tokenCount: z.number().int().nonnegative(),
  degraded: z.boolean(),
  omittedCount: z.number().int().nonnegative(),
  evidence: z.array(SliceSchema).max(64),
  memories: z.array(SliceSchema.omit({ citation: true })).max(64),
})

export type CortanaContextBundle = z.output<typeof CortanaContextBundleSchema>
export type CortanaTransport = 'mcp' | 'http' | 'runtime_node'

export interface CortanaClientRequest {
  objective: string
  transport: CortanaTransport
  mappedProjectRef: string
  scopeDigest: string
  principalRef: string
  maximumTokens: number
  deadline: string
  includeEvidence: boolean
  includeMemory: boolean
  gatewayCommand?: z.output<typeof GatewayCommandEnvelopeSchema>
}

export interface CortanaClientPort {
  read(request: CortanaClientRequest, signal: AbortSignal): Promise<unknown>
}

export interface CortanaAdapterOptions {
  readModel: ContextProviderReadModel
  providerRef: string
  mappedProjectRef: string
  transport: CortanaTransport
  client: CortanaClientPort
  maximumOutputBytes?: number
  maximumRetries?: number
  circuitFailureThreshold?: number
  expectedCorpusRevision?: string
  expectedMemoryRevision?: string
  expectedEmbeddingVersion?: string
  expectedRetrievalVersion?: string
  onTelemetry?: (event: { code: string; transport: CortanaTransport }) => void
}

export class CortanaContextAdapterError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CortanaContextAdapterError'
  }
}

export class CortanaContextProviderAdapter implements ContextProviderDriver {
  readonly readModel: ContextProviderReadModel
  readonly #options: Required<
    Pick<CortanaAdapterOptions, 'maximumOutputBytes' | 'maximumRetries' | 'circuitFailureThreshold'>
  > &
    Omit<CortanaAdapterOptions, 'maximumOutputBytes' | 'maximumRetries' | 'circuitFailureThreshold'>
  #consecutiveFailures = 0

  constructor(options: CortanaAdapterOptions) {
    this.readModel = ContextProviderReadModelSchema.parse(options.readModel)
    this.#options = {
      ...options,
      maximumOutputBytes: options.maximumOutputBytes ?? 512 * 1024,
      maximumRetries: options.maximumRetries ?? 1,
      circuitFailureThreshold: options.circuitFailureThreshold ?? 3,
    }
  }

  async retrieve(request: ContextProviderRequest): Promise<ContextContribution[]> {
    if (this.#consecutiveFailures >= this.#options.circuitFailureThreshold)
      throw new CortanaContextAdapterError('CORTANA_CIRCUIT_OPEN')
    const clientRequest = this.#request(request)
    let lastError: unknown
    for (let attempt = 0; attempt <= this.#options.maximumRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.policy.maximumLatencyMs)
      try {
        const raw = await this.#options.client.read(clientRequest, controller.signal)
        const bundle = this.#validateBundle(raw, request)
        this.#consecutiveFailures = 0
        return normalizeBundle(bundle, this.readModel)
      } catch (error) {
        lastError = error
        this.#options.onTelemetry?.({
          code: normalizeAdapterError(error).code,
          transport: this.#options.transport,
        })
      } finally {
        clearTimeout(timeout)
      }
    }
    this.#consecutiveFailures += 1
    throw normalizeAdapterError(lastError)
  }

  #request(request: ContextProviderRequest): CortanaClientRequest {
    const base = {
      objective: request.objective,
      transport: this.#options.transport,
      mappedProjectRef: this.#options.mappedProjectRef,
      scopeDigest: request.scopeDigest,
      principalRef: request.principalRef,
      maximumTokens: request.policy.maximumTokens,
      deadline: new Date(Date.parse(request.now) + request.policy.maximumLatencyMs).toISOString(),
      includeEvidence: request.policy.includeEvidence,
      includeMemory: request.policy.includeMemory,
    }
    if (this.#options.transport !== 'runtime_node') return base
    return { ...base, gatewayCommand: runtimeNodeCommand(request, this.#options.providerRef) }
  }

  #validateBundle(raw: unknown, request: ContextProviderRequest): CortanaContextBundle {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > this.#options.maximumOutputBytes)
      throw new CortanaContextAdapterError('CORTANA_OUTPUT_LIMIT')
    const result = CortanaContextBundleSchema.safeParse(raw)
    if (!result.success) throw new CortanaContextAdapterError('CORTANA_BUNDLE_INVALID')
    const bundle = result.data
    if (bundle.scopeDigest !== request.scopeDigest)
      throw new CortanaContextAdapterError('CORTANA_SCOPE_MISMATCH')
    const expectedPins = [
      [this.#options.expectedCorpusRevision, bundle.corpusRevision],
      [this.#options.expectedMemoryRevision, bundle.memoryRevision],
      [this.#options.expectedEmbeddingVersion, bundle.embeddingVersion],
      [this.#options.expectedRetrievalVersion, bundle.retrievalVersion],
    ]
    if (expectedPins.some(([expected, actual]) => expected !== undefined && expected !== actual))
      throw new CortanaContextAdapterError('CORTANA_REVISION_MISMATCH')
    if (bundle.bundleDigest !== bundleDigest(bundle))
      throw new CortanaContextAdapterError('CORTANA_DIGEST_MISMATCH')
    if (
      [...bundle.evidence, ...bundle.memories].some(
        (slice) => slice.contentDigest !== digest(slice.content)
      )
    )
      throw new CortanaContextAdapterError('CORTANA_CONTENT_DIGEST_MISMATCH')
    if (
      bundle.evidence.reduce(sumTokens, 0) + bundle.memories.reduce(sumTokens, 0) !==
      bundle.tokenCount
    )
      throw new CortanaContextAdapterError('CORTANA_TOKEN_MISMATCH')
    if (bundle.tokenCount > request.policy.maximumTokens)
      throw new CortanaContextAdapterError('CORTANA_BUDGET_EXCEEDED')
    if (!request.policy.includeEvidence && bundle.evidence.length > 0)
      throw new CortanaContextAdapterError('CORTANA_EVIDENCE_NOT_AUTHORIZED')
    if (!request.policy.includeMemory && bundle.memories.length > 0)
      throw new CortanaContextAdapterError('CORTANA_MEMORY_NOT_AUTHORIZED')
    return bundle
  }
}

export function createContextBundle(
  input: Omit<CortanaContextBundle, 'bundleDigest'>
): CortanaContextBundle {
  const bundle = CortanaContextBundleSchema.parse({
    ...input,
    bundleDigest: `sha256:${'0'.repeat(64)}`,
  })
  return { ...bundle, bundleDigest: bundleDigest(bundle) }
}

export class FakeCortanaCompatibleServer implements CortanaClientPort {
  readonly requests: CortanaClientRequest[] = []
  effects = 0
  constructor(
    private readonly bundle: CortanaContextBundle,
    private failuresBeforeSuccess = 0,
    private readonly latencyMs = 0
  ) {}

  async read(request: CortanaClientRequest, signal: AbortSignal): Promise<unknown> {
    this.requests.push(structuredClone(request))
    if (this.latencyMs > 0) await abortableDelay(this.latencyMs, signal)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1
      throw new CortanaContextAdapterError('CORTANA_UNAVAILABLE')
    }
    this.effects += 1
    return structuredClone(this.bundle)
  }
}

function normalizeBundle(
  bundle: CortanaContextBundle,
  readModel: ContextProviderReadModel
): ContextContribution[] {
  const common = {
    providerId: readModel.definition.providerId,
    connectionId: readModel.connection.connectionId,
    contractVersion: readModel.definition.contractVersion,
    observedAt: bundle.createdAt,
    scopeDigest: bundle.scopeDigest,
    degraded: bundle.degraded,
    providerMetadata: {
      bundleId: bundle.bundleId,
      bundleDigest: bundle.bundleDigest,
      corpusRevision: bundle.corpusRevision,
      ...(bundle.memoryRevision === undefined ? {} : { memoryRevision: bundle.memoryRevision }),
      ...(bundle.embeddingVersion === undefined
        ? {}
        : { embeddingVersion: bundle.embeddingVersion }),
      retrievalVersion: bundle.retrievalVersion,
      omittedCount: bundle.omittedCount,
    },
  }
  return [
    ...bundle.evidence.map((slice) =>
      ContextContributionSchema.parse({
        ...common,
        contributionId: `${bundle.bundleId}:${slice.sliceId}`,
        kind: 'evidence',
        content: slice.content,
        tokenCount: slice.tokenCount,
        revision: bundle.corpusRevision,
        contentDigest: slice.contentDigest,
        provenance: [
          {
            sourceRef: slice.sourceRef,
            ...(slice.citation === undefined ? {} : { citation: slice.citation }),
            sourceKind: 'external_evidence',
          },
        ],
      })
    ),
    ...bundle.memories.map((slice) =>
      ContextContributionSchema.parse({
        ...common,
        contributionId: `${bundle.bundleId}:${slice.sliceId}`,
        kind: 'memory',
        content: slice.content,
        tokenCount: slice.tokenCount,
        revision: bundle.memoryRevision ?? bundle.corpusRevision,
        contentDigest: slice.contentDigest,
        provenance: [{ sourceRef: slice.sourceRef, sourceKind: 'provider_memory' }],
      })
    ),
  ]
}

function runtimeNodeCommand(request: ContextProviderRequest, providerRef: string) {
  return GatewayCommandEnvelopeSchema.parse({
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    sequence: 1,
    nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
    workspaceId: request.workspaceId,
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: request.now,
    channelGeneration: 1,
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: `context-read:${providerRef}`,
    payloadHash: digest(
      canonical({
        providerRef,
        objective: request.objective,
        scopeDigest: request.scopeDigest,
        maximumTokens: request.policy.maximumTokens,
      })
    ),
    issuedAt: request.now,
    expiresAt: new Date(Date.parse(request.now) + request.policy.maximumLatencyMs).toISOString(),
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    providerRef,
    authorizationRef: `authz:${request.scopeDigest.slice(7, 39)}`,
    requiredCapabilities: ['context.read'],
    payload: {
      version: 1,
      parameters: {
        objective: request.objective,
        scopeDigest: request.scopeDigest,
        maximumTokens: request.policy.maximumTokens,
      },
    },
  })
}

function bundleDigest(bundle: CortanaContextBundle): string {
  const content = Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== 'bundleDigest')
  )
  return digest(canonical(content))
}

function sumTokens(sum: number, slice: { tokenCount: number }): number {
  return sum + slice.tokenCount
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function normalizeAdapterError(error: unknown): CortanaContextAdapterError {
  if (error instanceof CortanaContextAdapterError) return error
  if (error instanceof Error && error.name === 'AbortError')
    return new CortanaContextAdapterError('CORTANA_TIMEOUT')
  return new CortanaContextAdapterError('CORTANA_UNAVAILABLE')
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

export const packageName = 'cortana-context-adapter'
