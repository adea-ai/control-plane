import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ExecutionLifecycleService, InteractionService } from '@control-plane/domain'
import {
  FilesystemObjectStore,
  ScopedObjectStoreJsonToolExecutor,
} from '@control-plane/object-store'
import {
  PiDurableEffectGate,
  SqliteDurableEffectGateStore,
  createRetainedApprovalWriteRunner,
  retainedApprovalWriteEffectKey,
} from '@control-plane/pi-durable-adapter'
import {
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqliteInteractionRepository,
  SqlitePersistenceProvider,
  SqliteToolCallRepository,
  SqliteToolRegistryRepository,
} from '@control-plane/sqlite-persistence'
import {
  InMemoryToolRateLimiter,
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
} from '@control-plane/tool-execution'
import { fixture, at, expiry } from '../models/canonical-model-host-fixtures.mjs'
import { createPiDurableCurrentToolAuthority } from './current-tool-authority.ts'

// Real local composition: SQLite interactions, tool calls, registry, executions, and the
// effect-gate store; a filesystem JSON object store (the authorized write); and the same
// gate class production composes. Intent, plan pin, and host reader stay as fixture doubles.
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFH'
const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFH'
const executorRef = 'retained.object-store-json.v1'
const toolExecutor = { type: 'internal', reference: executorRef }
const approverA = 'user:11111111-1111-4111-8111-111111111111'
const toolCallId = 'tlc_01JABCDEF0123456789ABCDEFH'
const interactionId = 'int_01JABCDEF0123456789ABCDEFH'
const approvalExpiry = '2026-10-08T12:30:00.000Z'
const working = '2026-10-08T12:10:00.000Z'
const document = { headline: 'Retained write', labels: ['approved'] }
// The tool gateway checks grant expiry against the wall clock, so the grant is open-ended here.
// Approval and intent expiry still use the test clock.
const grantExpiresAt = '2036-01-01T00:00:00.000Z'

function taskFor(
  f,
  { taskId = 'rwt_01JABCDEF0123456789ABCDEFG', input = document, version = toolVersionId } = {}
) {
  return {
    schemaVersion: 'retained-approval-write/v1',
    taskId,
    request: {
      requestId: 'req_01JABCDEF0123456789ABCDEFH',
      toolCallId,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      workspaceId: f.intent.workspaceId,
      profileId: f.plan.profile.profileId,
      toolDefinitionId,
      toolVersionId: version,
      operation: 'store-json',
      input,
      grant: {
        workspaceId: f.intent.workspaceId,
        profileId: f.plan.profile.profileId,
        toolDefinitionId,
        toolVersionId,
        operations: ['store-json'],
        expiresAt: grantExpiresAt,
      },
      audit: {
        principalRef: f.intent.canonicalActorPrincipalId,
        traceId: 'trc_01JABCDEF0123456789ABCDEFH',
      },
      idempotencyKey: retainedApprovalWriteEffectKey(taskId),
      requestedAt: at,
      policySnapshotRef: 'policy://fixture/tool-policy',
      approval: {
        interactionId,
        allowedPrincipalIds: [approverA],
        requestedAt: at,
        expiresAt: approvalExpiry,
      },
    },
  }
}

/** The operator-published tool identity the task pins: approval-gated JSON write to the object store. */
async function publishStoreJsonTool(registry, f) {
  await registry.createDefinition({
    toolDefinitionId,
    name: 'workspace.json-store',
    displayName: 'Workspace JSON store',
    description:
      'Stores canonical JSON as an immutable object and returns its reference and digest.',
    ownership: { scope: 'workspace', workspaceId: f.intent.workspaceId },
    createdAt: at,
  })
  await registry.publishVersion({
    toolDefinitionId,
    toolVersionId,
    semanticVersion: '1.0.0',
    operations: [
      {
        name: 'store-json',
        riskClass: 'medium',
        approvalMode: 'always',
        idempotency: 'inherent',
        requiredCapabilities: ['object-store.write'],
      },
    ],
    executor: toolExecutor,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: {
      type: 'object',
      properties: {
        artifactRef: { type: 'string', pattern: '^art_[0-9A-HJKMNP-TV-Z]{26}$' },
        contentDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        size: { type: 'integer', minimum: 0 },
      },
      required: ['artifactRef', 'contentDigest', 'size'],
      additionalProperties: false,
    },
    limits: { maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 5000 },
    createdAt: at,
    publishedAt: at,
  })
}

