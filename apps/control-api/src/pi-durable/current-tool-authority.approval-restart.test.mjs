import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService, InteractionService } from '@control-plane/domain'
import {
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqliteInteractionRepository,
  SqlitePersistenceProvider,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
import { toolInputDigest } from '@control-plane/tool-execution'
import { fixture, at, expiry } from '../models/canonical-model-host-fixtures.mjs'
import { createPiDurableCurrentToolAuthority } from './current-tool-authority.ts'

// Real SQLite stores: plan, context, execution, attempt, interactions (approvals), and tool calls.
// Intent, plan-pin marker, and host reader are the canonical fixture's synthetic doubles.
const toolExecutor = { type: 'internal', reference: 'fixture.executor' }
const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFG'
const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFG'
const approverA = 'user:11111111-1111-4111-8111-111111111111'
const approverB = 'user:22222222-2222-4222-8222-222222222222'
const toolCallId = 'tlc_01JABCDEF0123456789ABCDEFG'
const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
const approvalExpiry = '2026-10-08T12:30:00.000Z'
const working = '2026-10-08T12:10:00.000Z'
const afterApprovalExpiry = '2026-10-08T12:45:00.000Z'
const input = { action: 'read', target: 'artifact://workspace/document-1' }
const rejected = { code: 'PI_TOOL_AUTHORITY_REJECTED' }

async function seedDatabase(path, f) {
  const provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await new SqliteContextPackageRepository(provider).put(f.context)
    await new SqliteExecutionPlanRepository(provider).put(f.plan)
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

async function openStores(path, f) {
  const provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  return {
    provider,
    executions: new SqliteExecutionRepository(provider),
    interactions: new SqliteInteractionRepository(provider),
    calls: new SqliteToolCallRepository(provider, f.intent.workspaceId),
  }
}

/** Records an approval through the domain service, then the call it authorizes. */
async function seedApprovedWork(f, stores, { callId, approvalId }) {
  const interactions = new InteractionService(stores.interactions)
  await interactions.request({
    interactionId: approvalId,
    executionId: f.intent.executionId,
    attemptId: f.intent.attemptId,
    kind: 'approval',
    prompt: { title: 'Approve documents.read', detailsReference: `artifact://tool-call/${callId}` },
    allowedActions: ['approve', 'deny'],
    allowedPrincipalIds: [approverA],
    requestedAt: at,
    expiresAt: approvalExpiry,
  })
  await interactions.respond({
    interactionId: approvalId,
    executionId: f.intent.executionId,
    attemptId: f.intent.attemptId,
    responseId: `cmd_${approvalId.slice(4)}`,
    action: 'approve',
    respondingPrincipalId: approverA,
    expectedVersion: 1,
    respondedAt: '2026-10-08T12:05:00.000Z',
  })
  await stores.calls.insert(callFor(f, callId, approvalId))
}

function callFor(f, callId, approvalId) {
  return {
    toolCallId: callId,
    requestDigest: `sha256:${'a'.repeat(64)}`,
    executionId: f.intent.executionId,
    attemptId: f.intent.attemptId,
    workspaceId: f.intent.workspaceId,
    profileId: f.plan.profile.profileId,
    principalRef: f.intent.canonicalActorPrincipalId,
    toolDefinitionId,
    toolVersionId,
    operation: 'documents.read',
    inputDigest: toolInputDigest(input),
    policySnapshotRef: 'policy://fixture/tool-policy',
    approvalInteractionId: approvalId,
    approvalPrincipalRef: approverA,
    policyDecision: {
      effect: 'allow',
      decisionId: 'fixture-allow',
      policyVersion: 'fixture-policy-v1',
      reasonCode: 'GRANTED',
      requiresApproval: true,
      evaluatedAt: at,
    },
    executor: toolExecutor,
    idempotencyKey: `pi-tool-call:${callId}`,
    status: 'executing',
    revision: 2,
    requestedAt: at,
    startedAt: at,
    history: [
      { status: 'requested', at },
      { status: 'executing', at },
    ],
  }
}

function requestFor(f, callId, approvalId) {
  return {
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    toolCallId: callId,
    executionId: f.intent.executionId,
    attemptId: f.intent.attemptId,
    workspaceId: f.intent.workspaceId,
    profileId: f.plan.profile.profileId,
    toolDefinitionId,
    toolVersionId,
    operation: 'documents.read',
    input: structuredClone(input),
    grant: {
      workspaceId: f.intent.workspaceId,
      profileId: f.plan.profile.profileId,
      toolDefinitionId,
      toolVersionId,
      operations: ['documents.read'],
      expiresAt: expiry,
    },
    audit: {
      principalRef: f.intent.canonicalActorPrincipalId,
      traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    },
    idempotencyKey: `pi-tool-call:${callId}`,
    requestedAt: at,
    policySnapshotRef: 'policy://fixture/tool-policy',
    approval: {
      interactionId: approvalId,
      allowedPrincipalIds: [approverA],
      requestedAt: at,
      expiresAt: approvalExpiry,
    },
  }
}

/** Current authority over reopened real stores, with the canonical intent and plan pin. */
function authorityFor(f, stores, now) {
  const intent = { ...f.intent }
  const marker = {
    state: 'ready',
    actorPrincipalId: 'svc_transport',
    workspaceId: intent.workspaceId,
    intent: structuredClone(intent),
    planPin: {
      executionPlanId: f.plan.executionPlanId,
      contentDigest: f.plan.contentDigest,
      schemaVersion: f.plan.schemaVersion,
    },
  }
  return createPiDurableCurrentToolAuthority({
    currentExecutionAuthority: f.host,
    intents: {
      getByAttempt: async (attemptId) =>
        attemptId === intent.attemptId ? structuredClone(intent) : undefined,
      marker: () => structuredClone(marker),
    },
    executions: stores.executions,
    plans: f.hostOptions.plans,
    service: {
      gateway: {
        prepare: async (request) => ({
          request,
          version: { toolDefinitionId, toolVersionId, executor: toolExecutor },
          operation: { name: 'documents.read', approvalMode: 'always' },
          executor: async () => ({ output: { ok: true } }),
        }),
      },
      calls: stores.calls,
      approvals: { repository: stores.interactions },
    },
    interactions: stores.interactions,
    now: () => now,
  })
}

async function withRealStores(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-approval-restart-'))
  try {
    await run(join(directory, 'state.sqlite'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('unchanged approved work keeps its authorization across physical close and reopen', async () => {
  await withRealStores(async (path) => {
    const f = await fixture()
    await seedDatabase(path, f)
    const first = await openStores(path, f)
    await seedApprovedWork(f, first, { callId: toolCallId, approvalId: interactionId })
    const request = requestFor(f, toolCallId, interactionId)
    await expect(
      authorityFor(f, first, working).assertCurrent(request, 'effect')
    ).resolves.toBeUndefined()
    first.provider.close()

    const reopened = await openStores(path, f)
    try {
      await expect(
        authorityFor(f, reopened, working).assertCurrent(request, 'effect')
      ).resolves.toBeUndefined()
      await expect(
        authorityFor(f, reopened, working).assertCurrent(request, 'approval')
      ).resolves.toBeUndefined()
    } finally {
      reopened.provider.close()
    }
  })
})

test('changed input, action, audience, principal, or workspace cannot reuse the retained approval after reopen', async () => {
  await withRealStores(async (path) => {
    const f = await fixture()
    await seedDatabase(path, f)
    const seeded = await openStores(path, f)
    await seedApprovedWork(f, seeded, { callId: toolCallId, approvalId: interactionId })
    seeded.provider.close()

    const base = requestFor(f, toolCallId, interactionId)
    const reopenedControl = await openStores(path, f)
    try {
      // Control: the unchanged request passes in this same session, so each rejection below is caused by its change.
      await expect(
        authorityFor(f, reopenedControl, working).assertCurrent(base, 'effect')
      ).resolves.toBeUndefined()
    } finally {
      reopenedControl.provider.close()
    }
    const changed = {
      input: { ...base, input: { ...input, target: 'artifact://workspace/other' } },
      action: { ...base, operation: 'documents.write' },
      audience: { ...base, approval: { ...base.approval, allowedPrincipalIds: [approverB] } },
      principal: { ...base, audit: { ...base.audit, principalRef: 'actor:other' } },
      workspace: { ...base, workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
    }
    const reopened = await openStores(path, f)
    try {
      for (const [name, request] of Object.entries(changed)) {
        await expect(
          authorityFor(f, reopened, working).assertCurrent(request, 'effect'),
          name
        ).rejects.toMatchObject(rejected)
      }
    } finally {
      reopened.provider.close()
    }
  })
})

test('an expired or revoked approval cannot authorize unchanged work after reopen', async () => {
  await withRealStores(async (path) => {
    const f = await fixture()
    await seedDatabase(path, f)
    const seeded = await openStores(path, f)
    const revokedId = 'int_01JABCDEF0123456789ABCDEFH'
    const revokedCallId = 'tlc_01JABCDEF0123456789ABCDEFH'
    await seedApprovedWork(f, seeded, { callId: toolCallId, approvalId: interactionId })
    await seedApprovedWork(f, seeded, { callId: revokedCallId, approvalId: revokedId })
    // No domain path revokes an already-approved request. The real store records the
    // terminal state through its version-conditional write; a cancelled request carries no response.
    const approved = await seeded.interactions.get(revokedId)
    const { response: _response, ...unanswered } = approved
    expect(
      await seeded.interactions.compareAndSet(approved.version, {
        ...unanswered,
        state: 'cancelled',
        version: approved.version + 1,
        resolvedAt: working,
      })
    ).toBe(true)
    seeded.provider.close()

    const reopened = await openStores(path, f)
    try {
      // Controls: before expiry the approved call and the not-yet-revoked call both pass.
      await expect(
        authorityFor(f, reopened, working).assertCurrent(
          requestFor(f, toolCallId, interactionId),
          'effect'
        )
      ).resolves.toBeUndefined()
      await expect(
        authorityFor(f, reopened, afterApprovalExpiry).assertCurrent(
          requestFor(f, toolCallId, interactionId),
          'effect'
        )
      ).rejects.toMatchObject(rejected)
      await expect(
        authorityFor(f, reopened, working).assertCurrent(
          requestFor(f, revokedCallId, revokedId),
          'effect'
        )
      ).rejects.toMatchObject(rejected)
    } finally {
      reopened.provider.close()
    }
  })
})

test('a call that already passed its effect cannot authorize a second effect after reopen', async () => {
  await withRealStores(async (path) => {
    const f = await fixture()
    await seedDatabase(path, f)
    const seeded = await openStores(path, f)
    await seedApprovedWork(f, seeded, { callId: toolCallId, approvalId: interactionId })
    const executing = await seeded.calls.get(toolCallId)
    expect(
      await seeded.calls.compareAndSet(executing.revision, {
        ...executing,
        status: 'succeeded',
        revision: executing.revision + 1,
        history: [...executing.history, { status: 'succeeded', at: working }],
      })
    ).toBe(true)
    seeded.provider.close()

    const reopened = await openStores(path, f)
    try {
      const request = requestFor(f, toolCallId, interactionId)
      await expect(
        authorityFor(f, reopened, working).assertCurrent(request, 'effect')
      ).rejects.toMatchObject(rejected)
      await expect(
        authorityFor(f, reopened, working).assertCurrent(request, 'publication')
      ).resolves.toBeUndefined()
      expect((await reopened.calls.get(toolCallId)).status).toBe('succeeded')
    } finally {
      reopened.provider.close()
    }
  })
})
