import type { PolicyControlledToolExecutionService } from '@control-plane/tool-execution'
import type { DelegationEvent } from '@control-plane/orchestration'
import { PiDurableRuntimeAdapter } from './adapter.js'
import type {
  PiDurableRuntimeOptions,
  PiDurableGovernedDelegateChildCompiler,
} from './contracts.js'
import { PiDurableEffectGate, SqliteDurableEffectGateStore } from './effect-gate.js'

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
            gate: () => {
              if (!effects) throw new Error('PI_GOVERNED_TOOL_GATE_REQUIRED')
              return effects
            },
          },
        }
      : {}),
  })

  async function recover(): Promise<void> {
    const blocked: Array<{ handleId: string; code: 'PI_RECOVERY_AUTHORITY_BLOCKED' }> = []
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
        } catch {
          blocked.push({ handleId: record.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' })
          try {
            adapter.journal.update(record.handleId, record.epoch, {
              detail: { ...record.detail, recoveryBlocked: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
            })
          } catch {
            /* A newer owner keeps its record. */
          }
        }
      }
    }
    recoveryBlocked = blocked
  }

  let recoveryBlocked: readonly { handleId: string; code: 'PI_RECOVERY_AUTHORITY_BLOCKED' }[] = []

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
