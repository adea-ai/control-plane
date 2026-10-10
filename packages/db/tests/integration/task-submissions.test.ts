import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createContentRef, getContentRefForUser } from '../../src/content-refs'
import { createGroupChannel, createMessage, listMessagesForUser } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createProject } from '../../src/projects'
import {
  createRuntimeNodeChallenge,
  registerRuntimeNode,
  revokeRuntimeNode,
  rotateRuntimeNodeKeys,
} from '../../src/runtime-nodes'
import {
  agents,
  commandOutbox,
  contentRefs,
  messages,
  runtimeNodeKeys,
  runtimeNodes,
  taskExecutionAttempts,
  taskSubmissions,
  tasks,
  workspaceEvents,
} from '../../src/schema'
import {
  enqueueTaskSubmission,
  getTaskSubmissionForUser,
  type TaskSubmissionInput,
} from '../../src/task-submissions'
import { createTask, getTaskForUser, setTaskConversationReferences } from '../../src/tasks'
import {
  inspectExpiredTaskSubmissionCiphertext,
  purgeExpiredTaskSubmissionCiphertext,
} from '../../src/task-submission-retention'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
// The purge entry point imports the built @adea-ai/types package. The integration runner builds
// it once before the suite; a direct run builds it here once per file when it is missing, so each
// spawned purge runs the script itself instead of rebuilding the package first.
if (!existsSync(fileURLToPath(new URL('../../../types/dist/index.js', import.meta.url)))) {
  const build = spawnSync('bun', ['run', '--cwd', 'packages/types', 'build'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  if (build.status !== 0) throw new Error(`packages/types build failed: ${build.stderr}`)
}

function invokeRetention(input: string[]) {
  return spawnSync('bun', ['scripts/purge-relay-ciphertext.ts', ...input], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 15000,
  })
}

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }

