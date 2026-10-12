import { createHash } from 'node:crypto'
import { GraphReferenceSchema, type GraphReference } from '@control-plane/contracts'
import type {
  PersistenceProvider,
  PersistenceRecord,
  PersistenceTransaction,
} from '@control-plane/deployment'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { z } from 'zod'

// Bounded legacy LangGraph reader, drain plan, handoff fences and new-admission gate (M16.03, #940).
// Everything here is repository-side and inert by default: nothing shuts down, deletes, converts or
// reconciles work. A disposable store can never establish zero live work; zero requires a
// deployed-dsn attestation, complete reads, and no unparseable retained records.

export const LEGACY_CHECKPOINT_NAMESPACE = 'langgraph-checkpoints-v1'
export const LEGACY_EXECUTION_NAMESPACE = 'executions'
export const LEGACY_EXECUTION_PLAN_NAMESPACE = 'execution-plans'
export const LEGACY_DRAIN_FENCE_NAMESPACE = 'langgraph-legacy-drain-fences'
// Never deleted by any release, so each thread's generation only grows. A reclaim cannot reuse a generation.
export const LEGACY_DRAIN_FENCE_GENERATION_NAMESPACE = 'langgraph-legacy-drain-fence-generations'
export const LEGACY_SAVER_OWNER = 'legacy-langgraph-saver'
export const TYPED_REPLACEMENT_OWNER = 'typed-replacement'
export const LEGACY_STATUS_SCHEMA = 'langgraph-legacy-operator-status/v1'
/** Maximum work items included in an operator status; the total is always reported. */
export const LEGACY_STATUS_ITEM_LIMIT = 25

/** Repository-side version and deprecation marker for the public graph routes. Changes no HTTP behavior. */
export const LEGACY_GRAPH_API = Object.freeze({
  path: 'graphs',
  version: '1',
  lifecycle: 'deprecated',
  successor: 'typed durable task replacement (M16.02, adea-ai/control-plane#939)',
  operations: Object.freeze(['deprecate', 'publish', 'resolve', 'revoke']),
  removalCondition:
    'Zero retained legacy threads in deployed-dsn scope from complete reads with an attestation, every admissible legacy graph version covered by an evidence-equivalent replacement report, and profile and failure evidence proven for each replacement. This module performs no removal.',
})

const TERMINAL_EXECUTION_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
const UNCERTAIN_EXECUTION_STATES = new Set(['reconciliation_required'])

export class LegacyRetirementError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'LegacyRetirementError'
    this.code = code
  }
}

export type ObservationScope = 'disposable-local-store' | 'deployed-dsn'
export type ThreadClassification =
  | 'in-flight'
  | 'uncertain-effect'
  | 'terminal'
  | 'orphaned'
  | 'unclassified'
  | 'unknown'
export type PlanVerification = 'verified' | 'unverified' | 'absent'

export interface VerifiedPlanIdentity {
  readonly executionPlanId: string
  readonly contentDigest: string
  readonly graph?: GraphReference
}

export interface ReadOptions {
  readonly observationScope: ObservationScope
  /** Records per page, 1 through 128. */
  readonly pageSize?: number
  /** Records read per namespace before the read is reported incomplete. */
  readonly maximumRecords?: number
  /** Required before a deployed-dsn observation can establish zero. Never produced in this repository. */
  readonly attestation?: { readonly attestedBy: string; readonly attestedAt: string }
  /** Test seam; the default verifies the canonical execution-plan integrity and graph identity. */
  readonly verifyPlan?: (value: unknown) => VerifiedPlanIdentity
}

export interface LegacyWorkItem {
  readonly kind: 'checkpoint-thread' | 'execution-only'
  /** Storage thread id for checkpoint threads, or `execution:<executionId>` for execution-only work. */
  readonly identity: string
  readonly scope?: string
  readonly workspaceId?: string
  readonly executionId?: string
  readonly executionState?: string
  readonly classification: ThreadClassification
  readonly planVerification: PlanVerification
  readonly graph?: GraphReference
  readonly blockers: readonly string[]
}

export interface LegacyRemainder {
  readonly observationScope: ObservationScope
  readonly observation: 'observed' | 'incomplete'
  /** Counts are exact only when every namespace was read completely. Otherwise they are lower bounds. */
  readonly exact: boolean
  readonly truncated: {
    readonly checkpoints: boolean
    readonly executions: boolean
    readonly plans: boolean
  }
  readonly counts: {
    readonly threads: number
    readonly executionOnly: number
    readonly checkpoints: number
    readonly writes: number
    readonly unparseableCheckpointRecords: number
    readonly unsupportedVersionCheckpointRecords: number
    readonly executions: number
    readonly inFlightExecutions: number
    readonly malformedExecutions: number
    readonly plans: number
    readonly unparseablePlans: number
    readonly plansUnverified: number
    readonly byClassification: Readonly<Record<ThreadClassification, number>>
  }
  readonly items: readonly LegacyWorkItem[]
  readonly zero: { readonly established: boolean; readonly reasons: readonly string[] }
}

