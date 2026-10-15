// TEST ONLY. A fresh process that resumes the child's terminal settlement from nothing but the
// on-disk stores a closed production-factory host left behind: the canonical SQLite database, the
// adapter journal and the cost-state projection. It has no provider transport, no credentials and no
// composition, so it cannot start, send or publish anything. Importing this file never runs it.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteDurableJournal } from '@control-plane/pi-durable-adapter'
import {
  SqliteChildUsageOutcomeRepository,
  SqliteDelegationEventPublisher,
  SqliteDelegationRepository,
  SqliteDurableUsageStore,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  childIds,
  createChildTerminalSettlement,
  loadChildCostState,
} from './pi-durable-compaction-governed-dispatch.fixture.mjs'

const worker = fileURLToPath(import.meta.url)

/** Opens the stores of a closed host directory exactly as the host did. */
export async function openDurableChildStores(directory, { workspaceId, parentExecutionId, at }) {
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
  await persistence.migrate()
  const journal = new SqliteDurableJournal(join(directory, 'authority.sqlite'))
  return {
    ledger: new DurableUsageLedger({
      store: new SqliteDurableUsageStore(persistence),
      now: () => at,
    }),
    usageOutcomes: new SqliteChildUsageOutcomeRepository(persistence, childIds.delegationId),
    events: new SqliteDelegationEventPublisher(persistence, parentExecutionId),
    delegations: new SqliteDelegationRepository(persistence),
    journal,
    workspaceId,
    parentExecutionId,
    at,
    async close() {
      journal.database.close()
      await persistence.close()
    },
  }
}

/** Everything the durable stores hold about the child, as plain JSON. */
export async function readDurableChildState(stores) {
  const { ledger, workspaceId, parentExecutionId } = stores
  const childRow = stores.journal
    .list()
    .find((row) => row.admission.request.executionId === childIds.executionId)
  return JSON.parse(
    JSON.stringify({
      parentEntries: await ledger.entries(workspaceId, parentExecutionId),
      childEntries: await ledger.entries(workspaceId, childIds.executionId),
      parentSummary: await ledger.summary(workspaceId, parentExecutionId),
      childSummary: await ledger.summary(workspaceId, childIds.executionId),
      cost: await loadChildCostState(stores.usageOutcomes, parentExecutionId),
      eventTypes: (await stores.events.list()).map((event) => event.type),
      childJournal: childRow,
      delegationCount: (await stores.delegations.listByParent(parentExecutionId)).length,
    })
  )
}

/**
 * Runs the worker in a new process. `killAtStep` makes the worker SIGKILL itself right after that
 * durable settlement step, so the process dies mid-settlement with no chance to clean up.
 */
export function runChildSettlementProcess(directory, ids, { killAtStep } = {}) {
  const child = spawn(
    process.execPath,
    [worker, directory, ids.workspaceId, ids.parentExecutionId, ids.at, killAtStep ?? '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '))
      resolve({
        pid: child.pid,
        code,
        signal,
        stderr,
        result: line ? JSON.parse(line.slice('RESULT '.length)) : undefined,
      })
    })
  })
}

if (import.meta.main) {
  const [directory, workspaceId, parentExecutionId, at, killAtStep] = process.argv.slice(2)
  const stores = await openDurableChildStores(directory, { workspaceId, parentExecutionId, at })
  try {
    const settlement = await createChildTerminalSettlement({
      ...stores,
      seam: async (step) => {
        if (step === killAtStep) process.kill(process.pid, 'SIGKILL')
      },
    }).settle()
    process.stdout.write(
      `RESULT ${JSON.stringify({ pid: process.pid, settlement, state: await readDurableChildState(stores) })}\n`
    )
  } finally {
    await stores.close()
  }
}
