import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
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
import { createPiDurableEngine } from '@control-plane/pi-durable-adapter'
import { deterministicPiLeadIntentIds } from './node-admission.ts'

// Shared live fixture for the M18.01.3 fence tests: a production lead composition over real SQLite,
// a real Pi adapter, and a scripted model transport whose turn is genuinely held open. Test code
// observes the composition through the same ports production uses; it never rewrites journal state.
// This fixture explicitly qualifies its own product/deadline writers with the native SDK fence.
// It does not install production wiring or establish complete external writer/generation coverage.

export const at = '2026-10-08T09:00:00.000Z'
export const expiresAt = '2026-10-08T10:00:00.000Z'
export const afterExpiry = '2026-10-08T10:00:01.000Z'
export const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
export const actorUserId = '2b1a7e26-8c3f-4f4f-9a1e-77d19b7d5e11'
export const canonicalActor = `user:${actorUserId}`
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const payloadHash = (value) =>
  createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
export const principal = {
  kind: 'agent_hq_service',
  principalId: 'svc_adea',
  workspaceIds: [id('wsp')],
  projectIds: [id('prj')],
  scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
}
export const secondAllowedPrincipal = { ...principal, principalId: 'svc_pi-admission' }
export const outsiderPrincipal = { ...principal, principalId: 'svc_other' }

export function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

