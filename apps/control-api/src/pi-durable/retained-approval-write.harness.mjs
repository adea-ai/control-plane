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
import { at, expiry } from '../models/canonical-model-host-fixtures.mjs'
import { createPiDurableCurrentToolAuthority } from './current-tool-authority.ts'

// Real local composition: SQLite interactions, tool calls, registry, executions, and the
// effect-gate store; a filesystem JSON object store (the authorized write); and the same
// gate class production composes. Intent, plan pin, and host reader stay as fixture doubles.
export const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
export const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFH'
export const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFH'
export const executorRef = 'retained.object-store-json.v1'
export const toolExecutor = { type: 'internal', reference: executorRef }
export const approverA = 'user:11111111-1111-4111-8111-111111111111'
export const toolCallId = 'tlc_01JABCDEF0123456789ABCDEFH'
export const interactionId = 'int_01JABCDEF0123456789ABCDEFH'
export const approvalExpiry = '2026-10-08T12:30:00.000Z'
export const working = '2026-10-08T12:10:00.000Z'
export const document = { headline: 'Retained write', labels: ['approved'] }
// The tool gateway checks grant expiry against the wall clock, so the grant is open-ended here.
// Approval and intent expiry still use the test clock.
export const grantExpiresAt = '2036-01-01T00:00:00.000Z'

export function taskFor(
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
export async function publishStoreJsonTool(registry, f) {
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

export async function seedDatabase(path, f) {
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
export async function compose(directory, f, { counter, clock }) {
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
      const result = await writer.execute(request, version, signal)
      // A real crash after the object write and before the receipt is recorded.
      if (counter.crashAfterWrite) process.exit(137)
      return result
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
