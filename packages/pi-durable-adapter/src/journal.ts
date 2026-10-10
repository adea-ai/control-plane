import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'

export interface JournalRecord {
  handleId: string
  attemptId: string
  startKey: string
  admission: unknown
  at: string
  epoch: number
  state: string
  detail: Record<string, unknown>
}

interface Row {
  body: string
}
interface JournalEvent {
  type: string
  data: Record<string, unknown>
  at: string
}

// Records that may be owned by one live process at a time.
const OWNERSHIP_STATES: readonly string[] = [
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'unknown',
]

/** The fields that make up a process ownership claim. Only claimProcess writes them, and only a
 * release that matches the claim clears them. */
const OWNER_FIELDS = ['ownerPid', 'ownerEpoch', 'ownerClaimId'] as const

/** A process ownership claim. `epoch` is the command epoch the claim produced; command writes and
 * assertOwner check it, and it moves on later command writes. `ownerPid`, `ownerEpoch` and
 * `claimId` are the claim's own fence, stored with the owner fields. They never follow the command
 * epoch, and `claimId` is unique per claim: a transient release restores the command epoch, so a
 * later claim can reuse an epoch number, and the id is what tells the two claims apart. */
export interface ProcessClaim {
  readonly epoch: number
  readonly ownerPid: number
  readonly ownerEpoch: number
  readonly claimId: string
}

function holdsClaim(record: JournalRecord, claim: ProcessClaim): boolean {
  return (
    record.detail['ownerPid'] === claim.ownerPid &&
    record.detail['ownerEpoch'] === claim.ownerEpoch &&
    record.detail['ownerClaimId'] === claim.claimId
  )
}

function clearOwner(detail: Record<string, unknown>): Record<string, unknown> {
  return { ...detail, ownerPid: undefined, ownerEpoch: undefined, ownerClaimId: undefined }
}

/** A detail write carries a snapshot that may predate a claim or outlive its release. While a
 * claim is stored, its owner fields come from the store, so no write can erase or replace them.
 * With no stored claim, a snapshot that still carries a claim id was taken under a claim that has
 * since been released, so none of its owner fields may come back. */
function guardOwner(
  detail: Record<string, unknown>,
  stored: Record<string, unknown>
): Record<string, unknown> {
  if (stored['ownerClaimId'] !== undefined) {
    const guarded = { ...detail }
    for (const field of OWNER_FIELDS) guarded[field] = stored[field]
    return guarded
  }
  if (detail['ownerClaimId'] === undefined) return detail
  const { ownerPid: _pid, ownerEpoch: _epoch, ownerClaimId: _claim, ...rest } = detail
  return rest
}

