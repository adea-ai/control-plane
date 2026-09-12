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
export * from './http-client.js'

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
  operationId?: string
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

const CommandFields = GatewayCommandEnvelopeSchema.shape
export const RuntimeNodeContextReadBindingSchema = z
  .object({
    nodeId: CommandFields.nodeId,
    workspaceId: CommandFields.workspaceId,
    traceId: CommandFields.traceId,
    channelGeneration: CommandFields.channelGeneration,
    sequence: CommandFields.sequence,
    commandId: CommandFields.commandId,
    idempotencyKey: CommandFields.idempotencyKey,
    authorizationRef: CommandFields.authorizationRef.unwrap(),
    providerRef: CommandFields.providerRef.unwrap(),
    principalRef: z.string().min(1).max(256),
    scopeDigest: DigestSchema,
    expiresAt: CommandFields.expiresAt,
  })
  .strict()
export type RuntimeNodeContextReadBinding = z.output<typeof RuntimeNodeContextReadBindingSchema>

export interface CortanaAdapterOptions {
  readModel: ContextProviderReadModel
  providerRef: string
  mappedProjectRef: string
  transport: CortanaTransport
  client: CortanaClientPort
  /** Non-secret identity of the configured endpoint and credential-policy binding. */
  clientIdentity?: string
  /** Composition-owned authorization and durable command identity allocation. */
  bindRuntimeNodeRead?: (
    input: { providerRef: string; request: ContextProviderRequest },
    signal: AbortSignal
  ) => Promise<RuntimeNodeContextReadBinding | undefined>
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
    const startedAt = performance.now()
    const clientRequest = await this.#request(request)
    const remaining = () =>
      Date.parse(clientRequest.deadline) - Date.parse(request.now) - (performance.now() - startedAt)
    let lastError: unknown
    for (let attempt = 0; attempt <= this.#options.maximumRetries; attempt += 1) {
      try {
        const raw = await boundedOperation(
          (signal) => this.#options.client.read(structuredClone(clientRequest), signal),
          remaining(),
          'CORTANA_TIMEOUT'
        )
        if (remaining() <= 0) throw new CortanaContextAdapterError('CORTANA_TIMEOUT')
        const bundle = this.#validateBundle(raw, request)
        this.#consecutiveFailures = 0
        return normalizeBundle(bundle, this.readModel)
      } catch (error) {
        lastError = error
        this.#options.onTelemetry?.({
          code: normalizeAdapterError(error).code,
          transport: this.#options.transport,
        })
      }
    }
    this.#consecutiveFailures += 1
    throw normalizeAdapterError(lastError)
  }

  cacheIdentity(request: ContextProviderRequest): string | undefined {
    const options = this.#options
    if (
      !options.clientIdentity ||
      options.transport === 'runtime_node' ||
      !options.expectedCorpusRevision ||
      !options.expectedEmbeddingVersion ||
      !options.expectedRetrievalVersion ||
      this.#consecutiveFailures >= options.circuitFailureThreshold ||
      (request.policy.includeMemory && !options.expectedMemoryRevision)
    )
      return undefined
    return digest(
      JSON.stringify({
        adapterVersion: 'cortana-context-adapter/2',
        clientIdentity: options.clientIdentity,
        providerRef: options.providerRef,
        mappedProjectRef: options.mappedProjectRef,
        transport: options.transport,
        maximumOutputBytes: options.maximumOutputBytes,
        maximumRetries: options.maximumRetries,
        circuitFailureThreshold: options.circuitFailureThreshold,
        expectedCorpusRevision: options.expectedCorpusRevision,
        expectedMemoryRevision: options.expectedMemoryRevision,
        expectedEmbeddingVersion: options.expectedEmbeddingVersion,
        expectedRetrievalVersion: options.expectedRetrievalVersion,
      })
    )
  }

  async #request(request: ContextProviderRequest): Promise<CortanaClientRequest> {
    const base = {
      objective: request.objective,
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
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
    const bind = this.#options.bindRuntimeNodeRead
    if (!bind) throw new CortanaContextAdapterError('CORTANA_RUNTIME_BINDING_REQUIRED')
    let raw: unknown
    try {
      raw = await boundedOperation(
        (signal) =>
          bind(
            { providerRef: this.#options.providerRef, request: structuredClone(request) },
            signal
          ),
        request.policy.maximumLatencyMs,
        'CORTANA_RUNTIME_BINDING_TIMEOUT'
      )
    } catch (error) {
      throw normalizeAdapterError(error)
    }
    const parsed = RuntimeNodeContextReadBindingSchema.safeParse(raw)
    if (!parsed.success) throw new CortanaContextAdapterError('CORTANA_RUNTIME_BINDING_INVALID')
    const binding = parsed.data
    if (
      binding.workspaceId !== request.workspaceId ||
      binding.principalRef !== request.principalRef ||
      binding.scopeDigest !== request.scopeDigest ||
      binding.providerRef !== this.#options.providerRef
    )
      throw new CortanaContextAdapterError('CORTANA_RUNTIME_BINDING_SCOPE_MISMATCH')
    if (Date.parse(binding.expiresAt) <= Date.parse(request.now))
      throw new CortanaContextAdapterError('CORTANA_RUNTIME_BINDING_EXPIRED')
    const deadline = new Date(
      Math.min(Date.parse(base.deadline), Date.parse(binding.expiresAt))
    ).toISOString()
    return {
      ...base,
      deadline,
      gatewayCommand: createRuntimeNodeContextCommand(
        request,
        binding,
        deadline,
        this.#options.mappedProjectRef
      ),
    }
  }

  #validateBundle(raw: unknown, request: ContextProviderRequest): CortanaContextBundle {
    return validateCortanaContextBundle(raw, request, this.#options)
  }
}

