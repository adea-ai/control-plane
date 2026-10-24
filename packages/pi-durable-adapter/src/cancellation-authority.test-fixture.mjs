import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'

export function createMemoryCommittedCancellationAuthority({
  now = () => new Date().toISOString(),
} = {}) {
  const records = new Map()
  const acknowledged = new Set()
  let version = 0
  return {
    async commit(proposal) {
      const key = `${proposal.handleId}\u0000${proposal.idempotencyKey}`
      const existing = records.get(key)
      if (existing) {
        if (existing.requestDigest !== proposal.requestDigest)
          throw new RuntimeAdapterError({
            code: 'PI_CANCELLATION_INTENT_CONFLICT',
            classification: 'conflict',
            message: 'PI_CANCELLATION_INTENT_CONFLICT',
            retryable: false,
          })
        return structuredClone(existing)
      }
      const intent = {
        schemaVersion: 'pi-committed-cancellation/v1',
        intentId: randomUUID(),
        committedAuthorityVersion: ++version,
        committedAt: now(),
        ...structuredClone(proposal),
      }
      records.set(key, intent)
      return structuredClone(intent)
    },
    async pendingHandles() {
      return [
        ...new Set(
          [...records.values()]
            .filter((intent) => !acknowledged.has(intent.intentId))
            .map((intent) => intent.handleId)
        ),
      ]
    },
    async pendingForHandle(handleId) {
      return [...records.values()]
        .filter((intent) => intent.handleId === handleId && !acknowledged.has(intent.intentId))
        .map((intent) => structuredClone(intent))
    },
    async pending() {
      return (await this.pendingHandles()).flatMap((handleId) =>
        [...records.values()]
          .filter((intent) => intent.handleId === handleId && !acknowledged.has(intent.intentId))
          .map((intent) => structuredClone(intent))
      )
    },
    async acknowledge(intentId) {
      acknowledged.add(intentId)
    },
    intentForHandle(handleId, idempotencyKey) {
      const matches = [...records.values()].filter(
        (intent) =>
          intent.handleId === handleId &&
          (idempotencyKey === undefined || intent.idempotencyKey === idempotencyKey)
      )
      const intent = matches.at(-1)
      return intent ? structuredClone(intent) : undefined
    },
  }
}

/** Test-only shared owner. Product fence, control-plane attempt/deadline and cancellation outbox
 * rows share one SQLite transaction, unlike today's production owners.
 */
