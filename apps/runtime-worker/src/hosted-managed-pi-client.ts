import {
  ManagedPiInspectionSchema,
  type ManagedPiClient,
  type ManagedPiConfiguration,
  type ManagedPiEvent,
  type ManagedPiInspection,
  type ManagedPiStartCommand,
  type ManagedPiStatus,
} from '@control-plane/managed-pi-adapter'
import {
  RuntimeAdapterError,
  RuntimeExecutionHandleSchema,
  RuntimeSessionOperationSchema,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeInputRequest,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
} from '@control-plane/runtime-sdk'
import {
  HostedAuthoritySchema,
  HostedManagedPiLaunchRequestSchema,
  HostedRuntimeHostInspectionSchema,
  type HostedManagedPiAuthority,
  type RuntimeHostProvider,
} from './hosted-managed-pi-schemas.js'
import { canonicalJson, unavailableHost } from './hosted-managed-pi-protocol.js'

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
