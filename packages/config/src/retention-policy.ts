import { z } from 'zod'

/**
 * Durable-data retention policy (#194).
 *
 * The M11.9 coverage matrix (docs/evidence/m11-retention-coverage-2026-09-22.md)
 * lists every durable class that needs an explicit retention decision. Those
 * decisions were recorded on 2026-09-24; this module is their machine-readable
 * form so the eligibility work and the operator report read the same values
 * instead of restating durations.
 *
 * `retainMs: null` means "retain for as long as a reference or lifecycle state
 * requires it" — an unbounded retention, never an unbounded sweep. A duration
 * is measured from the class's eligibility instant (terminal state, settled
 * publication, reference release, or the stored expiry), which the eligible
 * deletion path must evaluate; this policy never authorizes deletion on age
 * alone.
 */
export const RetentionClassIdSchema = z.enum([
  'project-state',
  'context-packages',
  'state-proposals',
  'execution-plans',
  'executions',
  'execution-events',
  'command-inbox',
  'messaging',
  'interaction-receipts',
  'runtime-ledgers',
  'native-admission-fences',
  'native-terminal-snapshots',
  'workflow-references',
  'checkpoints',
  'usage',
  'evaluation-runs',
  'logs-traces',
  'artifacts',
  'backups',
  'audit-records',
])

export const RetentionClassPolicySchema = z.object({
  id: RetentionClassIdSchema,
  /** Duration after eligibility; null retains while references require it. */
  retainMs: z.number().int().positive().nullable(),
  /** Role accountable for holds and for approving a deletion change. */
  holdOwner: z.string().min(1).max(64),
})

export const RetentionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Instant the policy takes effect; used for provenance, not expiry. */
    effectiveAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'effectiveAt must be a parseable instant',
    }),
    /** Where the decision is recorded, so an operator can audit it. */
    provenance: z.string().min(1).max(200),
    classes: z.array(RetentionClassPolicySchema),
  })
  .superRefine((policy, context) => {
    const seen = new Set<string>()
    for (const entry of policy.classes) {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: 'custom',
          path: ['classes'],
          message: `Duplicate retention class: ${entry.id}`,
        })
      }
      seen.add(entry.id)
    }
    for (const id of RetentionClassIdSchema.options) {
      if (!seen.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['classes'],
          message: `Missing retention class: ${id}`,
        })
      }
    }
  })

export type RetentionClassId = z.output<typeof RetentionClassIdSchema>
export type RetentionClassPolicy = z.output<typeof RetentionClassPolicySchema>
export type RetentionPolicyConfig = z.output<typeof RetentionPolicySchema>

const day = 24 * 60 * 60 * 1_000

/**
 * Decided policy, 2026-09-24 (issue #194). Durations reuse the accepted
 * operational baselines where one already existed (30-day inbox/event, 7-day
 * terminal ledger, 24-hour command lifetime, 90-day artifacts); classes added
 * here are new decisions, not defaults invented by the implementation.
 */
export const decidedRetentionPolicy: RetentionPolicyConfig = RetentionPolicySchema.parse({
  schemaVersion: 1,
  effectiveAt: '2026-09-24T00:00:00.000Z',
  provenance:
    'issue #194 owner decision recorded 2026-09-24; see docs/evidence/m11-retention-implementation-plan-2026-09-08.md',
  classes: [
    // The live revision is never a deletion candidate; historical revisions
    // stay while a checkpoint, mutation or plan references them.
    { id: 'project-state', retainMs: null, holdOwner: 'workspace-owner' },
    { id: 'context-packages', retainMs: 90 * day, holdOwner: 'workspace-owner' },
    // Unresolved proposals are pending work; resolution ends eligibility.
    { id: 'state-proposals', retainMs: null, holdOwner: 'workspace-owner' },
    { id: 'execution-plans', retainMs: 90 * day, holdOwner: 'platform-operator' },
    { id: 'executions', retainMs: 90 * day, holdOwner: 'platform-operator' },
    { id: 'execution-events', retainMs: 30 * day, holdOwner: 'platform-operator' },
    { id: 'command-inbox', retainMs: 30 * day, holdOwner: 'platform-operator' },
    { id: 'messaging', retainMs: 30 * day, holdOwner: 'platform-operator' },
    { id: 'interaction-receipts', retainMs: 30 * day, holdOwner: 'platform-operator' },
    { id: 'runtime-ledgers', retainMs: 30 * day, holdOwner: 'runtime-owner' },
    // Admission fences are tiny and gate native work; a durable replacement
    // rejection identity has to exist before one can be removed.
    { id: 'native-admission-fences', retainMs: null, holdOwner: 'runtime-owner' },
    { id: 'native-terminal-snapshots', retainMs: 30 * day, holdOwner: 'runtime-owner' },
    { id: 'workflow-references', retainMs: 30 * day, holdOwner: 'platform-operator' },
    // Active and pinned checkpoints are references, never candidates.
    { id: 'checkpoints', retainMs: null, holdOwner: 'platform-operator' },
    // Billing and release evidence outlive operational data.
    { id: 'usage', retainMs: 400 * day, holdOwner: 'billing-owner' },
    { id: 'evaluation-runs', retainMs: 180 * day, holdOwner: 'release-owner' },
    { id: 'logs-traces', retainMs: 30 * day, holdOwner: 'platform-operator' },
    { id: 'artifacts', retainMs: 90 * day, holdOwner: 'release-owner' },
    // Provider capability: Neon PITR window, exercised by the restore drill.
    { id: 'backups', retainMs: 7 * day, holdOwner: 'platform-operator' },
    { id: 'audit-records', retainMs: 400 * day, holdOwner: 'release-owner' },
  ],
})

export function loadRetentionPolicy(
  input: unknown = decidedRetentionPolicy
): RetentionPolicyConfig {
  return RetentionPolicySchema.parse(input)
}

export function retentionClassPolicy(
  policy: RetentionPolicyConfig,
  id: RetentionClassId
): RetentionClassPolicy {
  const entry = policy.classes.find((candidate) => candidate.id === id)
  if (entry === undefined) throw new Error(`RETENTION_CLASS_NOT_CONFIGURED:${id}`)
  return entry
}

/**
 * Rejection-key tombstone epoch (#194 decision): a retired scoped idempotency
 * key may be forgotten only after the longest possible replay of the original
 * command can no longer be valid — the inbox retention window plus the
 * maximum accepted command lifetime. Forgetting earlier could admit a replay
 * as new work.
 */
export function rejectionKeyEpochMs(policy: RetentionPolicyConfig): number {
  const inbox = retentionClassPolicy(policy, 'command-inbox')
  if (inbox.retainMs === null) throw new Error('RETENTION_EPOCH_REQUIRES_BOUNDED_INBOX')
  return inbox.retainMs + MAXIMUM_COMMAND_LIFETIME_MS
}

/** Accepted operational baseline (packages/config/src/operational.ts). */
export const MAXIMUM_COMMAND_LIFETIME_MS = 24 * 60 * 60 * 1_000
