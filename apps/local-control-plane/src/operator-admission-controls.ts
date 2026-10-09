import { createHash } from 'node:crypto'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceRecord,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  AdmissionStopReasonClassSchema,
  IdentifierSchemas,
  ServicePrincipalSchema,
  compareCodePointOrder,
  type ServicePrincipal,
} from '@control-plane/contracts'
import type { WorkflowJobStoreOptions } from '@control-plane/workflow-runtime'
import { z } from 'zod'

/**
 * Audited operator admission stops for the local control plane's embedded
 * workflow queue (M17.03.2 "operated audited controls").
 *
 * An admission stop is an operator-applied control that pauses admission of
 * NEW workflow jobs for one workspace and resumes it. It never touches work
 * that was already admitted: queued, running and waiting jobs keep their
 * leases, and cancellations and interaction responses stay deliverable.
 * Recovery scheduling is blocked exactly like any other new job, because it
 * is a new job admission.
 *
 * Boundaries this module preserves:
 * - Current-actor authority: every mutating command carries the authenticated
 *   `ServicePrincipal` the caller already holds (the private-API bearer
 *   authentication re-exported from `authentication.ts` produces it). A
 *   command without a parseable principal, or whose principal does not hold
 *   the target workspace in its `workspaceIds`, fails closed with no state
 *   change and no outcome record. Authority is re-read from the command on
 *   every mutation, so a principal whose workspace membership was revoked can
 *   neither set nor clear a stop from that moment on.
 * - Auditable outcome: stop and resume attempts record who, what scope, when,
 *   result (`applied` | `duplicate`) and a bounded reason class in an
 *   append-only outcome namespace, using the same persistence-namespace
 *   receipt pattern as the local graph tool command receipts. The state
 *   change and its outcome record are written in the SAME store transaction,
 *   so a torn write cannot leave a stop without its receipt or a receipt
 *   without its stop.
 * - Safe repeats: a replayed command (same action, scope, actor and
 *   commandId, but any timestamp) returns the original outcome receipt
 *   without a new write; a new command against an already-achieved state is
 *   an idempotent success recorded as `duplicate`.
 * - Enforcement point: `assertWorkflowJobAdmissionOpen` is the pure
 *   transaction-scoped gate. `admissionControlledBeforeEnqueue` composes it
 *   with the existing new-reference admission guard into the
 *   `WorkflowJobStoreOptions.beforeEnqueue` hook, so blocked admission is
 *   rejected inside the enqueue writer transaction itself.
 *
 * Supported scope today: one workspace per command — the authority model
 * (`ServicePrincipal.workspaceIds`) and the admission path (every lifecycle
 * job references a stored execution whose correlation carries its workspace)
 * both support it. Global (deployment-wide) stops have no authority
 * primitive, so they return the typed unavailable state instead of guessing.
 *
 * Neither namespace needs a schema migration: `PersistenceProvider`
 * namespaces are free-form keys in the same record store. Stop state lives in
 * a dedicated namespace (at most one record per workspace) so gate checks
 * stay bounded; outcomes live in a separate append-only namespace.
 */

export const WORKFLOW_ADMISSION_STOPS_NAMESPACE = 'workflow-admission-stops'
export const WORKFLOW_ADMISSION_OUTCOMES_NAMESPACE = 'workflow-admission-outcomes'
/** The stored executions namespace; a job's scope is resolved through its execution reference. */
export const WORKFLOW_EXECUTIONS_NAMESPACE = 'executions'

/** Bounded, grep-friendly operator reason classes; the vocabulary lives in contracts. */
export { AdmissionStopReasonClassSchema }

export const AdmissionStopScopeSchema = z
  .object({
    kind: z.literal('workspace'),
    workspaceId: IdentifierSchemas.workspaceId,
  })
  .strict()