describe.skipIf(!url)('durable encrypted Task intent', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  async function fixture(kind: 'local_device' | 'remote_host' = 'remote_host') {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Relay fixture',
      owner: owner.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      name: 'Selected project',
      iconKey: 'planning',
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Selected Agent',
      profileId: profile.id,
      profileVersion: profile.version,
    })
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      {
        agentId: agent.id,
        projectId: project.id,
        title: 'Delivery intent',
        objective: 'PRIVATE_PROMPT_SENTINEL',
      },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    const encryption = await generateRemoteCommandKeyPair()
    const publicKey = Buffer.from(
      await crypto.subtle.exportKey('raw', encryption.publicKey)
    ).toString('base64url')
    const keys = [
      {
        algorithm: 'ed25519' as const,
        publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
        role: 'signing' as const,
      },
      { algorithm: 'x25519' as const, publicKey, role: 'command_encryption' as const },
    ]
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: owner.principal.userId,
      kind,
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: workspace.id,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: challenge.challengeId,
      displayName: 'Selected host',
      keys,
      kind,
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: workspace.id,
    })
    const command = {
      idempotencyKey: 'initial-submission',
      requestId: crypto.randomUUID(),
      expectedVersion: task.version,
    }
    const keyId = node.keys.find((key) => key.role === 'command_encryption')!.keyId
    const envelope = await sealRemoteContent({
      keyId,
      recipientPublicKey: encryption.publicKey,
      aad: {
        workspaceId: workspace.id,
        runtimeNodeId: node.id,
        requestId: command.requestId,
        payloadType: 'command.input',
        schemaVersion: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      plaintext: new TextEncoder().encode('PRIVATE_CONTEXT_SENTINEL'),
    })
    const input: TaskSubmissionInput = {
      runtimeNodeId: node.id,
      queueWhenOffline: false,
      profile,
      envelope,
    }
    const enqueue = (candidate = input, metadata = command) =>
      enqueueTaskSubmission(
        connection.db,
        workspace.id,
        task.id,
        owner.principal,
        candidate,
        metadata
      )
    return {
      owner,
      workspace,
      project,
      agent,
      task,
      node,
      keys,
      command,
      input,
      envelope,
      enqueue,
      encryption,
    }
  }

  async function anotherSubmission(f: Awaited<ReturnType<typeof fixture>>) {
    const task = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        agentId: f.agent.id,
        projectId: f.project.id,
        title: 'Additional relay intent',
        objective: 'PRIVATE_PROMPT_SENTINEL',
      },
      { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }
    )
    const command = {
      expectedVersion: task.version,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    }
    const envelope = await sealRemoteContent({
      keyId: f.envelope.keyId,
      recipientPublicKey: f.encryption.publicKey,
      aad: { ...f.envelope.aad, requestId: command.requestId },
      plaintext: new TextEncoder().encode('PRIVATE_CONTEXT_SENTINEL'),
    })
    return enqueueTaskSubmission(
      connection.db,
      f.workspace.id,
      task.id,
      f.owner.principal,
      { ...f.input, envelope },
      command
    )
  }

  async function expire(id: string) {
    await connection.db
      .update(taskSubmissions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(taskSubmissions.id, id))
  }

  async function readSubmissionOutbox(id: string) {
    const [row] = await connection.db
      .select({ outbox: commandOutbox })
      .from(taskSubmissions)
      .innerJoin(commandOutbox, eq(commandOutbox.id, taskSubmissions.commandId))
      .where(eq(taskSubmissions.id, id))
    return row!.outbox
  }

  test('expired ciphertext is purged without erasing intent or claiming execution cancellation', async () => {
    const f = await fixture()
    const original = await f.enqueue()
    const before = await connection.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, f.workspace.id))
    await expire(original.id)

    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(1)
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000)
    try {
      expect(
        await getTaskSubmissionForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
      ).toMatchObject({ id: original.id, state: 'expired' })
    } finally {
      clock.mockRestore()
    }
    const outbox = await readSubmissionOutbox(original.id)
    expect(outbox!.payload).not.toHaveProperty('envelope')
    expect(outbox!.status).toBe('pending')
    expect(outbox!.payload.submissionId).toBe(original.id)
    expect(await f.enqueue()).toMatchObject({
      id: original.id,
      requestId: original.requestId,
      state: 'expired',
    })
    expect(
      (await getTaskForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal))!
        .lifecycleState
    ).toBe(f.task.lifecycleState)
    expect(
      await connection.db
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.taskId, f.task.id))
    ).toEqual([])
    expect(
      await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, f.workspace.id))
    ).toEqual(before)
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(0)
  })

  test('relay purge preserves canonical messages and local-only body references independently of ciphertext', async () => {
    const f = await fixture()
    const channel = await createGroupChannel(connection.db, f.workspace.id, f.owner.principal, {
      idempotencyKey: 'retained-history',
      title: 'Retained history',
    })
    const origin = await createMessage(
      connection.db,
      f.workspace.id,
      channel.id,
      f.owner.principal,
      {
        bodyText: 'CANONICAL_HISTORY_SENTINEL',
        idempotencyKey: 'retained-origin',
        sender: f.owner.principal,
        taskId: f.task.id,
      }
    )
    const body = await createContentRef(connection.db, f.workspace.id, f.owner.principal, {
      availability: 'offline',
      contentType: 'message_body',
      digestSha256: 'e'.repeat(64),
      id: crypto.randomUUID(),
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    })
    const privateMessage = await createMessage(
      connection.db,
      f.workspace.id,
      channel.id,
      f.owner.principal,
      { bodyContentRefId: body.id, idempotencyKey: 'retained-reference', sender: f.owner.principal }
    )
    const linked = await setTaskConversationReferences(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal,
      { channelId: channel.id, messageId: origin.id },
      {
        idempotencyKey: 'retained-link',
        requestId: crypto.randomUUID(),
        expectedVersion: f.task.version,
      }
    )
    const submission = await f.enqueue(f.input, { ...f.command, expectedVersion: linked.version })
    const snapshot = async () => {
      const [messageRows, content, history] = await Promise.all([
        connection.db
          .select()
          .from(messages)
          .where(eq(messages.workspaceId, f.workspace.id))
          .orderBy(messages.sequence),
        getContentRefForUser(connection.db, f.workspace.id, body.id, f.owner.principal),
        listMessagesForUser(connection.db, f.workspace.id, channel.id, f.owner.principal),
      ])
      return { messageRows, content, history }
    }
    const before = await snapshot()
    expect(before.history.messages.map((message) => message.id)).toEqual([
      origin.id,
      privateMessage.id,
    ])
    expect(before.content).toMatchObject({
      availability: 'offline',
      messageId: privateMessage.id,
      synchronizationPolicy: 'local_only',
    })
    await expire(submission.id)

    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(1)
    expect((await readSubmissionOutbox(submission.id)).payload).not.toHaveProperty('envelope')
    expect(await snapshot()).toEqual(before)
    expect(
      await getTaskForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
    ).toMatchObject({
      conversation: { channelId: channel.id, messageId: origin.id },
      lifecycleState: 'created',
      version: linked.version,
    })
  })

  test('dry-run, batch bounds and workspace isolation preserve future and foreign ciphertext', async () => {
    const f = await fixture()
    const foreign = await fixture()
    const first = await f.enqueue()
    const second = await anotherSubmission(f)
    const future = await anotherSubmission(f)
    const other = await foreign.enqueue()
    for (const id of [first.id, second.id, other.id]) await expire(id)
    const original = await readSubmissionOutbox(first.id)
    expect(await inspectExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id, 1)).toBe(1)
    expect(await readSubmissionOutbox(first.id)).toEqual(original)
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id, 1)).toBe(1)
    expect(await inspectExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id, 1000)).toBe(
      1
    )
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(1)
    expect((await readSubmissionOutbox(future.id)).payload).toHaveProperty('envelope')
    expect((await readSubmissionOutbox(other.id)).payload).toHaveProperty('envelope')
    expect(await inspectExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(0)
  })

  test('concurrent purges claim each expired submission once and preserve delivery status', async () => {
    const f = await fixture()
    const submissions = [await f.enqueue(), await anotherSubmission(f), await anotherSubmission(f)]
    const statuses = ['processing', 'delivered', 'failed'] as const
    for (const [index, submission] of submissions.entries()) {
      await expire(submission.id)
      const row = await readSubmissionOutbox(submission.id)
      await connection.db
        .update(commandOutbox)
        .set({ status: statuses[index]!, attempts: 3 })
        .where(eq(commandOutbox.id, row.id))
    }
    const counts = await Promise.all(
      Array.from({ length: 3 }, () =>
        purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id, 2)
      )
    )
    expect(counts.reduce((total, count) => total + count, 0)).toBe(3)
    for (const [index, submission] of submissions.entries()) {
      const row = await readSubmissionOutbox(submission.id)
      expect(row.payload).not.toHaveProperty('envelope')
      expect(row.status).toBe(statuses[index]!)
      expect(row.attempts).toBe(3)
    }
  })

  test('locked outbox rows are skipped and remain eligible after their owner releases the lock', async () => {
    const f = await fixture()
    const submission = await f.enqueue()
    await expire(submission.id)
    let unlock!: () => void
    let locked!: () => void
    const release = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const queued = await readSubmissionOutbox(submission.id)
    const holder = connection.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${commandOutbox} where id = ${queued.id}::uuid for update`
      )
      locked()
      await release
    })
    try {
      await Promise.race([ready, holder])
      expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(0)
      expect((await readSubmissionOutbox(submission.id)).payload).toHaveProperty('envelope')
    } finally {
      unlock()
      await holder
    }
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(1)
  })

  test('outer rollback restores ciphertext and the purge marker together', async () => {
    const f = await fixture()
    const submission = await f.enqueue()
    await expire(submission.id)
    await expect(
      connection.db.transaction(async (transaction) => {
        expect(await purgeExpiredTaskSubmissionCiphertext(transaction, f.workspace.id)).toBe(1)
        throw new Error('rollback retention fixture')
      })
    ).rejects.toThrow('rollback retention fixture')
    expect((await readSubmissionOutbox(submission.id)).payload).toHaveProperty('envelope')
    const [row] = await connection.db
      .select()
      .from(taskSubmissions)
      .where(eq(taskSubmissions.id, submission.id))
    expect(row!.ciphertextPurgedAt).toBeNull()
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(1)
  })

  test('the schema refuses early purge markers and already-absent envelopes converge once', async () => {
    const f = await fixture()
    const submission = await f.enqueue()
    await expect(
      connection.db
        .update(taskSubmissions)
        .set({ ciphertextPurgedAt: new Date() })
        .where(eq(taskSubmissions.id, submission.id))
        .execute()
    ).rejects.toThrow()
    const queued = await readSubmissionOutbox(submission.id)
    await connection.db.execute(
      sql`update ${commandOutbox} set payload = payload - 'envelope' where id = ${queued.id}::uuid`
    )
    await expire(submission.id)
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(1)
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(0)
    const [row] = await connection.db
      .select()
      .from(taskSubmissions)
      .where(eq(taskSubmissions.id, submission.id))
    expect(row!.ciphertextPurgedAt!.getTime()).toBeGreaterThanOrEqual(row!.expiresAt.getTime())
  })

  test('operator entry refuses a wrong target, previews unchanged rows and applies explicit cleanup', () => {
    return (async () => {
      const f = await fixture()
      const submission = await f.enqueue()
      await expire(submission.id)
      const target = new URL(process.env.DATABASE_URL_UNPOOLED!)
      const args = [
        '--host',
        target.hostname,
        '--port',
        target.port || '5432',
        '--database',
        decodeURIComponent(target.pathname.slice(1)),
        '--workspace',
        f.workspace.id,
        '--limit',
        '10',
      ]
      const wrong = invokeRetention(
        args.map((value) => (value === target.hostname ? 'wrong.invalid' : value))
      )
      expect(wrong.status).toBe(1)
      expect(wrong.stderr).toContain('wrong_target')
      expect(wrong.stderr).not.toContain(target.password)
      expect(wrong.stderr).not.toContain('postgresql:')
      const preview = invokeRetention(args)
      expect(preview.status).toBe(0)
      expect(JSON.parse(preview.stdout.trim().split('\n').at(-1)!)).toEqual({
        schemaVersion: 1,
        mode: 'dry_run',
        count: 1,
        limit: 10,
      })
      expect((await readSubmissionOutbox(submission.id)).payload).toHaveProperty('envelope')
      const applied = invokeRetention([...args, '--apply'])
      expect(applied.status).toBe(0)
      expect(JSON.parse(applied.stdout.trim().split('\n').at(-1)!)).toEqual({
        schemaVersion: 1,
        mode: 'apply',
        count: 1,
        limit: 10,
      })
      expect((await readSubmissionOutbox(submission.id)).payload).not.toHaveProperty('envelope')
      expect((await f.enqueue()).id).toBe(submission.id)
      expect(applied.stdout).not.toContain('PRIVATE_')
    })()
  }, 30000)

  test('one selected host, immutable profile snapshot, canonical conversation correlation and no false acceptance', async () => {
    const f = await fixture('local_device')
    const channel = await createGroupChannel(connection.db, f.workspace.id, f.owner.principal, {
      idempotencyKey: 'origin',
      title: 'Origin',
    })
    const message = await createMessage(
      connection.db,
      f.workspace.id,
      channel.id,
      f.owner.principal,
      { bodyText: 'PRIVATE_MESSAGE_SENTINEL', idempotencyKey: 'origin', sender: f.owner.principal }
    )
    const linked = await setTaskConversationReferences(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal,
      { channelId: channel.id, messageId: message.id },
      { idempotencyKey: 'link', requestId: crypto.randomUUID(), expectedVersion: 1 }
    )
    const result = await f.enqueue(f.input, { ...f.command, expectedVersion: linked.version })
    expect(result).toMatchObject({
      taskId: f.task.id,
      runtimeNodeId: f.node.id,
      locationKind: 'local_device',
      state: 'pending_delivery',
      profile,
      taskVersion: linked.version,
    })
    const [queued] = await connection.db
      .select()
      .from(commandOutbox)
      .where(eq(commandOutbox.workspaceId, f.workspace.id))
    expect(queued!.payload).toMatchObject({
      conversation: { channelId: channel.id, messageId: message.id },
      envelope: f.envelope,
      profile,
    })
    expect(queued!.status).toBe('pending')
    expect(queued!.attempts).toBe(0)
    for (const secret of [
      'PRIVATE_PROMPT_SENTINEL',
      'PRIVATE_CONTEXT_SENTINEL',
      'PRIVATE_MESSAGE_SENTINEL',
    ])
      expect(JSON.stringify(queued)).not.toContain(secret)
    const product = await getTaskForUser(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal
    )
    expect(product).toMatchObject({
      lifecycleState: 'created',
      version: linked.version,
      conversation: { channelId: channel.id, messageId: message.id },
    })
    expect(product!.controlPlaneExecutionRef).toBeUndefined()
    expect(
      await connection.db
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.taskId, f.task.id))
    ).toHaveLength(0)
    const events = await connection.db
      .select()
      .from(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, f.workspace.id),
          eq(workspaceEvents.eventType, 'task.submission_queued')
        )
      )
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('ciphertext')
    expect(JSON.stringify(queued!.payload.controlPlane)).toMatch(/tsk_[0-9A-HJKMNP-TV-Z]{26}/u)
    expect(JSON.stringify(queued!.payload.controlPlane)).toMatch(/agt_[0-9A-HJKMNP-TV-Z]{26}/u)
  })

  test('concurrent duplicate, restarted connection and changed payload converge without a second command', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 8 }, () => f.enqueue()))
    expect(new Set(results.map((row) => row.id)).size).toBe(1)
    const restarted = createDatabase(url!)
    try {
      expect(
        await enqueueTaskSubmission(
          restarted.db,
          f.workspace.id,
          f.task.id,
          f.owner.principal,
          f.input,
          f.command
        )
      ).toEqual(results[0]!)
    } finally {
      await restarted.close()
    }
    await expect(f.enqueue({ ...f.input, queueWhenOffline: true })).rejects.toThrow(
      'idempotency_conflict'
    )
    await expect(f.enqueue(f.input, { ...f.command, idempotencyKey: 'second' })).rejects.toThrow(
      'already_submitted'
    )
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(1)
    expect(
      await getTaskSubmissionForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
    ).toEqual(results[0]!)
  })

  test('queueing offline is explicit and never changes the selected node', async () => {
    const f = await fixture()
    await connection.db
      .update(runtimeNodes)
      .set({ lastProofAt: new Date(Date.now() - 600_000) })
      .where(eq(runtimeNodes.id, f.node.id))
    await expect(f.enqueue()).rejects.toThrow('node_offline')
    expect(
      await connection.db
        .select()
        .from(taskSubmissions)
        .where(eq(taskSubmissions.taskId, f.task.id))
    ).toHaveLength(0)
    expect(await f.enqueue({ ...f.input, queueWhenOffline: true })).toMatchObject({
      state: 'queued_for_node',
      runtimeNodeId: f.node.id,
      locationKind: 'remote_host',
    })
  })

  test('denies foreign workspace/principal, stale task/profile revisions, retired or unverified keys, expiry and wrong direction', async () => {
    const f = await fixture()
    const foreign = await fixture()
    await expect(
      enqueueTaskSubmission(
        connection.db,
        f.workspace.id,
        f.task.id,
        foreign.owner.principal,
        f.input,
        f.command
      )
    ).rejects.toThrow('unavailable')
    await expect(
      enqueueTaskSubmission(
        connection.db,
        foreign.workspace.id,
        f.task.id,
        foreign.owner.principal,
        f.input,
        f.command
      )
    ).rejects.toThrow('invalid')
    await expect(f.enqueue(f.input, { ...f.command, expectedVersion: 99 })).rejects.toThrow(
      'version_conflict'
    )
    await expect(f.enqueue({ ...f.input, profile: { ...profile, revision: 99 } })).rejects.toThrow(
      'profile_conflict'
    )
    await expect(
      f.enqueue({
        ...f.input,
        envelope: { ...f.envelope, aad: { ...f.envelope.aad, payloadType: 'execution.result' } },
      })
    ).rejects.toThrow('invalid')
    await expect(
      f.enqueue({
        ...f.input,
        envelope: {
          ...f.envelope,
          aad: { ...f.envelope.aad, expiresAt: new Date(Date.now() - 1000).toISOString() },
        },
      })
    ).rejects.toThrow('expired')
    await connection.db
      .update(runtimeNodeKeys)
      .set({ verifiedAt: null })
      .where(eq(runtimeNodeKeys.id, f.envelope.keyId))
    await expect(f.enqueue()).rejects.toThrow('key_unavailable')
    await connection.db
      .update(runtimeNodeKeys)
      .set({ verifiedAt: new Date(), retiredAt: new Date() })
      .where(eq(runtimeNodeKeys.id, f.envelope.keyId))
    await expect(f.enqueue()).rejects.toThrow('key_unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
  })

  test('scope/pin checks serialize with profile changes; original retry preserves its snapshot', async () => {
    const f = await fixture()
    const race = await Promise.allSettled([
      f.enqueue(),
      connection.db
        .update(agents)
        .set({ profileRevision: 1, profileVersion: `pfv_${'0'.repeat(25)}2` })
        .where(eq(agents.id, f.agent.id)),
    ])
    if (race[0]!.status === 'fulfilled') {
      expect(race[0]!.value.profile).toEqual(profile)
      expect((await f.enqueue()).profile).toEqual(profile)
    } else {
      expect(race[0]!.reason.message).toContain('profile_conflict')
      expect(
        await connection.db
          .select()
          .from(taskSubmissions)
          .where(eq(taskSubmissions.taskId, f.task.id))
      ).toHaveLength(0)
    }
  })

  test('rotation/revocation serialize with admission without deadlock or admitting an already-revoked node', async () => {
    const f = await fixture()
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: f.owner.principal.userId,
      kind: 'remote_host',
      nonce: crypto.randomUUID(),
      purpose: 'rotate',
      runtimeNodeId: f.node.id,
      workspaceId: f.workspace.id,
    })
    const replacements = f.keys.map((key) => ({
      ...key,
      publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    }))
    const race = await Promise.allSettled([
      f.enqueue(),
      rotateRuntimeNodeKeys(connection.db, {
        challengeId: challenge.challengeId,
        keys: replacements,
        ownerUserId: f.owner.principal.userId,
        runtimeNodeId: f.node.id,
        workspaceId: f.workspace.id,
      }),
    ])
    expect(race[1]!.status).toBe('fulfilled')
    if (race[0]!.status === 'rejected') expect(race[0]!.reason.message).toContain('key_unavailable')
    const revoked = await fixture()
    await revokeRuntimeNode(connection.db, {
      actorUserId: revoked.owner.principal.userId,
      reason: 'revoked',
      runtimeNodeId: revoked.node.id,
      workspaceId: revoked.workspace.id,
    })
    await expect(revoked.enqueue()).rejects.toThrow('unavailable')
  })

  test('commit failure rolls back intent, ciphertext and event together', async () => {
    const f = await fixture()
    const failingDatabase = new Proxy(connection.db, {
      get(target, key, receiver) {
        if (key === 'transaction')
          return (callback: Parameters<typeof connection.db.transaction>[0]) =>
            target.transaction(async (transaction) => {
              await callback(transaction)
              throw new Error('simulated commit failure')
            })
        return Reflect.get(target, key, receiver)
      },
    })
    await expect(
      enqueueTaskSubmission(
        failingDatabase,
        f.workspace.id,
        f.task.id,
        f.owner.principal,
        f.input,
        f.command
      )
    ).rejects.toThrow('simulated commit failure')
    expect(
      await connection.db
        .select()
        .from(taskSubmissions)
        .where(eq(taskSubmissions.taskId, f.task.id))
    ).toHaveLength(0)
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
    expect(
      await connection.db
        .select()
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, f.workspace.id),
            eq(workspaceEvents.eventType, 'task.submission_queued')
          )
        )
    ).toHaveLength(0)
    expect((await f.enqueue()).state).toBe('pending_delivery')
  })

  test('identical client idempotency keys in separate workspaces remain independent', async () => {
    const [left, right] = await Promise.all([fixture(), fixture()])
    const [first, second] = await Promise.all([left.enqueue(), right.enqueue()])
    expect(first.id).not.toBe(second.id)
    expect(first.workspaceId).not.toBe(second.workspaceId)
  })

  test('expiry preserves the original identity and cannot silently start a replacement', async () => {
    const f = await fixture()
    const original = await f.enqueue()
    await connection.db
      .update(taskSubmissions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(taskSubmissions.id, original.id))
    expect(
      await getTaskSubmissionForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
    ).toMatchObject({ id: original.id, state: 'expired' })
    expect(await f.enqueue()).toMatchObject({ id: original.id, state: 'expired' })
    await expect(
      f.enqueue(f.input, { ...f.command, idempotencyKey: 'replacement' })
    ).rejects.toThrow('already_submitted')
  })

  test('deleting an outbox command cannot erase the original submission identity', async () => {
    const f = await fixture()
    const original = await f.enqueue()
    await expect(
      connection.db
        .delete(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
        .execute()
    ).rejects.toThrow()
    expect(await f.enqueue()).toMatchObject({ id: original.id })
  })

  test('an existing execution reference refuses a new initial intent without relay writes', async () => {
    const f = await fixture()
    await connection.db
      .update(tasks)
      .set({ controlPlaneExecutionRef: 'existing-execution' })
      .where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
  })

  test('foreign and mismatched conversation references refuse initial admission', async () => {
    const [f, other] = await Promise.all([fixture(), fixture()])
    const foreign = await createGroupChannel(
      connection.db,
      other.workspace.id,
      other.owner.principal,
      { idempotencyKey: 'foreign', title: 'Foreign' }
    )
    await connection.db.update(tasks).set({ channelId: foreign.id }).where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    const channels = await Promise.all(
      ['one', 'two'].map((idempotencyKey) =>
        createGroupChannel(connection.db, f.workspace.id, f.owner.principal, {
          idempotencyKey,
          title: idempotencyKey,
        })
      )
    )
    const message = await createMessage(
      connection.db,
      f.workspace.id,
      channels[1]!.id,
      f.owner.principal,
      { bodyText: 'private', idempotencyKey: 'message', sender: f.owner.principal }
    )
    await connection.db
      .update(tasks)
      .set({ channelId: channels[0]!.id, messageId: message.id })
      .where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
  })

  test('same request racing with different keys yields one intent and a stable conflict', async () => {
    const f = await fixture()
    const second = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      { agentId: f.agent.id, projectId: f.project.id, title: 'Second', objective: 'Private' },
      { requestId: crypto.randomUUID(), idempotencyKey: 'second-task' }
    )
    const outcomes = await Promise.allSettled([
      f.enqueue(),
      enqueueTaskSubmission(connection.db, f.workspace.id, second.id, f.owner.principal, f.input, {
        ...f.command,
        idempotencyKey: 'different-key',
      }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.message).toContain(
      'idempotency_conflict'
    )
  })

  test('an objective reference from another workspace cannot enter the selected host relay', async () => {
    const [f, other] = await Promise.all([fixture(), fixture()])
    const [reference] = await connection.db
      .insert(contentRefs)
      .values({
        workspaceId: other.workspace.id,
        contentType: 'task_objective',
        digestSha256: 'a'.repeat(64),
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        availability: 'available',
        schemaVersion: 1,
        keyVersion: 1,
      })
      .returning({ id: contentRefs.id })
    await connection.db
      .update(tasks)
      .set({ objective: null, objectiveContentRefId: reference!.id })
      .where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
    await connection.db
      .update(contentRefs)
      .set({ workspaceId: f.workspace.id, taskId: f.task.id })
      .where(eq(contentRefs.id, reference!.id))
    expect((await f.enqueue()).state).toBe('pending_delivery')
  })

  test('same workspace/key racing on different Tasks yields one intent and a stable conflict', async () => {
    const f = await fixture()
    const second = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        agentId: f.agent.id,
        projectId: f.project.id,
        title: 'Second Task',
        objective: 'Private second objective',
      },
      { requestId: crypto.randomUUID(), idempotencyKey: 'second-task' }
    )
    const outcomes = await Promise.allSettled([
      f.enqueue(),
      enqueueTaskSubmission(
        connection.db,
        f.workspace.id,
        second.id,
        f.owner.principal,
        f.input,
        f.command
      ),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.message).toContain(
      'idempotency_conflict'
    )
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(1)
  })
})
