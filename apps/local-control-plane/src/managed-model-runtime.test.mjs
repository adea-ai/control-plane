import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { PrivateFileSecretsProvider } from '@control-plane/secrets'
import {
  SqliteDurableUsageStore,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { translateExecutionPlanToManagedPi } from '@control-plane/managed-pi-adapter'
import { createManagedPiModelConnection } from './managed-model-runtime.ts'

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'private-native-model-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  const secrets = new PrivateFileSecretsProvider({ rootDirectory: join(directory, 'secrets') })
  let connection
  try {
    await provider.migrate()
    const plan = createExecutionPlanTestFixture()
    const configuration = translateExecutionPlanToManagedPi(plan, '1.2.0')
    const workspaceId = plan.correlation.workspaceId
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
    const at = '2026-08-22T12:00:00.000Z'
    const scope = { workspaceId, executionId, attemptId }
    await provider.transaction(async (tx) => {
      for (const [namespace, identity, value] of [
        [
          'executions',
          executionId,
          {
            executionId,
            state: 'completed',
            version: 2,
            correlation: plan.correlation,
            executionPlan: {
              executionPlanId: plan.executionPlanId,
              contentDigest: plan.contentDigest,
              schemaVersion: 1,
            },
            attemptCount: 1,
            latestAttemptId: attemptId,
            acceptedAt: at,
            terminalAt: at,
            createdAt: at,
            updatedAt: at,
          },
        ],
        [
          'execution-attempts',
          attemptId,
          {
            attemptId,
            executionId,
            state: 'completed',
            sequence: 1,
            version: 2,
            acceptedAt: at,
            terminalAt: at,
            createdAt: at,
            updatedAt: at,
          },
        ],
      ])
        await tx.put({
          namespace,
          id: `r-${createHash('sha256').update(identity).digest('hex')}`,
          value,
        })
    })
    const ledger = new DurableUsageLedger({ store: new SqliteDurableUsageStore(provider) })
    const maximumMicrounits = configuration.limits.budget.maximumMicrounits
    const maximumTokens = configuration.limits.tokens.maximumTotal
    await ledger.openBudget({
      workspaceId,
      executionId,
      currency: 'USD',
      maximumMicrounits,
      maximumTokens,
      source: { sourceId: 'budget', idempotencyKey: 'budget' },
    })
    await ledger.reserve({
      ...scope,
      reservationKey: `runtime-attempt:${attemptId}`,
      maximumMicrounits,
      maximumTokens,
      source: { sourceId: 'attempt', idempotencyKey: 'attempt' },
    })
    const context = {
      attemptId,
      executionId,
      attemptBudget: {
        schemaVersion: 1,
        ...scope,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
        reservationKey: `runtime-attempt:${attemptId}`,
        currency: 'USD',
        maximumMicrounits,
        maximumTokens,
      },
    }
    const grant = {
      schemaVersion: 1,
      ...scope,
      authorizationId: 'operator-approved-1',
      evidenceRef: 'operator://spend/1',
      deploymentId: 'managed.reasoning.us',
      credentialRef: 'lease://provider/main',
      principalRef: 'service:runtime',
      alias: 'reasoning.standard',
      policySnapshotDigest: configuration.policySnapshot.digest,
      currency: 'USD',
      fundingSource: 'hq_managed',
      maximumMicrounits,
      maximumTokens,
      issuedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }
    const record = {
      schemaVersion: 1,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      grant,
      price: {
        schemaVersion: 1,
        deploymentId: grant.deploymentId,
        provider: 'openai',
        model: 'gpt-5',
        version: 'price-1',
        currency: 'USD',
        fundingSource: 'hq_managed',
        validFrom: grant.issuedAt,
        validUntil: grant.expiresAt,
        maximumInputTokens: 100,
        maximumOutputTokens: 20,
        ratesMicrounitsPerMillionTokens: { input: 1000000, cachedInput: 500000, output: 2000000 },
      },
      endpoint: 'https://private-proxy.example/v1/chat/completions',
      proxyModelId: 'exact-deployment-1',
      credential: { provider: 'file', key: 'provider-key' },
      costClass: 'standard',
      entitlements: [],
    }
    const recordPath = join(
      directory,
      'secrets',
      'model-authorizations',
      workspaceId,
      executionId,
      `${attemptId}.json`
    )
    await mkdir(join(directory, 'secrets', 'model-authorizations', workspaceId, executionId), {
      recursive: true,
      mode: 0o700,
    })
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 })
    await writeFile(join(directory, 'secrets', 'provider-key'), 'UPSTREAM-SECRET', { mode: 0o600 })
    let handler
    let listening = 0
    let sends = 0
    const options = {
      directory: join(directory, 'native'),
      secrets,
      ledger,
      configuration,
      context,
      workspaceId,
      route: {
        provider: 'openai',
        model: 'gpt-5',
        modelAlias: 'reasoning.standard',
        providerClass: 'managed',
        dataResidency: 'us',
        modelCapabilities: ['tool_calling', 'structured_output'],
      },
      path: process.env.PATH ?? '/usr/bin:/bin',
      listen: async (fetch) => {
        listening++
        handler = fetch
        return {
          origin: 'http://127.0.0.1:49152',
          close: async () => {
            listening--
          },
        }
      },
      fetch: async (_url, init) => {
        sends++
        expect(init.headers.authorization).toBe('Bearer UPSTREAM-SECRET')
        return Response.json({
          id: `upstream-${sends}`,
          choices: [{ message: { content: 'known' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        })
      },
    }
    const connect = async (override = {}) =>
      (connection = await createManagedPiModelConnection({ ...options, ...override }))
    await run({
      options,
      connect,
      record,
      recordPath,
      directory,
      ledger,
      scope,
      call: async (token, body = {}) =>
        handler(
          new Request('http://private/v1/chat/completions', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'reasoning.standard',
              messages: [{ role: 'user', content: 'Hello' }],
              ...body,
            }),
          })
        ),
      listening: () => listening,
      sends: () => sends,
    })
  } finally {
    await connection?.close()
    await secrets.close()
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('startup cancellation observes a ledger rejection before opening a listener', async () => {
  await fixture(async ({ options, connect, listening }) => {
    const abort = new AbortController()
    await expect(
      connect({
        context: { ...options.context, signal: abort.signal },
        ledger: {
          attemptAllocation: () => {
            abort.abort()
            return Promise.reject(new Error('late ledger rejection'))
          },
        },
      })
    ).rejects.toThrow('MANAGED_PI_MODEL_AUTHORITY_TIMEOUT')
    expect(listening()).toBe(0)
  })
})

test('a lost settled response and recreated broker cannot bill an identical request twice', async () => {
  await fixture(async (f) => {
    const first = await f.connect()
    const token = async (connection) =>
      JSON.parse(
        await readFile(join(connection.environment.PI_CODING_AGENT_DIR, 'auth.json'), 'utf8')
      )['control-plane'].key
    const response = await f.call(await token(first))
    expect(response.status).toBe(200)
    await response.body.cancel()
    expect((await f.call(await token(first))).status).toBe(409)
    await first.close()
    const reopened = await f.connect()
    expect((await f.call(await token(reopened))).status).toBe(502)
    expect(f.sends()).toBe(1)
    const charges = (await f.ledger.entries(f.scope.workspaceId, f.scope.executionId)).filter(
      (entry) => entry.kind === 'model_usage'
    )
    expect(charges.map((entry) => entry.costMicrounits)).toEqual([19])
  })
})

test('native private config carries only the broker capability and accounts distinct requests in SQLite', async () => {
  await fixture(async (f) => {
    const connection = await f.connect()
    const env = connection.environment
    expect(Object.keys(env).toSorted()).toEqual([
      'HOME',
      'PATH',
      'PI_CODING_AGENT_DIR',
      'PI_CODING_AGENT_SESSION_DIR',
    ])
    expect(env.HOME).toStartWith(join(f.directory, 'native'))
    expect((await stat(env.HOME)).mode & 0o777).toBe(0o700)
    const authPath = join(env.PI_CODING_AGENT_DIR, 'auth.json')
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
    const auth = JSON.parse(await readFile(authPath, 'utf8'))
    const models = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'))
    expect(Object.keys(auth)).toEqual(['control-plane'])
    expect(auth['control-plane'].key).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify({ env, auth, models })).not.toContain('UPSTREAM-SECRET')
    expect(models.providers['control-plane'].baseUrl).toBe('http://127.0.0.1:49152/v1')
    expect(models.providers['control-plane'].models[0].id).toBe('reasoning.standard')
    expect((await f.call('forged')).status).toBe(401)
    for (let turn = 0; turn < 2; turn++) {
      const response = await f.call(auth['control-plane'].key, {
        fundingSource: 'external_subscription',
        workspaceId: 'forged',
        messages: [{ role: 'user', content: `Hello ${turn}` }],
      })
      expect(response.status).toBe(200)
      expect((await response.json()).usage.total_tokens).toBe(16)
    }
    const entries = await f.ledger.entries(f.scope.workspaceId, f.scope.executionId)
    const charges = entries.filter((entry) => entry.kind === 'model_usage')
    expect(charges.map((entry) => entry.costMicrounits)).toEqual([19, 19])
    expect(new Set(charges.map((entry) => entry.modelCallId)).size).toBe(2)
    expect(entries.filter((entry) => entry.kind === 'model_reservation')).toHaveLength(2)
    expect(f.sends()).toBe(2)
    await connection.close()
    await connection.close()
    expect(f.listening()).toBe(0)
    expect(await readdir(join(f.directory, 'native'))).toEqual([])
    expect((await f.call(auth['control-plane'].key)).status).toBe(401)
  })
})