/** One synchronous transaction commits state and its replay cursor together. */
export class SqliteDurableJournal {
  readonly database: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5000 })
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS pi_admissions (
        handle_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE,
        start_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_progress (
        handle_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(handle_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS pi_sessions (
        session_id TEXT PRIMARY KEY, create_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL
      );
    `)
  }

  admit(input: Omit<JournalRecord, 'epoch' | 'state' | 'detail'>): JournalRecord {
    return this.transaction(() => {
      const replay = this.database
        .prepare('SELECT body FROM pi_admissions WHERE start_key=?')
        .get(input.startKey) as Row | undefined
      if (replay) {
        const existing = JSON.parse(replay.body) as JournalRecord
        if (
          existing.handleId !== input.handleId ||
          existing.attemptId !== input.attemptId ||
          canonicalJsonStringify(existing.admission) !== canonicalJsonStringify(input.admission)
        )
          throw new Error('IDEMPOTENCY_CONFLICT')
        return existing
      }
      if (
        this.database
          .prepare('SELECT body FROM pi_admissions WHERE attempt_id=?')
          .get(input.attemptId)
      )
        throw new Error('ATTEMPT_CONFLICT')
      const record = { ...input, epoch: 0, state: 'starting', detail: {} }
      this.database
        .prepare('INSERT INTO pi_admissions VALUES (?,?,?,?)')
        .run(input.handleId, input.attemptId, input.startKey, JSON.stringify(record))
      this.event(input.handleId, { type: 'status', data: { state: 'starting' }, at: input.at })
      return record
    })
  }

  get(handleId: string): JournalRecord {
    const row = this.database
      .prepare('SELECT body FROM pi_admissions WHERE handle_id=?')
      .get(handleId) as Row | undefined
    if (!row) throw new Error('HANDLE_NOT_FOUND')
    return JSON.parse(row.body) as JournalRecord
  }

  list(): JournalRecord[] {
    return (
      this.database
        .prepare('SELECT body FROM pi_admissions ORDER BY handle_id')
        .all() as unknown as Row[]
    ).map((row) => JSON.parse(row.body) as JournalRecord)
  }

  claim(handleId: string, expected?: { epoch: number; state: string }): number {
    return this.transaction(() => {
      const record = this.get(handleId)
      if (expected && (record.epoch !== expected.epoch || record.state !== expected.state))
        throw new Error('STALE_STATE')
      const epoch = record.epoch + 1
      this.save({ ...record, epoch })
      return epoch
    })
  }

  /** Validate the entire retained snapshot, synchronously guard it, and commit
   * its interaction state/epoch/cursor together. Undefined is an exact replay.
   */
  transition(
    expected: JournalRecord,
    operation: (current: JournalRecord) =>
      | {
          change: Partial<Pick<JournalRecord, 'state' | 'detail'>>
          event?: JournalEvent | readonly JournalEvent[]
        }
      | undefined
  ): JournalRecord {
    return this.transaction(() => {
      const current = this.get(expected.handleId)
      if (canonicalJsonStringify(current) !== canonicalJsonStringify(expected))
        throw new Error('STALE_STATE')
      const mutation = operation(current)
      if (!mutation) return current
      const next = {
        ...current,
        ...mutation.change,
        detail: guardOwner(mutation.change.detail ?? current.detail, current.detail),
        epoch: current.epoch + 1,
      }
      this.save(next)
      if (mutation.event)
        for (const event of Array.isArray(mutation.event) ? mutation.event : [mutation.event])
          this.event(current.handleId, event as JournalEvent)
      return next
    })
  }

  /** Serialize local process ownership before touching the native Pi store or lock file. The
   * returned claim is the only token that can release this ownership. */
  claimProcess(handleId: string, expected?: { epoch: number; state: string }): ProcessClaim {
    return this.transaction(() => {
      const record = this.get(handleId)
      if (
        !OWNERSHIP_STATES.includes(record.state) ||
        (expected && (record.epoch !== expected.epoch || record.state !== expected.state))
      )
        throw new Error('STALE_STATE')
      const pid = record.detail['ownerPid']
      if (typeof pid === 'number') {
        try {
          process.kill(pid, 0)
          throw new Error('PI_SESSION_OWNER_ACTIVE')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            throw new Error('PI_SESSION_OWNER_ACTIVE', { cause: error })
        }
      }
      const epoch = record.epoch + 1
      const claim: ProcessClaim = {
        epoch,
        ownerPid: process.pid,
        ownerEpoch: epoch,
        claimId: randomUUID(),
      }
      this.save({
        ...record,
        epoch,
        detail: {
          ...record.detail,
          ownerPid: claim.ownerPid,
          ownerEpoch: claim.ownerEpoch,
          ownerClaimId: claim.claimId,
        },
      })
      return claim
    })
  }

  /** Whether this claim still owns the record. The check reads the claim's own fence, so a later
   * command epoch bump does not revoke it. */
  holdsProcessClaim(handleId: string, claim: ProcessClaim): boolean {
    return holdsClaim(this.get(handleId), claim)
  }

  /** Undoes a recovery claim that reached no decision (a transient authority failure, or a
   * shutdown interrupting it): clears the owner fields that hold this claim and restores the
   * predecessor epoch only while the claimed epoch is still current. Restoring is safe because a
   * later claim gets its own claim id, so a delayed release still holding this token cannot match
   * it. A declared denial must use releaseRecoveryDenial instead, so its fence is never reissued. */
  releaseRecoveryClaim(handleId: string, claim: ProcessClaim): void {
    this.transaction(() => {
      const record = this.get(handleId)
      if (!holdsClaim(record, claim)) return
      this.save({
        ...record,
        epoch: record.epoch === claim.epoch ? claim.epoch - 1 : record.epoch,
        detail: clearOwner(record.detail),
      })
    })
  }

  /** Ends a recovery claim with a declared authority denial. The marker and the epoch advance are
   * written only while the expected claim is still current, and the epoch moves forward rather
   * than back, so the denied attempt's token is never accepted again. A superseded claim writes
   * no marker and leaves the newer epoch alone; it clears only the owner fields of this claim. */
  releaseRecoveryDenial(handleId: string, claim: ProcessClaim, recoveryBlocked: string): void {
    this.transaction(() => {
      const record = this.get(handleId)
      if (!holdsClaim(record, claim)) return
      const held = record.epoch === claim.epoch
      this.save({
        ...record,
        epoch: held ? claim.epoch + 1 : record.epoch,
        detail: {
          ...clearOwner(record.detail),
          ...(held ? { recoveryBlocked } : {}),
        },
      })
    })
  }

  /** Clears the owner fields only while they still hold this claim. Two adapters in one process
   * share a pid, so the pid alone never identifies an owner. A late release from an earlier claim
   * matches nothing once a later claim holds the record, and a command epoch bump does not stop
   * the claim's own owner from releasing it. */
  releaseProcess(handleId: string, claim: ProcessClaim): void {
    this.transaction(() => {
      const record = this.get(handleId)
      if (!holdsClaim(record, claim)) return
      this.save({ ...record, detail: clearOwner(record.detail) })
    })
  }

  assertOwner(handleId: string, epoch: number): void {
    if (this.get(handleId).epoch !== epoch) throw new Error('STALE_OWNER')
  }

  update(
    handleId: string,
    epoch: number,
    change: Partial<Pick<JournalRecord, 'state' | 'detail'>>,
    event?: JournalEvent | readonly JournalEvent[]
  ): JournalRecord {
    return this.transaction(() => {
      this.assertOwner(handleId, epoch)
      const stored = this.get(handleId)
      const next = {
        ...stored,
        ...change,
        detail: guardOwner(change.detail ?? stored.detail, stored.detail),
      }
      this.save(next)
      if (event)
        for (const item of Array.isArray(event) ? event : [event])
          this.event(handleId, item as JournalEvent)
      return next
    })
  }

  events(handleId: string, afterSequence: number): Record<string, unknown>[] {
    return (
      this.database
        .prepare('SELECT body FROM pi_progress WHERE handle_id=? AND sequence>? ORDER BY sequence')
        .all(handleId, afterSequence) as unknown as Row[]
    ).map((row) => JSON.parse(row.body) as Record<string, unknown>)
  }

  sessionCreate(
    session: { sessionId: string; state: 'active' | 'closed'; observedAt: string },
    key: string
  ) {
    const replay = this.database
      .prepare('SELECT body FROM pi_sessions WHERE create_key=?')
      .get(key) as Row | undefined
    if (replay) return JSON.parse(replay.body) as typeof session
    this.database
      .prepare('INSERT INTO pi_sessions VALUES (?,?,?)')
      .run(session.sessionId, key, JSON.stringify(session))
    return session
  }

  sessions(): Array<{ sessionId: string; state: 'active' | 'closed'; observedAt: string }> {
    return (
      this.database
        .prepare('SELECT body FROM pi_sessions ORDER BY session_id')
        .all() as unknown as Row[]
    ).map((row) => JSON.parse(row.body))
  }

  sessionUpdate(session: {
    sessionId: string
    state: 'active' | 'closed'
    observedAt: string
  }): void {
    this.database
      .prepare('UPDATE pi_sessions SET body=? WHERE session_id=?')
      .run(JSON.stringify(session), session.sessionId)
  }

  close(): void {
    this.database.close()
  }

  private save(record: JournalRecord): void {
    this.database
      .prepare('UPDATE pi_admissions SET body=? WHERE handle_id=?')
      .run(JSON.stringify(record), record.handleId)
  }

  private event(
    handleId: string,
    event: { type: string; data: Record<string, unknown>; at: string }
  ): void {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM pi_progress WHERE handle_id=?')
      .get(handleId) as { sequence: number }
    const body = {
      handleId,
      sequence: row.sequence,
      occurredAt: event.at,
      type: event.type,
      data: event.data,
    }
    this.database
      .prepare('INSERT INTO pi_progress VALUES (?,?,?)')
      .run(handleId, row.sequence, JSON.stringify(body))
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}
