// Disposable deployed-shaped PostgreSQL fixture for the M16.01 retirement
// inventory PG collector (#938).
//
// Derives a throwaway isolated database exactly the way the existing
// integration suites do (createIsolatedTestDatabase: fresh per-case database,
// migrated, application role without DDL) and seeds it through the real
// deployed persistence path — graph definitions and command receipts through
// GraphDefinitionCatalog + PostgresGraphDefinitionRepository, execution plans
// and executions through PostgresExecutionPlanRepository +
// ExecutionLifecycleService, and LangGraph checkpoint rows in the exact
// PostgresSaver column shape (packages/database/src/schema/langgraph-checkpoints.ts).
// Corruption and pagination-volume scenarios write directly through the raw
// application client, because the real repositories refuse those rows by
// design. Only the fixture ever writes, and only to the database it created.
//
// Application-role writes are fixtures by definition; the collector under
// test never writes (see scripts/langgraph-retirement-inventory-pg.mjs).

import { createHash } from 'node:crypto'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresGraphDefinitionRepository,
} from '@control-plane/database'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  GraphDefinitionCatalog,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'

const FIXTURE_AT = '2026-10-01T06:00:00.000Z'

// Workspace one must equal the execution-plan fixture correlation workspace so
// executions attribute to the catalog definitions in the same workspace.
export const fixtureIds = {
  workspaceOne: 'wsp_01JABCDEF0123456789ABCDEFG',
  workspaceTwo: 'wsp_01JBBBBBBBBBBBBBBBBBBBBBB2',
  executionRunning: 'exe_01JCCCCCCCCCCCCCCCCCCCCCC1',
  executionCancelled: 'exe_01JCCCCCCCCCCCCCCCCCCCCCC2',
  executionOrphan: 'exe_01JCCCCCCCCCCCCCCCCCCCCCC3',
  attempt: 'att_01JEEEEEEEEEEEEEEEEEEEEEE1',
  workflow: 'wfl_01JDDDDDDDDDDDDDDDDDDDDDD1',
  callerOne: 'svc_inventory-pg-fixture',
  callerTwo: 'svc_inventory-pg-beta-caller',
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
 * Creates the disposable deployed-shaped store. Options mirror the reviewed
 * SQLite fixture:
 * - seedRunningExecution: seed the running + cancelled executions (default true).
 * - compileRunningPlanGraphless: compile the running execution's plan with no
 *   graph selection at all, the way a genuine non-graph workflow is built;
 *   the plan's digest and the execution's pin stay self-consistent.
 * - injectOrphanCheckpoint: checkpoint row whose thread names an execution
 *   with no record in the executions table.
 * - injectUnclassifiedCheckpoint: checkpoint row whose thread name cannot be
 *   parsed into a workspace/execution pair.
 * - injectOrphanBlob: checkpoint_blobs row whose thread names an execution
 *   with no record in the executions table and that has no checkpoint/write
 *   row — blob-only evidence whose thread must still be classified.
 * - injectUnclassifiedBlob: checkpoint_blobs row whose thread name cannot be
 *   parsed, again with no checkpoint/write row behind it.
 * - mutateRunningPlanGraphIdentity: rewrites the running execution's retained
 *   plan row in place — 'missing-graph-id' (reference without
 *   graphDefinitionId), 'invalid-graph-version' (nonempty but canonically
 *   invalid graphVersion), or 'missing-graph-reference' (deletes the graph
 *   selection the plan was compiled with, leaving the retained digest stale:
 *   corrupted evidence, never a legal non-graph workflow).
 * - corruptRunningPlanContent: edits the running plan's retained content
 *   (schema-valid, but no longer the content the retained digest covers).
 * - mutateRunningExecutionPin: rewrites the running execution's plan pin to a
 *   well-formed digest that belongs to no retained plan.
 * - backdateExecutions: rewrites the executions' lifecycle timestamps to an
 *   instant far before the observation time, so the freshness threshold
 *   classifies the section as stale.
 * - settleRunningExecution: marks the running execution completed in place, so
 *   the store carries retained work with zero in-flight evidence — the exact
 *   precondition a pagination bound must respect when it blocks the zero claim.
 * - volume: { definitionRows, checkpointThreads } — pagination volume seeded
 *   directly (shape-valid rows) so exactness can be checked across page sizes.
 */
export async function createInventoryPgFixture({
  seedRunningExecution = true,
  compileRunningPlanGraphless = false,
  injectOrphanCheckpoint = false,
  injectUnclassifiedCheckpoint = false,
  injectOrphanBlob = false,
  injectUnclassifiedBlob = false,
  mutateRunningPlanGraphIdentity = undefined,
  corruptRunningPlanContent = false,
  mutateRunningExecutionPin = false,
  backdateExecutions = false,
  settleRunningExecution = false,
  volume = undefined,
} = {}) {
  const database = await createIsolatedTestDatabase({
    administration: loadDatabaseCredentials(process.env, 'administration'),
    application: loadDatabaseCredentials(process.env, 'application'),
    migration: loadDatabaseCredentials(process.env, 'migration'),
  })
  const client = database.application.$client
  try {
    await database.migrate()
    const ids = fixtureIds

    // Catalog definitions through the real publish command path so the store
    // also carries graph_definition_commands receipts (consumer evidence).
    const catalogRepositoryOne = new PostgresGraphDefinitionRepository(
      database.application,
      ids.workspaceOne
    )
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
        idempotencyKey: 'inventory-pg-fixture-alpha-v1-0001',
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
        idempotencyKey: 'inventory-pg-fixture-beta-v1-0001',
        payloadHash: 'b'.repeat(64),
      },
      async (commandView) => {
        await commandView.insert(beta)
        return beta
      }
    )
    const catalogRepositoryTwo = new PostgresGraphDefinitionRepository(
      database.application,
      ids.workspaceTwo
    )
    // Same published version, different workspace row: the catalog is
    // workspace-scoped, so identical content exists per workspace.
    await catalogRepositoryTwo.insert(alpha)

    // Execution plans pin the graph references; executions pin the plans.
    // Plan compilation and storage require the pinned context package to be
    // stored first (PostgresExecutionPlanRepository.put verifies the pin).
    if (seedRunningExecution) {
      const planInputs = createExecutionPlanTestFixtureInputs()
      await new PostgresContextPackageRepository(database.application).put(
        planInputs.contextPackage
      )
      const plans = new PostgresExecutionPlanRepository(database.application)
      const lifecycle = new ExecutionLifecycleService(
        new PostgresExecutionRepository(database.application)
      )
      await seedRunning({
        plans,
        lifecycle,
        graph: alpha,
        executionId: ids.executionRunning,
        planInputs,
        graphless: compileRunningPlanGraphless,
      })
      await seedCancelled({
        plans,
        lifecycle,
        graph: beta,
        executionId: ids.executionCancelled,
        planInputs,
      })

      if (mutateRunningPlanGraphIdentity !== undefined) {
        await mutatePlanGraphIdentity(client, lifecycle, ids, mutateRunningPlanGraphIdentity)
      }
      if (corruptRunningPlanContent) {
        await rewriteRunningPlanRow(client, lifecycle, ids, (plan) => {
          plan.compiledAt = '2026-09-15T00:00:00.000Z'
        })
      }
      if (mutateRunningExecutionPin) {
        await client.unsafe(
          'update executions set execution_plan_digest = $2 where execution_id = $1',
          [
            ids.executionRunning,
            `sha256:${createHash('sha256').update('fixture-foreign-plan-digest').digest('hex')}`,
          ]
        )
      }
      if (settleRunningExecution) {
        // Evidence-shaping raw write (the collector under test never writes):
        // the running execution becomes terminal so the store holds retained
        // work with no in-flight evidence at all.
        await client.unsafe(
          'update executions set state = $2, updated_at = $3 where execution_id = $1',
          [ids.executionRunning, 'completed', FIXTURE_AT]
        )
      }
      if (backdateExecutions) {
        await client.unsafe(
          'update executions set accepted_at = $1, updated_at = $1, created_at = $1',
          ['2026-06-01T00:00:00.000Z']
        )
        // The executions section's freshness signal is the newest lifecycle
        // timestamp across executions and retained plans.
        await client.unsafe('update execution_plans set created_at = $1', [
          '2026-06-01T00:00:00.000Z',
        ])
      }

      // LangGraph checkpoint rows in the PostgresSaver's exact storage shape.
      const runningThread = `${ids.workspaceOne}:${ids.executionRunning}:graph:${ids.executionRunning}`
      await putCheckpointRow(client, {
        thread: runningThread,
        checkpointId: 'ck-inventory-pg-0001',
      })
      await putCheckpointRow(client, {
        thread: runningThread,
        checkpointId: 'ck-inventory-pg-0002',
      })
      await putCheckpointWriteRow(client, {
        thread: runningThread,
        checkpointId: 'ck-inventory-pg-0002',
        taskId: 'record',
        index: 0,
        channel: 'values',
      })
      await putCheckpointRow(client, {
        thread: `${ids.workspaceOne}:${ids.executionCancelled}:graph:${ids.executionCancelled}`,
        checkpointId: 'ck-inventory-pg-0003',
      })
      if (injectOrphanCheckpoint) {
        await putCheckpointRow(client, {
          thread: `${ids.workspaceOne}:${ids.executionOrphan}:graph:${ids.executionOrphan}`,
          checkpointId: 'ck-inventory-pg-0004',
        })
      }
      if (injectUnclassifiedCheckpoint) {
        await putCheckpointRow(client, {
          thread: 'legacy-retained-thread-without-execution-scope',
          checkpointId: 'ck-inventory-pg-0005',
        })
      }
    }

    // Blob-only evidence sits outside the running-execution block: a store can
    // hold checkpoint_blobs rows whose threads have no checkpoint/write row at
    // all, and those threads must still be classified by the collector.
    if (injectOrphanBlob) {
      await putCheckpointBlobRow(client, {
        thread: `${ids.workspaceOne}:${ids.executionOrphan}:graph:${ids.executionOrphan}`,
      })
    }
    if (injectUnclassifiedBlob) {
      await putCheckpointBlobRow(client, {
        thread: 'legacy-retained-blob-thread-without-execution-scope',
        channel: 'patched',
      })
    }

    if (volume !== undefined) await seedVolume(client, ids, volume)

    // The application-role DSN for the isolated database is the deployed-DSN
    // analog the collector observes (SELECT/DML only, no DDL authority).
    const applicationUrl = new URL(loadDatabaseCredentials(process.env, 'application').url)
    applicationUrl.pathname = `/${database.name}`
    return {
      database,
      dsn: applicationUrl.toString(),
      at: FIXTURE_AT,
      ids,
      cleanup: async () => {
        await database.dispose()
      },
    }
  } catch (error) {
    await database.dispose()
    throw error
  }
}

