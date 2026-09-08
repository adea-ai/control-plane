import { describe, expect, test } from 'bun:test'
import { setTimeout as delay } from 'node:timers/promises'
import { executionConstraintFixtures } from '@control-plane/domain'
import {
  DirectLocalRuntimeTransport,
  runRuntimeAdapterConformance,
} from '@control-plane/runtime-sdk'
import { AcpAdapter, AcpDriver, ReferenceAcpTransport } from './index.ts'

const now = '2026-08-25T12:00:00.000Z'
const digest = (character) => `sha256:${character.repeat(64)}`
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'

function plan() {
  return {
    schemaVersion: 1,
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: digest('a'),
    profile: {
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      version: 3,
      revision: 2,
      schemaVersion: 1,
      contentDigest: digest('b'),
    },
    skills: [],
    contextPackage: {
      contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
      contentDigest: digest('d'),
      schemaVersion: 1,
      compilerVersion: '1.0.0',
    },
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
      { capability: 'execution.cancel', necessity: 'required', minimumSupport: 'supported' },
    ],
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    policySnapshot: globalThis.structuredClone(executionConstraintFixtures.write.policySnapshot),
    outputContract: { contractRef: 'contract://execution-result/v1' },
  }
}

function fixture(options = {}) {
  const transport = new ReferenceAcpTransport({ now: () => now, ...options })
  const nativeSessions = new Map()
  const adapter = new AcpAdapter({
    transport: new DirectLocalRuntimeTransport(
      new AcpDriver({
        transport,
        adapterVersion: '1.0.0',
        externalSessionId: (nativeSessionId) => {
          if (!nativeSessions.has(nativeSessionId)) {
            nativeSessions.set(nativeSessionId, 'ses_01JABCDEF0123456789ABCDEFG')
          }
          return nativeSessions.get(nativeSessionId)
        },
        interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
        now: () => new Date(now),
      })
    ),
  })
  return { adapter, transport }
}

