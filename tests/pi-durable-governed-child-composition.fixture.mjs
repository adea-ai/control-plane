// Actual Pi/J1/SQLite composition. HTTP, grants and approval are deterministic host fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  ChildProgressEvidenceBuffer,
  ChildProgressLeadDispatcher,
  ChildProgressLeadFeed,
  ChildUsageLedger,
} from '@control-plane/orchestration'
import { DurableUsageLedger, PinnedModelPrice } from '@control-plane/usage-ledger'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { PolicyControlledToolExecutionService } from '@control-plane/tool-execution'
import {
  SqlitePersistenceProvider,
  SqliteDurableUsageStore,
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteDelegationRepository,
  SqliteDelegationEventPublisher,
  SqliteToolCallRepository,
  SqliteDelegationToolAdmissionRepository,
  SqliteChildUsageOutcomeRepository,
} from '@control-plane/sqlite-persistence'
import {
  createGovernedChildHostFixture,
  parentAttemptId,
  identity,
} from './pi-durable-child-host.fixture.mjs'
import { ids } from '../packages/orchestration/src/delegation-fixtures.mjs'
import {
  actor,
  now,
  workspaceInput,
  currentSnapshot,
} from '../packages/orchestration/src/delegation-workspace-fixtures.mjs'
import { createNodePiDurableRuntime } from '../packages/pi-durable-adapter/src/composition.ts'
import { createPiDurableUsageAuthority } from '../packages/pi-durable-adapter/src/usage-authority.ts'
import { createNativeEngineToolFixture } from '../packages/pi-durable-adapter/src/pi-engine-tools.loopback.fixture.mjs'
import { PiDurableChildProgressScanner } from '../apps/control-api/src/pi-durable/child-progress-scanner.ts'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { SqlitePiLeadRunningLifecycle } from '../apps/control-api/src/pi-durable/lead-running-lifecycle.ts'

function persistentStorage(provider) {
  const publications = new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
  // The lead projection composes over the canonical durable outlet: every
  // delegation event the service (or the production scanner's
  // recordChildProgress path) publishes folds through the feed into the lead
  // dispatcher, and `list()` stays the durable restart source.
  const dispatcher = new ChildProgressLeadDispatcher({
    buffer: new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId }),
  })
  const leadFeed = new ChildProgressLeadFeed({
    publications,
    dispatcher,
    generationOf: () => 1,
  })
  return {
    executions: new SqliteExecutionRepository(provider),
    plans: new SqliteExecutionPlanRepository(provider),
    contexts: new SqliteContextPackageRepository(provider),
    delegations: new SqliteDelegationRepository(provider),
    events: leadFeed,
    publications,
    leadFeed,
    dispatcher,
    usageOutcomes: new SqliteChildUsageOutcomeRepository(provider, ids.delegationId),
    calls: new SqliteToolCallRepository(provider, ids.workspaceId),
    admissions: new SqliteDelegationToolAdmissionRepository(provider, ids.workspaceId),
  }
}

