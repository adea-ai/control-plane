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
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
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
const principal = {
  kind: 'agent_hq_service',
  principalId: 'svc_adea',
  workspaceIds: [id('wsp')],
  projectIds: [id('prj')],
  scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
}

// Port failures injected at the executions reads that canonical authority performs.
const failures = {
  transport: () => new Error('connect ECONNRESET 127.0.0.1:5432 secret-store-token'),
  typedUnavailable: () =>
    new RuntimeAdapterError({
      code: 'PI_EXECUTION_STORE_UNAVAILABLE',
      classification: 'unavailable',
      message: 'PI_EXECUTION_STORE_UNAVAILABLE',
      retryable: true,
    }),
  // A caller-controlled string is not proof of a denial.
  forgedDenialString: () => new Error('PI_CANONICAL_AUTHORITY_REJECTED'),
}

// Only canonical executions reads fail. Every other store call reaches the real SQLite store.
function faultyExecutions(executions, failure) {
  return new Proxy(executions, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'getExecution' || property === 'getAttempt')
        return async () => {
          throw failure()
        }
      return value.bind(target)
    },
  })
}

/** Concrete lead composition with real SQLite stores, canonical admission and a local HTTP model
 * transport. Verified product, budget and spending ports are scripted. */
async function createNodeHarness(directory) {
  const state = { requests: [] }
  const providerServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 })
      state.requests.push(await request.json())
      const chunks = [
        {
          id: 'classification-chat',
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
          id: 'classification-chat',
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
  let persistence, repositories, composition, plan, evidence, ids
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
  const ledger = () => new DurableUsageLedger({ store: repositories.usage, now: () => at })
  const envelope = (operation, payload) => ({
    caller: { servicePrincipalId: principal.principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId: id('wsp'),
    projectId: id('prj'),
    correlation: { traceId: id('trc') },
    commandId: id('cmd'),
    idempotencyKey: 'classification-transport:one',
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
  const harness = {
    state,
    principal,
    envelope,
    read,
    get composition() {
      return composition
    },
    get repositories() {
      return repositories
    },
    get ids() {
      return ids
    },
    /** Catalog, plan, and verified product intent, written through a short-lived store. */
    async setup() {
      await openPersistence()
      repositories = undefined
      const storage = {
        executions: new SqliteExecutionRepository(persistence),
        plans: new SqliteExecutionPlanRepository(persistence),
        catalog: new SqliteVersionedCatalogRepository(persistence),
      }
      const inputs = createExecutionPlanTestFixtureInputs()
      inputs.profile.definition.skills = []
      inputs.profile.definition.capabilityRequirements = []
      inputs.skills = []
      ids = deterministicPiLeadIntentIds(inputs.correlation.workspaceId, intentId)
      inputs.correlation.requestId = ids.requestId
      const catalog = new VersionedCatalog(storage.catalog, storage.catalog)
      await catalog.createAgentProfile({
        profileId: inputs.profile.profileId,
        displayName: 'Classification node fixture',
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
        messageRef: 'message:classification-node',
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
      await harness.close()
    },
    /** Opens the production composition. `executionsFailure` injects a port failure into the
     * canonical executions reads only. Recovery runs during open, as in production. */
    async open({ executionsFailure, reconcileInference = async () => 'unresolved' } = {}) {
      repositories = await openPersistence()
      const executions = executionsFailure
        ? faultyExecutions(repositories.executions, executionsFailure)
        : repositories.executions
      composition = await createNodePiDurableLeadComposition({
        directory,
        admission: {
          product: {
            readCurrent: async (input) =>
              input.intentId === intentId && input.workspaceId === evidence.workspaceId
                ? evidence
                : undefined,
          },
          resolvePlan: async () => plan,
          plans: repositories.plans,
          commandRepository: repositories.commands,
          planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
            catalog: { profiles: repositories.catalog, skills: repositories.catalog },
          }),
          executions,
          budgetAdmission: new DurableRuntimeBudgetAdmission({
            commands: repositories.commands,
            store: repositories.usage,
          }),
          admissionPrincipalId: 'svc_pi-admission',
          now: () => at,
        },
        usage: {
          ledger: ledger(),
          resolvePrice: async () => ({ price, maximumOutputTokens: 24 }),
          assertSpendingAuthorized: async () => ({
            authorizationRef: 'model-spend:scripted-trusted-record',
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
        reconcileInference,
      })
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

// Admit one lead execution through the production service so a real run record exists.
async function admitCompletedRun(node) {
  await node.open()
  const dispatch = node.envelope('pi-durable.lead.dispatch', { intentId })
  const first = (await node.composition.service.dispatch(dispatch, node.principal)).data
  await node.composition.adapter.drain()
  const [record] = node.composition.adapter.journal.list()
  return { first, record }
}

// Recovery must consult canonical authority for the retained run, so the control-plane execution
// and attempt are reactivated first, while the composition is open and nothing is yet retained.
async function reactivateExecution(node) {
  const executions = node.repositories.executions
  const execution = structuredClone(await executions.getExecution(node.ids.executionId))
  const expectedExecutionVersion = execution.version
  delete execution.terminalAt
  delete execution.terminalResultRef
  delete execution.failure
  execution.state = 'running'
  execution.version += 1
  execution.updatedAt = at
  if (!(await executions.compareAndSetExecution(expectedExecutionVersion, execution)))
    throw new Error('TEST_EXECUTION_REACTIVATION_CONFLICT')
  const attempt = structuredClone(await executions.getAttempt(node.ids.attemptId))
  const expectedAttemptVersion = attempt.version
  delete attempt.terminalAt
  delete attempt.terminalResultRef
  delete attempt.failure
  attempt.state = 'running'
  attempt.version += 1
  if (!(await executions.compareAndSetAttempt(expectedAttemptVersion, attempt)))
    throw new Error('TEST_ATTEMPT_REACTIVATION_CONFLICT')
}

// Retain the run as interrupted, as an owner that stopped mid-turn leaves it. Completion-only
// fields are removed: an interrupted record never carries a result or terminal usage.
function retainRunning(node, record) {
  const detail = { ...record.detail, inferencePending: true }
  delete detail.result
  delete detail.terminalUsage
  node.composition.adapter.journal.update(record.handleId, record.epoch, {
    state: 'running',
    detail,
  })
  return node.composition.adapter.journal.get(record.handleId)
}

async function withNode(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-canonical-classification-'))
  const node = await createNodeHarness(directory)
  try {
    await node.setup()
    await run(node)
  } finally {
    await node.close()
    node.stop()
    await rm(directory, { recursive: true, force: true })
  }
}

test.each([
  ['transport', failures.transport, 'PI_RECOVERY_UNCLASSIFIED'],
  ['typed unavailable', failures.typedUnavailable, 'PI_RECOVERY_UNAVAILABLE'],
  ['forged denial string', failures.forgedDenialString, 'PI_RECOVERY_UNCLASSIFIED'],
])(
  'canonical %s outage during recovery fails closed, persists nothing, and resumes on a healthy startup',
  async (_label, failure, code) => {
    await withNode(async (node) => {
      const { record } = await admitCompletedRun(node)
      await reactivateExecution(node)
      const retained = retainRunning(node, record)
      await node.close()
      const requestsBefore = node.state.requests.length
      await node.open({ executionsFailure: failure })
      expect(node.composition.recoveryBlocked).toEqual([{ handleId: record.handleId, code }])
      expect(node.composition.adapter.journal.get(record.handleId)).toEqual(retained)
      expect(node.state.requests).toHaveLength(requestsBefore)
      expect(JSON.stringify(node.composition.recoveryBlocked)).not.toContain('secret-store-token')
      await node.close()
      await node.open({ reconcileInference: async () => 'safe_to_resume' })
      await node.composition.adapter.drain()
      expect(node.composition.recoveryBlocked).toEqual([])
      expect(node.composition.adapter.journal.get(record.handleId).state).toBe('completed')
      expect(
        node.composition.adapter.journal.get(record.handleId).detail.recoveryBlocked
      ).toBeUndefined()
    })
  },
  60000
)

test('an explicit canonical lifecycle denial persists the revocation marker under the claim and starts nothing', async () => {
  await withNode(async (node) => {
    // The control plane cancels the execution, so canonical lifecycle denies the retained run's
    // authority. That denial is an explicit policy decision, not a port failure.
    const { record } = await admitCompletedRun(node)
    await reactivateExecution(node)
    const lifecycle = new ExecutionLifecycleService(node.repositories.executions)
    const execution = await node.repositories.executions.getExecution(node.ids.executionId)
    await lifecycle.transitionExecution({
      executionId: node.ids.executionId,
      expectedVersion: execution.version,
      to: 'cancelled',
      transitionedAt: at,
    })
    const retained = retainRunning(node, record)
    await node.close()
    const requestsBefore = node.state.requests.length
    await node.open()
    expect(node.composition.recoveryBlocked).toEqual([
      { handleId: record.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    ])
    expect(node.composition.adapter.journal.get(record.handleId)).toEqual({
      ...retained,
      epoch: retained.epoch + 2,
      detail: { ...retained.detail, recoveryBlocked: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    })
    expect(node.state.requests).toHaveLength(requestsBefore)
  })
}, 60000)

test('a canonical outage at admission fails closed with no runtime record or model call, and a healthy retry admits the same intent', async () => {
  await withNode(async (node) => {
    await node.open({ executionsFailure: failures.transport })
    const dispatch = node.envelope('pi-durable.lead.dispatch', { intentId })
    await expect(node.composition.service.dispatch(dispatch, node.principal)).rejects.toThrow(
      'PI_LEAD_UNAVAILABLE'
    )
    expect(node.composition.adapter.journal.list()).toEqual([])
    expect(node.state.requests).toHaveLength(0)
    await node.close()
    await node.open()
    const admitted = (await node.composition.service.dispatch(dispatch, node.principal)).data
    await node.composition.adapter.drain()
    expect(admitted).toMatchObject({ executionId: node.ids.executionId, replayed: false })
    expect(node.state.requests).toHaveLength(1)
  })
}, 60000)
