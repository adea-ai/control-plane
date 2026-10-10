// M17.02.2 (#1025): self-hosted simple recovery and backup through the
// LocalControlPlaneComposition root with profile `hosted-simple` (SQLite
// persistence, the pinned @restatedev/restate-server, Restate ingress).
//
// - Close/reopen and filesystem-checkpoint restore: an approval paused in the
//   real Restate server keeps its execution identity, attempt, and plan record.
//   A stale owner is refused by the execution-version fence, a duplicate run
//   submission starts no second effect, and one approval resumes exactly once.
// - Portable backup: the composition's own SQLite persistence refuses active
//   work, exports, and restores into a freshly provisioned composition after the
//   source composition is closed.
//
// Not covered here: SIGKILL of the composition process with its Restate child
// orphaned, Restate drain, upgrade, rollback, and Hosted. Those stay unproven in
// docs/profile-recovery-acceptance-map.md.

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, test } from 'bun:test'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/src/composition.ts'
import {
  LangGraphOrchestrationAdapter,
  LangGraphSqliteCheckpointSaver,
  deterministicInterruptGraph,
} from '../packages/langgraph-adapter/src/index.ts'
import { OrchestrationGraphSegmentActivities } from '../packages/workflow-runtime/src/index.ts'
import {
  createFilesystemCheckpoint,
  restoreFilesystemCheckpoint,
  verifyFilesystemCheckpoint,
} from '@control-plane/deployment'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import { ManagedPiAdapter, ManagedPiDriver } from '@control-plane/managed-pi-adapter'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  applyPortableImport,
  exportPortableState,
  planPortableImport,
} from '@control-plane/profile-portability'
import { SqliteEvaluationRepository } from '@control-plane/sqlite-persistence'
import { observedEvaluationFixture } from '../packages/profile-portability/src/evaluation-fixture.mjs'
import { CompletedManagedPiClient } from './fixtures/completed-managed-pi-client.mjs'
import {
  createRegisteredGraphPlan,
  seedRegisteredGraphPlan,
} from './fixtures/registered-graph-plan.mjs'

const createdAt = '2026-10-09T00:00:00.000Z'
const executionKey = 'exe_01JABCDEF0123456789ABCDEFG'
const approvalInteractionId = 'approval-1'
const graph = {
  graphDefinitionId: 'self-hosted-simple-recovery',
  graphVersion: '1.0.0',
  contentDigest: `sha256:${'a'.repeat(64)}`,
}
const graphInput = { objective: 'recover a self-hosted simple approval' }

const temporaryDirectories = []
const temporaryCompositions = []

/** Releases what a composition holds before its directory is removed. A started
 *  composition drains and closes itself through `close()`. An unstarted one is
 *  not closed by `close()`, so its storage handle is released explicitly. */