export const AdmissionControlCommandSchema = z
  .object({
    /** The authenticated principal performing the mutation; never a self-asserted label. */
    actor: ServicePrincipalSchema,
    scope: AdmissionStopScopeSchema,
    commandId: IdentifierSchemas.commandId,
    reasonClass: AdmissionStopReasonClassSchema,
    /** Optional operator explanation; printable text without control characters. */
    reason: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          [...value].every((character) => {
            const code = character.codePointAt(0) ?? 0
            return code >= 0x20 && code !== 0x7f
          }),
        { message: 'Admission reason cannot contain control characters' }
      )
      .optional(),
    at: z.iso.datetime(),
  })
  .strict()

export type AdmissionStopScope = z.output<typeof AdmissionStopScopeSchema>
export type AdmissionStopReasonClass = z.output<typeof AdmissionStopReasonClassSchema>
export type AdmissionControlCommand = z.output<typeof AdmissionControlCommandSchema>

/** One recorded stop/resume attempt outcome; the durable audit unit. */
const OutcomeRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('admission-control-outcome'),
    action: z.enum(['stop', 'resume']),
    scope: AdmissionStopScopeSchema,
    actorPrincipalId: ServicePrincipalSchema.shape.principalId,
    commandId: IdentifierSchemas.commandId,
    reasonClass: AdmissionStopReasonClassSchema,
    reason: z.string().min(1).max(256).optional(),
    result: z.enum(['applied', 'duplicate']),
    stateAfter: z.enum(['stopped', 'open']),
    at: z.iso.datetime(),
  })
  .strict()

const StopStateRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('admission-stop'),
    scope: AdmissionStopScopeSchema,
    commandId: IdentifierSchemas.commandId,
    actorPrincipalId: ServicePrincipalSchema.shape.principalId,
    reasonClass: AdmissionStopReasonClassSchema,
    reason: z.string().min(1).max(256).optional(),
    stoppedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()

export type AdmissionControlOutcomeRecord = z.output<typeof OutcomeRecordSchema>

/** The current stop state for one workspace; absence means admission is open. */
export type AdmissionStopStateRecord = z.output<typeof StopStateRecordSchema>

export type AdmissionStopStateView =
  | {
      readonly status: 'stopped'
      readonly scope: AdmissionStopScope
      readonly commandId: string
      readonly actorPrincipalId: string
      readonly reasonClass: AdmissionStopReasonClass
      readonly reason?: string
      readonly stoppedAt: string
    }
  | { readonly status: 'open'; readonly scope: AdmissionStopScope }

/**
 * Typed result of a stop/resume command. Authority, input and state-integrity
 * failures are not results: they throw, failing closed with no writes.
 */
export type AdmissionControlOutcome =
  | {
      readonly status: 'ok'
      /**
       * `applied` changed the state, `duplicate` found it already achieved,
       * `replayed` returned the earlier receipt of the same command.
       */
      readonly outcome: 'applied' | 'duplicate' | 'replayed'
      readonly state: AdmissionStopStateView
      readonly audit: AdmissionControlOutcomeRecord
    }
  | {
      readonly status: 'unavailable'
      readonly reason: 'ADMISSION_STOP_SCOPE_GLOBAL_UNSUPPORTED'
    }

function parseCommand(input: unknown): AdmissionControlCommand {
  const parsed = AdmissionControlCommandSchema.safeParse(input)
  if (!parsed.success) throw new Error('ADMISSION_CONTROL_COMMAND_INVALID')
  return parsed.data
}

/**
 * Applies a stop or resume through the provider's own writer transaction.
 * The state change and its outcome record commit atomically: a crash before
 * commit rolls back both, so admission can never end up stopped-without-trace
 * or resumed-without-trace. Authority failures throw before any write.
 */
