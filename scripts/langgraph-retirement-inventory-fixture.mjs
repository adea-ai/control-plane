// Disposable fixture store for the M16.01 retirement inventory (#938).
//
// Builds a throwaway SQLite control-plane store in a fresh temp directory —
// graph definitions published through the real GraphDefinitionCatalog +
// SqliteGraphDefinitionRepository command path, execution plans and
// executions through the real repositories and lifecycle service, and
// LangGraph checkpoint rows in the exact row shape the checkpointer writes.
// This is the only component of the inventory tooling that ever writes, and
// it only ever writes to a directory it created under the OS temp root.
//
// Direct execution prints the sample manifest for this store:
//   bun scripts/langgraph-retirement-inventory-fixture.mjs [observed-at]

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  GraphDefinitionCatalog,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
import {
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqliteGraphDefinitionRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'

const FIXTURE_AT = '2026-10-01T06:00:00.000Z'

// Workspace one must equal the execution-plan fixture correlation workspace so
// executions attribute to the catalog definitions in the same workspace.
const ids = {
  workspaceOne: 'wsp_01JABCDEF0123456789ABCDEFG',
  workspaceTwo: 'wsp_01JBBBBBBBBBBBBBBBBBBBBBB2',
  executionRunning: 'exe_01JCCCCCCCCCCCCCCCCCCCCCC1',
  executionCancelled: 'exe_01JCCCCCCCCCCCCCCCCCCCCCC2',
  executionOrphan: 'exe_01JCCCCCCCCCCCCCCCCCCCCCC3',
  attempt: 'att_01JEEEEEEEEEEEEEEEEEEEEEE1',
  workflow: 'wfl_01JDDDDDDDDDDDDDDDDDDDDDD1',
  callerOne: 'svc_inventory-fixture',
  callerTwo: 'svc_inventory-beta-caller',
}

function graphDefinition({ graphDefinitionId, graphVersion, nodes, requiredCapabilities }) {
  return {
    graphDefinitionId,
    graphVersion,
    schemaVersion: 1,
    nodes,
    edges: [
      { from: '__start__', to: nodes[0].node },
      ...nodes.slice(0, -1).map((node, index) => ({ from: node.node, to: nodes[index + 1].node })),
      { from: nodes[nodes.length - 1].node, to: '__end__' },
    ],
    schemas: { input: 'schema:json', state: 'schema:json', output: 'schema:json' },
    requiredCapabilities,
    compatibility: {
      contractMajorVersions: [1],
      compilerVersions: ['1.0.0'],
      adapterVersions: ['1.0.0', '1.4.12'],
    },
  }
}

function alphaNodes() {
  return [
    { node: 'prepare', operation: { kind: 'runtime', name: 'prepare' } },
    { node: 'record', operation: { kind: 'tool', name: 'store-json' } },
  ]
}

/**
 * Creates the disposable store. Options:
 * - now: () => Date — provider clock (drives updated_at; use an old clock for
 *   staleness scenarios). Defaults to the fixed fixture instant.
 * - injectMalformedDefinition: writes one unparseable graph-definitions row.
 * - injectMalformedExecution: writes one unparseable executions row.
 * - injectMalformedCheckpoint: writes one checkpoint row with an unknown version.
 * - injectOrphanCheckpoint: writes a well-formed checkpoint row whose thread
 *   names an execution that has no record in the executions namespace.
 * - injectUnclassifiedCheckpoint: writes a well-formed checkpoint row whose
 *   thread name cannot be parsed into a workspace/execution pair.
 * - mutateRunningPlanGraphIdentity: rewrites the running execution's retained
 *   plan record in place so its graph identity is unusable —
 *   'missing-graph-id' (reference without graphDefinitionId),
 *   'missing-graph-version' (non-string graphVersion), or
 *   'missing-graph-reference' (no graph selection at all).
 */
export async function createInventoryFixtureStore({
  now = () => new Date(FIXTURE_AT),
  injectMalformedDefinition = false,
  injectMalformedExecution = false,
  injectMalformedCheckpoint = false,
  injectOrphanCheckpoint = false,
  injectUnclassifiedCheckpoint = false,
  mutateRunningPlanGraphIdentity = undefined,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'langgraph-retirement-inventory-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path, now })
  try {
    await provider.migrate()

    // Catalog definitions through the real publish command path so the store
    // also carries graph-definition-commands receipts (consumer evidence).
    const catalogRepositoryOne = new SqliteGraphDefinitionRepository(provider, ids.workspaceOne)
    const stagingCatalog = new GraphDefinitionCatalog(new InMemoryGraphDefinitionRepository())
    const alpha = await stagingCatalog.publish({
      definition: graphDefinition({
        graphDefinitionId: 'graph:inventory-alpha',
        graphVersion: '1.0.0',
        nodes: alphaNodes(),
        requiredCapabilities: ['graph.tool-pins.v1'],
      }),
      publishedAt: FIXTURE_AT,
    })
    await catalogRepositoryOne.executeCommand(
      {
        callerId: ids.callerOne,
        operation: 'publish',
        idempotencyKey: 'inventory-fixture-alpha-v1-0001',
        payloadHash: 'a'.repeat(64),
      },
      async (commandView) => {
        await commandView.insert(alpha)
        return alpha
      }
    )
    const alphaNext = await stagingCatalog.publish({
      definition: graphDefinition({
        graphDefinitionId: 'graph:inventory-alpha',
        graphVersion: '1.1.0',
        nodes: alphaNodes(),
        requiredCapabilities: ['graph.tool-pins.v1'],
      }),
      publishedAt: FIXTURE_AT,
    })
    await catalogRepositoryOne.insert(alphaNext)
    const liveCatalogOne = new GraphDefinitionCatalog(catalogRepositoryOne)
    await liveCatalogOne.deprecate({
      reference: alphaNext.reference,
      expectedRevision: 1,
      changedAt: FIXTURE_AT,
      reason: 'superseded by the workflow migration candidate',
    })
    const beta = await stagingCatalog.publish({
      definition: graphDefinition({
        graphDefinitionId: 'graph:inventory-beta',
        graphVersion: '1.0.0',
        nodes: [{ node: 'prepare', operation: { kind: 'runtime', name: 'prepare' } }],
        requiredCapabilities: [],
      }),
      publishedAt: FIXTURE_AT,
    })
    await catalogRepositoryOne.executeCommand(
      {
        callerId: ids.callerTwo,
        operation: 'publish',
        idempotencyKey: 'inventory-fixture-beta-v1-0001',
        payloadHash: 'b'.repeat(64),
      },
      async (commandView) => {
        await commandView.insert(beta)
        return beta
      }
    )
    const catalogRepositoryTwo = new SqliteGraphDefinitionRepository(provider, ids.workspaceTwo)
    // Same published version, different workspace record: the catalog is
    // workspace-scoped, so identical content exists per workspace.
    await catalogRepositoryTwo.insert(alpha)

    // Execution plans pin the graph references; executions pin the plans.
    // Plan compilation and storage require the pinned context package to be
    // stored first (SqliteExecutionPlanRepository.put verifies the pin).
    const planInputs = createExecutionPlanTestFixtureInputs()
    await new SqliteContextPackageRepository(provider).put(planInputs.contextPackage)
    const plans = new SqliteExecutionPlanRepository(provider)
    const lifecycle = new ExecutionLifecycleService(new SqliteExecutionRepository(provider))
    await seedRunningExecution({
      provider,
      plans,
      lifecycle,
      graph: alpha,
      executionId: ids.executionRunning,
      planInputs,
    })
    await seedCancelledExecution({
      plans,
      lifecycle,
      graph: beta,
      executionId: ids.executionCancelled,
      planInputs,
    })
    if (mutateRunningPlanGraphIdentity !== undefined) {
      await mutatePlanGraphIdentity(provider, lifecycle, mutateRunningPlanGraphIdentity)
    }

    // LangGraph checkpoint rows in the checkpointer's exact storage shape.
    const runningThread = `${ids.workspaceOne}:${ids.executionRunning}:graph:${ids.executionRunning}`
    await putCheckpointRow(provider, {
      scope: 'managed-graphs',
      thread: runningThread,
      checkpointId: 'ck-inventory-0001',
      kind: 'checkpoint',
    })
    await putCheckpointRow(provider, {
      scope: 'managed-graphs',
      thread: runningThread,
      checkpointId: 'ck-inventory-0002',
      kind: 'checkpoint',
    })
    await putCheckpointRow(provider, {
      scope: 'managed-graphs',
      thread: runningThread,
      checkpointId: 'ck-inventory-0002',
      kind: 'write',
      task: 'record',
      index: 0,
      channel: 'values',
    })
    await putCheckpointRow(provider, {
      scope: 'managed-graphs',
      thread: `${ids.workspaceOne}:${ids.executionCancelled}:graph:${ids.executionCancelled}`,
      checkpointId: 'ck-inventory-0003',
      kind: 'checkpoint',
    })
    if (injectMalformedExecution) {
      await provider.transaction(async (transaction) => {
        await transaction.put({
          namespace: 'executions',
          id: `e-${createHash('sha256').update('fixture-malformed-execution').digest('hex')}`,
          value: { broken: true },
        })
      })
    }
    if (injectOrphanCheckpoint) {
      await putCheckpointRow(provider, {
        scope: 'managed-graphs',
        thread: `${ids.workspaceOne}:${ids.executionOrphan}:graph:${ids.executionOrphan}`,
        checkpointId: 'ck-inventory-0004',
        kind: 'checkpoint',
      })
    }
    if (injectUnclassifiedCheckpoint) {
      await putCheckpointRow(provider, {
        scope: 'managed-graphs',
        thread: 'legacy-retained-thread-without-execution-scope',
        checkpointId: 'ck-inventory-0005',
        kind: 'checkpoint',
      })
    }
    if (injectMalformedCheckpoint) {
      await provider.transaction(async (transaction) => {
        await transaction.put({
          namespace: 'langgraph-checkpoints-v1',
          id: `g-${createHash('sha256').update('fixture-malformed-checkpoint').digest('hex')}`,
          value: { version: 99, scope: 'managed-graphs', thread: 'bogus', kind: 'checkpoint' },
        })
      })
    }
    if (injectMalformedDefinition) {
      await provider.transaction(async (transaction) => {
        await transaction.put({
          namespace: 'graph-definitions',
          id: `r-${createHash('sha256').update('fixture-malformed-definition').digest('hex')}`,
          value: { broken: true },
        })
      })
    }

    return {
      directory,
      path,
      at: FIXTURE_AT,
      ids,
      cleanup: async () => {
        try {
          provider.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try {
      provider.close()
    } catch {
      // Close failures must not mask the original fixture error.
    }
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function seedRunningExecution({ plans, lifecycle, graph, executionId, planInputs }) {
  const compiled = compilePlanWithGraph(graph, planInputs)
  const planReference = await plans.put(compiled)
  await lifecycle.createExecution({
    executionId,
    correlation: { ...compiled.correlation },
    executionPlan: { ...planReference, schemaVersion: 1 },
    acceptedAt: FIXTURE_AT,
  })
  await lifecycle.createAttempt({
    executionId,
    attemptId: ids.attempt,
    expectedExecutionVersion: 1,
    queuedAt: FIXTURE_AT,
  })
  await transitionExecutionTo(lifecycle, executionId, 'queued')
  await transitionExecutionTo(lifecycle, executionId, 'running')
  const attempt = await lifecycle.repository.getAttempt(ids.attempt)
  await lifecycle.transitionAttempt({
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    to: 'running',
    transitionedAt: FIXTURE_AT,
  })
}

/** Reads the live version before each transition; attempts bump the aggregate. */
async function transitionExecutionTo(lifecycle, executionId, state) {
  const execution = await lifecycle.getExecution(executionId)
  return lifecycle.transitionExecution({
    executionId,
    expectedVersion: execution.version,
    to: state,
    transitionedAt: FIXTURE_AT,
  })
}

async function seedCancelledExecution({ plans, lifecycle, graph, executionId, planInputs }) {
  const compiled = compilePlanWithGraph(graph, planInputs)
  const planReference = await plans.put(compiled)
  await lifecycle.createExecution({
    executionId,
    correlation: { ...compiled.correlation },
    executionPlan: { ...planReference, schemaVersion: 1 },
    acceptedAt: FIXTURE_AT,
  })
  await transitionExecutionTo(lifecycle, executionId, 'cancelled')
}

/**
 * Rewrites the running execution's retained plan record in place so its graph
 * identity is missing or malformed. This simulates a corrupted plan row that
 * can no longer be attributed to a workflow: the inventory must never benignly
 * bucket such a plan as an unknown graph or a non-graph workflow.
 */
async function mutatePlanGraphIdentity(provider, lifecycle, mutation) {
  const execution = await lifecycle.getExecution(ids.executionRunning)
  const planId = execution.executionPlan.executionPlanId
  const id = `r-${createHash('sha256').update(planId).digest('hex')}`
  await provider.transaction(async (transaction) => {
    const record = await transaction.get('execution-plans', id)
    if (record === undefined) throw new Error('fixture plan record missing')
    const plan = record.value
    if (mutation === 'missing-graph-id') delete plan.graph.reference.graphDefinitionId
    else if (mutation === 'missing-graph-version') plan.graph.reference.graphVersion = 1
    else if (mutation === 'missing-graph-reference') delete plan.graph
    else throw new Error(`unknown plan graph identity mutation: ${mutation}`)
    await transaction.put({
      namespace: 'execution-plans',
      id,
      expectedRevision: record.revision,
      value: plan,
    })
  })
}

function compilePlanWithGraph(graph, planInputs) {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...planInputs,
    graph: { reference: graph.reference, input: { message: 'inventory' } },
  })
}

async function putCheckpointRow(
  provider,
  { scope, thread, checkpointId, kind, task, index, channel }
) {
  const payload = Buffer.from(`fixture-${kind}-${checkpointId}`).toString('base64')
  const row = {
    version: 1,
    scope,
    thread,
    ns: '',
    checkpointId,
    kind,
    checkpoint: ['msgpack', payload, sha256Hex(payload)],
    metadata: [
      'json',
      Buffer.from('{}').toString('base64'),
      sha256Hex(Buffer.from('{}').toString('base64')),
    ],
    ...(task === undefined ? {} : { task }),
    ...(index === undefined ? {} : { index }),
    ...(channel === undefined ? {} : { channel }),
  }
  const id = `g-${createHash('sha256')
    .update(
      JSON.stringify([
        row.scope,
        row.thread,
        row.ns,
        row.checkpointId,
        row.kind,
        task ?? null,
        index ?? null,
      ])
    )
    .digest('hex')}`
  await provider.transaction(async (transaction) => {
    await transaction.put({ namespace: 'langgraph-checkpoints-v1', id, value: row })
  })
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const inventory = await import('./langgraph-retirement-inventory.mjs')
  const observedAt = process.argv[2] ?? '2026-10-08T00:00:00.000Z'
  const fixture = await createInventoryFixtureStore()
  try {
    const store = await inventory.openReadOnlyStore(fixture.path)
    try {
      const manifest = inventory.buildInventoryManifest({
        database: store.database,
        storeIdentity: store.identity,
        storeProfile: inventory.readStoreProfile(store.database),
        observationScope: 'local-disposable-store',
        observedAt,
        sourceRevision: 'fixture',
      })
      process.stdout.write(`${inventory.stableJsonStringify(manifest)}\n`)
    } finally {
      store.database.close()
    }
  } finally {
    await fixture.cleanup()
  }
}
