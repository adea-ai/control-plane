import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { ManagedPiAdapter, ManagedPiDriver } from '@control-plane/managed-pi-adapter'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import { LocalControlPlaneComposition } from '@control-plane/local-control-plane'
import { createExecutionId } from '../apps/control-api/dist/index.js'
import {
  SqliteCommandAcceptanceRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import {
  EmbeddedExecutionWorkflowDispatcher,
  EmbeddedWorkflowRuntime,
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
import {
  DisabledGraphSegmentActivities,
  DurableExecutionLifecycleActivities,
} from '@control-plane/workflow-worker'
import { runProfileConformance } from '@control-plane/profile-portability'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  PostgresCommandAcceptanceRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import process from 'node:process'

const observedAt = '2026-09-18T12:00:00.000Z'
const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
const postgresConfigured = process.env.RUN_M10_POSTGRES_CONFORMANCE === 'true'

const plan = createExecutionPlanTestFixture()

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('cp1 waitFor timed out')
    await delay(10)
  }
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function managedPiAdapter(client) {
  return new ManagedPiAdapter({
    transport: new DirectLocalRuntimeTransport(
      new ManagedPiDriver({ client, adapterVersion: '1.0.0' })
    ),
  })
}

class CompletedManagedPiClient {
  executions = new Map()

  async inspect() {
    return {
      driverVersion: '1.0.0',
      runtimeVersion: '0.52.1',
      protocolVersion: '1.0.0',
      health: 'healthy',
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
        { name: 'interaction.user-input', support: 'supported' },
        { name: 'interaction.approval', support: 'supported' },
        { name: 'filesystem.read', support: 'supported' },
      ],
      limitations: [],
      observedAt,
    }
  }

  async start(startCommand) {
    const handle = {
      handleId: `managed-pi:${startCommand.attemptId}`,
      attemptId: startCommand.attemptId,
      startedAt: observedAt,
    }
    this.executions.set(handle.handleId, handle)
    return handle
  }

  async *progress() {
    yield { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'running' }
    yield { sequence: 2, occurredAt: observedAt, kind: 'output', text: 'completed' }
    yield {
      sequence: 3,
      occurredAt: observedAt,
      kind: 'usage',
      inputTokens: 3,
      outputTokens: 2,
      durationMs: 10,
    }
    yield { sequence: 4, occurredAt: observedAt, kind: 'status', state: 'succeeded' }
  }

  async status(handle) {
    this.#require(handle)
    return {
      state: 'succeeded',
      observedAt,
      result: {
        output: { ok: true },
        usage: { inputTokens: 3, outputTokens: 2, durationMs: 10 },
        artifacts: [],
      },
    }
  }

  submitInput(handle) {
    return this.status(handle)
  }

  submitApproval(handle) {
    return this.status(handle)
  }

  async cancel(handle, request) {
    this.#require(handle)
    return { state: 'cancelled', observedAt: request.requestedAt }
  }

  reconcile(handle) {
    return this.status(handle)
  }

  async session() {
    throw new Error('CAPABILITY_UNSUPPORTED')
  }

  async cleanup(handle) {
    this.#require(handle)
  }

  #require(handle) {
    if (!this.executions.has(handle.handleId)) throw new Error('MANAGED_PI_EXECUTION_MISSING')
  }
}

class ParkedManagedPiClient extends CompletedManagedPiClient {
  async *progress() {
    yield { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'running' }
    yield {
      sequence: 2,
      occurredAt: observedAt,
      kind: 'interaction',
      interactionId,
      interactionKind: 'input',
      prompt: 'Provide fixture input',
    }
    await new Promise(() => {})
  }

  async status() {
    return { state: 'waiting_input', observedAt }
  }

  async submitInput(handle) {
    this.executions.set(handle.handleId, handle)
    return {
      state: 'succeeded',
      observedAt,
      result: {
        output: { ok: true },
        usage: { inputTokens: 3, outputTokens: 2, durationMs: 10 },
        artifacts: [],
      },
    }
  }
}

function acceptanceEnvelope(issuedAt) {
  return {
    ...ControlApiFixtures.executionAcceptance.request,
    commandId: ControlApiFixtures.executionAcceptance.request.commandId,
    idempotencyKey: `cp1-${issuedAt}`,
    requestId: plan.correlation.requestId,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
    issuedAt,
    payload: {
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      deadlineAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
      retentionExpiresAt: new Date(Date.parse(issuedAt) + 30 * 86_400_000).toISOString(),
    },
  }
}

