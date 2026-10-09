import { createRegistry } from '@earendil-works/pi-durable'
import { test, expect } from 'bun:test'
import { CloudflareSessionJournal, parseBinding } from './sessions.ts'
import { CloudflareOwnerJournal, stableJson } from './owner.ts'
import { fixture, pins, request } from './test-fixtures.mjs'
const binding = {
  schemaVersion: 1,
  sessionId: 'ses_00000000000000000000000001',
  nativeConversationId: 1,
  attemptId: request.attemptId,
}

test('durable session aliases replay exactly and survive owner replacement without changing task pins', async () => {
  const f = fixture()
  try {
    await f.host.accept(request, 42)
    const before = f.journal.get(request.attemptId).task
    const sessions = new CloudflareSessionJournal(f.storage, f.journal)
    sessions.bind(binding)
    sessions.bind(binding)
    expect(sessions.get(binding.sessionId)).toEqual({ binding, task: before })
    const reopened = new CloudflareSessionJournal(
      f.storage,
      new CloudflareOwnerJournal(f.storage, pins)
    )
    expect(reopened.list()).toEqual([{ binding, task: before }])
    expect(() => sessions.get(binding.sessionId)).toThrow('CLOUDFLARE_OWNER_STALE')
  } finally {
    f.db.close()
  }
})
test('changed alias, duplicate native mapping and missing accepted attempt fail atomically', async () => {
  const f = fixture()
  try {
    await f.host.accept(request, 42)
    const sessions = new CloudflareSessionJournal(f.storage, f.journal)
    sessions.bind(binding)
    for (const changed of [
      { ...binding, nativeConversationId: 2 },
      { ...binding, sessionId: 'ses_00000000000000000000000002' },
      { ...binding, attemptId: 'att_00000000000000000000000002' },
    ])
      expect(() => sessions.bind(changed)).toThrow()
    expect(sessions.list()).toHaveLength(1)
    expect(f.journal.get(request.attemptId).state).toBe('accepted')
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})
test('unknown binding versions and noncanonical identifiers fail closed', () => {
  for (const changed of [
    { ...binding, schemaVersion: 2 },
    { ...binding, nativeConversationId: -1 },
    { ...binding, nativeConversationId: 0.5 },
    { ...binding, sessionId: 'caller-alias' },
    { ...binding, approved: true },
  ])
    expect(() => parseBinding(changed)).toThrow()
})

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CloudflareReadOnlySessions } from './sessions.ts'
import { CloudflarePiRuntimeAdapter } from './adapter.ts'
import { openCloudflarePiStorage } from './storage.ts'

async function nativeFixture(sessionCount = 1) {
  const f = fixture()
  await f.host.accept(request, 42)
  const seed = await openCloudflarePiStorage(f.storage)
  const nativeId = await seed.mintId()
  await seed.commit([{ type: 'conversation', value: { id: nativeId } }], BACKGROUND_CONTEXT)
  await seed.close(BACKGROUND_CONTEXT)
  const exact = { ...binding, nativeConversationId: nativeId }
  const allBindings = [exact]
  for (let index = 1; index < sessionCount; index++) {
    const extra = await openCloudflarePiStorage(f.storage)
    const extraId = await extra.mintId()
    await extra.commit([{ type: 'conversation', value: { id: extraId } }], BACKGROUND_CONTEXT)
    await extra.close(BACKGROUND_CONTEXT)
    allBindings.push({
      ...binding,
      sessionId: `ses_${String(index + 1).padStart(26, '0')}`,
      nativeConversationId: extraId,
    })
  }
  let revoked = false,
    expiresAt = 100,
    nativeReads = 0,
    nativeCloses = 0,
    onRead = () => {},
    onClose = () => {}
  const authority = {
    async assertCurrent(entries, owner, operation) {
      expect(owner).toEqual(pins)
      expect(['bind', 'load', 'list']).toContain(operation)
      if (revoked || expiresAt <= 42) throw new Error('SESSION_AUTHORITY_REVOKED')
      for (const entry of entries) {
        if (
          !allBindings.some((candidate) => stableJson(candidate) === stableJson(entry.binding)) ||
          entry.task.canonicalActorPrincipalId !== 'user:00000000-0000-0000-0000-000000000001' ||
          stableJson(entry.task.request) !== stableJson(request)
        )
          throw new Error('SESSION_CANONICAL_BINDING_DENIED')
      }
    },
  }
  const open = async () => {
    const storage = await openCloudflarePiStorage(f.storage)
    return {
      conversation: async (...args) => {
        nativeReads++
        const native = await storage.conversation(...args)
        await onRead()
        return native
      },
      close: async () => {
        nativeCloses++
        await storage.close(BACKGROUND_CONTEXT)
        await onClose()
      },
    }
  }
  const create = (journal = f.journal) =>
    new CloudflareReadOnlySessions(
      journal,
      new CloudflareSessionJournal(f.storage, journal),
      pins,
      f.authority,
      authority,
      open,
      BACKGROUND_CONTEXT,
      () => 42
    )
  const sessions = create()
  return {
    ...f,
    exact,
    allBindings,
    sessions,
    create,
    sessionAuthority: authority,
    open,
    revokeSession: () => {
      revoked = true
    },
    expire: () => {
      expiresAt = 42
    },
    onRead: (fn) => {
      onRead = fn
    },
    onClose: (fn) => {
      onClose = fn
    },
    nativeCounts: () => ({ nativeReads, nativeCloses }),
  }
}

