import { randomBytes } from 'node:crypto'
import {
  createRuntimeNodeContextCommand,
  RuntimeNodeContextReadBindingSchema,
  type CortanaAdapterOptions,
  type RuntimeNodeContextReadBinding,
} from '@control-plane/cortana-context-adapter'
import {
  ContextCommandGrantAuthority,
  ContextCommandGrantSchema,
  createQueuedContextCommandRecord,
  type ContextCommandGrantRepository,
} from '@control-plane/domain'
import type {
  ActiveRuntimeNodeChannelRecord,
  RuntimeNodeCoordinationPort,
} from './websocket-coordination.js'

type BindingInput = Parameters<NonNullable<CortanaAdapterOptions['bindRuntimeNodeRead']>>[0]

export interface ContextReadBindingOptions {
  readonly workspaceId: string
  readonly providerRef: string
  readonly mappedProjectRef: string
  readonly authorizationRef: string
  readonly grants: Pick<ContextCommandGrantRepository, 'get'>
  readonly coordination: Pick<RuntimeNodeCoordinationPort, 'lookup'>
  readonly nextSequence: (channel: ActiveRuntimeNodeChannelRecord) => Promise<number>
  /** Supplied from the authenticated invocation's tracing context. */
  readonly traceId: () => string
}

export class ContextRuntimeNodeReadBinder {
  readonly #authority: ContextCommandGrantAuthority
  constructor(readonly options: ContextReadBindingOptions) {
    this.#authority = new ContextCommandGrantAuthority(options.grants)
  }

  async bind(input: BindingInput, signal: AbortSignal): Promise<RuntimeNodeContextReadBinding> {
    const { request } = structuredClone(input)
    signal.throwIfAborted()
    if (
      request.executionLocation !== 'runtime_node' ||
      request.policy.mode === 'disabled' ||
      request.workspaceId !== this.options.workspaceId ||
      input.providerRef !== this.options.providerRef ||
      !request.operationId
    )
      throw new Error('CONTEXT_BINDING_SCOPE_MISMATCH')
    const grant = ContextCommandGrantSchema.parse(
      await this.options.grants.get(this.options.workspaceId, this.options.authorizationRef)
    )
    signal.throwIfAborted()
    if (
      grant.providerRef !== this.options.providerRef ||
      grant.mappedProjectRef !== this.options.mappedProjectRef
    )
      throw new Error('CONTEXT_BINDING_SCOPE_MISMATCH')
    const channel = await this.options.coordination.lookup(grant.nodeId)
    signal.throwIfAborted()
    if (!channel || channel.nodeId !== grant.nodeId || channel.workspaceId !== request.workspaceId)
      throw new Error('CONTEXT_BINDING_CHANNEL_UNAVAILABLE')
    const deadline = Math.min(
      Date.parse(request.now) + request.policy.maximumLatencyMs,
      Date.parse(grant.expiresAt)
    )
    const now = Date.now()
    if (
      !Number.isFinite(deadline) ||
      deadline <= now ||
      deadline - now > 300000 ||
      Date.parse(request.now) > now
    )
      throw new Error('CONTEXT_BINDING_DEADLINE_INVALID')
    const binding = RuntimeNodeContextReadBindingSchema.parse({
      nodeId: grant.nodeId,
      workspaceId: request.workspaceId,
      providerRef: grant.providerRef,
      principalRef: request.principalRef,
      scopeDigest: request.scopeDigest,
      authorizationRef: this.options.authorizationRef,
      channelGeneration: channel.channelGeneration,
      traceId: this.options.traceId(),
      commandId: commandId(),
      idempotencyKey: request.operationId,
      sequence: 0, // Preflight only; never returned or transmitted without a durable reservation.
      expiresAt: new Date(deadline).toISOString(),
    })
    const candidate = createQueuedContextCommandRecord(
      createRuntimeNodeContextCommand(
        request,
        binding,
        binding.expiresAt,
        this.options.mappedProjectRef
      ),
      request.now
    )
    await this.#authority.authorize(candidate)
    signal.throwIfAborted()
    const sequence = await this.options.nextSequence(structuredClone(channel))
    signal.throwIfAborted()
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2147483647)
      throw new Error('CONTEXT_BINDING_SEQUENCE_INVALID')
    await this.#authority.authorize(candidate)
    signal.throwIfAborted()
    const current = await this.options.coordination.lookup(grant.nodeId)
    signal.throwIfAborted()
    if (
      !current ||
      current.nodeId !== grant.nodeId ||
      current.workspaceId !== channel.workspaceId ||
      current.channelGeneration !== channel.channelGeneration ||
      current.connectionId !== channel.connectionId ||
      current.gatewayInstanceId !== channel.gatewayInstanceId
    )
      throw new Error('CONTEXT_BINDING_CHANNEL_REPLACED')
    if (deadline <= Date.now()) throw new Error('CONTEXT_BINDING_DEADLINE_INVALID')
    return RuntimeNodeContextReadBindingSchema.parse({ ...binding, sequence })
  }
}

function commandId(): string {
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  for (let index = 0; index < 26; index++) {
    encoded = alphabet[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return `cmd_${encoded}`
}
