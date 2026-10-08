import 'reflect-metadata'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VersioningType } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify/adapters/fastify-adapter.js'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiDurableRuntimeAdapter } from '@control-plane/pi-durable-adapter'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import { NormalizedExceptionFilter } from '../http/errors.ts'
import { PiDurableLeadModule } from './pi-durable-lead.module.ts'
import {
  DurablePiDurableLeadService,
  PiDurableLeadError,
  SqlitePiDurableLeadReceiptStore,
  UnavailablePiDurableLeadService,
} from './pi-durable-lead.service.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const deadlineAt = '2026-10-08T10:00:00.000Z'
const principalId = 'svc_agent-hq'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const hash = (value) => createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')

async function fixture(run, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-http-'))
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const workspaceId = plan.correlation.workspaceId
  const projectId = plan.correlation.projectId
  const state = {
    requests: [],
    resolutions: 0,
    revoked: false,
    audience: [principalId],
    changeAdmission: false,
    starts: 0,
  }
  // A scripted LOCAL HTTP provider exercises the actual pinned Pi transport.
  // It is not a live-provider or real-account qualification claim.
  const providerServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 })
      state.requests.push(await request.json())
      const chunks = [
        {
          id: 'fixture-chat',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'scripted-1',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Canonical answer' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'fixture-chat',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'scripted-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      ]
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  const baseUrl = `http://127.0.0.1:${providerServer.port}/v1`
  const startRequest = {
    executionId: id('exe'),
    attemptId: id('att'),
    idempotencyKey: 'canonical-message:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId,
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${id('att')}`,
      currency: 'USD',
      maximumMicrounits: 10000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: 'Canonical server-side question',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: principalId,
      scopeRef: 'scope:canonical-message',
      expiresAt: deadlineAt,
    },
  }
  let adapter
  let app
  let service
  const envelope = (operation, payload, key = 'transport-command:one') => ({
    caller: { servicePrincipalId: principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId,
    projectId,
    correlation: { traceId: id('trc') },
    commandId: id('cmd'),
    idempotencyKey: key,
    payloadHash: hash(payload),
    operation,
    issuedAt: at,
    payload,
  })
  const read = (operation, parameters) => ({
    caller: { servicePrincipalId: principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId,
    projectId,
    correlation: { traceId: id('trc') },
    operation,
    requestedAt: at,
    parameters,
  })
  const claims = {
    audience: 'control-plane',
    credentialId: 'credential-local-test',
    credentialKind: 'service',
    issuedAt: at,
    expiresAt: deadlineAt,
    issuer: 'https://test.invalid',
    keyId: 'test-key',
    principalId,
    workspaceIds: [workspaceId],
    projectIds: [projectId],
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
    ...changes.claims,
  }
  const close = async () => {
    if (app) {
      await app.close()
      app = undefined
    }
    if (adapter) {
      await adapter.close()
      adapter = undefined
    }
  }
  const open = async (overrides = {}) => {
    adapter = new PiDurableRuntimeAdapter({
      directory,
      now: () => at,
      resolveAdmission: async () => admission,
      assertAuthority: async () => {
        if (state.revoked) throw new Error('private-provider-secret')
      },
      resolveProvider: async () => ({
        ...admission.selection,
        workspaceId,
        provider: 'scripted-http',
        providerModel: 'scripted-1',
        location: 'remote_host',
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        providerBinding: 'pi_durable_models',
        withModels: async (use) => {
          state.resolutions++
          const models = createModels()
          models.setProvider(
            createProvider({
              id: 'scripted-http',
              baseUrl,
              auth: {
                apiKey: {
                  name: 'Local test only',
                  resolve: async () => ({ auth: { apiKey: 'test-only-not-provider-credential' } }),
                },
              },
              models: [
                {
                  id: 'scripted-1',
                  name: 'Scripted HTTP',
                  api: 'openai-completions',
                  provider: 'scripted-http',
                  baseUrl,
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 64,
                  maxTokens: 100,
                },
              ],
              api: openAICompletionsApi(),
            })
          )
          return use(models)
        },
      }),
      authorizeInference: async () => ({
        maxOutputTokens: 24,
        maximumInputTokens: 64,
        assertActive: async () => undefined,
      }),
      settleUsage: async (_authority, _key, usage) => usage,
      reconcileInference: async () => 'unresolved',
    })
    const receipts = new SqlitePiDurableLeadReceiptStore(adapter.journal.database)
    service = new DurablePiDurableLeadService({
      adapter: {
        start: async (request) => {
          state.starts++
          return adapter.start(request)
        },
        status: (...args) => adapter.status(...args),
        progress: (...args) => adapter.progress(...args),
        cancel: (...args) => adapter.cancel(...args),
      },
      receipts: overrides.receipts?.(receipts) ?? receipts,
      now: () => at,
      authority: {
        resolveIntent: async ({ intentId: submitted }) => {
          if (submitted !== intentId) throw new PiDurableLeadError('PI_LEAD_MISSING')
          return {
            schemaVersion: 'pi-lead-authority/v1',
            intentId,
            workspaceId,
            allowedPrincipalIds: state.audience,
            admissionDigest: `sha256:${(state.changeAdmission ? 'b' : 'a').repeat(64)}`,
            deadlineAt,
            admittedAttempt: {
              executionId: startRequest.executionId,
              attemptId: startRequest.attemptId,
              executionPlanId: plan.executionPlanId,
              executionPlanDigest: plan.contentDigest,
            },
            startRequest,
          }
        },
        assertCurrent: async () => {
          if (state.revoked) throw new PiDurableLeadError('PI_LEAD_SCOPE_REJECTED')
        },
      },
    })
    const authenticator = new PolicyServiceAuthenticator({
      audience: 'control-plane',
      issuer: claims.issuer,
      now: () => new Date(at),
      logger: { write() {} },
      verifier: { verify: async () => claims },
      revocationChecker: { isRevoked: async () => false },
    })
    const fastify = new FastifyAdapter({ logger: false })
    app = await NestFactory.create(
      PiDurableLeadModule.register({
        service: changes.unconfigured ? new UnavailablePiDurableLeadService() : service,
        serviceAuthenticator: authenticator,
      }),
      fastify,
      { logger: false }
    )
    app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })
    app.useGlobalFilters(new NormalizedExceptionFilter())
    await app.init()
    await fastify.getInstance().ready()
    return { app, adapter, receipts, service }
  }
  const inject = (route, body, headers = { authorization: 'Bearer local-http-test-token' }) =>
    app.inject({
      method: 'POST',
      url: `/v3/pi-durable/lead-dispatches/${route}`,
      payload: body,
      headers,
    })
  try {
    await open()
    await run({
      open,
      close,
      inject,
      envelope,
      read,
      state,
      directory,
      get adapter() {
        return adapter
      },
      get service() {
        return service
      },
    })
  } finally {
    await close()
    providerServer.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

describe('composed Pi Durable lead HTTP endpoints', () => {
  test('real Pi Models HTTP transport completes and receipt/session/cursor survive reopen without inference replay', () =>
    fixture(async (context) => {
      const { inject, envelope, read, state, close, open } = context
      const body = envelope('pi-durable.lead.dispatch', { intentId })
      const accepted = await inject('dispatch', body)
      expect(accepted.statusCode).toBe(202)
      const receipt = accepted.json().data
      expect(receipt.dispatchId).toMatch(/^dispatch_[a-f0-9]{32}$/)
      expect(receipt.runtimeSessionId).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/)
      await context.adapter.drain()
      const status = await inject(
        'status',
        read('pi-durable.lead.status', { dispatchId: receipt.dispatchId })
      )
      expect(status.statusCode).toBe(200)
      expect(status.json().data.status.result.output).toEqual({ text: 'Canonical answer' })
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0].model).toBe('scripted-1')
      expect(state.requests[0].tools ?? []).toEqual([])
      expect(
        state.requests[0].messages.some(
          (message) => message.content === 'Canonical server-side question'
        )
      ).toBe(true)
      const progressBody = read('pi-durable.lead.progress', { dispatchId: receipt.dispatchId })
      const events = (await inject('progress', progressBody)).json().data.events
      expect(events.length).toBeGreaterThan(1)
      await close()
      await open()
      const replay = await inject('dispatch', body)
      expect(replay.statusCode).toBe(202)
      expect(replay.json().data).toMatchObject({
        dispatchId: receipt.dispatchId,
        runtimeSessionId: receipt.runtimeSessionId,
        state: 'completed',
        replayed: true,
      })
      const tail = (
        await inject(
          'progress',
          read('pi-durable.lead.progress', {
            dispatchId: receipt.dispatchId,
            afterSequence: events[0].sequence,
          })
        )
      ).json().data.events
      expect(tail).toEqual(events.slice(1))
      expect(state.requests).toHaveLength(1)
      expect(state.starts).toBe(1)
    }))

  test('clients cannot supply prompt, provider, plan or current authority through payload/envelope extras', () =>
    fixture(async ({ inject, envelope, state }) => {
      for (const extras of [
        { prompt: 'client prompt' },
        { selection: { selectionRef: 'msel_forged' } },
        { executionPlan: {} },
        { principalId: 'svc_attacker' },
      ]) {
        const response = await inject(
          'dispatch',
          envelope('pi-durable.lead.dispatch', { intentId, ...extras })
        )
        expect(response.statusCode).toBe(400)
      }
      const body = envelope('pi-durable.lead.dispatch', { intentId })
      expect((await inject('dispatch', { ...body, runtimeSessionId: 'attacker' })).statusCode).toBe(
        400
      )
      expect((await inject('dispatch', { ...body, payloadHash: '0'.repeat(64) })).statusCode).toBe(
        400
      )
      expect(state.starts).toBe(0)
      expect(state.requests).toHaveLength(0)
    }))

  test('existing authentication rejects missing credentials and spoofed transport caller', () =>
    fixture(async ({ inject, envelope, state }) => {
      const body = envelope('pi-durable.lead.dispatch', { intentId })
      expect((await inject('dispatch', body, {})).statusCode).toBe(401)
      expect(
        (await inject('dispatch', { ...body, caller: { servicePrincipalId: 'svc_attacker' } }))
          .statusCode
      ).toBe(403)
      expect(state.starts).toBe(0)
    }))

  test('canonical audience and authority changes deny reads and cancellation without runtime calls', () =>
    fixture(async (context) => {
      const { inject, envelope, read, state } = context
      const receipt = (
        await inject('dispatch', envelope('pi-durable.lead.dispatch', { intentId }))
      ).json().data
      await context.adapter.drain()
      state.audience = ['svc_other']
      expect(
        (await inject('status', read('pi-durable.lead.status', { dispatchId: receipt.dispatchId })))
          .statusCode
      ).toBe(403)
      state.audience = [principalId]
      state.changeAdmission = true
      expect(
        (
          await inject(
            'progress',
            read('pi-durable.lead.progress', { dispatchId: receipt.dispatchId })
          )
        ).statusCode
      ).toBe(409)
      state.changeAdmission = false
      state.revoked = true
      expect(
        (
          await inject(
            'cancel',
            envelope(
              'pi-durable.lead.cancel',
              { dispatchId: receipt.dispatchId },
              'cancel-command:one'
            )
          )
        ).statusCode
      ).toBe(403)
      expect(state.requests).toHaveLength(1)
    }))

  test('transport idempotency cannot be reassigned and opaque receipt scope stays pinned', () =>
    fixture(async (context) => {
      const { inject, envelope, read, state } = context
      const receipt = (
        await inject('dispatch', envelope('pi-durable.lead.dispatch', { intentId }))
      ).json().data
      await context.adapter.drain()
      const cancel = envelope('pi-durable.lead.cancel', { dispatchId: receipt.dispatchId })
      expect((await inject('cancel', cancel)).statusCode).toBe(409)
      const status = read('pi-durable.lead.status', { dispatchId: `dispatch_${'b'.repeat(32)}` })
      expect((await inject('status', status)).statusCode).toBe(404)
      expect(state.starts).toBe(1)
    }))

  test('receipt write fault after actual adapter start recovers same attempt without duplicate inference', () =>
    fixture(async (context) => {
      const { close, open, inject, envelope, state } = context
      await close()
      await open({
        receipts: (store) => ({
          get: store.get.bind(store),
          insert: store.insert.bind(store),
          bindCommand: store.bindCommand.bind(store),
          compareAndSet: async () => {
            throw new Error('private-provider-secret')
          },
        }),
      })
      const body = envelope('pi-durable.lead.dispatch', { intentId })
      const failed = await inject('dispatch', body)
      expect(failed.statusCode).toBe(503)
      expect(failed.body).not.toContain('private-provider-secret')
      await context.adapter.drain()
      await close()
      await open()
      const recovered = await inject('dispatch', body)
      expect(recovered.statusCode).toBe(202)
      expect(recovered.json().data.state).toBe('completed')
      expect(state.requests).toHaveLength(1)
    }))

  test('cancel uses the stored session and command replay survives reopen', () =>
    fixture(async (context) => {
      const { inject, envelope, close, open } = context
      const receipt = (
        await inject('dispatch', envelope('pi-durable.lead.dispatch', { intentId }))
      ).json().data
      await context.adapter.drain()
      const persisted = await new SqlitePiDurableLeadReceiptStore(
        context.adapter.journal.database
      ).get(receipt.dispatchId)
      await context.adapter.awaitInput(persisted.handle, id('int'))
      const cancel = envelope(
        'pi-durable.lead.cancel',
        { dispatchId: receipt.dispatchId },
        'cancel-command:one'
      )
      expect((await inject('cancel', cancel)).json().data.state).toBe('cancelled')
      await close()
      await open()
      expect((await inject('cancel', cancel)).json().data.state).toBe('cancelled')
    }))

  test('unconfigured composition stays unavailable without enabling providers', () =>
    fixture(
      async ({ inject, envelope, state }) => {
        expect(
          (await inject('dispatch', envelope('pi-durable.lead.dispatch', { intentId }))).statusCode
        ).toBe(503)
        expect(state.requests).toHaveLength(0)
      },
      { unconfigured: true }
    ))

  test('receipt table retains references and digests without prompt, credential or plan material', () =>
    fixture(async (context) => {
      const { inject, envelope, directory } = context
      await inject('dispatch', envelope('pi-durable.lead.dispatch', { intentId }))
      await context.adapter.drain()
      const rows = context.adapter.journal.database
        .prepare('SELECT record FROM pi_lead_receipts')
        .all()
      expect(JSON.stringify(rows)).not.toContain('Canonical server-side question')
      expect(JSON.stringify(rows)).not.toContain('test-only-not-provider-credential')
      expect(JSON.stringify(rows)).not.toContain('executionPlan')
      const walk = async (path) => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(join(path, entry.name))
          else
            expect((await readFile(join(path, entry.name))).toString()).not.toContain(
              'test-only-not-provider-credential'
            )
        }
      }
      await context.close()
      await walk(directory)
    }))
})