test('actual vendor session load/list retain canonical alias across restart without opening Harness', async () => {
  const f = await nativeFixture()
  try {
    await Promise.all([f.sessions.bind(f.exact), f.sessions.bind(f.exact)])
    const runtime = new CloudflarePiRuntimeAdapter(
      { session: (op) => f.sessions.operation(op) },
      () => 42
    )
    const loaded = await runtime.session({ operation: 'load', sessionId: f.exact.sessionId })
    expect(loaded).toEqual({
      operation: 'load',
      session: {
        sessionId: f.exact.sessionId,
        state: 'active',
        observedAt: new Date(42).toISOString(),
      },
    })
    expect((await runtime.session({ operation: 'list' })).sessions).toEqual([loaded.session])
    const journal = new CloudflareOwnerJournal(f.storage, pins)
    expect(
      await f.create(journal).operation({ operation: 'load', sessionId: f.exact.sessionId })
    ).toEqual(loaded)
    expect(f.counts().opens).toBe(0)
    expect(journal.get(request.attemptId).state).toBe('accepted')
    expect(f.db.query('SELECT body FROM cp_pi_sessions').all()).toHaveLength(1)
  } finally {
    f.db.close()
  }
})

test('revoked/expired session or current actor denies before native reads and aliases', async () => {
  for (const revoke of [(f) => f.revokeSession(), (f) => f.expire(), (f) => f.revoke()]) {
    const f = await nativeFixture()
    try {
      revoke(f)
      await expect(f.sessions.bind(f.exact)).rejects.toThrow()
      expect(f.db.query('SELECT * FROM cp_pi_sessions').all()).toEqual([])
      expect(f.nativeCounts().nativeReads).toBe(0)
      expect(f.counts().opens).toBe(0)
    } finally {
      f.db.close()
    }
  }
})

test('authority revoked during native read/close prevents returning data and binding persistence', async () => {
  for (const when of ['onRead', 'onClose']) {
    const f = await nativeFixture()
    try {
      f[when](() => f.revokeSession())
      await expect(f.sessions.bind(f.exact)).rejects.toThrow('SESSION_AUTHORITY_REVOKED')
      expect(f.db.query('SELECT * FROM cp_pi_sessions').all()).toEqual([])
      expect(f.nativeCounts().nativeCloses).toBe(1)
    } finally {
      f.db.close()
    }
  }
})

