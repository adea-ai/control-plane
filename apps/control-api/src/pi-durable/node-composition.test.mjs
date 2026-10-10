import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { ExecutionLifecycleService, VersionedCatalog } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqlitePersistenceProvider,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteExecutionRepository,
  SqliteCommandAcceptanceRepository,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { SqliteVersionedCatalogRepository } from '@control-plane/sqlite-persistence/catalog'
import { DurableUsageLedger, PinnedModelPrice } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createNodePiDurableLeadComposition } from './node-composition.ts'
import { deterministicPiLeadIntentIds } from './node-admission.ts'

const at = '2026-10-08T09:00:00.000Z'
const expiresAt = '2026-10-08T10:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const payloadHash = (value) =>
  createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')

// Local HTTP Models transport and scripted verified product/spending ports.
// The Pi engine, CP admission, SQLite stores and usage settlement are real.
// This does not qualify a live provider account or recorded grant integration.
test('concrete node composition persists real Pi generation, canonical admission and usage across store reopen, and settles the completed attempt reservation exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-concrete-node-'))
  const state = {
    requests: [],
    modelsResolutions: 0,
    spendingChecks: 0,
    productReads: 0,
    revoked: false,
  }
  const providerServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 })
      state.requests.push(await request.json())
      const chunks = [
        {
          id: 'node-fixture-chat',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'scripted-1',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Canonical node answer' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'node-fixture-chat',
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
  let persistence, composition, plan, evidence, ids
  const openPersistence = async () => {
    persistence = new SqlitePersistenceProvider({ path: join(directory, 'cp-state.sqlite') })
    await persistence.migrate()
    const executions = new SqliteExecutionRepository(persistence)
    const plans = new SqliteExecutionPlanRepository(persistence)
    const commands = new SqliteCommandAcceptanceRepository(persistence, { budgetAdmission: true })
    const catalog = new SqliteVersionedCatalogRepository(persistence)
    const usage = new SqliteDurableUsageStore(persistence)
    return { executions, plans, commands, catalog, usage }
  }
  let repositories
  const ledger = () => new DurableUsageLedger({ store: repositories.usage, now: () => at })
  const price = new PinnedModelPrice(
    {
      schemaVersion: 1,
      deploymentId: 'local-scripted-node',
      provider: 'scripted-http',
      model: 'scripted-1',
      version: 'price:1',
      currency: 'USD',
      fundingSource: 'hq_managed',
      validFrom: at,
      validUntil: expiresAt,
      maximumInputTokens: 32768,
      maximumOutputTokens: 24,
      ratesMicrounitsPerMillionTokens: {
        input: 1_000_000,
        cachedInput: 500_000,
        output: 2_000_000,
      },
    },
    { now: () => at }
  )
  const principal = {
    kind: 'agent_hq_service',
    principalId: 'svc_adea',
    workspaceIds: [id('wsp')],
    projectIds: [id('prj')],
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
  }
  const envelope = (operation, payload) => ({
    caller: { servicePrincipalId: principal.principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId: id('wsp'),
    projectId: id('prj'),
    correlation: { traceId: id('trc') },
    commandId: id('cmd'),
    idempotencyKey: 'concrete-node-transport:one',
    payloadHash: payloadHash(payload),
    operation,
    issuedAt: at,
    payload,
  })
  const read = (operation, parameters) => ({
    caller: { servicePrincipalId: principal.principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId: id('wsp'),
    projectId: id('prj'),
    correlation: { traceId: id('trc') },
    operation,
    requestedAt: at,
    parameters,
  })
  const close = async () => {
    if (composition) {
      await composition.close()
      composition = undefined
    }
    if (persistence) {
      await persistence.close()
      persistence = undefined
    }
  }
  const open = async () => {
    repositories = await openPersistence()
    composition = await createNodePiDurableLeadComposition({
      directory,
      admission: {
        product: {
          readCurrent: async (input) => {
            state.productReads++
            expect(input.schemaVersion).toBe('pi-lead-intent/v1')
            if (
              input.intentId !== intentId ||
              input.workspaceId !== evidence.workspaceId ||
              input.principalId !== principal.principalId
            )
              return undefined
            return {
              ...evidence,
              allowedPrincipalIds: state.revoked ? ['svc_other'] : evidence.allowedPrincipalIds,
            }
          },
        },
        resolvePlan: async () => plan,
        plans: repositories.plans,
        commandRepository: repositories.commands,
        planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
          catalog: { profiles: repositories.catalog, skills: repositories.catalog },
        }),
        executions: repositories.executions,
        budgetAdmission: new DurableRuntimeBudgetAdmission({
          commands: repositories.commands,
          store: repositories.usage,
        }),
        admissionPrincipalId: 'svc_pi-admission',
        now: () => at,
      },
      usage: {
        ledger: ledger(),
        resolvePrice: async (authority) => {
          expect(authority.admission.selection).toEqual({
            selectionRef: evidence.selectionRef,
            selectionRevision: evidence.selectionRevision,
          })
          return { price, maximumOutputTokens: 24 }
        },
        assertSpendingAuthorized: async (authority, request) => {
          expect(request.attemptMaximumTokens).toBe(authority.request.attemptBudget.maximumTokens)
          expect(request.maximumTokens).toBe(32792)
          expect(request.maximumMicrounits).toBe(32816)
          return {
            authorizationRef: 'model-spend:scripted-trusted-record',
            evidenceDigest: `sha256:${'e'.repeat(64)}`,
            assertActive: async () => {
              state.spendingChecks++
              if (state.revoked) throw new Error('SCRIPTED_SPENDING_REVOKED')
            },
          }
        },
      },
      provider: async (reference) => ({
        ...reference,
        workspaceId: evidence.workspaceId,
        provider: 'scripted-http',
        providerModel: 'scripted-1',
        location: 'remote_host',
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        providerBinding: 'pi_durable_models',
        withModels: async (use) => {
          state.modelsResolutions++
          const models = createModels()
          models.setProvider(
            createProvider({
              id: 'scripted-http',
              baseUrl,
              auth: {
                apiKey: {
                  name: 'Local fixture',
                  resolve: async () => ({ auth: { apiKey: 'test-only-not-provider-credential' } }),
                },
              },
              models: [
                {
                  id: 'scripted-1',
                  name: 'Scripted node HTTP',
                  api: 'openai-completions',
                  provider: 'scripted-http',
                  baseUrl,
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 24,
                },
              ],
              api: openAICompletionsApi(),
            })
          )
          return use(models)
        },
      }),
      reconcileInference: async () => 'unresolved',
    })
  }
  try {
    repositories = await openPersistence()
    const inputs = createExecutionPlanTestFixtureInputs()
    inputs.profile.definition.skills = []
    inputs.profile.definition.capabilityRequirements = []
    inputs.skills = []
    ids = deterministicPiLeadIntentIds(inputs.correlation.workspaceId, intentId)
    inputs.correlation.requestId = ids.requestId
    const catalog = new VersionedCatalog(repositories.catalog, repositories.catalog)
    await catalog.createAgentProfile({
      profileId: inputs.profile.profileId,
      displayName: 'Concrete Pi node fixture',
      ownership: { scope: 'system' },
      createdAt: inputs.profile.createdAt,
    })
    const draft = await catalog.createAgentProfileDraft({
      profileId: inputs.profile.profileId,
      profileVersionId: inputs.profile.profileVersionId,
      version: inputs.profile.version,
      definition: inputs.profile.definition,
      createdAt: inputs.profile.createdAt,
    })
    inputs.profile = await catalog.publishAgentProfileVersion({
      profileVersionId: draft.profileVersionId,
      expectedRevision: draft.revision,
      publishedAt: at,
    })
    await new SqliteContextPackageRepository(persistence).put(inputs.contextPackage)
    plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    await repositories.plans.put(plan)
    evidence = {
      schemaVersion: 'pi-lead-intent/v1',
      intentId,
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      messageRef: 'message:concrete-node',
      authorityRevision: 1,
      principalRef: 'lead:one',
      scopeRef: 'channel:one',
      expiresAt,
      allowedPrincipalIds: [principal.principalId],
      selectionRef: `msel_${'a'.repeat(32)}`,
      selectionRevision: 1,
      prompt: 'Canonical node question',
      profileVersionId: plan.profile.profileVersionId,
      profileContentDigest: plan.profile.contentDigest,
    }
    await close()
    await open()
    const dispatch = envelope('pi-durable.lead.dispatch', { intentId })
    const first = (await composition.service.dispatch(dispatch, principal)).data
    expect(first).toMatchObject({
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      replayed: false,
    })
    await composition.adapter.drain()
    const statusRequest = read('pi-durable.lead.status', { dispatchId: first.dispatchId })
    const status = (await composition.service.status(statusRequest, principal)).data.status
    expect(status.state).toBe('completed')
    expect(status.result.output).toEqual({ text: 'Canonical node answer' })
    expect(status.result.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
      accounting: { fundingSource: 'hq_managed', chargedMicrounits: 11, costExact: true },
    })
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]).toMatchObject({ model: 'scripted-1', max_completion_tokens: 24 })
    expect(state.requests[0].tools ?? []).toEqual([])
    expect(state.requests[0].messages.some((message) => message.content === evidence.prompt)).toBe(
      true
    )
    expect(state.spendingChecks).toBeGreaterThanOrEqual(3)
    expect(state.modelsResolutions).toBeGreaterThanOrEqual(2)
    const events = (
      await composition.service.progress(
        read('pi-durable.lead.progress', { dispatchId: first.dispatchId }),
        principal
      )
    ).data.events
    expect(events.length).toBeGreaterThan(1)
    const modelUsage = (await ledger().entries(evidence.workspaceId, ids.executionId)).filter(
      (entry) => entry.kind === 'model_usage'
    )
    expect(modelUsage).toHaveLength(1)
    expect(modelUsage[0]).toMatchObject({
      attemptId: ids.attemptId,
      costMicrounits: 11,
      quantity: { unit: 'tokens', value: 8 },
    })
    const durableBudget = await ledger().summary(evidence.workspaceId, ids.executionId)
    await close()
    await open()
    const replay = (await composition.service.dispatch(dispatch, principal)).data
    expect(replay).toMatchObject({
      dispatchId: first.dispatchId,
      runtimeSessionId: first.runtimeSessionId,
      executionId: first.executionId,
      attemptId: first.attemptId,
      state: 'completed',
      replayed: true,
    })
    const tail = (
      await composition.service.progress(
        read('pi-durable.lead.progress', {
          dispatchId: first.dispatchId,
          afterSequence: events[0].sequence,
        }),
        principal
      )
    ).data.events
    expect(tail).toEqual(events.slice(1))
    expect((await composition.service.status(statusRequest, principal)).data.status).toEqual(status)
    expect(
      (await ledger().entries(evidence.workspaceId, ids.executionId)).filter(
        (entry) => entry.kind === 'model_usage'
      )
    ).toEqual(modelUsage)
    expect(await ledger().summary(evidence.workspaceId, ids.executionId)).toEqual(durableBudget)
    expect(await repositories.executions.listAttempts(ids.executionId)).toHaveLength(1)
    expect(state.requests).toHaveLength(1)
    state.revoked = true
    await expect(composition.service.status(statusRequest, principal)).rejects.toThrow(
      'PI_LEAD_SCOPE_REJECTED'
    )
    await expect(composition.service.dispatch(dispatch, principal)).rejects.toThrow(
      'PI_LEAD_SCOPE_REJECTED'
    )
    expect(state.requests).toHaveLength(1)
    // Terminal accounting. A normally completed run keeps its attempt reservation open, and an open
    // reservation refuses supersession until the lead settles it. Settlement releases only the unspent
    // remainder, and replays add nothing, including after a store reopen.
    const laterAttemptId = 'att_01JBBCDEF0123456789ABCDEFG'
    const lifecycle = new ExecutionLifecycleService(repositories.executions)
    const supersede = async () =>
      lifecycle.createAttempt({
        executionId: ids.executionId,
        attemptId: laterAttemptId,
        expectedExecutionVersion: (await repositories.executions.getExecution(ids.executionId))
          .version,
        queuedAt: at,
      })
    const attemptReservation = async () =>
      (await ledger().entries(evidence.workspaceId, ids.executionId)).find(
        (entry) =>
          entry.kind === 'reservation' &&
          entry.reservationKey === `runtime-attempt:${ids.attemptId}`
      )
    const reserved = await attemptReservation()
    const charged = modelUsage[0].costMicrounits
    // An open hold counts only its unspent part as reserved; the charge has already moved to spent.
    expect((await ledger().summary(evidence.workspaceId, ids.executionId)).reservedMicrounits).toBe(
      reserved.quantity.value - charged
    )
    await expect(supersede()).rejects.toThrow('SETTLEMENT_INCOMPLETE')
    // An open model request keeps the completed attempt pending, and nothing is released meanwhile.
    const openRequest = {
      workspaceId: evidence.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: `runtime-attempt:${ids.attemptId}`,
      fundingSource: 'hq_managed',
      priceSnapshotDigest: `sha256:${'a'.repeat(64)}`,
      requestDigest: `sha256:${'b'.repeat(64)}`,
    }
    const probeCallId = 'mdc_01JABCDEF0123456789ABCDEFG'
    await ledger().reserveModelRequestForDispatch({
      ...openRequest,
      modelCallId: probeCallId,
      maximumMicrounits: 1,
      maximumTokens: 1,
      source: { sourceId: probeCallId, idempotencyKey: 'terminal-probe:open-request' },
    })
    expect(await composition.settleTerminalAccounting()).toEqual({
      settled: 0,
      pending: 1,
      unbound: 0,
    })
    expect(composition.terminalSettlementBlocked).toBe(true)
    expect(
      (await ledger().entries(evidence.workspaceId, ids.executionId)).filter(
        (entry) => entry.kind === 'release'
      )
    ).toHaveLength(0)
    await ledger().settleModelRequest({
      workspaceId: evidence.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: openRequest.reservationKey,
      modelCallId: probeCallId,
      costMicrounits: 0,
      tokens: 0,
      source: { sourceId: probeCallId, idempotencyKey: 'terminal-probe:open-request:settle' },
    })
    expect(await composition.settleTerminalAccounting()).toEqual({
      settled: 1,
      pending: 0,
      unbound: 0,
    })
    expect(await ledger().summary(evidence.workspaceId, ids.executionId)).toMatchObject({
      reservedMicrounits: 0,
      spentMicrounits: charged,
    })
    expect(composition.terminalSettlementBlocked).toBe(false)
    const releases = (await ledger().entries(evidence.workspaceId, ids.executionId)).filter(
      (entry) => entry.kind === 'release'
    )
    expect(releases).toHaveLength(1)
    expect(releases[0].quantity.value).toBe(reserved.quantity.value - charged)
    await supersede()
    expect(
      (await repositories.executions.listAttempts(ids.executionId)).map(
        (attempt) => attempt.attemptId
      )
    ).toEqual([ids.attemptId, laterAttemptId])
    const settled = await ledger().entries(evidence.workspaceId, ids.executionId)
    expect(await composition.settleTerminalAccounting()).toEqual({
      settled: 1,
      pending: 0,
      unbound: 0,
    })
    expect(await ledger().entries(evidence.workspaceId, ids.executionId)).toEqual(settled)
    await close()
    await open()
    expect(await composition.settleTerminalAccounting()).toEqual({
      settled: 1,
      pending: 0,
      unbound: 0,
    })
    expect(await ledger().entries(evidence.workspaceId, ids.executionId)).toEqual(settled)
    // Once settled, the same allowance cannot fund another model request.
    await expect(
      ledger().reserveModelRequestForDispatch({
        ...openRequest,
        modelCallId: 'mdc_01JABCDEF0123456789ABCDEFH',
        maximumMicrounits: 1,
        maximumTokens: 1,
        source: {
          sourceId: 'mdc_01JABCDEF0123456789ABCDEFH',
          idempotencyKey: 'terminal-probe:post-settlement-spend',
        },
      })
    ).rejects.toMatchObject({ code: 'RESERVATION_SETTLED' })
    expect(await ledger().entries(evidence.workspaceId, ids.executionId)).toEqual(settled)
    const closing = composition.close()
    expect(composition.close()).toBe(closing)
    await closing
    expect(composition.close()).toBe(closing)
  } finally {
    await close()
    providerServer.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
