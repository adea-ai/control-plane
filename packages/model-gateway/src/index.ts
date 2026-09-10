import { IdentifierSchemas } from '@control-plane/contracts'
import { ModelRequirementSchema } from '@control-plane/domain'
import {
  PolicyDecisionSchema,
  PolicySnapshotReferenceSchema,
  type PolicyDecisionPoint,
} from '@control-plane/policy'
import { z } from 'zod'

const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const AliasSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)

export const ModelMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().min(1).max(262_144),
  })
  .strict()

export const ManagedModelRequestSchema = z
  .object({
    modelCallId: IdentifierSchemas.modelCallId,
    requestId: IdentifierSchemas.requestId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    workspaceId: IdentifierSchemas.workspaceId,
    principalRef: ReferenceSchema,
    alias: AliasSchema,
    messages: z.array(ModelMessageSchema).min(1).max(256),
    settings: z
      .object({
        maxOutputTokens: z.number().int().positive().max(131_072),
        temperature: z.number().min(0).max(2),
        timeoutMs: z.number().int().positive().max(900_000),
        responseFormat: z.enum(['text', 'json']).optional(),
      })
      .strict(),
    requirement: ModelRequirementSchema,
    policySnapshot: PolicySnapshotReferenceSchema,
    traceId: IdentifierSchemas.traceId,
    fundingSource: z.enum(['hq_managed', 'external_subscription']),
    routing: z
      .object({
        entitlements: z.array(AliasSchema).max(64),
        maxCostClass: z.enum(['low', 'standard', 'premium']),
        estimatedInputTokens: z.number().int().nonnegative().max(1_000_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.alias !== request.requirement.alias) {
      context.addIssue({ code: 'custom', message: 'Alias must match the pinned requirement' })
    }
    const bytes = Buffer.byteLength(JSON.stringify(request.messages), 'utf8')
    if (bytes > 1_048_576) {
      context.addIssue({ code: 'custom', message: 'Model input exceeds the request limit' })
    }
  })

export const NormalizedModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().default(0),
    reasoningTokens: z.number().int().nonnegative().default(0),
  })
  .strict()

export const ManagedModelResultSchema = z
  .object({
    modelCallId: IdentifierSchemas.modelCallId,
    alias: AliasSchema,
    content: z.string().max(4_194_304),
    finishReason: z.enum(['stop', 'length', 'tool_call', 'cancelled', 'content_filter', 'error']),
    usage: NormalizedModelUsageSchema,
    latencyMs: z.number().int().nonnegative(),
    provider: z
      .object({
        name: AliasSchema,
        model: z.string().min(1).max(256),
        requestId: z.string().min(1).max(256).optional(),
      })
      .strict(),
    traceId: IdentifierSchemas.traceId,
    fundingSource: z.enum(['hq_managed', 'external_subscription']),
    policySnapshot: PolicySnapshotReferenceSchema,
    policyDecisionId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    route: z
      .object({
        deploymentId: ReferenceSchema,
        routerVersion: z.literal('model-router/v1'),
        eligibleCandidateIds: z.array(ReferenceSchema).min(1).max(128),
        reason: z.literal('DETERMINISTIC_POLICY_RANK'),
        fallbackFrom: ReferenceSchema.optional(),
      })
      .strict(),
  })
  .strict()

export const ModelStreamChunkSchema = z
  .object({
    modelCallId: IdentifierSchemas.modelCallId,
    alias: AliasSchema,
    sequence: z.number().int().nonnegative(),
    delta: z.string().max(262_144),
    finishReason: z
      .enum(['stop', 'length', 'tool_call', 'cancelled', 'content_filter', 'error'])
      .optional(),
    usage: NormalizedModelUsageSchema.optional(),
    traceId: IdentifierSchemas.traceId,
  })
  .strict()

export type ManagedModelRequest = z.output<typeof ManagedModelRequestSchema>
export type ManagedModelResult = z.output<typeof ManagedModelResultSchema>
export type ModelStreamChunk = z.output<typeof ModelStreamChunkSchema>