export interface ReplacementEvidence {
  readonly graph: GraphReference
  readonly outcome: 'evidence-equivalent' | 'evidence-divergent'
  readonly reportDigest: `sha256:${string}`
}

export interface ProofEvidence {
  readonly graph: GraphReference
  readonly outcome: 'proven' | 'unproven'
}

export interface DrainItemPlan {
  readonly identity: string
  readonly classification: ThreadClassification
  readonly selectedOwner: typeof LEGACY_SAVER_OWNER | typeof TYPED_REPLACEMENT_OWNER
  readonly ownerReasons: readonly string[]
  readonly blockers: readonly string[]
  readonly handoffEligible: boolean
}

export interface LegacyDrainPlan {
  readonly observation: LegacyRemainder['observation']
  readonly items: readonly DrainItemPlan[]
  readonly handoffEligible: boolean
  /** Dependencies kept while any unresolved live-work evidence or incomplete read remains. */
  readonly retainedDependencies: readonly string[]
  readonly removal: {
    readonly condition: string
    readonly satisfied: boolean
    readonly reasons: readonly string[]
  }
}

// Persisted records are parsed, never cast. Unknown fields pass through; malformed records are counted.
const CheckpointRowSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    thread: z.string(),
    checkpointId: z.string(),
    kind: z.enum(['checkpoint', 'write']),
  })
  .passthrough()

const VersionProbeSchema = z.object({ version: z.unknown() }).passthrough()

