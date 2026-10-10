import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { VersionedCatalog } from '@control-plane/domain'
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

// M18.01.3 live service path: a retained run is admitted through the production lead composition
// (real SQLite, real Pi adapter, scripted model transport), then Adea publishes a v2 fence. Every
// observation and cancellation below goes through DurablePiDurableLeadService.

const at = '2026-10-08T09:00:00.000Z'
const expiresAt = '2026-10-08T10:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const actorUserId = '2b1a7e26-8c3f-4f4f-9a1e-77d19b7d5e11'
const canonicalActor = `user:${actorUserId}`
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const payloadHash = (value) =>
  createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
const principal = {
  kind: 'agent_hq_service',
  principalId: 'svc_adea',
  workspaceIds: [id('wsp')],
  projectIds: [id('prj')],
  scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
}
const secondAllowedPrincipal = { ...principal, principalId: 'svc_pi-admission' }
const outsiderPrincipal = { ...principal, principalId: 'svc_other' }

async function createLiveHarness(directory) {
  const state = {
    requests: [],
    product: undefined,
    productReads: 0,
    starts: 0,
    budgetReserves: 0,
    fenceCancels: 0,
    adapterStatuses: 0,
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
          id: 'live-fence-chat',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'scripted-1',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Live fence answer' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'live-fence-chat',
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
  const price = new PinnedModelPrice(
    {
      schemaVersion: 1,
      deploymentId: 'local-scripted-live-fence',
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
  let persistence, repositories, composition, plan, evidence

  const openPersistence = async () => {
    persistence = new SqlitePersistenceProvider({ path: join(directory, 'cp-state.sqlite') })
    await persistence.migrate()
    return {
      executions: new SqliteExecutionRepository(persistence),
      plans: new SqliteExecutionPlanRepository(persistence),
      commands: new SqliteCommandAcceptanceRepository(persistence, { budgetAdmission: true }),
      catalog: new SqliteVersionedCatalogRepository(persistence),
      usage: new SqliteDurableUsageStore(persistence),
    }
  }

  const harness = {
    state,
    principal,
    envelope(operation, payload, idempotencyKey = 'live-fence:one', actor = principal) {
      return {
        caller: { servicePrincipalId: actor.principalId },
        contractVersion: { major: 1, minor: 0 },
        requestId: id('req'),
        workspaceId: id('wsp'),
        projectId: id('prj'),
        correlation: { traceId: id('trc') },
        commandId: id('cmd'),
        idempotencyKey,
        payloadHash: payloadHash(payload),
        operation,
        issuedAt: at,
        payload,
      }
    },
    read(operation, parameters, actor = principal) {
      return {
        caller: { servicePrincipalId: actor.principalId },
        contractVersion: { major: 1, minor: 0 },
        requestId: id('req'),
        workspaceId: id('wsp'),
        projectId: id('prj'),
        correlation: { traceId: id('trc') },
        operation,
        requestedAt: at,
        parameters,
      }
    },
    get composition() {
      return composition
    },
    /** The lead admission database holds the receipts; the adapter journal is a separate file. */
    receiptRecord(dispatchId) {
      const database = new DatabaseSync(join(directory, 'lead-admission.sqlite'))
      try {
        const row = database
          .prepare('SELECT record FROM pi_lead_receipts WHERE dispatch_id = ?')
          .get(dispatchId)
        return JSON.parse(row.record)
      } finally {
        database.close()
      }
    },
    writeReceiptRecord(dispatchId, record) {
      const database = new DatabaseSync(join(directory, 'lead-admission.sqlite'))
      try {
        database
          .prepare('UPDATE pi_lead_receipts SET record = ? WHERE dispatch_id = ?')
          .run(JSON.stringify(record), dispatchId)
      } finally {
        database.close()
      }
    },
    get evidence() {
      return evidence
    },
    get ids() {
      return deterministicPiLeadIntentIds(plan.correlation.workspaceId, intentId)
    },
    /** The ordinary product evidence, then the v2 fence facts that match its retained pins. */
    fenceBody(overrides = {}) {
      return {
        schemaVersion: 'pi-lead-intent-fence/v2',
        intentId,
        workspaceId: evidence.workspaceId,
        dispatchPermitted: false,
        rollbackFence: {
          fencedAt: at,
          reason: 'operator_intervention',
          actor: { kind: 'user', userId: actorUserId },
        },
        authorityRevision: evidence.authorityRevision,
        canonicalActorPrincipalId: canonicalActor,
        scopeRef: evidence.scopeRef,
        allowedPrincipalIds: [...evidence.allowedPrincipalIds],
        ...overrides,
      }
    },
    async setup() {
      await openPersistence()
      const storage = {
        executions: new SqliteExecutionRepository(persistence),
        plans: new SqliteExecutionPlanRepository(persistence),
        catalog: new SqliteVersionedCatalogRepository(persistence),
      }
      const inputs = createExecutionPlanTestFixtureInputs()
      inputs.profile.definition.skills = []
      inputs.profile.definition.capabilityRequirements = []
      inputs.skills = []
      const ids = deterministicPiLeadIntentIds(inputs.correlation.workspaceId, intentId)
      inputs.correlation.requestId = ids.requestId
      const catalog = new VersionedCatalog(storage.catalog, storage.catalog)
      await catalog.createAgentProfile({
        profileId: inputs.profile.profileId,
        displayName: 'Live fence fixture',
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
      await storage.plans.put(plan)
      evidence = {
        schemaVersion: 'pi-lead-intent/v1',
        intentId,
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        messageRef: 'message:live-fence',
        authorityRevision: 7,
        principalRef: 'lead:one',
        canonicalActorPrincipalId: canonicalActor,
        scopeRef: `adea-product:sha256:${'c'.repeat(64)}`,
        expiresAt,
        allowedPrincipalIds: ['svc_adea', 'svc_pi-admission'],
        selectionRef: `msel_${'a'.repeat(32)}`,
        selectionRevision: 1,
        prompt: 'Canonical live fence question',
        profileVersionId: plan.profile.profileVersionId,
        profileContentDigest: plan.profile.contentDigest,
      }
      state.product = evidence
      await harness.close()
    },
    async open() {
      repositories = await openPersistence()
      const budget = new DurableRuntimeBudgetAdmission({
        commands: repositories.commands,
        store: repositories.usage,
      })
      composition = await createNodePiDurableLeadComposition({
        directory,
        admission: {
          product: {
            readCurrent: async (input) => {
              state.productReads += 1
              return input.intentId === intentId && input.workspaceId === evidence.workspaceId
                ? structuredClone(state.product)
                : undefined
            },
          },
          resolvePlan: async () => plan,
          plans: repositories.plans,
          commandRepository: repositories.commands,
          planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
            catalog: { profiles: repositories.catalog, skills: repositories.catalog },
          }),
          executions: repositories.executions,
          budgetAdmission: {
            reserve: async (input) => {
              state.budgetReserves += 1
              return budget.reserve(input)
            },
          },
          admissionPrincipalId: 'svc_pi-admission',
          now: () => at,
        },
        usage: {
          ledger: new DurableUsageLedger({ store: repositories.usage, now: () => at }),
          resolvePrice: async () => ({ price, maximumOutputTokens: 24 }),
          assertSpendingAuthorized: async () => ({
            authorizationRef: 'model-spend:scripted-live-fence',
            evidenceDigest: `sha256:${'e'.repeat(64)}`,
            assertActive: async () => {},
          }),
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
            const models = createModels()
            models.setProvider(
              createProvider({
                id: 'scripted-http',
                baseUrl,
                auth: {
                  apiKey: {
                    name: 'Local fixture',
                    resolve: async () => ({
                      auth: { apiKey: 'test-only-not-provider-credential' },
                    }),
                  },
                },
                models: [
                  {
                    id: 'scripted-1',
                    name: 'Scripted live fence HTTP',
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
      const realStart = composition.adapter.start.bind(composition.adapter)
      composition.adapter.start = async (request) => {
        state.starts += 1
        return realStart(request)
      }
      return composition
    },
    async close() {
      if (composition) {
        const closing = composition
        composition = undefined
        await closing.close()
      }
      if (persistence) {
        const closing = persistence
        persistence = undefined
        repositories = undefined
        await closing.close()
      }
    },
    stop() {
      providerServer.stop(true)
    },
  }
  return harness
}

/** Admits one run through the production dispatch, then waits until the record is running. */
async function admitLiveRun(harness) {
  // A fresh gate holds this run's model response until the test is done with it.
  const composition = await harness.open()
  const dispatched = (
    await composition.service.dispatch(
      harness.envelope('pi-durable.lead.dispatch', { intentId }, 'live-fence:dispatch'),
      principal
    )
  ).data
  await composition.adapter.drain()
  // Retain the run as an owner that stopped mid-turn leaves it: running, with its inference pending
  // and no completion result. Admission, the receipt and the handle are the ones dispatch produced.
  const [completed] = composition.adapter.journal.list()
  const detail = { ...completed.detail, inferencePending: true }
  delete detail.result
  delete detail.terminalUsage
  composition.adapter.journal.update(completed.handleId, completed.epoch, {
    state: 'running',
    detail,
  })
  const record = composition.adapter.journal.get(completed.handleId)
  if (record.state !== 'running') throw new Error('LIVE_FENCE_RUN_NOT_RETAINED')
  return { dispatchId: dispatched.dispatchId, record }
}

async function withLiveHarness(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-fence-service-'))
  const harness = await createLiveHarness(directory)
  try {
    await harness.setup()
    await run(harness)
  } finally {
    await harness.close()
    harness.stop()
    await rm(directory, { recursive: true, force: true })
  }
}

async function expectRefused(promise, code) {
  await expect(promise).rejects.toThrow(code)
}

test('a live Adea v2 fence serves status and progress and cancels as the original actor, with no start, model or budget calls', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await admitLiveRun(harness)
    const composition = harness.composition
    const before = {
      starts: harness.state.starts,
      requests: harness.state.requests.length,
      reserves: harness.state.budgetReserves,
    }
    harness.state.product = harness.fenceBody()

    const status = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }),
      principal
    )
    expect(status.data).toMatchObject({ dispatchId, state: 'running' })

    const progress = await composition.service.progress(
      harness.read('pi-durable.lead.progress', { dispatchId }),
      principal
    )
    expect(progress.data).toMatchObject({ dispatchId, events: expect.any(Array) })

    const cancelled = await composition.service.cancel(
      harness.envelope('pi-durable.lead.cancel', { dispatchId }, 'live-fence:cancel'),
      principal
    )
    expect(['cancelling', 'cancelled']).toContain(cancelled.data.state)

    expect(harness.state.starts).toBe(before.starts)
    expect(harness.state.requests.length).toBe(before.requests)
    expect(harness.state.budgetReserves).toBe(before.reserves)
    expect(harness.state.productReads).toBeGreaterThan(0)
  })
}, 60000)

test('under a fence, changed pins refuse observation and cancellation before any effect', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await admitLiveRun(harness)
    const composition = harness.composition
    const starts = harness.state.starts
    const changes = [
      ['authority revision', { authorityRevision: 8 }],
      ['scope', { scopeRef: `adea-product:sha256:${'e'.repeat(64)}` }],
      ['allowed principals', { allowedPrincipalIds: ['svc_adea'] }],
      [
        'canonical actor',
        {
          canonicalActorPrincipalId: `user:${'9'.repeat(8)}-${'9'.repeat(4)}-4${'9'.repeat(3)}-8${'9'.repeat(3)}-${'9'.repeat(12)}`,
        },
      ],
    ]
    for (const [label, change] of changes) {
      harness.state.product = harness.fenceBody(change)
      await expectRefused(
        composition.service.status(
          harness.read('pi-durable.lead.status', { dispatchId }),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      await expectRefused(
        composition.service.cancel(
          harness.envelope(
            'pi-durable.lead.cancel',
            { dispatchId },
            `live-fence:cancel:${label.replaceAll(' ', '-')}`
          ),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    }
    expect(harness.state.starts).toBe(starts)
    // The retained run was never cancelled by any refused change.
    const [record] = composition.adapter.journal.list()
    expect(record.state).toBe('running')
    // The unchanged fence observes again: the refusals were about the change, not the run.
    harness.state.product = harness.fenceBody()
    const restored = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }),
      principal
    )
    expect(restored.data.state).toBe('running')
  })
}, 60000)

test('under a fence, a principal outside the allowlist is refused, and a second allowed principal observes but cannot cancel', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await admitLiveRun(harness)
    const composition = harness.composition
    harness.state.product = harness.fenceBody()

    await expectRefused(
      composition.service.status(
        harness.read('pi-durable.lead.status', { dispatchId }, outsiderPrincipal),
        outsiderPrincipal
      ),
      'PI_LEAD_SCOPE_REJECTED'
    )
    await expectRefused(
      composition.service.cancel(
        harness.envelope(
          'pi-durable.lead.cancel',
          { dispatchId },
          'live-fence:outsider',
          outsiderPrincipal
        ),
        outsiderPrincipal
      ),
      'PI_LEAD_SCOPE_REJECTED'
    )

    const observed = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }, secondAllowedPrincipal),
      secondAllowedPrincipal
    )
    expect(observed.data.state).toBe('running')
    await expectRefused(
      composition.service.cancel(
        harness.envelope(
          'pi-durable.lead.cancel',
          { dispatchId },
          'live-fence:second',
          secondAllowedPrincipal
        ),
        secondAllowedPrincipal
      ),
      'PI_LEAD_SCOPE_REJECTED'
    )
    const [record] = composition.adapter.journal.list()
    expect(record.state).toBe('running')
  })
}, 60000)

