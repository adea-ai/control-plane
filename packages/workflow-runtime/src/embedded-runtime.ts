import { randomUUID } from 'node:crypto'
import type {
  DeploymentComponentHealth,
  DeploymentProfile,
  PersistenceProvider,
} from '@control-plane/deployment'
import {
  ExecutionCancellationCommandSchema,
  type ExecutionCancellationCommand,
} from '@control-plane/contracts'
import {
  computeBackoffDelayMs,
  InteractionRequestSchema,
  type InteractionRequest,
} from '@control-plane/domain'
import {
  ExecutionWorkflowInputSchema,
  type ExecutionWorkflowInput,
} from '@control-plane/orchestration'
import {
  runExecutionLifecycle,
  workflowPolicies,
  type ActivityRaceResult,
  type ExecutionLifecycleActivities,
  type TerminalControl,
  type WorkflowControl,
  type WorkflowInteractionResponse,
} from './execution-workflow.js'
import { WorkflowJobStore, type WorkflowJobRecord } from './embedded-job-store.js'

export class EmbeddedWorkflowSubmissionError extends Error {
  constructor() {
    super('Embedded workflow submission failed')
    this.name = 'EmbeddedWorkflowSubmissionError'
  }
}

/** Error used to unwind interaction waiters when the runtime stops. */
class WorkflowRunInterrupted extends Error {
  constructor() {
    super('WORKFLOW_RUN_INTERRUPTED')
    this.name = 'WorkflowRunInterrupted'
  }
}

export interface EmbeddedWorkflowRuntimeOptions {
  readonly provider: PersistenceProvider
  readonly activities: ExecutionLifecycleActivities
  readonly profile?: DeploymentProfile
  /** Claim identity for this runtime instance; defaults to a fresh random id. */
  readonly owner?: string
  /** Claim lease duration in milliseconds; expired leases allow crash recovery. */
  readonly leaseMs?: number
  /** Queue scan cadence in milliseconds; also drives waiter/cancellation polling. */
  readonly pollIntervalMs?: number
  /** Base backoff before a failed run's next attempt in milliseconds. */
  readonly retryDelayMs?: number
  /** Per-job attempt budget; the job is terminally failed once exhausted. */
  readonly maximumAttempts?: number
  /** How many jobs one tick may start; also bounds concurrent workflow runs. */
  readonly claimLimit?: number
  /** Upper bound stop() waits for in-flight runs before abandoning them. */
  readonly stopGraceMs?: number
  readonly now?: () => string
}

const defaults = {
  leaseMs: 60_000,
  pollIntervalMs: 100,
  retryDelayMs: 250,
  maximumAttempts: 5,
  claimLimit: 8,
  stopGraceMs: 5_000,
} as const

/**
 * Durable in-process workflow runtime. It claims jobs from the
 * {@link WorkflowJobStore}, drives the portable `runExecutionLifecycle`
 * program with the same activity contract the Restate endpoint serves, and
 * records terminal outcomes durably — no Restate binary, ingress, or
 * workflow endpoint involved.
 */
