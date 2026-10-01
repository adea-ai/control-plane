import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/src/composition.ts'
import { seedSystemCatalogOwners } from '../apps/local-control-plane/src/test-catalog-owners.mjs'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { GraphDefinitionCatalog } from '@control-plane/orchestration'
import {
  SqliteGraphDefinitionRepository,
  SqliteProjectStateRepository,
} from '@control-plane/sqlite-persistence'

const publishedAt = '2026-10-01T04:00:00.000Z'
const definition = {
  graphDefinitionId: 'managed-composition',
  graphVersion: '1.0.0',
  schemaVersion: 1,
  nodes: [{ node: 'work', operation: { kind: 'tool', name: 'approved-records-v1' } }],
  edges: [
    { from: '__start__', to: 'work' },
    { from: 'work', to: '__end__' },
  ],
  schemas: { input: 'managed/input/v1', state: 'managed/state/v1', output: 'managed/output/v1' },
  requiredCapabilities: ['tool.invoke'],
  compatibility: {
    contractMajorVersions: [1],
    compilerVersions: ['1.0.0'],
    adapterVersions: ['1.4.12'],
  },
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function graphRuntime(calls) {
  return {
    capabilities: ['tool.invoke'],
    compiler: {
      operationAllowlist: [{ kind: 'tool', name: 'approved-records-v1' }],
      schemaRegistry: {
        getValidator(reference) {
          if (reference === 'managed/input/v1')
            return (value) => record(value) && value.objective === 'managed composition'
          if (reference === 'managed/state/v1')
            return (value) =>
              record(value) && record(value.input) && record(value.values) && record(value.output)
          if (reference === 'managed/output/v1') return record
          return undefined
        },
      },
    },
    // The provider is a fixture; this test proves the composition, not real tool delivery.
    operations: {
      invoke: async (operation) => {
        calls.push(operation)
        return { value: 'fixture result' }
      },
      cancel: async () => true,
    },
  }
}

async function seedPlan(composition, selection) {
  const inputs = createExecutionPlanTestFixtureInputs()
  await seedSystemCatalogOwners(composition.catalog, inputs.profile, inputs.skills)
  await composition.catalog.insertAgentProfileVersion(inputs.profile)
  for (const skill of inputs.skills) await composition.catalog.insertSkillVersion(skill)
  await composition.contextPackages.put(inputs.contextPackage)
  const plan = new ExecutionPlanCompiler('1.0.0').compile({ ...inputs, graph: selection })
  await composition.executionPlans.put(plan)
  return plan
}

async function validatePlan(composition, selection) {
  const inputs = createExecutionPlanTestFixtureInputs()
  const package_ = inputs.contextPackage
  await new SqliteProjectStateRepository(composition.persistence).create({
    schemaVersion: 1,
    ...package_.projectState,
    items: [],
    createdAt: publishedAt,
    updatedAt: publishedAt,
  })
  const base = ControlApiFixtures.executionValidation.request
  const request = {
    ...base,
    caller: { servicePrincipalId: 'svc_managed-graph-test' },
    payload: {
      ...base.payload,
      profileVersionId: inputs.profile.profileVersionId,
      skillVersionIds: inputs.skills.map(({ skillVersionId }) => skillVersionId),
      projectState: package_.projectState,
      contextPackage: {
        contextPackageId: package_.contextPackageId,
        contentDigest: package_.contentDigest,
        schemaVersion: package_.schemaVersion,
        compilerVersion: package_.compiler.version,
      },
      policySnapshot: {
        policySnapshotId: inputs.constraints.policySnapshot.policyId,
        revision: inputs.constraints.policySnapshot.version,
        contentDigest: inputs.constraints.policySnapshot.digest,
      },
      runtimeRequirements: ['stream.output'],
      outputContractRef: 'contract://execution-result/v1',
      graph: selection,
    },
  }
  const response = await composition.executionValidationService.validate(
    request,
    request.caller.servicePrincipalId
  )
  expect(response.data.valid).toBe(true)
  return composition.executionPlans.get(response.data.executionPlan)
}

function acceptance(plan, key = 'managed-graph-admission-0001') {
  return {
    callerPrincipalId: 'svc_managed-graph-test',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: key,
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
    receivedAt: publishedAt,
    retentionExpiresAt: '2026-11-01T04:00:00.000Z',
  }
}

async function ownedComposition(profile, body) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-managed-graph-'))
  const calls = []
  const createComposition = () =>
    new LocalControlPlaneComposition({
      dataDirectory: directory,
      profile,
      runtimeTransport: { transportKind: 'direct-local' },
      graphRuntime: graphRuntime(calls),
    })
  let composition = createComposition()
  const reopen = async () => {
    await composition.close()
    composition.persistence.close({ checkpoint: true })
    composition = createComposition()
    await composition.persistence.migrate()
    return composition
  }
  try {
    await composition.persistence.migrate()
    const workspaceId = createExecutionPlanTestFixtureInputs().correlation.workspaceId
    const catalog = new GraphDefinitionCatalog(
      new SqliteGraphDefinitionRepository(composition.persistence, workspaceId)
    )
    const graph = await catalog.publish({ definition, publishedAt })
    await body({ composition, catalog, graph, calls, workspaceId, reopen })
  } finally {
    try {
      await composition.close()
    } finally {
      composition.persistence.close({ checkpoint: true })
      await rm(directory, { recursive: true, force: true })
    }
  }
}

