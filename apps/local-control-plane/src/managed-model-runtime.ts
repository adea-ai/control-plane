import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { ModelProviderClassSchema } from '@control-plane/domain'
import type { SecretLease, SecretsProvider } from '@control-plane/deployment'
import type {
  ManagedPiProcessInvocation,
  ManagedPiProcessInvocationContext,
} from '@control-plane/managed-pi-adapter'
import { ManagedPiConfigurationSchema } from '@control-plane/managed-pi-adapter'
import {
  LedgerLiteLlmHttpClient,
  LiteLlmAdapter,
  ManagedModelGateway,
  ManagedModelRequestSchema,
  ModelRouteRegistry,
  NativeModelBroker,
  RecordedModelSpendingAuthorizationSchema,
  type ModelDeployment,
} from '@control-plane/model-gateway'
import { RuntimeAttemptBudgetAuthoritySchema } from '@control-plane/runtime-sdk'
import { DurableUsageLedger, ModelPriceSnapshotSchema } from '@control-plane/usage-ledger'
import { z } from 'zod'
import { LocalRuntimeModelRoute, type LocalModelRouteOptions } from './runtime-model-route.js'
import { startNativeModelListener, type NativeModelListener } from './native-model-listener.js'

/** An operator-owned private file records the spending decision and its evidence.
 * ExecutionPlan limits and runtime allocation never create this authorization.
 * Removing/replacing the file revokes an existing connection's next send.
 */
export const LocalModelSpendingRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionPlanId: z.string(),
    executionPlanDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    grant: RecordedModelSpendingAuthorizationSchema,
    price: ModelPriceSnapshotSchema,
    endpoint: z.string().url(),
    proxyModelId: z.string().min(1).max(256),
    credential: z
      .object({
        provider: z.enum(['file', 'env', 'docker-secret']),
        key: z.string().min(1).max(256),
        version: z.string().min(1).max(256).optional(),
      })
      .strict(),
    costClass: z.enum(['low', 'standard', 'premium']),
    entitlements: z.array(z.string().regex(/^[a-z][a-z0-9.-]*$/)).max(64),
  })
  .strict()

export interface ManagedPiModelConnectionOptions {
  readonly directory: string
  readonly secrets: SecretsProvider
  readonly ledger: DurableUsageLedger
  readonly configuration: ReturnType<typeof ManagedPiConfigurationSchema.parse>
  readonly context: ManagedPiProcessInvocationContext
  readonly workspaceId: string
  readonly route: LocalModelRouteOptions
  readonly path: string
  /** Tests inject the HTTP boundary without opening a local listening socket. */
  readonly listen?: (fetch: (request: Request) => Promise<Response>) => Promise<NativeModelListener>
  readonly fetch?: typeof globalThis.fetch
}