async function disposeComposition(composition) {
  const failures = []
  const release = async (step) => {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  await release(() => composition.close())
  await release(() => composition.persistence.close())
  await release(() => composition.coordination.close())
  await release(() => composition.observability.close())
  if (failures.length > 0) {
    throw new AggregateError(failures, 'LocalControlPlaneComposition disposal failed')
  }
}

afterEach(async () => {
  const failures = []
  for (const composition of temporaryCompositions.splice(0)) {
    try {
      await disposeComposition(composition)
    } catch (error) {
      failures.push(error)
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'self-hosted simple cleanup failed')
})

async function openTempDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function isolatedPorts() {
  const servers = []
  const ports = {}
  try {
    for (const name of [
      'restateAdminPort',
      'restateIngressPort',
      'restateNodePort',
      'workflowEndpointPort',
    ]) {
      const server = createServer()
      servers.push(server)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      ports[name] = server.address().port
    }
    return ports
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

function createDirectManagedPiAdapter() {
  return new ManagedPiAdapter({
    transport: new DirectLocalRuntimeTransport(
      new ManagedPiDriver({ client: new CompletedManagedPiClient(), adapterVersion: '1.0.0' })
    ),
  })
}

/** The graph run is the only runtime path here; the managed-Pi transport is configured
 *  because the composition requires a runtime for graph execution, and it is not invoked. */
function openSelfHostedSimple({ dataDirectory, ports, plan, registration, context }) {
  const composition = new LocalControlPlaneComposition({
    profile: 'hosted-simple',
    dataDirectory,
    durableExecution: 'restate',
    runtimeTransport: createDirectManagedPiAdapter(),
    ...ports,
    graphActivitiesFactory: ({ persistence }) =>
      new OrchestrationGraphSegmentActivities(
        new LangGraphOrchestrationAdapter({
          checkpointer: new LangGraphSqliteCheckpointSaver(
            persistence,
            plan.correlation.workspaceId
          ),
          graphs: [
            {
              reference: graph,
              build(buildContext) {
                const runnable = registration.build(buildContext)
                return {
                  invoke: async (input, config) => {
                    const state = await runnable.invoke(input, config)
                    if (state.output?.decision === undefined) return state
                    await context.local.objectStore.put({
                      key: context.resultKey,
                      body: new TextEncoder().encode(JSON.stringify(state.output)),
                      contentType: 'application/json',
                      metadata: { execution: context.executionId },
                    })
                    return {
                      ...state,
                      output: { ...state.output, artifactRef: context.artifactId },
                    }
                  },
                }
              },
            },
          ],
          operations: {
            invoke: async ({ name }) => {
              context.operations.push(name)
              return { value: name }
            },
            cancel: async () => true,
          },
          events: { publish: async () => {} },
        })
      ),
  })
  temporaryCompositions.push(composition)
  return composition
}

function planReferenceOf(plan) {
  return {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
  }
}

function acceptanceCommand(plan) {
  return {
    callerPrincipalId: 'svc_self-hosted-simple-recovery',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: 'self-hosted-simple-recovery-execution',
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
    retentionExpiresAt: '2099-01-01T00:00:00.000Z',
  }
}

async function waitForExecution(composition, executionId, done) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const execution = await composition.executions.getExecution(executionId)
    if (done(execution)) return execution
    await delay(25)
  }
  throw new Error('SELF_HOSTED_SIMPLE_EXECUTION_TIMEOUT')
}

describe('M17.02.2 self-hosted simple composition recovery (hosted-simple, pinned Restate)', () => {
  test.each(['restart', 'checkpoint-restore'])(
    'a paused approval keeps its identity across %s, refuses a stale owner, and resumes once',
    async (recoveryMode) => {
      const directory = await openTempDirectory('profile-recovery-self-hosted-simple-')
      const ports = await isolatedPorts()
      const plan = createRegisteredGraphPlan(graph, graphInput)
      const registration = deterministicInterruptGraph(graph)
      const context = {
        local: undefined,
        executionId: undefined,
        artifactId: undefined,
        resultKey: undefined,
        operations: [],
      }
      const open = (dataDirectory) =>
        openSelfHostedSimple({ dataDirectory, ports, plan, registration, context })
      let dataDirectory = join(directory, 'original')
      let local = open(dataDirectory)
      context.local = local
      const post = (path, body) =>
        fetch(
          `http://127.0.0.1:${ports.restateIngressPort}/execution-lifecycle/${context.executionId}/${path}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          }
        )
      try {
        await local.start()
        const executionPlanValidator = await seedRegisteredGraphPlan(local, plan, {
          reference: graph,
          input: graphInput,
        })
        const acceptedAt = new Date().toISOString()
        const accepted = await new CommandInboxService({
          repository: local.commandRepository,
          executionIdFactory: () => `exe_${plan.executionPlanId.slice(4)}`,
          executionPlanValidator,
        }).acceptExecution({
          ...acceptanceCommand(plan),
          receivedAt: acceptedAt,
          retentionExpiresAt: new Date(Date.parse(acceptedAt) + 30 * 86400000).toISOString(),
        })
        const executionId = accepted.execution.executionId
        context.executionId = executionId
        context.artifactId = `art_${executionId.slice(4)}`
        context.resultKey = `graph-results/${executionId}/result.json`
        const acceptedVersion = (await local.executions.getExecution(executionId)).version
        const runInput = {
          executionId,
          workflowId: `wfl_${executionId.slice(4)}`,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          deadlineAt: new Date(Date.now() + 90000).toISOString(),
          graph: {
            workspaceId: plan.correlation.workspaceId,
            reference: graph,
            threadId: `graph:${executionId}`,
            input: plan.graph.input,
          },
        }
        expect((await post('run/send', runInput)).ok).toBe(true)
        await waitForExecution(
          local,
          executionId,
          (execution) => execution.state === 'awaiting_input'
        )
        expect(context.operations).toEqual(['prepare'])

        const paused = await local.executions.getExecution(executionId)
        expect(paused).toMatchObject({
          state: 'awaiting_input',
          attemptCount: 1,
          latestAttemptId: `att_${executionId.slice(4)}`,
        })
        const retainedPlan = await local.executionPlans.get(planReferenceOf(plan))
        const retainedArtifact = await local.objectStore.put({
          key: 'recovery/self-hosted-simple.json',
          body: new TextEncoder().encode('{"retained":true}'),
          contentType: 'application/json',
          metadata: { execution: executionId },
        })
        await local.close()

        if (recoveryMode === 'checkpoint-restore') {
          const checkpointDirectory = join(directory, 'checkpoint')
          const checkpoint = await createFilesystemCheckpoint({
            sourceDirectory: dataDirectory,
            destinationDirectory: checkpointDirectory,
            profile: 'hosted-simple',
          })
          expect(await verifyFilesystemCheckpoint(checkpointDirectory)).toEqual(checkpoint)
          dataDirectory = join(directory, 'restored')
          await restoreFilesystemCheckpoint({
            checkpointDirectory,
            destinationDirectory: dataDirectory,
          })
        }
        local = open(dataDirectory)
        context.local = local
        await local.start()

        // Retained identity and input: the reopened composition reads back the same
        // execution, attempt, plan record, and artifact that were paused before close.
        const resumed = await local.executions.getExecution(executionId)
        expect(resumed).toMatchObject({
          state: 'awaiting_input',
          version: paused.version,
          attemptCount: 1,
          latestAttemptId: paused.latestAttemptId,
          executionPlan: paused.executionPlan,
        })
        expect(await local.executionPlans.get(planReferenceOf(plan))).toEqual(retainedPlan)
        expect(retainedPlan).toBeDefined()
        expect((await local.objectStore.get('recovery/self-hosted-simple.json')).sha256).toBe(
          retainedArtifact.sha256
        )
        // The composition's own attempt step returns the retained attempt rather than
        // creating a second one.
        await expect(
          local.executionLifecycleActivities.ensureAttempt({
            executionId,
            workflowId: runInput.workflowId,
            effectKey: `${runInput.workflowId}:attempt`,
          })
        ).resolves.toEqual({ attemptId: paused.latestAttemptId })

        // Stale owner: an owner that accepted the execution at its original version is
        // refused by the execution-version fence and cannot create a second attempt.
        await expect(
          new ExecutionLifecycleService(local.executions).createAttempt({
            executionId,
            attemptId: `att_${'7'.repeat(26)}`,
            expectedExecutionVersion: acceptedVersion,
            queuedAt: new Date().toISOString(),
          })
        ).rejects.toMatchObject({ code: 'STALE_EXECUTION_VERSION' })
        // A second owner resubmitting the same run is accepted by Restate, but the workflow
        // key admits one run: the attempt, the version, and the graph operations stay as
        // they were. A second `prepare` or `finalize` would fail the checks below.
        expect((await post('run/send', runInput)).ok).toBe(true)
        expect(await local.executions.getExecution(executionId)).toMatchObject({
          version: paused.version,
          attemptCount: 1,
          latestAttemptId: paused.latestAttemptId,
        })
        expect(context.operations).toEqual(['prepare'])

        // Single effective resume: the first answer resolves the durable approval. A
        // conflicting second answer for the same interaction must not apply.
        expect(
          (
            await post('respondToInteraction', {
              interactionId: approvalInteractionId,
              responseId: 'self-hosted-response-one',
              action: 'approve',
            })
          ).ok
        ).toBe(true)
        await post('respondToInteraction', {
          interactionId: approvalInteractionId,
          responseId: 'self-hosted-response-two',
          action: 'deny',
        })
        const execution = await waitForExecution(local, executionId, (current) =>
          ['completed', 'failed', 'cancelled', 'timed_out'].includes(current.state)
        )
        expect(execution).toMatchObject({
          state: 'completed',
          terminalResultRef: context.artifactId,
          attemptCount: 1,
          latestAttemptId: paused.latestAttemptId,
        })
        expect(
          JSON.parse(
            new TextDecoder().decode((await local.objectStore.get(context.resultKey)).body)
          )
        ).toEqual({ decision: 'approve' })
        expect(context.operations).toEqual(['prepare', 'finalize'])
        const attach = await fetch(
          `http://127.0.0.1:${ports.restateIngressPort}/restate/workflow/execution-lifecycle/${executionId}/attach`,
          { signal: AbortSignal.timeout(15000) }
        )
        expect(attach.ok).toBe(true)
        expect(await attach.json()).toMatchObject({
          status: 'completed',
          graphCheckpointId: expect.any(String),
        })
      } finally {
        await local.close()
      }
    },
    90000
  )

  test('portable backup refuses active self-hosted simple work, then restores into a fresh composition after total loss', async () => {
    const sourceDirectory = await openTempDirectory('profile-recovery-self-hosted-src-')
    const source = new LocalControlPlaneComposition({
      profile: 'hosted-simple',
      dataDirectory: sourceDirectory,
    })
    temporaryCompositions.push(source)
    // The source is never started: the portable export reads its SQLite persistence only.
    await source.persistence.migrate()
    const evaluation = await observedEvaluationFixture()
    await new SqliteEvaluationRepository(source.persistence).saveRun(evaluation)

    await expect(
      exportPortableState(
        new PersistencePortableStateSource({
          persistence: source.persistence,
          componentVersions: { contracts: '1.0.0' },
          activeWorkIds: async () => [executionKey],
        }),
        { exportId: 'self-hosted-fenced-export', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_ACTIVE_WORK' })

    const backup = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: source.persistence,
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'self-hosted-simple-backup', createdAt }
    )
    expect(backup).toMatchObject({
      sourceProfile: 'hosted-simple',
      quiesced: true,
      compatibility: { sourcePersistence: 'sqlite' },
    })
    expect(backup.records.length).toBeGreaterThan(0)

    // Total loss: the source composition is closed before the restore target is opened.
    await disposeComposition(source)
    const restoredDirectory = await openTempDirectory('profile-recovery-self-hosted-dst-')
    const restored = new LocalControlPlaneComposition({
      profile: 'hosted-simple',
      dataDirectory: restoredDirectory,
    })
    temporaryCompositions.push(restored)
    await restored.persistence.migrate()
    const destination = new PersistencePortableStateDestination({
      persistence: restored.persistence,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(backup, destination)
    expect(plan).toMatchObject({ applicable: true, conflicts: [] })
    await expect(
      applyPortableImport(backup, plan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })

    // Reopen the restored composition: the retained evaluation is read back from disk.
    await disposeComposition(restored)
    const reopened = new LocalControlPlaneComposition({
      profile: 'hosted-simple',
      dataDirectory: restoredDirectory,
    })
    temporaryCompositions.push(reopened)
    await reopened.persistence.migrate()
    await expect(
      new SqliteEvaluationRepository(reopened.persistence).getRun(evaluation.evalRunId)
    ).resolves.toEqual(evaluation)
  })
})
