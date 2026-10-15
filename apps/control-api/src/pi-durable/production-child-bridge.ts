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

const required = (value: unknown) => typeof value === 'function'

/**
 * Builds the governed child bridge from the composition's canonical ports. Each step the bridge
 * takes is a re-read of current authority first: the child's originating tool call, actor, grant
 * and provider are read before the budget is reserved, the reservation is funded only after it
 * resolves, and the runtime start receives the request only after a final read. A missing or
 * revoked authority therefore ends before any reservation, funding record or start.
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
  if (
    !required(options.records?.get) ||
    !required(options.records?.retainChildRuntimeStart) ||
    !required(options.records?.bindChildSession) ||
    !required(options.lifecycle?.getExecution) ||
    !required(options.plans?.get) ||
    !required(options.delegations?.recordChildProgress) ||
    !required(options.events?.publish) ||
    !required(context?.authority?.readRecord) ||
    !required(context?.modelBinding) ||
    !required(context?.runtime?.start) ||
    !required(options.reserveBudget) ||
    !required(options.fundChildAttempt) ||
    (options.receiptReadAuthority === undefined) !== (options.nativeReceiptReader === undefined)
  )
    throw new Error('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
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
      const binding = await context.modelBinding({
        executionId: budget.executionId,
        attemptId: budget.attemptId,
      })
      await options.fundChildAttempt({ budget, binding })
      return budget
    },
  })
}