export function createSqliteCommittedCancellationAuthority(
  path,
  { now = () => new Date().toISOString() } = {}
) {
  const database = new DatabaseSync(path, { timeout: 5000 })
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS cancellation_authority_binding (
      handle_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      admission_digest TEXT NOT NULL,
      admitted_product_revision INTEGER NOT NULL,
      current_product_revision INTEGER NOT NULL,
      product_active INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      admitted_execution_version INTEGER NOT NULL,
      current_execution_version INTEGER NOT NULL,
      admitted_attempt_version INTEGER NOT NULL,
      current_attempt_version INTEGER NOT NULL,
      admitted_deadline_at TEXT NOT NULL,
      current_deadline_at TEXT NOT NULL,
      authority_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cancellation_intent_outbox (
      intent_id TEXT PRIMARY KEY,
      handle_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      body TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      UNIQUE(handle_id,idempotency_key)
    );
  `)

  function transaction(operation) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function authorityConflict(code = 'PI_LEAD_AUTHORITY_CONFLICT') {
    return new RuntimeAdapterError({
      code,
      classification: 'conflict',
      message: code,
      retryable: false,
    })
  }

  let loseNextCommitResponse = false
  let failNextAcknowledge = false
  let nextCommitGate
  const port = {
    register({
      handleId,
      executionId,
      attemptId,
      workspaceId,
      admissionDigest,
      productRevision,
      productActive = true,
      expiresAt,
      executionVersion = 1,
      attemptVersion = 1,
      deadlineAt,
      authorityVersion = 1,
    }) {
      transaction(() => {
        database
          .prepare(`
          INSERT INTO cancellation_authority_binding VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(handle_id) DO UPDATE SET
            execution_id=excluded.execution_id,
            attempt_id=excluded.attempt_id,
            workspace_id=excluded.workspace_id,
            admission_digest=excluded.admission_digest,
            admitted_product_revision=excluded.admitted_product_revision,
            current_product_revision=excluded.current_product_revision,
            product_active=excluded.product_active,
            expires_at=excluded.expires_at,
            admitted_execution_version=excluded.admitted_execution_version,
            current_execution_version=excluded.current_execution_version,
            admitted_attempt_version=excluded.admitted_attempt_version,
            current_attempt_version=excluded.current_attempt_version,
            admitted_deadline_at=excluded.admitted_deadline_at,
            current_deadline_at=excluded.current_deadline_at,
            authority_version=excluded.authority_version
        `)
          .run(
            handleId,
            executionId,
            attemptId,
            workspaceId,
            admissionDigest,
            productRevision,
            productRevision,
            productActive ? 1 : 0,
            expiresAt,
            executionVersion,
            executionVersion,
            attemptVersion,
            attemptVersion,
            deadlineAt,
            deadlineAt,
            authorityVersion
          )
      })
    },
    updateProductFence(handleId, { revision, active = true, expiresAt }) {
      transaction(() => {
        const result = database
          .prepare(`
            UPDATE cancellation_authority_binding
            SET current_product_revision=?, product_active=?, expires_at=COALESCE(?, expires_at)
            WHERE handle_id=?
          `)
          .run(revision, active ? 1 : 0, expiresAt ?? null, handleId)
        if (result.changes !== 1) throw authorityConflict('PI_CANCELLATION_BINDING_NOT_FOUND')
      })
    },
    updateControlPlane(handleId, { executionVersion, attemptVersion, deadlineAt }) {
      transaction(() => {
        const current = database
          .prepare('SELECT * FROM cancellation_authority_binding WHERE handle_id=?')
          .get(handleId)
        if (!current) throw authorityConflict('PI_CANCELLATION_BINDING_NOT_FOUND')
        const result = database
          .prepare(`
            UPDATE cancellation_authority_binding
            SET current_execution_version=?, current_attempt_version=?, current_deadline_at=?
            WHERE handle_id=?
          `)
          .run(
            executionVersion ?? current.current_execution_version + 1,
            attemptVersion ?? current.current_attempt_version,
            deadlineAt ?? current.current_deadline_at,
            handleId
          )
        if (result.changes !== 1) throw authorityConflict('PI_CANCELLATION_BINDING_NOT_FOUND')
      })
    },
    async commit(proposal) {
      const gate = nextCommitGate
      nextCommitGate = undefined
      if (gate) {
        gate.entered.resolve()
        await gate.release.promise
      }
      let committed
      try {
        committed = transaction(() => {
          const existing = database
            .prepare(
              'SELECT body FROM cancellation_intent_outbox WHERE handle_id=? AND idempotency_key=?'
            )
            .get(proposal.handleId, proposal.idempotencyKey)
          if (existing) {
            const intent = JSON.parse(existing.body)
            if (
              intent.idempotencyKey !== proposal.idempotencyKey ||
              intent.requestDigest !== proposal.requestDigest ||
              intent.admissionDigest !== proposal.admissionDigest
            )
              throw authorityConflict('PI_CANCELLATION_INTENT_CONFLICT')
            return intent
          }
          const binding = database
            .prepare('SELECT * FROM cancellation_authority_binding WHERE handle_id=?')
            .get(proposal.handleId)
          if (
            !binding ||
            binding.execution_id !== proposal.executionId ||
            binding.attempt_id !== proposal.attemptId ||
            binding.workspace_id !== proposal.workspaceId ||
            binding.admission_digest !== proposal.admissionDigest ||
            binding.product_active !== 1 ||
            binding.current_product_revision !== binding.admitted_product_revision ||
            binding.current_execution_version !== binding.admitted_execution_version ||
            binding.current_attempt_version !== binding.admitted_attempt_version ||
            binding.current_deadline_at !== binding.admitted_deadline_at ||
            Date.parse(binding.expires_at) <= Date.parse(now()) ||
            Date.parse(binding.current_deadline_at) <= Date.parse(now())
          )
            throw authorityConflict()
          const intent = {
            schemaVersion: 'pi-committed-cancellation/v1',
            intentId: randomUUID(),
            committedAuthorityVersion: binding.authority_version + 1,
            committedAt: now(),
            ...structuredClone(proposal),
          }
          database
            .prepare('INSERT INTO cancellation_intent_outbox VALUES (?,?,?,?,?,0)')
            .run(
              intent.intentId,
              intent.handleId,
              intent.idempotencyKey,
              intent.requestDigest,
              JSON.stringify(intent)
            )
          database
            .prepare(`
              UPDATE cancellation_authority_binding SET authority_version=? WHERE handle_id=?
            `)
            .run(intent.committedAuthorityVersion, intent.handleId)
          return intent
        })
      } catch (error) {
        if (error instanceof RuntimeAdapterError) throw error
        throw new RuntimeAdapterError({
          code: 'PI_CANCELLATION_COMMIT_UNAVAILABLE',
          classification: 'unavailable',
          message: 'PI_CANCELLATION_COMMIT_UNAVAILABLE',
          retryable: true,
        })
      }
      if (loseNextCommitResponse) {
        loseNextCommitResponse = false
        throw new RuntimeAdapterError({
          code: 'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN',
          classification: 'unavailable',
          message: 'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN',
          retryable: true,
        })
      }
      return structuredClone(committed)
    },
    async pendingHandles() {
      return database
        .prepare(`
          SELECT handle_id FROM cancellation_intent_outbox
          WHERE acknowledged=0 GROUP BY handle_id ORDER BY MIN(rowid)
        `)
        .all()
        .map(({ handle_id }) => handle_id)
    },
    async pendingForHandle(handleId) {
      return database
        .prepare(`
          SELECT body FROM cancellation_intent_outbox
          WHERE acknowledged=0 AND handle_id=? ORDER BY rowid
        `)
        .all(handleId)
        .map(({ body }) => JSON.parse(body))
    },
    async pending() {
      const pending = []
      for (const handleId of await this.pendingHandles())
        pending.push(...(await this.pendingForHandle(handleId)))
      return pending
    },
    async acknowledge(intentId) {
      if (failNextAcknowledge) {
        failNextAcknowledge = false
        throw new RuntimeAdapterError({
          code: 'PI_CANCELLATION_ACK_UNAVAILABLE',
          classification: 'unavailable',
          message: 'PI_CANCELLATION_ACK_UNAVAILABLE',
          retryable: true,
        })
      }
      const existing = database
        .prepare('SELECT intent_id FROM cancellation_intent_outbox WHERE intent_id=?')
        .get(intentId)
      if (!existing) throw authorityConflict('PI_CANCELLATION_INTENT_NOT_FOUND')
      database
        .prepare('UPDATE cancellation_intent_outbox SET acknowledged=1 WHERE intent_id=?')
        .run(intentId)
    },
    close() {
      database.close()
    },
    loseNextCommitResponse() {
      loseNextCommitResponse = true
    },
    parkNextCommit() {
      let enter
      let release
      const entered = new Promise((resolve) => {
        enter = resolve
      })
      const released = new Promise((resolve) => {
        release = resolve
      })
      nextCommitGate = { entered: { resolve: enter }, release: { promise: released } }
      return { entered, release }
    },
    failNextAcknowledge() {
      failNextAcknowledge = true
    },
    corruptPendingBody(handleId, idempotencyKey, body = '{') {
      const result = database
        .prepare(`
          UPDATE cancellation_intent_outbox SET body=?
          WHERE handle_id=? AND idempotency_key=? AND acknowledged=0
        `)
        .run(body, handleId, idempotencyKey)
      if (result.changes !== 1) throw authorityConflict('PI_CANCELLATION_INTENT_NOT_FOUND')
    },
    intentForHandle(handleId) {
      const row = database
        .prepare(
          'SELECT body FROM cancellation_intent_outbox WHERE handle_id=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(handleId)
      return row ? JSON.parse(row.body) : undefined
    },
    intentForKey(handleId, idempotencyKey) {
      const row = database
        .prepare(
          'SELECT body FROM cancellation_intent_outbox WHERE handle_id=? AND idempotency_key=?'
        )
        .get(handleId, idempotencyKey)
      return row ? JSON.parse(row.body) : undefined
    },
  }

  return port
}
