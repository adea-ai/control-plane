import { createHash } from 'node:crypto'
import {
  ManagedPiConfigurationSchema,
  ManagedPiEventSchema,
  ManagedPiInspectionSchema,
  ManagedPiStatusSchema,
  type ManagedPiClient,
  type ManagedPiConfiguration,
  type ManagedPiEvent,
  type ManagedPiInspection,
  type ManagedPiStartCommand,
  type ManagedPiStatus,
} from '@control-plane/managed-pi-adapter'
import {
  ObjectStoreError,
  type ObjectStore,
  type StoredObjectDescriptor,
} from '@control-plane/object-store'
import {
  GatewayCommandEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  type GatewayCommandEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import {
  RuntimeAdapterError,
  RuntimeApprovalRequestSchema,
  RuntimeArtifactReferenceSchema,
  RuntimeCancelRequestSchema,
  RuntimeCapabilitySchema,
  RuntimeConnectionSchema,
  RuntimeExecutionHandleSchema,
  RuntimeInputRequestSchema,
  RuntimeSessionOperationSchema,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeInputRequest,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const SemanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const AuthorityReferenceSchema = z
  .string()
  .min(12)
  .max(256)
  .regex(/^authz:[A-Za-z0-9._:-]+$/)
const HostedAuthoritySchema = z
  .object({
    modelGrantRefs: z
      .array(AuthorityReferenceSchema)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
    toolGrantRefs: z
      .array(AuthorityReferenceSchema)
      .max(128)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
const HostedSandboxSchema = ManagedPiConfigurationSchema.shape.limits.shape.sandbox

export const HostedRuntimeHostInspectionSchema = z
  .object({
    providerFamily: z.string().regex(/^[a-z][a-z0-9-]*$/),
    driverVersion: SemanticVersionSchema,
    harnessVersion: SemanticVersionSchema,
    health: z.enum(['healthy', 'degraded', 'unavailable']),
    capabilities: z
      .array(RuntimeCapabilitySchema)
      .max(64)
      .refine(
        (values) => new Set(values.map(({ name }) => name)).size === values.length,
        'Hosted capability identities must be unique'
      ),
    limitations: z.array(z.string().min(1).max(512)).max(64),
    capacity: z
      .object({
        maximumConcurrent: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        queued: z.number().int().nonnegative(),
      })
      .strict(),
    limits: z
      .object({
        maximumDurationMs: z.number().int().positive(),
        sandbox: HostedSandboxSchema,
      })
      .strict(),
    observedAt: TimestampSchema,
  })
  .strict()
  .refine(
    ({ capacity }) => capacity.active <= capacity.maximumConcurrent,
    'Active hosted work cannot exceed advertised capacity'
  )

export const HostedManagedPiLaunchRequestSchema = z
  .object({
    attemptId: z.string().regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/),
    idempotencyKey: z.string().min(1).max(256),
    configuration: ManagedPiConfigurationSchema,
    authority: HostedAuthoritySchema,
    sandbox: HostedSandboxSchema,
    maximumDurationMs: z.number().int().positive(),
    deadlineAt: TimestampSchema,
  })
  .strict()

export type HostedRuntimeHostInspection = z.output<typeof HostedRuntimeHostInspectionSchema>
export type HostedManagedPiLaunchRequest = z.output<typeof HostedManagedPiLaunchRequestSchema>
export type HostedManagedPiAuthority = z.output<typeof HostedAuthoritySchema>

export interface HostedArtifactStore {
  persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly value: z.util.JSONType
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>>
}

export interface HostedManagedPiTerminalBridgeOptions {
  readonly artifactStore: HostedArtifactStore
}

export class HostedManagedPiTerminalBridge {
  readonly #artifactStore: HostedArtifactStore

  constructor(options: HostedManagedPiTerminalBridgeOptions) {
    this.#artifactStore = options.artifactStore
  }

  async result(input: {
    readonly command: GatewayCommandEnvelope
    readonly status: ManagedPiStatus
    readonly sequence: number
  }): Promise<GatewayResultEnvelope | undefined> {
    const command = GatewayCommandEnvelopeSchema.parse(input.command)
    const status = ManagedPiStatusSchema.parse(input.status)
    const sequence = z.number().int().nonnegative().max(2_147_483_647).parse(input.sequence)
    const attemptId = z
      .string()
      .regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/)
      .parse(command.attemptId)
    if (sequence <= command.sequence) throw new Error('HOSTED_GATEWAY_SEQUENCE_STALE')

    if (
      status.state === 'queued' ||
      status.state === 'running' ||
      status.state === 'waiting_input' ||
      status.state === 'stopping' ||
      status.state === 'unknown'
    ) {
      return undefined
    }

    const common = {
      type: 'result' as const,
      schemaVersion: 1 as const,
      protocolVersion: command.protocolVersion,
      sequence,
      nodeId: command.nodeId,
      workspaceId: command.workspaceId,
      traceId: command.traceId,
      sentAt: status.observedAt,
      channelGeneration: command.channelGeneration,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      completedAt: status.observedAt,
    }
    if (status.state === 'succeeded') {
      const artifact = await this.#artifactStore.persist({
        attemptId,
        mediaType: 'application/json',
        value: z.json().parse(status.result),
      })
      return GatewayResultEnvelopeSchema.parse({
        ...common,
        status: 'succeeded',
        result: {
          artifact: {
            artifactId: artifact.artifactId,
            digest: artifact.digest,
            mediaType: artifact.mediaType,
            sizeBytes: artifact.sizeBytes,
          },
        },
      })
    }
    if (status.state === 'cancelled') {
      return GatewayResultEnvelopeSchema.parse({
        ...common,
        status: 'cancelled',
        result: { data: {} },
      })
    }
    return GatewayResultEnvelopeSchema.parse({
      ...common,
      status: 'failed',
      result: { data: { error: status.error } },
    })
  }
}

