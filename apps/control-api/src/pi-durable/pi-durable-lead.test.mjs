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
import { SqlitePiLeadPreparations } from './lead-preparation.ts'
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
    fundingRevision: 1,
    releases: 0,
    fundingReads: 0,
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
      ...(changes.preparations
        ? {
            preparations: new SqlitePiLeadPreparations(
              adapter.journal.database,
              {
                async readFunding(lead) {
                  state.fundingReads++
                  await changes.onFundingRead?.(state)
                  return {
                    schemaVersion: 'model-funding-display/v1',
                    state: 'ready',
                    workspaceId,
                    executionId: lead.admittedAttempt.executionId,
                    attemptId: lead.admittedAttempt.attemptId,
                    selectionRef: admission.selection.selectionRef,
                    selectionRevision: admission.selection.selectionRevision,
                    provider: 'scripted-http',
                    providerModel: 'scripted-1',
                    accountRef: 'account:test',
                    authKind: 'api_key',
                    fundingSource: 'byo_api',
                    fundingOwner: {
                      ownerRef: 'payer:test',
                      kind: 'provider_account',
                      displayName: 'Test payer',
                      revision: state.fundingRevision,
                      evidenceRef: 'payer-evidence:test',
                    },
                    authorizationRef: 'authorization:test',
                    authorityRevision: state.fundingRevision,
                    expiresAt: deadlineAt,
                  }
                },
                async releaseExpired() {
                  state.releases++
                },
              },
              () => at
            ),
          }
        : {}),
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
      ...(changes.delegationService ? { delegationService: changes.delegationService } : {}),
      ...(changes.childDelegations ? { childDelegations: changes.childDelegations } : {}),
      findRuntimeHandle: (request) => adapter.findExistingHandle(request),
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
          if (state.revoked || !state.audience.includes(principalId))
            throw new PiDurableLeadError('PI_LEAD_SCOPE_REJECTED')
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
  test('audience revoked during final funding await prevents dispatch claim, runtime start and native send', async () => {
    let signalEntered, resumeFunding
    const entered = new Promise((resolve) => {
      signalEntered = resolve
    })
    const gate = new Promise((resolve) => {
      resumeFunding = resolve
    })
    await fixture(
      async (context) => {
        const { inject, envelope, state } = context
        const prepared = await inject(
          'prepare',
          envelope('pi-durable.lead.prepare', { intentId }, 'prepare-for-final-await')
        )
        expect(prepared.statusCode).toBe(200)
        const preparationRef = prepared.json().data.preparationRef
        let claims = 0
        const store = context.service.options.preparations
        const mark = store.markDispatching.bind(store)
        store.markDispatching = (ref) => {
          claims++
          return mark(ref)
        }
        const pending = inject(
          'dispatch',
          envelope('pi-durable.lead.dispatch', { intentId, preparationRef }, 'dispatch-final-await')
        )
        await entered
        state.audience = ['svc_other']
        resumeFunding()
        const denied = await pending
        expect(denied.statusCode).toBe(403)
        await context.adapter.drain()
        expect(claims).toBe(0)
        expect(state.starts).toBe(0)
        expect(state.requests).toHaveLength(0)
        const record = context.adapter.journal.database
          .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref = ?')
          .get(preparationRef)
        expect(JSON.parse(record.record).state).toBe('prepared')
        expect(denied.body).not.toContain('private-provider-secret')
      },
      {
        preparations: true,
        onFundingRead: async (state) => {
          if (state.fundingReads === 3) {
            signalEntered()
            await gate
          }
        },
      }
    )
  })

  test('intent-only lookup repairs lost dispatch ACK without funding replay or another inference', () =>
    fixture(
      async (context) => {
        const { inject, envelope, read, state, open } = context
        let failOnce = true
        await open({
          receipts: (store) => ({
            get: (...args) => store.get(...args),
            insert: (...args) => store.insert(...args),
            bindCommand: (...args) => store.bindCommand(...args),
            compareAndSet: async (...args) => {
              if (failOnce) {
                failOnce = false
                throw new Error('simulated-lost-receipt-ACK')
              }
              return store.compareAndSet(...args)
            },
          }),
        })
        const body = read('pi-durable.lead.lookup', { intentId })
        expect((await inject('lookup', body)).json().data.receipt).toBeNull()
        expect(state.starts).toBe(0)
        const preparation = (
          await inject(
            'prepare',
            envelope('pi-durable.lead.prepare', { intentId }, 'prepare-for-lost-ack')
          )
        ).json().data
        const rejected = await inject(
          'dispatch',
          envelope(
            'pi-durable.lead.dispatch',
            { intentId, preparationRef: preparation.preparationRef },
            'lost-ack-dispatch'
          )
        )
        expect(rejected.statusCode).toBe(503)
        await context.adapter.drain()
        const counts = {
          starts: state.starts,
          requests: state.requests.length,
          fundingReads: state.fundingReads,
        }
        state.fundingRevision++
        const recovered = await inject('lookup', body)
        expect(recovered.statusCode).toBe(200)
        const receipt = recovered.json().data.receipt
        expect(receipt.state).toBe('dispatched')
        expect(receipt.runtimeSessionId).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/)
        expect((await inject('lookup', body)).json().data.receipt).toEqual(receipt)
        expect({
          starts: state.starts,
          requests: state.requests.length,
          fundingReads: state.fundingReads,
        }).toEqual(counts)
        expect(counts.requests).toBe(1)
      },
      { preparations: true }
    ))

  test('prepare retains funding without runtime start; explicit dispatch rejects changed payer evidence', () =>
    fixture(
      async ({ inject, envelope, state, adapter }) => {
        const body = envelope('pi-durable.lead.prepare', { intentId })
        const prepared = await inject('prepare', body)
        expect(prepared.statusCode).toBe(200)
        const data = prepared.json().data
        expect(data.preparationRef).toMatch(/^prep_[a-f0-9]{32}$/)
        expect(data.funding.fundingOwner.displayName).toBe('Test payer')
        expect(data.runtimeSessionId).toBeUndefined()
        expect(state.starts).toBe(0)
        expect(state.requests).toHaveLength(0)
        expect((await inject('prepare', body)).json().data).toEqual({ ...data, replayed: true })
        await adapter.drain()
        expect(state.requests).toHaveLength(0)
        state.fundingRevision++
        const stale = await inject(
          'dispatch',
          envelope(
            'pi-durable.lead.dispatch',
            { intentId, preparationRef: data.preparationRef },
            'stale-confirmation'
          )
        )
        expect(stale.statusCode).toBe(409)
        expect(stale.json().error.code).toBe('PI_LEAD_FUNDING_CONFIRMATION_STALE')
        expect(state.starts).toBe(0)
        const refreshed = await inject(
          'prepare',
          envelope('pi-durable.lead.prepare', { intentId }, 'refresh-preparation')
        )
        expect(refreshed.statusCode).toBe(409)
        expect(state.starts).toBe(0)
        state.fundingRevision--
        const accepted = await inject(
          'dispatch',
          envelope(
            'pi-durable.lead.dispatch',
            { intentId, preparationRef: data.preparationRef },
            'confirmed-dispatch'
          )
        )
        expect(accepted.statusCode).toBe(202)
        await adapter.drain()
        expect(state.starts).toBe(1)
        expect(state.requests).toHaveLength(1)
        expect(state.releases).toBe(0)
      },
      { preparations: true }
    ))

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

  test('cancel rechecks authority and never cascades to child stops', () => {
    let revokeAfterCancel = true
    const calls = []
    // The spy stays configured precisely so any child-cancel call would
    // fail the zero-call assertions below. Ordinary lead-stop must not
    // cancel child jobs; explicit cascade lives outside this path.
    const delegationService = {
      async cancelChildren(input) {
        calls.push(structuredClone(input))
      },
    }
    return fixture(
      async (context) => {
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
        const originalCancel = context.adapter.cancel.bind(context.adapter)
        context.adapter.cancel = async (...args) => {
          const result = await originalCancel(...args)
          expect(
            context.adapter.journal.get(args[0].handleId).detail.cancellationIntent
          ).toBeDefined()
          if (revokeAfterCancel) {
            revokeAfterCancel = false
            context.state.revoked = true
          }
          return result
        }
        const revoked = await inject('cancel', cancel)
        expect(revoked.statusCode).toBe(503)
        expect(revoked.json().error.code).toBe('PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN')
        expect(calls).toEqual([])
        context.state.revoked = false
        const stopped = await inject('cancel', cancel)
        expect(stopped.statusCode).toBe(202)
        expect(stopped.json().data.state).toBe('cancelled')
        expect(calls).toEqual([])
        await close()
        await open()
        expect((await inject('cancel', cancel)).json().data.state).toBe('cancelled')
        expect(calls).toEqual([])
      },
      { delegationService }
    )
  })

  describe('authorized child read', () => {
    const childId = (suffix) => `dlg_01JABCDEF0123456789ABCDEF${suffix}`
    const record = (suffix, changes = {}) => ({
      delegationId: childId(suffix),
      parentExecutionId: id('exe'),
      parentAttemptId: id('att'),
      childExecutionId: `exe_01JABCDEF0123456789ABCDEF${suffix}`,
      childAttemptId: `att_01JABCDEF0123456789ABCDEF${suffix}`,
      parentExecutionPlanDigest: `sha256:${'1'.repeat(64)}`,
      contextPackageDigest: `sha256:${'2'.repeat(64)}`,
      role: 'researcher',
      objective: 'PRIVATE-OBJECTIVE-CANARY',
      state: 'running',
      retryCount: 0,
      inputDigest: `sha256:${'3'.repeat(64)}`,
      revision: 2,
      acceptedAt: at,
      updatedAt: at,
      ...changes,
    })
    const records = () => [
      record('B', {
        state: 'completed',
        terminalResultRef: 'art_01JABCDEF0123456789ABCDEFG',
        terminalPublication: {
          status: 'published',
          idempotencyKey: 'delegation:terminal:B',
        },
        revision: 4,
      }),
      record('A', { state: 'awaiting_input' }),
      record('C', { state: 'running', pendingCancellationAt: at }),
      record('D', { state: 'failed', failureCode: 'CHILD_FAILED' }),
      record('E', { parentAttemptId: 'att_01JABCDEF0123456789ABCDEFZ' }),
      record('F', { parentAttemptId: undefined }),
    ]
    const read = (context, receipt) =>
      context.inject(
        'children',
        context.read('pi-durable.lead.children', { dispatchId: receipt.dispatchId })
      )

    test('returns bounded canonical child state, input state and outcomes without private payloads', () => {
      const listed = []
      return fixture(
        async (context) => {
          const receipt = (
            await context.inject(
              'dispatch',
              context.envelope('pi-durable.lead.dispatch', { intentId })
            )
          ).json().data
          await context.adapter.drain()
          const response = await read(context, receipt)
          expect(response.statusCode).toBe(200)
          const { children, ...lead } = response.json().data
          expect(lead.dispatchId).toBe(receipt.dispatchId)
          expect(children.map((child) => child.delegationId)).toEqual([
            childId('A'),
            childId('B'),
            childId('C'),
            childId('D'),
          ])
          const [awaiting, completed, stopping, failed] = children
          expect(awaiting).toMatchObject({ state: 'awaiting_input', awaitingInput: true })
          expect(awaiting.outcome).toBeUndefined()
          expect(completed).toMatchObject({
            state: 'completed',
            revision: 4,
            outcome: {
              state: 'completed',
              resultRef: 'art_01JABCDEF0123456789ABCDEFG',
              publication: { status: 'published' },
            },
          })
          expect(stopping).toMatchObject({ state: 'running', stopRequested: true })
          expect(failed.outcome).toEqual({
            state: 'failed',
            failureCode: 'CHILD_FAILED',
            publication: { status: 'pending' },
          })
          const text = response.body
          for (const secret of ['PRIVATE-OBJECTIVE-CANARY', 'sha256:', 'idempotencyKey'])
            expect(text).not.toContain(secret)
          // A read never starts, advances or stops anything.
          expect(context.state.starts).toBe(1)
          expect(listed).toEqual([receipt.executionId])
          // A repeated read returns the same retained view and still starts nothing.
          expect((await read(context, receipt)).json().data.children).toEqual(children)
          expect(listed).toHaveLength(2)
          expect(context.state.starts).toBe(1)
        },
        {
          childDelegations: {
            async listChildren(parentExecutionId) {
              listed.push(parentExecutionId)
              return records().map((child) => ({ ...child, parentExecutionId }))
            },
          },
        }
      )
    })

    test('only records attributable to this dispatch attempt are disclosed or counted', () => {
      const listed = []
      return fixture(
        async (context) => {
          const receipt = (
            await context.inject(
              'dispatch',
              context.envelope('pi-durable.lead.dispatch', { intentId })
            )
          ).json().data
          await context.adapter.drain()
          const response = await read(context, receipt)
          expect(response.statusCode).toBe(200)
          const { children, totalChildren, complete } = response.json().data
          // Attribution is by the exact admitted parent attempt. A record of another attempt of
          // the same execution and a legacy record with no parent attempt are both left out.
          expect(children.map((child) => child.delegationId)).toEqual([
            childId('A'),
            childId('B'),
            childId('C'),
            childId('D'),
          ])
          // The disclosed count is the attributable count: an excluded record is never disclosed
          // and never inflates the total a caller pages against.
          expect(totalChildren).toBe(4)
          expect(complete).toBe(true)
          // Reading children never starts, advances or publishes anything.
          expect(context.state.starts).toBe(1)
          expect(listed).toEqual([receipt.executionId])
        },
        {
          childDelegations: {
            async listChildren(parentExecutionId) {
              listed.push(parentExecutionId)
              return records().map((child) => ({ ...child, parentExecutionId }))
            },
          },
        }
      )
    })

    const many = (count, extraOtherAttempt = 3) => {
      const key = (n) => String(n).padStart(8, '0')
      return [
        ...Array.from({ length: count }, (_, n) =>
          record('X', {
            delegationId: `dlg_01JABCDEF012345678${key(n)}`,
            childExecutionId: `exe_01JABCDEF012345678${key(n)}`,
            childAttemptId: `att_01JABCDEF012345678${key(n)}`,
            acceptedAt: new Date(Date.parse(at) + n * 1000).toISOString(),
          })
        ),
        ...Array.from({ length: extraOtherAttempt }, (_, n) =>
          record('Y', {
            delegationId: `dlg_01JABCDEF012345679${key(n)}`,
            parentAttemptId: 'att_01JABCDEF0123456789ABCDEFZ',
          })
        ),
      ]
    }
    const pageOf = async (context, receipt, parameters = {}) => {
      const response = await context.inject(
        'children',
        context.read('pi-durable.lead.children', { dispatchId: receipt.dispatchId, ...parameters })
      )
      expect(response.statusCode).toBe(200)
      return response.json().data
    }
    const dispatchLead = async (context) => {
      const receipt = (
        await context.inject('dispatch', context.envelope('pi-durable.lead.dispatch', { intentId }))
      ).json().data
      await context.adapter.drain()
      return receipt
    }

    test('256 matching children are one complete page and 257 are paged with a cursor, never truncated', () => {
      let count = 256
      return fixture(
        async (context) => {
          const receipt = await dispatchLead(context)
          // Exactly the page maximum: complete, no cursor; other-attempt records are not counted.
          const exact = await pageOf(context, receipt)
          expect(exact.children).toHaveLength(256)
          expect(exact).toMatchObject({ totalChildren: 256, complete: true })
          expect(exact.next).toBeUndefined()
          // One more matching child: the first page says it is not the whole set.
          count = 257
          const first = await pageOf(context, receipt)
          expect(first.children).toHaveLength(256)
          expect(first).toMatchObject({ totalChildren: 257, complete: false })
          expect(first.next).toEqual({
            acceptedAt: first.children.at(-1).acceptedAt,
            delegationId: first.children.at(-1).delegationId,
          })
          const second = await pageOf(context, receipt, { after: first.next })
          expect(second.children).toHaveLength(1)
          expect(second).toMatchObject({ totalChildren: 257, complete: true })
          expect(second.next).toBeUndefined()
          const ids = [...first.children, ...second.children].map((child) => child.delegationId)
          expect(new Set(ids).size).toBe(257)
          expect(ids).toEqual([...ids].toSorted())
          expect(
            ids.every((delegationId) => delegationId.startsWith('dlg_01JABCDEF012345678'))
          ).toBe(true)
          // Smaller pages walk the same set in the same order.
          const walked = []
          let after
          let pages = 0
          do {
            const page = await pageOf(context, receipt, { limit: 100, ...(after ? { after } : {}) })
            walked.push(...page.children.map((child) => child.delegationId))
            after = page.next
            pages++
          } while (after)
          expect(pages).toBe(3)
          expect(walked).toEqual(ids)
        },
        {
          childDelegations: {
            async listChildren(parentExecutionId) {
              return many(count).map((child) => ({ ...child, parentExecutionId }))
            },
          },
        }
      )
    })

    test('a cursor past the last child is an empty complete page and bad paging input is rejected', () =>
      fixture(
        async (context) => {
          const receipt = await dispatchLead(context)
          const end = await pageOf(context, receipt, {
            after: { acceptedAt: '2100-01-01T00:00:00.000Z', delegationId: childId('Z') },
          })
          expect(end).toMatchObject({ children: [], totalChildren: 3, complete: true })
          for (const parameters of [{ limit: 0 }, { limit: 257 }, { after: { acceptedAt: 'x' } }]) {
            const response = await context.inject(
              'children',
              context.read('pi-durable.lead.children', {
                dispatchId: receipt.dispatchId,
                ...parameters,
              })
            )
            expect(response.statusCode).toBe(400)
          }
        },
        {
          childDelegations: {
            async listChildren(parentExecutionId) {
              return many(3).map((child) => ({ ...child, parentExecutionId }))
            },
          },
        }
      ))

    test('denies without reading children when the audience, receipt or command scope is wrong', () => {
      let listings = 0
      return fixture(
        async (context) => {
          const receipt = (
            await context.inject(
              'dispatch',
              context.envelope('pi-durable.lead.dispatch', { intentId })
            )
          ).json().data
          await context.adapter.drain()
          context.state.audience = ['svc_other']
          expect((await read(context, receipt)).statusCode).toBe(403)
          context.state.audience = [principalId]
          expect(
            (
              await context.inject(
                'children',
                context.read('pi-durable.lead.children', {
                  dispatchId: `dispatch_${'f'.repeat(32)}`,
                })
              )
            ).statusCode
          ).toBe(404)
          context.state.changeAdmission = true
          expect((await read(context, receipt)).statusCode).toBe(409)
          expect(listings).toBe(0)
          context.state.changeAdmission = false
          expect((await read(context, receipt)).statusCode).toBe(200)
          expect(listings).toBe(1)
        },
        {
          childDelegations: {
            async listChildren() {
              listings++
              return []
            },
          },
        }
      )
    })

    test('authority revoked while children are read returns nothing', () => {
      let state
      return fixture(
        async (context) => {
          state = context.state
          const receipt = (
            await context.inject(
              'dispatch',
              context.envelope('pi-durable.lead.dispatch', { intentId })
            )
          ).json().data
          await context.adapter.drain()
          const response = await read(context, receipt)
          expect(response.statusCode).toBe(403)
          expect(response.body).not.toContain('researcher')
        },
        {
          childDelegations: {
            async listChildren(parentExecutionId) {
              state.revoked = true
              return [record('A', { parentExecutionId })]
            },
          },
        }
      )
    })

    test('a child record of another execution fails closed and survives reopen unchanged', () => {
      let foreign = true
      return fixture(
        async (context) => {
          const receipt = (
            await context.inject(
              'dispatch',
              context.envelope('pi-durable.lead.dispatch', { intentId })
            )
          ).json().data
          await context.adapter.drain()
          expect((await read(context, receipt)).statusCode).toBe(409)
          foreign = false
          const first = (await read(context, receipt)).json().data
          await context.close()
          await context.open()
          expect((await read(context, receipt)).json().data).toEqual(first)
          expect(context.state.requests).toHaveLength(1)
        },
        {
          childDelegations: {
            async listChildren(parentExecutionId) {
              return [
                record('A', {
                  parentExecutionId: foreign ? id('exe').replace('G', 'H') : parentExecutionId,
                }),
              ]
            },
          },
        }
      )
    })

    test('stays unavailable when no child record reader is composed', () =>
      fixture(async (context) => {
        const receipt = (
          await context.inject(
            'dispatch',
            context.envelope('pi-durable.lead.dispatch', { intentId })
          )
        ).json().data
        await context.adapter.drain()
        expect((await read(context, receipt)).statusCode).toBe(503)
      }))
  })

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
