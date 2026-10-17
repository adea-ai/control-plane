// Test-only: explicitly compacts a closed Pi durable native session store. The adapter keeps
// automatic compaction disabled, so a qualification run compacts the exact file selected by the
// journal's execution/attempt -> handle -> externalSessionId mapping while no runtime holds it.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CompactionEntry, createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'

/** Matches the adapter's mapping: `<runtime directory>/sessions/<sha256(externalSessionId)>.sqlite`. */
export function nativeSessionPath(runtimeDirectory, externalSessionId) {
  const fileDigest = createHash('sha256').update(externalSessionId).digest('hex')
  return join(runtimeDirectory, 'sessions', `${fileDigest}.sqlite`)
}

const settings = {
  compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128, backgroundTokens: 0 },
  retry: { enabled: false, maxRetries: 0 },
}

async function withHarness(path, models, use) {
  const storage = await openNodeSqliteStorage(path)
  let harness
  try {
    harness = await Harness.open(
      storage,
      { models, registry: createRegistry(), settings },
      BACKGROUND_CONTEXT
    )
    return await use(await harness.root(BACKGROUND_CONTEXT), harness)
  } finally {
    await harness?.close(BACKGROUND_CONTEXT)
    await storage.close(BACKGROUND_CONTEXT)
  }
}

const compactionEntries = async (root) =>
  (await root.context(BACKGROUND_CONTEXT)).entries.filter(
    (entry) => entry.kind === CompactionEntry.kind
  )

/**
 * Compact the root conversation of one closed native store with a scripted summary, then reopen it
 * and read the retained summary back. The summarizer is a local faux provider declared under the
 * session's recorded provider and model identity, so no network or credential is involved.
 */
export async function compactNativeSession({
  runtimeDirectory,
  externalSessionId,
  provider,
  modelId,
  summary = 'The compacted lead summary preserves the task and its child limits.',
  instructions = 'Preserve the lead task and its child limits.',
}) {
  const path = nativeSessionPath(runtimeDirectory, externalSessionId)
  const models = createModels()
  const faux = fauxProvider({ provider, models: [{ id: modelId }] })
  models.setProvider(faux.provider)
  faux.setResponses([fauxAssistantMessage(summary)])
  const compacted = await withHarness(path, models, async (root, harness) => {
    const entriesBefore = (await root.context(BACKGROUND_CONTEXT)).entries.length
    const taskId = await root.compact(instructions, BACKGROUND_CONTEXT)
    const task = await harness.waitForTask(taskId, BACKGROUND_CONTEXT)
    return {
      conversationId: root.id,
      entriesBefore,
      outcome: task.state.outcome.status,
      summaries: (await compactionEntries(root)).length,
      summarizerCalls: faux.state.callCount,
    }
  })
  const reopened = await withHarness(path, createModels(), async (root) => ({
    conversationId: root.id,
    summaries: (await compactionEntries(root)).length,
  }))
  return { path, ...compacted, reopened }
}