export interface RuntimeHostProvider {
  inspect(): Promise<HostedRuntimeHostInspection>
  /** Read an admitted launch without launching work or renewing its authority/deadline.
   * Production providers must retain this receipt across worker restarts.
   */
  getLaunch(idempotencyKey: string): Promise<
    | {
        readonly request: HostedManagedPiLaunchRequest
        readonly handle: RuntimeExecutionHandle
      }
    | undefined
  >
  launch(request: HostedManagedPiLaunchRequest): Promise<RuntimeExecutionHandle>
  progress(
    handle: RuntimeExecutionHandle,
    afterSequence?: number,
    signal?: AbortSignal
  ): AsyncIterable<ManagedPiEvent>
  status(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus>
  reconcile(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus>
  submitInput(
    handle: RuntimeExecutionHandle,
    request: RuntimeInputRequest
  ): Promise<ManagedPiStatus>
  submitApproval(
    handle: RuntimeExecutionHandle,
    request: RuntimeApprovalRequest
  ): Promise<ManagedPiStatus>
  cancel(handle: RuntimeExecutionHandle, request: RuntimeCancelRequest): Promise<ManagedPiStatus>
  cleanup(handle: RuntimeExecutionHandle): Promise<void>
  close(): Promise<void>
}

export interface HostedManagedPiClientOptions {
  readonly host: RuntimeHostProvider
  readonly resolveAuthority: (
    configuration: ManagedPiConfiguration
  ) => HostedManagedPiAuthority | Promise<HostedManagedPiAuthority>
  readonly now?: () => Date
}

export class HostedManagedPiClient implements ManagedPiClient {
  readonly #host: RuntimeHostProvider
  readonly #resolveAuthority: HostedManagedPiClientOptions['resolveAuthority']
  readonly #now: () => Date

  constructor(options: HostedManagedPiClientOptions) {
    this.#host = options.host
    this.#resolveAuthority = options.resolveAuthority
    this.#now = options.now ?? (() => new Date())
  }

  async inspect(): Promise<ManagedPiInspection> {
    const host = HostedRuntimeHostInspectionSchema.parse(await this.#host.inspect())
    return ManagedPiInspectionSchema.parse({
      driverVersion: host.driverVersion,
      runtimeVersion: host.harnessVersion,
      protocolVersion: '1.0.0',
      health: host.health,
      capabilities: host.capabilities,
      limitations: host.limitations,
      observedAt: host.observedAt,
    })
  }

  async start(command: ManagedPiStartCommand): Promise<RuntimeExecutionHandle> {
    const input = HostedManagedPiLaunchRequestSchema.pick({
      attemptId: true,
      idempotencyKey: true,
      configuration: true,
    }).parse(command)
    const { configuration } = input
    const admitted = await this.#admittedHandle(input)
    if (admitted) return admitted
    const inspection = HostedRuntimeHostInspectionSchema.parse(await this.#host.inspect())
    if (inspection.health === 'unavailable' || inspection.capacity.maximumConcurrent === 0) {
      throw unavailableHost()
    }
    if (inspection.capacity.active >= inspection.capacity.maximumConcurrent) {
      throw new RuntimeAdapterError({
        code: 'HOSTED_PI_CAPACITY_UNAVAILABLE',
        classification: 'unavailable',
        message: 'Hosted managed Pi capacity is temporarily unavailable',
        retryable: true,
      })
    }
    if (
      configuration.limits.duration.maximumMs > inspection.limits.maximumDurationMs ||
      configuration.limits.sandbox.cpuMillicores > inspection.limits.sandbox.cpuMillicores ||
      configuration.limits.sandbox.memoryMebibytes > inspection.limits.sandbox.memoryMebibytes ||
      configuration.limits.sandbox.storageMebibytes > inspection.limits.sandbox.storageMebibytes
    ) {
      throw new RuntimeAdapterError({
        code: 'HOSTED_PI_RESOURCE_LIMIT_UNSUPPORTED',
        classification: 'unsupported',
        message: 'Execution plan exceeds hosted managed Pi resource limits',
        retryable: false,
      })
    }
    const authority = HostedAuthoritySchema.parse(await this.#resolveAuthority(configuration))
    const issuedAt = this.#now()
    const request = HostedManagedPiLaunchRequestSchema.parse({
      attemptId: input.attemptId,
      idempotencyKey: input.idempotencyKey,
      configuration,
      authority,
      sandbox: configuration.limits.sandbox,
      maximumDurationMs: configuration.limits.duration.maximumMs,
      deadlineAt: new Date(
        issuedAt.getTime() + configuration.limits.duration.maximumMs
      ).toISOString(),
    })
    try {
      return RuntimeExecutionHandleSchema.parse(await this.#host.launch(request))
    } catch (error) {
      if (error instanceof RuntimeAdapterError && error.code === 'HOSTED_PI_IDEMPOTENCY_CONFLICT') {
        // Another client may have admitted this command after our initial lookup,
        // with its own deadline/authority. Only the original command may replay it.
        const concurrentAdmission = await this.#admittedHandle(input)
        if (concurrentAdmission) return concurrentAdmission
      }
      throw error
    }
  }

  async #admittedHandle(input: ManagedPiStartCommand): Promise<RuntimeExecutionHandle | undefined> {
    const admitted = await this.#host.getLaunch(input.idempotencyKey)
    if (!admitted) return undefined
    const request = HostedManagedPiLaunchRequestSchema.parse(admitted.request)
    const handle = RuntimeExecutionHandleSchema.parse(admitted.handle)
    if (
      request.idempotencyKey !== input.idempotencyKey ||
      request.attemptId !== input.attemptId ||
      handle.attemptId !== input.attemptId ||
      canonicalJson(request.configuration) !== canonicalJson(input.configuration)
    ) {
      throw new RuntimeAdapterError({
        code: 'HOSTED_PI_IDEMPOTENCY_CONFLICT',
        classification: 'conflict',
        message: 'Hosted managed Pi launch idempotency key was reused',
        retryable: false,
      })
    }
    return handle
  }

  progress(
    handle: RuntimeExecutionHandle,
    afterSequence = 0,
    signal?: AbortSignal
  ): AsyncIterable<ManagedPiEvent> {
    return this.#host.progress(RuntimeExecutionHandleSchema.parse(handle), afterSequence, signal)
  }

  submitInput(
    handle: RuntimeExecutionHandle,
    request: RuntimeInputRequest
  ): Promise<ManagedPiStatus> {
    return this.#host.submitInput(RuntimeExecutionHandleSchema.parse(handle), request)
  }

  submitApproval(
    handle: RuntimeExecutionHandle,
    request: RuntimeApprovalRequest
  ): Promise<ManagedPiStatus> {
    return this.#host.submitApproval(RuntimeExecutionHandleSchema.parse(handle), request)
  }

  cancel(handle: RuntimeExecutionHandle, request: RuntimeCancelRequest): Promise<ManagedPiStatus> {
    return this.#host.cancel(RuntimeExecutionHandleSchema.parse(handle), request)
  }

  status(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus> {
    return this.#host.status(RuntimeExecutionHandleSchema.parse(handle))
  }

  reconcile(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus> {
    return this.#host.reconcile(RuntimeExecutionHandleSchema.parse(handle))
  }

  async session(operation: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    RuntimeSessionOperationSchema.parse(operation)
    throw new RuntimeAdapterError({
      code: 'CAPABILITY_UNSUPPORTED',
      classification: 'unsupported',
      message: 'Hosted managed Pi sessions are not supported by this adapter version',
      retryable: false,
    })
  }

  cleanup(handle: RuntimeExecutionHandle): Promise<void> {
    return this.#host.cleanup(RuntimeExecutionHandleSchema.parse(handle))
  }
}

export class InMemoryHostedArtifactStore implements HostedArtifactStore {
  readonly #now: () => string
  readonly #records: Array<{
    readonly attemptId: string
    readonly createdAt: string
    readonly reference: z.output<typeof RuntimeArtifactReferenceSchema>
  }> = []

  constructor(options: { readonly now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly value: z.util.JSONType
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>> {
    const content = JSON.stringify(input.value)
    const index = this.#records.length
    const suffix = `${(index + 1).toString(32).toUpperCase()}`.padStart(26, '0')
    const reference = RuntimeArtifactReferenceSchema.parse({
      artifactId: `art_${suffix}`,
      version: 1,
      mediaType: input.mediaType,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      sizeBytes: Buffer.byteLength(content),
      locator: 'artifact://hosted-managed-pi/result',
    })
    this.#records.push({ attemptId: input.attemptId, createdAt: this.#now(), reference })
    return structuredClone(reference)
  }

  references(): Array<z.output<typeof RuntimeArtifactReferenceSchema>> {
    return this.#records.map(({ reference }) => structuredClone(reference))
  }
}

export class ObjectStoreHostedArtifactStore implements HostedArtifactStore {
  readonly #objectStore: ObjectStore
  readonly #pending = new Map<
    string,
    {
      readonly fingerprint: string
      readonly result: Promise<z.output<typeof RuntimeArtifactReferenceSchema>>
    }
  >()

  constructor(objectStore: ObjectStore) {
    this.#objectStore = objectStore
  }

  persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly value: z.util.JSONType
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>> {
    const attemptId = z
      .string()
      .regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/)
      .parse(input.attemptId)
    const mediaType = z.string().min(1).max(255).parse(input.mediaType)
    const body = new TextEncoder().encode(canonicalJson(z.json().parse(input.value)))
    const fingerprint = createHash('sha256')
      .update(mediaType)
      .update('\0')
      .update(body)
      .digest('hex')
    const current = this.#pending.get(attemptId)
    if (current !== undefined) {
      if (current.fingerprint !== fingerprint) return Promise.reject(artifactConflict())
      return current.result
    }
    const result = this.#persist({ attemptId, mediaType, body })
    this.#pending.set(attemptId, { fingerprint, result })
    return result.catch((error: unknown) => {
      this.#pending.delete(attemptId)
      throw error
    })
  }

  async #persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly body: Uint8Array
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>> {
    const key = `runtime-results/${input.attemptId}/result.json`
    const expectedDigest = `sha256:${createHash('sha256').update(input.body).digest('hex')}`
    let existing: StoredObjectDescriptor | undefined
    try {
      existing = await this.#objectStore.head(key)
    } catch (error) {
      if (!(error instanceof ObjectStoreError) || error.code !== 'OBJECT_STORE_NOT_FOUND') {
        throw error
      }
    }
    if (existing !== undefined) {
      if (
        existing.sha256 !== expectedDigest ||
        existing.size !== input.body.byteLength ||
        existing.contentType !== input.mediaType
      ) {
        throw artifactConflict()
      }
      return artifactReference(input.attemptId, existing)
    }
    const stored = await this.#objectStore.put({
      key,
      body: input.body,
      contentType: input.mediaType,
      metadata: { attempt: input.attemptId },
    })
    if (stored.sha256 !== expectedDigest || stored.size !== input.body.byteLength) {
      throw new Error('HOSTED_ARTIFACT_INTEGRITY_FAILURE')
    }
    return artifactReference(input.attemptId, stored)
  }
}

export type ReferenceHostedManagedPiScenario = 'complete' | 'running' | 'crash'

interface HostedExecution {
  readonly handle: RuntimeExecutionHandle
  readonly events: ManagedPiEvent[]
  status: ManagedPiStatus
}

export interface ReferenceRuntimeHostProviderOptions {
  readonly artifactStore: HostedArtifactStore
  readonly now?: () => string
  readonly scenario?: ReferenceHostedManagedPiScenario
  readonly maximumConcurrent?: number
}

export class ReferenceRuntimeHostProvider implements RuntimeHostProvider {
  readonly #artifactStore: HostedArtifactStore
  readonly #now: () => string
  readonly #scenario: ReferenceHostedManagedPiScenario
  readonly #maximumConcurrent: number
  readonly #executions = new Map<string, HostedExecution>()
  readonly #launchByIdempotencyKey = new Map<
    string,
    {
      readonly fingerprint: string
      readonly handle: RuntimeExecutionHandle
      readonly request: HostedManagedPiLaunchRequest
    }
  >()
  readonly #launches: HostedManagedPiLaunchRequest[] = []
  readonly #pendingLaunches = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<RuntimeExecutionHandle> }
  >()
  readonly #effects = new Map<string, number>()
  readonly #cleaned = new Set<string>()
  #health: HostedRuntimeHostInspection['health'] = 'healthy'
  #queued = 0

  constructor(options: ReferenceRuntimeHostProviderOptions) {
    this.#artifactStore = options.artifactStore
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#scenario = options.scenario ?? 'complete'
    this.#maximumConcurrent = options.maximumConcurrent ?? 1
  }

  async inspect(): Promise<HostedRuntimeHostInspection> {
    return HostedRuntimeHostInspectionSchema.parse({
      providerFamily: 'reference-sandbox',
      driverVersion: '1.0.0',
      harnessVersion: '0.52.1',
      health: this.#health,
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'stream.events', support: 'supported' },
        { name: 'tool.call', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
        { name: 'interaction.user-input', support: 'supported' },
        { name: 'interaction.approval', support: 'supported' },
      ],
      limitations: [],
      capacity: {
        maximumConcurrent: this.#maximumConcurrent,
        active: [...this.#executions.values()].filter(
          ({ handle, status }) =>
            !this.#cleaned.has(handle.handleId) &&
            ['queued', 'running', 'waiting_input', 'stopping'].includes(status.state)
        ).length,
        queued: this.#queued,
      },
      limits: {
        maximumDurationMs: 3_600_000,
        sandbox: {
          cpuMillicores: 8_000,
          memoryMebibytes: 16_384,
          storageMebibytes: 32_768,
        },
      },
      observedAt: this.#now(),
    })
  }

  async getLaunch(idempotencyKey: string) {
    await this.#pendingLaunches.get(idempotencyKey)?.result
    const receipt = this.#launchByIdempotencyKey.get(idempotencyKey)
    return receipt
      ? structuredClone({ request: receipt.request, handle: receipt.handle })
      : undefined
  }

  async launch(requestInput: HostedManagedPiLaunchRequest): Promise<RuntimeExecutionHandle> {
    if (this.#health === 'unavailable') throw unavailableHost()
    const request = HostedManagedPiLaunchRequestSchema.parse(requestInput)
    const fingerprint = stable(request)
    const pending = this.#pendingLaunches.get(request.idempotencyKey)
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new RuntimeAdapterError({
          code: 'HOSTED_PI_IDEMPOTENCY_CONFLICT',
          classification: 'conflict',
          message: 'Hosted managed Pi launch idempotency key was reused',
          retryable: false,
        })
      }
      return structuredClone(await pending.result)
    }
    const replay = this.#launchByIdempotencyKey.get(request.idempotencyKey)
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new RuntimeAdapterError({
          code: 'HOSTED_PI_IDEMPOTENCY_CONFLICT',
          classification: 'conflict',
          message: 'Hosted managed Pi launch idempotency key was reused',
          retryable: false,
        })
      }
      return structuredClone(replay.handle)
    }
    const result = this.#admit(request, fingerprint)
    this.#pendingLaunches.set(request.idempotencyKey, { fingerprint, result })
    // Keep rejected admissions fenced: a thrown allocation is not proof of no effect.
    const handle = await result
    this.#pendingLaunches.delete(request.idempotencyKey)
    return structuredClone(handle)
  }

  async #admit(request: HostedManagedPiLaunchRequest, fingerprint: string) {
    const handle = RuntimeExecutionHandleSchema.parse({
      handleId: `hosted-managed-pi:${request.attemptId}`,
      attemptId: request.attemptId,
      startedAt: this.#now(),
    })
    const execution = await this.#createExecution(handle, request.attemptId)
    this.#executions.set(handle.handleId, execution)
    this.#launchByIdempotencyKey.set(request.idempotencyKey, { fingerprint, handle, request })
    this.#launches.push(structuredClone(request))
    this.#effects.set(request.attemptId, (this.#effects.get(request.attemptId) ?? 0) + 1)
    return structuredClone(handle)
  }