export type CortanaBundleValidationOptions = Pick<
  CortanaAdapterOptions,
  | 'maximumOutputBytes'
  | 'expectedCorpusRevision'
  | 'expectedMemoryRevision'
  | 'expectedEmbeddingVersion'
  | 'expectedRetrievalVersion'
>

export function validateCortanaContextBundle(
  raw: unknown,
  request: {
    scopeDigest: string
    policy: Pick<
      ContextProviderRequest['policy'],
      'maximumTokens' | 'includeEvidence' | 'includeMemory'
    >
  },
  options: CortanaBundleValidationOptions = {}
): CortanaContextBundle {
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > (options.maximumOutputBytes ?? 524288))
    throw new CortanaContextAdapterError('CORTANA_OUTPUT_LIMIT')
  const result = CortanaContextBundleSchema.safeParse(raw)
  if (!result.success) throw new CortanaContextAdapterError('CORTANA_BUNDLE_INVALID')
  const bundle = result.data
  if (bundle.scopeDigest !== request.scopeDigest)
    throw new CortanaContextAdapterError('CORTANA_SCOPE_MISMATCH')
  const expectedPins = [
    [options.expectedCorpusRevision, bundle.corpusRevision],
    [options.expectedMemoryRevision, bundle.memoryRevision],
    [options.expectedEmbeddingVersion, bundle.embeddingVersion],
    [options.expectedRetrievalVersion, bundle.retrievalVersion],
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

export function createRuntimeNodeContextCommand(
  request: ContextProviderRequest,
  binding: RuntimeNodeContextReadBinding,
  deadline: string,
  mappedProjectRef: string
) {
  const payload = {
    version: 1,
    parameters: {
      mappedProjectRef,
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      objective: request.objective,
      scopeDigest: request.scopeDigest,
      principalRef: request.principalRef,
      capability: request.capability,
      maximumTokens: request.policy.maximumTokens,
      maximumAgeSeconds: request.policy.maximumAgeSeconds,
      includeEvidence: request.policy.includeEvidence,
      includeMemory: request.policy.includeMemory,
    },
  }
  const semantics = {
    nodeId: binding.nodeId,
    workspaceId: request.workspaceId,
    providerRef: binding.providerRef,
    authorizationRef: binding.authorizationRef,
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    requiredCapabilities: ['context.read'],
    payload,
  }
  return GatewayCommandEnvelopeSchema.parse({
    ...semantics,
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    sequence: binding.sequence,
    traceId: binding.traceId,
    sentAt: request.now,
    channelGeneration: binding.channelGeneration,
    commandId: binding.commandId,
    idempotencyKey: binding.idempotencyKey,
    payloadHash: digest(canonical(semantics)),
    issuedAt: request.now,
    expiresAt: deadline,
  })
}

async function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  code: string
): Promise<T> {
  if (milliseconds <= 0) throw new CortanaContextAdapterError(code)
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new CortanaContextAdapterError(code))
          controller.abort()
        }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
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
