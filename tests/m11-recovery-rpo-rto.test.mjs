import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { CommandInboxService } from '@control-plane/domain'
import {
  SqliteCommandAcceptanceRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'

// M11.9 (#194) measured recovery evidence for the Local/SQLite profile: the
// backup is a filesystem copy of the database file, RPO is the committed-write
// window between the last backup and the failure, and RTO is the measured
// time from failure to a restored, verified control plane.

const now = '2026-09-15T12:00:00.000Z'
const pad = (n) => String(n).padStart(2, '0')
const executionIdFor = (seq) => `exe_01ARZ3NDEKTSV4RRFFQ69G5F${pad(seq)}`
const commandIdFor = (seq) => `cmd_01ARZ3NDEKTSV4RRFFQ69G5F${pad(seq)}`
const executionPlanIdFor = (seq) => `pln_01ARZ3NDEKTSV4RRFFQ69G5F${pad(seq)}`

describe('M11.9 recovery evidence: measured RPO/RTO (SQLite profile)', () => {
  test('backup preserves committed work; post-backup writes define the measured RPO', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-rpo-rto-'))
    const livePath = join(directory, 'state.sqlite')
    const backupPath = join(directory, 'backup.sqlite')
    const restorePath = join(directory, 'restored.sqlite')

    const provider = new SqlitePersistenceProvider({ path: livePath })
    await provider.migrate()
    const commands = new SqliteCommandAcceptanceRepository(provider)

    const acceptExecution = async (repository, seq) => {
      await new CommandInboxService({
        repository,
        executionIdFactory: () => executionIdFor(seq),
        executionPlanValidator: { validate: async () => true },
        now: () => now,
      }).acceptExecution({
        callerPrincipalId: 'svc_agent-hq',
        operation: 'execution.accept',
        commandId: commandIdFor(seq),
        requestId: `req_01ARZ3NDEKTSV4RRFFQ69G5F${pad(seq)}`,
        idempotencyKey: `recovery-rpo-sweep-${pad(seq)}`,
        payloadHash: 'a'.repeat(64),
        correlation: {
          workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
        executionPlan: {
          executionPlanId: executionPlanIdFor(seq),
          contentDigest: `sha256:${'b'.repeat(64)}`,
          schemaVersion: 1,
        },
        receivedAt: now,
        retentionExpiresAt: '2027-09-16T12:00:00.000Z',
      })
    }

    // Work #1: committed before the backup.
    await acceptExecution(commands, 1)

    // Quiesce and checkpoint so the filesystem backup captures every write.
    await provider.close({ checkpoint: true })

    // Backup: filesystem copy of the checkpointed database file.
    const backupStart = Date.now()
    await copyFile(livePath, backupPath)
    const backupMs = Date.now() - backupStart

    // Work #2: committed after the backup, on a reopened live database.
    const liveProvider = new SqlitePersistenceProvider({ path: livePath })
    await liveProvider.migrate()
    const liveCommands = new SqliteCommandAcceptanceRepository(liveProvider)
    await acceptExecution(liveCommands, 2)

    // Failure: the live database is destroyed. Only the backup remains.
    await liveProvider.close()
    await rm(livePath, { force: true })

    // RTO: place the backup at the restore path, then open and verify.
    const recoveryStart = Date.now()
    await copyFile(backupPath, restorePath)
    const restoreProvider = new SqlitePersistenceProvider({ path: restorePath })
    await restoreProvider.migrate()
    const restoredCommands = new SqliteCommandAcceptanceRepository(restoreProvider)
    const rtoMs = Date.now() - recoveryStart

    // Invariants: work #1 survives restore; work #2 (post-backup) does not —
    // its absence IS the measured RPO window.
    expect(await restoredCommands.getByExecutionId(executionIdFor(1))).toBeDefined()
    expect(await restoredCommands.getByExecutionId(executionIdFor(2))).toBeUndefined()

    console.log(
      `[m11-recovery] backupMs=${backupMs} rtoMs=${rtoMs} ` +
        'rpoWindow=writes-between-backup-and-failure'
    )
  })
})