async function seedRunning({ plans, lifecycle, graph, executionId, planInputs, graphless }) {
  const compiled = graphless
    ? compileGraphlessPlan(planInputs)
    : compilePlanWithGraph(graph, planInputs)
  const planReference = await plans.put(compiled)
  await lifecycle.createExecution({
    executionId,
    correlation: { ...compiled.correlation },
    executionPlan: { ...planReference, schemaVersion: 1 },
    acceptedAt: FIXTURE_AT,
  })
  await lifecycle.createAttempt({
    executionId,
    attemptId: fixtureIds.attempt,
    expectedExecutionVersion: 1,
    queuedAt: FIXTURE_AT,
  })
  await transitionExecutionTo(lifecycle, executionId, 'queued')
  await transitionExecutionTo(lifecycle, executionId, 'running')
  const attempt = await lifecycle.repository.getAttempt(fixtureIds.attempt)
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

async function seedCancelled({ plans, lifecycle, graph, executionId, planInputs }) {
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

function compilePlanWithGraph(graph, planInputs) {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...planInputs,
    graph: { reference: graph.reference, input: { message: 'inventory' } },
  })
}

/**
 * A genuine non-graph workflow plan: the compiler itself writes it with no
 * graph selection at all, so the canonical digest covers exactly the retained
 * content and the execution's pin derives from this compilation.
 */