export class EmbeddedWorkflowRuntime {
  readonly profile: DeploymentProfile
  readonly #activities: ExecutionLifecycleActivities
  readonly #store: WorkflowJobStore
  readonly #owner: string
  readonly #leaseMs: number
  readonly #pollIntervalMs: number
  readonly #retryDelayMs: number
  readonly #maximumAttempts: number
  readonly #claimLimit: number
  readonly #stopGraceMs: number
  readonly #now: () => string
  readonly #activeRuns = new Set<Promise<void>>()
  #running = false
  #stopping = false
  #tickTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: EmbeddedWorkflowRuntimeOptions) {
    this.#activities = options.activities
    this.#store = new WorkflowJobStore(options.provider)
    this.profile = options.profile ?? 'local'
    this.#owner = options.owner ?? randomUUID()
    this.#leaseMs = positiveInteger('leaseMs', options.leaseMs ?? defaults.leaseMs)
    this.#pollIntervalMs = positiveInteger(
      'pollIntervalMs',
      options.pollIntervalMs ?? defaults.pollIntervalMs
    )
    this.#retryDelayMs = options.retryDelayMs ?? defaults.retryDelayMs
    this.#maximumAttempts = positiveInteger(
      'maximumAttempts',
      options.maximumAttempts ?? defaults.maximumAttempts
    )
    this.#claimLimit = positiveInteger('claimLimit', options.claimLimit ?? defaults.claimLimit)
    this.#stopGraceMs = options.stopGraceMs ?? defaults.stopGraceMs
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error('EMBEDDED_RUNTIME_ALREADY_STARTED')
    this.#running = true
    this.#stopping = false
    this.#scheduleTick(0)
  }

  async health(): Promise<DeploymentComponentHealth> {
    return {
      ready: this.#running,
      component: 'embedded-workflow-runtime',
      version: workflowPolicies.version,
      details: { owner: this.#owner, pollIntervalMs: this.#pollIntervalMs },
    }
  }

  async stop(): Promise<void> {
    if (!this.#running) return
    this.#running = false
    this.#stopping = true
    if (this.#tickTimer !== undefined) clearTimeout(this.#tickTimer)
    this.#tickTimer = undefined
    // Parked interaction waiters observe #stopping within one poll and unwind,
    // returning their jobs to the queue for the next runtime to resume.
    const active = [...this.#activeRuns]
    if (active.length === 0) return
    await Promise.race([
      Promise.allSettled(active),
      new Promise((resolve) => setTimeout(resolve, this.#stopGraceMs)),
    ])
  }

  #scheduleTick(delayMs: number): void {
    if (!this.#running) return
    this.#tickTimer = setTimeout(() => {
      void this.#tick()
    }, delayMs)
  }

  async #tick(): Promise<void> {
    if (!this.#running) return
    try {
      const availableSlots = this.#claimLimit - this.#activeRuns.size
      const now = this.#now()
      if (availableSlots <= 0) return
      const claimed = await this.#store.claimDue({
        owner: this.#owner,
        leaseMs: this.#leaseMs,
        now,
        limit: availableSlots,
      })
      for (const job of claimed) {
        const run = this.#runJob(job).finally(() => this.#activeRuns.delete(run))
        this.#activeRuns.add(run)
      }
    } catch {
      // Queue scan failures are transient (e.g. provider busy); retry next tick.
    } finally {
      this.#scheduleTick(this.#pollIntervalMs)
    }
  }

  async #runJob(job: WorkflowJobRecord): Promise<void> {
    const lease = job.lease
    if (lease === undefined || lease.owner !== this.#owner) return
    const renewTimer = setInterval(
      () => {
        void this.#store
          .renewLease({
            workflowKey: job.workflowKey,
            owner: this.#owner,
            token: lease.token,
            leaseMs: this.#leaseMs,
            now: this.#now(),
          })
          .catch(() => undefined)
      },
      Math.max(250, Math.floor(this.#leaseMs / 3))
    )
    try {
      const input = ExecutionWorkflowInputSchema.parse(job.input)
      const control = await this.#control(job.workflowKey, lease.token, input)
      const result = await runExecutionLifecycle(
        input,
        journalActivities(this.#store, job.workflowKey, this.#activities),
        control
      )
      await this.#store.complete({
        workflowKey: job.workflowKey,
        owner: this.#owner,
        token: lease.token,
        outcome: result,
        at: this.#now(),
      })
    } catch (error) {
      const interrupted = error instanceof WorkflowRunInterrupted || this.#stopping
      const retriable = job.attempt < this.#maximumAttempts
      const backoffMs = computeBackoffDelayMs({
        baseDelayMs: this.#retryDelayMs,
        attempt: job.attempt - 1,
        maxDelayMs: 30_000,
      })
      await this.#store
        .fail({
          workflowKey: job.workflowKey,
          owner: this.#owner,
          token: lease.token,
          error: error instanceof Error ? error.message : 'WORKFLOW_RUN_FAILED',
          ...(retriable
            ? {
                retryAt: new Date(
                  interrupted ? Date.parse(this.#now()) : Date.parse(this.#now()) + backoffMs
                ).toISOString(),
              }
            : {}),
          at: this.#now(),
        })
        .catch(() => undefined)
    } finally {
      clearInterval(renewTimer)
    }
  }

  async #control(
    workflowKey: string,
    token: string,
    input: ExecutionWorkflowInput
  ): Promise<WorkflowControl> {
    const deadlineMs = Date.parse(input.deadlineAt)
    const store = this.#store
    const now = () => this.#now()
    const poll = () => sleep(this.#pollIntervalMs)
    const entryControl = (async (): Promise<
      { cancelled: true } | { deadlineReached: true } | Record<string, never>
    > => {
      const cancellation = await store.getCancellation(workflowKey)
      if (cancellation !== undefined) return { cancelled: true }
      if (Date.now() >= deadlineMs) return { deadlineReached: true }
      return {}
    })()
    return {
      ...(await entryControl),
      waitForInteraction: async (interactionId: string): Promise<WorkflowInteractionResponse> => {
        if (!(await store.markWaiting({ workflowKey, owner: this.#owner, token, at: now() }))) {
          throw new Error('WORKFLOW_CLAIM_LOST')
        }
        for (;;) {
          const saved = await store.getInteractionResponse(workflowKey, interactionId)
          if (saved !== undefined) {
            if (!(await store.markRunning({ workflowKey, owner: this.#owner, token, at: now() }))) {
              throw new Error('WORKFLOW_CLAIM_LOST')
            }
            return saved as WorkflowInteractionResponse
          }
          if (this.#stopping) throw new WorkflowRunInterrupted()
          await poll()
        }
      },
      raceActivity: async <Value>(activity: Promise<Value>): Promise<ActivityRaceResult<Value>> => {
        let settled = false
        const terminalWatch = (async (): Promise<ActivityRaceResult<Value> | undefined> => {
          for (;;) {
            if (settled) return undefined
            const cancellation = await store.getCancellation(workflowKey)
            if (cancellation !== undefined) {
              return { type: 'terminal', control: { cancelled: true } satisfies TerminalControl }
            }
            if (Date.now() >= deadlineMs) {
              return {
                type: 'terminal',
                control: { deadlineReached: true } satisfies TerminalControl,
              }
            }
            await poll()
          }
        })()
        try {
          return await Promise.race([
            activity.then((value) => ({ type: 'activity', value }) as const),
            terminalWatch.then((outcome) => outcome ?? neverSettles()),
          ])
        } finally {
          settled = true
        }
      },
      checkTerminal: async (): Promise<TerminalControl | undefined> => {
        const cancellation = await store.getCancellation(workflowKey)
        if (cancellation !== undefined) return { cancelled: true }
        if (Date.now() >= deadlineMs) return { deadlineReached: true }
        return undefined
      },
    }
  }
}

const neverSettles = (): Promise<never> => new Promise(() => {})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Journals every activity result by effect key before the workflow observes
 * it. A resumed run replays persisted activities from the journal instead of
 * re-executing them — the embedded equivalent of the Restate `ctx.run`
 * journal. Throwing activities are not journaled: the underlying activities
 * are idempotent, so a retried run re-executes them (at-least-once).
 */
function journalActivities(
  store: WorkflowJobStore,
  workflowKey: string,
  activities: ExecutionLifecycleActivities
): ExecutionLifecycleActivities {
  const wrap = <
    Input extends { readonly effectKey?: string; readonly idempotencyKey?: string },
    Result,
  >(
    method: (input: Input) => Promise<Result>
  ): ((input: Input) => Promise<Result>) => {
    return async (input: Input) => {
      const effectKey = input.effectKey ?? input.idempotencyKey
      if (effectKey === undefined) return method(input)
      const replayed = await store.getEffect(workflowKey, effectKey)
      if (replayed !== undefined) {
        return (replayed === null ? undefined : replayed) as Result
      }
      const result = await method(input)
      const stored = await store.recordEffect(workflowKey, effectKey, result)
      return (stored.result === null ? undefined : stored.result) as Result
    }
  }
  return {
    ensureAttempt: wrap(activities.ensureAttempt.bind(activities)),
    persistStatus: wrap(activities.persistStatus.bind(activities)),
    dispatch: wrap(activities.dispatch.bind(activities)),
    applyInteraction: wrap(activities.applyInteraction.bind(activities)),
    runGraphSegment: wrap(activities.runGraphSegment.bind(activities)),
    resumeGraphSegment: wrap(activities.resumeGraphSegment.bind(activities)),
    continueGraphSegment: wrap(activities.continueGraphSegment.bind(activities)),
    cancelActive: wrap(activities.cancelActive.bind(activities)),
    cleanup: wrap(activities.cleanup.bind(activities)),
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`EMBEDDED_RUNTIME_INVALID_${name.toUpperCase()}`)
  return value
}

export interface EmbeddedExecutionWorkflowDispatcherOptions {
  readonly store: WorkflowJobStore
  readonly maximumAttempts?: number
  readonly now?: () => string
}

/**
 * Submission-side twin of {@link EmbeddedWorkflowRuntime}: it implements the
 * same dispatcher contracts as the Restate ingress client (workflow submit,
 * interaction signal, cancellation) but enqueues durably into the job store
 * instead of calling an ingress.
 */
export class EmbeddedExecutionWorkflowDispatcher {
  readonly #store: WorkflowJobStore
  readonly #maximumAttempts: number
  readonly #now: () => string

  constructor(options: EmbeddedExecutionWorkflowDispatcherOptions) {
    this.#store = options.store
    this.#maximumAttempts = options.maximumAttempts ?? defaults.maximumAttempts
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async submit(inputValue: ExecutionWorkflowInput): Promise<void> {
    const input = ExecutionWorkflowInputSchema.parse(inputValue)
    // Duplicate submissions mirror the Restate 409/PreviouslyAccepted path:
    // the first enqueue for an execution wins, replays are accepted no-ops.
    await this.#store.enqueue({
      workflowKey: input.executionId,
      input,
      maximumAttempts: this.#maximumAttempts,
      at: this.#now(),
    })
  }

  async cancel(requestValue: ExecutionCancellationCommand): Promise<void> {
    const request = ExecutionCancellationCommandSchema.parse(requestValue)
    await this.#store.requestCancellation({
      workflowKey: request.payload.executionId,
      commandId: request.commandId,
      at: this.#now(),
    })
  }

  async deliver(
    inputValue: InteractionRequest & { response: NonNullable<InteractionRequest['response']> }
  ): Promise<void> {
    const request = InteractionRequestSchema.parse(inputValue)
    if (request.state !== 'responded' || request.response === undefined) {
      throw new EmbeddedWorkflowSubmissionError()
    }
    await this.#store.saveInteractionResponse({
      workflowKey: request.executionId,
      response: {
        interactionId: request.interactionId,
        responseId: request.response.responseId,
        action: request.response.action,
        ...(request.response.value === undefined ? {} : { value: request.response.value }),
      },
      at: this.#now(),
    })
  }
}

export interface EmbeddedWorkflowExecutionOptions extends EmbeddedWorkflowRuntimeOptions {
  readonly dispatcherMaximumAttempts?: number
}

/** Composes the runtime and dispatcher pair over one shared queue. */
export function createEmbeddedWorkflowExecution(options: EmbeddedWorkflowExecutionOptions): {
  readonly store: WorkflowJobStore
  readonly runtime: EmbeddedWorkflowRuntime
  readonly dispatcher: EmbeddedExecutionWorkflowDispatcher
} {
  const store = new WorkflowJobStore(options.provider)
  const runtime = new EmbeddedWorkflowRuntime(options)
  const dispatcher = new EmbeddedExecutionWorkflowDispatcher({
    store,
    ...(options.dispatcherMaximumAttempts === undefined
      ? {}
      : { maximumAttempts: options.dispatcherMaximumAttempts }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { store, runtime, dispatcher }
}
