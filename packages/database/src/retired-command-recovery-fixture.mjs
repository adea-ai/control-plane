import { deepStrictEqual, rejects } from 'node:assert'
import { eq } from 'drizzle-orm'
import { CommandInboxService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  commandInbox,
  PostgresCommandAcceptanceRepository,
  PostgresExecutionRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
} from './index.ts'
import { retiredCommandKeys } from './schema/retired-command-keys.ts'

export async function seedRetiredCommandRecoveryFixture(database) {
  const suffix = '01DRZ3NDEKTSV4RRFFQ69G5FAW'
  const receivedAt = '2026-08-01T10:00:00.000Z'
  const retiredAt = '2026-09-08T10:00:00.000Z'
  // This drill exercises normal guarded admission before payload retirement.
  // A validator stub does not authorize a nonexistent immutable parent.
  const plan = createExecutionPlanTestFixture()
  await new PostgresContextPackageRepository(database).put(
    contextPackageSerializationFixtures.futurePi
  )
  await new PostgresExecutionPlanRepository(database).put(plan)
  const repository = new PostgresCommandAcceptanceRepository(database)
  const service = new CommandInboxService({
    repository,
    executionIdFactory: () => `exe_${suffix}`,
    executionPlanValidator: { authorize: async () => true, validate: async () => true },
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
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
    },
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
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
