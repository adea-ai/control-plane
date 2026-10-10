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
// deployed-dsn attestation and complete reads.

export const LEGACY_CHECKPOINT_NAMESPACE = 'langgraph-checkpoints-v1'
export const LEGACY_EXECUTION_NAMESPACE = 'executions'
export const LEGACY_EXECUTION_PLAN_NAMESPACE = 'execution-plans'
export const LEGACY_DRAIN_FENCE_NAMESPACE = 'langgraph-legacy-drain-fences'
export const LEGACY_SAVER_OWNER = 'legacy-langgraph-saver'
export const TYPED_REPLACEMENT_OWNER = 'typed-replacement'

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
    readonly executions: number
    readonly inFlightExecutions: number
    readonly malformedExecutions: number
    readonly plans: number
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
const FenceRecordSchema = z.object({ owner: z.string() }).passthrough()

function fenceOwner(value: unknown): string | undefined {
  const parsed = FenceRecordSchema.safeParse(value)
  return parsed.success ? parsed.data.owner : undefined
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
    const threadKeys = new Map<string, { scope: string; thread: string }>()
    for (const record of checkpointScan.records) {
      const parsed = CheckpointRowSchema.safeParse(record.value)
      if (!parsed.success) {
        unparseableCheckpointRecords += 1
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
    for (const record of planScan.records) {
      const identity = PlanIdentitySchema.safeParse(record.value)
      if (!identity.success) continue
      const planId = identity.data.executionPlanId
      try {
        verifiedPlans.set(planId, verifyPlan(record.value))
      } catch {
        verifiedPlans.set(planId, undefined)
      }
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
      const pin = classified.execution?.pin
      const verified = pin === undefined ? undefined : verifiedPlans.get(pin.executionPlanId)
      const graph =
        verified !== undefined &&
        pin !== undefined &&
        verified.executionPlanId === pin.executionPlanId &&
        verified.contentDigest === pin.contentDigest
          ? verified.graph
          : undefined
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
        ...(graph === undefined ? {} : { graph }),
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
      items.push({
        kind: 'execution-only',
        identity: `execution:${executionId}`,
        executionId,
        executionState: execution.state,
        ...(execution.workspaceId === undefined ? {} : { workspaceId: execution.workspaceId }),
        classification,
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
        executions: executionScan.records.length,
        inFlightExecutions,
        malformedExecutions,
        plans: planScan.records.length,
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

/**
 * Per-item owner selection and handoff blockers. Owner stays with the legacy saver unless an
 * evidence-equivalent replacement exists for the item's exact graph and its profile and failure
 * evidence is proven. Any blocker, incomplete read, or non-terminal work retains dependencies.
 */
export function planLegacyDrain(
  remainder: LegacyRemainder,
  evidence: {
    readonly replacements?: readonly ReplacementEvidence[]
    readonly profiles?: readonly ProofEvidence[]
    readonly failures?: readonly ProofEvidence[]
  } = {}
): LegacyDrainPlan {
  const replacements = evidence.replacements ?? []
  const profiles = evidence.profiles ?? []
  const failures = evidence.failures ?? []
  const items: DrainItemPlan[] = remainder.items.map((item) => {
    const ownerReasons: string[] = []
    let selectedOwner: DrainItemPlan['selectedOwner'] = LEGACY_SAVER_OWNER
    if (item.graph === undefined) {
      ownerReasons.push('GRAPH_IDENTITY_UNKNOWN')
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
  const unresolved =
    remainder.observation !== 'observed' ||
    items.some((item) => item.blockers.length > 0 || item.selectedOwner === LEGACY_SAVER_OWNER)
  const handoffEligible =
    items.length > 0 &&
    remainder.observation === 'observed' &&
    items.every((item) => item.handoffEligible)
  const removalReasons = [...remainder.zero.reasons]
  if (items.some((item) => item.selectedOwner === LEGACY_SAVER_OWNER)) {
    removalReasons.push('LEGACY_OWNER_RETAINED')
  }
  const satisfied = remainder.zero.established && items.every((item) => item.handoffEligible)
  return {
    observation: remainder.observation,
    items,
    handoffEligible,
    retainedDependencies: unresolved
      ? ['langgraph-checkpoints-v1 namespace', 'LangGraph checkpoint saver composition']
      : [],
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

/**
 * Claims the handoff fence for a legacy thread. A second owner is refused until the first releases it.
 * The fence is a revision-checked record in the existing persistence transaction, so it survives a
 * physical restart. Claiming again with the same owner is idempotent.
 */
export async function claimLegacyDrainFence(
  provider: PersistenceProvider,
  input: { readonly storageThreadId: string; readonly owner: string; readonly now?: () => string }
): Promise<{
  readonly storageThreadId: string
  readonly owner: string
  readonly revision: number
}> {
  const storageThreadId = requireIdentifier(input.storageThreadId)
  const owner = requireIdentifier(input.owner)
  const now = input.now ?? (() => new Date().toISOString())
  return provider.transaction(async (tx) => {
    const id = fenceId(storageThreadId)
    const existing = await tx.get(LEGACY_DRAIN_FENCE_NAMESPACE, id)
    if (existing !== undefined) {
      if (fenceOwner(existing.value) === owner) {
        return { storageThreadId, owner, revision: existing.revision }
      }
      throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_HELD')
    }
    const written = await tx.put({
      namespace: LEGACY_DRAIN_FENCE_NAMESPACE,
      id,
      value: { storageThreadId, owner, claimedAt: now() },
    })
    return { storageThreadId, owner, revision: written.revision }
  })
}

/** Releases only the owner's fence, checked against the exact revision it created. */
export async function releaseLegacyDrainFence(
  provider: PersistenceProvider,
  input: { readonly storageThreadId: string; readonly owner: string }
): Promise<boolean> {
  const storageThreadId = requireIdentifier(input.storageThreadId)
  const owner = requireIdentifier(input.owner)
  return provider.transaction(async (tx) => {
    const id = fenceId(storageThreadId)
    const existing = await tx.get(LEGACY_DRAIN_FENCE_NAMESPACE, id)
    if (existing === undefined) return false
    if (fenceOwner(existing.value) !== owner) {
      throw new LegacyRetirementError('LEGACY_DRAIN_FENCE_NOT_OWNED')
    }
    return tx.delete(LEGACY_DRAIN_FENCE_NAMESPACE, id, existing.revision)
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
  readonly remainder: LegacyRemainder
  /** Every legacy graph version that new admissions could currently use. */
  readonly admissibleGraphs: readonly GraphReference[]
  readonly replacements: readonly ReplacementEvidence[]
  readonly profiles: readonly ProofEvidence[]
  readonly failures: readonly ProofEvidence[]
  /** Explicit operator intent. Nothing in this repository sets it. */
  readonly closureRequested: boolean
}

/**
 * Decides whether closing new legacy admissions is eligible. The default is open, and eligibility
 * requires deployed-dsn zero, evidence for every admissible graph, and an explicit closure request.
 * It performs no action.
 */
export function evaluateLegacyAdmissionGate(evidence: AdmissionEvidence): {
  readonly decision: 'open' | 'closure-eligible'
  readonly reasons: readonly string[]
} {
  const reasons: string[] = []
  if (evidence.remainder.observationScope !== 'deployed-dsn') {
    reasons.push('REMAINING_NOT_DEPLOYED_SCOPE')
  }
  if (!evidence.remainder.zero.established) reasons.push('REMAINING_ZERO_NOT_ESTABLISHED')
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

/** New-admission guard: refuses only when eligibility is established and closure was explicitly requested. */
export function createLegacyAdmissionGuard(
  evaluate: () => Promise<AdmissionEvidence> | AdmissionEvidence
): { assertNewAdmissionAllowed(): Promise<void> } {
  return {
    async assertNewAdmissionAllowed() {
      const decision = evaluateLegacyAdmissionGate(await evaluate())
      if (decision.decision === 'closure-eligible') {
        throw new LegacyRetirementError('LEGACY_ADMISSION_CLOSED')
      }
    },
  }
}
