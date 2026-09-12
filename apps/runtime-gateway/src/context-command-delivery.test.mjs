import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  ContextCommandArtifactStore,
  contextCommandUploadKey,
  contextCommandUploadMetadata,
} from './context-result-store.ts'
import { contextCommandResultDigest } from './context-result-integrity.ts'
import { ContextGatewayReadClient } from './context-read-client.ts'
import {
  SqlitePersistenceProvider,
  SqliteContextCommandRepository,
} from '@control-plane/sqlite-persistence'
import { InMemoryContextCommandRepository, contextCommandSemanticHash } from '@control-plane/domain'
import { ContextCommandDeliveryService } from './context-command-delivery.ts'
import { RuntimeGatewayMessageRouter } from './runtime-message-handler.ts'

function fixture(repository = new InMemoryContextCommandRepository()) {
  let now = '2026-09-12T12:00:00.000Z'
  let active = {
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    gatewayInstanceId: 'gateway-test',
    connectionId: 'connection-test',
    channelGeneration: 1,
    protocolVersion: { major: 1, minor: 5 },
    connectedAt: now,
    lastHeartbeatAt: now,
  }
  const source = structuredClone(active)
  const command = {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: source.protocolVersion,
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: source.nodeId,
    workspaceId: source.workspaceId,
    traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    channelGeneration: 1,
    sequence: 1,
    sentAt: now,
    issuedAt: now,
    expiresAt: '2026-09-12T12:01:00.000Z',
    idempotencyKey: 'context-read:delivery-test',
    providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    authorizationRef: 'authz:delivery-test-policy',
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    requiredCapabilities: ['context.read'],
    payload: {
      version: 1,
      parameters: {
        operationId: 'context-author:delivery-test',
        principalRef: 'service:author',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        objective: 'Read bounded evidence',
      },
    },
  }
  command.payloadHash = contextCommandSemanticHash(command)
  const sent = [],
    stored = []
  const options = {
    repository,
    coordination: { lookup: async () => structuredClone(active) },
    sender: {
      send: async (envelope) => {
        expect((await repository.get(source.workspaceId, command.commandId)).status).toBe(
          'dispatched'
        )
        sent.push(envelope)
      },
    },
    results: {
      persist: async (...args) => {
        stored.push(args)
        return 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      },
    },
    now: () => new Date(now),
  }
  const service = new ContextCommandDeliveryService(options)
  const frame = {
    schemaVersion: 1,
    protocolVersion: source.protocolVersion,
    nodeId: source.nodeId,
    workspaceId: source.workspaceId,
    traceId: command.traceId,
    channelGeneration: 1,
    sequence: 2,
    sentAt: now,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
  }
  return {
    command,
    source,
    repository,
    options,
    service,
    sent,
    stored,
    ack: { ...frame, type: 'ack', disposition: 'accepted' },
    result: {
      ...frame,
      type: 'result',
      status: 'succeeded',
      completedAt: now,
      result: { data: { evidence: 'bounded' } },
    },
    setNow: (value) => {
      now = value
    },
    replace: (value) => {
      active = value
    },
  }
}

function clientFixture() {
  const f = fixture()
  const at = new Date().toISOString()
  f.setNow(at)
  Object.assign(f.command, {
    issuedAt: at,
    sentAt: at,
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  })
  Object.assign(f.command.payload.parameters, {
    mappedProjectRef: 'project:client',
    maximumTokens: 100,
    includeEvidence: true,
    includeMemory: false,
  })
  f.command.payloadHash = contextCommandSemanticHash(f.command)
  Object.assign(f.result, { payloadHash: f.command.payloadHash, completedAt: at, sentAt: at })
  const request = {
    ...f.command.payload.parameters,
    transport: 'runtime_node',
    gatewayCommand: f.command,
    deadline: f.command.expiresAt,
  }
  const options = {
    delivery: f.service,
    coordination: f.options.coordination,
    nextSequence: async () => 1,
    authorize: async () => {},
    artifacts: { read: async () => ({ evidence: 'bounded' }) },
    pollIntervalMs: 10,
  }
  return { f, request, options, client: new ContextGatewayReadClient(options) }
}

