// TEST ONLY. Executable local candidate host, never imported by production startup.
// Real Nest auth/routes, canonical CP admission, SQLite, ledger and Pi Harness;
// synthetic bearer/product/spending evidence and scripted loopback provider.
import 'reflect-metadata'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
import { createPiRecordedSpendingAuthority } from '@control-plane/pi-durable-adapter'
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
  }
  let app, composition, persistence, inspection, providerServer
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      if (app) await app.close()
    } finally {
      try {
        if (composition) await composition.close()
      } finally {
        inspection?.close()
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
      credentialRef: 'credential:candidate-scripted',
      provider: 'scripted-http',
      providerModel: 'scripted-1',
      fundingSource: 'hq_managed',
    }
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
      if (projectId !== null) {
        const ids = deterministicPiLeadIntentIds(workspaceId, intentId)
        const perIntentInputs = structuredClone(inputs)
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
    composition = await createNodePiDurableLeadComposition({
      directory,
      admission: {
        product: {
          readCurrent: async (input) => {
            state.productReads++
            if (
              state.revoked ||
              input.workspaceId !== workspaceId ||
              input.principalId !== principalId
            )
              return undefined
            return structuredClone(productEvidence.get(input.intentId))
          },
        },
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
        }),
        executions: repositories.executions,
        budgetAdmission: new DurableRuntimeBudgetAdmission({
          commands: repositories.commands,
          store: repositories.usage,
        }),
        admissionPrincipalId: 'svc_candidate-admission',
        now: () => at,
      },
      usage: { ledger, ...spending },
      provider: async (reference) => ({
        ...reference,
        workspaceId,
        provider: selection.provider,
        providerModel: selection.providerModel,
        location: 'remote_host',
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        providerBinding: 'pi_durable_models',
        withModels: async (use) => {
          state.modelsResolutions++
          const models = createModels()
          models.setProvider(
            createProvider({
              id: selection.provider,
              baseUrl: modelBaseUrl,
              auth: {
                apiKey: {
                  name: 'Test-only candidate loopback',
                  resolve: async () => ({ auth: { apiKey: 'test-only-not-provider-credential' } }),
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
        },
      }),
      reconcileInference: async () => 'unresolved',
    })
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
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
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
