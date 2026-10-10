import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import {
  DelegationRuntimeAdmissionRequestSchema,
  type CanonicalDelegationRuntimeBridge,
  type ChildProgressInput,
} from '@control-plane/orchestration'
import {
  RuntimeExecutionHandleSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  type RuntimeAdapter,
  type RuntimeExecutionResult,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'

/** Host-retained identity and lifecycle state, never model or API request authority. */
export const PiDurableRetainedChildSchema = z
  .object({
    identity: DelegationRuntimeAdmissionRequestSchema,
    handle: RuntimeExecutionHandleSchema,
    canonicalState: z.enum([
      'queued',
      'starting',
      'running',
      'awaiting_input',
      'completed',
      'failed',
      'cancelled',
    ]),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.handle.attemptId !== record.identity.childAttemptId)
      context.addIssue({ code: 'custom', message: 'Child handle must bind its canonical attempt' })
  })
export type PiDurableRetainedChild = z.output<typeof PiDurableRetainedChildSchema>

export interface PiDurableChildProgressScannerOptions {
  readonly listRetainedChildren: () => Promise<readonly PiDurableRetainedChild[]>
  /** Re-read canonical child/parent attempts, immutable plan and publication authority. */
  readonly assertCurrent: (record: PiDurableRetainedChild) => Promise<void>
  /** Idempotently retain the actual result and return its canonical artifact ID. */
  readonly retainTerminalResult: (
    record: PiDurableRetainedChild,
    result: RuntimeExecutionResult
  ) => Promise<string>
  readonly bridge: Pick<CanonicalDelegationRuntimeBridge, 'recordProgress'>
  readonly now: () => string
}

/** Polls committed receipts only. J1 owns terminal CAS, publication recovery and inbox deduplication. */
export class PiDurableChildProgressScanner {
  constructor(readonly options: PiDurableChildProgressScannerOptions) {}

  async scan(adapter: Pick<RuntimeAdapter, 'status' | 'progress'>) {
    const rows = await this.options.listRetainedChildren()
    if (!Array.isArray(rows) || rows.length > 4096)
      throw new Error('PI_CHILD_PROGRESS_RECORD_INVALID')
    const records = rows.map((row) => {
      const parsed = PiDurableRetainedChildSchema.safeParse(row)
      if (!parsed.success) throw new Error('PI_CHILD_PROGRESS_RECORD_INVALID')
      return parsed.data
    })
    const blocked: Array<{
      delegationId: string
      childAttemptId: string
      code: 'PI_CHILD_PROGRESS_BLOCKED'
    }> = []
    let published = 0
    let skipped = 0
    for (const record of records) {
      try {
        await this.options.assertCurrent(structuredClone(record))
        const status = RuntimeExecutionStatusSchema.parse(await adapter.status(record.handle))
        await this.options.assertCurrent(structuredClone(record))
        if (
          canonicalJsonStringify(status.handle) !== canonicalJsonStringify(record.handle) ||
          Date.parse(status.observedAt) >
            Date.parse(RuntimeExecutionHandleSchema.shape.startedAt.parse(this.options.now()))
        )
          throw new Error('PI_CHILD_PROGRESS_STATUS_INVALID')
        if (['starting', 'unknown', 'cancelling'].includes(status.state)) {
          skipped++
          continue
        }
        const target = status.state === 'timed_out' ? 'failed' : status.state
        if (
          (target === 'completed' || target === 'awaiting_input') &&
          ['queued', 'starting'].includes(record.canonicalState)
        ) {
          // A first poll can observe terminal before J1 has recorded running.
          // Recover its actual committed running event rather than inventing a checkpoint.
          let runningAt: string | undefined
          let sequence = 0
          let occurredAt = 0
          let count = 0
          for await (const value of adapter.progress(record.handle, { afterSequence: 0 })) {
            const event = RuntimeExecutionProgressSchema.parse(value)
            if (
              ++count > 65536 ||
              event.handleId !== record.handle.handleId ||
              event.sequence <= sequence ||
              Date.parse(event.occurredAt) < occurredAt ||
              Date.parse(event.occurredAt) > Date.parse(status.observedAt)
            )
              throw new Error('PI_CHILD_PROGRESS_REPLAY_INVALID')
            sequence = event.sequence
            occurredAt = Date.parse(event.occurredAt)
            if (!runningAt && event.type === 'status' && event.data['state'] === 'running')
              runningAt = event.occurredAt
          }
          await this.options.assertCurrent(structuredClone(record))
          if (!runningAt) throw new Error('PI_CHILD_PROGRESS_RUNNING_EVIDENCE_REQUIRED')
          await this.options.bridge.recordProgress(record.identity, {
            delegationId: record.identity.delegationId,
            childAttemptId: record.identity.childAttemptId,
            state: 'running',
            observedAt: runningAt,
          })
          await this.options.assertCurrent(structuredClone(record))
        }
        let progress: ChildProgressInput
        const base = {
          delegationId: record.identity.delegationId,
          childAttemptId: record.identity.childAttemptId,
          observedAt: status.observedAt,
        }
        if (target === 'completed') {
          if (!status.result) throw new Error('PI_CHILD_PROGRESS_RESULT_REQUIRED')
          const terminalResultRef = IdentifierSchemas.artifactId.parse(
            await this.options.retainTerminalResult(
              structuredClone(record),
              structuredClone(status.result)
            )
          )
          await this.options.assertCurrent(structuredClone(record))
          progress = { ...base, state: 'completed', terminalResultRef }
        } else if (target === 'failed') {
          progress = {
            ...base,
            state: 'failed',
            failure: {
              classification: 'runtime_error',
              code: 'PI_CHILD_RUNTIME_FAILED',
              retryable: false,
            },
          }
        } else if (target === 'cancelled' || target === 'running' || target === 'awaiting_input') {
          progress = { ...base, state: target }
        } else {
          skipped++
          continue
        }
        await this.options.assertCurrent(structuredClone(record))
        await this.options.bridge.recordProgress(record.identity, progress)
        published++
      } catch {
        blocked.push({
          delegationId: record.identity.delegationId,
          childAttemptId: record.identity.childAttemptId,
          code: 'PI_CHILD_PROGRESS_BLOCKED',
        })
      }
    }
    return { published, skipped, blocked }
  }
}