export async function waitUntil(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`LIVE_FIXTURE_TIMEOUT:${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`

export function createLiveHarness(directory, { scoped = false, preparation = false } = {}) {
  const state = {
    requests: [],
    streamsStarted: 0,
    streamsAborted: 0,
    gate: deferred(),
    clock: at,
    product: undefined,
    productReads: 0,
    starts: 0,
    budgetReserves: 0,
    fundingReads: 0,
    preparationReleases: 0,
    bindingRead: undefined,
    authorityRequest: undefined,
    armedBindingSnapshot: undefined,
    armedAfterBindingValidation: undefined,
    armedAfterCancelAuthorization: undefined,
    scopeReads: 0,
    armedScope: undefined,
    // The provider's answer when reconciliation probes a cancelled turn that may have reached it.
    reconcileDecision: 'unresolved',
    reconcileCalls: 0,
  }
  const nativeOwners = new Map()
  let publishedProduct
  let mutationOrdinal = 0
  let writerQueue = Promise.resolve()
  let pendingWrites = 0
  let writerFailed = false

  // R is published only after every explicitly live fixture owner's native F ACK.
  // The initial/no-owner case describes this disposable fixture only: it is not
  // a global empty-writer assertion or permission for an external canonical R.
  async function installFixtureFences(mutationId) {
    const acknowledged = new Set()
    for (;;) {
      const pending = [...nativeOwners.values()].filter((owner) => !acknowledged.has(owner))
      if (pending.length === 0) return
      await Promise.all(
        pending.map(async (owner) => {
          await owner.installFence({ mutationId })
          acknowledged.add(owner)
        })
      )
    }
  }
  function enqueueFixtureMutation(kind, publish) {
    const mutationId = `live-fixture:${kind}:${++mutationOrdinal}`
    pendingWrites += 1
    writerQueue = writerQueue
      .then(async () => {
        await installFixtureFences(mutationId)
        await publish()
      })
      .catch((error) => {
        writerFailed = true
        throw error
      })
      .finally(() => {
        pendingWrites -= 1
      })
    // A synchronous property setter cannot return the promise. Preserve its
    // rejection for every flush without an unhandled-rejection side channel.
    void writerQueue.catch(() => {})
    return writerQueue
  }
  async function flushFixtureMutations() {
    for (;;) {
      const pending = writerQueue
      await pending
      if (pending === writerQueue) return
    }
  }
  Object.defineProperty(state, 'product', {
    enumerable: true,
    get: () => publishedProduct,
    set(value) {
      const next = structuredClone(value)
      if (nativeOwners.size === 0 && pendingWrites === 0 && !writerFailed) {
        publishedProduct = next
        return
      }
      enqueueFixtureMutation('product', () => {
        publishedProduct = next
      })
    },
  })
  const encoder = new TextEncoder()
  const providerServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 })
      state.requests.push(await request.json())
      // The model answers its first delta at once, then holds the turn open until the test
      // releases the gate or the client aborts. The run is in flight for the whole hold.
      const gate = state.gate
      const first = {
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
      }
      const last = {
        id: 'live-fence-chat',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'scripted-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }
      const body = new ReadableStream({
        async start(controller) {
          state.streamsStarted += 1
          controller.enqueue(encoder.encode(chunk(first)))
          await gate.promise
          controller.enqueue(encoder.encode(chunk(last) + 'data: [DONE]\n\n'))
          controller.close()
        },
        cancel() {
          state.streamsAborted += 1
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
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
  let persistence, repositories, composition, plan, evidence, scopeAuthority
  let realGetExecution

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
    get plan() {
      return plan
    },
    get evidence() {
      return evidence
    },
    get ids() {
      return deterministicPiLeadIntentIds(plan.correlation.workspaceId, intentId)
    },
    /** The v2 fence facts Adea publishes; each pin matches the retained admission by default. */
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
    /** The lead admission database holds the receipts; the adapter journal is a separate file. */
    receiptRecord(dispatchId) {
      const database = new DatabaseSync(join(directory, 'lead-admission.sqlite'))
      try {
        return JSON.parse(
          database
            .prepare('SELECT record FROM pi_lead_receipts WHERE dispatch_id = ?')
            .get(dispatchId).record
        )
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
    /** Preparation rows and command bindings, for proving what a refused command wrote. */
    leadTableCounts() {
      const database = new DatabaseSync(join(directory, 'lead-admission.sqlite'))
      try {
        const count = (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
        return {
          receipts: count('pi_lead_receipts'),
          commands: count('pi_lead_commands'),
          intents: count('pi_lead_intent_admissions'),
        }
      } finally {
        database.close()
      }
    },
    /** Runs `action` at a named retained binding checkpoint in the next service operation. */
    armBindingSnapshot(phase, sample, action) {
      if (!['lookup', 'pre-effect', 'post-effect'].includes(phase))
        throw new Error('LIVE_FIXTURE_BINDING_PHASE_INVALID')
      if (!['initial', 'final'].includes(sample))
        throw new Error('LIVE_FIXTURE_BINDING_SAMPLE_INVALID')
      state.armedBindingSnapshot = { phase, sample, action }
    },
    /** Runs after a named binding validation returns, before its caller's next authority read. */
    armAfterBindingValidation(phase, action) {
      if (!['lookup', 'pre-effect', 'post-effect'].includes(phase))
        throw new Error('LIVE_FIXTURE_BINDING_PHASE_INVALID')
      state.armedAfterBindingValidation = { phase, action }
    },
    /** Runs after the selected service authorization returns, before the adapter's next step. */
    armAfterCancelAuthorization(action, checkpoint = 'first') {
      if (!['first', 'final'].includes(checkpoint))
        throw new Error('LIVE_FIXTURE_CANCEL_AUTHORIZATION_CHECKPOINT_INVALID')
      state.armedAfterCancelAuthorization = { action, checkpoint }
    },
    /** Runs `action` during the next scope-authority read of the adapter. */
    armScopeRead(action) {
      state.armedScope = action
    },
    /** Native queued-input race probes; available only in this explicit qualification fixture. */
    async queueNativeInputForQualification(input) {
      if (nativeOwners.size !== 1) throw new Error('LIVE_FIXTURE_NATIVE_OWNER_AMBIGUOUS')
      return [...nativeOwners.values()][0].queueInputForQualification(input)
    },
    async nativeQueuedInputIdsForQualification() {
      if (nativeOwners.size !== 1) throw new Error('LIVE_FIXTURE_NATIVE_OWNER_AMBIGUOUS')
      return [...nativeOwners.values()][0].queuedInputIdsForQualification()
    },
    /** Moves the retained execution's own deadline; the dispatch-time deadline no longer matches. */
    async setExecutionDeadline(deadlineAt) {
      await enqueueFixtureMutation('deadline', async () => {
        const current = structuredClone(await realGetExecution(harness.ids.executionId))
        const expectedVersion = current.version
        current.deadlineAt = deadlineAt
        current.version += 1
        current.updatedAt = at
        if (!(await repositories.executions.compareAndSetExecution(expectedVersion, current)))
          throw new Error('LIVE_FIXTURE_EXECUTION_DEADLINE_CONFLICT')
      })
    },
    /** The execution's current attempt, read without the armed hook. */
    async latestAttemptId() {
      return (await realGetExecution(harness.ids.executionId)).latestAttemptId
    },
    /**
     * Tries to move the latest-attempt pointer with a bare compare-and-set, outside the lifecycle.
     * Resolves false when the store refuses, which is the guard being demonstrated.
     */
    async moveLatestAttemptBypassingLifecycle(attemptId) {
      const current = structuredClone(await realGetExecution(harness.ids.executionId))
      const expectedVersion = current.version
      current.latestAttemptId = attemptId
      current.version += 1
      current.updatedAt = at
      return repositories.executions.compareAndSetExecution(expectedVersion, current)
    },
    /**
     * REPRODUCTION PRECONDITION, not production behavior. Settles a dispatched run's runtime-attempt
     * reservation through the production ledger, the call a supersession needs. No production path
     * settles it for a dispatched run (unused-lead-allocation settles only undispatched ones), so the
     * qualification test performs this step itself and says so.
     */
    async settleRuntimeAttemptForReproduction(attemptId) {
      const ledger = new DurableUsageLedger({ store: repositories.usage, now: () => at })
      await ledger.settle({
        workspaceId: evidence.workspaceId,
        executionId: harness.ids.executionId,
        reservationKey: `runtime-attempt:${attemptId}`,
        source: {
          sourceId: attemptId,
          idempotencyKey: `runtime-attempt:${attemptId}:reproduction-settle`,
        },
      })
    },
    /** A later accepted attempt for the same execution, created through the lifecycle service. */
    async supersedeAttempt(attemptId) {
      const execution = await realGetExecution(harness.ids.executionId)
      await new ExecutionLifecycleService(repositories.executions).createAttempt({
        executionId: harness.ids.executionId,
        attemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: at,
        ...(execution.deadlineAt === undefined ? {} : { deadlineAt: execution.deadlineAt }),
      })
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
      if (scoped)
        inputs.correlation.executionScope = {
          schemaVersion: 1,
          kind: 'project',
          projectId: inputs.correlation.projectId,
        }
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
      scopeAuthority = {
        readCurrent: async (input) => {
          state.scopeReads += 1
          if (state.armedScope) {
            const action = state.armedScope
            state.armedScope = undefined
            await action()
            await flushFixtureMutations()
          }
          return {
            workspaceId: plan.correlation.workspaceId,
            executionScope: plan.correlation.executionScope,
            callerPrincipalId: input.callerPrincipalId,
            executionPlan: {
              executionPlanId: plan.executionPlanId,
              contentDigest: plan.contentDigest,
              schemaVersion: plan.schemaVersion,
            },
            principalActive: true,
            grantActive: true,
            allowedPrincipalIds: [canonicalActor, 'svc_pi-admission'],
            expiresAt,
            projectWorkspaceId: plan.correlation.workspaceId,
          }
        },
      }
      await closeOpened()
    },
    async open() {
      repositories = await openPersistence()
      realGetExecution = repositories.executions.getExecution.bind(repositories.executions)
      const realGetAttempt = repositories.executions.getAttempt.bind(repositories.executions)
      const finishAuthorityRead = async (bindingRead, sample) => {
        if (!bindingRead || !sample) return
        bindingRead.completed[sample] += 1
        if (bindingRead.completed[sample] !== 2) return
        const armed = state.armedBindingSnapshot
        if (armed?.phase === bindingRead.phase && armed.sample === sample) {
          state.armedBindingSnapshot = undefined
          await armed.action()
          await flushFixtureMutations()
        }
      }
      repositories.executions.getExecution = async (executionId) => {
        const bindingRead = state.bindingRead
        const offset = bindingRead?.started ?? 4
        if (bindingRead) bindingRead.started += 1
        const sample = offset < 2 ? 'initial' : offset < 4 ? 'final' : undefined
        const value = await realGetExecution(executionId)
        await finishAuthorityRead(bindingRead, sample)
        return value
      }
      repositories.executions.getAttempt = async (attemptId) => {
        const bindingRead = state.bindingRead
        const offset = bindingRead?.started ?? 4
        if (bindingRead) bindingRead.started += 1
        const sample = offset < 2 ? 'initial' : offset < 4 ? 'final' : undefined
        const value = await realGetAttempt(attemptId)
        await finishAuthorityRead(bindingRead, sample)
        return value
      }
      const budget = new DurableRuntimeBudgetAdmission({
        commands: repositories.commands,
        store: repositories.usage,
      })
      composition = await createNodePiDurableLeadComposition({
        directory,
        engineFactory: (options) =>
          createPiDurableEngine({
            ...options,
            nativeCancellationQualification: {
              now: () => state.clock,
              onOwnerReady(owner) {
                nativeOwners.set(owner.sessionId, owner)
              },
              onOwnerClosed(sessionId) {
                nativeOwners.delete(sessionId)
              },
            },
          }),
        admission: {
          product: {
            readCurrent: async (input) => {
              await flushFixtureMutations()
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
            ...(scoped ? { scopeAuthority, now: () => state.clock } : {}),
          }),
          executions: repositories.executions,
          budgetAdmission: {
            reserve: async (input) => {
              state.budgetReserves += 1
              return budget.reserve(input)
            },
          },
          admissionPrincipalId: 'svc_pi-admission',
          now: () => state.clock,
          ...(scoped ? { scopeAuthority, assertProviderReady: async () => {} } : {}),
        },
        ...(preparation
          ? {
              preparationAuthority: {
                readFunding: async (lead) => {
                  state.fundingReads += 1
                  // The funding disclosure the configured model selection is priced against.
                  return {
                    schemaVersion: 'model-funding-display/v1',
                    state: 'ready',
                    workspaceId: evidence.workspaceId,
                    executionId: lead.admittedAttempt.executionId,
                    attemptId: lead.admittedAttempt.attemptId,
                    selectionRef: evidence.selectionRef,
                    selectionRevision: evidence.selectionRevision,
                    provider: 'scripted-http',
                    providerModel: 'scripted-1',
                    accountRef: 'account:test',
                    authKind: 'api_key',
                    fundingSource: 'byo_api',
                    fundingOwner: {
                      ownerRef: 'payer:test',
                      kind: 'provider_account',
                      displayName: 'Test payer',
                      revision: 1,
                      evidenceRef: 'payer-evidence:test',
                    },
                    authorizationRef: 'authorization:test',
                    authorityRevision: 1,
                    expiresAt,
                  }
                },
                releaseExpired: async () => {
                  state.preparationReleases += 1
                },
              },
            }
          : {}),
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
        reconcileInference: async () => {
          state.reconcileCalls += 1
          return state.reconcileDecision
        },
      })
      const realAssertFencedBinding = composition.admission.assertFencedBinding.bind(
        composition.admission
      )
      composition.admission.assertFencedBinding = async (input) => {
        const previous = state.bindingRead
        const request = state.authorityRequest
        const ordinal = request ? ++request.validationOrdinal : 0
        const phase = ordinal === 1 ? 'lookup' : ordinal === 2 ? 'pre-effect' : 'post-effect'
        state.bindingRead = {
          phase,
          started: 0,
          completed: { initial: 0, final: 0 },
        }
        try {
          const result = await realAssertFencedBinding(input)
          const armed = state.armedAfterBindingValidation
          if (armed?.phase === phase) {
            state.armedAfterBindingValidation = undefined
            await armed.action()
            await flushFixtureMutations()
          }
          return result
        } finally {
          state.bindingRead = previous
        }
      }
      for (const phase of ['status', 'progress', 'cancel']) {
        const realOperation = composition.service[phase].bind(composition.service)
        composition.service[phase] = async (...args) => {
          await flushFixtureMutations()
          const previous = state.authorityRequest
          state.authorityRequest = { phase, validationOrdinal: 0 }
          try {
            return await realOperation(...args)
          } finally {
            state.authorityRequest = previous
          }
        }
      }
      const realCancelFenced = composition.adapter.cancelFenced.bind(composition.adapter)
      composition.adapter.cancelFenced = async (handle, command, authorize) => {
        let authorizationCheckpoint = 0
        return realCancelFenced(handle, command, async (retained) => {
          const authoritySnapshot = await authorize(retained)
          authorizationCheckpoint += 1
          const checkpoint = authorizationCheckpoint === 1 ? 'first' : 'final'
          const armed = state.armedAfterCancelAuthorization
          if (armed?.checkpoint === checkpoint) {
            state.armedAfterCancelAuthorization = undefined
            await armed.action()
            await flushFixtureMutations()
          }
          return authoritySnapshot
        })
      }
      const realStart = composition.adapter.start.bind(composition.adapter)
      composition.adapter.start = async (request) => {
        state.starts += 1
        return realStart(request)
      }
      return composition
    },
    /** Dispatches one run through the production service and waits until its model turn is held open. */
    async admitInFlightRun() {
      state.gate = deferred()
      await harness.open()
      // With the preparation path configured, dispatch consumes a preparation made through prepare.
      const payload = { intentId }
      if (preparation) {
        const prepared = await composition.service.prepare(
          harness.envelope('pi-durable.lead.prepare', { intentId }, 'live-fence:prepare'),
          principal
        )
        payload.preparationRef = prepared.data.preparationRef
      }
      const dispatched = (
        await composition.service.dispatch(
          harness.envelope('pi-durable.lead.dispatch', payload, 'live-fence:dispatch'),
          principal
        )
      ).data
      await waitUntil(
        () => state.streamsStarted >= 1 && state.requests.length >= 1,
        'model turn held open'
      )
      const [record] = composition.adapter.journal.list()
      if (record.state !== 'running') throw new Error('LIVE_FIXTURE_RUN_NOT_RUNNING')
      return { dispatchId: dispatched.dispatchId, preparationRef: payload.preparationRef, record }
    },
    async close() {
      // A held model turn must end before its composition can drain.
      state.gate.resolve()
      await closeOpened()
    },
    stop() {
      providerServer.stop(true)
    },
  }

  async function closeOpened() {
    const failures = []
    try {
      await flushFixtureMutations()
    } catch (error) {
      failures.push(error)
    }
    // Failed F/queued R must remain a test failure, but must not leak a native
    // owner or persistence handle while the disposable fixture is torn down.
    if (composition) {
      const closing = composition
      composition = undefined
      try {
        await closing.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (persistence) {
      const closing = persistence
      persistence = undefined
      repositories = undefined
      try {
        await closing.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'LIVE_FIXTURE_CLOSE_FAILED')
  }

  return harness
}

/** Runs one scenario on a fresh fixture: setup, the scenario, then release, drain, and removal. */
export async function withLiveHarness(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-fence-live-'))
  const harness = createLiveHarness(directory, options)
  try {
    await harness.setup()
    await run(harness)
  } finally {
    await harness.close()
    harness.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
