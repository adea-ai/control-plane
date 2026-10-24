import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PiCancellationRegistrationCoordinator } from './cancellation-registration.ts'

const resources = []
afterEach(() => {
  for (const { databases, directory } of resources.splice(0)) {
    for (const database of databases) database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
const generation = { lineageId: 'lineage:one', restoreGeneration: 'G:one', revision: 1 }
const owner = (overrides = {}) => ({
  ownerId: 'owner:one',
  processClaimId: 'process:one',
  ownerEpoch: 1,
  generation,
  scopes: ['scope:a', 'scope:b'],
  ...overrides,
})
const mutation = (mutationId = 'mutation:one', scopes = ['scope:a']) => ({
  mutationId,
  generation,
  scopes,
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-registration-'))
  const path = join(directory, 'prototype.sqlite')
  const databases = []
  resources.push({ directory, databases })
  const authority = {
    current: { ...generation, state: 'open' },
    async readCurrent() {
      return { ...this.current }
    },
  }
  const calls = []
  const native = {
    async installFence(request) {
      calls.push(structuredClone(request))
      return {
        ...request,
        schemaVersion: 'pi-native-cancellation-fence-receipt/v1',
        installationReceiptId: `receipt:${request.fenceEpoch}`,
        nativeCommitSequence: request.fenceEpoch,
        installedAt: '2026-10-23T12:00:00.000Z',
      }
    },
  }
  function connect(boundary = native, current = authority) {
    const database = new DatabaseSync(path)
    databases.push(database)
    return {
      database,
      coordinator: new PiCancellationRegistrationCoordinator(database, current, boundary),
    }
  }
  return { ...connect(), connect, authority, native, calls, path, databases }
}

test('closes registered scope cut, binds ACK and retains evidence across connections', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  const before = await f.coordinator.beginMutation(mutation())
  expect(before.status).toBe('pending')
  expect(before.owners).toHaveLength(1)
  expect(before.qualifiedAuthorization).toBe(false)
  await expect(f.coordinator.register(owner({ ownerId: 'late' }))).rejects.toThrow(
    'PI_CANCELLATION_SCOPE_CLOSED'
  )
  await expect(f.coordinator.unregister(owner())).rejects.toThrow('PI_CANCELLATION_SCOPE_CLOSED')
  const fenced = await f.coordinator.installFences('mutation:one')
  expect(fenced.status).toBe('fenced')
  expect(f.calls).toHaveLength(1)
  expect(await f.connect().coordinator.readEvidence('mutation:one')).toEqual(fenced)
  expect(await f.coordinator.beginMutation(mutation())).toEqual(fenced)
  await expect(f.coordinator.beginMutation(mutation('mutation:one', ['scope:b']))).rejects.toThrow(
    'PI_CANCELLATION_MUTATION_CONFLICT'
  )
})

test('registration suspended in authority read cannot escape closure from another SQLite connection', async () => {
  const f = fixture()
  let resume
  let entered
  const reading = new Promise((resolve) => {
    entered = resolve
  })
  const stalled = {
    async readCurrent() {
      entered()
      await new Promise((resolve) => {
        resume = resolve
      })
      return { ...generation, state: 'open' }
    },
  }
  const other = f.connect(f.native, stalled).coordinator
  const pending = other.register(owner())
  await reading
  expect((await f.coordinator.beginMutation(mutation())).owners).toHaveLength(0)
  resume()
  await expect(pending).rejects.toThrow('PI_CANCELLATION_SCOPE_CLOSED')
})

test('exact registrations are idempotent; identity rebind is blocked by all old and new scopes', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.register(owner({ scopes: ['scope:b', 'scope:a'] }))
  await f.coordinator.beginMutation(mutation())
  await expect(
    f.coordinator.register(
      owner({ processClaimId: 'process:successor', ownerEpoch: 2, scopes: ['unaffected'] })
    )
  ).rejects.toThrow('PI_CANCELLATION_SCOPE_CLOSED')
  await expect(f.coordinator.unregister(owner({ ownerEpoch: 99 }))).rejects.toThrow(
    'PI_CANCELLATION_OWNER_CONFLICT'
  )
  expect((await f.coordinator.readEvidence('mutation:one')).owners[0].owner.processClaimId).toBe(
    'process:one'
  )
})

test('overlap restrictions persist separately and per-owner fences cannot overtake an unacked epoch', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  await f.coordinator.beginMutation(mutation('mutation:two', ['scope:b']))
  await expect(f.coordinator.installFences('mutation:two')).rejects.toThrow(
    'PI_CANCELLATION_FENCE_PREDECESSOR_PENDING'
  )
  expect(f.calls).toHaveLength(0)
  await f.coordinator.installFences('mutation:one')
  await f.coordinator.installFences('mutation:two')
  expect(f.calls.map(({ previousEpoch, fenceEpoch }) => [previousEpoch, fenceEpoch])).toEqual([
    [0, 1],
    [1, 2],
  ])
  await expect(f.coordinator.register(owner({ scopes: ['scope:b'] }))).rejects.toThrow(
    'PI_CANCELLATION_SCOPE_CLOSED'
  )
  expect((await f.coordinator.readEvidence('mutation:one')).status).toBe('fenced')
})

test('mismatched receipt stays unconfirmed and retry preserves exact request after reopen', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const bad = {
    async installFence(request) {
      return { ...(await f.native.installFence(request)), processClaimId: 'forged' }
    },
  }
  await expect(f.connect(bad).coordinator.installFences('mutation:one')).rejects.toThrow(
    'PI_NATIVE_CANCELLATION_FENCE_RECEIPT_MISMATCH'
  )
  expect((await f.coordinator.readEvidence('mutation:one')).status).toBe('pending')
  const good = await f.connect().coordinator.installFences('mutation:one')
  expect(good.status).toBe('fenced')
  expect(f.calls[0]).toEqual(f.calls[1])
})