const ExecutionRowSchema = z
  .object({
    executionId: z.string(),
    state: z.string(),
    correlation: z.object({ workspaceId: z.string() }).passthrough().optional(),
    executionPlan: z
      .object({ executionPlanId: z.string(), contentDigest: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough()

const PlanIdentitySchema = z.object({ executionPlanId: z.string() }).passthrough()
const FenceRecordSchema = z
  .object({
    storageThreadId: z.string(),
    owner: z.string(),
    generation: z.number().int().positive(),
    claimedAt: z.string(),
  })
  .passthrough()

const GenerationRecordSchema = z
  .object({ storageThreadId: z.string(), generation: z.number().int().nonnegative() })
  .passthrough()

// A persisted record that does not parse fails closed: it is never treated as absent or as someone else's.
function parseFenceRecord(value: unknown): z.infer<typeof FenceRecordSchema> {
  const parsed = FenceRecordSchema.safeParse(value)
  if (!parsed.success) throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_INVALID')
  return parsed.data
}

function parseGenerationRecord(value: unknown): z.infer<typeof GenerationRecordSchema> {
  const parsed = GenerationRecordSchema.safeParse(value)
  if (!parsed.success) throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_INVALID')
  return parsed.data
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LegacyRetirementError('LEGACY_READ_BOUND_INVALID')
  }
  return value
}

function defaultVerifyPlan(value: unknown): VerifiedPlanIdentity {
  const plan = assertExecutionPlanIntegrity(value)
  const parsed = GraphReferenceSchema.safeParse(plan.graph?.reference)
  return {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    ...(parsed.success ? { graph: parsed.data } : {}),
  }
}

/** Same identity rule as the retirement inventory: the first two separators delimit the identifiers. */
function parseStorageThread(
  storageThreadId: string
): { workspaceId: string; executionId: string } | undefined {
  const first = storageThreadId.indexOf(':')
  const second = first === -1 ? -1 : storageThreadId.indexOf(':', first + 1)
  if (first === -1 || second === -1) return undefined
  const workspaceId = storageThreadId.slice(0, first)
  const executionId = storageThreadId.slice(first + 1, second)
  if (!workspaceId.startsWith('wsp_') || !executionId.startsWith('exe_')) return undefined
  return { workspaceId, executionId }
}

async function scanAll(
  tx: PersistenceTransaction,
  namespace: string,
  pageSize: number,
  maximumRecords: number
): Promise<{ records: PersistenceRecord[]; complete: boolean }> {
  const records: PersistenceRecord[] = []
  let afterId: string | undefined
  for (;;) {
    const limit = Math.min(pageSize, maximumRecords - records.length)
    const cursor = afterId === undefined ? {} : { afterId }
    if (limit <= 0) {
      // One probe distinguishes "exactly at the budget" from "more records remain".
      const probe = await tx.scan(namespace, { limit: 1, ...cursor })
      return { records, complete: probe.length === 0 }
    }
    const page = await tx.scan(namespace, { limit, ...cursor })
    records.push(...page)
    if (page.length < limit) return { records, complete: true }
    afterId = page[page.length - 1]?.id
  }
}

interface ExecutionObservation {
  readonly state: string
  readonly workspaceId?: string
  readonly pin?: { readonly executionPlanId: string; readonly contentDigest: string }
}

function classifyThread(
  storageThreadId: string,
  executions: ReadonlyMap<string, ExecutionObservation>,
  executionsComplete: boolean
): {
  classification: ThreadClassification
  blockers: string[]
  workspaceId?: string
  executionId?: string
  execution?: ExecutionObservation
} {
  const parsed = parseStorageThread(storageThreadId)
  if (parsed === undefined) {
    return { classification: 'unclassified', blockers: ['THREAD_IDENTITY_UNPARSEABLE'] }
  }
  const { workspaceId, executionId } = parsed
  const execution = executions.get(executionId)
  if (execution === undefined) {
    return executionsComplete
      ? { classification: 'orphaned', blockers: ['ORPHANED_THREAD'], workspaceId, executionId }
      : {
          classification: 'unknown',
          blockers: ['EXECUTIONS_NOT_FULLY_READ'],
          workspaceId,
          executionId,
        }
  }
  if (execution.workspaceId !== undefined && execution.workspaceId !== workspaceId) {
    return {
      classification: 'unclassified',
      blockers: ['THREAD_EXECUTION_MISMATCH'],
      workspaceId,
      executionId,
      execution,
    }
  }
  if (UNCERTAIN_EXECUTION_STATES.has(execution.state)) {
    return {
      classification: 'uncertain-effect',
      blockers: ['UNCERTAIN_EFFECT_UNRECONCILED'],
      workspaceId,
      executionId,
      execution,
    }
  }
  if (TERMINAL_EXECUTION_STATES.has(execution.state)) {
    return { classification: 'terminal', blockers: [], workspaceId, executionId, execution }
  }
  return {
    classification: 'in-flight',
    blockers: ['IN_FLIGHT_WORK'],
    workspaceId,
    executionId,
    execution,
  }
}

/**
 * Bounded, read-only observation of retained legacy LangGraph work. Each namespace is read in pages
 * up to a fixed budget. Incomplete reads report lower bounds, and a zero claim is never made from them.
 * Non-terminal executions without a checkpoint thread are reported too, so no live work is hidden.
 * Unparseable or unsupported-version checkpoint records block a zero claim: they cannot be ruled out as live work.
 */
export async function readLegacyRemainder(
  provider: PersistenceProvider,
  options: ReadOptions
): Promise<LegacyRemainder> {
  const pageSize = boundedInteger(options.pageSize ?? 64, 1, 128)
  const maximumRecords = boundedInteger(options.maximumRecords ?? 10_000, 1, 100_000)
  const verifyPlan = options.verifyPlan ?? defaultVerifyPlan

  return provider.transaction(async (tx) => {
    const checkpointScan = await scanAll(tx, LEGACY_CHECKPOINT_NAMESPACE, pageSize, maximumRecords)
    const executionScan = await scanAll(tx, LEGACY_EXECUTION_NAMESPACE, pageSize, maximumRecords)
    const planScan = await scanAll(tx, LEGACY_EXECUTION_PLAN_NAMESPACE, pageSize, maximumRecords)

    let checkpoints = 0
    let writes = 0
    let unparseableCheckpointRecords = 0
    let unsupportedVersionCheckpointRecords = 0
    const threadKeys = new Map<string, { scope: string; thread: string }>()
    for (const record of checkpointScan.records) {
      const parsed = CheckpointRowSchema.safeParse(record.value)
      if (!parsed.success) {
        unparseableCheckpointRecords += 1
        const probe = VersionProbeSchema.safeParse(record.value)
        if (probe.success && probe.data.version !== undefined && probe.data.version !== 1) {
          unsupportedVersionCheckpointRecords += 1
        }
        continue
      }
      const { scope, thread, kind } = parsed.data
      if (kind === 'checkpoint') checkpoints += 1
      else writes += 1
      const key = `${scope}\u0000${thread}`
      if (!threadKeys.has(key)) threadKeys.set(key, { scope, thread })
    }

    const executions = new Map<string, ExecutionObservation>()
    let malformedExecutions = 0
    let inFlightExecutions = 0
    for (const record of executionScan.records) {
      const parsed = ExecutionRowSchema.safeParse(record.value)
      if (!parsed.success) {
        malformedExecutions += 1
        continue
      }
      const { executionId, state, correlation, executionPlan } = parsed.data
      if (!TERMINAL_EXECUTION_STATES.has(state)) inFlightExecutions += 1
      const workspaceId = correlation?.workspaceId
      const pin =
        executionPlan === undefined
          ? undefined
          : {
              executionPlanId: executionPlan.executionPlanId,
              contentDigest: executionPlan.contentDigest,
            }
      executions.set(executionId, {
        state,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(pin === undefined ? {} : { pin }),
      })
    }

    const verifiedPlans = new Map<string, VerifiedPlanIdentity | undefined>()
    let unparseablePlans = 0
    let plansUnverified = 0
    for (const record of planScan.records) {
      const identity = PlanIdentitySchema.safeParse(record.value)
      if (!identity.success) {
        unparseablePlans += 1
        continue
      }
      const planId = identity.data.executionPlanId
      try {
        verifiedPlans.set(planId, verifyPlan(record.value))
      } catch {
        verifiedPlans.set(planId, undefined)
        plansUnverified += 1
      }
    }

    // Graph identity is trusted only when a verified plan matches the execution's exact pin.
    const identityOf = (
      pin: ExecutionObservation['pin']
    ): { planVerification: PlanVerification; graph?: GraphReference } => {
      if (pin === undefined || !verifiedPlans.has(pin.executionPlanId)) {
        return { planVerification: 'absent' }
      }
      const verified = verifiedPlans.get(pin.executionPlanId)
      const matches =
        verified !== undefined &&
        verified.executionPlanId === pin.executionPlanId &&
        verified.contentDigest === pin.contentDigest
      if (!matches) return { planVerification: 'unverified' }
      return verified.graph === undefined
        ? { planVerification: 'verified' }
        : { planVerification: 'verified', graph: verified.graph }
    }

    const executionsComplete = executionScan.complete
    const byClassification: Record<ThreadClassification, number> = {
      'in-flight': 0,
      'uncertain-effect': 0,
      terminal: 0,
      orphaned: 0,
      unclassified: 0,
      unknown: 0,
    }
    const items: LegacyWorkItem[] = []
    const threadExecutionIds = new Set<string>()
    for (const { thread, scope } of threadKeys.values()) {
      const classified = classifyThread(thread, executions, executionsComplete)
      byClassification[classified.classification] += 1
      if (classified.executionId !== undefined) threadExecutionIds.add(classified.executionId)
      const identity = identityOf(classified.execution?.pin)
      items.push({
        kind: 'checkpoint-thread',
        identity: thread,
        scope,
        ...(classified.workspaceId === undefined ? {} : { workspaceId: classified.workspaceId }),
        ...(classified.executionId === undefined ? {} : { executionId: classified.executionId }),
        ...(classified.execution === undefined
          ? {}
          : { executionState: classified.execution.state }),
        classification: classified.classification,
        planVerification: identity.planVerification,
        ...(identity.graph === undefined ? {} : { graph: identity.graph }),
        blockers: classified.blockers,
      })
    }

    // Live work can exist without a checkpoint thread, for example an execution that failed before its first checkpoint.
    let executionOnly = 0
    for (const [executionId, execution] of executions) {
      if (TERMINAL_EXECUTION_STATES.has(execution.state) || threadExecutionIds.has(executionId))
        continue
      const uncertain = UNCERTAIN_EXECUTION_STATES.has(execution.state)
      const classification: ThreadClassification = uncertain ? 'uncertain-effect' : 'in-flight'
      byClassification[classification] += 1
      executionOnly += 1
      const identity = identityOf(execution.pin)
      items.push({
        kind: 'execution-only',
        identity: `execution:${executionId}`,
        executionId,
        executionState: execution.state,
        ...(execution.workspaceId === undefined ? {} : { workspaceId: execution.workspaceId }),
        classification,
        planVerification: identity.planVerification,
        ...(identity.graph === undefined ? {} : { graph: identity.graph }),
        blockers: [uncertain ? 'UNCERTAIN_EFFECT_UNRECONCILED' : 'IN_FLIGHT_WORK'],
      })
    }

    const complete = checkpointScan.complete && executionsComplete && planScan.complete
    const threadCount = items.filter((item) => item.kind === 'checkpoint-thread').length
    const zeroReasons: string[] = []
    if (options.observationScope !== 'deployed-dsn') {
      zeroReasons.push('DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO')
    }
    if (options.observationScope === 'deployed-dsn' && options.attestation === undefined) {
      zeroReasons.push('DEPLOYED_ATTESTATION_MISSING')
    }
    if (!complete) zeroReasons.push('READ_INCOMPLETE')
    if (threadCount > 0) zeroReasons.push('RETAINED_THREADS_PRESENT')
    if (inFlightExecutions > 0) zeroReasons.push('IN_FLIGHT_EXECUTIONS_PRESENT')
    if (malformedExecutions > 0) zeroReasons.push('MALFORMED_EXECUTION_RECORDS_PRESENT')
    if (unparseableCheckpointRecords > 0) {
      zeroReasons.push('UNPARSEABLE_CHECKPOINT_RECORDS_PRESENT')
    }

    return {
      observationScope: options.observationScope,
      observation: complete ? 'observed' : 'incomplete',
      exact: complete,
      truncated: {
        checkpoints: !checkpointScan.complete,
        executions: !executionsComplete,
        plans: !planScan.complete,
      },
      counts: {
        threads: threadCount,
        executionOnly,
        checkpoints,
        writes,
        unparseableCheckpointRecords,
        unsupportedVersionCheckpointRecords,
        executions: executionScan.records.length,
        inFlightExecutions,
        malformedExecutions,
        plans: planScan.records.length,
        unparseablePlans,
        plansUnverified,
        byClassification,
      },
      items,
      zero: { established: zeroReasons.length === 0, reasons: zeroReasons },
    }
  })
}

function replacementFor(
  graph: GraphReference,
  replacements: readonly ReplacementEvidence[]
): ReplacementEvidence | undefined {
  return replacements.find(
    (item) =>
      item.graph.graphDefinitionId === graph.graphDefinitionId &&
      item.graph.graphVersion === graph.graphVersion &&
      item.graph.contentDigest === graph.contentDigest
  )
}

function proofFor(graph: GraphReference, proofs: readonly ProofEvidence[]): boolean {
  return proofs.some(
    (item) =>
      item.outcome === 'proven' &&
      item.graph.graphDefinitionId === graph.graphDefinitionId &&
      item.graph.graphVersion === graph.graphVersion &&
      item.graph.contentDigest === graph.contentDigest
  )
}

/** A graph is covered only by an evidence-equivalent replacement with proven profile and failure evidence. */
function coveredFor(
  graph: GraphReference,
  evidence: {
    readonly replacements: readonly ReplacementEvidence[]
    readonly profiles: readonly ProofEvidence[]
    readonly failures: readonly ProofEvidence[]
  }
): boolean {
  return (
    replacementFor(graph, evidence.replacements)?.outcome === 'evidence-equivalent' &&
    proofFor(graph, evidence.profiles) &&
    proofFor(graph, evidence.failures)
  )
}

/**
 * Per-item owner selection and handoff blockers. Owner stays with the legacy saver unless an
 * evidence-equivalent replacement exists for the item's exact graph and its profile and failure
 * evidence is proven. Removal additionally requires coverage of every admissible graph, so a zero
 * count alone never satisfies it. Dependencies stay retained until the removal condition is satisfied.
 */
export function planLegacyDrain(
  remainder: LegacyRemainder,
  evidence: {
    readonly replacements?: readonly ReplacementEvidence[]
    readonly profiles?: readonly ProofEvidence[]
    readonly failures?: readonly ProofEvidence[]
    readonly admissibleGraphs?: readonly GraphReference[]
  } = {}
): LegacyDrainPlan {
  const replacements = evidence.replacements ?? []
  const profiles = evidence.profiles ?? []
  const failures = evidence.failures ?? []
  const admissibleGraphs = evidence.admissibleGraphs ?? []
  const items: DrainItemPlan[] = remainder.items.map((item) => {
    const ownerReasons: string[] = []
    let selectedOwner: DrainItemPlan['selectedOwner'] = LEGACY_SAVER_OWNER
    if (item.graph === undefined) {
      ownerReasons.push(
        item.planVerification === 'unverified' ? 'PLAN_UNVERIFIED' : 'GRAPH_IDENTITY_UNKNOWN'
      )
    } else {
      const replacement = replacementFor(item.graph, replacements)
      if (replacement === undefined) ownerReasons.push('NO_COMPATIBLE_REPLACEMENT_EVIDENCE')
      else if (replacement.outcome === 'evidence-divergent') ownerReasons.push('EVIDENCE_DIVERGENT')
      else if (!proofFor(item.graph, profiles) || !proofFor(item.graph, failures)) {
        ownerReasons.push('PROFILE_OR_FAILURE_EVIDENCE_UNPROVEN')
      } else {
        selectedOwner = TYPED_REPLACEMENT_OWNER
        ownerReasons.push('EVIDENCE_EQUIVALENT_PROVEN')
      }
    }
    if (selectedOwner === LEGACY_SAVER_OWNER && ownerReasons.length === 0) {
      ownerReasons.push('LEGACY_OWNER_RETAINED')
    }
    const blockers = [...item.blockers]
    if (remainder.observation !== 'observed') blockers.push('READ_INCOMPLETE')
    return {
      identity: item.identity,
      classification: item.classification,
      selectedOwner,
      ownerReasons,
      blockers,
      handoffEligible: blockers.length === 0 && selectedOwner === TYPED_REPLACEMENT_OWNER,
    }
  })
  const handoffEligible =
    items.length > 0 &&
    remainder.observation === 'observed' &&
    items.every((item) => item.handoffEligible)
  const coverage = { replacements, profiles, failures }
  const admissibleCovered =
    admissibleGraphs.length > 0 && admissibleGraphs.every((graph) => coveredFor(graph, coverage))
  const satisfied =
    remainder.zero.established && admissibleCovered && items.every((item) => item.handoffEligible)
  const removalReasons = [...remainder.zero.reasons]
  if (admissibleGraphs.length === 0) removalReasons.push('NO_ADMISSIBLE_GRAPHS_OBSERVED')
  else if (!admissibleCovered) removalReasons.push('ADMISSIBLE_GRAPHS_NOT_COVERED')
  if (items.some((item) => item.selectedOwner === LEGACY_SAVER_OWNER)) {
    removalReasons.push('LEGACY_OWNER_RETAINED')
  }
  return {
    observation: remainder.observation,
    items,
    handoffEligible,
    // The namespace and saver composition stay until removal holds, not merely until handoff is possible.
    retainedDependencies: satisfied
      ? []
      : ['langgraph-checkpoints-v1 namespace', 'LangGraph checkpoint saver composition'],
    removal: {
      condition: LEGACY_GRAPH_API.removalCondition,
      satisfied,
      reasons: satisfied ? [] : removalReasons,
    },
  }
}

function fenceId(storageThreadId: string): string {
  return `fence:${createHash('sha256').update(storageThreadId).digest('hex')}`
}

function requireIdentifier(value: string): string {
  if (value.length === 0 || value.length > 256)
    throw new LegacyRetirementError('LEGACY_FENCE_INVALID')
  return value
}

// The largest generation a claim issues, and the largest handle counter a release accepts. The PostgreSQL repository's
// counter() accepts the same range, so both stores refuse the same values.
const MAXIMUM_CLAIM_GENERATION = Number.MAX_SAFE_INTEGER - 1

// The generation after previous. Refused before any write when previous is not a safe non-negative integer, or when
// the new generation's handle could not be released.
function nextGeneration(previous: number): number {
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= MAXIMUM_CLAIM_GENERATION) {
    throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_STATE_INVALID')
  }
  return previous + 1
}

function requireHandleCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_CLAIM_GENERATION) {
    throw new LegacyRetirementError('LEGACY_FENCE_INVALID')
  }
}