describe('ACP RuntimeAdapter', () => {
  test.each(['approve', 'deny'])(
    'preserves opaque native permission option IDs for %s',
    async (decision) => {
      const { adapter, transport } = fixture({ scenario: 'running' })
      const originalUpdates = transport.updates.bind(transport)
      transport.updates = async function* (...args) {
        for await (const update of originalUpdates(...args)) {
          yield update.sessionUpdate === 'request_permission'
            ? {
                ...update,
                options: update.options.map((option) => ({
                  ...option,
                  optionId: `opaque-${option.kind}-42`,
                })),
              }
            : update
        }
      }
      const handle = await adapter.start({
        attemptId,
        idempotencyKey: `opaque:${decision}`,
        executionPlan: plan(),
      })
      for await (const event of adapter.progress(handle)) {
        if (event.type === 'interaction') break
      }
      await adapter.submitApproval(handle, {
        interactionId: 'int_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: `opaque-response:${decision}`,
        decision,
      })
      expect(transport.responses()).toEqual([
        {
          requestId: 40,
          result: {
            outcome: {
              outcome: 'selected',
              optionId: `opaque-${decision === 'approve' ? 'allow_once' : 'reject'}-42`,
            },
          },
        },
      ])
    }
  )

  test('negotiates ACP v2 capabilities without fabricating optional behavior', async () => {
    const { adapter, transport } = fixture()
    const inspection = await adapter.inspect([
      { capability: 'stream.output', necessity: 'required' },
      { capability: 'session.history', necessity: 'optional', minimumSupport: 'degraded' },
      { capability: 'session.load', necessity: 'required', minimumSupport: 'degraded' },
    ])

    expect(inspection).toMatchObject({
      health: 'healthy',
      metadata: {
        adapterName: 'acp',
        runtimeFamily: 'acp',
        harnessVersion: '2.4.0',
        transportKind: 'direct-local',
      },
      capabilityEvaluation: {
        eligible: false,
        missingRequired: ['session.load'],
        missingOptional: ['session.history'],
      },
    })
    expect(inspection.capabilities.map(({ name }) => name)).toEqual([
      'execution.cancel',
      'interaction.approval',
      'session.close',
      'session.create',
      'session.list',
      'session.resume',
      'stream.events',
      'stream.output',
      'tool.call',
    ])
    expect(transport.calls()[0]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: 2, capabilities: {} },
    })
  })

  test('executes and normalizes ACP updates while leaving native auth and configuration alone', async () => {
    const { adapter, transport } = fixture({ scenario: 'complete' })
    const handle = await adapter.start({
      attemptId,
      idempotencyKey: 'acp:start',
      executionPlan: plan(),
    })
    const progress = []
    for await (const event of adapter.progress(handle)) progress.push(event)

    expect(handle).toMatchObject({
      handleId: `acp:${attemptId}`,
      externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    })
    expect(progress.map(({ type }) => type)).toEqual([
      'status',
      'output',
      'interaction',
      'usage',
      'artifact',
      'status',
    ])
    expect(await adapter.status(handle)).toMatchObject({
      state: 'completed',
      result: {
        output: { text: 'ACP complete' },
        artifacts: [{ locator: 'artifact://acp/result' }],
      },
    })
    expect(transport.calls().map(({ method }) => method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ])
    expect(transport.calls()[1].params).toEqual({})
    expect(JSON.stringify(transport.calls())).not.toMatch(
      /auth\/login|auth\/logout|config|mcpServers|cwd|\/Users\/|credential|apiKey|accessToken/
    )
  })

  test('maps permission decisions and cancellation to ACP operations', async () => {
    const { adapter, transport } = fixture({ scenario: 'running' })
    const handle = await adapter.start({
      attemptId,
      idempotencyKey: 'acp:controls',
      executionPlan: plan(),
    })
    for await (const event of adapter.progress(handle)) {
      if (event.type === 'interaction') break
    }
    await adapter.submitApproval(handle, {
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'acp:approval',
      decision: 'approve',
    })
    expect(
      await adapter.cancel(handle, { idempotencyKey: 'acp:cancel', requestedAt: now })
    ).toMatchObject({ state: 'cancelled' })

    expect(transport.responses()).toEqual([
      { requestId: 40, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
    ])
    expect(transport.calls().at(-1)).toMatchObject({
      method: 'session/cancel',
      params: { sessionId: 'native-session-1' },
    })
  })

  test('passes shared RuntimeAdapter conformance with ACP-native state retained behind the edge', async () => {
    const { adapter, transport } = fixture({ scenario: 'running' })
    const report = await runRuntimeAdapterConformance({
      adapter,
      executionPlan: plan(),
      attemptId,
      complete: async (handle) => {
        transport.completeAttempt(handle.attemptId)
        return adapter.status(handle)
      },
    })

    expect(report.passed).toBeTrue()
    expect(transport.effectCount(attemptId)).toBe(1)
  })

  test('fails closed on protocol mismatch and reports disconnect without changing native state', async () => {
    const mismatch = fixture({ protocolVersion: 1 })
    expect(await mismatch.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['ACP_PROTOCOL_VERSION_UNSUPPORTED:1']),
      capabilityEvaluation: { eligible: false },
    })
    await expect(
      mismatch.adapter.start({
        attemptId,
        idempotencyKey: 'acp:mismatch',
        executionPlan: plan(),
      })
    ).rejects.toMatchObject({ code: 'ACP_RUNTIME_INELIGIBLE' })

    const disconnected = fixture({ scenario: 'running' })
    const handle = await disconnected.adapter.start({
      attemptId,
      idempotencyKey: 'acp:disconnect',
      executionPlan: plan(),
    })
    disconnected.transport.disconnect()
    expect(await disconnected.adapter.inspect()).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['ACP_DISCONNECTED']),
    })
    expect(await disconnected.adapter.reconcile(handle)).toMatchObject({ state: 'unknown' })
  })

  test('normalizes ACP timeout without inventing an automatic retry', async () => {
    const { adapter, transport } = fixture({ scenario: 'timeout' })
    const handle = await adapter.start({
      attemptId,
      idempotencyKey: 'acp:timeout',
      executionPlan: plan(),
    })

    expect(await adapter.status(handle)).toMatchObject({
      state: 'timed_out',
      error: { code: 'ACP_PROMPT_TIMED_OUT', classification: 'timeout', retryable: true },
    })
    expect(transport.effectCount(attemptId)).toBe(1)
  })

  test('bounds transport waits and cleans failed starts without masking the original error', async () => {
    const transport = new HangingAcpTransport()
    const driver = directDriver(transport, { requestTimeoutMs: 10 })

    await expect(
      driver.start({ attemptId, idempotencyKey: 'acp:hanging-prompt', executionPlan: plan() })
    ).rejects.toMatchObject({ code: 'ACP_REQUEST_TIMEOUT', classification: 'timeout' })
    expect(transport.closeCount).toBe(1)
    expect(transport.cleanupCount).toBe(1)
    expect(transport.activeSessionCount).toBe(0)

    transport.failCleanup = true
    await expect(
      driver.start({ attemptId, idempotencyKey: 'acp:hanging-prompt-retry', executionPlan: plan() })
    ).rejects.toMatchObject({ code: 'ACP_REQUEST_TIMEOUT', classification: 'timeout' })
    expect(transport.closeCount).toBe(2)
    expect(transport.cleanupCount).toBe(2)
  })

  test('applies the same deadline to snapshot transport calls', async () => {
    const transport = new HangingSnapshotTransport({ scenario: 'complete' })
    const driver = directDriver(transport, { requestTimeoutMs: 10 })
    const handle = await driver.start({
      attemptId,
      idempotencyKey: 'acp:hanging-snapshot',
      executionPlan: plan(),
    })

    await expect(driver.status(handle)).rejects.toMatchObject({
      code: 'ACP_REQUEST_TIMEOUT',
      classification: 'timeout',
    })
  })

  test('cleans the native session when post-create identity mapping fails', async () => {
    const transport = new HangingAcpTransport()
    transport.hangPrompt = false
    const driver = directDriver(transport, { externalSessionId: () => 'invalid-session-id' })

    await expect(
      driver.start({ attemptId, idempotencyKey: 'acp:invalid-session-id', executionPlan: plan() })
    ).rejects.toThrow()
    expect(transport.closeCount).toBe(1)
    expect(transport.cleanupCount).toBe(1)
    expect(transport.activeSessionCount).toBe(0)
  })

  test('times out and cleans transports that ignore abort signals', async () => {
    const transport = new HangingAcpTransport()
    transport.ignoreAbort = true
    const driver = directDriver(transport, { requestTimeoutMs: 10 })

    await expect(
      driver.start({ attemptId, idempotencyKey: 'acp:ignored-abort', executionPlan: plan() })
    ).rejects.toMatchObject({ code: 'ACP_REQUEST_TIMEOUT', classification: 'timeout' })
    expect(transport.closeCount).toBe(1)
    expect(transport.cleanupCount).toBe(1)
    expect(transport.activeSessionCount).toBe(0)
  })

  test('reclaims a session identified by a late session/new response', async () => {
    const transport = new HangingAcpTransport()
    transport.delayNewMs = 25
    const driver = directDriver(transport, { requestTimeoutMs: 10 })

    await expect(
      driver.start({ attemptId, idempotencyKey: 'acp:late-new', executionPlan: plan() })
    ).rejects.toMatchObject({ code: 'ACP_REQUEST_TIMEOUT', classification: 'timeout' })
    await delay(40)
    expect(transport.closeCount).toBe(1)
    expect(transport.cleanupCount).toBe(1)
    expect(transport.activeSessionCount).toBe(0)
  })

  test('cleans an identifiable session/new response that fails strict validation', async () => {
    const transport = new HangingAcpTransport()
    transport.extraNewField = true
    const driver = directDriver(transport)

    await expect(
      driver.start({ attemptId, idempotencyKey: 'acp:invalid-new', executionPlan: plan() })
    ).rejects.toThrow()
    expect(transport.closeCount).toBe(1)
    expect(transport.cleanupCount).toBe(1)
    expect(transport.activeSessionCount).toBe(0)
  })

  test('coalesces concurrent starts with the same idempotency key', async () => {
    const transport = new HangingAcpTransport()
    transport.hangPrompt = false
    const driver = directDriver(transport)
    const request = { attemptId, idempotencyKey: 'acp:concurrent', executionPlan: plan() }

    const [first, second] = await Promise.all([driver.start(request), driver.start(request)])

    expect(second).toEqual(first)
    expect(transport.newCount).toBe(1)
    expect(transport.activeSessionCount).toBe(1)
  })

  test('reconciles rejection after create side effects before allowing retry', async () => {
    const transport = new HangingAcpTransport()
    transport.rejectFirstNewOnAbort = true
    const driver = directDriver(transport, { requestTimeoutMs: 10 })
    const request = { attemptId, idempotencyKey: 'acp:rejected-new', executionPlan: plan() }

    await expect(driver.start(request)).rejects.toMatchObject({
      code: 'ACP_REQUEST_TIMEOUT',
      classification: 'timeout',
    })
    transport.hangPrompt = false
    const handle = await driver.start(request)

    expect(handle.attemptId).toBe(attemptId)
    expect(transport.cleanupCount).toBe(1)
    expect(transport.activeSessionCount).toBe(1)
  })

  test('rejects concurrent reuse of an attempt ID under a different idempotency key', async () => {
    const transport = new HangingAcpTransport()
    transport.hangPrompt = false
    transport.delayNewMs = 20
    const driver = directDriver(transport)
    const first = driver.start({
      attemptId,
      idempotencyKey: 'acp:attempt-owner',
      executionPlan: plan(),
    })

    await expect(
      driver.start({
        attemptId,
        idempotencyKey: 'acp:attempt-conflict',
        executionPlan: plan(),
      })
    ).rejects.toMatchObject({ code: 'ACP_ATTEMPT_ID_CONFLICT', classification: 'conflict' })
    await first
    expect(transport.newCount).toBe(1)
  })

  test('reconciles create side effects even when the original promise ignores abort', async () => {
    const transport = new HangingAcpTransport()
    transport.ignoreFirstNewAbort = true
    const driver = directDriver(transport, { requestTimeoutMs: 10 })
    const request = { attemptId, idempotencyKey: 'acp:ignored-new-abort', executionPlan: plan() }

    await expect(driver.start(request)).rejects.toMatchObject({
      code: 'ACP_REQUEST_TIMEOUT',
      classification: 'timeout',
    })
    transport.hangPrompt = false
    const handle = await driver.start(request)

    expect(handle.attemptId).toBe(attemptId)
    expect(transport.closeCount).toBe(1)
    expect(transport.activeSessionCount).toBe(1)
  })

  test('blocks retry when failed-start remote close cannot be confirmed', async () => {
    const transport = new HangingAcpTransport()
    transport.failClose = true
    transport.cleanupReclaims = false
    const driver = directDriver(transport, { requestTimeoutMs: 10 })
    const request = { attemptId, idempotencyKey: 'acp:uncertain-close', executionPlan: plan() }

    await expect(driver.start(request)).rejects.toMatchObject({
      code: 'ACP_REQUEST_TIMEOUT',
      classification: 'timeout',
    })
    await expect(driver.start(request)).rejects.toMatchObject({
      code: 'ACP_START_OUTCOME_UNKNOWN',
      classification: 'conflict',
    })
    expect(transport.activeSessionCount).toBe(1)
    expect(transport.newCount).toBe(1)
  })

  test('reconciles and coalesces explicit session creation', async () => {
    const transport = new HangingAcpTransport()
    transport.delayNewMs = 25
    const driver = directDriver(transport, { requestTimeoutMs: 10 })
    const operation = { operation: 'create', idempotencyKey: 'acp:session-create' }

    await expect(driver.session(operation)).rejects.toMatchObject({
      code: 'ACP_REQUEST_TIMEOUT',
      classification: 'timeout',
    })
    await delay(30)
    transport.delayNewMs = 0
    const [first, second] = await Promise.all([
      driver.session(operation),
      driver.session(operation),
    ])

    expect(second).toEqual(first)
    expect(transport.closeCount).toBe(1)
    expect(transport.newCount).toBe(2)
    expect(transport.activeSessionCount).toBe(1)
  })

  test('reconciles a synchronous create throw after its side effect', async () => {
    const transport = new SynchronousThrowCreateTransport()
    const driver = directDriver(transport, { requestTimeoutMs: 10 })
    const request = { attemptId, idempotencyKey: 'acp:sync-create-throw', executionPlan: plan() }

    await expect(driver.start(request)).rejects.toThrow('SYNC_CREATE_FAILURE')
    const handle = await driver.start(request)

    expect(handle.attemptId).toBe(attemptId)
    expect(transport.closeCount).toBe(1)
    expect(transport.activeSessionCount).toBe(1)
  })

  test('coalesces concurrent public cleanup calls exactly once', async () => {
    const transport = new HangingAcpTransport()
    transport.hangPrompt = false
    const driver = directDriver(transport)
    const handle = await driver.start({
      attemptId,
      idempotencyKey: 'acp:cleanup-once',
      executionPlan: plan(),
    })

    await Promise.all([driver.cleanup(handle), driver.cleanup(handle)])

    expect(transport.cleanupCount).toBe(1)
  })
})

