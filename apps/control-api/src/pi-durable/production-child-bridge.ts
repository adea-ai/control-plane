import {
  CanonicalDelegationRuntimeBridge,
  type CanonicalDelegationAdmission,
  type ChildReceiptReadAuthority,
  type DelegationEventPublisher,
  type DelegationRepository,
  type DelegationRuntimeReceiptRepository,
  type DelegationService,
} from '@control-plane/orchestration'
import type { ExecutionLifecycleService } from '@control-plane/domain'
import {
  childUsageIdentity,
  mutateChildUsage,
  type ChildUsageOutcomesFor,
} from './child-usage-outcomes.js'
import type { ExecutionPlanRepository } from '@control-plane/execution-plan'
import type {
  RuntimeAdapter,
  RuntimeAttemptBudgetAuthority,
  RuntimeStartRequest,
} from '@control-plane/runtime-sdk'

/** The composition's own canonical child ports, handed to the root that builds the bridge. */
export interface ProductionChildBridgeContext {
  /** Server-owned child lineage and current grants; callers supply identifiers only. */
  readonly authority: {
    readRecord(input: { executionId: string; attemptId: string }): Promise<unknown>
  }
  /** The model binding derived from retained child records for one attempt. */
  readonly modelBinding: (input: { executionId: string; attemptId: string }) => Promise<unknown>
  /** The same adapter the lead runs on. Resolves lazily and throws until the adapter is ready. */
  readonly runtime: Pick<RuntimeAdapter, 'start'>
  /** The durable cost-state projection per delegation, shared with the terminal settlement. */
  readonly usageOutcomes: ChildUsageOutcomesFor
}

export interface ProductionChildBridgeOptions {
  /** The same canonical repository retains delegation records and runtime-start receipts. */
  readonly records: DelegationRepository & DelegationRuntimeReceiptRepository
  readonly lifecycle: ExecutionLifecycleService
  readonly plans: ExecutionPlanRepository
  readonly delegations: Pick<DelegationService, 'recordChildProgress'>
  /** The exact parent-scoped publisher that also serves as the durable inbox. */
  readonly events: DelegationEventPublisher
  readonly runtimeConnectionId: string
  readonly context: ProductionChildBridgeContext
  /**
   * `DurableChildRuntimeBudgetAdmission.reserve`, unwrapped, over the usage store the root's child
   * allocator opened the child budgets in. It is injected because the admission lives in the
   * workflow worker, which this app does not depend on.
   */
  readonly reserveBudget: (
    admission: CanonicalDelegationAdmission
  ) => Promise<RuntimeAttemptBudgetAuthority>
  /**
   * Records the operator-owned funding decision for the reserved child attempt, against the binding
   * the composition derived for it. No default exists: this repository has no source that records
   * a child's funding, so a root without one cannot build the bridge.
   */
  readonly fundChildAttempt: (input: {
    readonly budget: RuntimeAttemptBudgetAuthority
    readonly binding: unknown
  }) => Promise<void>
  readonly receiptReadAuthority?: ChildReceiptReadAuthority
  readonly nativeReceiptReader?: {
    readonly runtimeConnectionId: string
    findExistingHandle(request: RuntimeStartRequest): Promise<unknown>
  }
}

const isFunction = (value: unknown) => typeof value === 'function'
const hasFunctions = (port: unknown, names: readonly string[]) =>
  typeof port === 'object' &&
  port !== null &&
  names.every((name) => isFunction((port as Record<string, unknown>)[name]))

/**
 * Every method the bridge calls on an injected port, by path: start (`resolve`, `startChild`),
 * progress (`recordProgress`), session recovery (`recoverChildSession`) and terminal publication
 * (`recoverTerminalPublication`). A port missing any of them refuses the build, so a recovery path
 * can never be the first place a missing port is discovered.
 */
export const productionChildBridgePorts = {
  records: [
    'get',
    'retainChildRuntimeStart',
    'getChildRuntimeStart',
    'bindRecoveredChildSession',
    'bindChildSession',
    'recoverTerminalPublication',
  ],
  lifecycle: ['getExecution'],
  lifecycleRepository: ['getAttempt'],
  plans: ['get'],
  delegations: ['recordChildProgress'],
  events: ['publish'],
  authority: ['readRecord'],
  runtime: ['start'],
  receiptReadAuthority: ['assertQualified', 'assertCurrent', 'now'],
  nativeReceiptReader: ['findExistingHandle'],
} as const

