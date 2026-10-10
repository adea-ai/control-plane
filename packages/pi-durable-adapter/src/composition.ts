import type { PolicyControlledToolExecutionService } from '@control-plane/tool-execution'
import type { DelegationEvent } from '@control-plane/orchestration'
import {
  isRecoveryAuthorityDenial,
  isRecoveryUnavailable,
  PiDurableRuntimeAdapter,
} from './adapter.js'
import type {
  PiDurableRuntimeOptions,
  PiDurableGovernedDelegateChildCompiler,
} from './contracts.js'
import { PiDurableEffectGate, SqliteDurableEffectGateStore } from './effect-gate.js'

/** Codes reported for a retained record that recovery did not resume in this start. A declared
 * denial is also persisted by the adapter, under the recovery claim that observed it. */
export type RecoveryBlockCode =
  | 'PI_RECOVERY_AUTHORITY_BLOCKED'
  | 'PI_RECOVERY_UNAVAILABLE'
  | 'PI_RECOVERY_UNCLASSIFIED'

export interface NodePiDurableCompositionOptions extends Omit<
  PiDurableRuntimeOptions,
  'governedDelegateChild'
> {
  /** Trusted host initialization, completed before any retained recovery is scheduled. */
  readonly onAdapterReady?: (adapter: PiDurableRuntimeAdapter) => void | Promise<void>
  readonly governedDelegateChild?: PiDurableGovernedDelegateChildCompiler
  /** Bind this port to the canonical parent in the host, never to model/request input. */
  readonly parentInbox?: { list(): Promise<readonly DelegationEvent[]> }
  /** Independently authorize/deduplicate publications; reading inbox evidence never infers. */
  readonly consumeParentInbox?: (events: readonly DelegationEvent[]) => Promise<void>
  readonly onParentInboxWake?: () => Promise<void>
  readonly tools?: {
    readonly service: PolicyControlledToolExecutionService
    readonly assertAuthority: ConstructorParameters<
      typeof PiDurableEffectGate
    >[0]['assertAuthority']
  }
}

/** Opt-in Node SQLite composition. No native tools, credential defaults or cloud fallback. */
export async function createNodePiDurableRuntime(options: NodePiDurableCompositionOptions) {
  if (options.governedDelegateChild && !options.tools)
    throw new Error('PI_GOVERNED_TOOL_GATE_REQUIRED')
  let effects: PiDurableEffectGate | undefined
  const { governedDelegateChild, onAdapterReady, ...runtimeOptions } = options
  const adapter = new PiDurableRuntimeAdapter({
    ...runtimeOptions,
    ...(governedDelegateChild
      ? {
          governedDelegateChild: {
            prepare: governedDelegateChild.prepare,
            ...(governedDelegateChild.retainContinuation
              ? { retainContinuation: governedDelegateChild.retainContinuation }
              : {}),
            gate: () => {
              if (!effects) throw new Error('PI_GOVERNED_TOOL_GATE_REQUIRED')
              return effects
            },
          },
        }
      : {}),
  })

  async function recover(): Promise<void> {
    const blocked: Array<{ handleId: string; code: RecoveryBlockCode }> = []
    if (options.parentInbox && options.consumeParentInbox) {
      await options.consumeParentInbox(await options.parentInbox.list())
      try {
        await options.onParentInboxWake?.()
      } catch {
        /* Wake is advisory; inbox evidence remains. */
      }
    }
    for (const record of adapter.journal.list()) {
      const handle = (record.admission as { handle: Parameters<typeof adapter.reconcile>[0] })
        .handle
      if (['starting', 'running', 'unknown', 'cancelling'].includes(record.state)) {
        try {
          await adapter.reconcile(handle)
        } catch (error) {
          // The adapter persisted any declared denial under the claim it held; this start only
          // reports. Unavailable and unclassified failures fence this start and persist nothing.
          if (isRecoveryAuthorityDenial(error))
            blocked.push({ handleId: record.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' })
          else if (isRecoveryUnavailable(error))
            blocked.push({ handleId: record.handleId, code: 'PI_RECOVERY_UNAVAILABLE' })
          else blocked.push({ handleId: record.handleId, code: 'PI_RECOVERY_UNCLASSIFIED' })
        }
      }
    }
    recoveryBlocked = blocked
  }

  let recoveryBlocked: readonly { handleId: string; code: RecoveryBlockCode }[] = []

  try {
    effects = options.tools
      ? new PiDurableEffectGate({
          store: new SqliteDurableEffectGateStore(adapter.journal.database),
          service: options.tools.service,
          assertAuthority: options.tools.assertAuthority,
          ...(options.now ? { now: options.now } : {}),
        })
      : undefined
    await onAdapterReady?.(adapter)
    await recover()
    return {
      adapter,
      effects,
      recover,
      get recoveryBlocked() {
        return recoveryBlocked
      },
      close: () => adapter.close(),
      profile: 'node-sqlite' as const,
    }
  } catch (error) {
    await adapter.close()
    throw error
  }
}
