import type { PersistenceTransaction } from '@control-plane/deployment'
import type { ChildAdmissionReader } from '@control-plane/orchestration'
import { readAttemptIn, readExecutionIn } from './repositories.js'
import { readToolCallIn } from './tool-repositories.js'

/**
 * Transaction-bound canonical reads for one child authority fence. Every read uses the allocation's own
 * transaction, so no read re-enters the provider while that transaction is open. The reader fails closed
 * once its fence returns; it cannot be used outside the transaction that issued it.
 */
export function createSqliteChildAdmissionReader(
  transaction: PersistenceTransaction,
  workspaceId: string
): ChildAdmissionReader & { close(): void } {
  let open = true
  const live = (): PersistenceTransaction => {
    if (!open) throw new Error('CHILD_ADMISSION_READER_CLOSED')
    return transaction
  }
  return {
    async getExecution(executionId) {
      return readExecutionIn(live(), executionId)
    },
    async getAttempt(attemptId) {
      return readAttemptIn(live(), attemptId)
    },
    async getToolCall(toolCallId) {
      return readToolCallIn(live(), workspaceId, toolCallId)
    },
    close() {
      open = false
    },
  }
}