async function seedDatabase(path, f) {
  const provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await new SqliteContextPackageRepository(provider).put(f.context)
    await new SqliteExecutionPlanRepository(provider).put(f.plan)
    await publishStoreJsonTool(
      new ToolRegistry(new SqliteToolRegistryRepository(provider, f.intent.workspaceId)),
      f
    )
    const lifecycle = new ExecutionLifecycleService(new SqliteExecutionRepository(provider))
    await lifecycle.createExecution({
      executionId: f.intent.executionId,
      correlation: f.plan.correlation,
      executionPlan: {
        executionPlanId: f.plan.executionPlanId,
        contentDigest: f.plan.contentDigest,
        schemaVersion: f.plan.schemaVersion,
      },
      acceptedAt: at,
      deadlineAt: expiry,
    })
    await lifecycle.createAttempt({
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      expectedExecutionVersion: 1,
      queuedAt: at,
    })
  } finally {
    provider.close()
  }
}

/** Opens (or reopens) every store from disk and wires the production-shaped gate over them. */
async function compose(directory, f, { counter, clock }) {
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  await provider.migrate()
  const workspaceId = f.intent.workspaceId
  const interactions = new SqliteInteractionRepository(provider)
  const calls = new SqliteToolCallRepository(provider, workspaceId)
  const registry = new ToolRegistry(new SqliteToolRegistryRepository(provider, workspaceId))
  const store = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 65_536,
  })
  const writer = new ScopedObjectStoreJsonToolExecutor(store, executorRef, {
    workspaceId,
    projectId,
  })
  const gateway = new ToolGateway(registry)
  gateway.registerExecutor('internal', executorRef, {
    async execute(request, version, signal) {
      counter.invocations += 1
      if (counter.failNext) {
        counter.failNext = false
        throw new Error('OBJECT_STORE_UNREACHABLE')
      }
      return writer.execute(request, version, signal)
    },
  })
  const service = new PolicyControlledToolExecutionService({
    gateway,
    calls,
    authorizer: new StaticToolPolicyAuthorizer({
      effect: 'allow',
      decisionId: 'fixture-allow',
      policyVersion: 'fixture-policy-v1',
      reasonCode: 'GRANTED',
      requiresApproval: true,
      evaluatedAt: at,
    }),
    approvals: new InteractionToolApprovalCoordinator(
      new InteractionService(interactions),
      interactions
    ),
    rateLimiter: new InMemoryToolRateLimiter(),
    now: () => clock.now,
  })
  const authority = createPiDurableCurrentToolAuthority({
    currentExecutionAuthority: f.host,
    intents: {
      getByAttempt: async (attemptId) =>
        attemptId === f.intent.attemptId ? structuredClone(f.intent) : undefined,
      marker: () => ({
        state: 'ready',
        actorPrincipalId: 'svc_transport',
        workspaceId,
        intent: structuredClone(f.intent),
        planPin: {
          executionPlanId: f.plan.executionPlanId,
          contentDigest: f.plan.contentDigest,
          schemaVersion: f.plan.schemaVersion,
        },
      }),
    },
    executions: new SqliteExecutionRepository(provider),
    plans: f.hostOptions.plans,
    service,
    interactions,
    now: () => clock.now,
  })
  const effectDb = new DatabaseSync(join(directory, 'effect-gate.sqlite'))
  const gate = new PiDurableEffectGate({
    store: new SqliteDurableEffectGateStore(effectDb),
    service,
    assertAuthority: (request, boundary) => authority.assertCurrent(request, boundary),
    now: () => clock.now,
  })
  return {
    interactions,
    runner: createRetainedApprovalWriteRunner({ effects: gate, interactions }),
    close() {
      effectDb.close()
      provider.close()
    },
  }
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-retained-approval-write-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('approval gates the authorized write, settles once, and replays after physical reopen without a second write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    const task = taskFor(f)
    const pending = await first.runner.run(task)
    expect(pending).toMatchObject({ state: 'awaiting_approval' })
    expect(counter.invocations).toBe(0)

    await new InteractionService(first.interactions).respond({
      interactionId,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
      action: 'approve',
      respondingPrincipalId: approverA,
      expectedVersion: 1,
      respondedAt: '2026-10-08T12:05:00.000Z',
    })
    const settled = await first.runner.run(task)
    expect(settled).toMatchObject({ state: 'succeeded', call: { toolCallId } })
    expect(counter.invocations).toBe(1)
    first.close()

    const reopened = await compose(directory, f, { counter, clock })
    try {
      await expect(reopened.runner.run(task)).resolves.toEqual(settled)
      expect(counter.invocations).toBe(1)
    } finally {
      reopened.close()
    }
  })
})

