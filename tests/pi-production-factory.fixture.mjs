// TEST ONLY: actual production factory/canonical SQLite/native Pi; authority and transport are scripted.
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFileRecordedModelFundingAuthority } from '@control-plane/model-gateway'
import {
  canonicalJsonStringify,
  StateChangingCommandEnvelopeSchema,
} from '@control-plane/contracts'
import { ContextPackageCompiler } from '@control-plane/context'
import { VersionedCatalog } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqlitePersistenceProvider,
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteCommandAcceptanceRepository,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { SqliteVersionedCatalogRepository } from '@control-plane/sqlite-persistence/catalog'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { createProductionPiLeadComposition } from '../apps/control-api/src/models/production-model-composition.ts'
import { createProductionProductHttpReader } from '../apps/control-api/src/models/production-product-http.ts'
import { createUnusedPiLeadAllocationReleaser } from '../apps/control-api/src/pi-durable/unused-lead-allocation.ts'
import {
  createProductionFactoryModels,
  ProductionFactoryModelTarget,
} from './pi-production-factory-models.fixture.mjs'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const digest = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
const exactText = 'Actual production factory answer\n'
/** No ambient network fallback. Native Models/credential/ledger checks still wrap this transport. */
function scriptedPhysicalFetch(state) {
  return async (url, options) => {
    const request = new Request(url, options)
    if (
      new URL(request.url).origin !== 'https://api.openai.com' ||
      new URL(request.url).pathname !== '/v1/responses'
    )
      throw new Error('TEST_UNEXPECTED_EGRESS')
    const body = await request.json()
    if (body.model !== 'gpt-5') throw new Error('TEST_UNEXPECTED_MODEL')
    state.physicalSends++
    const item = {
      type: 'message',
      id: 'msg_fixture',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: exactText, annotations: [] }],
    }
    const events = [
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: exactText },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ]
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
}

