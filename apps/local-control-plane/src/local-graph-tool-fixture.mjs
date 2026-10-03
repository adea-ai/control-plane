import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { GraphDefinitionCatalog } from '@control-plane/orchestration'
import { ToolRegistry } from '@control-plane/tool-execution/registry'
import {
  SqlitePersistenceProvider,
  SqliteToolRegistryRepository,
  SqliteGraphDefinitionRepository,
} from '@control-plane/sqlite-persistence'
import { LocalControlApiComposition } from './local-api-composition.ts'

const at = '2026-10-01T06:00:00.000Z'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'

export async function createLocalGraphToolFixture({
  requiredCapabilities = [],
  grantedCapabilities = [],
  activate = true,
  sharedPinNodes = false,
  approvalMode = 'always',
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-graph-tool-authority-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await persistence.migrate()
    const api = new LocalControlApiComposition(persistence, 'http://127.0.0.1:1')
    const inputs = createExecutionPlanTestFixtureInputs()
    for (const constraints of [
      inputs.constraints,
      inputs.profile.definition.executionConstraints,
    ]) {
      constraints.tools.grants[0].operations = ['store-json']
      constraints.tools.grants[0].requiredCapabilities = grantedCapabilities
      if (approvalMode === 'never') {
        constraints.tools.grants[0].approval = 'none'
        constraints.interaction.approvals = 'allowed'
      }
    }
    const workspaceId = inputs.correlation.workspaceId
    const registry = new ToolRegistry(new SqliteToolRegistryRepository(persistence, workspaceId))
    await registry.createDefinition({
      toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
      name: 'project-files',
      displayName: 'Project files',
      description: 'Configured Local tool',
      ownership: { scope: 'workspace', workspaceId },
      createdAt: at,
    })
    const version = await registry.publishVersion({
      toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
      toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
      semanticVersion: '1.2.0',
      operations: [
        {
          name: 'store-json',
          riskClass: 'medium',
          approvalMode,
          idempotency: 'inherent',
          requiredCapabilities,
        },
      ],
      executor: { type: 'internal', reference: 'local.object-store-json.v1' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      // These tests verify durable effects, not timeout policy. Allow a bounded
      // budget for real filesystem writes on loaded test hosts.
      limits: { maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 30_000 },
      createdAt: at,
      publishedAt: at,
    })
    const toolPin = {
      toolDefinitionId: version.toolDefinitionId,
      toolVersionId: version.toolVersionId,
      contentDigest: version.contentDigest,
      operation: 'store-json',
    }
    const graph = await new GraphDefinitionCatalog(
      new SqliteGraphDefinitionRepository(persistence, workspaceId)
    ).publish({
      definition: {
        graphDefinitionId: 'graph:tool-authority',
        graphVersion: '1.0.0',
        schemaVersion: 1,
        nodes: [
          { node: 'store', operation: { kind: 'tool', name: 'store', toolPin } },
          ...(sharedPinNodes
            ? [{ node: 'store_later', operation: { kind: 'tool', name: 'store', toolPin } }]
            : []),
        ],
        edges: sharedPinNodes
          ? [
              { from: '__start__', to: 'store' },
              { from: 'store', to: 'store_later' },
              { from: 'store_later', to: '__end__' },
            ]
          : [
              { from: '__start__', to: 'store' },
              { from: 'store', to: '__end__' },
            ],
        schemas: { input: 'schema:json', state: 'schema:json', output: 'schema:json' },
        requiredCapabilities: ['graph.tool-pins.v1'],
        compatibility: {
          contractMajorVersions: [1],
          compilerVersions: ['1.0.0'],
          adapterVersions: ['1.0.0', '1.4.12'],
        },
      },
      publishedAt: at,
    })
    const plan = new ExecutionPlanCompiler('1.0.0').compile({
      ...inputs,
      graph: { reference: graph.reference, input: { message: 'execute' } },
    })
    await api.contextPackages.put(inputs.contextPackage)
    const reference = { ...(await api.executionPlans.put(plan)), schemaVersion: 1 }
    const commands = new CommandInboxService({
      repository: api.commandRepository,
      executionIdFactory: () => executionId,
      executionPlanValidator: { validate: async () => true },
      now: () => at,
    })
    await commands.acceptExecution({
      callerPrincipalId: 'svc_graph-tool-test',
      operation: 'execution.accept',
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: plan.correlation.requestId,
      idempotencyKey: 'graph-tool-authority-0001',
      payloadHash: 'a'.repeat(64),
      correlation: {
        workspaceId,
        projectId: plan.correlation.projectId,
        taskId: plan.correlation.taskId,
        agentId: plan.correlation.agentId,
      },
      executionPlan: reference,
      receivedAt: at,
      retentionExpiresAt: '2026-11-01T00:00:00.000Z',
    })
    const attempt = await new ExecutionLifecycleService(api.executions).createAttempt({
      executionId,
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      expectedExecutionVersion: 1,
      queuedAt: at,
    })
    if (activate) {
      const lifecycle = new ExecutionLifecycleService(api.executions)
      let execution = await api.executions.getExecution(executionId)
      if (execution.state === 'accepted')
        execution = await lifecycle.transitionExecution({
          executionId,
          expectedVersion: execution.version,
          to: 'queued',
          transitionedAt: at,
        })
      await lifecycle.transitionExecution({
        executionId,
        expectedVersion: execution.version,
        to: 'running',
        transitionedAt: at,
      })
      await lifecycle.transitionAttempt({
        attemptId: attempt.attemptId,
        expectedVersion: attempt.version,
        to: 'running',
        transitionedAt: at,
      })
    }
    const operation = {
      workspaceId,
      executionId,
      attemptId: attempt.attemptId,
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      threadId: 'graph:' + executionId,
      node: 'store',
      kind: 'tool',
      name: 'store',
      input: { message: 'execute' },
      idempotencyKey: 'graph-op-v1:' + 'b'.repeat(64),
      toolPin,
    }
    const options = { api, registry, resolveGraph: async () => graph }
    return {
      directory,
      persistence,
      api,
      inputs,
      registry,
      version,
      graph,
      plan,
      operation,
      options,
      at,
      cleanup: async () => {
        persistence.close()
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    persistence.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
