import { assertSettlementReceipt } from './reconciliation.js'
import type { CloudflareSettlementReceipt } from './reconciliation.js'
import type { RuntimeExecutionResult, RuntimeStartRequest } from '@control-plane/runtime-sdk'

/** Structural subset of a SQLite Durable Object; no Node/process dependencies. */
export interface CloudflareOwnerStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: (string | number | null)[]
    ): {
      toArray(): Record<string, unknown>[]
    }
  }
  transactionSync<T>(operation: () => T): T
  setAlarm(scheduledTime: number): Promise<void>
}

export interface CloudflareOwnerPins {
  readonly schemaVersion: 1
  readonly adapterVersion: '0.1.0'
  readonly runtimeVersion: '1.1.0'
  readonly configurationDigest: string
  readonly workspaceId: string
  readonly conversationId: string
  readonly agentId: string
}

export interface CloudflareAcceptedTask {
  readonly schemaVersion: 1
  readonly canonicalActorPrincipalId: string
  readonly request: RuntimeStartRequest
}

type TaskState =
  | 'accepted'
  | 'running'
  | 'cancelling'
  | 'reconciliation_required'
  | 'completed'
  | 'cancelled'
export interface CloudflareTaskRecord {
  readonly task: CloudflareAcceptedTask
  readonly epoch: number
  readonly state: TaskState
  readonly result?: RuntimeExecutionResult
  readonly observedResult?: RuntimeExecutionResult
  readonly settlement?: CloudflareSettlementReceipt
}

/** Deterministic JSON comparison only. Never rewrites or rehashes the canonical plan. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`
  }
  throw new Error('CLOUDFLARE_NON_JSON_PIN')
}

/** One owner per conversation + agent. Tables contain runtime context, never canonical transcript/jobs. */
export class CloudflareOwnerJournal {
  readonly epoch: number
  private readonly pinsJson: string