test('lost native response replays the same identity and persisted ACK avoids another call', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const lost = {
    async installFence(request) {
      await f.native.installFence(request)
      throw new Error('response lost')
    },
  }
  await expect(f.connect(lost).coordinator.installFences('mutation:one')).rejects.toThrow(
    'response lost'
  )
  await f.connect().coordinator.installFences('mutation:one')
  expect(f.calls[0]).toEqual(f.calls[1])
  await f.connect().coordinator.installFences('mutation:one')
  expect(f.calls).toHaveLength(2)
})

test('default authority and native boundary fail closed with no synthesized ACK', async () => {
  const f = fixture()
  const unavailable = new PiCancellationRegistrationCoordinator(f.database)
  await expect(unavailable.register(owner())).rejects.toThrow(
    'PI_RESTORE_GENERATION_AUTHORITY_UNAVAILABLE'
  )
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const noNative = new PiCancellationRegistrationCoordinator(f.database, f.authority)
  await expect(noNative.installFences('mutation:one')).rejects.toThrow(
    'PI_NATIVE_CANCELLATION_BOUNDARY_UNAVAILABLE'
  )
  expect((await f.coordinator.readEvidence('mutation:one')).status).toBe('pending')
})

test('independent G rejects an intact historical registry and matching digests after rollback', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  await f.coordinator.installFences('mutation:one')
  f.authority.current = { ...generation, restoreGeneration: 'G:two', revision: 2, state: 'open' }
  const reopened = f.connect().coordinator
  await expect(reopened.readEvidence('mutation:one')).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  await expect(reopened.beginMutation(mutation())).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  await expect(reopened.register(owner())).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  await expect(reopened.installFences('mutation:one')).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
})

test('generation closing permits only restrictive installation and never open-generation evidence', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  f.authority.current.state = 'closing'
  await expect(f.coordinator.installFences('mutation:one')).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  expect(f.calls).toHaveLength(1)
  await expect(f.coordinator.readEvidence('mutation:one')).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  await expect(f.coordinator.register(owner({ ownerId: 'new', scopes: ['new'] }))).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  f.authority.current.state = 'open'
  expect((await f.coordinator.readEvidence('mutation:one')).status).toBe('fenced')
})

test('unaffected registration can progress during native await, without a SQLite transaction held', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const concurrent = f.connect().coordinator
  const boundary = {
    async installFence(request) {
      await concurrent.register(
        owner({ ownerId: 'independent', processClaimId: 'process:two', scopes: ['scope:z'] })
      )
      return f.native.installFence(request)
    },
  }
  expect((await f.connect(boundary).coordinator.installFences('mutation:one')).status).toBe(
    'fenced'
  )
  expect(
    (await concurrent.beginMutation(mutation('independent', ['scope:z']))).owners
  ).toHaveLength(1)
})