describe('CP1 local embedded durable execution', () => {
  test('completes an accepted execution through the embedded queue with no Restate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp1-embedded-complete-'))
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      runtimeTransport: managedPiAdapter(new CompletedManagedPiClient()),
    })
    try {
      await composition.start()
      await composition.executionPlans.put(plan)
      const response = await composition.executionAcceptanceService.accept(
        acceptanceEnvelope(new Date().toISOString()),
        'svc_cp1-standalone'
      )
      expect(response.data.status).toBe('processing')
      const executionId = response.data.executionId
      expect(composition.workflow.profile).toBe('local')
      expect(composition.workflowDispatcher).not.toBeUndefined()
      await waitFor(
        async () => (await composition.executions.getExecution(executionId)).state === 'completed'
      )
      const job = await composition.workflowJobs.get(executionId)
      expect(job.status).toBe('succeeded')
      expect(job.outcome.status).toBe('completed')
      expect(job.attempt).toBe(1)
      const manifest = await composition.manifest()
      expect(manifest.topology.durableExecution).toBe('embedded-sqlite')
      expect(manifest.topology.restateVersion).toBeUndefined()
      expect(manifest.components.every(({ ready }) => ready)).toBe(true)
    } finally {
      await composition.close()
      composition.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test('preserves the durable queue across a full composition restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp1-embedded-restart-'))
    const dataDirectory = join(directory, 'data')
    const client = new ParkedManagedPiClient()
    const first = new LocalControlPlaneComposition({
      dataDirectory,
      runtimeTransport: managedPiAdapter(client),
    })
    await first.start()
    await first.executionPlans.put(plan)
    const response = await first.executionAcceptanceService.accept(
      acceptanceEnvelope(new Date().toISOString()),
      'svc_cp1-standalone'
    )
    const executionId = response.data.executionId
    await waitFor(
      async () => (await first.executions.getExecution(executionId)).state === 'awaiting_input'
    )
    await first.close()
    first.persistence.close()

    // Restart (same data directory, new composition): the parked job survives,
    // the workflow replays its journal back to the interaction wait, and the
    // response settles it through the production interaction command path.
    const second = new LocalControlPlaneComposition({
      dataDirectory,
      runtimeTransport: managedPiAdapter(client),
    })
    try {
      await second.start()
      await waitFor(async () => {
        const job = await second.workflowJobs.get(executionId)
        return job.status === 'waiting' || job.status === 'succeeded'
      })
      const stored = await second.interactions.get(interactionId)
      expect(stored?.state).toBe('pending')
      await second.interactionCommandService.respond(
        {
          caller: { servicePrincipalId: 'svc_cp1-standalone' },
          contractVersion: { major: 3, minor: 0 },
          requestId: plan.correlation.requestId,
          workspaceId: plan.correlation.workspaceId,
          projectId: plan.correlation.projectId,
          correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
          commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
          idempotencyKey: `cp1-respond-${executionId}`,
          payloadHash: 'f'.repeat(64),
          operation: 'interaction.respond',
          issuedAt: new Date().toISOString(),
          payload: {
            executionId,
            attemptId: stored.attemptId,
            interactionId,
            expectedVersion: stored.version,
            action: 'input',
            value: 'resume-from-restart',
          },
        },
        'svc_cp1-standalone'
      )
      await waitFor(
        async () => (await second.executions.getExecution(executionId)).state === 'completed'
      )
      const job = await second.workflowJobs.get(executionId)
      expect(job.status).toBe('succeeded')
      expect(job.attempt).toBe(2)
      expect((await second.executions.getExecution(executionId)).state).toBe('completed')
    } finally {
      await second.close()
      second.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 45_000)
})

