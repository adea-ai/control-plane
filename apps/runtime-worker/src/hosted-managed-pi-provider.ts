import {
  ManagedPiEventSchema,
  ManagedPiStatusSchema,
  type ManagedPiEvent,
  type ManagedPiStatus,
} from '@control-plane/managed-pi-adapter'
import {
  RuntimeAdapterError,
  RuntimeApprovalRequestSchema,
  RuntimeCancelRequestSchema,
  RuntimeExecutionHandleSchema,
  RuntimeInputRequestSchema,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeInputRequest,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  HostedManagedPiLaunchRequestSchema,
  HostedRuntimeHostInspectionSchema,
  type HostedArtifactStore,
  type HostedManagedPiLaunchRequest,
  type HostedRuntimeHostInspection,
  type RuntimeHostProvider,
} from './hosted-managed-pi-schemas.js'
import { stable, unavailableHost } from './hosted-managed-pi-protocol.js'

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