interface ModelDeployment {
  readonly deploymentId: string
  readonly alias: string
  readonly provider: string
  readonly providerModel: string
  readonly providerClass: 'managed' | 'local' | 'private_cloud'
  readonly dataResidency: 'us' | 'eu' | 'global' | 'local'
  readonly capabilities: readonly string[]
  readonly credentialRef: string
  readonly adapterRef: string
  readonly enabled: boolean
  readonly fundingSource: 'hq_managed' | 'external_subscription'
  readonly maxContextTokens: number
  readonly maxOutputTokens: number
  readonly costClass: 'low' | 'standard' | 'premium'
  readonly priority: number
  readonly requiredEntitlements: readonly string[]
}

export class ModelRouteRegistry {
  readonly #deployments = new Map<string, ModelDeployment>()
  readonly #health = new Map<string, 'healthy' | 'degraded' | 'unhealthy'>()

  register(input: ModelDeployment): void {
    if (
      !ReferenceSchema.safeParse(input.deploymentId).success ||
      !AliasSchema.safeParse(input.alias).success ||
      !AliasSchema.safeParse(input.provider).success ||
      !ReferenceSchema.safeParse(input.adapterRef).success ||
      !/^(?:lease|vault):\/\/\S{1,500}$/.test(input.credentialRef) ||
      !Number.isSafeInteger(input.maxContextTokens) ||
      input.maxContextTokens <= 0 ||
      !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens <= 0 ||
      !Number.isSafeInteger(input.priority) ||
      input.priority < 0
    ) {
      throw new Error('INVALID_MODEL_DEPLOYMENT')
    }
    if (this.#deployments.has(input.deploymentId)) throw new Error('MODEL_DEPLOYMENT_EXISTS')
    this.#deployments.set(input.deploymentId, clone(input))
    this.#health.set(input.deploymentId, 'healthy')
  }

  setHealth(deploymentId: string, health: 'healthy' | 'degraded' | 'unhealthy'): void {
    if (!this.#deployments.has(deploymentId)) throw new Error('MODEL_DEPLOYMENT_MISSING')
    this.#health.set(deploymentId, health)
  }

  resolve(alias: string): readonly ModelDeployment[] {
    return [...this.#deployments.values()]
      .filter(
        (deployment) =>
          deployment.enabled &&
          deployment.alias === alias &&
          this.#health.get(deployment.deploymentId) !== 'unhealthy'
      )
      .toSorted(compareDeployments)
      .map(clone)
  }
}

export interface AdapterCompletion {
  readonly content: string
  readonly finishReason: ManagedModelResult['finishReason']
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cachedInputTokens?: number
    readonly reasoningTokens?: number
  }
  readonly providerRequestId?: string
  readonly latencyMs: number
}

export interface AdapterStreamChunk {
  readonly delta: string
  readonly finishReason?: ManagedModelResult['finishReason']
  readonly usage?: AdapterCompletion['usage']
}

export interface ModelProviderAdapter {
  complete(request: ManagedModelRequest, deployment: ModelDeployment): Promise<AdapterCompletion>
  stream(
    request: ManagedModelRequest,
    deployment: ModelDeployment
  ): AsyncIterable<AdapterStreamChunk>
  health(): Promise<{
    readonly healthy: boolean
    readonly checkedAt: string
    readonly reasonCode?: string
  }>
  cancel(modelCallId: string): Promise<boolean>
}

export type ModelGatewayErrorCode =
  | 'INVALID_REQUEST'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_POLICY_DENIED'
  | 'PROVIDER_FAILED'
  | 'STREAM_FAILED'
  | 'ADAPTER_UNAVAILABLE'

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    readonly retryable = false
  ) {
    super(code)
    this.name = 'ModelGatewayError'
  }
}

export class ModelProviderError extends Error {
  constructor(
    readonly providerCode: string,
    readonly retryable: boolean
  ) {
    super(providerCode)
    this.name = 'ModelProviderError'
  }
}

export class ManagedModelGateway {
  readonly #registry: ModelRouteRegistry
  readonly #adapters: ReadonlyMap<string, ModelProviderAdapter>
  readonly #decisionPoint: PolicyDecisionPoint
  readonly #now: () => string
  readonly #calls = new Map<string, string>()

