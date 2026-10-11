import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { InteractionService } from '@control-plane/domain'
import { SqliteDurableEffectGateStore } from '@control-plane/pi-durable-adapter'
import {
  SqliteExecutionRepository,
  SqliteInteractionRepository,
  SqlitePersistenceProvider,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
import { toolInputDigest, toolRequestDigest } from '@control-plane/tool-execution'
import { fixture, at, expiry } from '../models/canonical-model-host-fixtures.mjs'
import { createPiDurableCurrentToolAuthority } from './current-tool-authority.ts'
import {
  approverA,
  approvalExpiry,
  compose,
  interactionId,
  seedDatabase,
  taskFor,
  toolCallId,
  toolDefinitionId,
  toolExecutor,
  toolVersionId,
  working,
} from './retained-approval-write.harness.mjs'

// Deterministic regression for the awaited authority re-read (#939, retained
// approval-write). The reader re-reads the retained tool-call row and the
// approval interaction after its awaited canonical read so revocation and pin
// changes that commit during that await cannot authorize on stale snapshots.
// That re-read is a controlled barrier here: the mutation commits exactly
// between the two reads — no sleeps, no racing processes.
//
// Projection audit (callAuthorizationInputs vs every ToolCall field the reader
// can authorize on):
// - authorization inputs, compared on both reads: identity pins
//   (toolCallId, executionId, attemptId, workspaceId, profileId, principalRef,
//   toolDefinitionId, toolVersionId, operation, inputDigest,
//   policySnapshotRef, idempotencyKey, requestedAt), the executor binding, the
//   approval linkage (approvalInteractionId, approvalPrincipalRef), and the
//   policy decision. Any change to these during the await rejects.
// - omitted lifecycle evidence (status, startedAt, completedAt, result,
//   history, revision, errorCode, requestDigest): written only by the retained
//   effect about itself. None of them carries revocation — revocation travels
//   through the interaction state (re-read whole), the approval linkage, the
//   policy decision, or execution/attempt liveness and deadlines, all of which
//   stay checked. `status` still gates the effect boundary itself through the
//   first read, and a row that vanishes between reads has no projection and
//   rejects.
//
// The lifecycle case below is the exact concurrent-delivery defect this pins:
// under a whole-row comparison a racing duplicate read the winner's progress
// write and was rejected as PI_EFFECT_AUTHORITY_REJECTED instead of reaching
// the effect gate's invocation barrier.

const otherToolVersionId = 'tlv_01JABCDEF0123456789ABCDEFZ'
const approverB = 'user:22222222-2222-4222-8222-222222222222'
const input = { action: 'write', target: 'artifact://workspace/document-1' }
const rejected = { code: 'PI_TOOL_AUTHORITY_REJECTED' }

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

/** The approved call as it waits for dispatch: created and approved, not yet started. */
async function seedApprovedWork(f, stores, { callId, approvalId }) {
  const interactions = new InteractionService(stores.interactions)
  await interactions.request({
    interactionId: approvalId,
    executionId: f.intent.executionId,
    attemptId: f.intent.attemptId,
    kind: 'approval',
    prompt: {
      title: 'Approve documents.write',
      detailsReference: `artifact://tool-call/${callId}`,
    },
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
    operation: 'documents.write',
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
    status: 'requested',
    revision: 1,
    requestedAt: at,
    history: [{ status: 'requested', at }],
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
    operation: 'documents.write',
    input: structuredClone(input),
    grant: {
      workspaceId: f.intent.workspaceId,
      profileId: f.plan.profile.profileId,
      toolDefinitionId,
      toolVersionId,
      operations: ['documents.write'],
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

/**
 * Intercepts the reader's `get` at the commit point between its first snapshot
 * and its awaited re-read. `onSecondRead` runs after the first read, before the
 * second: returning a record replaces the observed row (a drifted store view),
 * returning null presents a vanished row, and returning undefined keeps the
 * real read after a store-path mutation committed inside the callback. Every
 * method delegates unchanged.
 */
function withSecondReadBarrier(repository, onSecondRead) {
  let reads = 0
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'get') {
        return async (...arguments_) => {
          reads += 1
          if (reads === 2 && onSecondRead) {
            const observed = await onSecondRead(target, ...arguments_)
            if (observed !== undefined) return observed === null ? undefined : observed
          }
          return target.get(...arguments_)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

/** The write a concurrently executing retained effect commits about itself: pure lifecycle progress. */
async function winnerExecutesTransition(repository, callId) {
  const row = await repository.get(callId)
  await repository.compareAndSet(row.revision, {
    ...row,
    status: 'executing',
    startedAt: working,
    revision: row.revision + 1,
    history: [...row.history, { status: 'executing', at: working }],
  })
}

function authorityFor(f, { calls, interactions, executions }, now) {
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
    executions,
    plans: f.hostOptions.plans,
    service: {
      gateway: {
        prepare: async (request) => ({
          request,
          version: { toolDefinitionId, toolVersionId, executor: toolExecutor },
          operation: { name: 'documents.write', approvalMode: 'always' },
          executor: async () => ({ output: { ok: true } }),
        }),
      },
      calls,
      approvals: { repository: interactions },
    },
    interactions,
    now: () => now,
  })
}

async function withApprovedWork(run, { onSecondCallRead, onSecondInteractionRead } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-await-window-'))
  try {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const stores = await openStores(join(directory, 'state.sqlite'), f)
    await seedApprovedWork(f, stores, { callId: toolCallId, approvalId: interactionId })
    const calls = withSecondReadBarrier(stores.calls, onSecondCallRead)
    const interactions = withSecondReadBarrier(stores.interactions, onSecondInteractionRead)
    const authority = authorityFor(
      f,
      { calls, interactions, executions: stores.executions },
      working
    )
    const request = requestFor(f, toolCallId, interactionId)
    return await run({ authority, request, stores })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a lifecycle-only write during the awaited re-read does not reject admission', async () => {
  await withApprovedWork(
    async ({ authority, request }) => {
      await expect(authority.assertCurrent(request, 'admission')).resolves.toBeUndefined()
    },
    {
      onSecondCallRead: (repository) => winnerExecutesTransition(repository, toolCallId),
    }
  )
})

test('an authorization pin changed during the awaited re-read rejects', async () => {
  await withApprovedWork(
    async ({ authority, request }) => {
      await expect(authority.assertCurrent(request, 'admission')).rejects.toMatchObject(rejected)
    },
    {
      // The production store refuses pin mutations (sameCallIdentity), so this
      // is a drifted second view. The reader's own defense must still reject.
      onSecondCallRead: async (repository) => {
        const row = await repository.get(toolCallId)
        return { ...row, toolVersionId: otherToolVersionId, revision: row.revision + 1 }
      },
    }
  )
})

test('an approval-linkage change during the awaited re-read rejects', async () => {
  await withApprovedWork(
    async ({ authority, request }) => {
      await expect(authority.assertCurrent(request, 'admission')).rejects.toMatchObject(rejected)
    },
    {
      onSecondCallRead: async (repository) => {
        const row = await repository.get(toolCallId)
        await repository.compareAndSet(row.revision, {
          ...row,
          approvalPrincipalRef: approverB,
          revision: row.revision + 1,
        })
      },
    }
  )
})

test('a policy change during the awaited re-read rejects', async () => {
  await withApprovedWork(
    async ({ authority, request }) => {
      await expect(authority.assertCurrent(request, 'admission')).rejects.toMatchObject(rejected)
    },
    {
      onSecondCallRead: async (repository) => {
        const row = await repository.get(toolCallId)
        await repository.compareAndSet(row.revision, {
          ...row,
          policyDecision: {
            ...row.policyDecision,
            requiresApproval: false,
            decisionId: 'fixture-allow-2',
          },
          revision: row.revision + 1,
        })
      },
    }
  )
})

test('a call row that vanishes during the awaited re-read rejects', async () => {
  await withApprovedWork(
    async ({ authority, request }) => {
      await expect(authority.assertCurrent(request, 'admission')).rejects.toMatchObject(rejected)
    },
    {
      // The repository stores calls under a namespaced record, so the barrier
      // presents the reader the same observation a deletion produces: the
      // second read finds nothing.
      onSecondCallRead: () => null,
    }
  )
})

test('an approval revoked during the awaited re-read rejects', async () => {
  await withApprovedWork(
    async ({ authority, request }) => {
      await expect(authority.assertCurrent(request, 'admission')).rejects.toMatchObject(rejected)
    },
    {
      onSecondInteractionRead: async (repository) => {
        const approved = await repository.get(interactionId)
        const { response: _response, ...unanswered } = approved
        await repository.compareAndSet(approved.version, {
          ...unanswered,
          state: 'cancelled',
          version: approved.version + 1,
          resolvedAt: working,
        })
      },
    }
  )
})

test('retained write: a lifecycle write during the admission await reaches the invocation barrier without a second write', async () => {
  await withState(async (directory, f) => {
    const first = await compose(directory, f, {
      counter: { invocations: 0 },
      clock: { now: working },
    })
    expect((await first.runner.run(taskFor(f))).state).toBe('awaiting_approval')
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
    first.close()

    // A concurrent winner holds the invocation barrier: its effect is in flight.
    await seedInvokingRecord(directory, f)

    // The duplicate's admission read straddles the winner's progress write —
    // deterministic, through the barrier — and must land on the retained
    // invocation barrier, never on an authority rejection or a second write.
    const counter = { invocations: 0 }
    const second = await compose(directory, f, {
      counter,
      clock: { now: working },
      wrapCalls: (calls) =>
        withSecondReadBarrier(calls, (repository) =>
          winnerExecutesTransition(repository, toolCallId)
        ),
    })
    try {
      await expect(second.runner.run(taskFor(f))).resolves.toMatchObject({
        state: 'reconciliation_required',
        reasonCode: 'PI_EFFECT_OUTCOME_UNKNOWN',
        toolCallId,
      })
      expect(counter.invocations).toBe(0)
      expect(await objectCount(directory)).toBe(0)

      // Replays return the same retained unknown; the barrier holds.
      const replay = await compose(directory, f, { counter, clock: { now: working } })
      try {
        await expect(replay.runner.run(taskFor(f))).resolves.toMatchObject({
          state: 'reconciliation_required',
          reasonCode: 'PI_EFFECT_OUTCOME_UNKNOWN',
        })
        expect(counter.invocations).toBe(0)
        expect(await objectCount(directory)).toBe(0)
        expect(await gateRecord(directory, f)).toMatchObject({ state: 'invoking' })
      } finally {
        replay.close()
      }
    } finally {
      second.close()
    }
  })
}, 60_000)

async function withState(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-await-window-gate-'))
  try {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    return await run(directory, f)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Marks the task's effect as claimed by a concurrent winner: state invoking, not yet settled. */
async function seedInvokingRecord(directory, f, taskId = 'rwt_01JABCDEF0123456789ABCDEFG') {
  const request = taskFor(f, { taskId }).request
  const key = JSON.stringify([request.workspaceId, request.idempotencyKey])
  const record = {
    schemaVersion: 'pi-effect-gate/v1',
    key,
    requestDigest: `sha256:${createHash('sha256')
      .update(canonicalJsonStringify(request) ?? 'null')
      .digest('hex')}`,
    toolRequestDigest: toolRequestDigest(request),
    toolCallId: request.toolCallId,
    revision: 1,
    state: 'invoking',
  }
  const database = new DatabaseSync(join(directory, 'effect-gate.sqlite'))
  try {
    const store = new SqliteDurableEffectGateStore(database)
    const current = await store.get(key)
    if (current) {
      await expect(
        store.compareAndSet(current.revision, { ...record, revision: current.revision + 1 })
      ).resolves.toBe(true)
    } else {
      await expect(store.insert(record)).resolves.toBe(true)
    }
  } finally {
    database.close()
  }
}

async function objectCount(directory) {
  const names = await readdir(join(directory, 'objects')).catch(() => [])
  return new Set(names.map((name) => name.split('.')[0])).size
}

async function gateRecord(directory, f, taskId = 'rwt_01JABCDEF0123456789ABCDEFG') {
  const key = JSON.stringify([f.intent.workspaceId, `retained-write:${taskId}`])
  const database = new DatabaseSync(join(directory, 'effect-gate.sqlite'))
  return new SqliteDurableEffectGateStore(database).get(key).finally(() => database.close())
}