test('owner replacement during native read fences late session alias and closes storage', async () => {
  const f = await nativeFixture()
  try {
    f.onRead(() => new CloudflareOwnerJournal(f.storage, pins))
    await expect(f.sessions.bind(f.exact)).rejects.toThrow('CLOUDFLARE_OWNER_STALE')
    expect(f.db.query('SELECT * FROM cp_pi_sessions').all()).toEqual([])
    expect(f.nativeCounts().nativeCloses).toBe(1)
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

test('session reads cannot resume an interrupted send or bypass revoked/unsupported approval', async () => {
  const f = await nativeFixture()
  try {
    await f.sessions.bind(f.exact)
    f.journal.transition(request.attemptId, 'accepted', 'running')
    const journal = new CloudflareOwnerJournal(f.storage, pins),
      sessions = f.create(journal)
    const runtime = new CloudflarePiRuntimeAdapter(
      { session: (op) => sessions.operation(op) },
      () => 42
    )
    expect(
      (await runtime.session({ operation: 'load', sessionId: f.exact.sessionId })).session.sessionId
    ).toBe(f.exact.sessionId)
    for (const operation of [
      { operation: 'resume', sessionId: f.exact.sessionId },
      { operation: 'create', idempotencyKey: 'new' },
      { operation: 'close', sessionId: f.exact.sessionId },
      { operation: 'history', sessionId: f.exact.sessionId },
    ])
      await expect(runtime.session(operation)).rejects.toThrow('CLOUDFLARE_SESSION_UNSUPPORTED')
    await expect(runtime.submitApproval({}, {})).rejects.toThrow('CLOUDFLARE_APPROVAL_UNSUPPORTED')
    expect(journal.get(request.attemptId).state).toBe('reconciliation_required')
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

import { CloudflarePiDurableOwner } from './durable-object.ts'

test('real durable owner exposes only explicitly authorized load/list and default stays unsupported', async () => {
  for (const enabled of [false, true]) {
    const f = await nativeFixture()
    try {
      const owner = new CloudflarePiDurableOwner(
        { storage: f.storage, blockConcurrencyWhile: (fn) => fn() },
        {
          context: BACKGROUND_CONTEXT,
          pins,
          authority: f.authority,
          ...(enabled ? { sessionAuthority: f.sessionAuthority } : {}),
          now: () => 42,
          nativeTaskCatalog: {
            schemaVersion: 1,
            configurationDigest: pins.configurationDigest,
            registry: createRegistry().snapshot(),
            migrations: [],
          },
          openEngine: f.openEngine,
        }
      )
      // This branch uses a dedicated canonical session port, not the execution authority shape.
      if (!enabled) {
        await expect(owner.bindSession(f.exact)).rejects.toThrow('CLOUDFLARE_SESSION_UNSUPPORTED')
        await expect(owner.runtimeAdapter().session({ operation: 'list' })).rejects.toThrow(
          'CLOUDFLARE_SESSION_UNSUPPORTED'
        )
      } else {
        await owner.bindSession(f.exact)
        expect(
          (
            await owner
              .runtimeAdapter()
              .session({ operation: 'load', sessionId: f.exact.sessionId })
          ).session.sessionId
        ).toBe(f.exact.sessionId)
        expect((await owner.runtimeAdapter().session({ operation: 'list' })).sessions).toHaveLength(
          1
        )
      }
      expect(f.counts().opens).toBe(0)
    } finally {
      f.db.close()
    }
  }
})

test('caller binding and operation mutation cannot redirect an awaited read', async () => {
  const f = await nativeFixture()
  try {
    const input = { ...f.exact }
    f.onRead(() => {
      input.sessionId = 'ses_00000000000000000000000002'
      input.nativeConversationId = 99
    })
    await f.sessions.bind(input)
    expect(
      f.db.query('SELECT native_conversation_id FROM cp_pi_sessions').get().native_conversation_id
    ).toBe(f.exact.nativeConversationId)
    const operation = { operation: 'load', sessionId: f.exact.sessionId }
    f.onRead(() => {
      operation.sessionId = 'ses_00000000000000000000000002'
    })
    expect((await f.sessions.operation(operation)).session.sessionId).toBe(f.exact.sessionId)
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})
test('missing native and forged canonical mappings fail before alias persistence', async () => {
  const f = await nativeFixture()
  try {
    for (const candidate of [
      { ...f.exact, nativeConversationId: 99 },
      { ...f.exact, sessionId: 'ses_00000000000000000000000002' },
      { ...f.exact, approved: true },
    ])
      await expect(Promise.resolve().then(() => f.sessions.bind(candidate))).rejects.toThrow()
    expect(f.nativeCounts().nativeReads).toBe(0)
    expect(f.db.query('SELECT * FROM cp_pi_sessions').all()).toEqual([])
    // Canonical mapping can be valid while the native record is absent; existence is independently verified.
    f.db.query('DELETE FROM conversations').run()
    await expect(f.sessions.bind(f.exact)).rejects.toThrow('CLOUDFLARE_NATIVE_CONVERSATION_MISSING')
    expect(f.db.query('SELECT * FROM cp_pi_sessions').all()).toEqual([])
    expect(f.nativeCounts().nativeCloses).toBe(1)
  } finally {
    f.db.close()
  }
})
test('revoked loads/list and alias replacement after native await cannot expose session data', async () => {
  const f = await nativeFixture()
  try {
    await f.sessions.bind(f.exact)
    const changed = { ...f.exact, nativeConversationId: 99 }
    f.onRead(() => f.db.query('UPDATE cp_pi_sessions SET body = ?').run(stableJson(changed)))
    await expect(
      f.sessions.operation({ operation: 'load', sessionId: f.exact.sessionId })
    ).rejects.toThrow('CLOUDFLARE_SESSION_PIN_MISMATCH')
    f.db.query('UPDATE cp_pi_sessions SET body = ?').run(stableJson(f.exact))
    f.onRead(() => {})
    f.revokeSession()
    await expect(
      f.sessions.operation({ operation: 'load', sessionId: 'ses_00000000000000000000000002' })
    ).rejects.toThrow('SESSION_AUTHORITY_REVOKED')
    await expect(f.sessions.operation({ operation: 'list' })).rejects.toThrow(
      'SESSION_AUTHORITY_REVOKED'
    )
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

test('owner snapshots binding and direct session operation before initialization awaits', async () => {
  const f = await nativeFixture()
  try {
    let initialize
    const owner = new CloudflarePiDurableOwner(
      {
        storage: f.storage,
        blockConcurrencyWhile: (fn) =>
          new Promise((resolve, reject) => {
            initialize = () => fn().then(resolve, reject)
          }),
      },
      {
        context: BACKGROUND_CONTEXT,
        pins,
        authority: f.authority,
        sessionAuthority: f.sessionAuthority,
        now: () => 42,
        nativeTaskCatalog: {
          schemaVersion: 1,
          configurationDigest: pins.configurationDigest,
          registry: createRegistry().snapshot(),
          migrations: [],
        },
        openEngine: f.openEngine,
      }
    )
    const suppliedBinding = { ...f.exact }
    const operation = { operation: 'load', sessionId: f.exact.sessionId }
    const pendingBind = owner.bindSession(suppliedBinding)
    const pendingLoad = owner.session(operation)
    suppliedBinding.sessionId = 'ses_00000000000000000000000002'
    suppliedBinding.nativeConversationId = 99
    operation.sessionId = 'ses_00000000000000000000000002'
    initialize()
    await pendingBind
    expect((await pendingLoad).session.sessionId).toBe(f.exact.sessionId)
    expect(f.db.query('SELECT session_id FROM cp_pi_sessions').all()).toEqual([
      { session_id: f.exact.sessionId },
    ])
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

for (const change of ['revocation', 'epoch']) {
  test(`two-session list stops before the next native read after ${change}`, async () => {
    const f = await nativeFixture(2)
    try {
      for (const entry of f.allBindings) await f.sessions.bind(entry)
      const before = f.nativeCounts()
      let changed = false
      f.onRead(() => {
        if (changed) return
        changed = true
        if (change === 'revocation') f.revokeSession()
        else new CloudflareOwnerJournal(f.storage, pins).assertOwner()
      })
      await expect(f.sessions.operation({ operation: 'list' })).rejects.toThrow(
        change === 'revocation' ? 'SESSION_AUTHORITY_REVOKED' : 'CLOUDFLARE_OWNER_STALE'
      )
      expect(f.nativeCounts().nativeReads - before.nativeReads).toBe(1)
      expect(f.nativeCounts().nativeCloses - before.nativeCloses).toBe(1)
      expect(f.counts().opens).toBe(0)
      expect(f.db.query('SELECT * FROM cp_pi_sessions').all()).toHaveLength(2)
    } finally {
      f.db.close()
    }
  })
}