export async function createManagedPiModelConnection(
  options: ManagedPiModelConnectionOptions
): Promise<NonNullable<ManagedPiProcessInvocation['modelConnection']>> {
  const configuration = ManagedPiConfigurationSchema.parse(options.configuration)
  const budget = RuntimeAttemptBudgetAuthoritySchema.parse(options.context.attemptBudget)
  if (
    budget.workspaceId !== options.workspaceId ||
    budget.executionId !== options.context.executionId ||
    budget.attemptId !== options.context.attemptId ||
    budget.executionPlanId !== configuration.executionPlanId ||
    budget.executionPlanDigest !== configuration.executionPlanDigest ||
    budget.currency !== configuration.limits.budget.currency ||
    budget.maximumMicrounits !== configuration.limits.budget.maximumMicrounits ||
    budget.maximumTokens !== configuration.limits.tokens.maximumTotal ||
    budget.reservationKey !== `runtime-attempt:${budget.attemptId}`
  )
    throw new Error('MANAGED_PI_MODEL_ALLOCATION_MISMATCH')
  new LocalRuntimeModelRoute(options.route, 'MANAGED_PI').assertEligible(configuration.modelPolicy)
  const scope = {
    workspaceId: budget.workspaceId,
    executionId: budget.executionId,
    attemptId: budget.attemptId,
  }
  const reference = {
    provider: 'file',
    key: `model-authorizations/${scope.workspaceId}/${scope.executionId}/${scope.attemptId}.json`,
  }
  const readRecord = async (signal: AbortSignal) => {
    const lease = await resolveLease(options.secrets, reference, scope.workspaceId, signal)
    try {
      return LocalModelSpendingRecordSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lease.value))
      )
    } finally {
      await lease.close()
    }
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(options.context.signal === undefined ? [] : [options.context.signal]),
  ])
  const record = await readRecord(signal)
  const { grant, price } = record
  const at = Date.now()
  if (
    record.executionPlanId !== configuration.executionPlanId ||
    record.executionPlanDigest !== configuration.executionPlanDigest ||
    grant.workspaceId !== scope.workspaceId ||
    grant.executionId !== scope.executionId ||
    grant.attemptId !== scope.attemptId ||
    grant.alias !== options.route.modelAlias ||
    grant.policySnapshotDigest !== configuration.policySnapshot.digest ||
    price.deploymentId !== grant.deploymentId ||
    price.provider !== options.route.provider ||
    price.model !== options.route.model ||
    price.fundingSource !== grant.fundingSource ||
    price.currency !== grant.currency ||
    at < Date.parse(grant.issuedAt) ||
    at >= Date.parse(grant.expiresAt) ||
    at < Date.parse(price.validFrom) ||
    at >= Date.parse(price.validUntil) ||
    grant.maximumTokens < budget.maximumTokens ||
    (grant.fundingSource === 'hq_managed' && grant.maximumMicrounits < budget.maximumMicrounits)
  )
    throw new Error('MANAGED_PI_MODEL_SPENDING_DENIED')
  assertProxyEndpoint(record.endpoint)
  const allocation = await readWithin(
    options.ledger.attemptAllocation(scope.workspaceId, scope.executionId, scope.attemptId),
    signal
  )
  if (
    canonicalJsonStringify(allocation) !==
    canonicalJsonStringify({
      currency: budget.currency,
      maximumMicrounits: budget.maximumMicrounits,
      maximumTokens: budget.maximumTokens,
    })
  )
    throw new Error('MANAGED_PI_MODEL_ALLOCATION_MISMATCH')
  const entries = await readWithin(
    options.ledger.entries(scope.workspaceId, scope.executionId),
    signal
  )
  const unsettled = new Set(
    entries
      .filter((entry) => entry.attemptId === scope.attemptId && entry.kind === 'model_reservation')
      .map((entry) => entry.modelCallId)
  )
  for (const entry of entries)
    if (entry.attemptId === scope.attemptId && entry.kind === 'model_release')
      unsettled.delete(entry.modelCallId)
  if (unsettled.size > 0) throw new Error('MANAGED_PI_MODEL_RECONCILIATION_REQUIRED')
  signal.throwIfAborted()
  const fingerprint = canonicalJsonStringify(record)
  const assertActive = async (activeSignal: AbortSignal) => {
    activeSignal.throwIfAborted()
    if (
      canonicalJsonStringify(await readRecord(activeSignal)) !== fingerprint ||
      Date.now() >= Date.parse(grant.expiresAt)
    )
      throw new Error('MANAGED_PI_MODEL_SPENDING_REVOKED')
  }
  const requirement = configuration.modelPolicy.find((candidate) => candidate.alias === grant.alias)
  if (!requirement) throw new Error('MANAGED_PI_MODEL_ALIAS_UNRESOLVED')
  const deployment: ModelDeployment = {
    deploymentId: grant.deploymentId,
    alias: grant.alias,
    provider: price.provider,
    providerModel: price.model,
    providerClass: ModelProviderClassSchema.parse(options.route.providerClass),
    dataResidency: options.route.dataResidency as ModelDeployment['dataResidency'],
    capabilities: options.route.modelCapabilities,
    credentialRef: grant.credentialRef,
    adapterRef: 'managed-litellm',
    enabled: true,
    fundingSource: grant.fundingSource,
    maxContextTokens: price.maximumInputTokens,
    maxOutputTokens: price.maximumOutputTokens,
    costClass: record.costClass,
    priority: 0,
    requiredEntitlements: record.entitlements,
  }
  const assertRequest = (request: {
    workspaceId: string
    executionId: string
    attemptId: string
    principalRef: string
    alias: string
    fundingSource: string
    policySnapshot: unknown
  }) => {
    if (
      request.workspaceId !== scope.workspaceId ||
      request.executionId !== scope.executionId ||
      request.attemptId !== scope.attemptId ||
      request.principalRef !== grant.principalRef ||
      request.alias !== grant.alias ||
      request.fundingSource !== grant.fundingSource ||
      canonicalJsonStringify(request.policySnapshot) !==
        canonicalJsonStringify(configuration.policySnapshot)
    )
      throw new Error('MANAGED_PI_MODEL_SCOPE_MISMATCH')
  }
  const client = new LedgerLiteLlmHttpClient({
    ledger: options.ledger,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    authority: {
      authorize: async ({ request, deployment: selected }, requestSignal) => {
        assertRequest(request)
        if (canonicalJsonStringify(selected) !== canonicalJsonStringify(deployment))
          throw new Error('MANAGED_PI_MODEL_SCOPE_MISMATCH')
        await assertActive(requestSignal)
        const lease = await resolveLease(
          options.secrets,
          {
            provider: record.credential.provider,
            key: record.credential.key,
            ...(record.credential.version === undefined
              ? {}
              : { version: record.credential.version }),
          },
          scope.workspaceId,
          requestSignal
        )
        return {
          grant,
          price,
          endpoint: record.endpoint,
          proxyModelId: record.proxyModelId,
          credential: {
            value: lease.value,
            close: async () => {
              lease.close()
            },
          },
          assertActive,
        }
      },
    },
  })
  const registry = new ModelRouteRegistry()
  registry.register(deployment)
  const gateway = new ManagedModelGateway({
    registry,
    adapters: new Map([['managed-litellm', new LiteLlmAdapter({ client })]]),
    decisionPoint: {
      authorize: async (request) => {
        if (
          request.action !== 'model:invoke' ||
          request.resource.id !== deployment.deploymentId ||
          request.principal.id !== grant.principalRef ||
          request.principal.workspaceId !== scope.workspaceId ||
          request.context.workspaceId !== scope.workspaceId ||
          request.context.attributes?.['executionId'] !== scope.executionId ||
          request.context.attributes?.['attemptId'] !== scope.attemptId ||
          canonicalJsonStringify(request.policySnapshot) !==
            canonicalJsonStringify(configuration.policySnapshot)
        )
          throw new Error('MANAGED_PI_MODEL_SCOPE_MISMATCH')
        await assertActive(AbortSignal.timeout(15_000))
        return {
          effect: 'allow',
          decisionId: `sha256:${createHash('sha256').update(fingerprint).update(canonicalJsonStringify(request)).digest('hex')}`,
          reasonCode: 'RECORDED_OPERATOR_SPENDING_AUTHORIZATION',
          policySnapshot: configuration.policySnapshot,
          evaluatedAt: new Date().toISOString(),
        }
      },
    },
  })
  const capability = randomBytes(32).toString('hex')
  const broker = new NativeModelBroker({
    gateway,
    capability,
    template: ManagedModelRequestSchema.parse({
      modelCallId: identifier('mdc'),
      requestId: identifier('req'),
      traceId: identifier('trc'),
      ...scope,
      principalRef: grant.principalRef,
      alias: grant.alias,
      requirement,
      policySnapshot: configuration.policySnapshot,
      fundingSource: grant.fundingSource,
      messages: [{ role: 'user', content: 'native request' }],
      settings: {
        maxOutputTokens: Math.min(price.maximumOutputTokens, budget.maximumTokens, 131_072),
        temperature: 0,
        timeoutMs: Math.min(configuration.limits.duration.maximumMs, 900_000),
      },
      routing: {
        entitlements: record.entitlements,
        maxCostClass: record.costClass,
        estimatedInputTokens: 0,
      },
    }),
  })
  let home: string | undefined
  let listener: NativeModelListener | undefined
  try {
    await mkdir(options.directory, { recursive: true, mode: 0o700 })
    home = await mkdtemp(join(options.directory, 'attempt-'))
    const agent = join(home, 'agent')
    const sessions = join(home, 'sessions')
    await mkdir(agent, { mode: 0o700 })
    await mkdir(sessions, { mode: 0o700 })
    listener = await (options.listen ?? startNativeModelListener)((request) =>
      broker.fetch(request)
    )
    signal.throwIfAborted()
    const origin = new URL(listener.origin)
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      !origin.port ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('MANAGED_PI_MODEL_LISTENER_INVALID')
    await writeFile(
      join(agent, 'auth.json'),
      JSON.stringify({ 'control-plane': { type: 'api_key', key: capability } }),
      { mode: 0o600, flag: 'wx' }
    )
    await writeFile(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          'control-plane': {
            baseUrl: `${origin.origin}/v1`,
            api: 'openai-completions',
            models: [
              {
                id: grant.alias,
                reasoning: false,
                input: ['text'],
                contextWindow: deployment.maxContextTokens,
                maxTokens: deployment.maxOutputTokens,
              },
            ],
          },
        },
      }),
      { mode: 0o600, flag: 'wx' }
    )
    let closing: Promise<void> | undefined
    const ownedListener = listener
    const ownedHome = home
    return {
      environment: {
        PATH: options.path,
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: sessions,
      },
      close: () => (closing ??= closeConnection(broker, ownedListener, ownedHome)),
    }
  } catch (error) {
    await closeConnection(broker, listener, home)
    throw error
  }
}