/**
 * A claim handle, returned by claimLegacyDrainFence and required by releaseLegacyDrainFence. A release
 * matches the exact generation and live revision, so a stale handle cannot release a later claim.
 * Generations are monotonic per thread and survive releases, so a reclaim never reuses one.
 */
export interface LegacyDrainFenceClaim {
  readonly storageThreadId: string
  readonly owner: string
  readonly generation: number
  readonly revision: number
}

/**
 * Claims the handoff fence for a legacy thread. A second owner is refused until the first releases it.
 * The live record survives a physical restart in the existing persistence transaction. Claiming again
 * with the same owner while held is idempotent: it returns the held handle and does not advance the
 * generation. Both writes use the persistence layer's revision CAS.
 */
export async function claimLegacyDrainFence(
  provider: PersistenceProvider,
  input: { readonly storageThreadId: string; readonly owner: string; readonly now?: () => string }
): Promise<LegacyDrainFenceClaim> {
  const storageThreadId = requireIdentifier(input.storageThreadId)
  const owner = requireIdentifier(input.owner)
  const now = input.now ?? (() => new Date().toISOString())
  return provider.transaction(async (tx) => {
    const id = fenceId(storageThreadId)
    const live = await tx.get(LEGACY_DRAIN_FENCE_NAMESPACE, id)
    if (live !== undefined) {
      const record = parseFenceRecord(live.value)
      if (record.owner !== owner) throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_HELD')
      return { storageThreadId, owner, generation: record.generation, revision: live.revision }
    }
    const counter = await tx.get(LEGACY_DRAIN_FENCE_GENERATION_NAMESPACE, id)
    const previous = counter === undefined ? 0 : parseGenerationRecord(counter.value).generation
    const generation = nextGeneration(previous)
    // The counter is never deleted, so its revision only grows. An update names the revision it read.
    await tx.put({
      namespace: LEGACY_DRAIN_FENCE_GENERATION_NAMESPACE,
      id,
      ...(counter === undefined ? {} : { expectedRevision: counter.revision }),
      value: { storageThreadId, generation },
    })
    // The live record was absent in this transaction, so a write without expectedRevision is create-only.
    const written = await tx.put({
      namespace: LEGACY_DRAIN_FENCE_NAMESPACE,
      id,
      value: { storageThreadId, owner, generation, claimedAt: now() },
    })
    // A revision that release would refuse must not be returned. Throwing here rolls back the counter write too.
    requireHandleCounter(written.revision)
    return { storageThreadId, owner, generation, revision: written.revision }
  })
}