test('G change during native await cannot persist ACK or expose retained evidence', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const boundary = {
    async installFence(request) {
      const receipt = await f.native.installFence(request)
      f.authority.current = {
        ...generation,
        restoreGeneration: 'G:two',
        revision: 2,
        state: 'open',
      }
      return receipt
    },
  }
  await expect(f.connect(boundary).coordinator.installFences('mutation:one')).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  expect(
    f.database.prepare('SELECT receipt_body FROM pi_cancel_proto_fences').get().receipt_body
  ).toBeNull()
})

test('every owner in affected cut requires ACK, and unrelated owners are excluded', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.register(owner({ ownerId: 'owner:two', processClaimId: 'process:two' }))
  await f.coordinator.register(
    owner({
      ownerId: 'owner:outside',
      processClaimId: 'process:outside',
      scopes: ['scope:outside'],
    })
  )
  const cut = await f.coordinator.beginMutation(mutation())
  expect(cut.owners.map(({ owner: retained }) => retained.ownerId)).toEqual([
    'owner:one',
    'owner:two',
  ])
  const partial = {
    async installFence(request) {
      if (request.processClaimId === 'process:two') throw new Error('owner unavailable')
      return f.native.installFence(request)
    },
  }
  await expect(f.connect(partial).coordinator.installFences('mutation:one')).rejects.toThrow(
    'owner unavailable'
  )
  const evidence = await f.coordinator.readEvidence('mutation:one')
  expect(evidence.status).toBe('pending')
  expect(evidence.owners.filter(({ receipt }) => receipt)).toHaveLength(1)
  expect((await f.connect().coordinator.installFences('mutation:one')).status).toBe('fenced')
})

test('invalid authority, invalid scopes and corrupted immutable cut fail closed', async () => {
  const f = fixture()
  await expect(f.coordinator.register(owner({ scopes: [] }))).rejects.toThrow()
  const malformed = {
    async readCurrent() {
      return { ...generation, state: 'open', extra: true }
    },
  }
  await expect(f.connect(f.native, malformed).coordinator.register(owner())).rejects.toThrow(
    'PI_RESTORE_GENERATION_AUTHORITY_INVALID'
  )
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  f.database
    .prepare('UPDATE pi_cancel_proto_mutations SET cut_digest = ?')
    .run(`sha256:${'0'.repeat(64)}`)
  await expect(f.coordinator.readEvidence('mutation:one')).rejects.toThrow(
    'PI_CANCELLATION_REGISTRY_CORRUPT'
  )
  await expect(f.coordinator.installFences('mutation:one')).rejects.toThrow(
    'PI_CANCELLATION_REGISTRY_CORRUPT'
  )
  expect(f.calls).toHaveLength(0)
})

test('closed database snapshot replay keeps matching cut digests but independent G rejects it', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const original = await f.coordinator.installFences('mutation:one')
  for (const db of f.databases.splice(0)) db.close()
  const snapshot = `${f.path}.snapshot`
  copyFileSync(f.path, snapshot)
  const later = f.connect().coordinator
  await later.beginMutation(mutation('later', ['scope:b']))
  for (const db of f.databases.splice(0)) db.close()
  copyFileSync(snapshot, f.path)
  const restored = f.connect().coordinator
  expect(await restored.readEvidence('mutation:one')).toEqual(original)
  f.authority.current = { ...generation, restoreGeneration: 'G:new', revision: 2, state: 'open' }
  await expect(restored.readEvidence('mutation:one')).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
  await expect(restored.installFences('mutation:one')).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
})

test('open owner rebind requires advancing epoch, and exact unregister cannot remove a successor', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await expect(f.coordinator.register(owner({ processClaimId: 'replacement' }))).rejects.toThrow(
    'PI_CANCELLATION_OWNER_CONFLICT'
  )
  await expect(f.coordinator.register(owner({ ownerEpoch: 0 }))).rejects.toThrow(
    'PI_CANCELLATION_OWNER_CONFLICT'
  )
  await f.coordinator.register(owner({ processClaimId: 'replacement', ownerEpoch: 2 }))
  await expect(f.coordinator.unregister(owner())).rejects.toThrow('PI_CANCELLATION_OWNER_CONFLICT')
  await f.coordinator.unregister(owner({ processClaimId: 'replacement', ownerEpoch: 2 }))
  expect((await f.coordinator.beginMutation(mutation())).owners).toHaveLength(0)
})

