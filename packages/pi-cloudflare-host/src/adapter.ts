import {
  RuntimeAdapterError,
  RuntimeAdapterInspectionSchema,
  RuntimeExecutionHandleSchema,
  RuntimeExecutionStatusSchema,
  RuntimeExecutionProgressSchema,
  RuntimeCancelRequestSchema,
  RuntimeStartRequestSchema,
  RuntimeSessionOperationSchema,
  inspectRuntimeCapabilities,
} from '@control-plane/runtime-sdk'
import type {
  RuntimeAdapter,
  RuntimeAdapterInspection,
  RuntimeExecutionHandle,
  RuntimeExecutionStatus,
  RuntimeExecutionProgress,
  RuntimeStartRequest,
  RuntimeInputRequest,
  RuntimeApprovalRequest,
  RuntimeCancelRequest,
  RuntimeSessionOperation,
  RuntimeSessionResult,
  RuntimeProgressOptions,
  CapabilityRequirement,
} from '@control-plane/runtime-sdk'
import type { CloudflareTaskRecord } from './owner.js'
import { stableJson } from './owner.js'

/** Trusted in-process owner port; not caller-supplied HTTP authority or a Worker route. */
export interface CloudflareRuntimeOwner {
  session?(operation: RuntimeSessionOperation): Promise<RuntimeSessionResult>
  accept(request: RuntimeStartRequest): Promise<CloudflareTaskRecord>
  read(attemptId: string): Promise<CloudflareTaskRecord>
  timedEvents(
    attemptId: string,
    afterSequence?: number
  ): Promise<
    readonly {
      sequence: number
      state: string
      occurredAt: number
    }[]
  >
  cancel(attemptId: string, request?: RuntimeCancelRequest): Promise<CloudflareTaskRecord>
  reconcile(attemptId: string): Promise<CloudflareTaskRecord>
}

