// TEST ONLY: disposable child-process fixture for the Pi lead crash/restart proof (#1025).
// Builds the production `createNodePiDurableLeadComposition` over real SQLite stores and the real
// Pi adapter. The model is a loopback scripted server that holds its first turn open until a gate
// is released. No provider, credential, or live resource is contacted. The fence fixture's
// constants are imported so both proofs use identical identities.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { VersionedCatalog } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteDurableUsageStore,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { SqliteVersionedCatalogRepository } from '@control-plane/sqlite-persistence/catalog'
import { createPiDurableEngine } from '@control-plane/pi-durable-adapter'
import { DurableUsageLedger, PinnedModelPrice } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createNodePiDurableLeadComposition } from '../../../apps/control-api/src/pi-durable/node-composition.ts'
import { deterministicPiLeadIntentIds } from '../../../apps/control-api/src/pi-durable/node-admission.ts'
import {
  at,
  canonicalActor,
  deferred,
  expiresAt,
  intentId,
  principal,
} from '../../../apps/control-api/src/pi-durable/lead-fence-live-harness.mjs'

const STATE_FILE = 'restart-fixture-state.json'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const payloadHash = (value) =>
  createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`

/** Loopback scripted model. Its first answer streams one delta, then waits on `gate`. Requests
 * and streams are counted so a test can prove that nothing was resent after a restart. */
export function startScriptedModel({ gateOpen = false } = {}) {
  const encoder = new TextEncoder()
  const counts = { requests: 0, streamsStarted: 0, streamsAborted: 0 }
  const gate = deferred()
  if (gateOpen) gate.resolve()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 })
      counts.requests += 1
      await request.json()
      const first = {
        id: 'restart-proof-chat',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'scripted-1',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'Restart proof' }, finish_reason: null },
        ],
      }
      const last = {
        id: 'restart-proof-chat',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'scripted-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }
      const body = new ReadableStream({
        async start(controller) {
          counts.streamsStarted += 1
          controller.enqueue(encoder.encode(chunk(first)))
          await gate.promise
          controller.enqueue(encoder.encode(chunk(last) + 'data: [DONE]\n\n'))
          controller.close()
        },
        cancel() {
          counts.streamsAborted += 1
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    counts,
    release: () => gate.resolve(),
    stop: () => server.stop(true),
  }
}

/** The same intent envelope shape the production dispatch service accepts. */
export function dispatchEnvelope(operation, payload, idempotencyKey) {
  return {
    caller: { servicePrincipalId: principal.principalId },
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
}

/** Opens the production composition on `directory`. `seed` publishes the profile, context, and plan
 * and writes the product evidence to the fixture state file. A reopen reads that evidence back and
 * refuses any new admission, so a restarted process can only adopt what was already retained. */
export async function openRestartComposition(options) {
  const {
    directory,
    createPersistenceProvider = (providerOptions) => new SqlitePersistenceProvider(providerOptions),
  } = options
  const persistence = createPersistenceProvider({ path: join(directory, 'cp-state.sqlite') })
  try {
    return await openRestartCompositionWithPersistence(persistence, options)
  } catch (primaryFailure) {
    const cleanupFailures = await closeRestartResources(undefined, persistence)
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        'Pi lead restart fixture initialization and cleanup failed',
        { cause: primaryFailure }
      )
    }
    throw primaryFailure
  }
}

async function openRestartCompositionWithPersistence(
  persistence,
  {
    directory,
    seed,
    baseUrl,
    reconcileInference = async () => 'unresolved',
    holdBeforeNativeDispatch = false,
    onNativeDispatchBoundary = async () => {},
    createLeadComposition = createNodePiDurableLeadComposition,
  }
) {
  await persistence.migrate()
  const repositories = {
    executions: new SqliteExecutionRepository(persistence),
    plans: new SqliteExecutionPlanRepository(persistence),
    commands: new SqliteCommandAcceptanceRepository(persistence, { budgetAdmission: true }),
    catalog: new SqliteVersionedCatalogRepository(persistence),
    usage: new SqliteDurableUsageStore(persistence),
  }
  const statePath = join(directory, STATE_FILE)
  let evidence
  let plan
  let resolvePlanCalls = 0
  if (seed) {
    const inputs = createExecutionPlanTestFixtureInputs()
    inputs.profile.definition.skills = []
    inputs.profile.definition.capabilityRequirements = []
    inputs.skills = []
    const ids = deterministicPiLeadIntentIds(inputs.correlation.workspaceId, intentId)
    inputs.correlation.requestId = ids.requestId
    const catalog = new VersionedCatalog(repositories.catalog, repositories.catalog)
    await catalog.createAgentProfile({
      profileId: inputs.profile.profileId,
      displayName: 'Restart proof fixture',
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
      messageRef: 'message:restart-proof',
      authorityRevision: 7,
      principalRef: 'lead:one',
      canonicalActorPrincipalId: canonicalActor,
      scopeRef: `adea-product:sha256:${'c'.repeat(64)}`,
      expiresAt,
      allowedPrincipalIds: ['svc_adea', 'svc_pi-admission'],
      selectionRef: `msel_${'a'.repeat(32)}`,
      selectionRevision: 1,
      prompt: 'Restart proof question',
      profileVersionId: plan.profile.profileVersionId,
      profileContentDigest: plan.profile.contentDigest,
    }
    await writeFile(statePath, JSON.stringify({ evidence }))
  } else {
    evidence = JSON.parse(await readFile(statePath, 'utf8')).evidence
    // Recovery re-reads the persisted plan through the validator. Anything that needs the
    // compiled plan again is a new admission, which the restart proof must not perform.
  }
  const budget = new DurableRuntimeBudgetAdmission({
    commands: repositories.commands,
    store: repositories.usage,
  })
  const price = new PinnedModelPrice(
    {
      schemaVersion: 1,
      deploymentId: 'local-restart-proof',
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
  const composition = await createLeadComposition({
    directory,
    engineFactory: async (engineOptions) => {
      let requestId
      const engine = createPiDurableEngine({
        ...engineOptions,
        authorizeInference: async (request) => {
          const allowance = await engineOptions.authorizeInference(request)
          const inferenceKey = `${requestId}:${request.inferenceId}`
          await onNativeDispatchBoundary(inferenceKey)
          if (seed && holdBeforeNativeDispatch) await new Promise(() => {})
          return allowance
        },
      })
      return {
        ...engine,
        async run(request) {
          requestId = request.requestId
          return engine.run(request)
        },
      }
    },
    admission: {
      product: {
        readCurrent: async (input) =>
          input.intentId === intentId && input.workspaceId === evidence.workspaceId
            ? structuredClone(evidence)
            : undefined,
      },
      resolvePlan: async () => {
        resolvePlanCalls += 1
        if (!plan) throw new Error('RESTART_PROOF_NEW_ADMISSION_NOT_EXPECTED')
        return plan
      },
      plans: repositories.plans,
      commandRepository: repositories.commands,
      planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
        catalog: { profiles: repositories.catalog, skills: repositories.catalog },
      }),
      executions: repositories.executions,
      budgetAdmission: {
        reserve: async (input) => budget.reserve(input),
      },
      admissionPrincipalId: 'svc_pi-admission',
      now: () => at,
    },
    usage: {
      ledger: new DurableUsageLedger({ store: repositories.usage, now: () => at }),
      resolvePrice: async () => ({ price, maximumOutputTokens: 24 }),
      assertSpendingAuthorized: async () => ({
        authorizationRef: 'model-spend:restart-proof',
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
                name: 'Scripted restart proof HTTP',
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
  return {
    composition,
    evidence,
    get resolvePlanCalls() {
      return resolvePlanCalls
    },
    async close() {
      const failures = await closeRestartResources(composition, persistence)
      if (failures.length > 0)
        throw new AggregateError(failures, 'Pi lead restart fixture close failed')
    },
  }
}

async function closeRestartResources(composition, persistence) {
  const failures = []
  for (const resource of [composition, persistence]) {
    if (resource === undefined) continue
    try {
      await resource.close()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}