async function closeConnection(
  broker: NativeModelBroker,
  listener?: NativeModelListener,
  home?: string
) {
  try {
    await broker.close()
  } finally {
    try {
      await listener?.close()
    } finally {
      if (home) await rm(home, { recursive: true, force: true })
    }
  }
}

async function resolveLease(
  secrets: SecretsProvider,
  reference: { provider: string; key: string; version?: string },
  workspaceId: string,
  signal: AbortSignal
): Promise<SecretLease> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('MANAGED_PI_MODEL_AUTHORITY_TIMEOUT'))
    signal.addEventListener('abort', abort, { once: true })
    void secrets
      .resolve(reference, {
        purpose: 'managed-model-request',
        workspaceId,
        operation: 'model:invoke',
      })
      .then(
        async (lease) => {
          signal.removeEventListener('abort', abort)
          if (signal.aborted) {
            await lease.close()
            reject(new Error('MANAGED_PI_MODEL_AUTHORITY_TIMEOUT'))
          } else resolve(lease)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        }
      )
      .catch(reject)
  })
}

function assertProxyEndpoint(value: string) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/chat/completions' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('MANAGED_PI_MODEL_PROXY_INVALID')
}

function identifier(prefix: string) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  return `${prefix}_${Array.from(randomBytes(26), (byte) => alphabet[byte & 31]).join('')}`
}

async function readWithin<Value>(read: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('MANAGED_PI_MODEL_AUTHORITY_TIMEOUT'))
    void read.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) abort()
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
