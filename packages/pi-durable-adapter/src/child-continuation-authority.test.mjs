import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertPiChildContinuationSnapshot } from './child-continuation.ts'
import {
  createPiChildContinuationAuthority,
  readPiChildContinuationJournal,
} from './child-continuation-authority.ts'
import { SqliteDurableJournal } from './journal.ts'
import { fixture, createdAt, expiresAt, id } from './child-continuation.fixture.mjs'

const rejected = 'PI_CHILD_CONTINUATION_REJECTED'

/** Real canonical lifecycle fixture, with explicitly scripted current/send/publication ports. */
async function host() {
  const f = await fixture()
  let grant = f.grant
  let clock = createdAt
  let current = f.current()
  let onSend
  let onCurrent
  let publication = true
  const calls = { fresh: 0, snapshot: 0, current: 0, send: 0, publication: 0, lookup: [] }
  const options = {
    repository: {
      getByChildAttempt: async (workspaceId, attemptId) => {
        calls.lookup.push({ workspaceId, attemptId })
        return grant
      },
    },
    readSnapshot: async () => {
      calls.snapshot++
      return f.snapshot()
    },
    current: {
      readCurrent: async () => {
        calls.current++
        await onCurrent?.(calls.current)
        return structuredClone(current)
      },
    },
    assertFreshAuthority: async () => {
      calls.fresh++
      assertPiChildContinuationSnapshot(f.grant, await f.snapshot(), { mode: 'retain', now: clock })
    },
    assertSendAuthority: async () => {
      calls.send++
      await onSend?.()
    },
    assertPublicationAuthority: async () => {
      calls.publication++
      if (!publication) throw new Error('PUBLICATION_AUDIENCE_REVOKED')
    },
    now: () => clock,
  }
  return {
    ...f,
    options,
    calls,
    wrapper: createPiChildContinuationAuthority(options),
    setGrant: (value) => {
      grant = value
    },
    setClock: (value) => {
      clock = value
    },
    revoke: (field) => {
      current[field] = field === 'revoked'
    },
    afterSend: (operation) => {
      onSend = operation
    },
    duringCurrent: (operation) => {
      onCurrent = operation
    },
    setPublication: (value) => {
      publication = value
    },
  }
}

async function completeParent(f) {
  const snapshot = await f.snapshot()
  await f.lifecycle.transitionExecution({
    executionId: snapshot.parentExecution.executionId,
    expectedVersion: snapshot.parentExecution.version,
    to: 'completed',
    transitionedAt: createdAt,
    terminalResultRef: id('art'),
  })
  await f.lifecycle.transitionAttempt({
    attemptId: snapshot.parentAttempt.attemptId,
    expectedVersion: snapshot.parentAttempt.version,
    to: 'completed',
    transitionedAt: createdAt,
    terminalResultRef: id('art'),
  })
}

test('production continuation wrapper fails closed when any mandatory trusted port is missing', async () => {
  const f = await host()
  for (const key of [
    'repository',
    'readSnapshot',
    'current',
    'assertFreshAuthority',
    'assertSendAuthority',
    'assertPublicationAuthority',
    'now',
  ]) {
    expect(() => createPiChildContinuationAuthority({ ...f.options, [key]: undefined })).toThrow(
      rejected
    )
  }
  expect(() => createPiChildContinuationAuthority({ ...f.options, repository: {} })).toThrow(
    rejected
  )
  expect(() => createPiChildContinuationAuthority({ ...f.options, current: {} })).toThrow(rejected)
})

test('absence of a grant delegates only to strict fresh authority and cannot relax a completed parent', async () => {
  const f = await host()
  f.setGrant(undefined)
  await f.wrapper.assertAuthority(f.authority)
  expect(f.calls.fresh).toBe(1)
  expect(f.calls.send).toBe(0)
  expect(f.calls.current).toBe(0)
  await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(rejected)
  await completeParent(f)
  await expect(f.wrapper.assertAuthority(f.authority)).rejects.toThrow(rejected)
  expect(f.calls.fresh).toBe(2)
  expect(f.calls.send).toBe(0)
})

test('completed-parent resume uses only the exact original child session and never renews the grant', async () => {
  const f = await host()
  await completeParent(f)
  const original = canonicalJsonStringify(f.grant)
  expect(await f.wrapper.assertResume(f.authority, f.grant.child.handle)).toEqual(f.grant)
  expect(await f.wrapper.assertResume(f.authority, f.grant.child.handle)).toEqual(f.grant)
  for (const changed of [
    { ...f.grant.child.handle, handleId: 'pi-durable:replacement' },
    { ...f.grant.child.handle, externalSessionId: id('ses') },
    { ...f.grant.child.handle, attemptId: id('att') },
    { ...f.grant.child.handle, startedAt: createdAt },
  ])
    await expect(f.wrapper.assertResume(f.authority, changed)).rejects.toThrow(rejected)
  expect(f.calls.fresh).toBe(0)
  expect(f.calls.send).toBe(2)
  expect(
    f.calls.lookup.every(
      (value) =>
        value.workspaceId === f.grant.workspaceId && value.attemptId === f.grant.child.attemptId
    )
  ).toBe(true)
  f.setClock(expiresAt)
  await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(rejected)
  expect(f.calls.send).toBe(2)
  expect(canonicalJsonStringify(f.grant)).toBe(original)
})

for (const field of ['revoked', 'actorActive', 'scopeActive', 'providerActive', 'spendingActive'])
  test(`current ${field} changes while send authority awaits deny continuation`, async () => {
    const f = await host()
    f.afterSend(async () => {
      await Promise.resolve()
      f.revoke(field)
    })
    await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(
      rejected
    )
    expect(f.calls.send).toBe(1)
    expect(f.calls.current).toBe(2)
    expect(f.calls.fresh).toBe(0)
  })