function directDriver(transport, options = {}) {
  return new AcpDriver({
    transport,
    adapterVersion: '1.0.0',
    externalSessionId: () => 'ses_01JABCDEF0123456789ABCDEFG',
    interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
    now: () => new Date(now),
    ...options,
  })
}

class HangingAcpTransport extends ReferenceAcpTransport {
  activeSessions = new Set()
  closeCount = 0
  cleanupCount = 0
  failCleanup = false
  hangPrompt = true
  ignoreAbort = false
  delayNewMs = 0
  extraNewField = false
  newCount = 0
  rejectFirstNewOnAbort = false
  ignoreFirstNewAbort = false
  failClose = false
  cleanupReclaims = true
  createdSessions = new Map()

  get activeSessionCount() {
    return this.activeSessions.size
  }

  async createSession(createToken, signal) {
    const existing = this.createdSessions.get(createToken)
    if (existing) return { sessionId: existing }
    const result = await super.request('session/new', {}, signal)
    this.newCount += 1
    this.activeSessions.add(result.sessionId)
    this.createdSessions.set(createToken, result.sessionId)
    if (this.rejectFirstNewOnAbort && this.newCount === 1) {
      await waitForAbort(signal)
    }
    if (this.ignoreFirstNewAbort && this.newCount === 1) {
      return new Promise(() => {})
    }
    if (this.delayNewMs > 0) {
      await delay(this.delayNewMs)
    }
    if (this.extraNewField) return { ...result, unexpected: true }
    return result
  }

