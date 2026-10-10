import type {
  ChildAdmissionAllocator,
  ChildAdmissionAuthority,
  ChildAdmissionReader,
  ChildAdmissionRequest,
  DelegationEvent,
  DelegationEventPublisher,
  DelegationParentInbox,
  DelegationRepository,
  DelegationScopeAdmission,
} from '@control-plane/orchestration'
import { DelegationService } from '@control-plane/orchestration'
import type { ExecutionLifecycleService } from '@control-plane/domain'
import type { ExecutionPlanRepository } from '@control-plane/execution-plan'
import { createProductionChildBudgetAdmissionAuthority } from './production-child-budget-admission.js'

type ProductAuthority = Parameters<
  typeof createProductionChildBudgetAdmissionAuthority
>[0]['product']

export interface ProductionChildDelegationOptions {
  /** The same canonical repository implements the allocator transaction. */
  readonly records: DelegationRepository & ChildAdmissionAllocator
  readonly lifecycle: ExecutionLifecycleService
  readonly plans: ExecutionPlanRepository
  /** The exact parent-scoped publisher also consumed as the durable inbox. */
  readonly events: DelegationEventPublisher & DelegationParentInbox
  readonly scopeAdmission: DelegationScopeAdmission
  readonly product: ProductAuthority
  /** Server-current canonical child request, actor, audience and selection references. */
  readonly readCurrent: (
    request: ChildAdmissionRequest,
    reader?: ChildAdmissionReader
  ) => Promise<unknown>
  readonly now?: () => string
  /** Optional advisory wake. It runs only after the durable inbox publish resolves. */
  readonly onEventRetained?: (event: DelegationEvent) => Promise<void>
}

/**
 * The production child path couples product-current admission to the canonical
 * allocator. DelegationService invokes the product preflight before writing the
 * child plan/execution/attempt, then the allocator repeats it inside its write
 * transaction before creating any child or budget records.
 */
export function createProductionChildDelegation(options: ProductionChildDelegationOptions) {
  const childAdmission: ChildAdmissionAuthority = createProductionChildBudgetAdmissionAuthority({
    product: options.product,
    readCurrent: options.readCurrent,
    ...(options.now ? { now: options.now } : {}),
  })
  const service = new DelegationService({
    delegations: options.records,
    childAllocator: options.records,
    lifecycle: options.lifecycle,
    plans: options.plans,
    events: options.events,
    childAdmission,
    scopeAdmission: options.scopeAdmission,
    ...(options.onEventRetained ? { onEventRetained: options.onEventRetained } : {}),
  })
  return { service, childAdmission }
}