for (const profile of ['local', 'hosted-simple']) {
  test(`${profile} admits and executes catalog graphs through its own compiler, checkpoints and durable events`, async () => {
    await ownedComposition(profile, async ({ composition, graph, calls, reopen }) => {
      const selection = { reference: graph.reference, input: { objective: 'managed composition' } }
      await seedPlan(composition, selection)
      const plan = await validatePlan(composition, selection)
      const accepted = await composition.commands.acceptExecution(acceptance(plan))
      const executionId = accepted.execution.executionId
      const workflowId = `wfl_${executionId.slice(4)}`
      await composition.executionLifecycleActivities.persistStatus({
        executionId,
        state: 'queued',
        effectKey: 'managed-graph-queued',
      })
      const attempt = await composition.executionLifecycleActivities.ensureAttempt({
        executionId,
        workflowId,
        effectKey: 'managed-graph-attempt',
      })
      await composition.executionLifecycleActivities.persistStatus({
        executionId,
        attemptId: attempt.attemptId,
        state: 'running',
        effectKey: 'managed-graph-running',
      })
      const result = await composition.executionLifecycleActivities.runGraphSegment({
        executionId,
        attemptId: attempt.attemptId,
        workspaceId: plan.correlation.workspaceId,
        workflowId,
        graph: plan.graph.reference,
        threadId: `graph:${executionId}`,
        input: plan.graph.input,
        idempotencyKey: 'managed:graph:run',
      })
      expect(result.outcome).toBe('completed')
      expect(result.checkpointId).toBeString()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        executionId,
        attemptId: attempt.attemptId,
        kind: 'tool',
        name: 'approved-records-v1',
      })
      const pending = await composition.executionEvents.queryPending(20)
      expect(pending.map(({ type }) => type)).toEqual([
        'graph.started',
        'graph.node_started',
        'graph.node_completed',
        'graph.completed',
      ])
      expect(pending.every(({ publication }) => publication.status === 'pending')).toBe(true)
      const recovered = await reopen()
      const continued = await recovered.executionLifecycleActivities.continueGraphSegment({
        executionId,
        attemptId: attempt.attemptId,
        workspaceId: plan.correlation.workspaceId,
        workflowId,
        graph: plan.graph.reference,
        threadId: `graph:${executionId}`,
        checkpointId: result.checkpointId,
        idempotencyKey: 'managed:graph:recover',
      })
      expect(continued.outcome).toBe('completed')
      expect(calls).toHaveLength(1)
      expect((await recovered.executionEvents.queryPending(20)).slice(0, 4)).toEqual(pending)
    })
  })

  test(`${profile} rejects input and catalog programs the configured compiler cannot execute before acceptance`, async () => {
    await ownedComposition(profile, async ({ composition, catalog, graph, calls, workspaceId }) => {
      const authority = composition.executionValidationService.options.graphs
      expect(
        await authority.validate(workspaceId, {
          reference: graph.reference,
          input: { objective: 'wrong input' },
        })
      ).toBe(false)
      const unsupported = await catalog.publish({
        definition: {
          ...definition,
          graphVersion: '2.0.0',
          nodes: [{ node: 'work', operation: { kind: 'tool', name: 'unconfigured-operation' } }],
        },
        publishedAt,
      })
      const selection = {
        reference: unsupported.reference,
        input: { objective: 'managed composition' },
      }
      expect(await authority.validate(workspaceId, selection)).toBe(false)
      const plan = await seedPlan(composition, selection)
      await expect(composition.commands.acceptExecution(acceptance(plan))).rejects.toMatchObject({
        code: 'INVALID_EXECUTION_PLAN_REFERENCE',
      })
      expect(
        await composition.commandRepository.get({
          callerPrincipalId: 'svc_managed-graph-test',
          operation: 'execution.accept',
          workspaceId,
          projectId: plan.correlation.projectId,
          idempotencyKey: 'managed-graph-admission-0001',
        })
      ).toBeUndefined()
      expect(calls).toHaveLength(0)
    })
  })
}

test('managed graph configuration rejects competing adapters and missing direct runtime before opening SQLite', () => {
  const base = {
    dataDirectory: '/tmp/unused-managed-graph-conflict',
    graphRuntime: graphRuntime([]),
  }
  expect(() => new LocalControlPlaneComposition(base)).toThrow('LOCAL_GRAPH_RUNTIME_REQUIRED')
  for (const competing of [
    { graphActivities: {} },
    { graphActivitiesFactory: () => ({}) },
    { activities: {} },
  ]) {
    expect(
      () =>
        new LocalControlPlaneComposition({
          ...base,
          runtimeTransport: { transportKind: 'direct-local' },
          ...competing,
        })
    ).toThrow('LOCAL_GRAPH_CONFIGURATION_CONFLICT')
  }
})