export async function createProductionFactoryFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-real-production-factory-'))
  const at = new Date().toISOString()
  const expiresAt = new Date(Date.parse(at) + 240_000).toISOString()
  const workspaceId = options.workspaceId ?? id('wsp')
  const actorPrincipalId = options.actorPrincipalId ?? `user:${randomUUID()}`
  if (!/^user:[0-9a-f-]{36}$/.test(actorPrincipalId))
    throw new Error('TEST_ORIGINAL_ACTOR_REQUIRED')
  const transportPrincipalId = options.transportPrincipalId ?? 'svc_factory-proof'
  const leasePrincipalRef = 'svc_factory-model-lease'
  const principal = {
    kind: 'agent_hq_service',
    principalId: transportPrincipalId,
    workspaceIds: [workspaceId],
    projectIds: [],
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
  }
  const state = {
    physicalSends: 0,
    productReads: 0,
    publicationChecks: 0,
    revoked: false,
    publicationRevoked: false,
  }
  const source = new Map(),
    plansByIntent = new Map(),
    records = new Map()
  const originalFetch = globalThis.fetch
  let persistence, composition, models
  let fetchInstalled = false
  let closing
  const close = () =>
    (closing ??= (async () => {
      try {
        await composition?.close()
      } finally {
        try {
          await persistence?.close()
        } finally {
          if (fetchInstalled) globalThis.fetch = originalFetch
          await rm(directory, { recursive: true, force: true })
        }
      }
    })())
  try {
    persistence = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
    await persistence.migrate()
    const repositories = {
      executions: new SqliteExecutionRepository(persistence),
      plans: new SqliteExecutionPlanRepository(persistence),
      commands: new SqliteCommandAcceptanceRepository(persistence, { budgetAdmission: true }),
      catalog: new SqliteVersionedCatalogRepository(persistence),
      usage: new SqliteDurableUsageStore(persistence),
    }
    const ledger = new DurableUsageLedger({ store: repositories.usage, now: () => at })
    const base = createExecutionPlanTestFixtureInputs({
      profileCapabilityRequirements: [],
      skillRequiredCapabilities: [],
    })
    // The real native resolver retains the pinned catalog context window. The synthetic
    // quote/allowance must cover that conservative bound; do not shrink native metadata.
    const nativeContextWindow = openaiProvider()
      .getModels()
      .find((model) => model.id === 'gpt-5').contextWindow
    base.constraints.limits.tokens.maximumTotal = nativeContextWindow + 24
    base.profile.definition.executionConstraints = structuredClone(base.constraints)
    base.profile.definition.skills = []
    base.skills = []
    const catalog = new VersionedCatalog(repositories.catalog, repositories.catalog)
    await catalog.createAgentProfile({
      profileId: base.profile.profileId,
      displayName: 'Synthetic production-factory profile',
      ownership: { scope: 'system' },
      createdAt: at,
    })
    const draft = await catalog.createAgentProfileDraft({
      profileId: base.profile.profileId,
      profileVersionId: base.profile.profileVersionId,
      version: base.profile.version,
      definition: base.profile.definition,
      createdAt: at,
    })
    base.profile = await catalog.publishAgentProfileVersion({
      profileVersionId: draft.profileVersionId,
      expectedRevision: draft.revision,
      publishedAt: at,
    })
    const productProfilePin = options.productProfilePin ?? {
      profileId: base.profile.profileId,
      profileVersion: String(base.profile.version),
      profileRevision: base.profile.revision,
    }
    models = await createProductionFactoryModels({
      persistence,
      workspaceId,
      actorPrincipalId,
      transportPrincipalId,
      leasePrincipalRef,
      policySnapshot: base.constraints.policySnapshot,
      now: () => at,
      expiresAt,
    })
    await models.setupDefault()
    let selection
    const fundingDirectory = join(directory, 'private-funding')
    await mkdir(fundingDirectory, { mode: 0o700 })
    const rawProduct = {
      readCurrent: async (input) => {
        state.productReads++
        if (
          state.revoked ||
          input.workspaceId !== workspaceId ||
          input.principalId !== transportPrincipalId
        )
          return undefined
        return options.productReader
          ? options.productReader.readCurrent(input)
          : structuredClone(source.get(input.intentId))
      },
    }
    // The production reader remains strict HTTPS/3 selectors. The optional injected test transport
    // may reach an owned real Adea handler; it is not HTTPS/deployment qualification.
    const product = options.productHttp
      ? createProductionProductHttpReader(options.productHttp)
      : rawProduct
    const scopeAuthority = {
      readCurrent: async (input) =>
        state.revoked
          ? undefined
          : {
              ...input,
              principalActive:
                input.callerPrincipalId === actorPrincipalId ||
                input.callerPrincipalId === 'svc_factory-admission',
              grantActive: true,
              allowedPrincipalIds: [actorPrincipalId, 'svc_factory-admission'],
              expiresAt,
            },
    }
    const resolvePlan = async (evidence, ids) => {
      selection = await models.repository.getSelection(workspaceId, evidence.selectionRef)
      if (!selection || selection.selectionRevision !== evidence.selectionRevision)
        throw new Error('TEST_SELECTION_REQUIRED')
      const prior = plansByIntent.get(evidence.intentId)
      if (prior) return prior
      if (
        evidence.canonicalActorPrincipalId !== actorPrincipalId ||
        evidence.workspaceId !== workspaceId
      )
        throw new Error('TEST_CURRENT_ACTOR_MISMATCH')
      const inputs = structuredClone(base)
      delete inputs.correlation.projectId
      inputs.correlation = {
        ...inputs.correlation,
        workspaceId,
        requestId: ids.requestId,
        executionScope: { schemaVersion: 1, kind: 'workspace' },
      }
      inputs.compiledAt = at
      inputs.contextPackage = new ContextPackageCompiler('1.0.0').compileWorkspace({
        workspaceId,
        executionScope: inputs.correlation.executionScope,
        revision: 1,
        objective: 'Synthetic actual production-factory proof',
        artifacts: [],
        permissions: [],
        constraints: inputs.contextPackage.constraints,
        successCriteria: inputs.contextPackage.successCriteria,
        returnContract: inputs.contextPackage.returnContract,
        budgets: inputs.contextPackage.budgets,
        compiledAt: at,
      })
      await new SqliteContextPackageRepository(persistence).put(inputs.contextPackage)
      const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
      await repositories.plans.put(plan)
      plansByIntent.set(evidence.intentId, plan)
      const binding = {
        schemaVersion: 'execution-model-selection/v1',
        workspaceId,
        executionId: ids.executionId,
        attemptId: ids.attemptId,
        requestId: ids.requestId,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
        executionPlanSchemaVersion: plan.schemaVersion,
        policySnapshotDigest: plan.policySnapshot.digest,
        principalRef: evidence.principalRef,
        canonicalActorPrincipalId: actorPrincipalId,
        leasePrincipalRef,
        modelAlias: 'reasoning.standard',
        authorityRevision: evidence.authorityRevision,
        selectionRef: evidence.selectionRef,
        selectionRevision: evidence.selectionRevision,
      }
      const price = {
        schemaVersion: 1,
        deploymentId: 'production-fixture-openai',
        provider: selection.provider,
        model: selection.providerModel,
        version: 'fixture-price:1',
        currency: 'USD',
        fundingSource: 'byo_api',
        validFrom: at,
        validUntil: expiresAt,
        maximumInputTokens: nativeContextWindow,
        maximumOutputTokens: 24,
        ratesMicrounitsPerMillionTokens: {
          input: 1_000_000,
          cachedInput: 500_000,
          output: 2_000_000,
        },
      }
      const fundingOwner = {
        ownerRef: 'payer:production-fixture',
        kind: 'provider_account',
        displayName: 'Synthetic explicit payer',
        revision: 1,
        evidenceRef: 'payer-evidence:fixture',
      }
      const decision = {
        schemaVersion: 'recorded-model-funding/v1',
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
        canonicalActorPrincipalId: actorPrincipalId,
        authorityRevision: evidence.authorityRevision,
        fundingOwner,
        price,
        grant: {
          schemaVersion: 1,
          authorizationId: `fixture-spend:${evidence.intentId}`,
          evidenceRef: `fixture-decision:${evidence.intentId}`,
          workspaceId,
          executionId: ids.executionId,
          attemptId: ids.attemptId,
          deploymentId: price.deploymentId,
          credentialRef: selection.credentialRef,
          principalRef: evidence.principalRef,
          alias: 'reasoning.standard',
          policySnapshotDigest: plan.policySnapshot.digest,
          currency: 'USD',
          fundingSource: 'byo_api',
          maximumMicrounits: plan.constraints.limits.budget.maximumMicrounits,
          maximumTokens: plan.constraints.limits.tokens.maximumTotal,
          issuedAt: at,
          expiresAt,
        },
      }
      const recordDirectory = join(fundingDirectory, workspaceId, ids.executionId),
        payerDirectory = join(fundingDirectory, workspaceId, 'payers')
      await mkdir(recordDirectory, { recursive: true, mode: 0o700 })
      await mkdir(payerDirectory, { recursive: true, mode: 0o700 })
      await writeFile(
        join(recordDirectory, `${ids.attemptId}.json`),
        JSON.stringify({
          schemaVersion: 'recorded-funding-host/v1',
          binding,
          decision,
          status: 'active',
          expiresAt,
        }),
        { mode: 0o600 }
      )
      await writeFile(
        join(
          payerDirectory,
          `${createHash('sha256').update(fundingOwner.ownerRef).digest('hex')}.json`
        ),
        JSON.stringify({
          schemaVersion: 'recorded-funding-payer/v1',
          workspaceId,
          authorizationRef: decision.grant.authorizationId,
          fundingOwner,
          status: 'active',
          expiresAt,
        }),
        { mode: 0o600 }
      )
      records.set(evidence.intentId, {
        binding,
        decision,
        recordPath: join(recordDirectory, `${ids.attemptId}.json`),
        payerPath: join(
          payerDirectory,
          `${createHash('sha256').update(fundingOwner.ownerRef).digest('hex')}.json`
        ),
      })
      return plan
    }
    const releaseExpired = createUnusedPiLeadAllocationReleaser({
      now: () => at,
      transaction: (workspace, operation) =>
        persistence.transaction((native) =>
          SqliteDurableUsageStore.withTransaction(native, workspace, (store) => {
            const bound = new Proxy(persistence, {
              get(target, key) {
                if (key === 'transaction') return (action) => action(native)
                const value = Reflect.get(target, key)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
            return operation({
              executions: new SqliteExecutionRepository(bound),
              ledger: new DurableUsageLedger({ store, now: () => at }),
            })
          })
        ),
    })
    const publicationFundingAuthority = createFileRecordedModelFundingAuthority({
      directory: fundingDirectory,
      now: () => at,
      currentExecutionAuthority: {
        assertCurrent: async (binding) => {
          const expected = [...records.values()].find(
            (record) => record.binding.attemptId === binding.attemptId
          )
          const current = await repositories.executions.getExecution(binding.executionId)
          if (
            state.revoked ||
            state.publicationRevoked ||
            !expected ||
            current?.latestAttemptId !== binding.attemptId ||
            canonicalJsonStringify(binding) !== canonicalJsonStringify(expected.binding)
          )
            throw new Error('TEST_PUBLICATION_DENIED')
        },
      },
    })
    globalThis.fetch = scriptedPhysicalFetch(state)
    fetchInstalled = true
    composition = await createProductionPiLeadComposition({
      directory,
      fundingDirectory,
      modelConnections: models.modelConnections,
      product,
      profiles: {
        resolveImmutable: async (pin) =>
          pin.workspaceId === workspaceId &&
          pin.profileId === productProfilePin.profileId &&
          pin.profileVersion === productProfilePin.profileVersion &&
          pin.profileRevision === productProfilePin.profileRevision
            ? {
                ...pin,
                profileVersionId: base.profile.profileVersionId,
                profileContentDigest: base.profile.contentDigest,
              }
            : undefined,
      },
      readiness: {
        target: ProductionFactoryModelTarget,
        gateway: {
          assertRequestReady: async (request) => {
            if (state.revoked || request.selection.selectionRef !== selection.selectionRef)
              throw new Error('TEST_MODEL_NOT_READY')
          },
        },
        buildRequest: async (input, current) => ({
          modelCallId: id('mdc'),
          requestId: input.ids.requestId,
          executionId: input.ids.executionId,
          attemptId: input.ids.attemptId,
          workspaceId,
          principalRef: input.actorPrincipalId,
          alias: 'reasoning.standard',
          messages: [{ role: 'user', content: 'Synthetic readiness only' }],
          settings: { maxOutputTokens: 24, temperature: 0, timeoutMs: 1000 },
          requirement: input.plan.constraints.models[0],
          policySnapshot: input.plan.policySnapshot,
          traceId: id('trc'),
          fundingSource: current.fundingSource,
          selection: current,
          routing: { entitlements: [], maxCostClass: 'premium', estimatedInputTokens: 1 },
        }),
      },
      admission: {
        resolvePlan,
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
        admissionPrincipalId: 'svc_factory-admission',
        scopeAuthority,
        now: () => at,
      },
      ledger,
      reconcileInference: async () => 'unresolved',
      releaseExpired,
      leasePrincipalRef,
      modelAlias: 'reasoning.standard',
      publicationAuthority: async (binding, reader) => {
        state.publicationChecks++
        const expected = records.get(binding.intentId)
        const execution = await repositories.executions.getExecution(binding.executionId)
        if (
          state.revoked ||
          state.publicationRevoked ||
          reader.principalId !== transportPrincipalId ||
          !expected ||
          binding.canonicalActorPrincipalId !== actorPrincipalId ||
          execution.latestAttemptId !== binding.attemptId ||
          ['workspaceId', 'executionId', 'attemptId', 'selectionRef', 'selectionRevision'].some(
            (key) => binding[key] !== expected.binding[key]
          )
        )
          throw new Error('TEST_PUBLICATION_DENIED')
        const fresh = await publicationFundingAuthority.readCurrent(expected.binding)
        if (canonicalJsonStringify(fresh) !== canonicalJsonStringify(expected.decision))
          throw new Error('TEST_PUBLICATION_DENIED')
        return { authorityRevision: 1, expiresAt: new Date(Date.parse(at) + 30_000).toISOString() }
      },
    })
    const command = (operation, payload) =>
      StateChangingCommandEnvelopeSchema.parse({
        contractVersion: { major: 1, minor: 0 },
        caller: { servicePrincipalId: transportPrincipalId },
        requestId: id('req'),
        workspaceId,
        correlation: { traceId: id('trc') },
        commandId: `cmd_01J${createHash('sha256')
          .update(operation + canonicalJsonStringify(payload))
          .digest('hex')
          .slice(0, 23)
          .toUpperCase()}`,
        idempotencyKey: `factory:${operation}:${digest(payload)}`,
        payloadHash: digest(payload).slice(7),
        operation,
        issuedAt: at,
        payload,
      })
    const read = (operation, parameters) => ({
      contractVersion: { major: 1, minor: 0 },
      caller: { servicePrincipalId: transportPrincipalId },
      requestId: id('req'),
      workspaceId,
      correlation: { traceId: id('trc') },
      operation,
      requestedAt: at,
      parameters,
    })
    return {
      composition,
      directory,
      principal,
      state,
      models,
      get selection() {
        return selection
      },
      ledger,
      repositories,
      records,
      exactText,
      at,
      expiresAt,
      canonicalCounts: () => {
        const db = new DatabaseSync(join(directory, 'canonical.sqlite'), { readOnly: true })
        try {
          const rows = Object.fromEntries(
            db
              .prepare(
                'SELECT namespace, COUNT(*) AS count FROM control_plane_records GROUP BY namespace'
              )
              .all()
              .map((row) => [row.namespace, Number(row.count)])
          )
          return {
            commands: rows['command-inbox'] ?? 0,
            executions: rows.executions ?? 0,
            attempts: rows['execution-attempts'] ?? 0,
            budgets: rows['usage-budgets'] ?? 0,
            usage: rows['usage-ledger-entries'] ?? 0,
          }
        } finally {
          db.close()
        }
      },
      profile: base.profile,
      productProfilePin,
      workspaceId,
      actorPrincipalId,
      command,
      read,
      close,
      setIntent: (intentId = randomUUID()) => {
        source.set(intentId, {
          schemaVersion: 'pi-lead-intent/v1',
          intentId,
          workspaceId,
          messageRef: `message:${intentId}`,
          authorityRevision: 1,
          principalRef: actorPrincipalId,
          canonicalActorPrincipalId: actorPrincipalId,
          scopeRef: `scope:${intentId}`,
          expiresAt,
          allowedPrincipalIds: [transportPrincipalId],
          prompt: 'Synthetic actual factory question',
          ...productProfilePin,
        })
        return intentId
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