test('removed closure rows cannot produce retained fenced evidence after reopen', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  await f.coordinator.installFences('mutation:one')
  f.database
    .prepare('DELETE FROM pi_cancel_proto_closures WHERE mutation_id = ?')
    .run('mutation:one')
  await expect(f.connect().coordinator.readEvidence('mutation:one')).rejects.toThrow(
    'PI_CANCELLATION_REGISTRY_CORRUPT'
  )
})

test('a native port mutating its request cannot mutate the retained binding or persist an ACK', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const boundary = {
    async installFence(request) {
      request.processClaimId = 'mutated'
      return f.native.installFence(request)
    },
  }
  await expect(f.connect(boundary).coordinator.installFences('mutation:one')).rejects.toThrow(
    'PI_NATIVE_CANCELLATION_FENCE_RECEIPT_MISMATCH'
  )
  const retained = await f.coordinator.readEvidence('mutation:one')
  expect(retained.status).toBe('pending')
  expect(retained.owners[0].request.processClaimId).toBe('process:one')
})

test('tampered ACK fails exact binding after reopen', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  await f.coordinator.installFences('mutation:one')
  const row = f.database.prepare('SELECT receipt_body FROM pi_cancel_proto_fences').get()
  const receipt = JSON.parse(row.receipt_body)
  receipt.fenceEpoch += 1
  f.database
    .prepare('UPDATE pi_cancel_proto_fences SET receipt_body = ?')
    .run(JSON.stringify(receipt))
  await expect(f.connect().coordinator.readEvidence('mutation:one')).rejects.toThrow(
    'PI_NATIVE_CANCELLATION_FENCE_RECEIPT_MISMATCH'
  )
})

test('evidence refuses an immutable cut substituted during independent generation read', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await f.coordinator.beginMutation(mutation())
  const oldBody = f.database.prepare('SELECT body FROM pi_cancel_proto_mutations').get().body
  const authority = {
    async readCurrent() {
      f.database.prepare('DELETE FROM pi_cancel_proto_fences').run()
      f.database.prepare('DELETE FROM pi_cancel_proto_closures').run()
      // Replace the cut by an internally self-consistent empty registered universe.
      const { createHash } = await import('node:crypto')
      const { canonicalJsonStringify } = await import('@control-plane/contracts')
      const emptyDigest = `sha256:${createHash('sha256').update(canonicalJsonStringify([])).digest('hex')}`
      f.database.prepare('UPDATE pi_cancel_proto_mutations SET cut_digest = ?').run(emptyDigest)
      f.database
        .prepare('INSERT INTO pi_cancel_proto_closures VALUES (?, ?, ?)')
        .run('mutation:one', generation.lineageId, 'scope:a')
      return { ...generation, state: 'open' }
    },
  }
  await expect(
    f.connect(f.native, authority).coordinator.readEvidence('mutation:one')
  ).rejects.toThrow('PI_CANCELLATION_REGISTRY_CONFLICT')
  expect(f.database.prepare('SELECT body FROM pi_cancel_proto_mutations').get().body).toBe(oldBody)
})

test('disjoint owner aliases cannot allocate independent epochs for the same native identity', async () => {
  const f = fixture()
  await f.coordinator.register(owner())
  await expect(
    f.coordinator.register(owner({ ownerId: 'alias', scopes: ['scope:alias'] }))
  ).rejects.toThrow('PI_CANCELLATION_NATIVE_OWNER_ALIAS')
  expect(
    (await f.coordinator.beginMutation(mutation('alias-cut', ['scope:alias']))).owners
  ).toHaveLength(0)
})

test('non-BMP and BMP scope names use the same canonical order across SQLite and JS', async () => {
  const f = fixture()
  const scopes = ['\u{10000}', '\ue000']
  await f.coordinator.register(owner({ scopes }))
  const before = await f.coordinator.beginMutation(mutation('unicode', scopes))
  expect(before.owners).toHaveLength(1)
  expect((await f.connect().coordinator.installFences('unicode')).status).toBe('fenced')
})