test('a revoked approval cannot authorize the write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      await session.runner.run(taskFor(f))
      await new InteractionService(session.interactions).resolveTerminal(interactionId, working)
      await expect(session.runner.run(taskFor(f))).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('changed pins after restart conflict with the retained effect instead of creating a second write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    await first.runner.run(taskFor(f))
    await new InteractionService(first.interactions).respond({
      interactionId,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
      action: 'approve',
      respondingPrincipalId: approverA,
      expectedVersion: 1,
      respondedAt: '2026-10-08T12:05:00.000Z',
    })
    await first.runner.run(taskFor(f))
    expect(counter.invocations).toBe(1)
    first.close()

    const reopened = await compose(directory, f, { counter, clock })
    try {
      const changed = taskFor(f, { input: { headline: 'Changed after approval', labels: [] } })
      await expect(reopened.runner.run(changed)).rejects.toMatchObject({
        code: 'PI_EFFECT_IDENTITY_CONFLICT',
      })
      expect(counter.invocations).toBe(1)
    } finally {
      reopened.close()
    }
  })
})

test('a task pinned to a tool version the registry does not hold is denied before any write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      const task = taskFor(f, {
        taskId: 'rwt_01JABCDEF0123456789ABCDEFH',
        version: 'tlv_01JABCDEF0123456789ABCDEFZ',
      })
      // The approval request is created first; admission then rejects the stale tool pin, before and after approval.
      await expect(session.runner.run(task)).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      await new InteractionService(session.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      await expect(session.runner.run(task)).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('concurrent runs of one approved task settle once', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      const task = taskFor(f)
      await session.runner.run(task)
      await new InteractionService(session.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      const results = await Promise.allSettled([1, 2, 3].map(() => session.runner.run(task)))
      const fulfilled = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
      for (const outcome of fulfilled) expect(outcome).toEqual(fulfilled[0])
      expect(fulfilled[0]).toMatchObject({ state: 'succeeded' })
      expect(counter.invocations).toBe(1)
    } finally {
      session.close()
    }
  })
})

test('an uncertain write settles once as reconciliation and is never retried after reopen', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0, failNext: true }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    const task = taskFor(f, { taskId: 'rwt_01JABCDEF0123456789ABCDEFI' })
    await first.runner.run(task)
    await new InteractionService(first.interactions).respond({
      interactionId,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
      action: 'approve',
      respondingPrincipalId: approverA,
      expectedVersion: 1,
      respondedAt: '2026-10-08T12:05:00.000Z',
    })
    const uncertain = await first.runner.run(task)
    expect(uncertain).toMatchObject({ state: 'reconciliation_required' })
    expect(counter.invocations).toBe(1)
    first.close()

    const reopened = await compose(directory, f, { counter, clock })
    try {
      await expect(reopened.runner.run(task)).resolves.toEqual(uncertain)
      expect(counter.invocations).toBe(1)
    } finally {
      reopened.close()
    }
  })
})