/**
 * Releases the fence only for the exact handle that claimed it. Returns false when nothing is held.
 * A handle from an earlier generation or revision is refused with LEGACY_DRAIN_FENCE_STALE, and a handle
 * for another owner with LEGACY_DRAIN_FENCE_NOT_OWNED. Nothing is deleted in either refusal.
 */
export async function releaseLegacyDrainFence(
  provider: PersistenceProvider,
  claim: LegacyDrainFenceClaim
): Promise<boolean> {
  const storageThreadId = requireIdentifier(claim.storageThreadId)
  const owner = requireIdentifier(claim.owner)
  requireHandleCounter(claim.generation)
  requireHandleCounter(claim.revision)
  return provider.transaction(async (tx) => {
    const id = fenceId(storageThreadId)
    const live = await tx.get(LEGACY_DRAIN_FENCE_NAMESPACE, id)
    if (live === undefined) return false
    const record = parseFenceRecord(live.value)
    if (record.owner !== owner) throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_NOT_OWNED')
    if (record.generation !== claim.generation || live.revision !== claim.revision) {
      throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_STALE')
    }
    // The revision was verified in this transaction, so the delete is an exact-revision CAS.
    return tx.delete(LEGACY_DRAIN_FENCE_NAMESPACE, id, live.revision)
  })
}