const guards = (options: ProductionChildBridgeOptions): boolean => {
  const { context } = options
  const ports = productionChildBridgePorts
  const receiptsConfigured =
    options.receiptReadAuthority !== undefined || options.nativeReceiptReader !== undefined
  return (
    hasFunctions(options.records, ports.records) &&
    hasFunctions(options.lifecycle, ports.lifecycle) &&
    hasFunctions(
      (options.lifecycle as { repository?: unknown }).repository,
      ports.lifecycleRepository
    ) &&
    hasFunctions(options.plans, ports.plans) &&
    hasFunctions(options.delegations, ports.delegations) &&
    hasFunctions(options.events, ports.events) &&
    hasFunctions(context?.authority, ports.authority) &&
    isFunction(context?.modelBinding) &&
    hasFunctions(context?.runtime, ports.runtime) &&
    isFunction(context?.usageOutcomes) &&
    isFunction(options.reserveBudget) &&
    isFunction(options.fundChildAttempt) &&
    typeof options.runtimeConnectionId === 'string' &&
    // Native receipt recovery needs both halves, each with the methods the bridge calls on it, and
    // both bound to the same connection. Neither half alone can recover a session.
    (!receiptsConfigured ||
      (hasFunctions(options.receiptReadAuthority, ports.receiptReadAuthority) &&
        hasFunctions(options.nativeReceiptReader, ports.nativeReceiptReader) &&
        options.nativeReceiptReader?.runtimeConnectionId === options.runtimeConnectionId))
  )
}

/**
 * Builds the governed child bridge from the composition's canonical ports. Each step the bridge
 * takes is a re-read of current authority first: the child's originating tool call, actor, grant
 * and provider are read before the budget is reserved, the reservation is funded only after it
 * resolves, and the runtime start receives the request only after a final read.
 *
 * What a missing or revoked authority prevents depends on when it is lost. Missing or revoked at
 * the first read: nothing is reserved, funded or started. Lost after the reservation or funding
 * (the final read before the start): the start never happens and nothing is sent, but the
 * reservation, the cost-state evidence and the funding record already exist and are not unwound
 * here; they stay for the terminal settlement to account for. The bridge makes no claim that no
 * earlier accounting occurred.
 *
 * Reopening a composition never reaches this bridge's `startChild`: only the governed executor
 * does, behind the policy-controlled tool service. Recovery and the progress scanner use
 * `recordProgress`, `recoverChildSession` and `recoverTerminalPublication`, none of which start a
 * runtime or reserve a budget.
 */
export function createProductionChildRuntimeBridge(
  options: ProductionChildBridgeOptions
): CanonicalDelegationRuntimeBridge {
  const { context } = options
  if (!guards(options)) throw new Error('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  return new CanonicalDelegationRuntimeBridge({
    records: options.records,
    lifecycle: options.lifecycle,
    plans: options.plans,
    delegations: options.delegations,
    runtime: { start: (request) => context.runtime.start(request) },
    runtimeConnectionId: options.runtimeConnectionId,
    childReceipts: options.records,
    terminalPublisher: options.events,
    ...(options.receiptReadAuthority
      ? {
          receiptReadAuthority: options.receiptReadAuthority,
          nativeReceiptReader: options.nativeReceiptReader,
        }
      : {}),
    async assertAuthority(admission) {
      await context.authority.readRecord({
        executionId: admission.record.childExecutionId,
        attemptId: admission.identity.childAttemptId,
      })
    },
    async reserveBudget(admission) {
      const budget = await options.reserveBudget(admission)
      // The estimate (the child plan's ceiling) and the attempt's reservation are recorded as
      // cost-state evidence in the same step, so the later settlement starts from what was reserved.
      await mutateChildUsage(context.usageOutcomes(admission.identity.delegationId), (usage) => {
        const identity = childUsageIdentity(admission)
        usage.recordEstimate(identity, {
          currency: 'USD',
          maximumMicrounits: admission.plan.constraints.limits.budget.maximumMicrounits,
          source: 'child-plan-budget-ceiling',
        })
        usage.recordReservation(identity, budget)
      })
      const binding = await context.modelBinding({
        executionId: budget.executionId,
        attemptId: budget.attemptId,
      })
      await options.fundChildAttempt({ budget, binding })
      return budget
    },
  })
}