test('gateway client rejects mismatched requests before authorization or persistence', async () => {
  const { f, request, options, client } = clientFixture()
  let calls = 0
  options.authorize = async () => {
    calls++
  }
  await expect(
    client.read({ ...request, objective: 'different objective' }, new AbortController().signal)
  ).rejects.toThrow('REQUEST_MISMATCH')
  expect(calls).toBe(0)
  expect(await f.repository.get(f.source.workspaceId, f.command.commandId)).toBeUndefined()
})

test('gateway client bounds an uncooperative authority without admitting a command', async () => {
  const { f, request, options, client } = clientFixture()
  options.authorize = () => new Promise(() => {})
  await expect(
    client.read(
      { ...request, deadline: new Date(Date.now() + 100).toISOString() },
      new AbortController().signal
    )
  ).rejects.toThrow('TIMEOUT')
  expect(await f.repository.get(f.source.workspaceId, f.command.commandId)).toBeUndefined()
})

test('gateway client cancellation before send preserves queued work and never sends later', async () => {
  const { f, request, options, client } = clientFixture()
  const controller = new AbortController()
  options.nextSequence = async () => {
    controller.abort()
    return 1
  }
  await expect(client.read(request, controller.signal)).rejects.toThrow('ABORTED')
  expect(f.sent).toHaveLength(0)
  expect((await f.repository.get(f.source.workspaceId, f.command.commandId)).status).toBe('queued')
})

test('gateway client cancellation after send does not fabricate provider cancellation', async () => {
  const { f, request, client } = clientFixture()
  const controller = new AbortController()
  f.options.sender.send = async () => {
    controller.abort()
  }
  await expect(client.read(request, controller.signal)).rejects.toThrow('ABORTED')
  expect((await f.repository.get(f.source.workspaceId, f.command.commandId)).status).toBe(
    'dispatched'
  )
})

test('gateway client rechecks authorization after Artifact read before disclosing output', async () => {
  const { f, request, options, client } = clientFixture()
  let revoked = false
  options.authorize = async () => {
    if (revoked) throw new Error('private-authority-details')
  }
  f.options.sender.send = async () => {
    await f.service.recordResult(f.source, f.result)
  }
  options.artifacts.read = async () => {
    revoked = true
    return { private: 'do not disclose' }
  }
  await expect(client.read(request, new AbortController().signal)).rejects.toThrow(
    'CONTEXT_GATEWAY_READ_FAILED'
  )
  expect((await f.repository.get(f.source.workspaceId, f.command.commandId)).status).toBe(
    'succeeded'
  )
})

test('context delivery persists first identity before send and recovers a failed send', async () => {
  const f = fixture()
  await f.service.enqueue(f.command)
  const replay = await f.service.enqueue({
    ...f.command,
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW',
  })
  expect(replay.replayed).toBe(true)
  expect(replay.record.commandId).toBe(f.command.commandId)
  const sender = f.options.sender.send
  f.options.sender.send = async () => {
    throw new Error('private transport detail')
  }
  await expect(f.service.deliver(f.source, f.command.commandId, 2)).rejects.toThrow(
    'CONTEXT_COMMAND_SEND_FAILED'
  )
  expect((await f.service.get(f.source.workspaceId, f.command.commandId)).deliveryAttempts).toBe(1)
  f.options.sender.send = sender
  const restarted = new ContextCommandDeliveryService(f.options)
  await expect(restarted.deliver(f.source, f.command.commandId, 2)).rejects.toThrow(
    'CONCURRENT_UPDATE'
  )
  expect((await restarted.deliver(f.source, f.command.commandId, 3)).sent).toBe(true)
  expect(f.sent[0].payloadHash).toBe(f.command.payloadHash)
  expect(f.sent[0]).not.toHaveProperty('executionId')
})

test('context delivery fences stale channels and expires pending work without sending', async () => {
  const f = fixture()
  await f.service.enqueue(f.command)
  await expect(
    f.service.deliver({ ...f.source, connectionId: 'other' }, f.command.commandId, 2)
  ).rejects.toThrow('STALE_CHANNEL')
  expect(f.sent).toHaveLength(0)
  f.setNow(f.command.expiresAt)
  expect((await f.service.deliver(f.source, f.command.commandId, 2)).record.status).toBe('expired')
  expect(f.sent).toHaveLength(0)
  await expect(f.service.enqueue(f.command)).rejects.toThrow('EXPIRED')
})