async function childTransport(state) {
  const requests = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      assert.equal(state.active.child, true, 'child current grant before physical HTTP')
      const body = await request.json()
      assert.equal(body.model, 'separate-child-model')
      requests.push(body)
      const chunks = [
        {
          id: 'child_chat',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Bounded child evidence.' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'child_chat',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        },
      ]
      return new Response(
        chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  const baseUrl = `${server.url}v1`
  return {
    requests,
    withModels: async (use) => {
      const models = createModels()
      models.setProvider(
        createProvider({
          id: 'child-loopback',
          baseUrl,
          auth: {
            apiKey: {
              name: 'Synthetic child transport',
              resolve: async () => ({ auth: { apiKey: 'fixture-child-no-account' } }),
            },
          },
          models: [
            {
              id: 'separate-child-model',
              provider: 'child-loopback',
              name: 'Separate child model',
              api: 'openai-completions',
              baseUrl,
              reasoning: false,
              input: ['text'],
              contextWindow: 1024,
              maxTokens: 32,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
          api: openAICompletionsApi(),
        })
      )
      return use(models)
    },
    close: () => server.stop(true),
  }
}

export async function createGovernedChildCompositionFixture(
  directory,
  {
    revokeChildBeforeDispatch = false,
    childRuntimeFactory = createNodePiDurableRuntime,
    retainContinuation,
  } = {}
) {
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
  await provider.migrate()
  const storage = persistentStorage(provider)
  const leadDatabase = new DatabaseSync(join(directory, 'lead-admission.sqlite'))
  const state = {
    active: { lead: true, child: true },
    approved: true,
    authorityChecks: [],
    spendingChecks: [],
    selections: [],
    budgets: [],
    parentAtChildAdmission: [],
  }
  const workspace = workspaceInput()
  // This first qualified runtime has no ambient filesystem capability. Compile
  // a real fixture plan requiring only its admitted streaming/workspace tools.
  const planInput = createExecutionPlanTestFixtureInputs({
    contextPackage: workspace.parentContext,
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  delete planInput.correlation.projectId
  planInput.correlation.executionScope = { schemaVersion: 1, kind: 'workspace' }
  planInput.constraints.limits.childExecutions.maximumTotal = 1
  planInput.profile.definition.executionConstraints.limits.childExecutions.maximumTotal = 1
  workspace.parentPlan = new ExecutionPlanCompiler('1.0.0').compile(planInput)
  workspace.command.parentPlan = workspace.parentPlan
  workspace.command.childPlan.constraints = structuredClone(workspace.parentPlan.constraints)
  workspace.command.childPlan.constraints.limits.budget.maximumMicrounits = 1000000
  workspace.command.childPlan.constraints.limits.tokens.maximumTotal = 10000
  workspace.command.childPlan.constraints.limits.duration.maximumMs = 600000
  workspace.command.childPlan.runtimeRequirements = workspace.parentPlan.runtimeRequirements.filter(
    (value) => value.capability !== 'execution.scope.workspace.v1'
  )
  const scopeAuthority = {
    readCurrent: async (input) => {
      assert.equal(input.callerPrincipalId, actor)
      const current = currentSnapshot(input)
      return {
        ...current,
        grantActive: state.active[input.executionScope.kind === 'workspace' ? 'lead' : 'child'],
      }
    },
  }
  workspace.scopeAdmission = {
    authority: scopeAuthority,
    now: () => now,
    resolveCallerPrincipalId: async () => actor,
  }
  const ledger = new DurableUsageLedger({
    store: new SqliteDurableUsageStore(provider),
    now: () => now,
  })
  // The correlated cost-state projection for the child attempt. The money
  // stays in the canonical durable ledger above; this records the explicit
  // estimated/reserved/reported/reconciled/settled evidence stages, driven
  // live by the bridge's reserveBudget seam and the canonical settle path.
  const childUsage = new ChildUsageLedger()
  const childUsageIdentity = (admission) => ({
    parentExecutionId: admission.identity.parentExecutionId,
    delegationId: admission.identity.delegationId,
    childExecutionId: admission.record.childExecutionId,
    childAttemptId: admission.identity.childAttemptId,
  })
  const selections = {
    lead: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    child: { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 2 },
  }
  let childRuntime, leadRuntime, host, childAdmission
  const child = await childTransport(state)
  const parentNative = await createNativeEngineToolFixture({
    argumentsInput: { objective: workspace.command.objective },
  })
  const roleFor = (authority) =>
    authority.request.executionId === ids.parentExecutionId ? 'lead' : 'child'
  async function assertCurrent(authority) {
    const role = roleFor(authority)
    const request = authority.request
    assert.equal(authority.admission.canonicalActorPrincipalId, actor)
    assert.deepEqual(authority.admission.selection, selections[role])
    assert.equal(state.active[role], true, `${role} authority revoked`)
    const execution = await storage.executions.getExecution(request.executionId)
    const attempt = await storage.executions.getAttempt(request.attemptId)
    assert.equal(execution.latestAttemptId, request.attemptId)
    assert.equal(attempt.executionId, execution.executionId)
    assert.equal(execution.executionPlan.contentDigest, request.executionPlan.contentDigest)
    assert.equal(request.attemptBudget.reservationKey, `runtime-attempt:${request.attemptId}`)
    state.authorityChecks.push({
      role,
      actor,
      executionId: request.executionId,
      attemptId: request.attemptId,
    })
  }
  const prices = Object.fromEntries(
    ['lead', 'child'].map((role) => [
      role,
      new PinnedModelPrice(
        {
          schemaVersion: 1,
          deploymentId: `pi-${role}-fixture`,
          provider: role === 'lead' ? 'loopback' : 'child-loopback',
          model: role === 'lead' ? 'loopback-model' : 'separate-child-model',
          version: `price:${role}:1`,
          currency: 'USD',
          fundingSource: 'byo_api',
          validFrom: now,
          validUntil: '2026-09-01T00:00:00.000Z',
          maximumInputTokens: 1024,
          maximumOutputTokens: 32,
          ratesMicrounitsPerMillionTokens: { input: 1000000, cachedInput: 500000, output: 2000000 },
        },
        { now: () => now }
      ),
    ])
  )
  const usage = createPiDurableUsageAuthority({
    ledger,
    resolvePrice: async (authority) => ({
      price: prices[roleFor(authority)],
      maximumOutputTokens: 32,
    }),
    assertSpendingAuthorized: async (authority, quote) => {
      await assertCurrent(authority)
      const role = roleFor(authority)
      state.spendingChecks.push({ role, quote, selection: authority.admission.selection })
      return {
        authorizationRef: `model-spend:${role}:fixture`,
        evidenceDigest: `sha256:${(role === 'lead' ? 'a' : 'b').repeat(64)}`,
        assertActive: async () => {
          await assertCurrent(authority)
          if (role === 'child' && revokeChildBeforeDispatch) {
            state.active.child = false
            throw new Error('CHILD_SPENDING_REVOKED_BEFORE_DISPATCH')
          }
        },
      }
    },
  })
  async function reserveBudget(admission) {
    const budget = {
      schemaVersion: 1,
      workspaceId: ids.workspaceId,
      executionId: admission.record.childExecutionId,
      attemptId: admission.attempt.attemptId,
      executionPlanId: admission.plan.executionPlanId,
      executionPlanDigest: admission.plan.contentDigest,
      reservationKey: `runtime-attempt:${admission.attempt.attemptId}`,
      currency: 'USD',
      maximumMicrounits: 500000,
      maximumTokens: 5000,
    }
    const existing = state.budgets.find((value) => value.attemptId === budget.attemptId)
    if (existing) assert.deepEqual(existing, budget)
    else {
      state.budgets.push(budget)
      await ledger.openBudget({
        workspaceId: ids.workspaceId,
        executionId: budget.executionId,
        parentExecutionId: ids.parentExecutionId,
        currency: 'USD',
        maximumMicrounits: budget.maximumMicrounits,
        maximumTokens: budget.maximumTokens,
        source: { sourceId: 'child-funded', idempotencyKey: 'child-funded' },
      })
      await ledger.reserve({
        workspaceId: ids.workspaceId,
        executionId: budget.executionId,
        attemptId: budget.attemptId,
        reservationKey: budget.reservationKey,
        maximumMicrounits: budget.maximumMicrounits,
        maximumTokens: budget.maximumTokens,
        source: { sourceId: 'child-reserved', idempotencyKey: 'child-reserved' },
      })
      // Live bridge seam: the canonical durable reservation above is recorded
      // verbatim as the attempt's reservation evidence (and the plan ceiling
      // as its estimate) in the same scheduling step.
      const usageIdentity = childUsageIdentity(admission)
      childUsage.recordEstimate(usageIdentity, {
        currency: 'USD',
        maximumMicrounits: workspace.command.childPlan.constraints.limits.budget.maximumMicrounits,
        source: 'fixture-child-plan-constraints',
      })
      childUsage.recordReservation(usageIdentity, budget)
    }
    childAdmission = {
      schemaVersion: 'pi-durable-admission/v1',
      prompt: admission.record.objective,
      canonicalActorPrincipalId: actor,
      selection: selections.child,
      authority: {
        revision: 2,
        principalRef: 'lease:separate-child',
        scopeRef: 'scope:project-child',
        expiresAt: '2026-09-01T00:00:00.000Z',
      },
    }
    return budget
  }
  const shared = {
    now: () => '2026-08-25T18:02:01.000Z',
    assertAuthority: assertCurrent,
    scopeAuthority,
    authorizeInference: usage.authorizeInference,
    settleUsage: async (authority, key, usageInput, counts) => {
      // Canonical settlement first: the durable usage ledger records the
      // charge, and only its returned, priced RuntimeUsage feeds the
      // cost-state projection — never an estimate or an inferred amount.
      const settled = await usage.settleUsage(authority, key, usageInput, counts)
      const accounting = settled.accounting
      if (authority.request.executionId === ids.childExecutionId && accounting !== undefined) {
        const settlementIdentity = childUsageIdentity({
          identity: {
            parentExecutionId: ids.parentExecutionId,
            delegationId: ids.delegationId,
            childAttemptId: ids.childAttemptId,
          },
          record: { childExecutionId: ids.childExecutionId },
        })
        const reportId = `usage-settle:${ids.childAttemptId}:${createHash('sha256')
          .update(String(key))
          .digest('hex')
          .slice(0, 16)}`
        const receipt = childUsage.recordReportedUsage(settlementIdentity, settled, { reportId })
        if (receipt.outcome === 'recorded') {
          childUsage.reconcile(settlementIdentity, { reconciledAt: now })
          childUsage.settle(settlementIdentity, {
            currency: 'USD',
            settledMicrounits: accounting.chargedMicrounits,
            settledAt: now,
            settlementRef: reportId,
          })
        }
      }
      return settled
    },
    reconcileInference: async () => 'unresolved',
    verifyApproval: async (_authority, _identity, submitted) =>
      state.approved &&
      submitted.interactionId === host.request.approval.interactionId &&
      submitted.decision === 'approve',
    resolveProvider: async (selection, authority) => {
      await assertCurrent(authority)
      const role = roleFor(authority)
      assert.deepEqual(selection, selections[role])
      state.selections.push({ role, selection })
      return {
        ...selection,
        workspaceId: ids.workspaceId,
        provider: role === 'lead' ? 'loopback' : 'child-loopback',
        providerModel: role === 'lead' ? 'loopback-model' : 'separate-child-model',
        location: 'remote_host',
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        providerBinding: 'pi_durable_models',
        withModels: role === 'lead' ? parentNative.options.withModels : child.withModels,
      }
    },
  }
  try {
    childRuntime = await childRuntimeFactory(
      {
        ...shared,
        directory: join(directory, 'child-runtime'),
        resolveAdmission: async (request) => {
          assert.equal(request.executionId, ids.childExecutionId)
          assert.equal(request.attemptId, ids.childAttemptId)
          assert.ok(childAdmission, 'separate canonical child admission required')
          return childAdmission
        },
      },
      { canonicalProvider: provider }
    )
    host = await createGovernedChildHostFixture({
      storage,
      workspace,
      principalRef: actor,
      runtimeAdapter: childRuntime.adapter,
      reserveChildBudget: reserveBudget,
      retainAdmission: false,
      initializeParentRunning: false,
      onCommandAuthority: async (admission) => {
        assert.equal(admission.request.audit.principalRef, actor)
        const parent = await storage.executions.getExecution(ids.parentExecutionId)
        const attempt = await storage.executions.getAttempt(parentAttemptId)
        assert.equal(parent.state, 'running')
        assert.equal(attempt.state, 'running')
        state.parentAtChildAdmission.push({ execution: parent.state, attempt: attempt.state })
        assert.equal(state.active.lead, true)
        assert.equal(
          admission.command.delegation.parentPlan.contentDigest,
          workspace.parentPlan.contentDigest
        )
      },
      onAuthority: async (admission) => {
        assert.equal(admission.attempt.attemptId, ids.childAttemptId)
        assert.equal(state.active.child, true)
        assert.equal(state.active.lead, true)
      },
    })
    const leadBudget = {
      schemaVersion: 1,
      workspaceId: ids.workspaceId,
      executionId: ids.parentExecutionId,
      attemptId: parentAttemptId,
      executionPlanId: host.parentPlan.executionPlanId,
      executionPlanDigest: host.parentPlan.contentDigest,
      reservationKey: `runtime-attempt:${parentAttemptId}`,
      currency: 'USD',
      maximumMicrounits: 500000,
      maximumTokens: 5000,
    }
    await ledger.openBudget({
      workspaceId: ids.workspaceId,
      executionId: ids.parentExecutionId,
      currency: 'USD',
      maximumMicrounits: 1000000,
      maximumTokens: 10000,
      source: { sourceId: 'lead-funded', idempotencyKey: 'lead-funded' },
    })
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.parentExecutionId,
      attemptId: parentAttemptId,
      reservationKey: leadBudget.reservationKey,
      maximumMicrounits: leadBudget.maximumMicrounits,
      maximumTokens: leadBudget.maximumTokens,
      source: { sourceId: 'lead-reserved', idempotencyKey: 'lead-reserved' },
    })
    const leadAdmission = {
      schemaVersion: 'pi-durable-admission/v1',
      prompt: 'Delegate the bounded project objective.',
      canonicalActorPrincipalId: actor,
      selection: selections.lead,
      authority: {
        revision: 1,
        principalRef: 'lease:workspace-lead',
        scopeRef: 'scope:workspace-lead',
        expiresAt: '2026-09-01T00:00:00.000Z',
      },
    }
    const leadRequest = {
      executionId: ids.parentExecutionId,
      attemptId: parentAttemptId,
      idempotencyKey: 'canonical-workspace-lead:one',
      executionPlan: host.parentPlan,
      attemptBudget: leadBudget,
    }
    const service = new PolicyControlledToolExecutionService({
      gateway: host.service.gateway,
      calls: host.calls,
      authorizer: host.service.authorizer,
      rateLimiter: host.service.rateLimiter,
      now: () => now,
      approvals: {
        review: async (input) => ({
          state: state.approved ? 'approved' : 'pending',
          interactionId: input.interactionId,
          ...(state.approved ? { decisionPrincipalRef: actor } : {}),
        }),
      },
    })
    const leadLifecycle = new SqlitePiLeadRunningLifecycle({
      database: leadDatabase,
      executions: storage.executions,
      assertAuthority: assertCurrent,
    })
    const leadOptions = {
      ...shared,
      directory: join(directory, 'lead-runtime'),
      onExecutionRunning: (authority) => leadLifecycle.onExecutionRunning(authority),
      resolveAdmission: async () => leadAdmission,
      tools: {
        service,
        assertAuthority: async (request) => {
          assert.equal(request.audit.principalRef, actor)
          assert.equal(state.active.lead, true)
        },
      },
      governedDelegateChild: {
        ...(retainContinuation ? { retainContinuation } : {}),
        prepare: async (authority, verified) => {
          await assertCurrent(authority)
          assert.equal(verified.objective, host.command.delegation.objective)
          const retained = await host.admissions.retain({
            ...host.admission,
            sourceKey: verified.sourceKey,
          })
          return retained.admission.request
        },
      },
    }
    leadRuntime = await createNodePiDurableRuntime(leadOptions)
    const scanner = new PiDurableChildProgressScanner({
      now: () => '2026-08-25T18:03:00.000Z',
      bridge: host.bridge,
      listRetainedChildren: async () => {
        const children = await storage.delegations.listByParent(ids.parentExecutionId)
        const result = []
        for (const childRecord of children) {
          const journal = childRuntime.adapter.journal
            .list()
            .find(
              (row) =>
                row.admission.request.executionId === childRecord.childExecutionId &&
                row.admission.request.attemptId === childRecord.childAttemptId
            )
          if (!journal) continue
          const attempt = await storage.executions.getAttempt(childRecord.childAttemptId)
          result.push({
            identity: {
              schemaVersion: 'delegation-runtime-admission/v1',
              parentExecutionId: childRecord.parentExecutionId,
              parentAttemptId: childRecord.parentAttemptId,
              delegationId: childRecord.delegationId,
              childAttemptId: childRecord.childAttemptId,
            },
            handle: journal.admission.handle,
            canonicalState: attempt.state,
          })
        }
        return result
      },
      assertCurrent: async (retained) => {
        const current = await storage.delegations.get(retained.identity.delegationId)
        assert.equal(current.parentExecutionId, retained.identity.parentExecutionId)
        assert.equal(current.parentAttemptId, retained.identity.parentAttemptId)
        assert.equal(current.childAttemptId, retained.identity.childAttemptId)
        const call = await storage.calls.get(current.admittedToolCallId)
        assert.equal(call.status, 'succeeded')
        assert.equal(call.principalRef, actor)
        assert.equal(call.result.output.externalSessionId, retained.handle.externalSessionId)
        const journal = childRuntime.adapter.journal.get(retained.handle.handleId)
        assert.deepEqual(journal.admission.handle, retained.handle)
        await assertCurrent(journal.admission)
      },
      retainTerminalResult: async (retained, result) => {
        await provider.transaction(async (tx) => {
          const existing = await tx.get(
            'pi-child-terminal-results',
            retained.identity.childAttemptId
          )
          if (existing)
            assert.equal(canonicalJsonStringify(existing.value), canonicalJsonStringify(result))
          else
            await tx.put({
              namespace: 'pi-child-terminal-results',
              id: retained.identity.childAttemptId,
              value: JSON.parse(JSON.stringify(result)),
            })
        })
        return 'art_01JBBCDEF0123456789ABCDEFG'
      },
    })
    return {
      state,
      host,
      ledger,
      childUsage,
      storage,
      leadDatabase,
      selections,
      leadRequest,
      identity,
      ids,
      actor,
      parentNative,
      child,
      get leadRuntime() {
        return leadRuntime
      },
      childRuntime,
      scanner,
      async reopenLead() {
        await leadRuntime.close()
        leadRuntime = await createNodePiDurableRuntime(leadOptions)
        return leadRuntime
      },
      async reopenCanonical() {
        provider.close()
        const reopened = new SqlitePersistenceProvider({
          path: join(directory, 'canonical.sqlite'),
        })
        await reopened.migrate()
        return { provider: reopened, storage: persistentStorage(reopened) }
      },
      async close() {
        await leadRuntime?.close()
        await childRuntime?.close()
        await parentNative.close()
        await child.close()
        provider.close()
        leadDatabase.close()
      },
    }
  } catch (error) {
    await leadRuntime?.close()
    await childRuntime?.close()
    await parentNative.close()
    await child.close()
    provider.close()
    leadDatabase.close()
    throw error
  }
}
