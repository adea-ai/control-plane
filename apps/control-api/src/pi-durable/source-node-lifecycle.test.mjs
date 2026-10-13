import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
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
import { createProductionSourceNodeComposition } from './source-node-composition.ts'
import { createProductionSourceLeadProductAuthority } from '../models/production-source-lead-product.ts'
import { ContextPackageCompiler } from '@control-plane/context'
import { piLeadConversationAgentContextRef } from '@control-plane/contracts'
import { DatabaseSync } from 'node:sqlite'
import { deterministicPiLeadIntentIds } from './node-admission.ts'

const at = '2026-10-08T09:00:00.000Z'
const expiresAt = '2026-10-08T10:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const payloadHash = (value) =>
  createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')

async function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('PI_NODE_TEST_PORT_UNAVAILABLE'))
        return
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

// Local HTTP Models transport and scripted verified product/spending ports.
// The Pi engine, source candidate composition, SQLite stores, catalog and ledger are real.
// Host/source/funding authority ports are synthetic. This proves lifecycle plumbing only, not physical source-tool effects, production fences or live grants/providers.
test('candidate source composition retains host/source pins through prepare, native dispatch, progress, restart and revoked reads with synthetic authority/funding ports', async () => {
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
    port: await availableLoopbackPort(),
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
  let persistence, composition, plan, evidence, ids, sourceDatabase, sourceProduct, sourceAuthority
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
    projectIds: [],
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
  }
  const envelope = (operation, payload) => ({
    caller: { servicePrincipalId: principal.principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId: id('wsp'),
    correlation: { traceId: id('trc') },
    commandId: operation === 'pi-durable.lead.prepare' ? `cmd_${'9'.repeat(26)}` : id('cmd'),
    idempotencyKey: `source-candidate:${operation}`,
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
    if (sourceDatabase) {
      sourceDatabase.close()
      sourceDatabase = undefined
    }
    if (persistence) {
      await persistence.close()
      persistence = undefined
    }
  }
  const open = async () => {
    repositories = await openPersistence()
    sourceDatabase = new DatabaseSync(join(directory, 'source-product.sqlite'))
    sourceProduct = createProductionSourceLeadProductAuthority({
      database: sourceDatabase,
      now: () => at,
      target: {
        location: 'remote_host',
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        providerBinding: 'pi_durable_models',
      },
      product: {
        readCurrent: async () => {
          state.productReads++
          return { authority: sourceAuthority, prompt: 'Canonical node question', expiresAt }
        },
      },
      assertHostService: async (input) => {
        expect(input.workspaceId).toBe(sourceAuthority.host.workspaceId)
        expect(input.principalId).toBe(principal.principalId)
        if (state.revoked) throw new Error('SYNTHETIC_HOST_REVOKED')
      },
      assertSourceAuthority: async (input) => {
        expect(input.workspaceId).toBe(sourceAuthority.source.workspaceId)
        expect(input.canonicalActorPrincipalId).toBe(sourceAuthority.host.canonicalActorPrincipalId)
        if (state.revoked) throw new Error('SYNTHETIC_SOURCE_REVOKED')
      },
      withCurrentAuthorization: async (_input, accept) => {
        // Same-realm synthetic fence for this focused test, not production qualification.
        if (state.revoked) throw new Error('SYNTHETIC_AUTHORITY_REVOKED')
        return accept()
      },
      profiles: {
        resolveImmutable: async (input) => {
          expect(input.workspaceId).toBe(plan.correlation.workspaceId)
          const version = await repositories.catalog.getAgentProfileVersion(
            plan.profile.profileVersionId
          )
          expect(version.profileId).toBe(sourceAuthority.source.profileId)
          return {
            ...input,
            profileVersionId: version.profileVersionId,
            profileContentDigest: version.contentDigest,
          }
        },
      },
      selections: {
        select: async (input) => {
          expect(input.workspaceId).toBe(sourceAuthority.source.workspaceId)
          return { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
        },
        resolveSelection: async (input) => {
          expect(input.workspaceId).toBe(sourceAuthority.source.workspaceId)
          return input
        },
        assertReady: async () => {
          if (state.revoked) throw new Error('SYNTHETIC_MODEL_REVOKED')
        },
      },
    })
    evidence = await sourceProduct.readCurrent({
      schemaVersion: 'pi-lead-intent/v1',
      workspaceId: sourceAuthority.source.workspaceId,
      intentId,
      principalId: principal.principalId,
    })
    const scopeAuthority = {
      readCurrent: async (input) =>
        state.revoked
          ? undefined
          : {
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
              allowedPrincipalIds: [
                sourceAuthority.host.canonicalActorPrincipalId,
                'svc_pi-admission',
              ],
              expiresAt,
            },
    }
    composition = await createProductionSourceNodeComposition({
      directory,
      sourceProduct,
      transportPrincipalId: principal.principalId,
      assertHostContext: async (current, authority) => {
        expect(authority).toEqual(sourceAuthority)
        const context = await new SqliteContextPackageRepository(persistence).get(
          current.contextPackage
        )
        expect(context.objective).toBe('Canonical node question')
        expect(context.stateItems).toEqual([])
        expect(context.artifactRefs).toEqual([])
      },
      preparationAuthority: {
        readFunding: async (admission) => ({
          schemaVersion: 'model-funding-display/v1',
          workspaceId: sourceAuthority.source.workspaceId,
          executionId: admission.admittedAttempt.executionId,
          attemptId: admission.admittedAttempt.attemptId,
          selectionRef: evidence.selectionRef,
          selectionRevision: evidence.selectionRevision,
          state: 'ready',
          provider: 'scripted-http',
          providerModel: 'scripted-1',
          accountRef: 'synthetic:source-account',
          authKind: 'api_key',
          fundingSource: 'hq_managed',
          fundingOwner: {
            ownerRef: 'synthetic:source-payer',
            kind: 'workspace_account',
            displayName: 'Synthetic existing test payer',
            revision: 1,
            evidenceRef: 'synthetic:source-payer-record',
          },
          authorizationRef: 'synthetic:source-funding',
          authorityRevision: 1,
          expiresAt,
        }),
        releaseExpired: async () => {},
      },
      admission: {
        scopeAuthority,
        assertProviderReady: async ({ evidence: current }) => {
          expect(current.workspaceId).toBe(sourceAuthority.source.workspaceId)
          expect(current.selectionRef).toBe(evidence.selectionRef)
          if (state.revoked) throw new Error('SYNTHETIC_PROVIDER_REVOKED')
        },
        resolvePlan: async () => plan,
        plans: repositories.plans,
        commandRepository: repositories.commands,
        planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
          catalog: { profiles: repositories.catalog, skills: repositories.catalog },
          scopeAuthority,
          now: () => at,
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
      ownership: { scope: 'workspace', workspaceId: inputs.correlation.workspaceId },
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
    delete inputs.correlation.projectId
    inputs.correlation.executionScope = { schemaVersion: 1, kind: 'workspace' }
    const priorContext = inputs.contextPackage
    inputs.contextPackage = new ContextPackageCompiler('1.0.0').compileWorkspace({
      workspaceId: inputs.correlation.workspaceId,
      executionScope: inputs.correlation.executionScope,
      revision: 1,
      objective: 'Canonical node question',
      artifacts: [],
      permissions: [],
      constraints: priorContext.constraints,
      successCriteria: priorContext.successCriteria,
      returnContract: priorContext.returnContract,
      budgets: priorContext.budgets,
      compiledAt: at,
    })
    await new SqliteContextPackageRepository(persistence).put(inputs.contextPackage)
    plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    const uuid = (char) =>
      `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(12)}`
    sourceAuthority = {
      schemaVersion: 'pi-lead-host-source-authority/v1',
      intentId,
      host: {
        workspaceId: `wsp_${'9'.repeat(26)}`,
        productWorkspaceId: uuid('2'),
        conversationId: uuid('3'),
        conversationVersion: 1,
        messageId: uuid('4'),
        messageVersion: 1,
        canonicalActorPrincipalId: `user:${uuid('5')}`,
        audienceDigest: `sha256:${'a'.repeat(64)}`,
        enlistmentGrantId: 'synthetic:source-enlistment',
        enlistmentRevision: 1,
      },
      source: {
        workspaceId: plan.correlation.workspaceId,
        productWorkspaceId: uuid('6'),
        agentId: plan.correlation.agentId,
        productAgentId: uuid('7'),
        profileId: plan.profile.profileId,
        profileVersion: String(plan.profile.version),
        profileRevision: plan.profile.revision,
      },
      contextRef: '',
    }
    sourceAuthority.contextRef = piLeadConversationAgentContextRef(sourceAuthority)
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
    const prepared = (
      await composition.service.prepare(
        envelope('pi-durable.lead.prepare', { intentId }),
        principal
      )
    ).data
    expect(prepared.executionId).toBe(ids.executionId)
    expect(state.requests).toHaveLength(0)
    expect(await composition.readRetainedSourceExecutionBinding(intentId)).toBeUndefined()
    const dispatch = envelope('pi-durable.lead.dispatch', {
      intentId,
      preparationRef: prepared.preparationRef,
    })
    const first = (await composition.service.dispatch(dispatch, principal)).data
    expect(first).toMatchObject({
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      replayed: false,
    })
    await composition.adapter.drain()
    const sourceBinding = await composition.readRetainedSourceExecutionBinding(intentId)
    expect(sourceBinding.authority).toEqual(sourceAuthority)
    expect(sourceBinding.runtimeSessionId).toBe(first.runtimeSessionId)
    expect(sourceBinding.profileVersionId).toBe(plan.profile.profileVersionId)
    expect(sourceBinding.selectionRef).toBe(evidence.selectionRef)
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
    expect(await composition.readRetainedSourceExecutionBinding(intentId)).toEqual(sourceBinding)
    state.revoked = true
    await expect(composition.service.status(statusRequest, principal)).rejects.toThrow(
      'PI_LEAD_UNAVAILABLE'
    )
    await expect(composition.service.dispatch(dispatch, principal)).rejects.toThrow(
      'PI_LEAD_UNAVAILABLE'
    )
    expect(state.requests).toHaveLength(1)
    const reads = state.productReads
    expect(await composition.readRetainedSourceExecutionBinding(intentId)).toEqual(sourceBinding)
    expect(state.productReads).toBe(reads)
  } finally {
    await close()
    providerServer.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