/** Resume and continue are refused while any owner holds the thread's handoff fence. */
export function createLegacyResumeFence(provider: PersistenceProvider): {
  assertResumeAllowed(storageThreadId: string): Promise<void>
} {
  return {
    async assertResumeAllowed(storageThreadId) {
      const held = await provider.transaction((tx) =>
        tx.get(LEGACY_DRAIN_FENCE_NAMESPACE, fenceId(storageThreadId))
      )
      if (held !== undefined) throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_HELD')
    },
  }
}

export interface AdmissionEvidence {
  /**
   * Absent when this composition observed no inventory. An absent remainder is never closure-eligible, and it is
   * never replaced by fabricated counts.
   */
  readonly remainder?: LegacyRemainder
  /** Every legacy graph version that new admissions could currently use. */
  readonly admissibleGraphs: readonly GraphReference[]
  readonly replacements: readonly ReplacementEvidence[]
  readonly profiles: readonly ProofEvidence[]
  readonly failures: readonly ProofEvidence[]
  /** Explicit operator intent. Nothing in this repository sets it. */
  readonly closureRequested: boolean
  /** True when the request's execution retains an uncertain effect. Admission is refused until it is reconciled. */
  readonly retainedUncertainEffect?: boolean
}

export type AdmissionDecision = {
  readonly decision: 'open' | 'closure-eligible'
  readonly reasons: readonly string[]
}