for (const owner of ['parent', 'child'])
  test(`latest ${owner} attempt changed during asynchronous send authority cannot reuse old continuation`, async () => {
    const f = await host()
    const target = f.grant[owner]
    f.afterSend(async () => {
      const execution = await f.repository.getExecution(target.executionId)
      await f.lifecycle.createAttempt({
        executionId: execution.executionId,
        expectedExecutionVersion: execution.version,
        attemptId: 'att_01JCBCDEF0123456789ABCDEFG',
        queuedAt: createdAt,
      })
    })
    await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(
      rejected
    )
    expect((await f.repository.getExecution(target.executionId)).latestAttemptId).not.toBe(
      target.attemptId
    )
    expect(f.calls.snapshot).toBeGreaterThanOrEqual(2)
    expect(f.calls.send).toBe(1)
  })

test('latest child attempt changed during the final current read still denies stale continuation', async () => {
  const f = await host()
  f.duringCurrent(async (read) => {
    if (read !== 2) return
    const child = await f.repository.getExecution(f.grant.child.executionId)
    await f.lifecycle.createAttempt({
      executionId: child.executionId,
      expectedExecutionVersion: child.version,
      attemptId: 'att_01JCBCDEF0123456789ABCDEFG',
      queuedAt: createdAt,
    })
  })
  await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(rejected)
  expect(f.calls.current).toBe(2)
  expect(f.calls.send).toBe(1)
})

test('grant expiring during an awaited current read denies before send authority', async () => {
  const f = await host()
  f.duringCurrent(async () => {
    await Promise.resolve()
    f.setClock(expiresAt)
  })
  await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(rejected)
  expect(f.calls.current).toBe(1)
  expect(f.calls.send).toBe(0)
  expect(f.grant.expiresAt).toBe(expiresAt)
})

test('expiry during asynchronous send authority denies continuation without refreshing its fixed TTL', async () => {
  const f = await host()
  f.afterSend(async () => {
    await Promise.resolve()
    f.setClock(expiresAt)
  })
  await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(rejected)
  expect(f.grant.expiresAt).toBe(expiresAt)
  expect(f.calls.send).toBe(1)
})

test('publication audience authority is independent of successful continuation and revoked send eligibility', async () => {
  const f = await host()
  await f.wrapper.assertResume(f.authority, f.grant.child.handle)
  f.setPublication(false)
  await expect(f.wrapper.assertPublication(f.grant)).rejects.toThrow('PUBLICATION_AUDIENCE_REVOKED')
  expect(f.calls.publication).toBe(1)
  f.revoke('providerActive')
  await expect(f.wrapper.assertResume(f.authority, f.grant.child.handle)).rejects.toThrow(rejected)
  f.setPublication(true)
  await f.wrapper.assertPublication(f.grant)
  expect(f.calls.publication).toBe(2)
  expect(f.calls.send).toBe(1)
})

test('publication revoked after a canonical terminal child result cannot discard or redeliver retained evidence', async () => {
  const f = await host()
  const snapshot = await f.snapshot()
  await f.lifecycle.transitionExecution({
    executionId: snapshot.childExecution.executionId,
    expectedVersion: snapshot.childExecution.version,
    to: 'completed',
    transitionedAt: createdAt,
    terminalResultRef: id('art', true),
  })
  await f.lifecycle.transitionAttempt({
    attemptId: snapshot.childAttempt.attemptId,
    expectedVersion: snapshot.childAttempt.version,
    to: 'completed',
    transitionedAt: createdAt,
    terminalResultRef: id('art', true),
  })
  const retained = await f.repository.getExecution(f.grant.child.executionId)
  f.setPublication(false)
  await expect(f.wrapper.assertPublication(f.grant)).rejects.toThrow('PUBLICATION_AUDIENCE_REVOKED')
  expect(await f.repository.getExecution(f.grant.child.executionId)).toEqual(retained)
  expect(retained.terminalResultRef).toBe(id('art', true))
  expect(f.calls.send).toBe(0)
})

test('read-only child journal metadata survives physical reopen and binds exact session, prompt and start key through its grant', async () => {
  const f = await host()
  const directory = mkdtempSync(join(tmpdir(), 'pi-child-metadata-'))
  const path = join(directory, 'journal.sqlite')
  let journal
  try {
    journal = new SqliteDurableJournal(path)
    const handle = f.grant.child.handle
    journal.admit({
      handleId: handle.handleId,
      attemptId: handle.attemptId,
      startKey: f.authority.request.idempotencyKey,
      admission: { ...f.authority, handle },
      at: handle.startedAt,
    })
    const before = journal.get(handle.handleId)
    journal.close()
    journal = new SqliteDurableJournal(path)
    const metadata = readPiChildContinuationJournal(journal, handle)
    expect(metadata).toEqual({ ...f.authority, handle, state: before.state })
    expect(journal.get(handle.handleId)).toEqual(before)
    expect(await f.wrapper.assertResume(metadata, metadata.handle)).toEqual(f.grant)
    for (const changed of [
      { ...handle, handleId: 'pi-durable:missing' },
      { ...handle, attemptId: id('att') },
      { ...handle, externalSessionId: id('ses') },
    ])
      expect(() => readPiChildContinuationJournal(journal, changed)).toThrow()
    for (const changed of [
      { ...metadata, request: { ...metadata.request, idempotencyKey: 'replacement-child' } },
      { ...metadata, admission: { ...metadata.admission, prompt: 'Replacement objective' } },
    ])
      await expect(f.wrapper.assertResume(changed, handle)).rejects.toThrow(rejected)
    expect(journal.list()).toHaveLength(1)
    expect(journal.get(handle.handleId)).toEqual(before)
  } finally {
    journal?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