test.each(['missing', 'scope', 'plan', 'expired', 'world-readable', 'symlink'])(
  'denies %s spending authority before a listener or request',
  async (mode) => {
    await fixture(async (f) => {
      if (mode === 'missing') await rm(f.recordPath)
      else if (mode === 'world-readable') await chmod(f.recordPath, 0o644)
      else if (mode === 'symlink') {
        await rm(f.recordPath)
        await symlink(join(f.directory, 'secrets', 'provider-key'), f.recordPath)
      } else {
        if (mode === 'scope') f.record.grant.workspaceId = 'wsp_01JBBCDEF0123456789ABCDEFG'
        if (mode === 'plan') f.record.executionPlanDigest = `sha256:${'f'.repeat(64)}`
        if (mode === 'expired') f.record.grant.expiresAt = '2021-01-01T00:00:00.000Z'
        await writeFile(f.recordPath, JSON.stringify(f.record), { mode: 0o600 })
      }
      await expect(f.connect()).rejects.toThrow()
      expect(f.listening()).toBe(0)
      expect(f.sends()).toBe(0)
    })
  }
)

test('revokes a recorded native grant on deletion without allowing another send', async () => {
  await fixture(async (f) => {
    const connection = await f.connect()
    const auth = JSON.parse(
      await readFile(join(connection.environment.PI_CODING_AGENT_DIR, 'auth.json'), 'utf8')
    )
    await rm(f.recordPath)
    expect((await f.call(auth['control-plane'].key)).status).toBe(502)
    expect(f.sends()).toBe(0)
  })
})

