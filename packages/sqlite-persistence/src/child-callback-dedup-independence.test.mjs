import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'

import { SqliteDelegationEventPublisher } from './delegation-event-publisher.ts'
import { terminalReceiptNamespace } from './delegation-terminal-receipt.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { json, recordId } from './record-storage.js'

// The three delivery kinds of CP #1024 deduplicate independently: a command
// delivery, a child event and a user publication each own their identity, so the
// same identity used in two kinds is two deliveries and never one.
//
// Every fixture is synthetic and offline: a command acceptance, a delegation
// event and a receipt record. No credential, provider, network or production
// resource is read, and nothing here certifies a live callback.

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
  agentId: 'agt_01JABCDEF0123456789ABCDEFG',
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JCBCDEF0123456789ABCDEFG',
}

const receivedAt = '2026-08-24T10:00:00.000Z'
const payloadHash = 'a'.repeat(64)

// The identity the child-event inbox requires: a delegation namespaced key. The
// command inbox accepts any caller key, so the same string is legal in both.
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
  return {
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: ids.commandId,
    requestId: ids.requestId,
    idempotencyKey: sharedIdentity,
    payloadHash,
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
    },
    executionPlan: {
      executionPlanId: ids.executionPlanId,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    receivedAt,
    retentionExpiresAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  }
}

function commandInbox() {
  const repository = new InMemoryCommandAcceptanceRepository()
  const service = new CommandInboxService({
    repository,
    executionIdFactory: () => ids.executionId,
    executionPlanValidator: { authorize: async () => true, validate: async () => true },
    now: () => receivedAt,
  })
  return { repository, service }
}

test('a command and a child event that share an identity are two deliveries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'child-callback-dedup-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const { repository, service } = commandInbox()

    // The command is accepted under the identity the child event also uses.
    const accepted = await service.acceptExecution(commandInput())
    expect(accepted.replayed).toBe(false)

    // The child event is published under that very identity.
    const publisher = new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
    await publisher.publish(event, sharedIdentity)

    // Each kind owns its own record: the command accepted one execution, and the
    // child-event inbox holds one publication.
    expect(repository.executionCount).toBe(1)
    expect(await publisher.list()).toEqual([event])

    // A replay of the command is answered by the command's own record, and a
    // redelivery of the event by the event's own record: neither kind answers
    // for the other.
    const replay = await service.acceptExecution(commandInput())
    expect(replay.replayed).toBe(true)
    expect(replay.execution.id).toBe(accepted.execution.id)
    await publisher.publish(event, sharedIdentity)
    expect(await publisher.list()).toEqual([event])
    expect(repository.executionCount).toBe(1)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('the child-event inbox and the retained publication intent never satisfy one another', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'child-callback-dedup-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()

    // A retained publication intent for the same delegation, under its own
    // namespace and its own record identity.
    await provider.transaction(async (transaction) => {
      await transaction.put({
        namespace: terminalReceiptNamespace,
        id: recordId(ids.delegationId),
        value: json({ idempotencyKey: sharedIdentity, status: 'pending', event }),
      })
    })

    const publisher = new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
    await publisher.publish(event, sharedIdentity)

    // The intent is retained and the event is published, and neither read answers
    // for the other.
    const retained = await provider.transaction(async (transaction) =>
      transaction.list(terminalReceiptNamespace)
    )
    expect(retained).toHaveLength(1)
    expect(retained[0]?.value).toMatchObject({
      idempotencyKey: sharedIdentity,
      status: 'pending',
    })
    expect(await publisher.list()).toEqual([event])
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
