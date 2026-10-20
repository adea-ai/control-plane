import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createNodePiDurableRuntime,
  createPiDurableUsageAuthority,
  type NodePiDurableCompositionOptions,
  type PiDurableUsageAuthorityOptions,
} from '@control-plane/pi-durable-adapter'
import {
  NodePiDurableLeadAdmission,
  type NodePiDurableLeadAdmissionOptions,
} from './node-admission.js'
import {
  DurablePiDurableLeadService,
  SqlitePiDurableLeadReceiptStore,
} from './pi-durable-lead.service.js'
import { createPiLeadRuntimeAuthorityRouter } from './runtime-authority-router.js'
import { SqlitePiLeadPreparations, type PiLeadPreparationAuthority } from './lead-preparation.js'
import type { PiDurableChildProgressScanner } from './child-progress-scanner.js'
import { SqlitePiLeadRunningLifecycle } from './lead-running-lifecycle.js'
import { SqlitePiLeadTerminalSettlement } from './lead-terminal-settlement.js'
import { PiChildTerminalSettlement, type ChildSettlementStep } from './child-terminal-settlement.js'
import type { ChildUsageOutcomesFor } from './child-usage-outcomes.js'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { DelegationService } from '@control-plane/orchestration'

export interface NodePiDurableLeadCompositionOptions {
  readonly onAdapterReady?: NodePiDurableCompositionOptions['onAdapterReady']
  readonly directory: string
  readonly admission: Omit<NodePiDurableLeadAdmissionOptions, 'database'>
  readonly usage: PiDurableUsageAuthorityOptions
  readonly provider: NodePiDurableCompositionOptions['resolveProvider']
  readonly reconcileInference: NodePiDurableCompositionOptions['reconcileInference']
  // Test seam: the restart proof injects the engine so it can hold a native dispatch open.
  readonly engineFactory?: NodePiDurableCompositionOptions['engineFactory']
  readonly verifyApproval?: NodePiDurableCompositionOptions['verifyApproval']
  readonly parentInbox?: NodePiDurableCompositionOptions['parentInbox']
  readonly consumeParentInbox?: NodePiDurableCompositionOptions['consumeParentInbox']
  readonly onParentInboxWake?: NodePiDurableCompositionOptions['onParentInboxWake']
  readonly tools?: NodePiDurableCompositionOptions['tools']
  readonly governedDelegateChild?: NodePiDurableCompositionOptions['governedDelegateChild']
  /** Host prepare plus retained execute for governed management calls. */
  readonly governedManagementCall?: NodePiDurableCompositionOptions['governedManagementCall']
  /** The same canonical service used by child admission/progress. */
  readonly delegationService?: Pick<DelegationService, 'cancelChildren'>
  /** Retained read-only child observations from that same canonical service. */
  readonly childDelegations?: Pick<DelegationService, 'listChildren'>
  /** A child must independently reload its canonical lineage, selection and authority. */
  readonly childAuthority?: Pick<
    NodePiDurableCompositionOptions,
    'resolveAdmission' | 'assertAuthority'
  >
  readonly preparationAuthority?: PiLeadPreparationAuthority
  /** Server-bound canonical child scanner. No child identity is accepted from an HTTP payload. */
  readonly childProgress?: Pick<PiDurableChildProgressScanner, 'scan'>
  /**
   * Terminal accounting for completed children: the canonical delegation records, the child cost-state
   * store and the clock. It runs beside the lead settlement on every recovery pass and shares its ledger.
   */
  readonly childSettlement?: {
    readonly delegations: ConstructorParameters<typeof PiChildTerminalSettlement>[0]['delegations']
    readonly usageOutcomes: ChildUsageOutcomesFor
    readonly now: () => string
    readonly afterStep?: (step: ChildSettlementStep) => Promise<void>
  }
  /** Cadence of the periodic recovery pass; defaults to 30 seconds. Tests shorten it. */
  readonly periodicRecoveryIntervalMs?: number
}

/** Explicit remote-host composition with canonical admission and existing ledger.
 * Product authority, current provider eligibility and recorded spending decisions
 * are mandatory host integrations. Nothing is enabled by an environment default.
 */