  constructor(options: {
    readonly registry: ModelRouteRegistry
    readonly adapters: ReadonlyMap<string, ModelProviderAdapter>
    readonly decisionPoint: PolicyDecisionPoint
    readonly now?: () => string
  }) {
    this.#registry = options.registry
    this.#adapters = options.adapters
    this.#decisionPoint = options.decisionPoint
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async complete(input: unknown): Promise<ManagedModelResult> {
    const { request, candidates } = await this.#prepare(input)
    const eligibleCandidateIds = candidates.map(({ deployment }) => deployment.deploymentId)
    let fallbackFrom: string | undefined
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      if (!candidate) continue
      const { deployment, adapter, decision } = candidate
      this.#calls.set(request.modelCallId, deployment.adapterRef)
      let completion: AdapterCompletion
      try {
        completion = await withTimeout(
          adapter.complete(request, deployment),
          request.settings.timeoutMs
        )
      } catch (error) {
        const retryable = error instanceof ModelProviderError && error.retryable
        if (retryable && index + 1 < candidates.length) {
          fallbackFrom ??= deployment.deploymentId
          continue
        }
        throw new ModelGatewayError('PROVIDER_FAILED', retryable)
      }
      return ManagedModelResultSchema.parse({
        modelCallId: request.modelCallId,
        alias: request.alias,
        content: completion.content,
        finishReason: completion.finishReason,
        usage: normalizeUsage(completion.usage),
        latencyMs: completion.latencyMs,
        provider: {
          name: deployment.provider,
          model: deployment.providerModel,
          ...(completion.providerRequestId === undefined
            ? {}
            : { requestId: completion.providerRequestId }),
        },
        traceId: request.traceId,
        fundingSource: request.fundingSource,
        policySnapshot: decision.policySnapshot,
        policyDecisionId: decision.decisionId,
        route: {
          deploymentId: deployment.deploymentId,
          routerVersion: 'model-router/v1',
          eligibleCandidateIds,
          reason: 'DETERMINISTIC_POLICY_RANK',
          ...(fallbackFrom === undefined ? {} : { fallbackFrom }),
        },
      })
    }
    throw new ModelGatewayError('MODEL_UNAVAILABLE')
  }

  async *stream(input: unknown): AsyncIterable<ModelStreamChunk> {
    const { request, candidates } = await this.#prepare(input)
    const selected = candidates[0]
    if (!selected) throw new ModelGatewayError('MODEL_UNAVAILABLE')
    const { deployment, adapter } = selected
    this.#calls.set(request.modelCallId, deployment.adapterRef)
    let sequence = 0
    let completed = false
    try {
      for await (const chunk of adapter.stream(request, deployment)) {
        if (completed) throw new ModelGatewayError('STREAM_FAILED', true)
        completed = chunk.finishReason !== undefined
        yield ModelStreamChunkSchema.parse({
          modelCallId: request.modelCallId,
          alias: request.alias,
          sequence: sequence++,
          delta: chunk.delta,
          ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
          ...(chunk.usage === undefined ? {} : { usage: normalizeUsage(chunk.usage) }),
          traceId: request.traceId,
        })
      }
      if (!completed) throw new ModelGatewayError('STREAM_FAILED', true)
    } catch {
      throw new ModelGatewayError('STREAM_FAILED', true)
    }
  }