/**
 * Decides whether closing new legacy admissions is eligible. The default is open, and eligibility
 * requires deployed-dsn zero, evidence for every admissible graph, and an explicit closure request.
 * It performs no action.
 */
export function evaluateLegacyAdmissionGate(evidence: AdmissionEvidence): AdmissionDecision {
  const reasons: string[] = []
  if (evidence.remainder === undefined) {
    reasons.push('REMAINING_NOT_OBSERVED')
  } else {
    if (evidence.remainder.observationScope !== 'deployed-dsn') {
      reasons.push('REMAINING_NOT_DEPLOYED_SCOPE')
    }
    if (!evidence.remainder.zero.established) reasons.push('REMAINING_ZERO_NOT_ESTABLISHED')
  }
  if (evidence.admissibleGraphs.length === 0) reasons.push('NO_ADMISSIBLE_GRAPHS_OBSERVED')
  for (const graph of evidence.admissibleGraphs) {
    const label = `${graph.graphDefinitionId}@${graph.graphVersion}`
    const replacement = replacementFor(graph, evidence.replacements)
    if (replacement === undefined || replacement.outcome !== 'evidence-equivalent') {
      reasons.push(`REPLACEMENT_NOT_EQUIVALENT:${label}`)
    }
    if (!proofFor(graph, evidence.profiles)) reasons.push(`PROFILE_UNPROVEN:${label}`)
    if (!proofFor(graph, evidence.failures)) reasons.push(`FAILURE_UNPROVEN:${label}`)
  }
  if (!evidence.closureRequested) reasons.push('CLOSURE_NOT_REQUESTED')
  return { decision: reasons.length === 0 ? 'closure-eligible' : 'open', reasons }
}

/**
 * The admission the guard is asked about. A retained uncertain effect is checked per execution, so one
 * unreconciled effect cannot be started again while it is retained.
 */
export interface LegacyAdmissionRequest {
  readonly executionId: string
  readonly storageThreadId: string
}

