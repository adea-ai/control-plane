import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextCommandSemanticHash } from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteContextNodeInboxRepository,
} from '@control-plane/sqlite-persistence'
import { ContextNodeHandler } from './context-node-handler.ts'
import { ContextNodeChannel } from './context-node-channel.ts'
import { ContextHttpProviderDriver } from './context-http-driver.ts'
import { createContextBundle } from '@control-plane/cortana-context-adapter'

const now = '2026-09-12T12:00:00.000Z'

async function socketDeadline(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SOCKET_TEST_DEADLINE')), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('node WebSocket bridge ACKs durable acceptance and replays a lost result without another read', () =>
  fixture(async (options, input, reopen) => {
    let calls = 0,
      peer,
      firstDone,
      resultReceived
    const first = new Promise((resolve) => {
      firstDone = resolve
    })
    const result = new Promise((resolve) => {
      resultReceived = resolve
    })
    const frames = []
    options.driver.execute = async () => {
      calls++
      return { status: 'succeeded', result: { evidence: 'socket result' } }
    }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, server) =>
        server.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 }),
      websocket: {
        open: (socket) => {
          peer = socket
        },
        message: (_, value) => {
          const frame = JSON.parse(String(value))
          frames.push(frame)
          if (frame.type === 'result') resultReceived(frame)
        },
      },
    })
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/node`)
    try {
      await socketDeadline(
        new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
      )
      let loseResult = true,
        sequence = 2,
        active = true
      const bridge = new ContextNodeChannel({
        handler: new ContextNodeHandler(options),
        now: options.now,
        assertCurrent: async () => {
          if (!active) throw new Error('REPLACED')
        },
        nextSequence: async () => sequence++,
        send: async (serialized) => {
          const frame = JSON.parse(serialized)
          if (frame.type === 'ack')
            expect(
              (await options.repository.get(input.workspaceId, input.nodeId, input.commandId))
                .status
            ).not.toBeUndefined()
          if (frame.type === 'result' && loseResult) {
            loseResult = false
            throw new Error('LOST_RESULT')
          }
          socket.send(serialized)
        },
      })
      const operations = []
      socket.addEventListener('message', (event) => {
        const operation = bridge.receive(String(event.data)).then(
          () => firstDone(),
          (error) => {
            firstDone(error.message)
          }
        )
        operations.push(operation)
      })
      peer.send(JSON.stringify(input))
      expect(await socketDeadline(first)).toBe('LOST_RESULT')
      await reopen()
      peer.send(JSON.stringify(input))
      const delivered = await socketDeadline(result)
      await Promise.all(operations)
      expect(delivered.result.data).toEqual({ evidence: 'socket result' })
      expect(frames.map((frame) => frame.type)).toEqual(['ack', 'ack', 'result'])
      expect(frames[1].disposition).toBe('replayed')
      expect(calls).toBe(1)
      active = false
      await expect(bridge.receive(JSON.stringify(input))).rejects.toThrow('REPLACED')
      expect(calls).toBe(1)
    } finally {
      socket.close()
      await server.stop(true)
    }
  }))

test('node handler uses a bound HTTP provider and replays its durable bundle after restart', () =>
  fixture(async (options, input, reopen) => {
    const at = new Date().toISOString()
    input = {
      ...input,
      issuedAt: at,
      sentAt: at,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      payload: {
        version: 1,
        parameters: {
          ...input.payload.parameters,
          mappedProjectRef: 'project:bound',
          capability: 'evidenceSearch',
          maximumTokens: 100,
          maximumAgeSeconds: 60,
          includeEvidence: true,
          includeMemory: false,
        },
      },
    }
    input.payloadHash = contextCommandSemanticHash(input)
    options.now = () => new Date()
    options.timeoutMs = 1000
    let calls = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (incoming) => {
        const request = await incoming.json()
        expect(request.mappedProjectRef).toBe('project:bound')
        expect(request.operationId).toBe(input.payload.parameters.operationId)
        calls++
        return Response.json(
          createContextBundle({
            contractVersion: '1.0.0',
            bundleId: 'http-node-bundle',
            scopeDigest: request.scopeDigest,
            corpusRevision: 'corpus-1',
            retrievalVersion: 'retrieval-1',
            createdAt: new Date().toISOString(),
            tokenCount: 0,
            degraded: false,
            omittedCount: 0,
            evidence: [],
            memories: [],
          })
        )
      },
    })
    try {
      options.driver = new ContextHttpProviderDriver({
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        providerRef: input.providerRef,
        mappedProjectRef: 'project:bound',
        http: { endpoint: `http://127.0.0.1:${server.port}/read`, allowLoopbackHttp: true },
        validation: { expectedCorpusRevision: 'corpus-1' },
      })
      expect((await new ContextNodeHandler(options).execute(input)).result.bundleId).toBe(
        'http-node-bundle'
      )
      await reopen()
      expect((await new ContextNodeHandler(options).execute(input)).result.bundleId).toBe(
        'http-node-bundle'
      )
      expect(calls).toBe(1)
      const stored = await options.repository.get(input.workspaceId, input.nodeId, input.commandId)
      expect(await options.driver.reconcile(stored.command, new AbortController().signal)).toEqual({
        status: 'unknown',
      })
      expect(calls).toBe(1)
      const changed = structuredClone(input)
      changed.payload.parameters.mappedProjectRef = 'project:other'
      changed.payloadHash = contextCommandSemanticHash(changed)
      const wrong = {
        ...stored.command,
        payloadHash: changed.payloadHash,
        commandEnvelope: changed,
      }
      await expect(options.driver.execute(wrong, new AbortController().signal)).rejects.toThrow(
        'BINDING_MISMATCH'
      )
      expect(calls).toBe(1)
    } finally {
      await server.stop(true)
    }
  }))

