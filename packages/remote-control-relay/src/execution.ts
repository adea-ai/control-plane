import {
  ExecutionAcceptanceRequestSchema,
  ExecutionAcceptanceResponseSchema,
  type ExecutionAcceptanceResponse,
} from '@control-plane/contracts'
import { z } from 'zod'
import {
  decryptRelayPayload,
  RelayEnvelopeError,
  sha256,
  type HostEncryptionKeyPair,
} from './crypto.js'
import { EncryptedRelayEnvelopeSchema, type EncryptedRelayEnvelope } from './protocol.js'
import {
  InMemoryRelayCommandResultRepository,
  RelayMetadataCommandProcessor,
  type RelayCommandResult,
  type RelayCommandResultRepository,
  type RelayHostCommandProcessor,
  type RelayMetadataCommandResultRepository,
} from './relay.js'
import type { RelayMetadataCommand } from './protocol.js'

export interface ExecutionAcceptancePort {
  accept(envelope: unknown, callerPrincipalId: string): Promise<ExecutionAcceptanceResponse>
}

const RelayIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)

export const RelaySubmitInputRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: RelayIdentifierSchema,
    commandId: RelayIdentifierSchema,
    executionId: RelayIdentifierSchema,
    interactionId: RelayIdentifierSchema,
    callerPrincipalId: RelayIdentifierSchema,
    text: z
      .string()
      .min(1)
      .max(256 * 1024),
  })
  .strict()

export const RelayExecutionControlResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: RelayIdentifierSchema,
    targetId: RelayIdentifierSchema,
    state: z.enum([
      'accepted',
      'running',
      'waiting',
      'completed',
      'cancelled',
      'failed',
      'unknown',
    ]),
    replayed: z.boolean(),
  })
  .strict()

export type RelaySubmitInputRequest = z.output<typeof RelaySubmitInputRequestSchema>
export type RelayExecutionControlResult = z.output<typeof RelayExecutionControlResultSchema>

export interface RelayExecutionControlPort {
  submitInput(
    request: RelaySubmitInputRequest,
    callerPrincipalId: string
  ): Promise<RelayExecutionControlResult>
  applyMetadata(
    command: RelayMetadataCommand,
    callerPrincipalId: string
  ): Promise<RelayExecutionControlResult>
}

export type RelayExecutionCommandResult = ExecutionAcceptanceResponse | RelayExecutionControlResult

export type RelayExecutionCommandErrorCode =
  | 'RELAY_COMMAND_INVALID'
  | 'RELAY_COMMAND_SCOPE_MISMATCH'

export class RelayExecutionCommandError extends Error {
  constructor(readonly code: RelayExecutionCommandErrorCode) {
    super('Remote execution command was rejected')
    this.name = 'RelayExecutionCommandError'
  }
}

export interface RelayExecutionCommandProcessorOptions {
  readonly hostId: string
  readonly workspaceId: string
  readonly callerPrincipalId: string
  readonly keyResolver: (keyId: string, now: Date) => HostEncryptionKeyPair
  readonly acceptance: ExecutionAcceptancePort
  readonly control?: RelayExecutionControlPort
  readonly results?: RelayCommandResultRepository<RelayExecutionCommandResult>
}

/**
 * Bridges decrypted relay commands into the same durable acceptance service used by the Control API.
 * CommandInbox remains the idempotency boundary; this processor never creates a second execution ledger.
 */
export class RelayExecutionCommandProcessor implements RelayHostCommandProcessor<RelayExecutionCommandResult> {
  readonly hostId: string
  readonly workspaceId: string
  readonly #callerPrincipalId: string
  readonly #keyResolver: (keyId: string, now: Date) => HostEncryptionKeyPair
  readonly #acceptance: ExecutionAcceptancePort
  readonly #control: RelayExecutionControlPort | undefined
  readonly #results: RelayCommandResultRepository<RelayExecutionCommandResult>
  readonly #inFlight = new Map<
    string,
    {
      readonly envelope: string
      readonly operation: Promise<RelayCommandResult<RelayExecutionCommandResult>>
    }
  >()

  constructor(options: RelayExecutionCommandProcessorOptions) {
    this.hostId = options.hostId
    this.workspaceId = options.workspaceId
    this.#callerPrincipalId = options.callerPrincipalId
    this.#keyResolver = options.keyResolver
    this.#acceptance = options.acceptance
    this.#control = options.control
    this.#results = options.results ?? new InMemoryRelayCommandResultRepository()
  }