  async health(adapterRef: string) {
    const adapter = this.#adapters.get(adapterRef)
    if (!adapter) throw new ModelGatewayError('ADAPTER_UNAVAILABLE')
    try {
      return await adapter.health()
    } catch {
      return { healthy: false, checkedAt: this.#now(), reasonCode: 'ADAPTER_UNAVAILABLE' }
    }
  }

  async cancel(modelCallId: string): Promise<boolean> {
    const parsed = IdentifierSchemas.modelCallId.parse(modelCallId)
    const adapterRef = this.#calls.get(parsed)
    if (!adapterRef) return false
    const adapter = this.#adapters.get(adapterRef)
    if (!adapter) return false
    try {
      return await adapter.cancel(parsed)
    } catch {
      return false
    }
  }

  async #prepare(input: unknown) {
    const parsed = ManagedModelRequestSchema.safeParse(input)
    if (!parsed.success) throw new ModelGatewayError('INVALID_REQUEST')
    const request = parsed.data
    const eligibleDeployments = this.#registry
      .resolve(request.alias)
      .filter((candidate) => eligible(candidate, request))
    if (eligibleDeployments.length === 0) throw new ModelGatewayError('MODEL_UNAVAILABLE')
    const candidates: {
      deployment: ModelDeployment
      adapter: ModelProviderAdapter
      decision: z.output<typeof PolicyDecisionSchema>
    }[] = []
    for (const deployment of eligibleDeployments) {
      const adapter = this.#adapters.get(deployment.adapterRef)
      if (!adapter) continue
      let decision: z.output<typeof PolicyDecisionSchema>
      try {
        decision = PolicyDecisionSchema.parse(
          await this.#decisionPoint.authorize({
            requestId: request.requestId,
            principal: {
              type: 'service',
              id: request.principalRef,
              workspaceId: request.workspaceId,
            },
            action: 'model:invoke',
            resource: {
              type: 'model',
              id: deployment.deploymentId,
              workspaceId: request.workspaceId,
              attributes: {
                alias: request.alias,
                provider: deployment.provider,
                providerClass: deployment.providerClass,
                dataResidency: deployment.dataResidency,
                capabilities: [...deployment.capabilities],
                fundingSource: request.fundingSource,
              },
            },
            context: {
              workspaceId: request.workspaceId,
              requestedAt: this.#now(),
              attributes: {
                executionId: request.executionId,
                attemptId: request.attemptId,
                modelCallId: request.modelCallId,
                traceId: request.traceId,
              },
            },
            policySnapshot: request.policySnapshot,
          })
        )
      } catch {
        throw new ModelGatewayError('MODEL_POLICY_DENIED')
      }
      if (decision.effect === 'allow') candidates.push({ deployment, adapter, decision })
    }
    if (candidates.length === 0) throw new ModelGatewayError('MODEL_POLICY_DENIED')
    return { request, candidates }
  }
}

export interface LiteLlmClientPort {
  complete(input: {
    readonly model: string
    readonly messages: ManagedModelRequest['messages']
    readonly maxTokens: number
    readonly temperature: number
    readonly timeoutMs: number
    readonly traceId: string
    readonly credentialRef: string
  }): Promise<{
    readonly choices: readonly {
      readonly message: { readonly content: string }
      readonly finish_reason: string
    }[]
    readonly usage: {
      readonly prompt_tokens: number
      readonly completion_tokens: number
      readonly total_tokens: number
      readonly prompt_tokens_details?: { readonly cached_tokens?: number }
      readonly completion_tokens_details?: { readonly reasoning_tokens?: number }
    }
    readonly id?: string
    readonly response_ms?: number
  }>
  stream?(input: {
    readonly model: string
    readonly messages: ManagedModelRequest['messages']
    readonly maxTokens: number
    readonly temperature: number
    readonly timeoutMs: number
    readonly traceId: string
    readonly credentialRef: string
  }): AsyncIterable<{
    readonly delta: string
    readonly finish_reason?: string
    readonly usage?: {
      readonly prompt_tokens: number
      readonly completion_tokens: number
    }
  }>
  health(): Promise<{
    readonly healthy: boolean
    readonly checkedAt: string
    readonly reasonCode?: string
  }>
  cancel(modelCallId: string): Promise<boolean>
}

export class LiteLlmAdapter implements ModelProviderAdapter {
  readonly client: LiteLlmClientPort

  constructor(options: { readonly client: LiteLlmClientPort }) {
    this.client = options.client
  }

