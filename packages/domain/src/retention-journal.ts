import { z } from 'zod'

/**
 * Durable deletion journal (#194, restore-time reapplication).
 *
 * A restored snapshot predates the deletions that happened after it was taken,
 * so restoring one silently resurrects compacted records and drops the
 * rejection identities that keep replays failing closed. The journal is the
 * fix: every deletion pass appends the effects it is about to apply, and
 * `retention-reapply` applies that journal to a restored copy before it is
 * exposed.
 *
 * Ordering rule: entries are appended *before* the storage effect, so a crash
 * between the two leaves an entry for an effect that did not happen. Reapplying
 * such an entry is a no-op (inserts are idempotent, deletes are by identity),
 * which makes the journal at-least-once rather than at-most-once — the safe
 * direction.
 *
 * Operations are explicit per backend instead of a generic row DSL: reapply
 * never builds SQL from journal content, so a tampered journal cannot widen its
 * own authority.
 */
export const RetentionJournalOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sqlite.put'),
    namespace: z.string().min(1).max(128),
    id: z.string().min(1).max(256),
    value: z.json(),
  }),
  z.object({
    kind: z.literal('sqlite.delete'),
    namespace: z.string().min(1).max(128),
    id: z.string().min(1).max(256),
  }),
  z.object({
    kind: z.literal('postgres.retireCommandKey'),
    scopeKey: z.string().min(1).max(64),
    commandId: z.string().min(1).max(30),
    executionId: z.string().min(1).max(30),
    retiredAt: z.string(),
  }),
  z.object({
    kind: z.literal('postgres.deleteCommand'),
    commandId: z.string().min(1).max(30),
  }),
  z.object({
    kind: z.literal('postgres.compactInboxMessage'),
    id: z.string().min(1).max(64),
    compactedAt: z.string(),
  }),
  z.object({
    kind: z.literal('postgres.deleteOutboxEvent'),
    id: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('postgres.deleteContextPackage'),
    contextPackageId: z.string().min(1).max(30),
  }),
  z.object({
    kind: z.literal('postgres.deleteAttempt'),
    attemptId: z.string().min(1).max(30),
  }),
  z.object({
    kind: z.literal('postgres.deleteExecution'),
    executionId: z.string().min(1).max(30),
  }),
  z.object({
    kind: z.literal('postgres.retireEventId'),
    eventId: z.string().min(1).max(30),
    executionId: z.string().min(1).max(30),
    sequence: z.number().int().positive(),
    retiredAt: z.string(),
  }),
  z.object({
    kind: z.literal('postgres.deleteEvent'),
    eventId: z.string().min(1).max(30),
  }),
])

export const RetentionJournalRecordSchema = z.object({
  version: z.literal(1),
  at: z.string(),
  backend: z.enum(['sqlite', 'postgres']),
  classId: z.string().min(1).max(64),
  operations: z.array(RetentionJournalOperationSchema).min(1),
})

export type RetentionJournalOperation = z.output<typeof RetentionJournalOperationSchema>
export type RetentionJournalRecord = z.output<typeof RetentionJournalRecordSchema>

/** Receives the effects one candidate is about to apply. */
export type RetentionJournalSink = (
  operations: readonly RetentionJournalOperation[]
) => Promise<void>

/** Parses one JSONL journal line; throws on anything malformed. */
export function parseRetentionJournalLine(line: string): RetentionJournalRecord {
  return RetentionJournalRecordSchema.parse(JSON.parse(line))
}