export async function applyAdmissionControl(
  provider: PersistenceProvider,
  action: 'stop' | 'resume',
  input: unknown
): Promise<AdmissionControlOutcome> {
  if (isGlobalScopeRequest(input)) {
    // The current authority model has no deployment-wide principal scope, so
    // a global stop cannot be granted or enforced responsibly: typed
    // unavailable instead of guessing.
    return { status: 'unavailable', reason: 'ADMISSION_STOP_SCOPE_GLOBAL_UNSUPPORTED' }
  }
  const command = parseCommand(input)
  assertActorMayControlScope(command.actor, command.scope)
  return provider.transaction((transaction) =>
    applyAdmissionControlInTransaction(transaction, action, command)
  )
}

/**
 * The transaction-scoped core. Exposed so callers can compose the control
 * into a larger transaction, and so tests can prove torn-write rollback
 * through the real store. The caller holds the writer transaction and passes
 * an already-validated command; authority is still re-checked here, so a
 * caller that skips `parseCommand` cannot bypass it.
 */
export async function applyAdmissionControlInTransaction(
  transaction: PersistenceTransaction,
  action: 'stop' | 'resume',
  command: AdmissionControlCommand
): Promise<AdmissionControlOutcome> {
  assertActorMayControlScope(command.actor, command.scope)
  const stateId = stopRecordId(command.scope.workspaceId)
  const auditId = outcomeRecordId(action, command.scope.workspaceId, command.commandId)
  const replayedRow = await transaction.get(WORKFLOW_ADMISSION_OUTCOMES_NAMESPACE, auditId)
  if (replayedRow !== undefined) {
    const prior = decodeOutcomeRecord(replayedRow)
    assertReplayIdentity(prior, action, command)
    return {
      status: 'ok',
      outcome: 'replayed',
      state: await readStopStateView(transaction, command.scope),
      audit: prior,
    }
  }
  const stateRow = await transaction.get(WORKFLOW_ADMISSION_STOPS_NAMESPACE, stateId)
  const existing = stateRow === undefined ? undefined : decodeStopStateRecord(stateRow)
  const duplicate = action === 'stop' ? existing !== undefined : existing === undefined
  const audit: AdmissionControlOutcomeRecord = {
    schemaVersion: 1,
    kind: 'admission-control-outcome',
    action,
    scope: command.scope,
    actorPrincipalId: command.actor.principalId,
    commandId: command.commandId,
    reasonClass: command.reasonClass,
    ...(command.reason === undefined ? {} : { reason: command.reason }),
    result: duplicate ? 'duplicate' : 'applied',
    stateAfter: action === 'stop' ? 'stopped' : 'open',
    at: command.at,
  }
  if (!duplicate) {
    if (action === 'stop') {
      const stopped: AdmissionStopStateRecord = {
        schemaVersion: 1,
        kind: 'admission-stop',
        scope: command.scope,
        commandId: command.commandId,
        actorPrincipalId: command.actor.principalId,
        reasonClass: command.reasonClass,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
        stoppedAt: command.at,
        updatedAt: command.at,
      }
      await transaction.put({
        namespace: WORKFLOW_ADMISSION_STOPS_NAMESPACE,
        id: stateId,
        value: json(stopped),
      })
    } else {
      await transaction.delete(WORKFLOW_ADMISSION_STOPS_NAMESPACE, stateId, stateRow?.revision)
    }
  }
  await transaction.put({
    namespace: WORKFLOW_ADMISSION_OUTCOMES_NAMESPACE,
    id: auditId,
    value: json(audit),
  })
  return {
    status: 'ok',
    outcome: duplicate ? 'duplicate' : 'applied',
    state: await readStopStateView(transaction, command.scope),
    audit,
  }
}

/** Sets an admission stop for one workspace. */
export function setWorkflowAdmissionStop(
  provider: PersistenceProvider,
  input: unknown
): Promise<AdmissionControlOutcome> {
  return applyAdmissionControl(provider, 'stop', input)
}

/** Resumes admission for one workspace (clears an existing stop). */
export function clearWorkflowAdmissionStop(
  provider: PersistenceProvider,
  input: unknown
): Promise<AdmissionControlOutcome> {
  return applyAdmissionControl(provider, 'resume', input)
}

