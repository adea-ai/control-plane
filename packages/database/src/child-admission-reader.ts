import type { ChildAdmissionReader } from '@control-plane/orchestration'
import type { ControlPlaneDatabase } from './connection.js'
import { readAttemptRow, readExecutionRow } from './execution-repository.js'
import { readToolCallRow } from './tool-repositories.js'

/**
 * Transaction-bound canonical reads for one child authority fence on PostgreSQL. Every read uses the
 * allocation's own transaction. The reader fails closed once its fence returns and cannot be used outside
 * the transaction that issued it.
 */
export function createPgChildAdmissionReader(
  transaction: Pick<ControlPlaneDatabase, 'select'>,
  workspaceId: string
): ChildAdmissionReader & { close(): void } {
  let open = true
  const live = (): Pick<ControlPlaneDatabase, 'select'> => {
    if (!open) throw new Error('CHILD_ADMISSION_READER_CLOSED')
    return transaction
  }
  return {
    async getExecution(executionId) {
      return readExecutionRow(live(), executionId)
    },
    async getAttempt(attemptId) {
      return readAttemptRow(live(), attemptId)
    },
    async getToolCall(toolCallId) {
      return readToolCallRow(live(), workspaceId, toolCallId)
    },
    close() {
      open = false
    },
  }
}