describe('CP1 persistence-profile conformance', () => {
  const conformanceResponse = {
    interactionId,
    responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
    action: 'approve',
  }
  const conformanceCases = {
    'workflow-accept-complete-v1': {
      port: {
        dispatch: { outcome: 'completed', resultReference: 'art_01JABCDEF0123456789ABCDEFG' },
        applyInteraction: {
          outcome: 'completed',
          resultReference: 'art_01JABCDEF0123456789ABCDEFG',
        },
      },
      control: {},
    },
    'workflow-interaction-resume-v1': {
      port: {
        dispatch: { outcome: 'awaiting_input', interactionId },
        applyInteraction: {
          outcome: 'completed',
          resultReference: 'art_01JABCDEF0123456789ABCDEFG',
        },
      },
      control: { waitForInteraction: async () => conformanceResponse },
    },
    'workflow-cancel-before-run-v1': {
      port: {
        dispatch: { outcome: 'completed', resultReference: 'art_01JABCDEF0123456789ABCDEFG' },
        applyInteraction: { outcome: 'completed' },
      },
      control: { cancelled: true },
    },
  }

  function scriptedPort(outcomes) {
    return {
      dispatch: async () => outcomes.dispatch,
      applyInteraction: async () => outcomes.applyInteraction,
      cancel: async () => undefined,
      cleanup: async () => undefined,
    }
  }

  function durableActivities({ plans, executions, commands, port }) {
    return new DurableExecutionLifecycleActivities({
      lifecycle: new ExecutionLifecycleService(executions),
      plans,
      runtime: port,
      graph: new DisabledGraphSegmentActivities(),
      commands,
    })
  }

  function acceptInput(caseName) {
    const receivedAt = new Date().toISOString()
    return {
      callerPrincipalId: 'svc_cp1-conformance',
      operation: 'execution.accept',
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: plan.correlation.requestId,
      idempotencyKey: `cp1-conformance-${caseName}`,
      payloadHash: 'f'.repeat(64),
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
      receivedAt,
      retentionExpiresAt: new Date(Date.parse(receivedAt) + 30 * 86_400_000).toISOString(),
      deadlineAt: new Date(Date.parse(receivedAt) + 60_000).toISOString(),
    }
  }

  function inputFor(executionId) {
    return {
      executionId,
      workflowId: `wfl_${executionId.slice(4)}`,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }
  }

  async function openSqliteWorld(profile, caseName) {
    const directory = await mkdtemp(join(tmpdir(), `cp1-${profile}-${caseName}-`))
    const provider = new SqlitePersistenceProvider({
      path: join(directory, 'state.sqlite'),
      profile,
    })
    await provider.migrate()
    const plans = new SqliteExecutionPlanRepository(provider)
    await plans.put(plan)
    const commands = new CommandInboxService({
      repository: new SqliteCommandAcceptanceRepository(provider),
      executionIdFactory: createExecutionId,
      executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans),
    })
    const executions = new SqliteExecutionRepository(provider)
    const caseDefinition = conformanceCases[caseName]
    const store = new WorkflowJobStore(provider)
    const runtime = new EmbeddedWorkflowRuntime({
      provider,
      activities: durableActivities({
        plans,
        executions,
        commands,
        port: scriptedPort(caseDefinition.port),
      }),
      pollIntervalMs: 10,
    })
    const dispatcher = new EmbeddedExecutionWorkflowDispatcher({ store })
    await runtime.start()
    return {
      kind: 'embedded',
      profile,
      directory,
      provider,
      commands,
      executions,
      store,
      dispatcher,
      close: async () => {
        await runtime.stop()
        provider.close()
        await rm(directory, { recursive: true, force: true })
      },
    }
  }

  async function openPostgresWorld(profile, credentials, caseName) {
    const database = await createIsolatedTestDatabase(credentials)
    await database.migrate()
    const plans = new PostgresExecutionPlanRepository(database.application)
    await plans.put(plan)
    const commands = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(database.application),
      executionIdFactory: createExecutionId,
      executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans),
    })
    const executions = new PostgresExecutionRepository(database.application)
    const caseDefinition = conformanceCases[caseName]
    const activities = durableActivities({
      plans,
      executions,
      commands,
      port: scriptedPort(caseDefinition.port),
    })
    return {
      kind: 'direct',
      profile,
      commands,
      executions,
      activities,
      control: caseDefinition.control,
      close: () => database.dispose(),
    }
  }

  /** Mirrors DurableExecutionAcceptanceService: the command is 'processing' once submitted. */
  async function markProcessing(world, accepted) {
    await world.commands.transitionCommand({
      callerPrincipalId: accepted.command.callerPrincipalId,
      operation: accepted.command.operation,
      workspaceId: accepted.command.workspaceId,
      projectId: accepted.command.projectId,
      idempotencyKey: accepted.command.idempotencyKey,
      expectedVersion: accepted.command.version,
      to: 'processing',
      transitionedAt: new Date().toISOString(),
    })
  }

  async function runEmbeddedCase(world, caseName) {
    const accepted = await world.commands.acceptExecution(acceptInput(caseName))
    const executionId = accepted.execution.executionId
    await world.dispatcher.submit(inputFor(executionId))
    await markProcessing(world, accepted)
    if (caseName === 'workflow-cancel-before-run-v1') {
      // Cancellation intent lands durably before the runner can claim the job.
      await world.dispatcher.cancel({
        caller: { servicePrincipalId: 'svc_cp1-conformance' },
        contractVersion: { major: 3, minor: 0 },
        requestId: plan.correlation.requestId,
        workspaceId: plan.correlation.workspaceId,
        correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
        commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: `cp1-cancel-${caseName}`,
        payloadHash: 'f'.repeat(64),
        projectId: plan.correlation.projectId,
        operation: 'execution.cancel',
        issuedAt: new Date().toISOString(),
        payload: { executionId },
      })
    }
    if (caseName === 'workflow-interaction-resume-v1') {
      // The workflow is parked on this interaction; persisting the response
      // wakes the waiter through the same store the dispatcher writes.
      await world.store.saveInteractionResponse({
        workflowKey: executionId,
        response: conformanceResponse,
        at: new Date().toISOString(),
      })
    }
    await waitFor(async () => {
      const job = await world.store.get(executionId)
      return job.status === 'succeeded' || (job.status === 'failed' && job.runAt === undefined)
    }, 20_000).catch(async (error) => {
      const job = await world.store.get(executionId)
      throw new Error(
        `cp1 case ${caseName} stuck: job=${JSON.stringify(job)} cause=${error.message}`
      )
    })
    const job = await world.store.get(executionId)
    if (job.status !== 'succeeded') {
      throw new Error(`cp1 embedded case did not succeed: ${JSON.stringify(job.lastError)}`)
    }
    return {
      executionState: (await world.executions.getExecution(executionId)).state,
      workflowStatus: job.outcome.status,
    }
  }

  async function runDirectCase(world, caseName) {
    const accepted = await world.commands.acceptExecution(acceptInput(caseName))
    const executionId = accepted.execution.executionId
    await markProcessing(world, accepted)
    const { runExecutionLifecycle } = await import('@control-plane/workflow-runtime')
    const result = await runExecutionLifecycle(
      inputFor(executionId),
      world.activities,
      world.control
    )
    return {
      executionState: (await world.executions.getExecution(executionId)).state,
      workflowStatus: result.status,
    }
  }

  test('SQLite profiles run the workflow contract cases identically', async () => {
    for (const caseName of Object.keys(conformanceCases)) {
      const local = await openSqliteWorld('local', caseName)
      const hostedSimple = await openSqliteWorld('hosted-simple', caseName)
      try {
        const localOutcome = await runEmbeddedCase(local, caseName)
        const hostedOutcome = await runEmbeddedCase(hostedSimple, caseName)
        expect(localOutcome).toEqual(hostedOutcome)
        // Concrete expectations guard against uniformly-wrong adapters.
        if (caseName === 'workflow-accept-complete-v1') {
          expect(localOutcome).toEqual({ executionState: 'completed', workflowStatus: 'completed' })
        }
        if (caseName === 'workflow-interaction-resume-v1') {
          expect(localOutcome).toEqual({ executionState: 'completed', workflowStatus: 'completed' })
        }
        if (caseName === 'workflow-cancel-before-run-v1') {
          expect(localOutcome).toEqual({ executionState: 'cancelled', workflowStatus: 'cancelled' })
        }
      } finally {
        await local.close()
        await hostedSimple.close()
      }
    }
  }, 60_000)

  // Coverage boundary: this matrix drives the same durable-execution stores and
  // ports the hosted compositions use, over a REAL Postgres baseline (direct
  // ports path). The hosted HTTP/Restate ingress itself is exercised by the
  // hosted composition suites. Skipped locally unless
  // RUN_M10_POSTGRES_CONFORMANCE=true; the Migrate Neon Branch CI lane runs it
  // against the ephemeral preview Postgres.
  const conformanceMatrix = postgresConfigured ? test : test.skip
  conformanceMatrix(
    'matches the cloud Postgres baseline through the profile conformance matrix (direct ports; runs in the Migrate Neon Branch lane)',
    async () => {
      const credentials = {
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      }
      const worlds = new Map()
      const openWorld = async (profile, caseName) => {
        const key = `${profile}:${caseName}`
        if (!worlds.has(key)) {
          worlds.set(
            key,
            profile === 'cloud' || profile === 'hosted-server'
              ? await openPostgresWorld(profile, credentials, caseName)
              : await openSqliteWorld(profile, caseName)
          )
        }
        return worlds.get(key)
      }
      const adapters = ['cloud', 'hosted-server', 'local', 'hosted-simple'].map((profile) => ({
        profile,
        ports: new Proxy({}, { get: (_target, port) => `${profile}-${String(port)}` }),
        run: async (caseId) => {
          const world = await openWorld(profile, caseId)
          return world.kind === 'embedded'
            ? runEmbeddedCase(world, caseId)
            : runDirectCase(world, caseId)
        },
      }))
      const result = await runProfileConformance(
        adapters,
        Object.keys(conformanceCases).map((caseName) => ({
          caseId: caseName,
          owner: 'workflow-runtime',
          input: {},
        }))
      )
      expect(result.conforms).toBe(true)
      for (const world of worlds.values()) await world.close()
    },
    180_000
  )

  test('case scripts stay digest-stable for the conformance ledger', () => {
    const caseIds = Object.keys(conformanceCases).toSorted()
    expect(digest(caseIds)).toBe(
      digest([
        'workflow-accept-complete-v1',
        'workflow-cancel-before-run-v1',
        'workflow-interaction-resume-v1',
      ])
    )
  })
})
