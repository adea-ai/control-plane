// TEST ONLY. Executable local candidate host, never imported by production startup.
// Real Nest auth/routes, canonical CP admission, SQLite, ledger and Pi Harness;
// synthetic bearer/product/spending evidence and scripted loopback provider.
import 'reflect-metadata'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { VersioningType } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify/adapters/fastify-adapter.js'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  PublicContractManifest,
} from '@control-plane/contracts'
import { ContextPackageCompiler } from '@control-plane/context'
import { VersionedCatalog } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { createPiExecutionBoundModelComposition } from '@control-plane/pi-durable-adapter'
import { RecordedModelFundingDecisionSchema } from '@control-plane/model-gateway'
import {
  SqlitePersistenceProvider,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteExecutionRepository,
  SqliteCommandAcceptanceRepository,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { SqliteVersionedCatalogRepository } from '@control-plane/sqlite-persistence/catalog'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { z } from 'zod'
import { createSqliteCandidateModelStore } from '../models/sqlite-candidate-model-store.fixture.mjs'
import { createCurrentModelConnectionComposition } from '../models/current-model-composition.ts'
import { createSelectedModelHostBridge } from '../models/selected-model-host-bridge.fixture.mjs'
import { ModelConnectionsController } from '../models/model-connections.controller.ts'
import {
  ConfiguredModelConnectionService,
  MODEL_CONNECTION_SERVICE,
} from '../models/model-connections.service.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import { NormalizedExceptionFilter } from '../http/errors.ts'
import { PiDurableLeadModule } from './pi-durable-lead.module.ts'
import { createNodePiDurableLeadComposition } from './node-composition.ts'
import { createUnusedPiLeadAllocationReleaser } from './unused-lead-allocation.ts'
import { createCanonicalModelHostComposition } from '../models/canonical-model-composition.ts'
import { createPiLeadModelProductAuthority } from './model-product-authority.ts'
import {
  deterministicPiLeadIntentIds,
  VerifiedPiLeadIntentEvidenceSchema,
} from './node-admission.ts'

const fixtureId = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const hash = (value) => createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')

export async function startSelectedModelCandidateHost(options = {}) {
  if (options.workspaceScope !== true || options.prepareFunding !== true)
    throw new Error('SELECTED_MODEL_OPT_IN_REQUIRED')
  const directory = await mkdtemp(join(tmpdir(), 'pi-node-candidate-'))
  const at = new Date().toISOString()
  const expiresAt = new Date(Date.parse(at) + 3_600_000).toISOString()
  const workspaceId = IdentifierSchemas.workspaceId.parse(options.workspaceId ?? fixtureId('wsp'))
  // An explicitly declared CP project fixture, never derived from an Adea workspace.
  const explicitProjectId = IdentifierSchemas.projectId.parse(
    options.explicitProjectId ?? fixtureId('prj')
  )
  const principalId = 'svc_pi-candidate-test'
  const testCredential = 'pi-candidate-test-only-service-credential'
  const principal = {
    kind: 'agent_hq_service',
    principalId,
    workspaceIds: [workspaceId],
    projectIds: [explicitProjectId],
    scopes: [
      'execution:accept',
      'execution:read',
      'execution:cancel',
      'credential:read',
      'credential:write',
    ],
  }
  const productEvidence = new Map()
  const plansByIntent = new Map()
  const recordedDecisions = new Map()
  const selectionsByIntent = new Map()
  const credentialRef = fixtureId('crd')
  const target = {
    location: 'remote_host',
    harness: 'pi_durable',
    harnessVersion: '1.1.0',
    providerBinding: 'pi_durable_models',
  }
  const state = {
    providerRequests: [],
    modelsResolutions: 0,
    productReads: 0,
    spendingReads: 0,
    planResolutions: 0,
    revoked: false,
    scopeFault: undefined,
    fundingRevision: 1,
    fixtureCredentialUses: 0,
    fixtureCredentialCallbacksCompleted: 0,
    modelsCallbacksCompleted: 0,
  }
  let app, composition, persistence, inspection, providerServer, fundingDatabase, canonicalModelHost
  let beforeSendGate
  const holdBeforePhysicalSend = () => {
    if (beforeSendGate) throw new Error('CANDIDATE_SEND_GATE_BUSY')
    let release, entered
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const reached = new Promise((resolve) => {
      entered = resolve
    })
    beforeSendGate = { pending, reached, release, entered }
    return reached
  }
  const releaseBeforePhysicalSend = () => {
    beforeSendGate?.release()
    beforeSendGate = undefined
  }
  let providerResponseGate
  const holdProviderResponse = () => {
    if (providerResponseGate) throw new Error('CANDIDATE_PROVIDER_GATE_BUSY')
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    providerResponseGate = { pending, release }
  }
  const releaseProviderResponse = () => {
    providerResponseGate?.release()
    providerResponseGate = undefined
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    releaseProviderResponse()
    releaseBeforePhysicalSend()
    try {
      if (app) await app.close()
    } finally {
      try {
        if (composition) await composition.close()
      } finally {
        inspection?.close()
        fundingDatabase?.close()
        if (persistence) await persistence.close()
        providerServer?.stop(true)
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
  try {
    providerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== '/v1/chat/completions')
          return new Response('not found', { status: 404 })
        const providerRequest = await request.json()
        state.providerRequests.push(providerRequest)
        await providerResponseGate?.pending
        const chunks = [
          {
            id: 'candidate-scripted-chat',
            object: 'chat.completion.chunk',
            created: 1,
            model: providerRequest.model,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'Candidate canonical answer' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'candidate-scripted-chat',
            object: 'chat.completion.chunk',
            created: 1,
            model: providerRequest.model,
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
    const modelBaseUrl = `http://127.0.0.1:${providerServer.port}/v1`
    const persistencePath = join(directory, 'cp-state.sqlite')
    persistence = new SqlitePersistenceProvider({ path: persistencePath })
    await persistence.migrate()
    inspection = new DatabaseSync(persistencePath, { readOnly: true })
    const repositories = {
      executions: new SqliteExecutionRepository(persistence),
      plans: new SqliteExecutionPlanRepository(persistence),
      commands: new SqliteCommandAcceptanceRepository(persistence, { budgetAdmission: true }),
      catalog: new SqliteVersionedCatalogRepository(persistence),
      usage: new SqliteDurableUsageStore(persistence),
    }
    const ledger = new DurableUsageLedger({ store: repositories.usage, now: () => at })
    const modelHolds = async (executionId) => {
      const budget = await repositories.usage.transaction(workspaceId, (transaction) =>
        transaction.getBudget(executionId)
      )
      return (budget?.reservations ?? []).flatMap((reservation) =>
        (reservation.modelRequests ?? []).map((hold) => ({
          modelCallId: hold.modelCallId,
          status: hold.status,
          maximumTokens: hold.maximumTokens,
          maximumMicrounits: hold.maximumMicrounits,
        }))
      )
    }
    const inputs = createExecutionPlanTestFixtureInputs()
    inputs.correlation.workspaceId = workspaceId
    inputs.correlation.projectId = explicitProjectId
    inputs.profile.definition.skills = []
    inputs.profile.definition.capabilityRequirements = []
    inputs.skills = []
    inputs.contextPackage = new ContextPackageCompiler('1.0.0').compile({
      objective: 'Test-only candidate CP project control',
      projectState: {
        schemaVersion: 1,
        workspaceId,
        projectId: explicitProjectId,
        revision: 1,
        items: [],
        createdAt: at,
        updatedAt: at,
      },
      expectedProjectStateRevision: 1,
      candidates: [],
      artifacts: [],
      constraints: inputs.contextPackage.constraints,
      permissions: [],
      successCriteria: inputs.contextPackage.successCriteria,
      returnContract: inputs.contextPackage.returnContract,
      budgets: inputs.contextPackage.budgets,
      compiledAt: at,
    })
    const catalog = new VersionedCatalog(repositories.catalog, repositories.catalog)
    await catalog.createAgentProfile({
      profileId: inputs.profile.profileId,
      displayName: 'Test-only candidate CP profile',
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
    // Actual persistent metadata API and inference resolve the SAME store.
    const leaseInputs = new Map()
    const modelMetadata = createCurrentModelConnectionComposition({
      repository: createSqliteCandidateModelStore(persistence, inspection),
      vault: {
        metadata: async (ref, workspace) => {
          if (ref !== credentialRef || workspace !== workspaceId)
            throw new Error('CANDIDATE_CREDENTIAL_MISSING')
          return {
            credentialId: credentialRef,
            workspaceId,
            provider: 'scripted-http',
            revision: 1,
            status: state.revoked ? 'revoked' : 'active',
            expiresAt,
          }
        },
        // Explicit synthetic callback transport; this does NOT qualify real vault custody.
        lease: async (input) => {
          if (
            state.revoked ||
            input.workspaceId !== workspaceId ||
            input.credentialId !== credentialRef ||
            input.expectedCredentialRevision !== 1
          )
            throw new Error('CANDIDATE_CREDENTIAL_REVOKED')
          const capabilityRef = `fixture-capability:${randomUUID()}`
          leaseInputs.set(capabilityRef, input)
          return { capabilityRef }
        },
        use: async (capabilityRef, scope, use) => {
          const lease = leaseInputs.get(capabilityRef)
          leaseInputs.delete(capabilityRef)
          if (
            !lease ||
            state.revoked ||
            scope.workspaceId !== workspaceId ||
            scope.resourceRef !== lease.resourceRef ||
            scope.operation !== 'model:invoke'
          )
            throw new Error('CANDIDATE_CREDENTIAL_REVOKED')
          state.fixtureCredentialUses++
          const result = z.json().parse(await use('synthetic-loopback-test-only'))
          state.fixtureCredentialCallbacksCompleted++
          return result
        },
      },
      currentAccountAuthority: {
        readCurrent: async (query) => {
          if (
            state.revoked ||
            query.workspaceId !== workspaceId ||
            query.credentialRef !== credentialRef ||
            query.credentialRevision !== 1
          )
            return undefined
          return {
            schemaVersion: 'model-account-authority/v1',
            evidenceRef: 'fixture-account-current:1',
            observedAt: query.requestedAt,
            expiresAt,
            workspaceId,
            credentialRef,
            credentialRevision: 1,
            provider: 'scripted-http',
            accountRef: 'candidate-account:provider',
            authKind: 'api_key',
            fundingSource: 'byo_api',
            models: ['fixture-model', 'fixture-model-small'],
            workspaceGrant: {
              grantRef: 'candidate-grant:scripted',
              revision: 1,
              status: 'active',
              expiresAt,
            },
            allowedPrincipalRefs: [principalId],
            targets: [target],
            entitlement: 'allowed',
            quota: 'available',
            residencyAllowed: true,
          }
        },
      },
      now: () => at,
    })
    const selectionBridge = createSelectedModelHostBridge({
      selections: modelMetadata.selections,
      target,
    })
    const runtimeSelection = true // This profile always requires explicit funding preparation.
    const fundingDirectory = join(directory, 'private-funding')
    if (runtimeSelection) await mkdir(fundingDirectory, { mode: 0o700 })
    const fundingPaths = new Map()
    const privateWrite = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 })
    const priceTemplate = {
      schemaVersion: 1,
      deploymentId: 'candidate-loopback',
      provider: 'scripted-http',
      model: 'unbound-price-template',
      version: 'candidate-price:1',
      currency: 'USD',
      fundingSource: 'byo_api',
      validFrom: at,
      validUntil: expiresAt,
      maximumInputTokens: 32768,
      maximumOutputTokens: 24,
      ratesMicrounitsPerMillionTokens: {
        input: 1_000_000,
        cachedInput: 500_000,
        output: 2_000_000,
      },
    }
    const registerIntentInternal = async (input) => {
      const intentId = z.uuid().parse(input.intentId)
      if (
        typeof input.canonicalActorPrincipalId !== 'string' ||
        !input.canonicalActorPrincipalId.startsWith('user:')
      )
        throw new Error('CANDIDATE_ORIGINAL_DB_ACTOR_REQUIRED')
      z.uuid().parse(input.canonicalActorPrincipalId.slice(5))
      // Null is intentional; callers must explicitly opt into the independent CP project fixture.
      const projectId = input.projectId ?? null
      if (projectId !== null && projectId !== explicitProjectId)
        throw new Error('CANDIDATE_EXPLICIT_CP_PROJECT_REQUIRED')
      if (input.workspaceId !== undefined && input.workspaceId !== workspaceId)
        throw new Error('CANDIDATE_WORKSPACE_MISMATCH')
      if (
        (input.profileVersionId !== undefined &&
          input.profileVersionId !== inputs.profile.profileVersionId) ||
        (input.profileContentDigest !== undefined &&
          input.profileContentDigest !== inputs.profile.contentDigest)
      )
        throw new Error('CANDIDATE_PIN_MISMATCH')
      const selection = await modelMetadata.selections.resolveSelection({
        workspaceId,
        selectionRef: input.selectionRef,
        selectionRevision: input.selectionRevision,
      })
      await modelMetadata.selections.assertReady(selection)
      const price = {
        ...priceTemplate,
        provider: selection.provider,
        model: selection.providerModel,
      }
      const evidence = VerifiedPiLeadIntentEvidenceSchema.parse({
        schemaVersion: 'pi-lead-intent/v1',
        intentId,
        workspaceId,
        projectId,
        messageRef: input.messageRef ?? `message:candidate:${intentId}`,
        authorityRevision: input.authorityRevision ?? 1,
        principalRef: input.principalRef ?? 'lead:candidate',
        canonicalActorPrincipalId: input.canonicalActorPrincipalId,
        scopeRef: input.scopeRef ?? `channel:candidate:${intentId}`,
        expiresAt,
        allowedPrincipalIds: [principalId],
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
        prompt: input.prompt ?? 'Canonical candidate question',
        profileVersionId: inputs.profile.profileVersionId,
        profileContentDigest: inputs.profile.contentDigest,
      })
      const prior = productEvidence.get(intentId)
      if (prior && hash(prior) !== hash(evidence)) throw new Error('CANDIDATE_INTENT_ID_CONFLICT')
      if (prior) return structuredClone(prior)
      const pinned = await selectionBridge.bindIntent({
        workspaceId,
        intentId,
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
      })
      if (canonicalJsonStringify(pinned) !== canonicalJsonStringify(selection))
        throw new Error('CANDIDATE_SELECTION_CHANGED')
      if (projectId !== null || options.workspaceScope === true) {
        const ids = deterministicPiLeadIntentIds(workspaceId, intentId)
        const perIntentInputs = structuredClone(inputs)
        if (projectId === null) {
          const { projectId: _projectId, ...correlation } = perIntentInputs.correlation
          perIntentInputs.correlation = {
            ...correlation,
            executionScope: { schemaVersion: 1, kind: 'workspace' },
          }
          perIntentInputs.contextPackage = new ContextPackageCompiler('1.0.0').compileWorkspace({
            workspaceId,
            executionScope: { schemaVersion: 1, kind: 'workspace' },
            revision: 1,
            objective: 'Test-only candidate workspace lead',
            artifacts: [],
            constraints: inputs.contextPackage.constraints,
            permissions: [],
            successCriteria: inputs.contextPackage.successCriteria,
            returnContract: inputs.contextPackage.returnContract,
            budgets: inputs.contextPackage.budgets,
            compiledAt: at,
          })
          await new SqliteContextPackageRepository(persistence).put(perIntentInputs.contextPackage)
        } else if (input.explicitProjectScope === true) {
          perIntentInputs.correlation.executionScope = {
            schemaVersion: 1,
            kind: 'project',
            projectId,
          }
        }
        perIntentInputs.constraints.models = perIntentInputs.constraints.models.map((model) =>
          model.alias === 'reasoning.standard' ? { ...model, fallback: 'none' } : model
        )
        perIntentInputs.correlation.requestId = ids.requestId
        perIntentInputs.compiledAt = at
        const plan = new ExecutionPlanCompiler('1.0.0').compile(perIntentInputs)
        await repositories.plans.put(plan)
        plansByIntent.set(intentId, plan)
        recordedDecisions.set(ids.attemptId, {
          executionPlanId: plan.executionPlanId,
          executionPlanDigest: plan.contentDigest,
          selectionRef: selection.selectionRef,
          selectionRevision: selection.selectionRevision,
          price,
          grant: {
            schemaVersion: 1,
            authorizationId: `candidate-spend:${intentId}`,
            evidenceRef: `candidate-decision:${intentId}`,
            workspaceId,
            executionId: ids.executionId,
            attemptId: ids.attemptId,
            deploymentId: price.deploymentId,
            credentialRef: selection.credentialRef,
            principalRef: evidence.principalRef,
            alias: 'reasoning.standard',
            policySnapshotDigest: plan.policySnapshot.digest,
            currency: 'USD',
            fundingSource: selection.fundingSource,
            maximumMicrounits: plan.constraints.limits.budget.maximumMicrounits,
            maximumTokens: plan.constraints.limits.tokens.maximumTotal,
            issuedAt: at,
            expiresAt,
          },
        })
        if (runtimeSelection && plan.schemaVersion === 2) {
          const binding = {
            schemaVersion: 'execution-model-selection/v1',
            workspaceId,
            executionId: ids.executionId,
            attemptId: ids.attemptId,
            requestId: plan.correlation.requestId,
            executionPlanId: plan.executionPlanId,
            executionPlanDigest: plan.contentDigest,
            executionPlanSchemaVersion: plan.schemaVersion,
            policySnapshotDigest: plan.policySnapshot.digest,
            principalRef: evidence.principalRef,
            canonicalActorPrincipalId: evidence.canonicalActorPrincipalId,
            leasePrincipalRef: 'svc_candidate-model-lease',
            modelAlias: 'reasoning.standard',
            authorityRevision: evidence.authorityRevision,
            selectionRef: selection.selectionRef,
            selectionRevision: selection.selectionRevision,
          }
          const fundingOwner = {
            ownerRef: `candidate-payer:${intentId}`,
            kind: 'provider_account',
            displayName: 'Synthetic scripted-provider payer',
            revision: state.fundingRevision,
            evidenceRef: `candidate-payer-evidence:${intentId}`,
          }
          const decision = {
            ...recordedDecisions.get(ids.attemptId),
            schemaVersion: 'recorded-model-funding/v1',
            canonicalActorPrincipalId: evidence.canonicalActorPrincipalId,
            authorityRevision: evidence.authorityRevision,
            fundingOwner,
          }
          const recordDirectory = join(fundingDirectory, workspaceId, ids.executionId)
          const payerDirectory = join(fundingDirectory, workspaceId, 'payers')
          await mkdir(recordDirectory, { recursive: true, mode: 0o700 })
          await mkdir(payerDirectory, { recursive: true, mode: 0o700 })
          const recordPath = join(recordDirectory, `${ids.attemptId}.json`)
          const payerPath = join(
            payerDirectory,
            `${createHash('sha256').update(fundingOwner.ownerRef).digest('hex')}.json`
          )
          const record = {
            schemaVersion: 'recorded-funding-host/v1',
            binding,
            decision,
            status: 'active',
            expiresAt,
          }
          const payer = {
            schemaVersion: 'recorded-funding-payer/v1',
            workspaceId,
            authorizationRef: decision.grant.authorizationId,
            fundingOwner,
            status: 'active',
            expiresAt,
          }
          await privateWrite(recordPath, record)
          await privateWrite(payerPath, payer)
          fundingPaths.set(intentId, { recordPath, payerPath, record, payer })
        }
      }
      selectionsByIntent.set(intentId, structuredClone(selection))
      productEvidence.set(intentId, evidence)
      return structuredClone(evidence)
    }
    const registrations = new Map()
    const registerIntent = (input) => {
      const intentId = z.uuid().parse(input.intentId)
      const previous = registrations.get(intentId) ?? Promise.resolve()
      const operation = previous.catch(() => {}).then(() => registerIntentInternal(input))
      registrations.set(intentId, operation)
      return operation.finally(() => {
        if (registrations.get(intentId) === operation) registrations.delete(intentId)
      })
    }
    const scopeAuthority = {
      async readCurrent(input) {
        const entry = [...plansByIntent.entries()].find(
          ([, plan]) => plan.executionPlanId === input.executionPlan.executionPlanId
        )
        if (!entry || state.revoked) return undefined
        const [intentId, plan] = entry
        const current = productEvidence.get(intentId)
        if (!current || !current.allowedPrincipalIds.includes(principalId)) return undefined
        if (
          ![current.canonicalActorPrincipalId, 'svc_candidate-admission'].includes(
            input.callerPrincipalId
          )
        )
          return undefined
        return {
          workspaceId:
            state.scopeFault === 'cross-workspace'
              ? fixtureId('wsp').replace(/G$/, 'H')
              : workspaceId,
          executionScope:
            state.scopeFault === 'cross-scope'
              ? { schemaVersion: 1, kind: 'project', projectId: explicitProjectId }
              : plan.correlation.executionScope,
          callerPrincipalId: input.callerPrincipalId,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest:
              state.scopeFault === 'stale-plan' ? `sha256:${'f'.repeat(64)}` : plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          principalActive: state.scopeFault !== 'inactive-principal',
          grantActive: state.scopeFault !== 'revoked-grant',
          allowedPrincipalIds:
            state.scopeFault === 'no-audience'
              ? []
              : [current.canonicalActorPrincipalId, 'svc_candidate-admission'],
          expiresAt: state.scopeFault === 'expired' ? at : expiresAt,
          ...(plan.correlation.projectId ? { projectWorkspaceId: workspaceId } : {}),
        }
      },
    }
    const product = {
      readCurrent: async (input) => {
        state.productReads++
        if (state.revoked || input.workspaceId !== workspaceId || input.principalId !== principalId)
          return undefined
        const retained = productEvidence.get(input.intentId)
        if (!retained) return undefined
        if (options.currentProductReader) {
          const current = await options.currentProductReader.readCurrent(input)
          if (!current) return undefined
          const parsed = VerifiedPiLeadIntentEvidenceSchema.safeParse(current)
          if (
            !parsed.success ||
            canonicalJsonStringify(parsed.data) !== canonicalJsonStringify(retained)
          )
            return undefined
          return parsed.data
        }
        // Explicit cached test evidence only; no late Adea DB authority claim.
        return structuredClone(retained)
      },
    }
    const readerFor = (admission, readerPrincipalId = principalId) => {
      const selection = selectionsByIntent.get(admission.intentId)
      if (!selection) throw new Error('CANDIDATE_SELECTION_MISSING')
      return {
        workspaceId,
        ...admission.admittedAttempt,
        principalId: readerPrincipalId,
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
      }
    }
    const bindingForAuthority = async (authority) =>
      canonicalModelHost.executionAuthority.resolveForReader({
        workspaceId,
        executionId: authority.request.executionId,
        attemptId: authority.request.attemptId,
        principalId,
        ...authority.admission.selection,
      })
    if (runtimeSelection) {
      fundingDatabase = new DatabaseSync(join(directory, 'model-funding-confirmations.sqlite'))
      fundingDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
      canonicalModelHost = createCanonicalModelHostComposition({
        canonical: {
          executions: repositories.executions,
          plans: repositories.plans,
          intents: {
            getByAttempt: (attempt) => composition.admission.store.getByAttempt(attempt),
            marker: (intent) => composition.admission.store.marker(intent),
          },
          product: createPiLeadModelProductAuthority({
            product,
            workspaceScope: {
              assertSupported: async () => {
                if (options.workspaceScope !== true || !scopeAuthority || !composition)
                  throw new Error('PI_LEAD_WORKSPACE_SCOPE_UNSUPPORTED')
                const runtimeInspection = await composition.adapter.inspect()
                if (
                  runtimeInspection.health !== 'healthy' ||
                  !runtimeInspection.capabilities.some(
                    (capability) =>
                      capability.name === 'execution.scope.workspace.v1' &&
                      capability.support === 'supported'
                  )
                )
                  throw new Error('PI_LEAD_WORKSPACE_SCOPE_UNSUPPORTED')
              },
            },
          }),
          scopeAuthority,
          leasePrincipalRef: 'svc_candidate-model-lease',
          modelAlias: 'reasoning.standard',
          now: () => new Date().toISOString(),
        },
        selections: modelMetadata.selections,
        fundingDirectory,
        database: fundingDatabase,
        now: () => new Date().toISOString(),
      })
    }
    const actualSpending = createPiExecutionBoundModelComposition({
      forExecution: (binding) => canonicalModelHost.forExecution(binding),
      currentExecutionAuthority: canonicalModelHost.confirmedExecutionAuthority,
      leasePrincipalRef: 'svc_candidate-model-lease',
      modelAlias: 'reasoning.standard',
      ledger,
      readRecordedDecision: async (authority) => {
        state.spendingReads++
        return RecordedModelFundingDecisionSchema.parse(
          await canonicalModelHost.fundingAuthority.readCurrent(
            await bindingForAuthority(authority)
          )
        )
      },
      now: () => new Date().toISOString(),
    })
    composition = await createNodePiDurableLeadComposition({
      directory,
      ...(options.prepareFunding === true
        ? {
            preparationAuthority: {
              readFunding: async (admission, reader) =>
                (
                  await canonicalModelHost.prepareForReader(
                    readerFor(admission, reader.principalId),
                    admission.deadlineAt
                  )
                ).funding,
              releaseExpired: createUnusedPiLeadAllocationReleaser({
                now: () => new Date().toISOString(),
                transaction: (workspace, operation) =>
                  persistence.transaction((native) =>
                    SqliteDurableUsageStore.withTransaction(native, workspace, (store) => {
                      const bound = new Proxy(persistence, {
                        get(nativeTarget, property) {
                          if (property === 'transaction') return (action) => action(native)
                          const value = Reflect.get(nativeTarget, property)
                          return typeof value === 'function' ? value.bind(nativeTarget) : value
                        },
                      })
                      return operation({
                        executions: new SqliteExecutionRepository(bound),
                        ledger: new DurableUsageLedger({ store }),
                      })
                    })
                  ),
              }),
            },
          }
        : {}),
      admission: {
        product,
        resolvePlan: async (evidence) => {
          state.planResolutions++
          const plan = plansByIntent.get(evidence.intentId)
          if (!plan) throw new Error('CANDIDATE_PLAN_MISSING')
          return plan
        },
        plans: repositories.plans,
        commandRepository: repositories.commands,
        planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
          catalog: { profiles: repositories.catalog, skills: repositories.catalog },
          ...(options.workspaceScope === true || runtimeSelection
            ? { scopeAuthority, now: () => at }
            : {}),
        }),
        ...(options.workspaceScope === true || runtimeSelection ? { scopeAuthority } : {}),
        ...(options.workspaceScope === true || runtimeSelection
          ? {
              assertProviderReady: async ({ evidence, plan, ids, actorPrincipalId }) => {
                const selection = await selectionBridge.resolveIntent({
                  workspaceId,
                  intentId: evidence.intentId,
                  selectionRef: evidence.selectionRef,
                  selectionRevision: evidence.selectionRevision,
                })
                if (
                  state.revoked ||
                  state.scopeFault === 'provider-revoked' ||
                  evidence.selectionRef !== selection.selectionRef ||
                  evidence.selectionRevision !== selection.selectionRevision ||
                  evidence.workspaceId !== selection.workspaceId ||
                  evidence.canonicalActorPrincipalId !== actorPrincipalId ||
                  plansByIntent.get(evidence.intentId)?.contentDigest !== plan.contentDigest ||
                  ids.attemptId !==
                    deterministicPiLeadIntentIds(workspaceId, evidence.intentId).attemptId ||
                  !plan.constraints.models.some((model) => model.alias === 'reasoning.standard')
                )
                  throw new Error('CANDIDATE_PROVIDER_NOT_READY')
              },
            }
          : {}),
        executions: repositories.executions,
        budgetAdmission: new DurableRuntimeBudgetAdmission({
          commands: repositories.commands,
          store: repositories.usage,
        }),
        admissionPrincipalId: 'svc_candidate-admission',
        now: () => at,
      },
      usage: { ledger, ...actualSpending },
      provider: async (reference, authority) => {
        const binding = await bindingForAuthority(authority)
        const facade = canonicalModelHost.forExecution(binding)
        const pinned = facade
          ? await facade.resolveSelection({ ...reference, workspaceId })
          : undefined
        if (!pinned) throw new Error('CANDIDATE_SELECTION_MISSING')
        const selection = pinned
        return {
          ...reference,
          workspaceId,
          provider: selection.provider,
          providerModel: selection.providerModel,
          location: 'remote_host',
          harness: 'pi_durable',
          harnessVersion: '1.1.0',
          providerBinding: 'pi_durable_models',
          withModels: async (use) => {
            const useScriptedModels = async (secret) => {
              state.modelsResolutions++
              const models = createModels()
              models.setProvider(
                createProvider({
                  id: selection.provider,
                  baseUrl: modelBaseUrl,
                  auth: {
                    apiKey: {
                      name: 'Test-only candidate loopback',
                      resolve: async () => {
                        const gate = beforeSendGate
                        if (gate) {
                          gate.entered()
                          await gate.pending
                        }
                        return { auth: { apiKey: secret } }
                      },
                    },
                  },
                  models: [
                    {
                      id: selection.providerModel,
                      name: 'Candidate scripted HTTP',
                      api: 'openai-completions',
                      provider: selection.provider,
                      baseUrl: modelBaseUrl,
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
              try {
                const result = await use(models)
                state.modelsCallbacksCompleted++
                return result
              } finally {
                models.clearProviders()
              }
            }
            return facade.withCredential(
              pinned,
              {
                requestId: authority.request.executionPlan.correlation.requestId,
                principalRef: 'svc_candidate-model-lease',
                policySnapshot: authority.request.executionPlan.policySnapshot,
              },
              useScriptedModels
            )
          },
        }
      },
      reconcileInference: async () => 'unresolved',
    })
    const inspectRuntime = composition.adapter.inspect.bind(composition.adapter)
    composition.adapter.inspect = async (requirements) => {
      const result = await inspectRuntime(requirements)
      return state.scopeFault === 'unsupported-adapter'
        ? {
            ...result,
            capabilities: result.capabilities.filter(
              (entry) => entry.name !== 'execution.scope.workspace.v1'
            ),
          }
        : result
    }
    const claims = {
      audience: 'control-plane',
      issuer: 'https://candidate-test.invalid',
      keyId: 'test-only-key',
      credentialId: 'test-only-candidate-service',
      credentialKind: 'service',
      issuedAt: at,
      expiresAt,
      principalId,
      workspaceIds: principal.workspaceIds,
      projectIds: principal.projectIds,
      scopes: principal.scopes,
    }
    const authenticator = new PolicyServiceAuthenticator({
      audience: claims.audience,
      issuer: claims.issuer,
      now: () => new Date(at),
      logger: { write() {} },
      verifier: {
        verify: async (credential) => {
          if (credential !== testCredential) throw new Error('CANDIDATE_BAD_BEARER')
          return claims
        },
      },
      revocationChecker: { isRevoked: async () => state.revoked },
    })
    const fastify = new FastifyAdapter({ logger: false })
    const candidateModule = PiDurableLeadModule.register({
      service: composition.service,
      serviceAuthenticator: authenticator,
    })
    candidateModule.controllers.push(ModelConnectionsController)
    candidateModule.providers.push({
      provide: MODEL_CONNECTION_SERVICE,
      useValue: new ConfiguredModelConnectionService(
        modelMetadata.selections,
        modelMetadata.administration,
        canonicalModelHost.fundingView
      ),
    })
    app = await NestFactory.create(candidateModule, fastify, { logger: false })
    app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })
    app.useGlobalFilters(new NormalizedExceptionFilter())
    const metrics = () => {
      const records = Object.fromEntries(
        inspection
          .prepare(
            'SELECT namespace, COUNT(*) AS count FROM control_plane_records GROUP BY namespace'
          )
          .all()
          .map((row) => [row.namespace, Number(row.count)])
      )
      const count = (db, table) =>
        Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
      return {
        providerRequests: state.providerRequests.length,
        modelsResolutions: state.modelsResolutions,
        fixtureCredentialUses: state.fixtureCredentialUses,
        fixtureCredentialCallbacksCompleted: state.fixtureCredentialCallbacksCompleted,
        modelsCallbacksCompleted: state.modelsCallbacksCompleted,
        fundingConfirmations: fundingDatabase
          ? count(fundingDatabase, 'model_funding_confirmations')
          : 0,
        productReads: state.productReads,
        spendingReads: state.spendingReads,
        planResolutions: state.planResolutions,
        commands: records['command-inbox'] ?? 0,
        executions: records.executions ?? 0,
        attempts: records['execution-attempts'] ?? 0,
        usageBudgets: records['usage-budgets'] ?? 0,
        usageEntries: records['usage-ledger-entries'] ?? 0,
        intentAdmissions: count(composition.admission.store.database, 'pi_lead_intent_admissions'),
        dispatchReceipts: count(composition.admission.store.database, 'pi_lead_receipts'),
        runtimeAdmissions: count(composition.adapter.journal.database, 'pi_admissions'),
        runtimeSessions: count(composition.adapter.journal.database, 'pi_sessions'),
      }
    }
    // Narrow authenticated fixture administration, not production HTTP surface.
    const fixtureAuthorized = (request, reply) => {
      if (request.headers.authorization !== `Bearer ${testCredential}`) {
        reply.code(401).send({ code: 'CANDIDATE_TEST_AUTH_REQUIRED' })
        return false
      }
      return true
    }
    fastify.getInstance().post('/__candidate/intents', async (request, reply) => {
      if (!fixtureAuthorized(request, reply)) return
      try {
        return await registerIntent(request.body)
      } catch {
        return reply.code(400).send({ code: 'CANDIDATE_INTENT_INVALID' })
      }
    })
    fastify.getInstance().post('/__candidate/provider-response', async (request, reply) => {
      if (!fixtureAuthorized(request, reply)) return
      if (request.body?.action === 'hold') holdProviderResponse()
      else if (request.body?.action === 'release') releaseProviderResponse()
      else return reply.code(400).send({ code: 'CANDIDATE_PROVIDER_ACTION_INVALID' })
      return { held: providerResponseGate !== undefined }
    })
    fastify.getInstance().get('/__candidate/evidence', async (request, reply) => {
      if (!fixtureAuthorized(request, reply)) return
      const intentId = request.query.intentId
      const ids = intentId ? deterministicPiLeadIntentIds(workspaceId, intentId) : undefined
      return {
        metrics: metrics(),
        ...(ids
          ? {
              ids,
              product: productEvidence.get(intentId) ?? null,
              selection: selectionsByIntent.get(intentId) ?? null,
              funding: fundingPaths.get(intentId)?.record.decision ?? null,
              execution: (await repositories.executions.getExecution(ids.executionId)) ?? null,
              attempt: (await repositories.executions.getAttempt(ids.attemptId)) ?? null,
              usage: await ledger.entries(workspaceId, ids.executionId).catch(() => []),
              modelHolds: await modelHolds(ids.executionId),
            }
          : {}),
      }
    })
    fastify.getInstance().post('/__candidate/close', async (request, reply) => {
      if (!fixtureAuthorized(request, reply)) return
      setTimeout(() => {
        void close()
      }, 0)
      return { closing: true }
    })
    await app.listen(0, '127.0.0.1')
    const port = app.getHttpServer().address().port
    const baseUrl = `http://127.0.0.1:${port}`
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const git = (args) => {
      const result = spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      if (result.status !== 0) throw new Error('CANDIDATE_SOURCE_IDENTITY_UNAVAILABLE')
      return result.stdout
    }
    const head = git(['rev-parse', 'HEAD']).trim()
    const sourceHash = createHash('sha256').update(git(['diff', '--binary', 'HEAD']))
    for (const path of git(['ls-files', '--others', '--exclude-standard'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .toSorted()) {
      sourceHash.update(path).update(await readFile(join(root, path)))
    }
    const sourceIdentity = {
      repository: 'adea-ai/control-plane',
      head,
      wipDigest: `sha256:${sourceHash.digest('hex')}`,
      fixtureVersion: 'node-candidate/v1',
      runtime: '@earendil-works/pi-durable@1.1.0',
      provider: 'scripted-loopback-http',
      liveProviderVerified: false,
    }
    const common = (projectId) => ({
      caller: { servicePrincipalId: principalId },
      contractVersion: PublicContractManifest.current,
      requestId: fixtureId('req'),
      workspaceId,
      ...(projectId === null ? {} : { projectId }),
      correlation: { traceId: fixtureId('trc') },
    })
    const envelope = (
      operation,
      payload,
      key = `candidate:${randomUUID()}`,
      projectId = explicitProjectId
    ) => ({
      ...common(projectId),
      commandId: deterministicPiLeadIntentIds(workspaceId, randomUUID()).commandId,
      idempotencyKey: key,
      payloadHash: hash(payload),
      operation,
      issuedAt: at,
      payload,
    })
    const read = (operation, parameters, projectId = explicitProjectId) => ({
      ...common(projectId),
      operation,
      requestedAt: at,
      parameters,
    })
    return {
      port,
      baseUrl,
      testCredential,
      principal,
      principalId,
      workspaceId,
      explicitProjectId,
      at,
      expiresAt,
      profileId: inputs.profile.profileId,
      profileVersionId: inputs.profile.profileVersionId,
      profileContentDigest: inputs.profile.contentDigest,
      credentialRef,
      target,
      currentProductReaderConfigured: Boolean(options.currentProductReader),
      sourceIdentity,
      registerIntent,
      envelope,
      read,
      metrics,
      holdProviderResponse,
      releaseProviderResponse,
      holdBeforePhysicalSend,
      releaseBeforePhysicalSend,
      async changePayer(intentId) {
        const retained = fundingPaths.get(intentId)
        if (!retained) throw new Error('CANDIDATE_RECORDED_PAYER_MISSING')
        const fundingOwner = {
          ...retained.payer.fundingOwner,
          revision: retained.payer.fundingOwner.revision + 1,
        }
        retained.payer = { ...retained.payer, fundingOwner }
        retained.record = {
          ...retained.record,
          decision: { ...retained.record.decision, fundingOwner },
        }
        await privateWrite(retained.recordPath, retained.record)
        await privateWrite(retained.payerPath, retained.payer)
      },
      fundingEvidence() {
        return fundingDatabase
          ? fundingDatabase
              .prepare('SELECT record_json FROM model_funding_confirmations')
              .all()
              .map((row) => JSON.parse(row.record_json))
          : []
      },
      close,
      drain: () => composition.adapter.drain(),
      inspectAdmissionRecordCounts: metrics,
      async evidence(intentId) {
        const ids = deterministicPiLeadIntentIds(workspaceId, intentId)
        return {
          ids,
          product: productEvidence.get(intentId) ?? null,
          selection: selectionsByIntent.get(intentId) ?? null,
          funding: fundingPaths.get(intentId)?.record.decision ?? null,
          execution: (await repositories.executions.getExecution(ids.executionId)) ?? null,
          attempt: (await repositories.executions.getAttempt(ids.attemptId)) ?? null,
          usage: await ledger.entries(workspaceId, ids.executionId).catch(() => []),
          modelHolds: await modelHolds(ids.executionId),
          metrics: metrics(),
        }
      },
      async awaitInput(dispatchId) {
        const receipt = await new (
          await import('./pi-durable-lead.service.ts')
        ).SqlitePiDurableLeadReceiptStore(composition.admission.store.database).get(dispatchId)
        if (!receipt) throw new Error('CANDIDATE_RECEIPT_MISSING')
        await composition.adapter.awaitInput(receipt.handle, fixtureId('int'))
      },
      revoke() {
        state.revoked = true
      },
      setScopeFault(fault) {
        state.scopeFault = fault
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

if (import.meta.main) {
  const productUrl = process.env.PI_SELECTED_PRODUCT_READER_URL
  const productCredential = process.env.PI_SELECTED_PRODUCT_READER_CREDENTIAL
  let currentProductReader
  if (productUrl || productCredential) {
    if (!productUrl || !productCredential)
      throw new Error('CANDIDATE_PRODUCT_READER_CONFIG_REQUIRED')
    const url = new URL(productUrl)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('CANDIDATE_LOOPBACK_PRODUCT_READER_REQUIRED')
    currentProductReader = {
      readCurrent: async (input) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${productCredential}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        })
        if (!response.ok) return undefined
        return response.json()
      },
    }
  }
  const host = await startSelectedModelCandidateHost({
    workspaceId: process.env.PI_CANDIDATE_WORKSPACE_ID,
    explicitProjectId: process.env.PI_CANDIDATE_EXPLICIT_PROJECT_ID,
    workspaceScope: process.env.PI_CANDIDATE_WORKSPACE_SCOPE === 'true',
    prepareFunding: process.env.PI_CANDIDATE_PREPARE_FUNDING === 'true',
    ...(currentProductReader ? { currentProductReader } : {}),
  })
  process.stdout.write(
    `${JSON.stringify({
      baseUrl: host.baseUrl,
      port: host.port,
      testCredential: host.testCredential,
      principalId: host.principalId,
      workspaceId: host.workspaceId,
      explicitProjectId: host.explicitProjectId,
      at: host.at,
      expiresAt: host.expiresAt,
      profileId: host.profileId,
      profileVersionId: host.profileVersionId,
      profileContentDigest: host.profileContentDigest,
      credentialRef: host.credentialRef,
      target: host.target,
      currentProductReaderConfigured: host.currentProductReaderConfigured,
      prepareFunding: process.env.PI_CANDIDATE_PREPARE_FUNDING === 'true',
      sourceIdentity: host.sourceIdentity,
    })}\n`
  )
  const stop = async () => {
    await host.close()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
