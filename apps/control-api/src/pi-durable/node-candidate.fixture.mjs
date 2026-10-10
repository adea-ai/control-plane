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
import {
  createPiRecordedSpendingAuthority,
  createPiExecutionBoundModelComposition,
} from '@control-plane/pi-durable-adapter'
import {
  RuntimeProviderSelectionSchema,
  RecordedModelFundingDecisionSchema,
} from '@control-plane/model-gateway'
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

export async function startNodePiDurableCandidateHost(options = {}) {
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
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
  }
  const productEvidence = new Map()
  const plansByIntent = new Map()
  const recordedDecisions = new Map()
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
        state.providerRequests.push(await request.json())
        await providerResponseGate?.pending
        const chunks = [
          {
            id: 'candidate-scripted-chat',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'scripted-1',
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
    const selection = {
      selectionRef: `msel_${'a'.repeat(32)}`,
      selectionRevision: 1,
      workspaceId,
      credentialRef:
        options.prepareFunding === true ? fixtureId('crd') : 'credential:candidate-scripted',
      provider: 'scripted-http',
      providerModel: 'scripted-1',
      accountRef: 'candidate-account:provider',
      fundingSource: options.prepareFunding === true ? 'byo_api' : 'hq_managed',
    }
    const runtimeSelection =
      options.prepareFunding === true
        ? RuntimeProviderSelectionSchema.parse({
            ...selection,
            schemaVersion: 'model-selection/v1',
            connectionRef: `mconn_${'b'.repeat(32)}`,
            connectionRevision: 1,
            credentialRevision: 1,
            authKind: 'api_key',
            location: 'remote_host',
            harness: 'pi_durable',
            harnessVersion: '1.1.0',
            providerBinding: 'pi_durable_models',
            workspaceGrant: { grantRef: 'candidate-grant:scripted', revision: 1 },
            configurationRevision: 1,
          })
        : undefined
    const fundingDirectory = join(directory, 'private-funding')
    if (runtimeSelection) await mkdir(fundingDirectory, { mode: 0o700 })
    const fundingPaths = new Map()
    const privateWrite = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 })
    const price = {
      schemaVersion: 1,
      deploymentId: 'candidate-loopback',
      provider: selection.provider,
      model: selection.providerModel,
      version: 'candidate-price:1',
      currency: 'USD',
      fundingSource: selection.fundingSource,
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
    const registerIntent = async (input) => {
      const intentId = z.uuid().parse(input.intentId)
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
          input.profileContentDigest !== inputs.profile.contentDigest) ||
        (input.selectionRef !== undefined && input.selectionRef !== selection.selectionRef) ||
        (input.selectionRevision !== undefined &&
          input.selectionRevision !== selection.selectionRevision)
      )
        throw new Error('CANDIDATE_PIN_MISMATCH')
      const evidence = VerifiedPiLeadIntentEvidenceSchema.parse({
        schemaVersion: 'pi-lead-intent/v1',
        intentId,
        workspaceId,
        projectId,
        messageRef: input.messageRef ?? `message:candidate:${intentId}`,
        authorityRevision: 1,
        principalRef: input.principalRef ?? 'lead:candidate',
        canonicalActorPrincipalId: input.canonicalActorPrincipalId ?? 'product:candidate-sender',
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
      productEvidence.set(intentId, evidence)
      return structuredClone(evidence)
    }
    const spending = createPiRecordedSpendingAuthority({
      ledger,
      alias: 'reasoning.standard',
      now: () => at,
      readRecordedDecision: async (authority) => {
        state.spendingReads++
        if (state.revoked) throw new Error('CANDIDATE_REVOKED')
        const record = recordedDecisions.get(authority.request.attemptId)
        if (!record) throw new Error('CANDIDATE_SPENDING_MISSING')
        return structuredClone(record)
      },
      resolveSelection: async () => {
        if (state.revoked) throw new Error('CANDIDATE_REVOKED')
        return { ...selection }
      },
    })
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
        return structuredClone(productEvidence.get(input.intentId))
      },
    }
    const readerFor = (admission, readerPrincipalId = principalId) => ({
      workspaceId,
      ...admission.admittedAttempt,
      principalId: readerPrincipalId,
      selectionRef: selection.selectionRef,
      selectionRevision: selection.selectionRevision,
    })
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
        selections: {
          resolveSelection: async (reference) => {
            if (
              state.revoked ||
              reference.workspaceId !== workspaceId ||
              reference.selectionRef !== runtimeSelection.selectionRef ||
              reference.selectionRevision !== runtimeSelection.selectionRevision
            )
              throw new Error('CANDIDATE_SELECTION_CHANGED')
            return structuredClone(runtimeSelection)
          },
          assertReady: async (candidate) => {
            if (
              state.revoked ||
              canonicalJsonStringify(candidate) !== canonicalJsonStringify(runtimeSelection)
            )
              throw new Error('CANDIDATE_SELECTION_CHANGED')
          },
          // Synthetic loopback credential transport; actual canonical facade guards
          // this callback, but this is intentionally not a real vault/provider lease.
          withCredential: async (_candidate, _authority, use) => {
            state.fixtureCredentialUses++
            return z.json().parse(await use('test-only-not-provider-credential'))
          },
        },
        fundingDirectory,
        database: fundingDatabase,
        now: () => new Date().toISOString(),
      })
    }
    const actualSpending = runtimeSelection
      ? createPiExecutionBoundModelComposition({
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
      : spending
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
                        get(target, property) {
                          if (property === 'transaction') return (action) => action(native)
                          const value = Reflect.get(target, property)
                          return typeof value === 'function' ? value.bind(target) : value
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
        const binding = runtimeSelection ? await bindingForAuthority(authority) : undefined
        const facade = binding ? canonicalModelHost.forExecution(binding) : undefined
        const pinned = facade
          ? await facade.resolveSelection({ ...reference, workspaceId })
          : undefined
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
                return await use(models)
              } finally {
                models.clearProviders()
              }
            }
            return facade
              ? facade.withCredential(
                  pinned,
                  {
                    requestId: authority.request.executionPlan.correlation.requestId,
                    principalRef: 'svc_candidate-model-lease',
                    policySnapshot: authority.request.executionPlan.policySnapshot,
                  },
                  useScriptedModels
                )
              : useScriptedModels('test-only-not-provider-credential')
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
    app = await NestFactory.create(
      PiDurableLeadModule.register({
        service: composition.service,
        serviceAuthenticator: authenticator,
      }),
      fastify,
      { logger: false }
    )
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
      selectionRef: selection.selectionRef,
      selectionRevision: selection.selectionRevision,
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
  const host = await startNodePiDurableCandidateHost({
    workspaceId: process.env.PI_CANDIDATE_WORKSPACE_ID,
    explicitProjectId: process.env.PI_CANDIDATE_EXPLICIT_PROJECT_ID,
    workspaceScope: process.env.PI_CANDIDATE_WORKSPACE_SCOPE === 'true',
    prepareFunding: process.env.PI_CANDIDATE_PREPARE_FUNDING === 'true',
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
      selectionRef: host.selectionRef,
      selectionRevision: host.selectionRevision,
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
