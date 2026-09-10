import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const SandboxIdSchema = z.string().regex(/^sbx_[0-9A-HJKMNP-TV-Z]{26}$/)
const BoundedPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => value.startsWith('/') && !value.includes('..'),
    'Expected an absolute safe path'
  )

export const SandboxNetworkPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('deny_all') }).strict(),
  z
    .object({
      mode: z.literal('allowlist'),
      allowedHosts: z
        .array(
          z
            .string()
            .min(1)
            .max(253)
            .regex(/^[a-z0-9.-]+$/)
        )
        .max(128)
        .refine((values) => new Set(values).size === values.length),
    })
    .strict(),
])

export const SandboxResourcePolicySchema = z
  .object({
    template: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9._-]+$/),
    timeoutMs: z.number().int().positive().max(86_400_000),
    limits: z
      .object({
        cpuCount: z.number().int().positive().max(64),
        memoryMb: z.number().int().positive().max(262_144),
        storageMb: z.number().int().positive().max(1_048_576),
        outputBytes: z.number().int().positive().max(16_777_216),
      })
      .strict(),
    network: SandboxNetworkPolicySchema,
  })
  .strict()

export const SandboxCreateRequestSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    policy: SandboxResourcePolicySchema,
  })
  .strict()

export const SandboxHandleSchema = z
  .object({
    sandboxId: SandboxIdSchema,
    providerRef: z.string().min(1).max(128),
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()

export const SandboxExecuteRequestSchema = z
  .object({
    sandboxId: SandboxIdSchema,
    command: z.array(z.string().max(16_384)).min(1).max(256),
    environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(65_536)),
    credentialBindings: z
      .array(
        z
          .object({
            leaseId: IdentifierSchemas.credentialLeaseId,
            environmentName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
          })
          .strict()
      )
      .max(32)
      .optional(),
    timeoutMs: z.number().int().positive().max(86_400_000),
  })
  .strict()

export const SandboxExecutionResultSchema = z
  .object({
    exitCode: z.number().int().min(-1).max(255),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict()

export const SandboxStatusSchema = z
  .object({
    sandboxId: SandboxIdSchema,
    state: z.enum(['creating', 'ready', 'running', 'failed', 'destroyed']),
    observedAt: TimestampSchema,
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  })
  .strict()

export type SandboxCreateRequest = z.output<typeof SandboxCreateRequestSchema>
export type SandboxHandle = z.output<typeof SandboxHandleSchema>
export type SandboxExecuteRequest = z.output<typeof SandboxExecuteRequestSchema>
export type SandboxExecutionResult = z.output<typeof SandboxExecutionResultSchema>
export type SandboxStatus = z.output<typeof SandboxStatusSchema>

export type SandboxErrorCode =
  | 'INVALID_REQUEST'
  | 'SANDBOX_NOT_FOUND'
  | 'POLICY_DENIED'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'PROVIDER_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROMOTION_DENIED'

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    readonly retryable = false
  ) {
    super(code)
    this.name = 'SandboxError'
  }
}

export interface SandboxProvider {
  create(request: SandboxCreateRequest): Promise<SandboxHandle>
  execute(request: SandboxExecuteRequest): Promise<SandboxExecutionResult>
  upload(sandboxId: string, path: string, content: Uint8Array): Promise<void>
  download(sandboxId: string, path: string): Promise<Uint8Array>
  status(sandboxId: string): Promise<SandboxStatus>
  destroy(sandboxId: string, reason: string): Promise<void>
  list(): Promise<readonly SandboxHandle[]>
}

export interface ArtifactPromoter {
  promote(input: {
    readonly workspaceId: string
    readonly executionId: string
    readonly sandboxId: string
    readonly path: string
    readonly content: Uint8Array
  }): Promise<{
    readonly artifactId: string
    readonly locator: string
    readonly digest: string
    readonly sizeBytes: number
  }>
}

interface SandboxRecord {
  readonly handle: SandboxHandle
  readonly policy: z.output<typeof SandboxResourcePolicySchema>
}

export class SandboxCoordinator {
  readonly #provider: SandboxProvider
  readonly #promoter: ArtifactPromoter
  readonly #now: () => string
  readonly #records = new Map<string, SandboxRecord>()

  constructor(options: {
    readonly provider: SandboxProvider
    readonly promoter: ArtifactPromoter
    readonly now?: () => string
  }) {
    this.#provider = options.provider
    this.#promoter = options.promoter
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async create(input: unknown): Promise<SandboxHandle> {
    const parsed = SandboxCreateRequestSchema.safeParse(input)
    if (!parsed.success) throw new SandboxError('INVALID_REQUEST')
    const handle = SandboxHandleSchema.parse(await this.#provider.create(parsed.data))
    this.#records.set(handle.sandboxId, { handle, policy: parsed.data.policy })
    return handle
  }

  async execute(input: unknown): Promise<SandboxExecutionResult> {
    const parsed = SandboxExecuteRequestSchema.safeParse(input)
    if (!parsed.success) throw new SandboxError('INVALID_REQUEST')
    const record = this.#record(parsed.data.sandboxId)
    enforceExecutionPolicy(parsed.data, record.policy)
    const bounded = {
      ...parsed.data,
      timeoutMs: Math.min(parsed.data.timeoutMs, record.policy.timeoutMs),
    }
    try {
      const result = SandboxExecutionResultSchema.parse(await this.#provider.execute(bounded))
      return boundOutput(result, record.policy.limits.outputBytes)
    } catch (error) {
      const normalized = normalizeProviderError(error)
      await this.#provider.destroy(parsed.data.sandboxId, reasonFor(normalized))
      throw normalized
    }
  }

  async upload(input: {
    readonly sandboxId: string
    readonly path: string
    readonly content: Uint8Array
  }): Promise<void> {
    const record = this.#record(input.sandboxId)
    const path = BoundedPathSchema.safeParse(input.path)
    if (!path.success || input.content.byteLength > record.policy.limits.storageMb * 1_048_576) {
      throw new SandboxError('INVALID_REQUEST')
    }
    await this.#provider.upload(input.sandboxId, path.data, input.content)
  }

  async promote(input: { readonly sandboxId: string; readonly path: string }): Promise<{
    readonly artifactId: string
    readonly locator: string
    readonly digest: string
    readonly sizeBytes: number
  }> {
    const record = this.#record(input.sandboxId)
    const path = BoundedPathSchema.safeParse(input.path)
    if (!path.success) throw new SandboxError('INVALID_REQUEST')
    const content = await this.#provider.download(input.sandboxId, path.data)
    try {
      return await this.#promoter.promote({
        workspaceId: record.handle.workspaceId,
        executionId: record.handle.executionId,
        sandboxId: input.sandboxId,
        path: path.data,
        content,
      })
    } catch {
      throw new SandboxError('PROMOTION_DENIED')
    }
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    this.#record(sandboxId)
    return SandboxStatusSchema.parse(await this.#provider.status(sandboxId))
  }

  async destroy(sandboxId: string, reason: string): Promise<void> {
    this.#record(sandboxId)
    await this.#provider.destroy(sandboxId, reason.slice(0, 128))
  }

  async reap(input: { readonly olderThanMs: number }): Promise<readonly string[]> {
    if (!Number.isSafeInteger(input.olderThanMs) || input.olderThanMs < 0) {
      throw new SandboxError('INVALID_REQUEST')
    }
    const threshold = Date.parse(this.#now()) - input.olderThanMs
    const destroyed: string[] = []
    for (const handle of await this.#provider.list()) {
      const status = await this.#provider.status(handle.sandboxId)
      if (
        Date.parse(handle.createdAt) <= threshold &&
        !['running', 'destroyed'].includes(status.state)
      ) {
        await this.#provider.destroy(handle.sandboxId, 'abandoned')
        destroyed.push(handle.sandboxId)
      }
    }
    return destroyed.toSorted()
  }

  #record(sandboxId: string): SandboxRecord {
    const record = this.#records.get(sandboxId)
    if (!record) throw new SandboxError('SANDBOX_NOT_FOUND')
    return record
  }
}

export interface E2bClientPort {
  create(input: {
    readonly template: string
    readonly timeoutMs: number
    readonly cpuCount: number
    readonly memoryMb: number
    readonly storageMb: number
    readonly network: z.output<typeof SandboxNetworkPolicySchema>
    readonly metadata: {
      readonly workspaceId: string
      readonly executionId: string
      readonly attemptId: string
    }
  }): Promise<{ readonly id: string; readonly createdAt: string; readonly expiresAt: string }>
  execute(
    sandboxId: string,
    input: {
      readonly command: readonly string[]
      readonly environment: Readonly<Record<string, string>>
      readonly timeoutMs: number
    }
  ): Promise<SandboxExecutionResult>
  upload(sandboxId: string, path: string, content: Uint8Array): Promise<void>
  download(sandboxId: string, path: string): Promise<Uint8Array>
  status(sandboxId: string): Promise<SandboxStatus>
  destroy(sandboxId: string): Promise<void>
  list(): Promise<
    readonly {
      readonly id: string
      readonly createdAt: string
      readonly expiresAt: string
      readonly metadata: {
        readonly workspaceId: string
        readonly executionId: string
        readonly attemptId: string
      }
    }[]
  >
}

export class E2bSandboxAdapter implements SandboxProvider {
  readonly #client: E2bClientPort
  readonly #resolveCredential: (leaseId: string) => Promise<string | undefined>

  constructor(options: {
    readonly client: E2bClientPort
    readonly resolveCredential: (leaseId: string) => Promise<string | undefined>
  }) {
    this.#client = options.client
    this.#resolveCredential = options.resolveCredential
  }

  async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
    const created = await this.#client.create({
      template: request.policy.template,
      timeoutMs: request.policy.timeoutMs,
      cpuCount: request.policy.limits.cpuCount,
      memoryMb: request.policy.limits.memoryMb,
      storageMb: request.policy.limits.storageMb,
      network: request.policy.network,
      metadata: {
        workspaceId: request.workspaceId,
        executionId: request.executionId,
        attemptId: request.attemptId,
      },
    })
    const handle = SandboxHandleSchema.parse({
      sandboxId: created.id,
      providerRef: 'e2b',
      workspaceId: request.workspaceId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    })
    return handle
  }

  async execute(request: SandboxExecuteRequest): Promise<SandboxExecutionResult> {
    const environment = { ...request.environment }
    for (const binding of request.credentialBindings ?? []) {
      const secret = await this.#resolveCredential(binding.leaseId)
      if (secret === undefined) throw new SandboxError('CREDENTIAL_UNAVAILABLE')
      environment[binding.environmentName] = secret
    }
    return this.#client.execute(request.sandboxId, {
      command: request.command,
      environment,
      timeoutMs: request.timeoutMs,
    })
  }

  upload(sandboxId: string, path: string, content: Uint8Array): Promise<void> {
    return this.#client.upload(sandboxId, path, content)
  }

  download(sandboxId: string, path: string): Promise<Uint8Array> {
    return this.#client.download(sandboxId, path)
  }

  status(sandboxId: string): Promise<SandboxStatus> {
    return this.#client.status(sandboxId)
  }

  async destroy(sandboxId: string): Promise<void> {
    await this.#client.destroy(sandboxId)
  }

  async list(): Promise<readonly SandboxHandle[]> {
    return (await this.#client.list()).map((sandbox) =>
      SandboxHandleSchema.parse({
        sandboxId: sandbox.id,
        providerRef: 'e2b',
        ...sandbox.metadata,
        createdAt: sandbox.createdAt,
        expiresAt: sandbox.expiresAt,
      })
    )
  }
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly providerRef: string
  readonly #now: () => string
  readonly #handles = new Map<string, SandboxHandle>()
  readonly #states = new Map<string, SandboxStatus['state']>()
  readonly #files = new Map<string, Uint8Array>()
  readonly executions: SandboxExecuteRequest[] = []
  readonly destroyed: { sandboxId: string; reason: string }[] = []
  nextExecution: 'success' | 'timeout' | 'failure' | 'cancelled' = 'success'
  #sequence = 0

  constructor(input: string | { readonly now?: () => string } = 'fake') {
    this.providerRef = typeof input === 'string' ? input : 'fake'
    this.#now =
      typeof input === 'string'
        ? () => new Date().toISOString()
        : (input.now ?? (() => new Date().toISOString()))
  }

  async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
    this.#sequence += 1
    const suffix = this.#sequence.toString(32).padStart(26, '0').toUpperCase()
    const createdAt = this.#now()
    const handle = SandboxHandleSchema.parse({
      sandboxId: `sbx_${suffix}`,
      providerRef: this.providerRef,
      workspaceId: request.workspaceId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + request.policy.timeoutMs).toISOString(),
    })
    this.#handles.set(handle.sandboxId, handle)
    this.#states.set(handle.sandboxId, 'ready')
    return handle
  }

  async execute(request: SandboxExecuteRequest): Promise<SandboxExecutionResult> {
    this.executions.push(structuredClone(request))
    if (this.nextExecution === 'timeout') throw new SandboxError('TIMEOUT', true)
    if (this.nextExecution === 'cancelled') throw new SandboxError('CANCELLED')
    if (this.nextExecution === 'failure') throw new SandboxError('PROVIDER_FAILED', true)
    return {
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      durationMs: 1,
      truncated: false,
    }
  }

  async upload(sandboxId: string, path: string, content: Uint8Array): Promise<void> {
    this.#require(sandboxId)
    this.#files.set(`${sandboxId}:${path}`, content.slice())
  }

  async download(sandboxId: string, path: string): Promise<Uint8Array> {
    this.#require(sandboxId)
    const content = this.#files.get(`${sandboxId}:${path}`)
    if (!content) throw new SandboxError('SANDBOX_NOT_FOUND')
    return content.slice()
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    this.#require(sandboxId)
    return SandboxStatusSchema.parse({
      sandboxId,
      state: this.#states.get(sandboxId),
      observedAt: this.#now(),
    })
  }

  async destroy(sandboxId: string, reason: string): Promise<void> {
    this.#require(sandboxId)
    if (this.#states.get(sandboxId) === 'destroyed') return
    this.#states.set(sandboxId, 'destroyed')
    this.destroyed.push({ sandboxId, reason })
  }

  async list(): Promise<readonly SandboxHandle[]> {
    return [...this.#handles.values()].map((handle) => structuredClone(handle))
  }

  #require(sandboxId: string): void {
    if (!this.#handles.has(sandboxId)) throw new SandboxError('SANDBOX_NOT_FOUND')
  }
}

export class FakeArtifactPromoter implements ArtifactPromoter {
  authorized = false

  async promote(input: { readonly content: Uint8Array }): Promise<{
    readonly artifactId: string
    readonly locator: string
    readonly digest: string
    readonly sizeBytes: number
  }> {
    if (!this.authorized) throw new Error('DENIED')
    return {
      artifactId: 'art_01JABCDEF0123456789ABCDEFG',
      locator: 'artifact://sandbox/report',
      digest: `sha256:${'a'.repeat(64)}`,
      sizeBytes: input.content.byteLength,
    }
  }
}

export class FakeE2bClient implements E2bClientPort {
  readonly created: Parameters<E2bClientPort['create']>[0][] = []
  readonly commands: { sandboxId: string; environment: Readonly<Record<string, string>> }[] = []
  readonly #files = new Map<string, Uint8Array>()
  readonly #states = new Map<string, SandboxStatus['state']>()
  readonly #instances = new Map<string, Awaited<ReturnType<E2bClientPort['list']>>[number]>()

  async create(input: Parameters<E2bClientPort['create']>[0]) {
    this.created.push(structuredClone(input))
    const id = 'sbx_01JABCDEF0123456789ABCDEFG'
    this.#states.set(id, 'ready')
    const created = {
      id,
      createdAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T12:00:10.000Z',
    }
    this.#instances.set(id, { ...created, metadata: structuredClone(input.metadata) })
    return created
  }

  async execute(
    sandboxId: string,
    input: Parameters<E2bClientPort['execute']>[1]
  ): Promise<SandboxExecutionResult> {
    this.commands.push({ sandboxId, environment: structuredClone(input.environment) })
    return {
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      durationMs: 1,
      truncated: false,
    }
  }

  async upload(sandboxId: string, path: string, content: Uint8Array): Promise<void> {
    this.#files.set(`${sandboxId}:${path}`, content.slice())
  }

  async download(sandboxId: string, path: string): Promise<Uint8Array> {
    return this.#files.get(`${sandboxId}:${path}`)?.slice() ?? new Uint8Array()
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    return SandboxStatusSchema.parse({
      sandboxId,
      state: this.#states.get(sandboxId) ?? 'destroyed',
      observedAt: '2026-08-25T12:00:00.000Z',
    })
  }

  async destroy(sandboxId: string): Promise<void> {
    this.#states.set(sandboxId, 'destroyed')
  }

  async list(): Promise<Awaited<ReturnType<E2bClientPort['list']>>> {
    return [...this.#instances.values()].map((instance) => structuredClone(instance))
  }
}

function enforceExecutionPolicy(
  request: SandboxExecuteRequest,
  policy: z.output<typeof SandboxResourcePolicySchema>
): void {
  if (
    Object.keys(request.environment).some((name) =>
      /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|KEY)/.test(name)
    )
  ) {
    throw new SandboxError('POLICY_DENIED')
  }
  const hosts = request.command.flatMap((argument) => {
    try {
      const url = new URL(argument)
      return ['http:', 'https:'].includes(url.protocol) ? [url.hostname.toLowerCase()] : []
    } catch {
      return []
    }
  })
  for (const host of hosts) {
    if (isMetadataHost(host)) throw new SandboxError('POLICY_DENIED')
    if (policy.network.mode === 'deny_all' || !policy.network.allowedHosts.includes(host)) {
      throw new SandboxError('POLICY_DENIED')
    }
  }
}

function isMetadataHost(host: string): boolean {
  return ['169.254.169.254', 'metadata.google.internal', 'metadata.azure.internal'].includes(host)
}

function boundOutput(result: SandboxExecutionResult, limit: number): SandboxExecutionResult {
  const stdout = result.stdout.slice(0, limit)
  const remaining = Math.max(0, limit - Buffer.byteLength(stdout))
  const stderr = result.stderr.slice(0, remaining)
  return {
    ...result,
    stdout,
    stderr,
    truncated:
      result.truncated ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > limit,
  }
}

function normalizeProviderError(error: unknown): SandboxError {
  if (error instanceof SandboxError) return error
  return new SandboxError('PROVIDER_FAILED', true)
}

function reasonFor(error: SandboxError): string {
  if (error.code === 'TIMEOUT') return 'timeout'
  if (error.code === 'CANCELLED') return 'cancelled'
  return 'failure'
}
