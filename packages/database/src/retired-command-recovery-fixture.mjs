import { deepStrictEqual, rejects } from 'node:assert'
import { eq } from 'drizzle-orm'
import { CommandInboxService } from '@control-plane/domain'
import {
  commandInbox,
  PostgresCommandAcceptanceRepository,
  PostgresExecutionRepository,
} from './index.ts'
import { retiredCommandKeys } from './schema/retired-command-keys.ts'

export async function seedRetiredCommandRecoveryFixture(database) {
  const suffix = '01DRZ3NDEKTSV4RRFFQ69G5FAW'
  const receivedAt = '2026-08-01T10:00:00.000Z'
  const retiredAt = '2026-09-08T10:00:00.000Z'
  const repository = new PostgresCommandAcceptanceRepository(database)
  const service = new CommandInboxService({
    repository,
    executionIdFactory: () => `exe_${suffix}`,
    executionPlanValidator: { validate: async () => true },
    now: () => receivedAt,
  })
  const accepted = await service.acceptExecution({
    callerPrincipalId: 'svc_retirement-recovery',
    operation: 'execution.accept',
    commandId: `cmd_${suffix}`,
    requestId: `req_${suffix}`,
    idempotencyKey: 'retired-command-recovery',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: `wsp_${suffix}`,
      projectId: `prj_${suffix}`,
      taskId: `tsk_${suffix}`,
      agentId: `agt_${suffix}`,
    },
    executionPlan: {
      executionPlanId: `pln_${suffix}`,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    receivedAt,
    retentionExpiresAt: '2026-09-01T10:00:00.000Z',
  })
  deepStrictEqual(
    await repository.compareAndSet(1, {
      ...accepted.command,
      status: 'failed',
      terminalAt: receivedAt,
      errorReference: 'error://recovery/cancelled',
      version: 2,
    }),
    true
  )
  deepStrictEqual(
    await new PostgresExecutionRepository(database).compareAndSetExecution(1, {
      ...accepted.execution,
      state: 'cancelled',
      terminalAt: receivedAt,
      version: 2,
    }),
    true
  )
  deepStrictEqual(await repository.retireExpiredCommand(accepted.command, retiredAt), true)
  const expected = await database
    .select()
    .from(retiredCommandKeys)
    .where(eq(retiredCommandKeys.commandId, accepted.command.commandId))
  deepStrictEqual(expected.length, 1)
  // Only the disposable drill database: simulate future payload compaction before backup.
  await database.delete(commandInbox).where(eq(commandInbox.commandId, accepted.command.commandId))
  return {
    async assertRecovered(restoredDatabase) {
      deepStrictEqual(
        await restoredDatabase
          .select()
          .from(retiredCommandKeys)
          .where(eq(retiredCommandKeys.commandId, accepted.command.commandId)),
        expected
      )
      deepStrictEqual(
        await restoredDatabase
          .select()
          .from(commandInbox)
          .where(eq(commandInbox.commandId, accepted.command.commandId)),
        []
      )
      const restored = new PostgresCommandAcceptanceRepository(restoredDatabase)
      await rejects(restored.get(accepted.command), { code: 'COMMAND_RETENTION_EXPIRED' })
      await rejects(
        restored.accept({ ...accepted.command, payloadHash: 'c'.repeat(64) }, accepted.execution),
        { code: 'COMMAND_RETENTION_EXPIRED' }
      )
    },
  }
}
