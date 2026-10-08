import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  ExecutionModelSelectionBindingSchema,
  RetainedModelFundingConfirmationSchema,
  ModelFundingConfirmationError,
  type ModelFundingConfirmationRepository,
} from '@control-plane/model-gateway'

interface ConfirmationDatabase {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...parameters: string[]): unknown
    run(...parameters: string[]): unknown
  }
}
const Key = ExecutionModelSelectionBindingSchema.pick({
  workspaceId: true,
  executionId: true,
  attemptId: true,
})
function keyOf(input: unknown) {
  return Key.parse(
    input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(Key.shape).map((key) => [key, Reflect.get(input, key)]))
      : input
  )
}

/** Host-local reference-only SQLite persistence. No update, grant minting, credential,
 * physical-send hold or allocation release API. Expired evidence remains immutable.
 */
export function createSqliteModelFundingConfirmations(
  database: ConfirmationDatabase
): ModelFundingConfirmationRepository {
  database.exec(`CREATE TABLE IF NOT EXISTS model_funding_confirmations (
    workspace_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(length(record_json) <= 65536),
    PRIMARY KEY (workspace_id, execution_id, attempt_id)
  ) STRICT`)
  const select = database.prepare(`SELECT record_json FROM model_funding_confirmations
    WHERE workspace_id = ? AND execution_id = ? AND attempt_id = ?`)
  const insert = database.prepare(`INSERT OR IGNORE INTO model_funding_confirmations
    (workspace_id, execution_id, attempt_id, record_json) VALUES (?, ?, ?, ?)`)
  function read(input: unknown) {
    const key = keyOf(input)
    const row = select.get(key.workspaceId, key.executionId, key.attemptId)
    if (row === undefined || row === null) return undefined
    try {
      const raw = typeof row === 'object' ? Reflect.get(row, 'record_json') : undefined
      if (typeof raw !== 'string' || raw.length > 65536) throw new Error()
      const record = RetainedModelFundingConfirmationSchema.parse(JSON.parse(raw))
      if (
        record.binding.workspaceId !== key.workspaceId ||
        record.binding.executionId !== key.executionId ||
        record.binding.attemptId !== key.attemptId
      )
        throw new Error()
      return record
    } catch {
      throw new ModelFundingConfirmationError('PI_LEAD_FUNDING_CONFIRMATION_STALE')
    }
  }
  return {
    async getByAttempt(input) {
      return read(input)
    },
    async putIfAbsent(input) {
      const record = RetainedModelFundingConfirmationSchema.parse(input)
      const key = keyOf(record.binding)
      insert.run(key.workspaceId, key.executionId, key.attemptId, canonicalJsonStringify(record))
      const winner = read(key)
      if (winner === undefined)
        throw new ModelFundingConfirmationError('PI_LEAD_FUNDING_CONFIRMATION_STALE')
      return winner
    },
  }
}