test('concurrent node redelivery does not execute an admitted provider twice', () =>
  fixture(async (options, input) => {
    options.timeoutMs = 1000
    let release,
      entered,
      calls = 0
    const started = new Promise((resolve) => {
      entered = resolve
    })
    options.driver.execute = async () => {
      calls++
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    }
    const handler = new ContextNodeHandler(options)
    const first = handler.execute(input)
    try {
      await started
      expect((await handler.execute(input)).status).toBe('executing')
    } finally {
      release({ status: 'succeeded', result: { evidence: 'one call' } })
    }
    expect((await first).status).toBe('succeeded')
    expect(calls).toBe(1)
  }))

test('authorization timeout cannot reserve work and revocation cannot disclose completed output', () =>
  fixture(async (options, input) => {
    const handler = new ContextNodeHandler(options)
    options.authorize = () => new Promise(() => {})
    await expect(handler.execute(input)).rejects.toThrow('CONTEXT_NODE_TIMEOUT')
    expect(
      await options.repository.get(input.workspaceId, input.nodeId, input.commandId)
    ).toBeUndefined()
    let revoked = false
    options.authorize = async () => {
      if (revoked) throw new Error('REVOKED')
    }
    options.driver.execute = async () => {
      revoked = true
      return { status: 'succeeded', result: { private: 'result' } }
    }
    await expect(handler.execute(input)).rejects.toThrow('REVOKED')
    const stored = await options.repository.get(input.workspaceId, input.nodeId, input.commandId)
    expect(stored.status).toBe('reconciliation_required')
    expect(stored.result).toBeUndefined()
  }))

function command() {
  const value = {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    channelGeneration: 1,
    sequence: 1,
    sentAt: now,
    issuedAt: now,
    expiresAt: '2026-09-12T12:01:00.000Z',
    idempotencyKey: 'context-node:read-test',
    providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    authorizationRef: 'authz:node-read-test',
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    requiredCapabilities: ['context.read'],
    payload: {
      version: 1,
      parameters: {
        operationId: 'context-node:read-test',
        principalRef: 'service:test',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        objective: 'Read bounded evidence',
      },
    },
  }
  return { ...value, payloadHash: contextCommandSemanticHash(value) }
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-node-handler-'))
  const path = join(directory, 'inbox.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const input = command()
    const options = {
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      repository: new SqliteContextNodeInboxRepository(provider),
      now: () => new Date(now),
      timeoutMs: 20,
      authorize: async () => {},
      driver: {
        execute: async () => ({ status: 'succeeded', result: { evidence: 'bounded' } }),
        reconcile: async () => ({ status: 'unknown' }),
      },
    }
    await run(options, input, async () => {
      provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      options.repository = new SqliteContextNodeInboxRepository(provider)
    })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('node handler authorizes before admission and replays SQLite results without provider work', () =>
  fixture(async (options, input, reopen) => {
    const handler = new ContextNodeHandler(options)
    options.authorize = async () => {
      throw new Error('DENIED')
    }
    await expect(handler.execute(input)).rejects.toThrow('DENIED')
    expect(
      await options.repository.get(input.workspaceId, input.nodeId, input.commandId)
    ).toBeUndefined()
    options.authorize = async () => {}
    let calls = 0
    options.driver.execute = async () => {
      calls++
      expect(
        (await options.repository.get(input.workspaceId, input.nodeId, input.commandId)).status
      ).toBe('executing')
      return { status: 'succeeded', result: { evidence: 'bounded' } }
    }
    expect((await handler.execute(input)).status).toBe('succeeded')
    await reopen()
    expect((await new ContextNodeHandler(options).execute(input)).result).toEqual({
      evidence: 'bounded',
    })
    expect(calls).toBe(1)
    options.authorize = async () => {
      throw new Error('REVOKED')
    }
    await expect(handler.execute(input)).rejects.toThrow('REVOKED')
  }))

test('timed-out provider execution survives restart and reconciles without another execute', () =>
  fixture(async (options, input, reopen) => {
    let calls = 0,
      signal
    options.driver.execute = async (_, incomingSignal) => {
      calls++
      signal = incomingSignal
      return new Promise(() => {})
    }
    expect((await new ContextNodeHandler(options).execute(input)).status).toBe(
      'reconciliation_required'
    )
    expect(signal.aborted).toBe(true)
    await reopen()
    const restarted = new ContextNodeHandler(options)
    input = { ...input, channelGeneration: 2, sequence: 7 }
    options.authorize = async (incoming) => {
      if (incoming.commandEnvelope.channelGeneration !== 2) throw new Error('STALE_CHANNEL')
    }
    expect((await restarted.execute(input)).status).toBe('reconciliation_required')
    expect((await restarted.reconcile(input)).status).toBe('reconciliation_required')
    options.driver.reconcile = async () => ({
      status: 'succeeded',
      result: { evidence: 'recovered' },
    })
    expect((await restarted.reconcile(input)).result).toEqual({ evidence: 'recovered' })
    expect(calls).toBe(1)
  }))