  constructor(
    private readonly storage: CloudflareOwnerStorage,
    pins: CloudflareOwnerPins
  ) {
    if (
      pins.schemaVersion !== 1 ||
      pins.runtimeVersion !== '1.1.0' ||
      pins.adapterVersion !== '0.1.0' ||
      !/^sha256:[a-f0-9]{64}$/.test(pins.configurationDigest) ||
      !pins.workspaceId ||
      !pins.conversationId ||
      !pins.agentId
    ) {
      throw new Error('CLOUDFLARE_OWNER_VERSION_UNSUPPORTED')
    }
    this.pinsJson = stableJson(pins)
    this.epoch = storage.transactionSync(() => {
      storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS cp_pi_owner (id INTEGER PRIMARY KEY CHECK (id = 1), pins TEXT NOT NULL, epoch INTEGER NOT NULL)'
      )
      storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS cp_pi_tasks (attempt_id TEXT PRIMARY KEY, replay_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL, state TEXT NOT NULL, epoch INTEGER NOT NULL, result TEXT, observed_result TEXT)'
      )
      storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS cp_pi_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, state TEXT NOT NULL)'
      )
      storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS cp_pi_wake (id INTEGER PRIMARY KEY CHECK (id = 1), due_at INTEGER NOT NULL)'
      )
      storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS cp_pi_settlements (attempt_id TEXT PRIMARY KEY, receipt_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL)'
      )
      const current = storage.sql
        .exec('SELECT pins, epoch FROM cp_pi_owner WHERE id = 1')
        .toArray()[0]
      if (current && current['pins'] !== this.pinsJson)
        throw new Error('CLOUDFLARE_OWNER_PIN_CONFLICT')
      const epoch = current ? Number(current['epoch']) + 1 : 1
      if (!Number.isSafeInteger(epoch)) throw new Error('CLOUDFLARE_OWNER_EPOCH_EXHAUSTED')
      storage.sql.exec(
        'INSERT INTO cp_pi_owner (id, pins, epoch) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET epoch = excluded.epoch',
        this.pinsJson,
        epoch
      )
      // A physical send interrupted by eviction has an ambiguous outcome. Never resend it automatically.
      const interrupted = storage.sql
        .exec("SELECT attempt_id FROM cp_pi_tasks WHERE state = 'running'")
        .toArray()
      storage.sql.exec(
        "UPDATE cp_pi_tasks SET state = 'reconciliation_required', epoch = ? WHERE state = 'running'",
        epoch
      )
      for (const task of interrupted)
        storage.sql.exec(
          'INSERT INTO cp_pi_events (attempt_id, state) VALUES (?, ?)',
          String(task['attempt_id']),
          'reconciliation_required'
        )
      return epoch
    })
  }

  assertPins(pins: CloudflareOwnerPins): void {
    if (stableJson(pins) !== this.pinsJson) throw new Error('CLOUDFLARE_OWNER_PIN_CONFLICT')
    this.assertOwner()
  }

  assertOwner(): void {
    const current = this.storage.sql
      .exec('SELECT pins, epoch FROM cp_pi_owner WHERE id = 1')
      .toArray()[0]
    if (current?.['pins'] !== this.pinsJson || current['epoch'] !== this.epoch)
      throw new Error('CLOUDFLARE_OWNER_STALE')
  }

  admit(task: CloudflareAcceptedTask, now: number): CloudflareTaskRecord {
    const body = stableJson(task)
    return this.storage.transactionSync(() => {
      this.assertOwner()
      const { attemptId, idempotencyKey } = task.request
      const rows = this.storage.sql
        .exec(
          'SELECT * FROM cp_pi_tasks WHERE attempt_id = ? OR replay_key = ?',
          attemptId,
          idempotencyKey
        )
        .toArray()
      if (rows.length) {
        if (rows.length !== 1 || rows[0]?.['body'] !== body)
          throw new Error('CLOUDFLARE_ADMISSION_REPLAY_CONFLICT')
        return this.decode(rows[0])
      }
      this.storage.sql.exec(
        'INSERT INTO cp_pi_tasks (attempt_id, replay_key, body, state, epoch) VALUES (?, ?, ?, ?, ?)',
        attemptId,
        idempotencyKey,
        body,
        'accepted',
        this.epoch
      )
      this.storage.sql.exec(
        'INSERT INTO cp_pi_events (attempt_id, state) VALUES (?, ?)',
        attemptId,
        'accepted'
      )
      this.markWake(now)
      return this.get(attemptId)
    })
  }

  get(attemptId: string): CloudflareTaskRecord {
    this.assertOwner()
    const row = this.storage.sql
      .exec('SELECT * FROM cp_pi_tasks WHERE attempt_id = ?', attemptId)
      .toArray()[0]
    if (!row) throw new Error('CLOUDFLARE_TASK_MISSING')
    return this.decode(row)
  }

  transition(
    attemptId: string,
    from: TaskState,
    to: TaskState,
    result?: RuntimeExecutionResult
  ): CloudflareTaskRecord {
    return this.storage.transactionSync(() => {
      this.assertOwner()
      const current = this.get(attemptId)
      const allowed: Record<TaskState, readonly TaskState[]> = {
        accepted: ['running', 'cancelled'],
        running: ['completed', 'cancelling', 'reconciliation_required'],
        cancelling: [],
        reconciliation_required: ['cancelling'],
        completed: [],
        cancelled: [],
      }
      if (
        (to === 'completed') !== (result !== undefined) ||
        current.state !== from ||
        !allowed[from].includes(to)
      )
        throw new Error('CLOUDFLARE_TASK_TRANSITION_CONFLICT')
      this.storage.sql.exec(
        'UPDATE cp_pi_tasks SET state = ?, epoch = ?, result = ? WHERE attempt_id = ?',
        to,
        this.epoch,
        result === undefined ? null : stableJson(result),
        attemptId
      )
      this.storage.sql.exec(
        'INSERT INTO cp_pi_events (attempt_id, state) VALUES (?, ?)',
        attemptId,
        to
      )
      return this.get(attemptId)
    })
  }

  observeResult(attemptId: string, result: RuntimeExecutionResult): void {
    this.storage.transactionSync(() => {
      this.assertOwner()
      const current = this.get(attemptId)
      if (!['running', 'cancelling'].includes(current.state))
        throw new Error('CLOUDFLARE_OBSERVATION_STATE_DENIED')
      const body = stableJson(result)
      if (current.observedResult && stableJson(current.observedResult) !== body)
        throw new Error('CLOUDFLARE_OBSERVATION_CONFLICT')
      this.storage.sql.exec(
        'UPDATE cp_pi_tasks SET observed_result = ? WHERE attempt_id = ?',
        body,
        attemptId
      )
    })
  }

  /** Atomic receipt/outcome/event commit; never transitions interrupted work back to running. */
  settle(receipt: CloudflareSettlementReceipt): CloudflareTaskRecord {
    return this.storage.transactionSync(() => {
      this.assertOwner()
      const attemptId = receipt.task.request.attemptId
      const current = this.get(attemptId)
      assertSettlementReceipt(
        receipt,
        current,
        JSON.parse(this.pinsJson) as CloudflareOwnerPins,
        this.epoch
      )
      const body = stableJson(receipt)
      if (current.settlement) {
        if (stableJson(current.settlement) !== body)
          throw new Error('CLOUDFLARE_SETTLEMENT_REPLAY_CONFLICT')
        return current
      }
      if (!['reconciliation_required', 'cancelling'].includes(current.state))
        throw new Error('CLOUDFLARE_SETTLEMENT_STATE_DENIED')
      this.storage.sql.exec(
        'INSERT INTO cp_pi_settlements (attempt_id, receipt_ref, body) VALUES (?, ?, ?)',
        attemptId,
        receipt.receiptRef,
        body
      )
      this.storage.sql.exec(
        'UPDATE cp_pi_tasks SET state = ?, epoch = ?, result = ? WHERE attempt_id = ?',
        receipt.disposition,
        this.epoch,
        receipt.result === undefined ? null : stableJson(receipt.result),
        attemptId
      )
      this.storage.sql.exec(
        'INSERT INTO cp_pi_events (attempt_id, state) VALUES (?, ?)',
        attemptId,
        receipt.disposition
      )
      return this.get(attemptId)
    })
  }

  events(attemptId: string, afterSequence = 0): readonly { sequence: number; state: string }[] {
    this.get(attemptId)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new Error('CLOUDFLARE_CURSOR_INVALID')
    return this.storage.sql
      .exec(
        'SELECT sequence, state FROM cp_pi_events WHERE attempt_id = ? AND sequence > ? ORDER BY sequence',
        attemptId,
        afterSequence
      )
      .toArray()
      .map((row) => ({ sequence: Number(row['sequence']), state: String(row['state']) }))
  }

  pending(afterAttemptId = ''): readonly CloudflareTaskRecord[] {
    this.assertOwner()
    return this.storage.sql
      .exec(
        "SELECT * FROM cp_pi_tasks WHERE state = 'accepted' AND attempt_id > ? ORDER BY attempt_id LIMIT 64",
        afterAttemptId
      )
      .toArray()
      .map((row) => this.decode(row))
  }

  refreshWake(now: number): void {
    this.storage.transactionSync(() => {
      this.assertOwner()
      this.storage.sql.exec('DELETE FROM cp_pi_wake WHERE id = 1')
      if (this.pending().length) this.markWake(now)
    })
  }

  /** SQL and setAlarm are deliberately separate; durable wake intent repairs a failed async alarm. */
  async repairAlarm(): Promise<void> {
    this.assertOwner()
    const row = this.storage.sql.exec('SELECT due_at FROM cp_pi_wake WHERE id = 1').toArray()[0]
    if (row) {
      await this.storage.setAlarm(Number(row['due_at']))
      this.assertOwner()
    }
  }

  private markWake(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('CLOUDFLARE_WAKE_TIME_INVALID')
    this.storage.sql.exec(
      'INSERT INTO cp_pi_wake (id, due_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET due_at = min(due_at, excluded.due_at)',
      now
    )
  }

  private decode(row: Record<string, unknown>): CloudflareTaskRecord {
    const settlement = this.storage.sql
      .exec('SELECT body FROM cp_pi_settlements WHERE attempt_id = ?', String(row['attempt_id']))
      .toArray()[0]
    return {
      ...(settlement
        ? { settlement: JSON.parse(String(settlement['body'])) as CloudflareSettlementReceipt }
        : {}),
      task: JSON.parse(String(row['body'])) as CloudflareAcceptedTask,
      epoch: Number(row['epoch']),
      state: row['state'] as TaskState,
      ...(row['result'] == null
        ? {}
        : { result: JSON.parse(String(row['result'])) as RuntimeExecutionResult }),
      ...(row['observed_result'] == null
        ? {}
        : { observedResult: JSON.parse(String(row['observed_result'])) as RuntimeExecutionResult }),
    }
  }
}