function compileGraphlessPlan(planInputs) {
  return new ExecutionPlanCompiler('1.0.0').compile({ ...planInputs })
}

/**
 * Rewrites the running execution's retained plan row in place. The
 * malformed-identity mutations ('missing-graph-id', 'invalid-graph-version')
 * simulate corrupted plan rows that can no longer be attributed to a
 * workflow; 'missing-graph-reference' deletes the graph selection a compiled
 * plan carries without updating the plan's digest: the retained digest no
 * longer covers the retained content, so the record is corrupted evidence —
 * not a legal non-graph workflow.
 */
async function mutatePlanGraphIdentity(client, lifecycle, ids, mutation) {
  await rewriteRunningPlanRow(client, lifecycle, ids, (plan) => {
    if (mutation === 'missing-graph-id') delete plan.graph.reference.graphDefinitionId
    else if (mutation === 'invalid-graph-version') plan.graph.reference.graphVersion = '?'
    else if (mutation === 'missing-graph-reference') delete plan.graph
    else throw new Error(`unknown plan graph identity mutation: ${mutation}`)
  })
}

/** Applies a rewrite to the running execution's retained plan row. */
async function rewriteRunningPlanRow(client, lifecycle, ids, rewrite) {
  const execution = await lifecycle.getExecution(ids.executionRunning)
  const planId = execution.executionPlan.executionPlanId
  const rows = await client.unsafe(
    'select plan from execution_plans where execution_plan_id = $1',
    [planId]
  )
  const plan = rows[0]?.plan
  if (plan === undefined) throw new Error('fixture plan row missing')
  rewrite(plan)
  await client.unsafe('update execution_plans set plan = $2 where execution_plan_id = $1', [
    planId,
    JSON.stringify(plan),
  ])
}

