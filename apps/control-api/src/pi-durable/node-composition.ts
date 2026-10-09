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
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { DelegationService } from '@control-plane/orchestration'

/**
 * Interface receipt (Root relay): DeepSeek1215 module commit fc42c7dd,
 * CP PR1043 comment 6076412118. The canonical
 * `PiDurableGovernedManagementCallEnginePort` lands in
 * @control-plane/pi-durable-adapter (DeepSeek-owned adapter hook, reported
 * upcoming and not yet qualified); this structural mirror keeps the narrow
 * composition pass-through type-checked in the meantime without importing
 * the not-yet-present module. The caller retains the FULL immutable request
 * (`management-governed-call.ts`, fc42c7dd) — this composition only forwards
 * the port and performs no validation itself.
 */
export interface PiDurableGovernedManagementCallPort {
  /**
   * Always present: one execute per retained identity (the caller built by
   * createProductionGovernedManagementCall supplies exactly this today).
   */
  execute(request: Readonly<Record<string, unknown>>): Promise<unknown>
  /**
   * Required by the canonical engine port when DeepSeek1215's adapter hook
   * publishes it; optional while a composition threads the caller itself.
   * Repeatable boundary check; never consumes approval or mints a decision.
   */
  assertCurrent?(
    request: Readonly<Record<string, unknown>>,
    boundary?: 'admission' | 'approval' | 'effect'
  ): Promise<void>
  prepare?(authority: unknown, verified: unknown): Promise<unknown>
  readonly source?: string
}

export interface NodePiDurableLeadCompositionOptions {
  readonly onAdapterReady?: NodePiDurableCompositionOptions['onAdapterReady']
  readonly directory: string
  readonly admission: Omit<NodePiDurableLeadAdmissionOptions, 'database'>
  readonly usage: PiDurableUsageAuthorityOptions
  readonly provider: NodePiDurableCompositionOptions['resolveProvider']
  readonly reconcileInference: NodePiDurableCompositionOptions['reconcileInference']
  readonly verifyApproval?: NodePiDurableCompositionOptions['verifyApproval']
  readonly parentInbox?: NodePiDurableCompositionOptions['parentInbox']
  readonly consumeParentInbox?: NodePiDurableCompositionOptions['consumeParentInbox']
  readonly onParentInboxWake?: NodePiDurableCompositionOptions['onParentInboxWake']
  readonly tools?: NodePiDurableCompositionOptions['tools']
  readonly governedDelegateChild?: NodePiDurableCompositionOptions['governedDelegateChild']
  /** Durable governed management caller; retains the full immutable request. */
  readonly governedManagementCall?: PiDurableGovernedManagementCallPort
  /** The same canonical service used by child admission/progress. */
  readonly delegationService?: Pick<DelegationService, 'cancelChildren'>
  /** A child must independently reload its canonical lineage, selection and authority. */
  readonly childAuthority?: Pick<
    NodePiDurableCompositionOptions,
    'resolveAdmission' | 'assertAuthority'
  >
  readonly preparationAuthority?: PiLeadPreparationAuthority
  /** Server-bound canonical child scanner. No child identity is accepted from an HTTP payload. */
  readonly childProgress?: Pick<PiDurableChildProgressScanner, 'scan'>
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
    const runtimeOptions: NodePiDurableCompositionOptions & {
      readonly governedManagementCall?: PiDurableGovernedManagementCallPort
    } = {
      ...(options.onAdapterReady ? { onAdapterReady: options.onAdapterReady } : {}),
      directory: options.directory,
      ...(options.admission.now ? { now: options.admission.now } : {}),
      ...createPiLeadRuntimeAuthorityRouter(
        {
          resolveAdmission: (request) => admission.canonicalAuthority.resolveAdmission(request),
          assertAuthority: (authority) => admission.canonicalAuthority.assertAuthority(authority),
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
    }
    runtime = await createNodePiDurableRuntime(runtimeOptions)
    const preparations = options.preparationAuthority
      ? new SqlitePiLeadPreparations(
          database,
          options.preparationAuthority,
          options.admission.now,
          { findRuntimeHandle: (request) => runtime!.adapter.findExistingHandle(request) }
        )
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
    const preparationTimer =
      preparations || options.childProgress
        ? setInterval(() => {
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
              .finally(() => {
                preparationRecovery = undefined
              })
          }, 30_000)
        : undefined
    preparationTimer?.unref()
    const service = new DurablePiDurableLeadService({
      authority: admission,
      adapter: runtime.adapter,
      receipts: new SqlitePiDurableLeadReceiptStore(database),
      findRuntimeHandle: (request) => runtime!.adapter.findExistingHandle(request),
      ...(preparations ? { preparations } : {}),
      ...(options.delegationService ? { delegationService: options.delegationService } : {}),
      ...(options.admission.now ? { now: options.admission.now } : {}),
    })
    const initializedRuntime = runtime
    let closePromise: Promise<void> | undefined
    return {
      ...runtime,
      admission,
      service,
      async recover() {
        await initializedRuntime.recover()
        await preparations?.recoverExpired()
        unclaimedPreparationRecovery = await recoverUnclaimedPreparations()
        preparationRecoveryBlocked = (unclaimedPreparationRecovery?.pending ?? 0) > 0
        childProgressRecovery = await options.childProgress?.scan(initializedRuntime.adapter)
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
      close() {
        closePromise ??= (async () => {
          if (preparationTimer) clearInterval(preparationTimer)
          await preparationRecovery
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