  async complete(request: ManagedModelRequest, deployment: ModelDeployment) {
    const result = await this.client.complete({
      model: deployment.providerModel,
      messages: request.messages,
      maxTokens: request.settings.maxOutputTokens,
      temperature: request.settings.temperature,
      timeoutMs: request.settings.timeoutMs,
      traceId: request.traceId,
      credentialRef: deployment.credentialRef,
    })
    const choice = result.choices[0]
    if (!choice) throw new Error('LITELLM_EMPTY_RESPONSE')
    return {
      content: choice.message.content,
      finishReason: normalizeFinishReason(choice.finish_reason),
      usage: {
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        cachedInputTokens: result.usage.prompt_tokens_details?.cached_tokens ?? 0,
        reasoningTokens: result.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      ...(result.id === undefined ? {} : { providerRequestId: result.id }),
      latencyMs: Math.max(0, Math.round(result.response_ms ?? 0)),
    }
  }

  async *stream(
    request: ManagedModelRequest,
    deployment: ModelDeployment
  ): AsyncIterable<AdapterStreamChunk> {
    if (!this.client.stream) throw new Error('LITELLM_STREAM_NOT_CONFIGURED')
    for await (const chunk of this.client.stream({
      model: deployment.providerModel,
      messages: request.messages,
      maxTokens: request.settings.maxOutputTokens,
      temperature: request.settings.temperature,
      timeoutMs: request.settings.timeoutMs,
      traceId: request.traceId,
      credentialRef: deployment.credentialRef,
    })) {
      yield {
        delta: chunk.delta,
        ...(chunk.finish_reason === undefined
          ? {}
          : { finishReason: normalizeFinishReason(chunk.finish_reason) }),
        ...(chunk.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              },
            }),
      }
    }
  }

  health() {
    return this.client.health()
  }

  cancel(modelCallId: string) {
    return this.client.cancel(modelCallId)
  }
}

export class FakeModelAdapter implements ModelProviderAdapter {
  readonly requests: { readonly request: ManagedModelRequest; readonly deploymentId: string }[] = []
  completion: AdapterCompletion = {
    content: '',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
  }
  streamChunks: readonly AdapterStreamChunk[] = []
  error: Error | undefined
  readonly errorsByDeployment = new Map<
    string,
    { readonly code: string; readonly retryable: boolean }
  >()

  async complete(request: ManagedModelRequest, deployment: ModelDeployment) {
    this.requests.push({ request: clone(request), deploymentId: deployment.deploymentId })
    const classified = this.errorsByDeployment.get(deployment.deploymentId)
    if (classified) throw new ModelProviderError(classified.code, classified.retryable)
    if (this.error) throw this.error
    return clone(this.completion)
  }

  async *stream(request: ManagedModelRequest, deployment: ModelDeployment) {
    this.requests.push({ request: clone(request), deploymentId: deployment.deploymentId })
    if (this.error) throw this.error
    for (const chunk of this.streamChunks) yield clone(chunk)
  }

  async health() {
    return { healthy: true, checkedAt: '2026-08-25T09:00:00.000Z' }
  }

  async cancel(modelCallId: string) {
    void modelCallId
    return true
  }
}

function eligible(deployment: ModelDeployment, request: ManagedModelRequest): boolean {
  const requirement = request.requirement
  return (
    deployment.fundingSource === request.fundingSource &&
    requirement.providerPolicy.allowedClasses.includes(deployment.providerClass) &&
    !requirement.providerPolicy.deniedProviders.includes(deployment.provider) &&
    requirement.providerPolicy.dataResidency.includes(deployment.dataResidency) &&
    requirement.requiredCapabilities.every((capability) =>
      deployment.capabilities.includes(capability)
    ) &&
    deployment.requiredEntitlements.every((entitlement) =>
      request.routing.entitlements.includes(entitlement)
    ) &&
    costRank(deployment.costClass) <= costRank(request.routing.maxCostClass) &&
    request.settings.maxOutputTokens <= deployment.maxOutputTokens &&
    request.routing.estimatedInputTokens + request.settings.maxOutputTokens <=
      deployment.maxContextTokens
  )
}

function compareDeployments(left: ModelDeployment, right: ModelDeployment): number {
  return (
    left.priority - right.priority ||
    costRank(left.costClass) - costRank(right.costClass) ||
    left.deploymentId.localeCompare(right.deploymentId)
  )
}

function costRank(value: ModelDeployment['costClass']): number {
  return { low: 0, standard: 1, premium: 2 }[value]
}

function normalizeUsage(usage: AdapterCompletion['usage']) {
  return NormalizedModelUsageSchema.parse({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  })
}

function normalizeFinishReason(reason: string): ManagedModelResult['finishReason'] {
  if (reason === 'stop' || reason === 'length' || reason === 'tool_call') return reason
  if (reason === 'content_filter' || reason === 'cancelled') return reason
  return 'error'
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ModelProviderError('MODEL_TIMEOUT', true)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

export const packageName = 'model-gateway'