/** Reads the current stop state for a workspace scope. */
export async function getWorkflowAdmissionStop(
  provider: PersistenceProvider,
  scope: AdmissionStopScope
): Promise<AdmissionStopStateView> {
  const parsed = AdmissionStopScopeSchema.parse(scope)
  return provider.transaction((transaction) => readStopStateView(transaction, parsed))
}

/** Bounded recent outcome trail for one workspace, oldest first. */
export async function listWorkflowAdmissionOutcomes(
  provider: PersistenceProvider,
  scope: AdmissionStopScope,
  limit = 100
): Promise<AdmissionControlOutcomeRecord[]> {
  const parsed = AdmissionStopScopeSchema.parse(scope)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('ADMISSION_CONTROL_LIMIT_INVALID')
  }
  return provider.transaction(async (transaction) => {
    const rows = await transaction.list(WORKFLOW_ADMISSION_OUTCOMES_NAMESPACE)
    return rows
      .map((row) => decodeOutcomeRecord(row))
      .filter((outcome) => outcome.scope.workspaceId === parsed.workspaceId)
      .toSorted(
        (left, right) =>
          compareCodePointOrder(left.at, right.at) ||
          compareCodePointOrder(left.commandId, right.commandId)
      )
      .slice(-limit)
  })
}

/**
 * The admission gate: throws `WORKFLOW_ADMISSION_STOPPED` when the job's
 * workspace is stopped, otherwise returns so admission proceeds. Runs inside
 * the enqueue writer transaction, so a stop that committed earlier is always
 * observed here. A job whose workspace cannot be resolved from its execution
 * reference passes through; the new-reference admission guard rejects such
 * jobs independently, so an unresolvable job is never admitted. A corrupt
 * stop record fails closed (blocks) rather than silently opening admission.
 */
export async function assertWorkflowJobAdmissionOpen(
  transaction: PersistenceTransaction,
  record: {
    readonly workflowKey: string
    readonly input: unknown
  }
): Promise<void> {
  const stops = await transaction.list(WORKFLOW_ADMISSION_STOPS_NAMESPACE)
  if (stops.length === 0) return
  const workspaceId = await resolveJobWorkspaceId(transaction, record.input)
  if (workspaceId === undefined) return
  const row = await transaction.get(WORKFLOW_ADMISSION_STOPS_NAMESPACE, stopRecordId(workspaceId))
  if (row === undefined) return
  decodeStopStateRecord(row)
  throw new Error('WORKFLOW_ADMISSION_STOPPED')
}

/**
 * Composes the admission gate with the existing new-reference admission guard
 * into the `WorkflowJobStoreOptions.beforeEnqueue` hook. The reference guard
 * runs first so a stop never masks an invalid job reference, then the gate
 * rejects stopped-scope admission inside the same writer transaction.
 * Intended wiring (composition.ts, embedded-sqlite mode only):
 * `{ beforeEnqueue: admissionControlledBeforeEnqueue(assertSqliteWorkflowExecutionReference) }`.
 */
export function admissionControlledBeforeEnqueue(
  referenceGuard?: WorkflowJobStoreOptions['beforeEnqueue']
): NonNullable<WorkflowJobStoreOptions['beforeEnqueue']> {
  return async (transaction, record) => {
    await referenceGuard?.(transaction, record)
    await assertWorkflowJobAdmissionOpen(transaction, record)
  }
}

function assertActorMayControlScope(actor: ServicePrincipal, scope: AdmissionStopScope): void {
  if (!ServicePrincipalSchema.safeParse(actor).success) {
    throw new Error('ADMISSION_CONTROL_ACTOR_INVALID')
  }
  if (!actor.workspaceIds.includes(scope.workspaceId)) {
    throw new Error('ADMISSION_CONTROL_SCOPE_FORBIDDEN')
  }
}