function pausedGenerationAuthority() {
  let entered
  let resume
  const reading = new Promise((resolve) => {
    entered = resolve
  })
  const released = new Promise((resolve) => {
    resume = resolve
  })
  return {
    reading,
    resume,
    authority: {
      async readCurrent() {
        entered()
        await released
        return { ...generation, state: 'open' }
      },
    },
  }
}

for (const operation of ['unregister', 'rebind']) {
  test(`${operation} suspended in generation read cannot escape a concurrent old-scope closure`, async () => {
    const f = fixture()
    const original = structuredClone(owner())
    await f.coordinator.register(original)
    const gate = pausedGenerationAuthority()
    const suspended = f.connect(f.native, gate.authority).coordinator
    const pending =
      operation === 'unregister'
        ? suspended.unregister(structuredClone(original))
        : suspended.register(
            owner({
              processClaimId: 'process:successor',
              ownerEpoch: 2,
              generation: { ...generation },
              scopes: ['scope:unaffected'],
            })
          )
    await gate.reading
    let cut
    let epochs
    try {
      cut = await f.coordinator.beginMutation(mutation())
      epochs = f.database.prepare('SELECT * FROM pi_cancel_proto_epochs ORDER BY owner_key').all()
      expect(cut.owners.map(({ owner: retained }) => retained)).toEqual([original])
      expect(cut.status).toBe('pending')
      expect(cut.qualifiedAuthorization).toBe(false)
    } finally {
      gate.resume()
    }
    await expect(pending).rejects.toThrow('PI_CANCELLATION_SCOPE_CLOSED')
    expect(await f.coordinator.readEvidence('mutation:one')).toEqual(cut)
    expect(
      f.database.prepare('SELECT * FROM pi_cancel_proto_epochs ORDER BY owner_key').all()
    ).toEqual(epochs)
    expect(
      f.database
        .prepare('SELECT body FROM pi_cancel_proto_owners')
        .all()
        .map(({ body }) => JSON.parse(body))
    ).toEqual([original])
    expect(f.calls).toHaveLength(0)
    expect(
      (await f.coordinator.beginMutation(mutation('unaffected', ['scope:unaffected']))).owners
    ).toHaveLength(0)
    expect(
      f.database.prepare('SELECT * FROM pi_cancel_proto_epochs ORDER BY owner_key').all()
    ).toEqual(epochs)
  })
}

for (const operation of ['register', 'unregister']) {
  test(`${operation} captures caller identity, nested generation and scopes before the generation await`, async () => {
    const f = fixture()
    const original = structuredClone(owner())
    const alias = owner({
      ownerId: 'owner:alias',
      processClaimId: 'process:alias',
      scopes: ['scope:alias'],
    })
    if (operation === 'unregister') {
      await f.coordinator.register(original)
      await f.coordinator.register(alias)
    }
    const input = structuredClone(original)
    const gate = pausedGenerationAuthority()
    const suspended = f.connect(f.native, gate.authority).coordinator
    const pending =
      operation === 'register' ? suspended.register(input) : suspended.unregister(input)
    await gate.reading
    input.ownerId = alias.ownerId
    input.processClaimId = alias.processClaimId
    input.ownerEpoch = 99
    input.generation.lineageId = 'lineage:forged'
    input.generation.restoreGeneration = 'G:forged'
    input.generation.revision = 99
    input.scopes.splice(0, input.scopes.length, 'scope:alias')
    gate.resume()
    await pending
    const retained = f.database
      .prepare('SELECT body FROM pi_cancel_proto_owners ORDER BY owner_id')
      .all()
      .map(({ body }) => JSON.parse(body))
    expect(retained).toEqual(operation === 'register' ? [original] : [alias])
    expect(f.database.prepare('SELECT * FROM pi_cancel_proto_epochs').all()).toEqual([])
    expect(f.database.prepare('SELECT * FROM pi_cancel_proto_fences').all()).toEqual([])
    expect(f.calls).toHaveLength(0)
    const cut = await f.coordinator.beginMutation(mutation())
    expect(cut.owners.map(({ owner: retainedOwner }) => retainedOwner)).toEqual(
      operation === 'register' ? [original] : []
    )
    expect(cut.qualifiedAuthorization).toBe(false)
    expect(f.calls).toHaveLength(0)
  })
}
