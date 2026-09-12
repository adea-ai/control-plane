import { z } from 'zod'
import {
  ContextNodeInboxRecordSchema,
  createContextNodeInboxRecord,
  createQueuedContextCommandRecord,
  type ContextCommandRecord,
  type ContextNodeInboxRecord,
  type ContextNodeInboxRepository,
} from '@control-plane/domain'
import { GatewayCommandEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'

const Outcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), result: z.record(z.string(), z.json()) }).strict(),
  z
    .object({ status: z.literal('failed'), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/) })
    .strict(),
  z.object({ status: z.literal('unknown') }).strict(),
])

export interface ContextNodeProviderDriver {
  execute(command: ContextCommandRecord, signal: AbortSignal): Promise<unknown>
  /** Observe the original operation ID; must never initiate another provider read. */
  reconcile(command: ContextCommandRecord, signal: AbortSignal): Promise<unknown>
}

export interface ContextNodeHandlerOptions {
  readonly workspaceId: string
  readonly nodeId: string
  readonly repository: ContextNodeInboxRepository
  readonly driver: ContextNodeProviderDriver
  /** Required trusted authority check, including active channel, principal and provider grant. */
  readonly authorize: (
    command: ContextCommandRecord,
    action: 'execute' | 'reconcile' | 'replay'
  ) => Promise<void>
  readonly timeoutMs: number
  readonly now?: () => Date
}

/** Durable node execution, not a socket or an authorization policy implementation. */
export class ContextNodeHandler {
  constructor(readonly options: ContextNodeHandlerOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 300000
    )
      fail('INVALID_TIMEOUT')
  }

  async execute(input: unknown): Promise<ContextNodeInboxRecord> {
    const command = this.#command(input)
    await this.#authorize(command, 'execute')
    let current = await this.options.repository.get(
      command.scope.workspaceId,
      command.nodeId,
      command.commandId
    )
    if (current) this.#same(current, command)
    else {
      const accepted = await this.options.repository.accept(
        createContextNodeInboxRecord(command.commandEnvelope, this.#now())
      )
      if (accepted.outcome === 'conflict') fail('PAYLOAD_CONFLICT')
      current = accepted.record
      this.#same(current, command)
    }
    if (current.status !== 'accepted') {
      await this.#authorize(command, 'replay')
      return structuredClone(current)
    }
    await this.#authorize(command, 'execute')
    const at = this.#now()
    if (Date.parse(at) >= Date.parse(current.command.expiresAt))
      return this.#transition(current, { status: 'expired', terminalAt: at, updatedAt: at })
    const executing = await this.#transition(current, {
      status: 'executing',
      startedAt: at,
      updatedAt: at,
    })
    // Only the successful CAS owner invokes the provider. A losing caller must retry lookup.
    return this.#invoke(executing, 'execute', command)
  }

  async reconcile(input: unknown): Promise<ContextNodeInboxRecord> {
    const command = this.#command(input)
    await this.#authorize(command, 'reconcile')
    const current = await this.options.repository.get(
      command.scope.workspaceId,
      command.nodeId,
      command.commandId
    )
    if (!current) fail('NOT_FOUND')
    this.#same(current, command)
    if (current.status !== 'executing' && current.status !== 'reconciliation_required')
      return structuredClone(current)
    const uncertain =
      current.status === 'executing'
        ? await this.#transition(current, {
            status: 'reconciliation_required',
            updatedAt: this.#now(),
          })
        : current
    return this.#invoke(uncertain, 'reconcile', command)
  }

  async #invoke(
    current: ContextNodeInboxRecord,
    action: 'execute' | 'reconcile',
    authorizationCommand: ContextCommandRecord
  ) {
    try {
      await this.#authorize(authorizationCommand, action)
      if (action === 'execute' && Date.parse(this.#now()) >= Date.parse(current.command.expiresAt))
        fail('GRANT_EXPIRED')
      const outcome = Outcome.parse(
        await bounded(
          (signal) => this.options.driver[action](structuredClone(current.command), signal),
          action === 'execute'
            ? Math.min(
                this.options.timeoutMs,
                Math.max(1, Date.parse(current.command.expiresAt) - Date.parse(this.#now()))
              )
            : this.options.timeoutMs
        )
      )
      await this.#authorize(authorizationCommand, action)
      if (outcome.status === 'unknown') return this.#uncertain(current)
      const at = this.#now()
      return await this.#transition(current, { ...outcome, terminalAt: at, updatedAt: at })
    } catch {
      // Includes timeout, invalid output, revocation and ambiguous storage acknowledgement.
      // Never infer that a provider call did not happen from a thrown exception.
      const stored = await this.options.repository.get(
        current.command.scope.workspaceId,
        current.command.nodeId,
        current.command.commandId
      )
      if (!stored) fail('NOT_FOUND')
      this.#same(stored, current.command)
      const result = await this.#uncertain(stored)
      await this.#authorize(authorizationCommand, 'replay')
      return result
    }
  }

  async #uncertain(current: ContextNodeInboxRecord) {
    return current.status === 'executing'
      ? this.#transition(current, { status: 'reconciliation_required', updatedAt: this.#now() })
      : structuredClone(current)
  }

  async #transition(current: ContextNodeInboxRecord, changes: Partial<ContextNodeInboxRecord>) {
    const next = ContextNodeInboxRecordSchema.parse({
      ...current,
      ...changes,
      version: current.version + 1,
    })
    if (!(await this.options.repository.compareAndSet(current.version, next)))
      fail('STATE_CONFLICT')
    return next
  }

  #command(input: unknown) {
    const envelope = GatewayCommandEnvelopeSchema.parse(input)
    const command = createQueuedContextCommandRecord(envelope, envelope.issuedAt)
    if (
      command.scope.workspaceId !== this.options.workspaceId ||
      command.nodeId !== this.options.nodeId
    )
      fail('SCOPE_MISMATCH')
    if (Date.parse(command.expiresAt) - Date.parse(command.issuedAt) > 86400000)
      fail('GRANT_TOO_LONG')
    return command
  }
  #same(record: ContextNodeInboxRecord, command: ContextCommandRecord) {
    if (
      record.command.commandId !== command.commandId ||
      record.command.nodeId !== command.nodeId ||
      record.command.scope.workspaceId !== command.scope.workspaceId ||
      record.command.payloadHash !== command.payloadHash
    )
      fail('PAYLOAD_CONFLICT')
  }
  #authorize(command: ContextCommandRecord, action: 'execute' | 'reconcile' | 'replay') {
    return bounded(
      () => this.options.authorize(structuredClone(command), action),
      this.options.timeoutMs
    )
  }
  #now() {
    return (this.options.now?.() ?? new Date()).toISOString()
  }
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('CONTEXT_NODE_TIMEOUT'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
function fail(code: string): never {
  throw new Error(`CONTEXT_NODE_${code}`)
}