/**
 * New-admission guard. It refuses a request whose execution retains an uncertain effect, whatever the gate says.
 * Otherwise it refuses only when closure is eligible and was explicitly requested.
 */
export function createLegacyAdmissionGuard(
  evaluate: (request: LegacyAdmissionRequest) => Promise<AdmissionEvidence> | AdmissionEvidence
): { assertNewAdmissionAllowed(request: LegacyAdmissionRequest): Promise<void> } {
  return {
    async assertNewAdmissionAllowed(request) {
      const evidence = await evaluate(request)
      if (evidence.retainedUncertainEffect === true) {
        throw new LegacyRetirementError('LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED')
      }
      const decision = evaluateLegacyAdmissionGate(evidence)
      if (decision.decision === 'closure-eligible') {
        throw new LegacyRetirementError('LEGACY_ADMISSION_CLOSED')
      }
    },
  }
}

export interface LegacyOperatorStatusEntry {
  readonly identity: string
  readonly kind: LegacyWorkItem['kind']
  readonly classification: ThreadClassification
  readonly executionState?: string
  readonly planVerification: PlanVerification
  readonly selectedOwner: DrainItemPlan['selectedOwner']
  readonly ownerReasons: readonly string[]
  readonly blockers: readonly string[]
}

export interface LegacyOperatorStatus {
  readonly schema: typeof LEGACY_STATUS_SCHEMA
  readonly api: { readonly path: string; readonly version: string; readonly lifecycle: string }
  readonly scope: ObservationScope
  /** False when a read was truncated or any retained record could not be parsed or verified. */
  readonly readComplete: boolean
  readonly exact: boolean
  readonly zero: LegacyRemainder['zero']
  readonly counts: LegacyRemainder['counts']
  readonly blockers: Readonly<Record<string, number>>
  readonly owners: Readonly<Record<string, number>>
  readonly retainedDependencies: readonly string[]
  readonly removal: LegacyDrainPlan['removal']
  readonly admission?: AdmissionDecision
  readonly items: {
    readonly total: number
    readonly shown: number
    readonly truncated: boolean
    readonly entries: readonly LegacyOperatorStatusEntry[]
  }
}

function compareIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Bounded operator status: counts, blocker and owner tallies, removal and admission decisions, and at
 * most LEGACY_STATUS_ITEM_LIMIT work items in identity order. It contains no store paths or record payloads.
 */
export function buildLegacyOperatorStatus(input: {
  readonly remainder: LegacyRemainder
  readonly plan: LegacyDrainPlan
  readonly admission?: AdmissionDecision
}): LegacyOperatorStatus {
  const { remainder, plan } = input
  if (plan.items.length !== remainder.items.length) {
    throw new LegacyRetirementError('LEGACY_STATUS_PLAN_MISMATCH')
  }
  const blockers: Record<string, number> = {}
  const owners: Record<string, number> = {}
  for (const item of plan.items) {
    owners[item.selectedOwner] = (owners[item.selectedOwner] ?? 0) + 1
    for (const blocker of item.blockers) blockers[blocker] = (blockers[blocker] ?? 0) + 1
  }
  // The plan is derived from this remainder, so its items align by position. A mismatch is refused, never guessed.
  const entries: LegacyOperatorStatusEntry[] = remainder.items
    .map((item, index) => {
      const decision = plan.items[index]
      if (decision === undefined || decision.identity !== item.identity) {
        throw new LegacyRetirementError('LEGACY_STATUS_PLAN_MISMATCH')
      }
      return {
        identity: item.identity,
        kind: item.kind,
        classification: item.classification,
        ...(item.executionState === undefined ? {} : { executionState: item.executionState }),
        planVerification: item.planVerification,
        selectedOwner: decision.selectedOwner,
        ownerReasons: decision.ownerReasons,
        blockers: decision.blockers,
      }
    })
    .toSorted((left, right) => compareIdentity(left.identity, right.identity))
  const shown = entries.slice(0, LEGACY_STATUS_ITEM_LIMIT)
  return {
    schema: LEGACY_STATUS_SCHEMA,
    api: {
      path: LEGACY_GRAPH_API.path,
      version: LEGACY_GRAPH_API.version,
      lifecycle: LEGACY_GRAPH_API.lifecycle,
    },
    scope: remainder.observationScope,
    readComplete: remainder.observation === 'observed',
    exact: remainder.exact,
    zero: remainder.zero,
    counts: remainder.counts,
    blockers,
    owners,
    retainedDependencies: plan.retainedDependencies,
    removal: plan.removal,
    ...(input.admission === undefined ? {} : { admission: input.admission }),
    items: {
      total: entries.length,
      shown: shown.length,
      truncated: entries.length > shown.length,
      entries: shown,
    },
  }
}