test('under a fence, prepare and dispatch are refused and start nothing', async () => {
  await withLiveHarness(async (harness) => {
    await admitLiveRun(harness)
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const starts = harness.state.starts
    await expectRefused(
      composition.service.dispatch(
        harness.envelope('pi-durable.lead.dispatch', { intentId }, 'live-fence:fenced-dispatch'),
        principal
      ),
      'PI_LEAD_UNAVAILABLE'
    )
    // This composition configures no preparation port, so prepare is refused before the authority
    // and nothing is written. The fence refusal of prepare itself is pinned at the authority level.
    await expectRefused(
      composition.service.prepare(
        harness.envelope('pi-durable.lead.prepare', { intentId }, 'live-fence:fenced-prepare'),
        principal
      ),
      'PI_LEAD_NOT_CONFIGURED'
    )
    expect(harness.state.starts).toBe(starts)
  })
}, 60000)

test('a retained receipt that no longer matches its admission, request, or handle is refused before any effect', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await admitLiveRun(harness)
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const original = harness.receiptRecord(dispatchId)
    const other = `sha256:${'d'.repeat(64)}`
    const tampers = [
      ['admission digest', { admissionDigest: other }],
      ['start digest', { startDigest: other }],
      ['deadline', { deadlineAt: '2026-10-08T09:30:00.000Z' }],
      ['allowed principals', { allowedPrincipalIds: ['svc_adea'] }],
      [
        'handle',
        { handle: { ...original.handle, externalSessionId: 'ses_01JABCDEF0123456789ABCDEFX' } },
      ],
    ]
    const starts = harness.state.starts
    for (const [label, change] of tampers) {
      harness.writeReceiptRecord(dispatchId, { ...original, ...change })
      await expectRefused(
        composition.service.status(
          harness.read('pi-durable.lead.status', { dispatchId }),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      expect(label.length).toBeGreaterThan(0)
    }
    expect(harness.state.starts).toBe(starts)
    harness.writeReceiptRecord(dispatchId, original)
    const restored = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }),
      principal
    )
    expect(restored.data.state).toBe('running')
  })
}, 60000)

test('the fence is rechecked after each awaited effect, and a changed fence withholds the response', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await admitLiveRun(harness)
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const adapter = composition.adapter
    const realStatus = adapter.status.bind(adapter)
    adapter.status = async (handle) => {
      const result = await realStatus(handle)
      // The fence changes while the status effect was awaited.
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
      return result
    }
    try {
      await expectRefused(
        composition.service.status(
          harness.read('pi-durable.lead.status', { dispatchId }),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    } finally {
      adapter.status = realStatus
    }

    harness.state.product = harness.fenceBody()
    const realCancelFenced = adapter.cancelFenced.bind(adapter)
    adapter.cancelFenced = async (handle, input, authorize) => {
      const result = await realCancelFenced(handle, input, authorize)
      harness.state.product = harness.fenceBody({
        scopeRef: `adea-product:sha256:${'f'.repeat(64)}`,
      })
      return result
    }
    try {
      await expectRefused(
        composition.service.cancel(
          harness.envelope('pi-durable.lead.cancel', { dispatchId }, 'live-fence:recheck'),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    } finally {
      adapter.cancelFenced = realCancelFenced
    }
  })
}, 60000)