  async request(method, params, signal) {
    if (method === 'session/prompt' && this.hangPrompt) {
      if (this.ignoreAbort) return new Promise(() => {})
      return waitForAbort(signal)
    }
    if (method === 'session/close' && this.failClose) {
      this.closeCount += 1
      throw new Error('SIMULATED_CLOSE_FAILURE')
    }
    const result = await super.request(method, params, signal)
    if (method === 'session/close') {
      this.closeCount += 1
      this.activeSessions.delete(params.sessionId)
    }
    return result
  }

  async cleanup(nativeSessionId, signal) {
    this.cleanupCount += 1
    if (this.cleanupReclaims) this.activeSessions.delete(nativeSessionId)
    if (!signal) throw new Error('MISSING_ABORT_SIGNAL')
    if (this.failCleanup) throw new Error('SIMULATED_CLEANUP_FAILURE')
  }
}

class HangingSnapshotTransport extends ReferenceAcpTransport {
  async snapshot(_nativeSessionId, signal) {
    return waitForAbort(signal)
  }
}

class SynchronousThrowCreateTransport extends ReferenceAcpTransport {
  activeSessions = new Set()
  createdSessions = new Map()
  closeCount = 0
  throwFirst = true

  get activeSessionCount() {
    return this.activeSessions.size
  }

  createSession(createToken) {
    const existing = this.createdSessions.get(createToken)
    if (existing) return Promise.resolve({ sessionId: existing })
    const sessionId = 'native-session-1'
    this.createdSessions.set(createToken, sessionId)
    this.activeSessions.add(sessionId)
    if (this.throwFirst) {
      this.throwFirst = false
      throw new Error('SYNC_CREATE_FAILURE')
    }
    return Promise.resolve({ sessionId })
  }

  async request(method, params, signal) {
    if (method === 'session/close') {
      this.closeCount += 1
      this.activeSessions.delete(params.sessionId)
      return {}
    }
    return super.request(method, params, signal)
  }
}

function waitForAbort(signal) {
  if (!signal) throw new Error('MISSING_ABORT_SIGNAL')
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true })
  })
}