async function putCheckpointRow(client, { thread, checkpointId }) {
  const checkpoint = {
    v: 4,
    id: checkpointId,
    ts: FIXTURE_AT,
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  }
  await client.unsafe(
    `insert into checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
     values ($1, '', $2, null, 'json', $3::jsonb, '{}'::jsonb)`,
    [thread, checkpointId, JSON.stringify(checkpoint)]
  )
}

async function putCheckpointWriteRow(client, { thread, checkpointId, taskId, index, channel }) {
  await client.unsafe(
    `insert into checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
     values ($1, '', $2, $3, $4, $5, 'json', $6::bytea)`,
    [thread, checkpointId, taskId, index, channel, Buffer.from(`fixture-write-${checkpointId}`)]
  )
}

/** One checkpoint_blobs row in the PostgresSaver's exact storage shape. */
async function putCheckpointBlobRow(client, { thread, channel = 'values', version = '1' }) {
  await client.unsafe(
    `insert into checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
     values ($1, '', $2, $3, 'json', $4::bytea)`,
    [thread, channel, version, Buffer.from(`fixture-blob-${thread}`)]
  )
}

/**
 * Pagination volume: shape-valid definition rows and checkpoint evidence
 * seeded directly so the collector's exactness can be checked independently
 * of the page size. Content stays minimal and synthetic.
 */
async function seedVolume(client, ids, { definitionRows = 0, checkpointThreads = 0 } = {}) {
  for (let index = 0; index < definitionRows; index += 1) {
    const graphDefinitionId = `graph:volume-${String(index).padStart(4, '0')}`
    const definition = {
      reference: {
        graphDefinitionId,
        graphVersion: '1.0.0',
        contentDigest: `sha256:${createHash('sha256').update(`volume-${index}`).digest('hex')}`,
      },
      revision: 1,
      lifecycle: 'published',
      content: graphDefinition({
        graphDefinitionId,
        graphVersion: '1.0.0',
        nodes: [{ node: 'prepare', operation: { kind: 'runtime', name: 'prepare' } }],
        requiredCapabilities: [],
      }),
      publishedAt: FIXTURE_AT,
      changedAt: FIXTURE_AT,
    }
    await client.unsafe(
      `insert into graph_definition_versions (workspace_id, graph_definition_id, graph_version, revision, definition)
       values ($1, $2, '1.0.0', 1, $3::jsonb)`,
      [ids.workspaceTwo, graphDefinitionId, JSON.stringify(definition)]
    )
  }
  for (let index = 0; index < checkpointThreads; index += 1) {
    const thread = `${ids.workspaceTwo}:exe_${String(index).padStart(23, '0')}:graph:${index}`
    await putCheckpointRow(client, { thread, checkpointId: `ck-volume-${index}` })
    await putCheckpointWriteRow(client, {
      thread,
      checkpointId: `ck-volume-${index}`,
      taskId: `task-${index}`,
      index: 0,
      channel: 'values',
    })
  }
}
