import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { CommandInboxService } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'

import { SqliteDelegationEventPublisher } from './delegation-event-publisher.ts'
import { retainTerminalReceipt, terminalReceiptNamespace } from './delegation-terminal-receipt.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteContextPackageRepository } from './repositories-extra.ts'
import { SqliteCommandAcceptanceRepository, SqliteExecutionPlanRepository } from './repositories.ts'

// The three delivery kinds of CP #1024 in ONE physical SQLite database: the
// durable command inbox, the durable child-event inbox and the retained
// publication intent. Each kind owns its identity and its own storage, so the
// same identity used in two kinds is two deliveries, a replay is answered by the
// kind that owns it, and changed content conflicts only in that kind.
//
// Every fixture is synthetic and offline: a compiled test execution plan, a
// command acceptance, a delegation event and a retained receipt. No credential,
// provider, network or production resource is read, and nothing here certifies a
// live qualified callback.

const at = '2026-08-24T10:00:00.000Z'
const plan = createExecutionPlanTestFixture()
const ids = {
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JCBCDEF0123456789ABCDEFG',
  childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  executionId: 'exe_01JDBCDEF0123456789ABCDEFG',
}

// The identity the child-event inbox requires: a delegation namespaced key. The
// command inbox accepts any caller key and the retained publication intent
// carries the delegation's own key, so the same string is legal in all three.
const sharedIdentity = `delegation:${ids.delegationId}:terminal`

const event = {
  type: 'delegation.completed',
  delegationId: ids.delegationId,
  parentExecutionId: ids.parentExecutionId,
  childExecutionId: ids.childExecutionId,
  occurredAt: '2026-08-25T18:03:00.000Z',
  details: { state: 'completed', terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG' },
}

function commandInput(overrides = {}) {
  const { workspaceId, projectId, taskId, agentId } = plan.correlation
  return {
    callerPrincipalId: 'svc_child-callback-dedup',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: sharedIdentity,
    payloadHash: 'a'.repeat(64),
    correlation: { workspaceId, projectId, taskId, agentId },
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    receivedAt: at,
    retentionExpiresAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  }
}

function commandScope() {
  const { workspaceId, projectId } = plan.correlation
  return {
    callerPrincipalId: 'svc_child-callback-dedup',
    operation: 'execution.accept',
    workspaceId,
    projectId,
    idempotencyKey: sharedIdentity,
  }
}

/** The delegation record the retained publication intent is recorded against. */
function delegationRecord(publication, overrides = {}) {
  return {
    delegationId: ids.delegationId,
    parentExecutionId: ids.parentExecutionId,
    childExecutionId: ids.childExecutionId,
    childAttemptId: ids.childAttemptId,
    state: 'completed',
    updatedAt: '2026-08-25T18:03:00.000Z',
    terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
    ...(publication ? { terminalPublication: publication } : {}),
    ...overrides,
  }
}

const pendingPublication = { idempotencyKey: sharedIdentity, status: 'pending' }
const publishedPublication = { idempotencyKey: sharedIdentity, status: 'published' }

/** The three kinds, all durable, all in one provider. */
function durableKinds(provider) {
  const commands = new SqliteCommandAcceptanceRepository(provider)
  const commandInbox = new CommandInboxService({
    repository: commands,
    executionIdFactory: () => ids.executionId,
    executionPlanValidator: { validate: async () => true, authorize: async () => true },
    now: () => at,
  })
  const events = new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
  return { commands, commandInbox, events }
}

/** The durable preconditions the command inbox reads: the plan and its context. */
async function seedPlan(provider) {
  await new SqliteContextPackageRepository(provider).put(
    contextPackageSerializationFixtures.futurePi
  )
  await new SqliteExecutionPlanRepository(provider).put(plan)
}

async function retainedIntents(provider) {
  return provider.transaction(async (transaction) => {
    const records = await transaction.list(terminalReceiptNamespace)
    return records.map((record) => record.value)
  })
}

test('each kind replays its own delivery and conflicts only on its own content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'child-callback-dedup-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await seedPlan(provider)
    const { commands, commandInbox, events } = durableKinds(provider)

    // The command kind: an accepted command replays onto its own execution, and
    // the same identity with a different payload conflicts in the command kind.
    const accepted = await commandInbox.acceptExecution(commandInput())
    expect(accepted.replayed).toBe(false)
    const replay = await commandInbox.acceptExecution(commandInput())
    expect(replay.replayed).toBe(true)
    expect(replay.execution.executionId).toBe(ids.executionId)
    await expect(
      commandInbox.acceptExecution(commandInput({ payloadHash: 'c'.repeat(64) }))
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' })

    // The child-event kind: a redelivery is the same publication, and changed
    // content conflicts in the event inbox.
    await events.publish(event, sharedIdentity)
    await events.publish(event, sharedIdentity)
    expect(await events.list()).toEqual([event])
    await expect(
      events.publish({ ...event, occurredAt: '2026-08-25T18:04:00.000Z' }, sharedIdentity)
    ).rejects.toThrow('DELEGATION_PUBLICATION_CONFLICT')

    // The retained publication kind: the same pending intent is retained again,
    // and a changed outcome conflicts in the retained receipt.
    await provider.transaction(async (transaction) => {
      await retainTerminalReceipt(
        transaction,
        delegationRecord(undefined),
        delegationRecord(pendingPublication)
      )
    })
    await provider.transaction(async (transaction) => {
      await retainTerminalReceipt(
        transaction,
        delegationRecord(pendingPublication),
        delegationRecord(pendingPublication)
      )
    })
    await expect(
      provider.transaction(async (transaction) => {
        await retainTerminalReceipt(
          transaction,
          delegationRecord(pendingPublication),
          delegationRecord(pendingPublication, {
            terminalResultRef: 'art_01JCBCDEF0123456789ABCDEFG',
          })
        )
      })
    ).rejects.toThrow('DELEGATION_TERMINAL_RECEIPT_CONFLICT')

    // No kind answered for another: the command's conflict left the event inbox
    // and the retained intent alone, the event's conflict left the command record
    // alone, and the intent's conflict left both alone.
    expect(await events.list()).toEqual([event])
    const command = await commands.get(commandScope())
    expect(command?.idempotencyKey).toBe(sharedIdentity)
    const intents = await retainedIntents(provider)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ idempotencyKey: sharedIdentity, status: 'pending' })
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('the retained state of every kind survives a close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'child-callback-dedup-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await seedPlan(provider)
    const { commandInbox, events } = durableKinds(provider)
    await commandInbox.acceptExecution(commandInput())
    await events.publish(event, sharedIdentity)
    await provider.transaction(async (transaction) => {
      await retainTerminalReceipt(
        transaction,
        delegationRecord(undefined),
        delegationRecord(pendingPublication)
      )
    })

    // The provider closes and the same database is reopened.
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const reopened = durableKinds(provider)

    // The command record survived and still replays onto its own execution.
    const replay = await reopened.commandInbox.acceptExecution(commandInput())
    expect(replay.replayed).toBe(true)
    expect(replay.execution.executionId).toBe(ids.executionId)

    // The child event survived.
    expect(await reopened.events.list()).toEqual([event])

    // The retained publication intent survived and is still completable.
    const intents = await retainedIntents(provider)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ idempotencyKey: sharedIdentity, status: 'pending' })
    await provider.transaction(async (transaction) => {
      await retainTerminalReceipt(
        transaction,
        delegationRecord(pendingPublication),
        delegationRecord(publishedPublication)
      )
    })
    const published = await retainedIntents(provider)
    expect(published[0]).toMatchObject({ idempotencyKey: sharedIdentity, status: 'published' })
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