export async function createNodePiDurableLeadComposition(
  options: NodePiDurableLeadCompositionOptions
) {
  if (
    options.governedDelegateChild &&
    (!options.childAuthority ||
      !options.childProgress ||
      !options.parentInbox ||
      !options.consumeParentInbox ||
      !options.delegationService)
  )
    throw new Error('PI_CHILD_COMPOSITION_REQUIRED')
  const recoveryIntervalMs = options.periodicRecoveryIntervalMs ?? 30_000
  if (!Number.isSafeInteger(recoveryIntervalMs) || recoveryIntervalMs < 1)
    throw new Error('PI_LEAD_RECOVERY_INTERVAL_INVALID')
  const usage = createPiDurableUsageAuthority(options.usage)
  mkdirSync(options.directory, { recursive: true })
  const database = new DatabaseSync(join(options.directory, 'lead-admission.sqlite'), {
    timeout: 5000,
  })
  let runtime: Awaited<ReturnType<typeof createNodePiDurableRuntime>> | undefined
  try {
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    const admission = new NodePiDurableLeadAdmission({
      ...options.admission,
      database,
      inspectRuntime: async (requirements) => {
        if (!runtime) throw new Error('PI_RUNTIME_NOT_INITIALIZED')
        return runtime.adapter.inspect(requirements)
      },
    })
    const leadLifecycle = new SqlitePiLeadRunningLifecycle({
      database,
      executions: options.admission.executions,
      assertAuthority: (authority) => admission.canonicalAuthority.assertAuthority(authority),
    })
    runtime = await createNodePiDurableRuntime({
      ...(options.onAdapterReady ? { onAdapterReady: options.onAdapterReady } : {}),
      directory: options.directory,
      ...(options.admission.now ? { now: options.admission.now } : {}),
      ...createPiLeadRuntimeAuthorityRouter(
        {
          resolveAdmission: (request) => admission.canonicalAuthority.resolveAdmission(request),
          assertAuthority: (authority, purpose) =>
            admission.canonicalAuthority.assertAuthority(authority, purpose),
        },
        options.childAuthority
      ),
      // J1 independently owns child lifecycle; never apply the lead bridge to children.
      onExecutionRunning: async (authority) => {
        if (!assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan)
          await leadLifecycle.onExecutionRunning(authority)
      },
      resolveProvider: options.provider,
      ...(options.admission.scopeAuthority
        ? { scopeAuthority: options.admission.scopeAuthority }
        : {}),
      ...usage,
      reconcileInference: options.reconcileInference,
      ...(options.engineFactory ? { engineFactory: options.engineFactory } : {}),
      ...(options.verifyApproval ? { verifyApproval: options.verifyApproval } : {}),
      ...(options.parentInbox ? { parentInbox: options.parentInbox } : {}),
      ...(options.consumeParentInbox ? { consumeParentInbox: options.consumeParentInbox } : {}),
      ...(options.onParentInboxWake ? { onParentInboxWake: options.onParentInboxWake } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.governedDelegateChild
        ? { governedDelegateChild: options.governedDelegateChild }
        : {}),
      ...(options.governedManagementCall
        ? { governedManagementCall: options.governedManagementCall }
        : {}),
    })
    const preparations = options.preparationAuthority
      ? new SqlitePiLeadPreparations(
          database,
          options.preparationAuthority,
          options.admission.now,
          { findRuntimeHandle: (request) => runtime!.adapter.findExistingHandle(request) }
        )
      : undefined
    const terminalSettlement = new SqlitePiLeadTerminalSettlement({
      database,
      journal: runtime.adapter.journal,
      ledger: options.usage.ledger,
    })
    const childTerminalSettlement = options.childSettlement
      ? new PiChildTerminalSettlement({
          journal: runtime.adapter.journal,
          ledger: options.usage.ledger,
          ...options.childSettlement,
        })
      : undefined
    const recoverUnclaimedPreparations = async () => {
      if (!preparations || !options.preparationAuthority) return undefined
      return admission.recoverUnclaimedPreparations(
        (unclaimed) => options.preparationAuthority!.releaseExpired(unclaimed),
        async (intentId) => preparations.hasIntent(intentId)
      )
    }
    await preparations?.recoverExpired()
    let unclaimedPreparationRecovery = await recoverUnclaimedPreparations()
    let childProgressRecovery = await options.childProgress?.scan(runtime.adapter)
    let preparationRecovery: Promise<void> | undefined
    let preparationRecoveryBlocked = (unclaimedPreparationRecovery?.pending ?? 0) > 0
    const service = new DurablePiDurableLeadService({
      authority: admission,
      adapter: runtime.adapter,
      receipts: new SqlitePiDurableLeadReceiptStore(database),
      findRuntimeHandle: (request) => runtime!.adapter.findExistingHandle(request),
      ...(preparations ? { preparations } : {}),
      ...(options.delegationService ? { delegationService: options.delegationService } : {}),
      ...(options.childDelegations ? { childDelegations: options.childDelegations } : {}),
      ...(options.admission.now ? { now: options.admission.now } : {}),
    })
    // Created last: after every awaited step and the service, nothing can throw before the return, so a
    // failed initialization never leaves an interval running against a closed store.
    const recoveryTimer = setInterval(() => {
      if (preparationRecovery) return
      preparationRecovery = (async () => {
        await preparations?.recoverExpired()
        unclaimedPreparationRecovery = await recoverUnclaimedPreparations()
        childProgressRecovery = await options.childProgress?.scan(runtime!.adapter)
      })()
        .then(() => {
          preparationRecoveryBlocked = (unclaimedPreparationRecovery?.pending ?? 0) > 0
        })
        .catch(() => {
          // A failed release remains retained for the next scan; never infer to repair it.
          preparationRecoveryBlocked = true
        })
        .then(async () => {
          // Terminal health lives in the settlement: a refused or failed pass leaves the store blocked.
          await terminalSettlement.settle().catch(() => undefined)
          await childTerminalSettlement?.settle().catch(() => undefined)
        })
        .finally(() => {
          preparationRecovery = undefined
        })
    }, recoveryIntervalMs)
    recoveryTimer.unref()
    const initializedRuntime = runtime
    const publicRecoveries = new Set<Promise<void>>()
    let closePromise: Promise<void> | undefined
    const assertOpen = () => {
      if (closePromise !== undefined) throw new Error('PI_LEAD_COMPOSITION_CLOSED')
    }
    return {
      ...runtime,
      admission,
      service,
      async recover() {
        assertOpen()
        const recovery = (async () => {
          await initializedRuntime.recover()
          await preparations?.recoverExpired()
          unclaimedPreparationRecovery = await recoverUnclaimedPreparations()
          preparationRecoveryBlocked = (unclaimedPreparationRecovery?.pending ?? 0) > 0
          childProgressRecovery = await options.childProgress?.scan(initializedRuntime.adapter)
          await terminalSettlement.settle()
          await childTerminalSettlement?.settle()
        })()
        publicRecoveries.add(recovery)
        try {
          await recovery
        } finally {
          publicRecoveries.delete(recovery)
        }
      },
      get preparationRecoveryBlocked() {
        return preparationRecoveryBlocked
      },
      get childProgressRecovery() {
        return childProgressRecovery
      },
      get unclaimedPreparationRecovery() {
        return unclaimedPreparationRecovery
      },
      get recoveryBlocked() {
        return initializedRuntime.recoveryBlocked
      },
      settleTerminalAccounting: () => terminalSettlement.settle(),
      get terminalSettlementBlocked() {
        return terminalSettlement.blocked
      },
      /** Settles completed children now. Undefined when no child settlement is configured. */
      settleChildTerminalAccounting: childTerminalSettlement
        ? () => childTerminalSettlement.settle()
        : undefined,
      get childTerminalSettlementBlocked() {
        return childTerminalSettlement?.blocked ?? false
      },
      close() {
        closePromise ??= (async () => {
          clearInterval(recoveryTimer)
          // Accepted recovery calls keep the stores live until they settle, including failures.
          await Promise.allSettled(publicRecoveries)
          await preparationRecovery
          await terminalSettlement.close()
          await childTerminalSettlement?.close()
          try {
            await initializedRuntime.close()
          } finally {
            database.close()
          }
        })()
        return closePromise
      },
    }
  } catch (error) {
    try {
      await runtime?.close()
    } catch {
      /* Preserve the initialization error after attempting runtime cleanup. */
    } finally {
      database.close()
    }
    throw error
  }
}