test('authenticated ACK and result replay is idempotent and changed results conflict', async () => {
  const f = fixture()
  await f.service.enqueue(f.command)
  await f.service.deliver(f.source, f.command.commandId, 2)
  await expect(f.service.acknowledge(f.source, { ...f.ack, sequence: 1 })).rejects.toThrow(
    'STALE_SEQUENCE'
  )
  await expect(
    f.service.acknowledge(f.source, { ...f.ack, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
  ).rejects.toThrow('SCOPE_MISMATCH')
  expect((await f.service.acknowledge(f.source, f.ack)).duplicate).toBe(false)
  expect(
    (await f.service.acknowledge(f.source, { ...f.ack, disposition: 'replayed' })).duplicate
  ).toBe(true)
  const completed = await f.service.recordResult(f.source, f.result)
  expect(completed.record.status).toBe('succeeded')
  expect(completed.record.resultReference).toBe('art_01ARZ3NDEKTSV4RRFFQ69G5FAV')
  expect(f.stored).toHaveLength(1)
  expect((await f.service.recordResult(f.source, { ...f.result, sequence: 3 })).duplicate).toBe(
    true
  )
  const lateAck = await f.service.acknowledge(f.source, f.ack)
  expect(lateAck.duplicate).toBe(true)
  expect(lateAck.record).toEqual(completed.record)
  expect(f.stored).toHaveLength(1)
  await expect(
    f.service.recordResult(f.source, { ...f.result, result: { data: { evidence: 'changed' } } })
  ).rejects.toThrow('RESULT_CONFLICT')
  expect((await f.service.deliver(f.source, f.command.commandId, 4)).sent).toBe(false)
})

test('result storage failure and replacement during persistence cannot settle the command', async () => {
  const f = fixture()
  await f.service.enqueue(f.command)
  await f.service.deliver(f.source, f.command.commandId, 2)
  f.options.results.persist = async () => {
    throw new Error('private storage detail')
  }
  await expect(f.service.recordResult(f.source, f.result)).rejects.toThrow(
    'CONTEXT_COMMAND_RESULT_STORE_FAILED'
  )
  expect((await f.service.get(f.source.workspaceId, f.command.commandId)).status).toBe('dispatched')
  f.options.results.persist = async () => {
    f.replace({ ...f.source, channelGeneration: 2 })
    return 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  }
  await expect(f.service.recordResult(f.source, f.result)).rejects.toThrow('STALE_CHANNEL')
  expect((await f.service.get(f.source.workspaceId, f.command.commandId)).status).toBe('dispatched')
})

test('classified error replay cannot replace a different terminal failure', async () => {
  const f = fixture()
  await f.service.enqueue(f.command)
  await f.service.deliver(f.source, f.command.commandId, 2)
  const { disposition: _disposition, ...common } = f.ack
  const error = { ...common, type: 'error', code: 'PROVIDER_UNAVAILABLE', retryable: true }
  expect((await f.service.recordError(f.source, error)).record.errorCode).toBe(
    'PROVIDER_UNAVAILABLE'
  )
  expect((await f.service.recordError(f.source, error)).duplicate).toBe(true)
  await expect(
    f.service.recordError(f.source, { ...error, code: 'PROVIDER_REVOKED' })
  ).rejects.toThrow('RESULT_CONFLICT')
})

test('router classifies context frames from the durable ledger and preserves runtime routing', async () => {
  const f = fixture()
  await f.service.enqueue(f.command)
  await f.service.deliver(f.source, f.command.commandId, 2)
  const runtime = []
  const events = []
  const router = new RuntimeGatewayMessageRouter({
    context: f.service,
    inventory: { handle: async () => {} },
    delivery: {
      acknowledge: async (frame) => runtime.push(frame),
      recordResult: async () => {},
      recordError: async () => {},
    },
    events: {
      ingestProgress: async (frame) => events.push(frame),
      ingestResult: async (frame) => events.push(frame),
      ingestError: async (frame) => events.push(frame),
    },
  })
  await router.handle(f.source, f.ack)
  await router.handle(f.source, f.result)
  expect((await f.service.get(f.source.workspaceId, f.command.commandId)).status).toBe('succeeded')
  expect(runtime).toHaveLength(0)
  expect(events).toHaveLength(0)
  await router.handle(f.source, { ...f.ack, commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
  expect(runtime).toHaveLength(1)
  await expect(
    router.handle(f.source, { ...f.ack, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
  ).rejects.toThrow('SCOPE_MISMATCH')
})

test('channel replacement during command lookup fences ACK settlement', async () => {
  const f = fixture()
  await f.service.enqueue(f.command)
  await f.service.deliver(f.source, f.command.commandId, 2)
  const get = f.repository.get.bind(f.repository)
  f.repository.get = async (...args) => {
    const record = await get(...args)
    f.replace({ ...f.source, channelGeneration: 2 })
    return record
  }
  await expect(f.service.acknowledge(f.source, f.ack)).rejects.toThrow('STALE_CHANNEL')
  expect((await get(f.source.workspaceId, f.command.commandId)).status).toBe('dispatched')
})

test('context delivery rejects overlong grants, mismatched hashes and oversized results', async () => {
  const f = fixture()
  await expect(
    f.service.enqueue({ ...f.command, expiresAt: '2026-09-13T12:00:01.000Z' })
  ).rejects.toThrow('EXPIRY_TOO_LONG')
  await f.service.enqueue(f.command)
  await f.service.deliver(f.source, f.command.commandId, 2)
  await expect(
    f.service.recordResult(f.source, { ...f.result, payloadHash: `sha256:${'b'.repeat(64)}` })
  ).rejects.toThrow('PAYLOAD_MISMATCH')
  await expect(
    f.service.recordResult(f.source, {
      ...f.result,
      result: { data: { oversized: 'x'.repeat(262144) } },
    })
  ).rejects.toThrow('RESULT_TOO_LARGE')
  expect(f.stored).toHaveLength(0)
})

test('Artifact persistence verifies scoped uploaded bytes and detects semantic tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-artifact-'))
  const objects = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 262144 })
  try {
    const f = fixture()
    await f.service.enqueue(f.command)
    const command = await f.repository.get(f.source.workspaceId, f.command.commandId)
    const body = new TextEncoder().encode('{ "evidence": "uploaded" }\n')
    const artifactId = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const key = contextCommandUploadKey(command, artifactId)
    const metadata = contextCommandUploadMetadata(command)
    const frame = {
      ...f.result,
      result: {
        artifact: {
          artifactId,
          sizeBytes: body.byteLength,
          mediaType: 'application/json',
          digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        },
      },
    }
    const digest = contextCommandResultDigest(frame)
    const store = new ContextCommandArtifactStore(objects)
    await objects.put({
      key,
      body,
      contentType: 'application/json',
      metadata: { ...metadata, 'workspace-id': 'wrong-workspace' },
    })
    await expect(store.persist(command, frame, digest)).rejects.toThrow('SCOPE_MISMATCH')
    await objects.put({ key, body, contentType: 'application/json', metadata })
    const id = await store.persist(command, frame, digest)
    expect(await store.persist(command, frame, digest)).toBe(id)
    f.options.results = store
    await f.service.deliver(f.source, f.command.commandId, 1)
    await f.service.recordResult(f.source, frame)
    const terminal = await f.repository.get(f.source.workspaceId, f.command.commandId)
    expect(await store.read(terminal)).toEqual({ evidence: 'uploaded' })
    const storedKey = `context-results/v1/stored/${command.scope.workspaceId}/${command.nodeId}/${command.commandId}/${id}`
    const stored = await objects.get(storedKey)
    await objects.put({
      key: storedKey,
      body: new TextEncoder().encode('{"evidence":"forged"}'),
      contentType: stored.contentType,
      metadata: stored.metadata,
    })
    await expect(store.read(terminal)).rejects.toThrow('INTEGRITY_FAILURE')
  } finally {
    objects.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('lost Artifact PUT acknowledgement retries verified bytes without another write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-ambiguous-put-'))
  const objects = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 262144 })
  try {
    let writes = 0
    const store = new ContextCommandArtifactStore({
      head: (key) => objects.head(key),
      get: (key) => objects.get(key),
      put: async (input) => {
        writes++
        await objects.put(input)
        throw new Error('ACK_LOST')
      },
    })
    const f = fixture()
    f.options.results = store
    await f.service.enqueue(f.command)
    await f.service.deliver(f.source, f.command.commandId, 1)
    await expect(f.service.recordResult(f.source, f.result)).rejects.toThrow('RESULT_STORE_FAILED')
    expect((await f.repository.get(f.source.workspaceId, f.command.commandId)).status).toBe(
      'dispatched'
    )
    const completed = await f.service.recordResult(f.source, f.result)
    expect(completed.record.status).toBe('succeeded')
    expect(writes).toBe(1)
    expect(await store.read(completed.record)).toEqual({ evidence: 'bounded' })
  } finally {
    objects.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Artifact result limits and invalid uploaded JSON fail before command settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-invalid-upload-'))
  const objects = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 262144 })
  try {
    const f = fixture()
    await f.service.enqueue(f.command)
    const command = await f.repository.get(f.source.workspaceId, f.command.commandId)
    const artifactId = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
    let reads = 0
    const store = new ContextCommandArtifactStore(
      {
        head: (key) => objects.head(key),
        get: (key) => {
          reads++
          return objects.get(key)
        },
        put: (input) => objects.put(input),
      },
      32
    )
    f.options.results = store
    await f.service.deliver(f.source, f.command.commandId, 1)
    for (const body of [
      new Uint8Array(33),
      new TextEncoder().encode('[]'),
      new Uint8Array([255]),
    ]) {
      const frame = {
        ...f.result,
        result: {
          artifact: {
            artifactId,
            sizeBytes: body.byteLength,
            mediaType: 'application/json',
            digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
          },
        },
      }
      await objects.put({
        key: contextCommandUploadKey(command, artifactId),
        body,
        contentType: 'application/json',
        metadata: contextCommandUploadMetadata(command),
      })
      await expect(f.service.recordResult(f.source, frame)).rejects.toThrow('RESULT_STORE_FAILED')
      if (body.byteLength > 32) expect(reads).toBe(0)
    }
    expect((await f.repository.get(f.source.workspaceId, f.command.commandId)).status).toBe(
      'dispatched'
    )
  } finally {
    objects.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite reconnect dispatch and terminal result replay survive database reconstruction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-delivery-'))
  const path = join(directory, 'ledger.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  let objects = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 262144,
  })
  try {
    await provider.migrate()
    const f = fixture(new SqliteContextCommandRepository(provider))
    f.options.results.persist = async (...args) => {
      f.stored.push(args)
      return new ContextCommandArtifactStore(objects).persist(...args)
    }
    await f.service.enqueue(f.command)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    f.options.repository = new SqliteContextCommandRepository(provider)
    // The fixture sender inspected the original repository; replace it after closing that provider.
    f.options.sender.send = async (envelope) => f.sent.push(envelope)
    const restarted = new ContextCommandDeliveryService(f.options)
    const batch = await restarted.redeliverPending(f.source, {
      limit: 1,
      nextSequence: async () => 2,
    })
    expect(batch.records).toHaveLength(1)
    expect(batch.nextAfterCommandId).toBe(f.command.commandId)
    expect(f.sent).toHaveLength(1)
    expect(
      (
        await restarted.redeliverPending(f.source, {
          limit: 1,
          afterCommandId: batch.nextAfterCommandId,
          nextSequence: async () => {
            throw new Error('NO_SEQUENCE_EXPECTED')
          },
        })
      ).records
    ).toEqual([])
    await restarted.recordResult(f.source, f.result)
    objects.close()
    objects = new FilesystemObjectStore({
      rootDirectory: join(directory, 'objects'),
      maxObjectBytes: 262144,
    })
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    f.options.repository = new SqliteContextCommandRepository(provider)
    const terminal = new ContextCommandDeliveryService(f.options)
    expect((await terminal.recordResult(f.source, f.result)).duplicate).toBe(true)
    expect(f.stored).toHaveLength(1)
    expect(
      await new ContextCommandArtifactStore(objects).read(
        await f.options.repository.get(f.source.workspaceId, f.command.commandId)
      )
    ).toEqual({ evidence: 'bounded' })
    expect(
      (
        await terminal.redeliverPending(f.source, {
          limit: 1,
          nextSequence: async () => {
            throw new Error('NO_SEQUENCE_EXPECTED')
          },
        })
      ).records
    ).toEqual([])
  } finally {
    objects.close()
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
