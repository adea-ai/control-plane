import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  InMemoryToolRegistryRepository,
  InMemoryToolRateLimiter,
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
} from '@control-plane/tool-execution'
import { InMemoryInteractionRepository, InteractionService } from '@control-plane/domain'
import { PiDurableEffectGate, SqliteDurableEffectGateStore } from './effect-gate.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const expiry = '2026-10-08T10:00:00.000Z'
const request = (changes = {}) => ({
  requestId: id('req'),
  toolCallId: id('tlc'),
  executionId: id('exe'),
  attemptId: id('att'),
  workspaceId: id('wsp'),
  profileId: id('prf'),
  toolDefinitionId: id('tld'),
  toolVersionId: id('tlv'),
  operation: 'write',
  input: { value: 'hello' },
  idempotencyKey: 'effect-admission-1',
  requestedAt: at,
  policySnapshotRef: 'policy://workspace/v1',
  grant: {
    workspaceId: id('wsp'),
    profileId: id('prf'),
    toolDefinitionId: id('tld'),
    toolVersionId: id('tlv'),
    operations: ['write'],
    expiresAt: expiry,
  },
  audit: { principalRef: 'service:runtime-worker', traceId: id('trc') },
  approval: {
    interactionId: id('int'),
    allowedPrincipalIds: ['principal:owner'],
    requestedAt: at,
    expiresAt: expiry,
  },
  ...changes,
})

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-effect-gate-'))
  const path = join(directory, 'journal.sqlite')
  let database
  const state = {
    effects: 0,
    reviews: 0,
    approved: false,
    revoked: false,
    clock: at,
    boundary: undefined,
  }
  const open = async (changes = {}) => {
    database = new DatabaseSync(path)
    database.exec(
      'CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, revision INTEGER, record TEXT)'
    )
    const calls = {
      async get(callId) {
        const row = database.prepare('SELECT record FROM calls WHERE id = ?').get(callId)
        return row ? JSON.parse(row.record) : undefined
      },
      async getByIdempotencyKey(workspace, key) {
        return database
          .prepare('SELECT record FROM calls')
          .all()
          .map((row) => JSON.parse(row.record))
          .find((call) => call.workspaceId === workspace && call.idempotencyKey === key)
      },
      async insert(call) {
        return (
          database
            .prepare('INSERT OR IGNORE INTO calls VALUES (?, ?, ?)')
            .run(call.toolCallId, call.revision, JSON.stringify(call)).changes === 1
        )
      },
      async compareAndSet(revision, call) {
        return (
          database
            .prepare('UPDATE calls SET revision = ?, record = ? WHERE id = ? AND revision = ?')
            .run(call.revision, JSON.stringify(call), call.toolCallId, revision).changes === 1
        )
      },
      async listByExecution() {
        return []
      },
    }
    const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
    await registry.createDefinition({
      toolDefinitionId: id('tld'),
      name: 'records.write',
      displayName: 'Write record',
      description: 'Scoped effect.',
      ownership: { scope: 'workspace', workspaceId: id('wsp') },
      createdAt: at,
    })
    await registry.publishVersion({
      toolDefinitionId: id('tld'),
      toolVersionId: id('tlv'),
      semanticVersion: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { saved: { type: 'boolean' } },
        required: ['saved'],
        additionalProperties: false,
      },
      operations: [
        {
          name: 'write',
          requiredCapabilities: ['records.write'],
          riskClass: 'high',
          approvalMode: 'always',
          idempotency: 'provider_key',
          retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
        },
      ],
      executor: { type: 'connector', reference: 'records-v1' },
      limits: { maxInputBytes: 256, maxOutputBytes: 256, timeoutMs: changes.timeoutMs ?? 1000 },
      createdAt: at,
      publishedAt: at,
    })
    const gateway = new ToolGateway(registry)
    gateway.registerExecutor('connector', 'records-v1', {
      async execute() {
        state.effects++
        await changes.afterEffect?.()
        return { output: { saved: true } }
      },
    })
    const authorizer = new StaticToolPolicyAuthorizer({
      effect: 'allow',
      decisionId: 'decision-1',
      policyVersion: 'v1',
      reasonCode: 'GRANTED',
      requiresApproval: true,
      evaluatedAt: at,
    })
    const approvals = changes.approvals ?? {
      async review(input) {
        state.reviews++
        changes.onReview?.(state.reviews)
        return {
          state: state.revoked ? 'revoked' : state.approved ? 'approved' : 'pending',
          interactionId: input.interactionId,
          ...(state.approved
            ? { decisionPrincipalRef: changes.approvalPrincipal ?? 'principal:owner' }
            : {}),
        }
      },
    }
    const service = new PolicyControlledToolExecutionService({
      gateway,
      calls,
      authorizer,
      approvals,
      rateLimiter: new InMemoryToolRateLimiter(),
      now: () => state.clock,
    })
    const store = new SqliteDurableEffectGateStore(database)
    const gate = new PiDurableEffectGate({
      service,
      store: changes.store?.(store) ?? store,
      now: () => state.clock,
      assertAuthority: async (_request, boundary) => {
        if (boundary === state.boundary) throw new Error('credential-secret-never-persist')
        await changes.assertAuthority?.(boundary)
      },
    })
    return { gate, store, calls, service }
  }
  const close = () => {
    database?.close()
    database = undefined
  }
  try {
    await run({ open, close, state, path })
  } finally {
    close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function delayedGuardAbortRegression(mode) {
  await fixture(async ({ open, close, state, path }) => {
    state.approved = true
    let entered, resume
    const guarding = new Promise((resolve) => {
      entered = resolve
    })
    const paused = new Promise((resolve) => {
      resume = resolve
    })
    const controller = new AbortController()
    const { gate, store } = await open({
      timeoutMs: mode === 'timeout' ? 20 : 1000,
      assertAuthority: async (boundary) => {
        // The second approval review is the final guard before executor entry.
        if (boundary === 'approval' && state.reviews === 2) {
          entered()
          await paused
        }
      },
    })
    try {
      const pending = gate.execute(request(), { signal: controller.signal })
      await guarding
      if (mode === 'caller') controller.abort(new Error('credential-secret-never-persist'))
      const outcome = await pending
      expect(outcome).toMatchObject({
        state: 'reconciliation_required',
        call: { errorCode: mode === 'caller' ? 'ABORTED' : 'TIMEOUT' },
      })
      const key = JSON.stringify([request().workspaceId, request().idempotencyKey])
      const evidence = await store.get(key)
      expect(state.effects).toBe(0)
      resume()
      // Drain the guard's continuations after the gateway has already returned its ambiguity receipt.
      await nextTurn()
      expect(state.effects).toBe(0)
      expect(await store.get(key)).toEqual(evidence)
      expect(await gate.execute(request())).toEqual(outcome)
      expect(state.effects).toBe(0)
      close()
      const reopened = await open()
      expect(await reopened.gate.execute(request())).toEqual(outcome)
      expect(await reopened.store.get(key)).toEqual(evidence)
      expect(state.effects).toBe(0)
      close()
      expect((await readFile(path)).toString()).not.toContain('credential-secret-never-persist')
    } finally {
      resume()
      await nextTurn()
    }
  })
}

describe('persistent Pi governed effect gate', () => {
  test('caller abort during the delayed final guard cannot invoke a non-abort-aware executor', () =>
    delayedGuardAbortRegression('caller'))

  test('gateway timeout during the delayed final guard cannot invoke a non-abort-aware executor', () =>
    delayedGuardAbortRegression('timeout'))

  test('pending approval survives SQLite close/reopen and succeeded receipt replays without effects', () =>
    fixture(async ({ open, close, state }) => {
      let { gate } = await open()
      expect((await gate.execute(request())).state).toBe('awaiting_approval')
      expect(state.effects).toBe(0)
      close()
      state.approved = true
      ;({ gate } = await open())
      expect((await gate.execute(request())).state).toBe('succeeded')
      expect(state.effects).toBe(1)
      close()
      ;({ gate } = await open())
      expect((await gate.execute(request())).state).toBe('succeeded')
      expect(state.effects).toBe(1)
    }))

  test('reconstructed gate denies retained outcomes after current authority revocation without effects or evidence changes', async () => {
    for (const interrupted of [false, true])
      await fixture(async ({ open, close, state, path }) => {
        state.approved = true
        const first = await open(
          interrupted
            ? {
                store: (store) => ({
                  get: store.get.bind(store),
                  insert: store.insert.bind(store),
                  compareAndSet: async () => {
                    throw new Error('credential-secret-never-persist')
                  },
                }),
              }
            : {}
        )
        if (interrupted)
          await expect(first.gate.execute(request())).rejects.toThrow('PI_EFFECT_STORE_CONFLICT')
        else expect((await first.gate.execute(request())).state).toBe('succeeded')
        expect(state.effects).toBe(1)
        const key = JSON.stringify([request().workspaceId, request().idempotencyKey])
        const evidence = await first.store.get(key)
        expect(evidence.state).toBe(interrupted ? 'invoking' : 'settled')
        const reviews = state.reviews
        close()

        state.boundary = 'admission'
        const resumed = await open()
        await expect(resumed.gate.execute(request())).rejects.toThrow(
          'PI_EFFECT_AUTHORITY_REJECTED'
        )
        expect(await resumed.store.get(key)).toEqual(evidence)
        expect(state.effects).toBe(1)
        expect(state.reviews).toBe(reviews)
        // Identity conflicts still take precedence over authority and never replace retained evidence.
        await expect(
          resumed.gate.execute(request({ input: { value: 'changed' } }))
        ).rejects.toThrow('PI_EFFECT_IDENTITY_CONFLICT')
        expect(await resumed.store.get(key)).toEqual(evidence)

        state.boundary = undefined
        expect((await resumed.gate.execute(request())).state).toBe(
          interrupted ? 'reconciliation_required' : 'succeeded'
        )
        expect(state.effects).toBe(1)
        expect(await resumed.store.get(key)).toEqual(evidence)
        close()
        expect((await readFile(path)).toString()).not.toContain('credential-secret-never-persist')
      })
  })

  test('revocation while an effect awaits retains its receipt and denies publication without reexecution', () =>
    fixture(async ({ open, close, state, path }) => {
      state.approved = true
      let entered, resume
      const executing = new Promise((resolve) => {
        entered = resolve
      })
      const paused = new Promise((resolve) => {
        resume = resolve
      })
      const first = await open({
        afterEffect: async () => {
          entered()
          await paused
        },
      })
      const pending = first.gate.execute(request())
      await executing
      // Current audience/attempt authority is revoked after the effect guard, before receipt publication.
      state.boundary = 'admission'
      resume()
      await expect(pending).rejects.toThrow('PI_EFFECT_AUTHORITY_REJECTED')
      expect(state.effects).toBe(1)
      const key = JSON.stringify([request().workspaceId, request().idempotencyKey])
      const receipt = await first.store.get(key)
      expect(receipt.state).toBe('settled')
      expect(receipt.outcome.state).toBe('succeeded')
      const reviews = state.reviews
      close()

      const restored = await open()
      await expect(restored.gate.execute(request())).rejects.toThrow('PI_EFFECT_AUTHORITY_REJECTED')
      expect(await restored.store.get(key)).toEqual(receipt)
      state.boundary = undefined
      expect(await restored.gate.execute(request())).toEqual(receipt.outcome)
      expect(await restored.store.get(key)).toEqual(receipt)
      expect(state.effects).toBe(1)
      expect(state.reviews).toBe(reviews)
      close()
      expect((await readFile(path)).toString()).not.toContain('credential-secret-never-persist')
    }))

  test('crash after invocation before receipt requires reconciliation after reopen', () =>
    fixture(async ({ open, close, state, path }) => {
      state.approved = true
      const { gate } = await open({
        store: (store) => ({
          get: store.get.bind(store),
          insert: store.insert.bind(store),
          compareAndSet: async () => {
            throw new Error('credential-secret-never-persist')
          },
        }),
      })
      await expect(gate.execute(request())).rejects.toThrow('PI_EFFECT_STORE_CONFLICT')
      expect(state.effects).toBe(1)
      close()
      const resumed = await open()
      expect(await resumed.gate.execute(request())).toMatchObject({
        state: 'reconciliation_required',
        reasonCode: 'PI_EFFECT_OUTCOME_UNKNOWN',
      })
      expect(state.effects).toBe(1)
      close()
      expect((await readFile(path)).toString()).not.toContain('credential-secret-never-persist')
    }))

  test('crash after admission marker before invocation never retries blindly', () =>
    fixture(async ({ open, close, state }) => {
      const { gate } = await open({
        store: (store) => ({
          get: store.get.bind(store),
          compareAndSet: store.compareAndSet.bind(store),
          insert: async (record) => {
            await store.insert(record)
            throw new Error('simulated-crash')
          },
        }),
      })
      await expect(gate.execute(request())).rejects.toThrow('PI_EFFECT_STORE_CONFLICT')
      close()
      const resumed = await open()
      expect((await resumed.gate.execute(request())).state).toBe('reconciliation_required')
      expect(state.effects).toBe(0)
    }))

  test('a separate process crash after a persisted invocation fence prevents replay', () =>
    fixture(async ({ open, close, state, path }) => {
      const first = await open()
      await first.gate.execute(request())
      close()
      const key = JSON.stringify([request().workspaceId, request().idempotencyKey])
      const child = spawnSync(
        process.execPath,
        [
          '--eval',
          `
        import { DatabaseSync } from 'node:sqlite';
        import { SqliteDurableEffectGateStore } from ${JSON.stringify(new URL('./effect-gate.ts', import.meta.url).pathname)};
        const database = new DatabaseSync(${JSON.stringify(path)});
        const store = new SqliteDurableEffectGateStore(database);
        const record = await store.get(${JSON.stringify(key)});
        const { outcome, ...identity } = record;
        if (!await store.compareAndSet(record.revision, { ...identity, revision: record.revision + 1, state: 'invoking' })) process.exit(2);
        process.exit(23);
      `,
        ],
        { encoding: 'utf8' }
      )
      expect(child.status).toBe(23)
      state.approved = true
      const resumed = await open()
      expect((await resumed.gate.execute(request())).state).toBe('reconciliation_required')
      expect(state.effects).toBe(0)
    }))

  test('exact identity pins input, scope, target, principal, approval audience and expiry', () =>
    fixture(async ({ open, state }) => {
      const { gate } = await open()
      await gate.execute(request())
      const original = request()
      for (const changes of [
        { input: { value: 'different' } },
        { attemptId: id('att').replace(/G$/, 'H') },
        { operation: 'read' },
        { toolVersionId: id('tlv').replace(/G$/, 'H') },
        { audit: { ...original.audit, principalRef: 'principal:attacker' } },
        { grant: { ...original.grant, expiresAt: '2026-10-09T10:00:00.000Z' } },
        { approval: { ...original.approval, allowedPrincipalIds: ['principal:attacker'] } },
        { approval: { ...original.approval, expiresAt: '2026-10-09T10:00:00.000Z' } },
        { approval: { ...original.approval, interactionId: id('int').replace(/G$/, 'H') } },
      ])
        await expect(gate.execute(request(changes))).rejects.toThrow('PI_EFFECT_IDENTITY_CONFLICT')
      expect(state.effects).toBe(0)
    }))

  test('stale authority is checked at admission, approval and immediately before effect', async () => {
    for (const boundary of ['admission', 'approval', 'effect'])
      await fixture(async ({ open, state, path, close }) => {
        state.approved = true
        state.boundary = boundary
        const { gate } = await open()
        if (boundary === 'admission')
          await expect(gate.execute(request())).rejects.toThrow('PI_EFFECT_AUTHORITY_REJECTED')
        else
          expect(await gate.execute(request())).toMatchObject({
            state: 'denied',
            reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
          })
        expect(state.effects).toBe(0)
        close()
        expect((await readFile(path)).toString()).not.toContain('credential-secret-never-persist')
      })
  })

  test('revocation between approval and execution denies the authorized tool call', () =>
    fixture(async ({ open, state }) => {
      state.approved = true
      const { gate } = await open({
        onReview: (count) => {
          if (count > 1) state.revoked = true
        },
      })
      expect(await gate.execute(request())).toMatchObject({
        state: 'denied',
        reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(state.effects).toBe(0)
    }))

  test('approval revocation during the effect authority check is reread before invocation', () =>
    fixture(async ({ open, state }) => {
      state.approved = true
      const { gate } = await open({
        assertAuthority: async (boundary) => {
          if (boundary === 'effect') state.revoked = true
        },
      })
      expect(await gate.execute(request())).toMatchObject({
        state: 'denied',
        reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(state.effects).toBe(0)
    }))

  test('expired or wrong-principal approvals never invoke effects', async () => {
    for (const principal of ['principal:owner', 'principal:attacker'])
      await fixture(async ({ open, state }) => {
        state.approved = true
        if (principal === 'principal:owner') state.clock = expiry
        const { gate } = await open({ approvalPrincipal: principal })
        expect((await gate.execute(request())).state).toBe('denied')
        expect(state.effects).toBe(0)
      })
  })

  test('canonical interaction from another attempt is denied before approval', () =>
    fixture(async ({ open, state }) => {
      const repository = new InMemoryInteractionRepository()
      const interactions = new InteractionService(repository)
      await interactions.request({
        ...request().approval,
        executionId: id('exe'),
        attemptId: id('att').replace(/G$/, 'H'),
        kind: 'approval',
        prompt: { title: 'Other attempt' },
        allowedActions: ['approve', 'deny'],
      })
      const { gate } = await open({
        approvals: new InteractionToolApprovalCoordinator(interactions, repository),
      })
      expect(await gate.execute(request())).toMatchObject({
        state: 'denied',
        reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(state.effects).toBe(0)
    }))

  test('a canonical approval for a different tool call cannot authorize this effect', () =>
    fixture(async ({ open, state }) => {
      const repository = new InMemoryInteractionRepository()
      const interactions = new InteractionService(repository)
      await interactions.request({
        ...request().approval,
        executionId: id('exe'),
        attemptId: id('att'),
        kind: 'approval',
        prompt: {
          title: 'Other tool',
          detailsReference: `artifact://tool-call/${id('tlc').replace(/G$/, 'H')}`,
        },
        allowedActions: ['approve', 'deny'],
      })
      const { gate } = await open({
        approvals: new InteractionToolApprovalCoordinator(interactions, repository),
      })
      expect(await gate.execute(request())).toMatchObject({
        state: 'denied',
        reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(state.effects).toBe(0)
    }))

  test('an authorized service call still rereads revocation before effect invocation', () =>
    fixture(async ({ open, state }) => {
      const { gate, calls } = await open()
      const pending = await gate.execute(request())
      await calls.compareAndSet(pending.call.revision, {
        ...pending.call,
        revision: pending.call.revision + 1,
        status: 'authorized',
        authorizedAt: at,
        approvalPrincipalRef: 'principal:owner',
      })
      state.approved = true
      state.revoked = true
      expect(await gate.execute(request())).toMatchObject({
        state: 'denied',
        reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(state.effects).toBe(0)
    }))

  test('concurrent admission has exactly one winner and no duplicate effect', () =>
    fixture(async ({ open, state }) => {
      state.approved = true
      const { gate } = await open()
      const outcomes = await Promise.allSettled([gate.execute(request()), gate.execute(request())])
      expect(state.effects).toBe(1)
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    }))
})
