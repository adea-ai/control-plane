import { RuntimeExecutionResultSchema, RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import type { RuntimeExecutionResult, RuntimeStartRequest } from '@control-plane/runtime-sdk'
import { CloudflareOwnerJournal, stableJson } from './owner.js'
import type { CloudflareAcceptedTask, CloudflareOwnerPins, CloudflareTaskRecord } from './owner.js'

export type CloudflareBoundary = 'admit' | 'wake' | 'read' | 'cancel' | 'effect'
/** Trusted host implementations reread canonical current actor/audience/grant and exact plan/budget pins. */
export interface CloudflareCurrentAuthority {
  readAccepted(request: RuntimeStartRequest): Promise<CloudflareAcceptedTask>
  assertCurrent(
    task: CloudflareAcceptedTask,
    owner: CloudflareOwnerPins,
    boundary: CloudflareBoundary
  ): Promise<void>
}
export interface CloudflarePiEngine {
  run(
    task: CloudflareAcceptedTask,
    beforeEffect: () => Promise<void>
  ): Promise<RuntimeExecutionResult>
  close(): Promise<void>
}

/** Internal host seam, not an advertised or qualified RuntimeAdapter/deployment profile. */
export class CloudflarePiHost {
  private readonly pins: CloudflareOwnerPins
  private wakeTail: Promise<void> = Promise.resolve()
  constructor(
    private readonly journal: CloudflareOwnerJournal,
    pins: CloudflareOwnerPins,
    private readonly authority: CloudflareCurrentAuthority,
    private readonly openEngine: () => Promise<CloudflarePiEngine>
  ) {
    this.journal.assertPins(pins)
    this.pins = Object.freeze(JSON.parse(stableJson(pins)) as CloudflareOwnerPins)
  }

  async accept(input: RuntimeStartRequest, now: number): Promise<CloudflareTaskRecord> {
    const request = RuntimeStartRequestSchema.parse(JSON.parse(stableJson(input)))
    const task = JSON.parse(
      stableJson(await this.authority.readAccepted(request))
    ) as CloudflareAcceptedTask
    this.assertAccepted(task, request)
    await this.assertCurrent(task, 'admit')
    const record = this.journal.admit(task, now)
    await this.journal.repairAlarm()
    return record
  }

  async read(attemptId: string): Promise<CloudflareTaskRecord> {
    const record = this.journal.get(attemptId)
    await this.assertCurrent(record.task, 'read')
    return this.journal.get(attemptId)
  }

  async events(attemptId: string, afterSequence = 0) {
    await this.read(attemptId)
    return this.journal.events(attemptId, afterSequence)
  }

  async cancel(attemptId: string): Promise<CloudflareTaskRecord> {
    const record = await this.read(attemptId)
    await this.assertCurrent(record.task, 'cancel')
    const current = this.journal.get(attemptId)
    if (
      current.state === 'completed' ||
      current.state === 'cancelled' ||
      current.state === 'cancelling'
    )
      return current
    return this.journal.transition(
      attemptId,
      current.state,
      current.state === 'accepted' ? 'cancelled' : 'cancelling'
    )
  }

  wake(attemptId: string): Promise<CloudflareTaskRecord> {
    const operation = this.wakeTail.then(() => this.runWake(attemptId))
    this.wakeTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async runWake(attemptId: string): Promise<CloudflareTaskRecord> {
    const record = await this.read(attemptId)
    await this.assertCurrent(record.task, 'wake')
    const current = this.journal.get(attemptId)
    // Interrupted physical effects need broker reconciliation, not an automatic provider retry.
    if (current.state !== 'accepted') return current
    this.journal.transition(attemptId, 'accepted', 'running')
    let engine: CloudflarePiEngine | undefined
    try {
      await this.assertEffect(current.task)
      engine = await this.openEngine()
      await this.assertEffect(current.task)
      const result = RuntimeExecutionResultSchema.parse(
        await engine.run(current.task, () => this.assertEffect(current.task))
      )
      this.journal.observeResult(attemptId, result)
      if (this.journal.get(attemptId).state === 'cancelling') return this.journal.get(attemptId)
      await this.assertEffect(current.task)
      return this.journal.transition(attemptId, 'running', 'completed', result)
    } catch (error) {
      // Never overwrite cancellation or a newer owner's journal with a late async continuation.
      try {
        if (this.journal.get(attemptId).state === 'running') {
          this.journal.transition(attemptId, 'running', 'reconciliation_required')
        }
      } catch {
        /* Stale owner is already fenced; preserve the original error. */
      }
      throw error
    } finally {
      await engine?.close()
    }
  }

  private assertAccepted(task: CloudflareAcceptedTask, request: RuntimeStartRequest): void {
    const parsed = RuntimeStartRequestSchema.parse(task.request)
    if (
      ![1, 2].includes(parsed.executionPlan.schemaVersion) ||
      task.schemaVersion !== 1 ||
      !/^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        task.canonicalActorPrincipalId
      ) ||
      stableJson(parsed) !== stableJson(request) ||
      !parsed.attemptBudget ||
      parsed.attemptBudget.workspaceId !== this.pins.workspaceId
    ) {
      throw new Error('CLOUDFLARE_CANONICAL_ADMISSION_MISMATCH')
    }
  }

  private async assertCurrent(
    task: CloudflareAcceptedTask,
    boundary: CloudflareBoundary
  ): Promise<void> {
    this.journal.assertOwner()
    this.assertAccepted(task, task.request)
    await this.authority.assertCurrent(task, this.pins, boundary)
    this.journal.assertOwner()
  }

  private async assertEffect(task: CloudflareAcceptedTask): Promise<void> {
    await this.assertCurrent(task, 'effect')
    if (this.journal.get(task.request.attemptId).state !== 'running')
      throw new Error('CLOUDFLARE_EFFECT_STATE_DENIED')
  }
}