/** Partial, unregistered adapter. Operations and capability eligibility remain separate. */
export class CloudflarePiRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly owner: CloudflareRuntimeOwner,
    private readonly now: () => number = Date.now
  ) {}

  async inspect(
    requirements: readonly CapabilityRequirement[] = []
  ): Promise<RuntimeAdapterInspection> {
    return RuntimeAdapterInspectionSchema.parse({
      metadata: {
        contractVersion: { major: 1, minor: 0 },
        adapterName: 'pi-cloudflare',
        adapterVersion: '0.1.0',
        runtimeFamily: 'pi-durable',
        driverVersion: '1.1.0',
        harnessVersion: '1.1.0',
        transportKind: 'direct-local',
      },
      health: 'degraded',
      capabilities: [],
      limitations: [
        'Internal Cloudflare owner composition only; no deployment profile or capabilities advertised.',
        'Input, approval, session mutation/history and cleanup are unsupported; session load/list require explicit current canonical session authority.',
        'Interrupted native checkpoints remain quarantined; trusted reconciliation never resends effects.',
      ],
      observedAt: this.observedAt(),
      capabilityEvaluation: inspectRuntimeCapabilities([], requirements),
    })
  }

  async start(input: RuntimeStartRequest): Promise<RuntimeExecutionHandle> {
    const request = RuntimeStartRequestSchema.parse(input)
    if (!inspectRuntimeCapabilities([], request.executionPlan.runtimeRequirements).eligible)
      throw failure('CLOUDFLARE_REQUIRED_CAPABILITY_UNSUPPORTED', 'unsupported')
    return this.handle(await this.owner.accept(request))
  }

  async status(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    return this.statusOf(await this.record(handle))
  }

  async *progress(
    handle: RuntimeExecutionHandle,
    options: RuntimeProgressOptions = {}
  ): AsyncIterable<RuntimeExecutionProgress> {
    const { afterSequence, signal } = options
    if (signal?.aborted) return
    const pinnedHandle = RuntimeExecutionHandleSchema.parse(handle)
    await this.record(pinnedHandle)
    const events = await this.owner.timedEvents(pinnedHandle.attemptId, afterSequence)
    for (const event of events) {
      if (signal?.aborted) return
      // Recheck current authority and the exact tuple after each iterator suspension.
      await this.record(pinnedHandle)
      if (signal?.aborted) return
      yield RuntimeExecutionProgressSchema.parse({
        handleId: pinnedHandle.handleId,
        sequence: event.sequence,
        occurredAt: new Date(event.occurredAt).toISOString(),
        type: 'status',
        data: {
          state: publicState(event.state),
          ...(event.state === 'reconciliation_required'
            ? { reason: 'CLOUDFLARE_RECONCILIATION_REQUIRED' }
            : {}),
        },
      })
    }
  }

  async cancel(
    handle: RuntimeExecutionHandle,
    input: RuntimeCancelRequest
  ): Promise<RuntimeExecutionStatus> {
    const request = RuntimeCancelRequestSchema.parse(input)
    const record = await this.record(handle)
    return this.statusOf(await this.owner.cancel(record.task.request.attemptId, request))
  }

  async reconcile(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    const record = await this.record(handle)
    return this.statusOf(await this.owner.reconcile(record.task.request.attemptId))
  }

  async submitInput(
    _handle: RuntimeExecutionHandle,
    _request: RuntimeInputRequest
  ): Promise<RuntimeExecutionStatus> {
    throw failure('CLOUDFLARE_INPUT_UNSUPPORTED', 'unsupported')
  }
  async submitApproval(
    _handle: RuntimeExecutionHandle,
    _request: RuntimeApprovalRequest
  ): Promise<RuntimeExecutionStatus> {
    throw failure('CLOUDFLARE_APPROVAL_UNSUPPORTED', 'unsupported')
  }
  async session(input: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    const operation = RuntimeSessionOperationSchema.parse(input)
    if (!this.owner.session || !['load', 'list'].includes(operation.operation))
      throw failure('CLOUDFLARE_SESSION_UNSUPPORTED', 'unsupported')
    return this.owner.session(operation)
  }
  async cleanup(_handle: RuntimeExecutionHandle): Promise<void> {
    throw failure('CLOUDFLARE_CLEANUP_UNSUPPORTED', 'unsupported')
  }

  private handle(record: CloudflareTaskRecord): RuntimeExecutionHandle {
    if (!record.handleId || record.acceptedAt === undefined)
      throw failure('CLOUDFLARE_HISTORICAL_HANDLE_UNAVAILABLE', 'unavailable')
    return RuntimeExecutionHandleSchema.parse({
      handleId: record.handleId,
      attemptId: record.task.request.attemptId,
      startedAt: new Date(record.acceptedAt).toISOString(),
    })
  }

  private async record(input: RuntimeExecutionHandle): Promise<CloudflareTaskRecord> {
    const handle = RuntimeExecutionHandleSchema.parse(input)
    const record = await this.owner.read(handle.attemptId)
    if (stableJson(handle) !== stableJson(this.handle(record)))
      throw failure('CLOUDFLARE_HANDLE_MISMATCH', 'conflict')
    return record
  }

  private statusOf(record: CloudflareTaskRecord): RuntimeExecutionStatus {
    const terminalUsage =
      record.state === 'cancelled'
        ? (record.settlement?.terminalUsage ?? record.observedResult?.usage)
        : undefined
    return RuntimeExecutionStatusSchema.parse({
      handle: this.handle(record),
      state: publicState(record.state),
      observedAt: this.observedAt(),
      ...(record.state === 'completed' ? { result: record.result } : {}),
      ...(terminalUsage ? { terminalUsage } : {}),
    })
  }
  private observedAt(): string {
    return new Date(this.now()).toISOString()
  }
}

function publicState(state: string): string {
  return state === 'accepted' ? 'starting' : state === 'reconciliation_required' ? 'unknown' : state
}
function failure(
  code: string,
  classification: 'unsupported' | 'conflict' | 'unavailable'
): RuntimeAdapterError {
  return new RuntimeAdapterError({ code, classification, message: code, retryable: false })
}
