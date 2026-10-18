// TEST ONLY. A fresh process that resumes the child's terminal settlement from nothing but the
// on-disk stores a closed production-factory host left behind: the canonical SQLite database, the
// adapter journal and the cost-state projection. It has no provider transport, no credentials and no
// composition, so it cannot start, send or publish anything. Importing this file never runs it.
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  readPublicationRecords,
} from './pi-durable-compaction-governed-dispatch.fixture.mjs'

const worker = fileURLToPath(import.meta.url)
let preparedWorker

// Each crash/recovery still gets a fresh OS process and real retained stores.
// Build this same entry point once so every child does not resolve/transpile
// the full production import graph again. Build failures never fall back.
function prepareWorker() {
  preparedWorker ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-settlement-worker-'))
    try {
      const result = await Bun.build({
        entrypoints: [worker],
        target: 'bun',
        format: 'esm',
        write: false,
      })
      if (!result.success) throw new AggregateError(result.logs, 'CHILD_SETTLEMENT_BUILD_FAILED')
      if (result.outputs.length !== 1) throw new Error('CHILD_SETTLEMENT_BUILD_OUTPUT_INVALID')
      const path = join(directory, 'settlement.mjs')
      await writeFile(path, new Uint8Array(await result.outputs[0].arrayBuffer()), { mode: 0o600 })
      return { path, directory }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  })()
  return preparedWorker
}

/** Called only after every owned settlement subprocess has closed. */
export async function closeChildSettlementWorker() {
  const pending = preparedWorker
  preparedWorker = undefined
  if (!pending) return
  const prepared = await pending.catch(() => undefined)
  if (prepared) await rm(prepared.directory, { recursive: true, force: true })
}

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
    persistence,
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
      publications: await readPublicationRecords(stores.persistence, parentExecutionId),
      childJournal: childRow,
      delegationCount: (await stores.delegations.listByParent(parentExecutionId)).length,
    })
  )
}

/**
 * Runs the worker in a new process. `killAtStep` makes the worker SIGKILL itself right after that
 * durable settlement step, so the process dies mid-settlement with no chance to clean up.
 */
export function runChildSettlementProcess(
  directory,
  ids,
  { killAtStep, spawnWorker = spawn, timeoutMs = 30000 } = {}
) {
  // Injected process doubles keep their synchronous event-registration contract.
  if (spawnWorker === spawn)
    return prepareWorker().then(({ path }) =>
      startChildSettlementProcess(path, directory, ids, { killAtStep, spawnWorker, timeoutMs })
    )
  return startChildSettlementProcess(worker, directory, ids, { killAtStep, spawnWorker, timeoutMs })
}

function startChildSettlementProcess(
  entrypoint,
  directory,
  ids,
  { killAtStep, spawnWorker, timeoutMs }
) {
  const child = spawnWorker(
    process.execPath,
    [entrypoint, directory, ids.workspaceId, ids.parentExecutionId, ids.at, killAtStep ?? '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    // `exit` can precede the last pipe data. `close` means stdout/stderr are drained as well.
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      try {
        if (timedOut) throw new Error(`CHILD_SETTLEMENT_PROCESS_TIMEOUT:${stderr}`)
        const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '))
        if (code === 0 && !line) throw new Error(`CHILD_SETTLEMENT_RESULT_MISSING:${stderr}`)
        resolve({
          pid: child.pid,
          code,
          signal,
          stderr,
          result: line ? JSON.parse(line.slice('RESULT '.length)) : undefined,
        })
      } catch (error) {
        reject(error)
      }
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
