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

const now = '2026-09-12T12:00:00.000Z'

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