test('a listener startup failure removes private model configuration', async () => {
  await fixture(async (f) => {
    await expect(
      f.connect({
        listen: async () => {
          throw new Error('BIND_FAILED')
        },
      })
    ).rejects.toThrow('BIND_FAILED')
    expect(await readdir(join(f.directory, 'native'))).toEqual([])
  })
})

test.each(['completion', 'stream'])(
  'uncertain %s blocks SDK retries and cold connections without releasing its hold',
  async (mode) => {
    await fixture(async (f) => {
      let sends = 0
      const connection = await f.connect({
        fetch: async () => {
          sends++
          return mode === 'stream'
            ? new Response(
                'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { 'content-type': 'text/event-stream' } }
              )
            : Response.json({
                choices: [{ message: { content: 'unknown' }, finish_reason: 'stop' }],
              })
        },
      })
      const auth = JSON.parse(
        await readFile(join(connection.environment.PI_CODING_AGENT_DIR, 'auth.json'), 'utf8')
      )
      const token = auth['control-plane'].key
      const first = await f.call(token, { stream: mode === 'stream' })
      if (mode === 'stream') await expect(first.text()).rejects.toThrow()
      else expect(first.status).toBe(502)
      expect((await f.call(token)).status).toBe(409)
      expect(sends).toBe(1)
      const entries = await f.ledger.entries(f.scope.workspaceId, f.scope.executionId)
      expect(entries.filter((entry) => entry.kind === 'model_reservation')).toHaveLength(1)
      expect(
        entries.filter((entry) => entry.kind === 'model_usage' || entry.kind === 'model_release')
      ).toEqual([])
      await connection.close()
      await expect(f.connect()).rejects.toThrow('MANAGED_PI_MODEL_RECONCILIATION_REQUIRED')
      expect(f.listening()).toBe(0)
    })
  }
)