  async process(
    envelopeInput: EncryptedRelayEnvelope,
    now: Date = new Date()
  ): Promise<RelayCommandResult<RelayExecutionCommandResult>> {
    let envelope: EncryptedRelayEnvelope
    try {
      envelope = EncryptedRelayEnvelopeSchema.parse(envelopeInput)
    } catch {
      throw new RelayEnvelopeError('RELAY_ENVELOPE_INVALID')
    }
    const canonical = JSON.stringify(envelope)
    const inFlight = this.#inFlight.get(envelope.commandId)
    if (inFlight !== undefined) {
      if (inFlight.envelope !== canonical) {
        throw new RelayExecutionCommandError('RELAY_COMMAND_SCOPE_MISMATCH')
      }
      return { ...(await inFlight.operation), outcome: 'duplicate' }
    }
    const operation = this.#processOnce(envelope, now)
    this.#inFlight.set(envelope.commandId, { envelope: canonical, operation })
    try {
      return await operation
    } finally {
      this.#inFlight.delete(envelope.commandId)
    }
  }

  async #processOnce(
    envelope: EncryptedRelayEnvelope,
    now: Date
  ): Promise<RelayCommandResult<RelayExecutionCommandResult>> {
    const plaintext = await decryptRelayPayload({
      envelope,
      recipient: this.#keyResolver(envelope.keyId, now),
      expectedHostId: this.hostId,
      expectedWorkspaceId: this.workspaceId,
      now,
    })
    try {
      const payloadDigest = await sha256(plaintext)
      const replay = await this.#results.get(envelope.commandId)
      if (replay !== undefined) {
        if (replay.payloadDigest !== payloadDigest) {
          throw new RelayExecutionCommandError('RELAY_COMMAND_SCOPE_MISMATCH')
        }
        return { ...replay, outcome: 'duplicate' }
      }
      const result = await this.#dispatch(envelope, plaintext)
      const accepted: RelayCommandResult<RelayExecutionCommandResult> = {
        outcome:
          ('data' in result ? result.data.replayed : result.replayed) === true
            ? 'duplicate'
            : 'accepted',
        commandId: envelope.commandId,
        payloadDigest,
        result,
      }
      await this.#results.put(accepted)
      return accepted
    } finally {
      plaintext.fill(0)
    }
  }

  async #dispatch(
    envelope: EncryptedRelayEnvelope,
    plaintext: Uint8Array
  ): Promise<RelayExecutionCommandResult> {
    if (envelope.payloadType === 'create_execution') {
      const request = parseExecutionRequest(plaintext)
      if (
        request.workspaceId !== this.workspaceId ||
        request.commandId !== envelope.commandId ||
        request.caller.servicePrincipalId !== this.#callerPrincipalId
      ) {
        throw new RelayExecutionCommandError('RELAY_COMMAND_SCOPE_MISMATCH')
      }
      const result = ExecutionAcceptanceResponseSchema.parse(
        await this.#acceptance.accept(request, this.#callerPrincipalId)
      )
      if (result.data.commandId !== envelope.commandId) {
        throw new RelayExecutionCommandError('RELAY_COMMAND_SCOPE_MISMATCH')
      }
      return result
    }
    if (envelope.payloadType === 'submit_input' && this.#control !== undefined) {
      const request = parseSubmitInputRequest(plaintext)
      if (
        request.workspaceId !== this.workspaceId ||
        request.commandId !== envelope.commandId ||
        request.callerPrincipalId !== this.#callerPrincipalId
      ) {
        throw new RelayExecutionCommandError('RELAY_COMMAND_SCOPE_MISMATCH')
      }
      return RelayExecutionControlResultSchema.parse(
        await this.#control.submitInput(request, this.#callerPrincipalId)
      )
    }
    throw new RelayExecutionCommandError('RELAY_COMMAND_INVALID')
  }
}

export function createRelayExecutionMetadataCommandProcessor(options: {
  readonly hostId: string
  readonly workspaceId: string
  readonly callerPrincipalId: string
  readonly control: RelayExecutionControlPort
  readonly repository?: RelayMetadataCommandResultRepository<RelayExecutionControlResult>
}): RelayMetadataCommandProcessor<RelayExecutionControlResult> {
  return new RelayMetadataCommandProcessor(
    options.hostId,
    options.workspaceId,
    async (command) =>
      RelayExecutionControlResultSchema.parse(
        await options.control.applyMetadata(command, options.callerPrincipalId)
      ),
    options.repository
  )
}

function parseExecutionRequest(plaintext: Uint8Array) {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
    return ExecutionAcceptanceRequestSchema.parse(JSON.parse(decoded))
  } catch (error) {
    if (error instanceof RelayExecutionCommandError) throw error
    throw new RelayExecutionCommandError('RELAY_COMMAND_INVALID')
  }
}

function parseSubmitInputRequest(plaintext: Uint8Array): RelaySubmitInputRequest {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
    return RelaySubmitInputRequestSchema.parse(JSON.parse(decoded))
  } catch (error) {
    if (error instanceof RelayExecutionCommandError) throw error
    throw new RelayExecutionCommandError('RELAY_COMMAND_INVALID')
  }
}