  async *progress(
    handleInput: RuntimeExecutionHandle,
    afterSequence = 0,
    signal?: AbortSignal
  ): AsyncIterable<ManagedPiEvent> {
    const execution = this.#execution(handleInput)
    for (const event of execution.events) {
      if (signal?.aborted) return
      if (event.sequence > afterSequence) yield structuredClone(event)
    }
  }

  async status(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus> {
    return structuredClone(this.#execution(handle).status)
  }

  reconcile(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus> {
    return this.status(handle)
  }

  async submitInput(
    handle: RuntimeExecutionHandle,
    request: RuntimeInputRequest
  ): Promise<ManagedPiStatus> {
    RuntimeInputRequestSchema.parse(request)
    const execution = this.#execution(handle)
    if (execution.status.state === 'waiting_input') {
      execution.status = { state: 'running', observedAt: this.#now() }
    }
    return structuredClone(execution.status)
  }

  async submitApproval(
    handle: RuntimeExecutionHandle,
    request: RuntimeApprovalRequest
  ): Promise<ManagedPiStatus> {
    RuntimeApprovalRequestSchema.parse(request)
    return this.submitInput(handle, {
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'reference-hosted-approval',
      text: 'approved',
    })
  }

  async cancel(
    handle: RuntimeExecutionHandle,
    request: RuntimeCancelRequest
  ): Promise<ManagedPiStatus> {
    RuntimeCancelRequestSchema.parse(request)
    const execution = this.#execution(handle)
    execution.status = { state: 'cancelled', observedAt: request.requestedAt }
    return structuredClone(execution.status)
  }

  async cleanup(handle: RuntimeExecutionHandle): Promise<void> {
    const execution = this.#execution(handle)
    this.#cleaned.add(execution.handle.handleId)
  }

  async close(): Promise<void> {
    this.#health = 'unavailable'
  }

  complete(handleId: string): ManagedPiStatus {
    const execution = this.#executions.get(handleId)
    if (!execution) throw new Error('HOSTED_PI_EXECUTION_MISSING')
    execution.status = {
      state: 'succeeded',
      observedAt: this.#now(),
      result: {
        output: { answer: 'hosted-managed-pi-complete' },
        usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
        artifacts: [],
      },
    }
    return structuredClone(execution.status)
  }

  setHealth(health: HostedRuntimeHostInspection['health']): void {
    this.#health = health
  }

  setQueued(queued: number): void {
    this.#queued = z.number().int().nonnegative().parse(queued)
  }

  launches(): HostedManagedPiLaunchRequest[] {
    return structuredClone(this.#launches)
  }

  effectCount(attemptId: string): number {
    return this.#effects.get(attemptId) ?? 0
  }

  cleanupCount(handleId: string): number {
    return this.#cleaned.has(handleId) ? 1 : 0
  }

  #execution(handleInput: RuntimeExecutionHandle): HostedExecution {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const execution = this.#executions.get(handle.handleId)
    if (!execution || execution.handle.attemptId !== handle.attemptId) {
      throw new RuntimeAdapterError({
        code: 'HOSTED_PI_EXECUTION_NOT_FOUND',
        classification: 'unavailable',
        message: 'Hosted managed Pi execution was not found',
        retryable: false,
      })
    }
    return execution
  }

  async #createExecution(
    handle: RuntimeExecutionHandle,
    attemptId: string
  ): Promise<HostedExecution> {
    if (this.#scenario === 'crash') {
      const error = {
        code: 'HOSTED_PI_WORKER_CRASHED',
        classification: 'infrastructure' as const,
        message: 'Hosted managed Pi worker crashed',
        retryable: true,
      }
      return {
        handle,
        events: [
          { sequence: 1, occurredAt: this.#now(), kind: 'status', state: 'running' },
          { sequence: 2, occurredAt: this.#now(), kind: 'error', error },
        ].map((event) => ManagedPiEventSchema.parse(event)),
        status: ManagedPiStatusSchema.parse({ state: 'errored', observedAt: this.#now(), error }),
      }
    }
    if (this.#scenario === 'running') {
      return {
        handle,
        events: [
          ManagedPiEventSchema.parse({
            sequence: 1,
            occurredAt: this.#now(),
            kind: 'status',
            state: 'running',
          }),
        ],
        status: ManagedPiStatusSchema.parse({ state: 'running', observedAt: this.#now() }),
      }
    }
    const artifact = await this.#artifactStore.persist({
      attemptId,
      mediaType: 'application/json',
      value: { answer: 'hosted-managed-pi-complete' },
    })
    const result = {
      output: { answer: 'hosted-managed-pi-complete' },
      usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
      artifacts: [artifact],
    }
    return {
      handle,
      events: [
        { sequence: 1, occurredAt: this.#now(), kind: 'status', state: 'running' },
        {
          sequence: 2,
          occurredAt: this.#now(),
          kind: 'output',
          text: 'hosted managed Pi running',
        },
        {
          sequence: 3,
          occurredAt: this.#now(),
          kind: 'usage',
          inputTokens: 12,
          outputTokens: 4,
          durationMs: 120,
        },
        { sequence: 4, occurredAt: this.#now(), kind: 'artifact', artifact },
        { sequence: 5, occurredAt: this.#now(), kind: 'status', state: 'succeeded' },
      ].map((event) => ManagedPiEventSchema.parse(event)),
      status: ManagedPiStatusSchema.parse({
        state: 'succeeded',
        observedAt: this.#now(),
        result,
      }),
    }
  }
}

export interface HostedManagedPiWorkerOptions {
  readonly host: RuntimeHostProvider
  readonly targetUtilizationPermille?: number
}

export class HostedManagedPiWorker {
  readonly #host: RuntimeHostProvider
  readonly #targetUtilizationPermille: number

  constructor(options: HostedManagedPiWorkerOptions) {
    this.#host = options.host
    this.#targetUtilizationPermille = z
      .number()
      .int()
      .min(100)
      .max(1_000)
      .parse(options.targetUtilizationPermille ?? 700)
  }

  async readiness(): Promise<{
    readonly ready: boolean
    readonly reason: 'READY' | 'HOST_DEGRADED' | 'HOST_UNAVAILABLE' | 'CAPACITY_UNAVAILABLE'
  }> {
    const host = HostedRuntimeHostInspectionSchema.parse(await this.#host.inspect())
    if (host.health === 'unavailable') return { ready: false, reason: 'HOST_UNAVAILABLE' }
    if (host.capacity.maximumConcurrent === 0) {
      return { ready: false, reason: 'CAPACITY_UNAVAILABLE' }
    }
    if (host.health === 'degraded') return { ready: true, reason: 'HOST_DEGRADED' }
    return { ready: true, reason: 'READY' }
  }

  async scaling(): Promise<{
    readonly currentCapacity: number
    readonly desiredCapacity: number
    readonly active: number
    readonly queued: number
  }> {
    const host = HostedRuntimeHostInspectionSchema.parse(await this.#host.inspect())
    const demand = host.capacity.active + host.capacity.queued
    const demandedCapacity = Math.ceil((demand * 1_000) / this.#targetUtilizationPermille)
    return {
      currentCapacity: host.capacity.maximumConcurrent,
      desiredCapacity: Math.max(host.capacity.maximumConcurrent, demandedCapacity),
      active: host.capacity.active,
      queued: host.capacity.queued,
    }
  }

  close(): Promise<void> {
    return this.#host.close()
  }
}

export function buildHostedManagedPiRuntimeConnection(input: {
  readonly runtimeConnectionId: string
  readonly runtimeDefinitionId: string
  readonly observedAt: string
  readonly host: HostedRuntimeHostInspection
}) {
  const host = HostedRuntimeHostInspectionSchema.parse(input.host)
  const unavailable = host.health === 'unavailable'
  const degraded = host.health === 'degraded'
  const expiresAt = new Date(Date.parse(input.observedAt) + 60_000).toISOString()
  const identityDigest = `sha256:${createHash('sha256')
    .update(`${input.runtimeDefinitionId}:managed-sandbox:${host.providerFamily}`)
    .digest('hex')}`
  return RuntimeConnectionSchema.parse({
    runtimeConnectionId: input.runtimeConnectionId,
    identityDigest,
    connectionType: 'managed_cloud',
    runtimeDefinitionId: input.runtimeDefinitionId,
    location: 'agent_hq_cloud',
    adapterVersion: '1.0.0',
    driverVersion: host.driverVersion,
    harnessVersion: host.harnessVersion,
    status: unavailable ? 'unavailable' : degraded ? 'degraded' : 'connected',
    health: host.health,
    capabilities: host.capabilities,
    compatibilityState: unavailable ? 'unavailable' : degraded ? 'degraded' : 'compatible',
    availabilityState: unavailable ? 'offline' : degraded ? 'degraded' : 'healthy',
    protocolVersion: '1.0.0',
    capabilitySnapshotVersion: 1,
    capabilitySnapshotObservedAt: input.observedAt,
    capabilitySnapshotExpiresAt: expiresAt,
    capabilityVerification: 'verified',
    lastHealthReportSequence: 1,
    lastHealthReportDigest: identityDigest,
    limitations: host.limitations,
    diagnostics: unavailable ? ['HOST_UNAVAILABLE'] : [],
    lastDiscoveredAt: input.observedAt,
    lastHeartbeatAt: input.observedAt,
    lastHealthCheckAt: input.observedAt,
    expiresAt,
    version: 1,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  })
}

function unavailableHost(): RuntimeAdapterError {
  return new RuntimeAdapterError({
    code: 'HOSTED_PI_HOST_UNAVAILABLE',
    classification: 'unavailable',
    message: 'Hosted managed Pi host is unavailable',
    retryable: true,
  })
}

function stable(value: unknown): string {
  return JSON.stringify(value)
}

function canonicalJson(value: z.util.JSONType): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: z.util.JSONType): z.util.JSONType {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)])
    )
  }
  return value
}

function artifactReference(
  attemptId: string,
  stored: StoredObjectDescriptor
): z.output<typeof RuntimeArtifactReferenceSchema> {
  return RuntimeArtifactReferenceSchema.parse({
    artifactId: `art_${attemptId.slice(4)}`,
    version: 1,
    mediaType: stored.contentType,
    digest: stored.sha256,
    sizeBytes: stored.size,
    locator: `artifact://${stored.key}`,
  })
}

function artifactConflict(): Error {
  return new Error('HOSTED_ARTIFACT_RESULT_CONFLICT')
}
