// Shared helpers for the legacy retirement tests. Disposable local stores only: nothing here reaches a deployed store.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyCheckpoint } from '@langchain/langgraph'
import { GraphNodeEffectUnconfirmedError } from '@control-plane/orchestration'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  LangGraphOrchestrationAdapter,
  LangGraphSqliteCheckpointSaver,
  deterministicInterruptGraph,
} from './index.ts'
import {
  LEGACY_CHECKPOINT_NAMESPACE,
  LEGACY_EXECUTION_NAMESPACE,
  LEGACY_EXECUTION_PLAN_NAMESPACE,
} from './legacy-retirement.ts'

export const request = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
  graph: {
    graphDefinitionId: 'deterministic-interrupt',
    graphVersion: '1.0.0',
    contentDigest: `sha256:${'b'.repeat(64)}`,
  },
  threadId: 'thread-legacy-1',
  input: { objective: 'drain legacy work' },
  idempotencyKey: 'legacy:segment:1',
}
export const storageThread = `${request.workspaceId}:${request.executionId}:${request.threadId}`
export const metadata = { source: 'input', step: 0, parents: {} }
export const scope = 'managed-graphs'
export const disposable = { observationScope: 'disposable-local-store' }
// Arithmetic only: a caller-asserted deployed scope on a disposable store. It is never a deployed observation.
export const assertedDeployed = {
  observationScope: 'deployed-dsn',
  attestation: { attestedBy: 'legacy-retirement-fixture', attestedAt: '2026-10-10T12:00:00.000Z' },
}
export const executionIds = Object.freeze({
  primary: request.executionId,
  second: 'exe_01JABCDEF0123456789ABCDEFH',
  third: 'exe_01JABCDEF0123456789ABCDEFJ',
  queued: 'exe_01JABCDEF0123456789ABCDEFK',
  orphan: 'exe_01JABCDEF0123456789ABCDEFM',
})
export const planId = 'pln_01JABCDEF0123456789ABCDEFG'
export const planDigest = `sha256:${'d'.repeat(64)}`

// Injected plan verifier: stands in for canonical verification where a trusted graph is needed. It is not evidence.
export function injectedVerifier(value) {
  return {
    executionPlanId: value.executionPlanId,
    contentDigest: value.contentDigest,
    graph: value.graph.reference,
  }
}

export function digest(character) {
  return `sha256:${character.repeat(64)}`
}

export function runRequest(overrides = {}) {
  return { ...request, ...overrides }
}

export function storageThreadFor(input) {
  return `${input.workspaceId}:${input.executionId}:${input.threadId}`
}

export function resumeRequest(input, checkpointId, idempotencyKey = 'legacy:segment:resume:1') {
  return {
    executionId: input.executionId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    graph: input.graph,
    threadId: input.threadId,
    checkpointId,
    response: { action: 'approve' },
    idempotencyKey,
  }
}

export function resumeInput(checkpointId) {
  return resumeRequest(request, checkpointId)
}

export async function disposableStore() {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-retirement-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  return { directory, path, provider }
}

export async function reopen(path) {
  const provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  return provider
}

export function saverFor(provider) {
  return new LangGraphSqliteCheckpointSaver(provider, scope)
}

export function adapterFor(provider, { calls = [], failOn, resumeFence, admissionGuard } = {}) {
  return new LangGraphOrchestrationAdapter({
    graphs: [deterministicInterruptGraph(request.graph)],
    checkpointer: saverFor(provider),
    operations: {
      async invoke(operation) {
        calls.push(operation.name)
        if (operation.name === failOn) throw new GraphNodeEffectUnconfirmedError()
        return { value: operation.name }
      },
      async cancel() {
        return true
      },
    },
    events: { async publish() {} },
    now: () => '2026-10-10T12:00:00.000Z',
    ...(resumeFence === undefined ? {} : { resumeFence }),
    ...(admissionGuard === undefined ? {} : { admissionGuard }),
  })
}

// Mirrors the control plane's execution state writes; the reader consumes the same record shape.
export async function writeExecution(
  provider,
  state,
  executionId = request.executionId,
  executionPlan
) {
  await provider.transaction(async (tx) => {
    const existing = await tx.get(LEGACY_EXECUTION_NAMESPACE, executionId)
    await tx.put({
      namespace: LEGACY_EXECUTION_NAMESPACE,
      id: executionId,
      ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
      value: {
        executionId,
        state,
        correlation: { workspaceId: request.workspaceId },
        ...(executionPlan === undefined ? {} : { executionPlan }),
      },
    })
  })
}

export async function writePlanRecord(provider, executionPlanId, value) {
  await provider.transaction((tx) =>
    tx.put({ namespace: LEGACY_EXECUTION_PLAN_NAMESPACE, id: executionPlanId, value })
  )
}

// Writes a record exactly as a foreign or damaged writer would. Used only in disposable stores.
export async function writeRawRecord(provider, namespace, id, value) {
  await provider.transaction((tx) => tx.put({ namespace, id, value }))
}

export function configFor(threadId) {
  return { configurable: { thread_id: threadId, checkpoint_ns: '' } }
}

// A checkpoint thread with no execution record: retained work the reader must report as orphaned.
export async function putOrphanThread(provider, threadId) {
  await saverFor(provider).put(configFor(threadId), emptyCheckpoint(), metadata, {})
}

export function itemFor(remainder, executionId) {
  return remainder.items.find((item) => item.executionId === executionId)
}

// A store holding every retained shape at once: in-flight, uncertain, orphaned, execution-only, an unverifiable
// plan, and a foreign-version checkpoint row. The foreign row is written last, after every saver write.
export async function buildMixedStore(provider) {
  await adapterFor(provider).run(runRequest({ idempotencyKey: 'legacy:mixed:in-flight' }))
  await writePlanRecord(provider, planId, {
    executionPlanId: planId,
    contentDigest: planDigest,
    graph: { reference: request.graph },
  })
  await writeExecution(provider, 'awaiting_input', executionIds.primary, {
    executionPlanId: planId,
    contentDigest: planDigest,
  })

  await adapterFor(provider, { failOn: 'prepare' }).run(
    runRequest({
      executionId: executionIds.second,
      threadId: 'thread-uncertain',
      idempotencyKey: 'legacy:mixed:uncertain',
    })
  )
  await writeExecution(provider, 'reconciliation_required', executionIds.second)

  await putOrphanThread(provider, `${request.workspaceId}:${executionIds.orphan}:thread-orphan`)
  await writeExecution(provider, 'queued', executionIds.queued)

  await writeRawRecord(provider, LEGACY_CHECKPOINT_NAMESPACE, 'foreign-v2', {
    version: 2,
    scope,
    thread: storageThread,
    checkpointId: 'ckpt-foreign',
    kind: 'checkpoint',
  })
}