function assertReplayIdentity(
  prior: AdmissionControlOutcomeRecord,
  action: 'stop' | 'resume',
  command: AdmissionControlCommand
): void {
  if (
    prior.action !== action ||
    prior.scope.workspaceId !== command.scope.workspaceId ||
    prior.actorPrincipalId !== command.actor.principalId ||
    prior.commandId !== command.commandId ||
    prior.reasonClass !== command.reasonClass ||
    prior.reason !== command.reason
  ) {
    throw new Error('ADMISSION_CONTROL_COMMAND_CONFLICT')
  }
}

async function readStopStateView(
  transaction: PersistenceTransaction,
  scope: AdmissionStopScope
): Promise<AdmissionStopStateView> {
  const row = await transaction.get(
    WORKFLOW_ADMISSION_STOPS_NAMESPACE,
    stopRecordId(scope.workspaceId)
  )
  if (row === undefined) return { status: 'open', scope }
  const stopped = decodeStopStateRecord(row)
  return {
    status: 'stopped',
    scope: stopped.scope,
    commandId: stopped.commandId,
    actorPrincipalId: stopped.actorPrincipalId,
    reasonClass: stopped.reasonClass,
    ...(stopped.reason === undefined ? {} : { reason: stopped.reason }),
    stoppedAt: stopped.stoppedAt,
  }
}

/**
 * Resolves the workspace a job admits into, through its execution reference —
 * the same stored-execution lookup the new-reference admission guard
 * performs. Unresolvable inputs return `undefined` instead of guessing a
 * scope.
 */
async function resolveJobWorkspaceId(
  transaction: PersistenceTransaction,
  input: unknown
): Promise<string | undefined> {
  const executionId = (input as { executionId?: unknown } | null | undefined)?.executionId
  if (typeof executionId !== 'string') return undefined
  const parsed = IdentifierSchemas.executionId.safeParse(executionId)
  if (!parsed.success) return undefined
  const row = await transaction.get(
    WORKFLOW_EXECUTIONS_NAMESPACE,
    `r-${createHash('sha256').update(parsed.data).digest('hex')}`
  )
  const workspaceId = (row?.value as { correlation?: { workspaceId?: unknown } } | null | undefined)
    ?.correlation?.workspaceId
  if (typeof workspaceId !== 'string') return undefined
  return IdentifierSchemas.workspaceId.safeParse(workspaceId).success ? workspaceId : undefined
}

function isGlobalScopeRequest(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const scope = (input as Record<string, unknown>)['scope']
  return (
    scope !== null &&
    typeof scope === 'object' &&
    !Array.isArray(scope) &&
    (scope as Record<string, unknown>)['kind'] === 'global'
  )
}

function decodeOutcomeRecord(row: PersistenceRecord): AdmissionControlOutcomeRecord {
  const parsed = OutcomeRecordSchema.safeParse(row.value)
  if (
    !parsed.success ||
    outcomeRecordId(parsed.data.action, parsed.data.scope.workspaceId, parsed.data.commandId) !==
      row.id
  ) {
    throw new Error('ADMISSION_CONTROL_OUTCOME_CORRUPT')
  }
  return parsed.data
}

function decodeStopStateRecord(row: PersistenceRecord): AdmissionStopStateRecord {
  const parsed = StopStateRecordSchema.safeParse(row.value)
  if (!parsed.success || stopRecordId(parsed.data.scope.workspaceId) !== row.id) {
    throw new Error('ADMISSION_CONTROL_STATE_CORRUPT')
  }
  return parsed.data
}

function stopRecordId(workspaceId: string): string {
  return `r-${createHash('sha256').update(`stop:workspace:${workspaceId}`).digest('hex')}`
}

function outcomeRecordId(
  action: 'stop' | 'resume',
  workspaceId: string,
  commandId: string
): string {
  return `r-${createHash('sha256')
    .update(`outcome:${action}:workspace:${workspaceId}:${commandId}`)
    .digest('hex')}`
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
