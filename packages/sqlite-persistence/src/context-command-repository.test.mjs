import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createQueuedContextCommandRecord, contextCommandSemanticHash } from '@control-plane/domain'
import { SqlitePersistenceProvider } from './index.ts'
import { SqliteContextCommandRepository } from './context-command-repository.ts'
import { SqliteContextNodeInboxRepository } from './context-node-inbox-repository.ts'
import { SqliteRuntimeChannelSequenceRepository } from './runtime-channel-sequence-repository.ts'
import { createContextNodeInboxRecord } from '@control-plane/domain'
import { ContextCommandGrantAuthority } from '@control-plane/domain'
import { SqliteContextCommandGrantRepository } from './context-command-grant-repository.ts'
import { SqliteContextProviderRegistrationRepository } from './context-provider-registration-repository.ts'
import { createFakeContextProvider } from '@control-plane/context'

const now = '2026-09-12T12:00:00.000Z'

test('operator CLI provisions scoped grants and registrations and preserves revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-admin-'))
  const path = join(directory, 'admin.sqlite')
  const input = join(directory, 'input.json')
  const provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  provider.close()
  const script = fileURLToPath(
    new URL('../../../scripts/context-provider-admin.mjs', import.meta.url)
  )
  const run = () =>
    spawnSync(
      process.execPath,
      [script, '--backend', 'sqlite', '--database', path, '--input', input],
      { encoding: 'utf8', timeout: 15000 }
    )
  const apply = async (request, expected = 0) => {
    await writeFile(input, JSON.stringify(request), { mode: 0o600 })
    const result = run()
    expect(result.status).toBe(expected)
    if (expected === 0)
      expect(JSON.parse(result.stdout)).toEqual({ status: 'applied', operation: request.operation })
    else {
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('CONTEXT_PROVIDER_ADMIN_FAILED\n')
    }
  }
  try {
    const readModel = createFakeContextProvider({
      suffix: 'A',
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      health: 'healthy',
      state: 'active',
      capabilities: { evidenceSearch: true },
      kind: 'evidence',
      tokenCount: 1,
    }).readModel
    const registration = {
      version: 1,
      readModel,
      providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      mappedProjectRef: 'project-1',
      authorizationRef: 'authz:admin-test',
    }
    const grant = {
      authorizationRef: registration.authorizationRef,
      workspaceId: readModel.connection.workspaceId,
      nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      providerRef: registration.providerRef,
      principalRef: readModel.connection.principalRef,
      mappedProjectRef: registration.mappedProjectRef,
      scopeDigest: readModel.connection.scopeDigest,
      capabilities: ['evidenceSearch'],
      maximumTokens: 100,
      includeEvidence: true,
      includeMemory: false,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      status: 'active',
    }
    const register = { operation: 'register', expectedVersion: 0, registration }
    await apply(register, 1)
    await writeFile(input, JSON.stringify(register), { mode: 0o600 })
    const wrongTarget = spawnSync(
      process.execPath,
      [script, '--backend', 'sqlite', '--database', path, '--host', 'unexpected', '--input', input],
      { encoding: 'utf8', timeout: 15000 }
    )
    expect(wrongTarget.status).toBe(1)
    expect(wrongTarget.stdout).toBe('')
    expect(wrongTarget.stderr).toBe('CONTEXT_PROVIDER_ADMIN_FAILED\n')
    await apply({ operation: 'grant', grant })
    await apply({ operation: 'grant', grant })
    await apply({ operation: 'grant', grant: { ...grant, maximumTokens: 200 } }, 1)
    await apply(
      { ...register, registration: { ...registration, mappedProjectRef: 'other-project' } },
      1
    )
    await apply(register)
    await apply(register, 1)
    const revoke = {
      operation: 'revoke',
      workspaceId: grant.workspaceId,
      authorizationRef: grant.authorizationRef,
    }
    await apply(revoke)
    await apply(revoke)
    await apply({ operation: 'grant', grant }, 1)
    await apply(
      { operation: 'register', expectedVersion: 1, registration: { ...registration, version: 2 } },
      1
    )
    const retired = structuredClone(registration)
    retired.version = 2
    retired.readModel.connection.state = 'revoked'
    await apply({ operation: 'register', expectedVersion: 1, registration: retired })
    const reopened = new SqlitePersistenceProvider({ path })
    try {
      await reopened.migrate()
      expect(
        (
          await new SqliteContextCommandGrantRepository(reopened).get(
            grant.workspaceId,
            grant.authorizationRef
          )
        ).status
      ).toBe('revoked')
      expect(
        await new SqliteContextProviderRegistrationRepository(reopened).list({
          workspaceId: grant.workspaceId,
          principalRef: grant.principalRef,
        })
      ).toEqual([])
    } finally {
      reopened.close()
    }
    await writeFile(input, 'secret-canary-not-json')
    expect(run().stderr).toBe('CONTEXT_PROVIDER_ADMIN_FAILED\n')
    await writeFile(input, 'x'.repeat(262145))
    expect(run().status).toBe(1)
    await rm(input)
    await symlink(path, input)
    expect(run().status).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('SQLite provider registry atomically indexes scoped snapshots and retains irreversible revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-provider-registry-'))
  const path = join(directory, 'registry.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const readModel = createFakeContextProvider({
      suffix: 'A',
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      health: 'healthy',
      state: 'active',
      capabilities: { evidenceSearch: true },
      kind: 'evidence',
      tokenCount: 1,
    }).readModel
    const record = {
      version: 1,
      readModel,
      providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      mappedProjectRef: 'project-1',
      authorizationRef: 'authz:registry-test',
      expectedCorpusRevision: 'corpus:1',
      maximumOutputBytes: 262144,
    }
    const scope = {
      workspaceId: readModel.connection.workspaceId,
      principalRef: readModel.connection.principalRef,
    }
    let repository = new SqliteContextProviderRegistrationRepository(provider)
    let writes = 0
    const failing = new SqliteContextProviderRegistrationRepository({
      transaction: (operation) =>
        provider.transaction((tx) =>
          operation({
            ...tx,
            get: tx.get.bind(tx),
            scan: tx.scan.bind(tx),
            put: async (write) => {
              if (++writes === 2) throw new Error('INDEX_FAILURE')
              return tx.put(write)
            },
          })
        ),
    })
    await expect(failing.save(0, record)).rejects.toThrow('INDEX_FAILURE')
    expect(await repository.list(scope)).toEqual([])
    expect(await Promise.all([repository.save(0, record), repository.save(0, record)])).toEqual([
      true,
      false,
    ])
    const refreshed = { ...structuredClone(record), version: 2 }
    refreshed.readModel.health.checkedAt = now
    expect(await repository.save(1, refreshed)).toBe(true)
    expect(await repository.save(1, refreshed)).toBe(false)
    const moved = { ...structuredClone(refreshed), version: 3 }
    moved.readModel.connection.principalRef = 'principal:other'
    expect(await repository.save(2, moved)).toBe(false)
    expect(await repository.save(2, { ...record, version: 3 })).toBe(false)
    expect(await repository.list({ ...scope, principalRef: 'principal:other' })).toEqual([])
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteContextProviderRegistrationRepository(provider)
    expect(await repository.list(scope)).toEqual([refreshed])
    const revoked = { ...structuredClone(refreshed), version: 3 }
    revoked.readModel.connection.state = 'revoked'
    expect(await repository.save(2, revoked)).toBe(true)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteContextProviderRegistrationRepository(provider)
    expect(await repository.list(scope)).toEqual([])
    expect(await repository.save(3, { ...refreshed, version: 4 })).toBe(false)
    expect(await repository.save(0, record)).toBe(false)
    for (let number = 1; number <= 33; number++) {
      const addition = structuredClone(record)
      addition.readModel.connection.connectionId = `ctc_${String(number).padStart(26, '0')}`
      expect(await repository.save(0, addition)).toBe(number <= 32)
    }
    expect(await repository.list(scope)).toHaveLength(32)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite context grants enforce scope and budgets and preserve revocation across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-grants-'))
  const path = join(directory, 'grants.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const envelope = queued().commandEnvelope
    Object.assign(envelope.payload.parameters, {
      mappedProjectRef: 'project-1',
      capability: 'evidenceSearch',
      maximumTokens: 100,
      includeEvidence: true,
      includeMemory: false,
    })
    envelope.payloadHash = contextCommandSemanticHash(envelope)
    const command = createQueuedContextCommandRecord(envelope, now)
    const grant = {
      authorizationRef: envelope.authorizationRef,
      workspaceId: envelope.workspaceId,
      nodeId: envelope.nodeId,
      providerRef: envelope.providerRef,
      principalRef: command.scope.principalRef,
      mappedProjectRef: 'project-1',
      scopeDigest: envelope.payload.parameters.scopeDigest,
      capabilities: ['evidenceSearch'],
      maximumTokens: 100,
      includeEvidence: true,
      includeMemory: false,
      issuedAt: now,
      expiresAt: envelope.expiresAt,
      status: 'active',
    }
    let repository = new SqliteContextCommandGrantRepository(provider)
    let authority = new ContextCommandGrantAuthority(repository, () => new Date(now))
    await expect(authority.authorize(command)).rejects.toThrow('GRANT_DENIED')
    await repository.create(grant)
    await authority.authorize(command)
    await expect(repository.create(grant)).rejects.toThrow('ALREADY_EXISTS')
    for (const change of [
      { mappedProjectRef: 'other' },
      { principalRef: 'service:other' },
      { maximumTokens: 101 },
      { includeMemory: true },
      { capability: 'memoryRecall' },
      { scopeDigest: `sha256:${'b'.repeat(64)}` },
    ]) {
      const altered = structuredClone(envelope)
      Object.assign(altered.payload.parameters, change)
      altered.payloadHash = contextCommandSemanticHash(altered)
      await expect(
        authority.authorize(createQueuedContextCommandRecord(altered, now))
      ).rejects.toThrow('GRANT_DENIED')
    }
    expect(
      await repository.get('wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW', grant.authorizationRef)
    ).toBeUndefined()
    for (const change of [
      { workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      { nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      { providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      { authorizationRef: 'authz:other-context-read' },
    ]) {
      const altered = { ...structuredClone(envelope), ...change }
      altered.payloadHash = contextCommandSemanticHash(altered)
      await expect(
        authority.authorize(createQueuedContextCommandRecord(altered, now))
      ).rejects.toThrow('GRANT_DENIED')
    }
    await expect(
      new ContextCommandGrantAuthority(repository, () => new Date(grant.expiresAt)).authorize(
        command
      )
    ).rejects.toThrow('GRANT_DENIED')
    await Promise.all([
      repository.revoke(grant.workspaceId, grant.authorizationRef),
      repository.revoke(grant.workspaceId, grant.authorizationRef),
    ])
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteContextCommandGrantRepository(provider)
    authority = new ContextCommandGrantAuthority(repository, () => new Date(now))
    expect((await repository.get(grant.workspaceId, grant.authorizationRef)).status).toBe('revoked')
    await expect(authority.authorize(command)).rejects.toThrow('GRANT_DENIED')
    await expect(repository.create(grant)).rejects.toThrow('ALREADY_EXISTS')
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite channel sequence reservations survive concurrency, ambiguous acknowledgement and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-channel-sequence-'))
  const path = join(directory, 'sequences.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const channel = {
      nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      gatewayInstanceId: 'gateway-test',
      connectionId: 'connection-test',
      channelGeneration: 1,
      protocolVersion: { major: 1, minor: 5 },
      connectedAt: now,
      lastHeartbeatAt: now,
    }
    const request = { channel, count: 1, minimum: 1 }
    let repository = new SqliteRuntimeChannelSequenceRepository(provider)
    expect(
      await Promise.all([
        repository.reserve({ ...request, count: 2 }),
        repository.reserve({ ...request, count: 3 }),
        repository.reserve(request),
      ])
    ).toEqual([1, 3, 6])
    const ambiguous = new SqliteRuntimeChannelSequenceRepository({
      transaction: async (operation) => {
        await provider.transaction(operation)
        throw new Error('ACK_LOST_AFTER_COMMIT')
      },
    })
    await expect(ambiguous.reserve(request)).rejects.toThrow('ACK_LOST_AFTER_COMMIT')
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteRuntimeChannelSequenceRepository(provider)
    expect(await repository.reserve(request)).toBe(8)
    expect(await repository.reserve({ ...request, minimum: 100 })).toBe(100)
    expect(await repository.reserve({ ...request, minimum: 2147483647 })).toBe(2147483647)
    await expect(repository.reserve(request)).rejects.toThrow('SEQUENCE_EXHAUSTED')
    expect(
      await repository.reserve({ ...request, channel: { ...channel, channelGeneration: 2 } })
    ).toBe(1)
    await expect(repository.reserve({ ...request, count: 1001 })).rejects.toThrow()
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite node inbox atomically deduplicates and preserves uncertain calls after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-node-inbox-'))
  const path = join(directory, 'inbox.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteContextNodeInboxRepository(provider)
    const record = createContextNodeInboxRecord(queued().commandEnvelope, now)
    let writes = 0
    const failing = new SqliteContextNodeInboxRepository({
      transaction: (operation) =>
        provider.transaction((transaction) =>
          operation({
            get: transaction.get.bind(transaction),
            put: async (input) => {
              if (++writes === 2) throw new Error('INDEX_WRITE_FAILED')
              return transaction.put(input)
            },
          })
        ),
    })
    await expect(failing.accept(record)).rejects.toThrow('INDEX_WRITE_FAILED')
    const { workspaceId } = record.command.scope
    const { nodeId, commandId } = record.command
    expect(await repository.get(workspaceId, nodeId, commandId)).toBeUndefined()
    const race = createContextNodeInboxRecord(
      queued('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW').commandEnvelope,
      now
    )
    expect(
      (await Promise.all([repository.accept(record), repository.accept(race)])).map(
        (entry) => entry.outcome
      )
    ).toEqual(['created', 'duplicate'])
    const executing = { ...record, version: 2, status: 'executing', startedAt: now }
    expect(await repository.compareAndSet(1, executing)).toBe(true)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteContextNodeInboxRepository(provider)
    expect(await repository.get(workspaceId, nodeId, commandId)).toEqual(executing)
    expect(
      await repository.get('wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW', nodeId, commandId)
    ).toBeUndefined()
    expect((await repository.accept(record)).record.status).toBe('executing')
    const uncertain = { ...executing, version: 3, status: 'reconciliation_required' }
    expect(await repository.compareAndSet(2, uncertain)).toBe(true)
    expect(await repository.compareAndSet(3, { ...executing, version: 4 })).toBe(false)
    const completed = {
      ...uncertain,
      version: 4,
      status: 'succeeded',
      terminalAt: now,
      result: { evidence: 'reconciled' },
    }
    expect(await repository.compareAndSet(3, completed)).toBe(true)
    expect((await repository.accept(record)).record).toEqual(completed)
    expect(await repository.compareAndSet(4, { ...completed, version: 5 })).toBe(false)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

function queued(commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV', objective = 'Read evidence') {
  const command = {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    commandId,
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    sequence: 1,
    channelGeneration: 1,
    sentAt: now,
    issuedAt: now,
    expiresAt: '2026-09-12T12:01:00.000Z',
    idempotencyKey: 'context-read:sqlite-0001',
    providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    authorizationRef: 'authz:sqlite-context-read',
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    requiredCapabilities: ['context.read'],
    payload: {
      version: 1,
      parameters: {
        operationId: 'context-author:sqlite-0001',
        principalRef: 'service:author',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        objective,
      },
    },
  }
  return createQueuedContextCommandRecord(
    { ...command, payloadHash: contextCommandSemanticHash(command) },
    now
  )
}

test('SQLite context commands survive reopen with scoped operation deduplication and CAS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-ledger-'))
  const path = join(directory, 'context.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteContextCommandRepository(provider)
    const record = queued()
    for (const failAt of [2, 3]) {
      let writes = 0
      const failing = new SqliteContextCommandRepository({
        transaction: (operation) =>
          provider.transaction((transaction) =>
            operation({
              get: transaction.get.bind(transaction),
              put: async (write) => {
                if (++writes === failAt) throw new Error('INJECTED_OPERATION_INDEX_FAILURE')
                return transaction.put(write)
              },
            })
          ),
      })
      await expect(failing.create(record)).rejects.toThrow('INJECTED_OPERATION_INDEX_FAILURE')
      expect(await repository.get(record.scope.workspaceId, record.commandId)).toBeUndefined()
      expect(await repository.getByOperation(record.scope)).toBeUndefined()
      expect(
        await repository.listPending({
          workspaceId: record.scope.workspaceId,
          nodeId: record.nodeId,
          limit: 1,
        })
      ).toEqual([])
    }
    const racing = queued('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW')
    const results = await Promise.all([repository.create(record), repository.create(racing)])
    expect(results.map((result) => result.outcome)).toEqual(['created', 'duplicate'])
    expect(results[1].record.commandId).toBe(record.commandId)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteContextCommandRepository(provider)
    expect(await repository.getByOperation(record.scope)).toEqual(record)
    const query = { workspaceId: record.scope.workspaceId, nodeId: record.nodeId, limit: 1 }
    expect(await repository.listPending(query)).toEqual([record])
    expect(await repository.listPending({ ...query, afterCommandId: record.commandId })).toEqual([])
    expect(
      await repository.listPending({ ...query, nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
    ).toEqual([])
    expect(
      await repository.listPending({ ...query, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
    ).toEqual([])
    await expect(repository.listPending({ ...query, limit: 129 })).rejects.toThrow()
    expect(await repository.get('wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW', record.commandId)).toBeUndefined()
    expect((await repository.create(queued(record.commandId, 'Changed objective'))).outcome).toBe(
      'conflict'
    )
    const dispatched = {
      ...record,
      status: 'dispatched',
      version: 2,
      deliveryAttempts: 1,
      lastDelivery: { channelGeneration: 2, sequence: 1, at: now },
    }
    expect(await repository.compareAndSet(1, dispatched)).toBe(true)
    expect(await repository.compareAndSet(1, dispatched)).toBe(false)
    expect(await repository.compareAndSet(2, { ...dispatched, version: 4 })).toBe(false)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    expect(
      await new SqliteContextCommandRepository(provider).get(
        record.scope.workspaceId,
        record.commandId
      )
    ).toEqual(dispatched)
    repository = new SqliteContextCommandRepository(provider)
    expect(
      await repository.compareAndSet(2, {
        ...dispatched,
        version: 3,
        status: 'cancelled',
        terminalAt: now,
      })
    ).toBe(true)
    expect(await repository.listPending(query)).toEqual([])
    expect((await repository.getByOperation(record.scope)).status).toBe('cancelled')
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
