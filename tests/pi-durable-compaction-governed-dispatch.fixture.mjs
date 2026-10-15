// TEST ONLY: governed delegate_child wired into the actual production Pi lead factory. The real
// GovernedDelegateChildExecutor, the production child bridge builder (CanonicalDelegationRuntimeBridge
// over the composition's own authority, model binding and adapter), production child delegation
// (allocator, current-grant reads) and DurableChildRuntimeBudgetAdmission are used. Funding
// records, the provider transport and the policy decision are scripted fixtures.
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { deriveContextPackage } from '@control-plane/context'
import {
  ExecutionLifecycleService,
  InMemoryInteractionRepository,
  InteractionService,
} from '@control-plane/domain'
import {
  ChildUsageLedger,
  assertDelegationToolParentPlan,
  CanonicalDelegationCommandResolver,
  GovernedDelegateChildExecutor,
} from '@control-plane/orchestration'
import {
  SqliteChildUsageOutcomeRepository,
  SqliteDelegationEventPublisher,
  SqliteDelegationRepository,
  SqliteDelegationToolAdmissionRepository,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
import {
  InMemoryToolRateLimiter,
  InMemoryToolRegistryRepository,
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  ToolGateway,
  ToolRegistry,
} from '@control-plane/tool-execution'
import { DurableChildRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import { SqlitePiLeadTerminalSettlement } from '../apps/control-api/src/pi-durable/lead-terminal-settlement.ts'
import { PiDurableChildProgressScanner } from '../apps/control-api/src/pi-durable/child-progress-scanner.ts'
import { createProductionChildRuntimeBridge } from '../apps/control-api/src/pi-durable/production-child-bridge.ts'

const id = (prefix, suffix = '01JABCDEF0123456789ABCDEFG') => `${prefix}_${suffix}`
const childSuffix = '01JBBCDEF0123456789ABCDEFG'
export const childIds = {
  delegationId: id('dlg', childSuffix),
  executionId: id('exe', childSuffix),
  attemptId: id('att', childSuffix),
  taskId: id('tsk', childSuffix),
  requestId: id('req', childSuffix),
  runtimeConnectionId: id('rtc', childSuffix),
  toolCallId: id('tlc'),
  toolRequestId: id('req'),
  terminalResultRef: id('art', childSuffix),
}
export const childObjective = 'Inspect the bounded child objective'

/** Late-bound context the test shares with the factory: the host, intent and evidence counters. */
export function createGovernedDispatchHooks() {
  return {
    host: undefined,
    intentId: undefined,
    /** Runs after the scripted policy decision allows the effect, before the executor is reached. */
    afterPolicyAllow: undefined,
    bridge: undefined,
    /** Replaces the production authority read for one test, e.g. to model a missing authority. */
    authorityOverride: undefined,
    scanner: undefined,
    delegationService: undefined,
    evidence: {
      policyDecisions: 0,
      executorCalls: 0,
      preparedRequests: [],
      childStarts: [],
      reservations: [],
      bridgeAuthorityReads: 0,
      fundingWrites: [],
      inboxWakes: [],
      retainedEvents: [],
    },
  }
}

/** Written like the host's private funding store would for a child attempt. */
async function writeChildFunding(hooks, binding) {
  const { host } = hooks
  const parentFunding = host.records.get(hooks.intentId)
  const decision = structuredClone(parentFunding.decision)
  const ownerRef = 'payer:compaction-governed-child'
  const fundingOwner = { ...decision.fundingOwner, ownerRef }
  decision.executionPlanId = binding.executionPlanId
  decision.executionPlanDigest = binding.executionPlanDigest
  decision.selectionRef = binding.selectionRef
  decision.selectionRevision = binding.selectionRevision
  decision.canonicalActorPrincipalId = binding.canonicalActorPrincipalId
  decision.authorityRevision = binding.authorityRevision
  decision.fundingOwner = fundingOwner
  decision.grant = {
    ...decision.grant,
    authorizationId: 'fixture-child-spend:compaction-governed',
    evidenceRef: 'fixture-child-decision:compaction-governed',
    workspaceId: binding.workspaceId,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
    principalRef: binding.principalRef,
    alias: binding.modelAlias,
    policySnapshotDigest: binding.policySnapshotDigest,
  }
  const fundingDirectory = join(host.directory, 'private-funding')
  const recordDirectory = join(fundingDirectory, binding.workspaceId, binding.executionId)
  const payerDirectory = join(fundingDirectory, binding.workspaceId, 'payers')
  await mkdir(recordDirectory, { recursive: true, mode: 0o700 })
  await mkdir(payerDirectory, { recursive: true, mode: 0o700 })
  await writeFile(
    join(recordDirectory, `${binding.attemptId}.json`),
    JSON.stringify({
      schemaVersion: 'recorded-funding-host/v1',
      binding,
      decision,
      status: 'active',
      expiresAt: host.expiresAt,
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(payerDirectory, `${createHash('sha256').update(ownerRef).digest('hex')}.json`),
    JSON.stringify({
      schemaVersion: 'recorded-funding-payer/v1',
      workspaceId: binding.workspaceId,
      authorizationRef: decision.grant.authorizationId,
      fundingOwner,
      status: 'active',
      expiresAt: host.expiresAt,
    }),
    { mode: 0o600 }
  )
}

/**
 * Children factory for `createProductionFactoryFixture`. Unlike the stub connector used by the other
 * production-composition proofs, the tool executes the real governed delegation path and starts the
 * child on the same production adapter.
 */
export function governedDispatchChildren(hooks) {
  const { evidence } = hooks
  return async ({
    persistence,
    repositories,
    workspaceId,
    actorPrincipalId,
    leasePrincipalRef,
    scopeAuthority,
    state,
    at,
  }) => {
    const toolDefinitionId = id('tld')
    const toolVersionId = id('tlv')
    const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
    await registry.createDefinition({
      toolDefinitionId,
      name: 'delegate-child',
      displayName: 'Governed child dispatch',
      description: 'Dispatches a bounded child through canonical orchestration.',
      ownership: { scope: 'workspace', workspaceId },
      createdAt: at,
    })
    await registry.publishVersion({
      toolVersionId,
      toolDefinitionId,
      semanticVersion: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: { objective: { type: 'string', minLength: 1, maxLength: 8192 } },
        required: ['objective'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      operations: [
        {
          name: 'delegate-child',
          requiredCapabilities: [],
          riskClass: 'high',
          approvalMode: 'never',
          idempotency: 'provider_key',
        },
      ],
      executor: { type: 'connector', reference: 'governed-dispatch-v1' },
      limits: { maxInputBytes: 8192, maxOutputBytes: 4096, timeoutMs: 20000 },
      createdAt: at,
      publishedAt: at,
    })
    const gateway = new ToolGateway(registry)
    gateway.registerExecutor('connector', 'governed-dispatch-v1', {
      async execute(input, version, signal) {
        evidence.executorCalls++
        return hooks.executeGoverned(input, version, signal)
      },
    })
    const interactions = new InMemoryInteractionRepository()
    const approvals = new InteractionToolApprovalCoordinator(
      new InteractionService(interactions),
      interactions
    )
    const toolCalls = new SqliteToolCallRepository(persistence, workspaceId)
    hooks.toolCalls = toolCalls
    hooks.persistence = persistence
    hooks.at = at
    hooks.usageOutcomes = new SqliteChildUsageOutcomeRepository(persistence, childIds.delegationId)
    const service = new PolicyControlledToolExecutionService({
      gateway,
      calls: toolCalls,
      authorizer: {
        async authorize() {
          evidence.policyDecisions++
          hooks.afterPolicyAllow?.()
          return {
            effect: 'allow',
            decisionId: 'governed-dispatch-policy-decision',
            policyVersion: 'governed-dispatch@1',
            reasonCode: 'ALLOW',
            requiresApproval: false,
            evaluatedAt: at,
          }
        },
      },
      approvals,
      rateLimiter: new InMemoryToolRateLimiter(),
      now: () => at,
    })
    const delegationRecords = new SqliteDelegationRepository(persistence)
    hooks.delegationRecords = delegationRecords
    const admissions = new SqliteDelegationToolAdmissionRepository(persistence, workspaceId)
    const lifecycle = new ExecutionLifecycleService(repositories.executions)
    const events = {
      async publish(event, key) {
        await new SqliteDelegationEventPublisher(persistence, event.parentExecutionId).publish(
          event,
          key
        )
        evidence.retainedEvents.push(structuredClone(event))
      },
      async list() {
        if (!state.parentExecutionId) return []
        return new SqliteDelegationEventPublisher(persistence, state.parentExecutionId).list()
      },
    }
    hooks.events = events
    const scopeAdmission = {
      authority: scopeAuthority,
      resolveCallerPrincipalId: async () => actorPrincipalId,
      now: () => at,
    }
    const budgetAdmission = new DurableChildRuntimeBudgetAdmission({
      store: repositories.usage,
      plans: repositories.plans,
    })
    const resolver = new CanonicalDelegationCommandResolver({
      admissions,
      calls: toolCalls,
      assertAuthority: async () => {},
    })

    async function prepare(authority, verified) {
      const parentPlan = authority.request.executionPlan
      const parentContext = await repositories.contexts.get(parentPlan.contextPackage)
      const parent = await repositories.executions.getExecution(authority.request.executionId)
      const childContext = deriveContextPackage(parentContext, {
        objective: verified.objective,
        allowedStateItemIds: [],
        allowedArtifactIds: [],
        budgets: parentContext.budgets,
        successCriteria: parentContext.successCriteria,
        returnContract: parentContext.returnContract,
        compiledAt: at,
      })
      await repositories.contexts.put(childContext)
      const request = {
        toolCallId: childIds.toolCallId,
        idempotencyKey: `pi-child:${verified.sourceKey.slice(-48)}`,
        requestedAt: at,
        policySnapshotRef: 'policy://governed-dispatch/v1',
        requestId: childIds.toolRequestId,
        executionId: authority.request.executionId,
        attemptId: authority.request.attemptId,
        workspaceId,
        profileId: parentPlan.profile.profileId,
        toolDefinitionId,
        toolVersionId,
        operation: 'delegate-child',
        input: { objective: verified.objective },
        grant: {
          workspaceId,
          profileId: parentPlan.profile.profileId,
          toolDefinitionId,
          toolVersionId,
          operations: ['delegate-child'],
          expiresAt: new Date(Date.parse(at) + 240_000).toISOString(),
        },
        audit: { principalRef: actorPrincipalId, traceId: id('trc') },
      }
      // A depth-one child cannot allocate children, so its plan states no allowance to hold back.
      // Otherwise its runtime attempt would keep only part of the funded balance, short of the native
      // request bound its own priced turn must cover.
      const childConstraints = structuredClone(parentPlan.constraints)
      delete childConstraints.limits.childExecutions.budgetAllowance
      const delegation = {
        delegationId: childIds.delegationId,
        parentIntentId: hooks.intentId,
        parentExecutionId: authority.request.executionId,
        parentAttemptId: authority.request.attemptId,
        admittedToolCallId: request.toolCallId,
        childExecutionId: childIds.executionId,
        childAttemptId: childIds.attemptId,
        role: 'researcher',
        profileVersionId: parentPlan.profile.profileVersionId,
        objective: verified.objective,
        parentPlan,
        childPlan: {
          correlation: {
            ...parentPlan.correlation,
            taskId: childIds.taskId,
            requestId: childIds.requestId,
          },
          contextPackage: childContext,
          constraints: childConstraints,
          runtimeRequirements: structuredClone(parentPlan.runtimeRequirements),
          outputContract: structuredClone(parentPlan.outputContract),
          compiledAt: at,
        },
        policy: {
          cancellation: 'cascade',
          deadline: 'bounded_by_parent',
          failure: 'manual',
          maximumRetries: 0,
        },
        acceptedAt: at,
        ...(parent.deadlineAt ? { deadlineAt: parent.deadlineAt } : {}),
      }
      const dispatch = {
        delegationId: childIds.delegationId,
        childAttemptId: childIds.attemptId,
        runtime: { runtimeConnectionId: childIds.runtimeConnectionId },
        dispatchedAt: at,
      }
      evidence.preparedRequests.push(request.requestId)
      const retained = await admissions.retain({
        schemaVersion: 'delegation-tool-admission/v1',
        sourceKey: verified.sourceKey,
        request,
        command: { delegation, dispatch },
      })
      return retained.admission.request
    }

    return {
      tools: { service, interactions },
      delegation: {
        records: delegationRecords,
        lifecycle,
        plans: repositories.plans,
        events,
        scopeAdmission,
      },
      createGovernedDelegateChild(delegationService, context) {
        hooks.delegationService = delegationService
        // The production builder: the composition hands over its own canonical authority, model
        // binding and adapter. Only the evidence counters and the scripted funding record are local.
        const bridge = createProductionChildRuntimeBridge({
          records: delegationRecords,
          lifecycle,
          plans: repositories.plans,
          delegations: delegationService,
          events,
          runtimeConnectionId: childIds.runtimeConnectionId,
          context: {
            ...context,
            authority: {
              async readRecord(input) {
                evidence.bridgeAuthorityReads++
                return hooks.authorityOverride
                  ? hooks.authorityOverride(input)
                  : context.authority.readRecord(input)
              },
            },
            runtime: {
              async start(request) {
                evidence.childStarts.push(structuredClone(request))
                return context.runtime.start(request)
              },
            },
          },
          async reserveBudget(admission) {
            const budget = await budgetAdmission.reserve(admission)
            evidence.reservations.push(structuredClone(budget))
            // The estimate (the child plan's ceiling) and the attempt's reservation are recorded as
            // cost-state evidence in the same step, and retained through the production repository.
            await mutateChildUsage(hooks, (usage) => {
              const identity = childUsageIdentity(admission)
              usage.recordEstimate(identity, {
                currency: 'USD',
                maximumMicrounits: admission.plan.constraints.limits.budget.maximumMicrounits,
                source: 'governed-dispatch-child-plan',
              })
              usage.recordReservation(identity, budget)
            })
            return budget
          },
          async fundChildAttempt({ budget, binding }) {
            await writeChildFunding(hooks, binding)
            evidence.fundingWrites.push(budget.attemptId)
          },
        })
        hooks.bridge = bridge
        hooks.executeGoverned = (input, version, signal) =>
          new GovernedDelegateChildExecutor({
            toolDefinitionId,
            toolVersionId,
            parentExecutionId: input.executionId,
            parentAttemptId: input.attemptId,
            lifecycle,
            plans: repositories.plans,
            delegations: delegationService,
            bridge,
            assertAuthority: async (request, canonicalParentPlan) => {
              assertDelegationToolParentPlan(
                await resolver.getAdmission(request.requestId),
                canonicalParentPlan
              )
            },
            resolveCommand: (request) => resolver.resolve(request),
          }).execute(input, version, signal)
        hooks.scanner = new PiDurableChildProgressScanner({
          now: () => new Date().toISOString(),
          bridge,
          listRetainedChildren: async () => {
            if (!state.parentExecutionId) return []
            const adapter = hooks.adapter
            const rows = []
            for (const record of await delegationRecords.listByParent(state.parentExecutionId)) {
              const journal = adapter.journal
                .list()
                .find(
                  (row) =>
                    row.admission.request.executionId === record.childExecutionId &&
                    row.admission.request.attemptId === record.childAttemptId
                )
              if (!journal) continue
              const attempt = await repositories.executions.getAttempt(record.childAttemptId)
              rows.push({
                identity: {
                  schemaVersion: 'delegation-runtime-admission/v1',
                  parentExecutionId: record.parentExecutionId,
                  parentAttemptId: record.parentAttemptId,
                  delegationId: record.delegationId,
                  childAttemptId: record.childAttemptId,
                },
                handle: journal.admission.handle,
                canonicalState: attempt.state,
              })
            }
            return rows
          },
          assertCurrent: async (retained) => {
            const current = await delegationRecords.get(retained.identity.delegationId)
            if (
              current?.parentExecutionId !== retained.identity.parentExecutionId ||
              current.parentAttemptId !== retained.identity.parentAttemptId ||
              current.childAttemptId !== retained.identity.childAttemptId
            )
              throw new Error('TEST_CHILD_PROGRESS_STALE')
            const call = await toolCalls.get(current.admittedToolCallId)
            if (
              call?.status !== 'succeeded' ||
              call.principalRef !== actorPrincipalId ||
              call.result?.output?.externalSessionId !== retained.handle.externalSessionId
            )
              throw new Error('TEST_CHILD_PROGRESS_CALL_DENIED')
          },
          retainTerminalResult: async (retained, result) => {
            await persistence.transaction(async (tx) => {
              const existing = await tx.get(
                'pi-child-terminal-results',
                retained.identity.childAttemptId
              )
              if (!existing)
                await tx.put({
                  namespace: 'pi-child-terminal-results',
                  id: retained.identity.childAttemptId,
                  value: JSON.parse(JSON.stringify(result)),
                })
            })
            return childIds.terminalResultRef
          },
        })
        return { prepare }
      },
      modelAuthority: { leasePrincipalRef, modelAlias: 'reasoning.standard' },
      runtime: {
        childProgress: {
          scan: async (adapter) => {
            // The composition scans at startup, before it is installed on the host.
            hooks.adapter = adapter
            return hooks.scanner.scan(adapter)
          },
        },
        consumeParentInbox: async () => {},
        onParentInboxWake: async () => {
          evidence.inboxWakes.push((await events.list()).at(-1)?.type ?? 'empty')
        },
      },
    }
  }
}

const usageCode = (error) => (typeof error === 'object' && error !== null ? error.code : undefined)

function childUsageIdentity(admission) {
  return {
    parentExecutionId: admission.identity.parentExecutionId,
    delegationId: admission.identity.delegationId,
    childExecutionId: admission.record.childExecutionId,
    childAttemptId: admission.identity.childAttemptId,
  }
}

/**
 * The cost-state projection is never held in memory between steps: each step loads the durable
 * snapshot, applies its evidence and saves a newer revision only when something changed. A restart
 * therefore resumes from exactly what was recorded.
 */
async function mutateChildUsage(hooks, apply) {
  const stored = await hooks.usageOutcomes.load()
  const usage = new ChildUsageLedger()
  if (stored) usage.restore(stored.snapshot)
  const result = apply(usage)
  const snapshot = usage.snapshot()
  if (!stored || canonicalJsonStringify(stored.snapshot) !== canonicalJsonStringify(snapshot))
    await hooks.usageOutcomes.save({ revision: (stored?.revision ?? 0) + 1, snapshot })
  return result
}

/** The retained child cost state and its durable revision, as a restarted owner would load them. */
export async function readChildCostState(hooks) {
  const stored = await hooks.usageOutcomes.load()
  const usage = new ChildUsageLedger()
  if (stored) usage.restore(stored.snapshot)
  return {
    revision: stored?.revision,
    snapshot: stored?.snapshot,
    outcome: usage.status({
      parentExecutionId: hooks.host.state.parentExecutionId,
      delegationId: childIds.delegationId,
      childExecutionId: childIds.executionId,
      childAttemptId: childIds.attemptId,
    }),
  }
}

/**
 * The production lead terminal settlement, run over the composition's own lead admission database.
 * The composition runs the same class on its recovery interval; it finds the child's completed
 * journal record unbound and leaves it alone.
 */
export async function settleLeadTerminal(host) {
  const database = new DatabaseSync(join(host.directory, 'lead-admission.sqlite'), {
    readOnly: true,
  })
  try {
    return await new SqlitePiLeadTerminalSettlement({
      database,
      journal: host.composition.adapter.journal,
      ledger: host.ledger,
    }).settle()
  } finally {
    database.close()
  }
}

/**
 * TEST ONLY child terminal settlement, composed from the existing machinery: the durable usage
 * ledger (`settle`, `finalizeBudget`), the child cost-state projection and its production
 * repository. Production has this path for the lead only; it is not wired into any composition
 * root here. Every step is idempotent, durable and ordered so that a cost state never runs ahead of
 * the money: report (needs the retained usage entry), settle the attempt reservation, finalize the
 * child budget back into the parent's funding reservation, then reconcile and settle the projection.
 * `hooks.settlementSeam(step)` runs after each durable step and may throw to interrupt.
 */
export function createChildTerminalSettlement(hooks) {
  const { host } = hooks
  const workspaceId = host.workspaceId
  const reservationKey = `runtime-attempt:${childIds.attemptId}`
  const seam = async (step) => hooks.settlementSeam?.(step)
  const identity = () => ({
    parentExecutionId: host.state.parentExecutionId,
    delegationId: childIds.delegationId,
    childExecutionId: childIds.executionId,
    childAttemptId: childIds.attemptId,
  })
  return {
    async settle() {
      const adapter = host.composition.adapter
      const row = adapter.journal
        .list()
        .find((candidate) => candidate.admission.request.executionId === childIds.executionId)
      if (!row) return { state: 'absent' }
      const status = await adapter.status(row.admission.handle)
      // Only a completed run has priced, retained usage. A failed, unknown or running child keeps
      // its reservation and its cost state exactly as recorded until it is reconciled.
      const usage = status.result?.usage
      if (status.state !== 'completed' || usage?.accounting === undefined)
        return { state: 'not_terminal', runtime: status.state }
      const usageEntry = (await host.ledger.entries(workspaceId, childIds.executionId)).find(
        (entry) =>
          entry.kind === 'model_usage' && entry.source.sourceId === usage.accounting.sourceId
      )
      if (!usageEntry) return { state: 'usage_not_retained' }
      const reportId = `usage-settle:${childIds.attemptId}:${createHash('sha256')
        .update(usage.accounting.sourceId)
        .digest('hex')
        .slice(0, 16)}`

      await mutateChildUsage(hooks, (cost) =>
        cost.recordReportedUsage(identity(), usage, {
          reportId,
          publicationSequence: usageEntry.sequence,
        })
      )
      await seam('reported')

      try {
        await host.ledger.settle({
          workspaceId,
          executionId: childIds.executionId,
          reservationKey,
          source: {
            sourceId: childIds.attemptId,
            idempotencyKey: `${reservationKey}:terminal-settle`,
          },
        })
      } catch (error) {
        if (usageCode(error) !== 'RESERVATION_SETTLED') throw error
      }
      await seam('attempt-settled')

      try {
        await host.ledger.finalizeBudget({
          workspaceId,
          executionId: childIds.executionId,
          source: {
            sourceId: `child-final:${childIds.executionId}`,
            idempotencyKey: `child-final:${childIds.executionId}:finalize`,
          },
        })
      } catch (error) {
        if (usageCode(error) !== 'BUDGET_SETTLED') throw error
      }
      await seam('budget-finalized')

      const summary = await host.ledger.summary(workspaceId, childIds.executionId)
      if (!summary.settled || summary.reservedMicrounits !== 0)
        throw new Error('TEST_CHILD_SETTLEMENT_INCOMPLETE')
      // The projection settles exactly what the ledger settled, and only when it agrees with the
      // priced report.
      if (summary.spentMicrounits !== usage.accounting.chargedMicrounits)
        throw new Error('TEST_CHILD_SETTLEMENT_MISMATCH')
      await mutateChildUsage(hooks, (cost) =>
        cost.reconcile(identity(), { reconciledAt: hooks.at })
      )
      await seam('reconciled')
      await mutateChildUsage(hooks, (cost) =>
        cost.settle(identity(), {
          currency: 'USD',
          settledMicrounits: summary.spentMicrounits,
          settledAt: hooks.at,
          settlementRef: reportId,
        })
      )
      return { state: 'settled', spentMicrounits: summary.spentMicrounits }
    },
  }
}
