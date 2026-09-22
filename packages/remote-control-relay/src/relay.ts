// DECISION (#612): insertion order is CONTRACTUAL here — the serialized bytes
// are persisted and compared verbatim across versions, so this site must not
// adopt canonicalJsonStringify; altering the format requires a versioned
// envelope migration with an explicit cutover.
import {
  decryptRelayPayload,
  RelayEnvelopeError,
  sha256,
  type HostEncryptionKeyPair,
  type HostEncryptionPublicKey,
} from './crypto.js'
import {
  EncryptedRelayEnvelopeSchema,
  MAX_RELAY_CLOCK_SKEW_MS,
  MAX_RELAY_ENVELOPE_LIFETIME_MS,
  RelayMetadataCommandSchema,
  RelayStatusProjectionSchema,
  type EncryptedRelayEnvelope,
  type RelayMetadataCommand,
  type RelayStatusProjection,
} from './protocol.js'

export interface OpaqueRelayRecord {
  readonly deliveryId: string
  readonly hostId: string
  readonly workspaceId: string
  readonly commandId: string
  readonly receivedAt: string
  readonly envelope: EncryptedRelayEnvelope
  readonly attempts: number
  readonly acknowledged: boolean
}

export interface RelayMetadataRecord {
  readonly deliveryId: string
  readonly hostId: string
  readonly workspaceId: string
  readonly commandId: string
  readonly receivedAt: string
  readonly command: RelayMetadataCommand
  readonly attempts: number
  readonly acknowledged: boolean
}

export class FakeOpaqueRelay {
  readonly #records = new Map<string, OpaqueRelayRecord>()
  readonly #metadata = new Map<string, RelayMetadataRecord>()
  readonly #results = new Map<string, EncryptedRelayEnvelope>()
  readonly #registrations = new Map<string, HostEncryptionPublicKey>()
  readonly #projections: RelayStatusProjection[] = []
  #sequence = 0

  publish(envelopeInput: EncryptedRelayEnvelope, receivedAt: Date = new Date()): OpaqueRelayRecord {
    const envelope = EncryptedRelayEnvelopeSchema.parse(envelopeInput)
    const duplicate = [...this.#records.values()].find(
      (record) =>
        record.hostId === envelope.hostId &&
        record.workspaceId === envelope.workspaceId &&
        record.commandId === envelope.commandId
    )
    if (duplicate !== undefined) {
      if (JSON.stringify(duplicate.envelope) !== JSON.stringify(envelope)) {
        throw new Error('RELAY_COMMAND_CONFLICT')
      }
      return duplicate
    }
    this.#sequence += 1
    const record = {
      deliveryId: `delivery-${this.#sequence}`,
      hostId: envelope.hostId,
      workspaceId: envelope.workspaceId,
      commandId: envelope.commandId,
      receivedAt: receivedAt.toISOString(),
      envelope,
      attempts: 0,
      acknowledged: false,
    }
    this.#records.set(record.deliveryId, record)
    return record
  }

  pull(hostId: string, limit = 100): readonly OpaqueRelayRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.hostId === hostId && !record.acknowledged)
      .slice(0, limit)
      .map((record) => {
        const delivered = { ...record, attempts: record.attempts + 1 }
        this.#records.set(record.deliveryId, delivered)
        return delivered
      })
  }

  acknowledge(deliveryId: string): void {
    const record = this.#records.get(deliveryId)
    if (record !== undefined) this.#records.set(deliveryId, { ...record, acknowledged: true })
  }

  publishMetadata(
    commandInput: RelayMetadataCommand,
    receivedAt: Date = new Date()
  ): RelayMetadataRecord {
    const command = RelayMetadataCommandSchema.parse(commandInput)
    const identity = `${command.hostId}:${command.workspaceId}:${command.commandId}`
    const duplicate = this.#metadata.get(identity)
    if (duplicate !== undefined) {
      if (JSON.stringify(duplicate.command) !== JSON.stringify(command)) {
        throw new Error('RELAY_COMMAND_CONFLICT')
      }
      return duplicate
    }
    this.#sequence += 1
    const record = {
      deliveryId: `metadata-delivery-${this.#sequence}`,
      hostId: command.hostId,
      workspaceId: command.workspaceId,
      commandId: command.commandId,
      receivedAt: receivedAt.toISOString(),
      command,
      attempts: 0,
      acknowledged: false,
    }
    this.#metadata.set(identity, record)
    return record
  }

  pullMetadata(hostId: string, limit = 100): readonly RelayMetadataRecord[] {
    return [...this.#metadata.entries()]
      .filter(([, record]) => record.hostId === hostId && !record.acknowledged)
      .slice(0, limit)
      .map(([identity, record]) => {
        const delivered = { ...record, attempts: record.attempts + 1 }
        this.#metadata.set(identity, delivered)
        return delivered
      })
  }

  acknowledgeMetadata(deliveryId: string): void {
    for (const [identity, record] of this.#metadata) {
      if (record.deliveryId === deliveryId) {
        this.#metadata.set(identity, { ...record, acknowledged: true })
        return
      }
    }
  }

  publishResult(envelopeInput: EncryptedRelayEnvelope): void {
    const envelope = EncryptedRelayEnvelopeSchema.parse(envelopeInput)
    if (
      envelope.payloadType !== 'execution_result' &&
      envelope.payloadType !== 'interaction_result'
    ) {
      throw new Error('RELAY_RESULT_TYPE_INVALID')
    }
    const identity = `${envelope.hostId}:${envelope.workspaceId}:${envelope.commandId}:${envelope.payloadType}`
    const existing = this.#results.get(identity)
    if (existing !== undefined) {
      if (existing.contentDigest !== envelope.contentDigest) {
        throw new Error('RELAY_COMMAND_CONFLICT')
      }
      return
    }
    this.#results.set(identity, envelope)
  }

  results(): readonly EncryptedRelayEnvelope[] {
    return [...this.#results.values()].map((envelope) => ({ ...envelope }))
  }

  snapshot(): string {
    return JSON.stringify({
      registrations: [...this.#registrations.values()],
      records: [...this.#records.values()],
      metadata: [...this.#metadata.values()],
      results: [...this.#results.values()],
      projections: this.#projections,
    })
  }

  register(key: HostEncryptionPublicKey): void {
    const existing = this.#registrations.get(key.hostId)
    if (existing !== undefined && existing.keyId === key.keyId) return
    this.#registrations.set(key.hostId, { ...key })
  }

  revoke(hostId: string, keyId: string): void {
    const registered = this.#registrations.get(hostId)
    if (registered?.keyId === keyId) this.#registrations.delete(hostId)
  }

  registration(hostId: string): HostEncryptionPublicKey | undefined {
    return this.#registrations.get(hostId)
  }

  publishProjection(input: RelayStatusProjection): void {
    this.#projections.push(RelayStatusProjectionSchema.parse(input))
  }

  projections(): readonly RelayStatusProjection[] {
    return this.#projections.map((projection) => ({ ...projection }))
  }

  health(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

export interface RelayCommandResult<Result> {
  readonly outcome: 'accepted' | 'duplicate'
  readonly commandId: string
  readonly payloadDigest: `sha256:${string}`
  readonly result: Result
}

export interface RelayCommandResultRepository<Result> {
  get(commandId: string): Promise<RelayCommandResult<Result> | undefined>
  put(result: RelayCommandResult<Result>): Promise<void>
}

export interface RelayHostCommandProcessor<Result> {
  readonly hostId: string
  readonly workspaceId: string
  process(envelope: EncryptedRelayEnvelope, now?: Date): Promise<RelayCommandResult<Result>>
}

export class InMemoryRelayCommandResultRepository<
  Result,
> implements RelayCommandResultRepository<Result> {
  readonly #results = new Map<string, RelayCommandResult<Result>>()

  get(commandId: string): Promise<RelayCommandResult<Result> | undefined> {
    return Promise.resolve(this.#results.get(commandId))
  }

  put(result: RelayCommandResult<Result>): Promise<void> {
    if (this.#results.has(result.commandId)) throw new Error('RELAY_COMMAND_ALREADY_RECORDED')
    this.#results.set(result.commandId, result)
    return Promise.resolve()
  }
}

export class RelayCommandProcessor<Result> implements RelayHostCommandProcessor<Result> {
  readonly #inFlight = new Map<
    string,
    { readonly envelope: string; readonly operation: Promise<RelayCommandResult<Result>> }
  >()

  constructor(
    readonly hostId: string,
    readonly workspaceId: string,
    readonly keyResolver: (keyId: string, now: Date) => HostEncryptionKeyPair,
    readonly repository: RelayCommandResultRepository<Result>,
    readonly accept: (envelope: EncryptedRelayEnvelope, plaintext: Uint8Array) => Promise<Result>
  ) {}

  async process(
    envelopeInput: EncryptedRelayEnvelope,
    now: Date = new Date()
  ): Promise<RelayCommandResult<Result>> {
    const parsed = EncryptedRelayEnvelopeSchema.safeParse(envelopeInput)
    if (!parsed.success) throw new RelayEnvelopeError('RELAY_ENVELOPE_INVALID')
    const envelope = parsed.data
    const inFlight = this.#inFlight.get(envelope.commandId)
    if (inFlight !== undefined) {
      if (inFlight.envelope !== JSON.stringify(envelope)) throw new Error('RELAY_COMMAND_CONFLICT')
      const result = await inFlight.operation
      return { ...result, outcome: 'duplicate' }
    }
    const operation = this.#processOnce(envelope, now)
    this.#inFlight.set(envelope.commandId, { envelope: JSON.stringify(envelope), operation })
    try {
      return await operation
    } finally {
      this.#inFlight.delete(envelope.commandId)
    }
  }

  async #processOnce(
    envelope: EncryptedRelayEnvelope,
    now: Date
  ): Promise<RelayCommandResult<Result>> {
    const key = this.keyResolver(envelope.keyId, now)
    const plaintext = await decryptRelayPayload({
      envelope,
      recipient: key,
      expectedHostId: this.hostId,
      expectedWorkspaceId: this.workspaceId,
      now,
    })
    try {
      const payloadDigest = await sha256(plaintext)
      const replay = await this.repository.get(envelope.commandId)
      if (replay !== undefined) {
        if (replay.payloadDigest !== payloadDigest) throw new Error('RELAY_COMMAND_CONFLICT')
        return { ...replay, outcome: 'duplicate' }
      }
      const result = await this.accept(envelope, plaintext)
      const accepted = {
        outcome: 'accepted' as const,
        commandId: envelope.commandId,
        payloadDigest,
        result,
      }
      await this.repository.put(accepted)
      return accepted
    } finally {
      plaintext.fill(0)
    }
  }
}

export interface RelayMetadataCommandResult<Result> {
  readonly outcome: 'accepted' | 'duplicate'
  readonly commandId: string
  readonly result: Result
}

export type RelayMetadataCommandErrorCode =
  | 'RELAY_COMMAND_INVALID'
  | 'RELAY_COMMAND_SCOPE_MISMATCH'
  | 'RELAY_COMMAND_EXPIRED'
  | 'RELAY_COMMAND_CONFLICT'

export class RelayMetadataCommandError extends Error {
  constructor(readonly code: RelayMetadataCommandErrorCode) {
    super('Remote-control metadata command was rejected')
    this.name = 'RelayMetadataCommandError'
  }
}

export interface RelayMetadataCommandResultRepository<Result> {
  get(commandId: string): Promise<
    | {
        readonly command: string
        readonly result: RelayMetadataCommandResult<Result>
      }
    | undefined
  >
  put(commandId: string, command: string, result: RelayMetadataCommandResult<Result>): Promise<void>
}

export class InMemoryRelayMetadataCommandResultRepository<
  Result,
> implements RelayMetadataCommandResultRepository<Result> {
  readonly #results = new Map<
    string,
    { readonly command: string; readonly result: RelayMetadataCommandResult<Result> }
  >()

  get(commandId: string) {
    return Promise.resolve(this.#results.get(commandId))
  }

  put(
    commandId: string,
    command: string,
    result: RelayMetadataCommandResult<Result>
  ): Promise<void> {
    if (this.#results.has(commandId)) {
      throw new RelayMetadataCommandError('RELAY_COMMAND_CONFLICT')
    }
    this.#results.set(commandId, { command, result })
    return Promise.resolve()
  }
}

export class RelayMetadataCommandProcessor<Result> {
  readonly #inFlight = new Map<
    string,
    { readonly command: string; readonly operation: Promise<RelayMetadataCommandResult<Result>> }
  >()

  constructor(
    readonly hostId: string,
    readonly workspaceId: string,
    readonly accept: (command: RelayMetadataCommand) => Promise<Result>,
    readonly repository: RelayMetadataCommandResultRepository<Result> = new InMemoryRelayMetadataCommandResultRepository<Result>()
  ) {}

  async process(
    commandInput: RelayMetadataCommand,
    now: Date = new Date()
  ): Promise<RelayMetadataCommandResult<Result>> {
    const parsed = RelayMetadataCommandSchema.safeParse(commandInput)
    if (!parsed.success) throw new RelayMetadataCommandError('RELAY_COMMAND_INVALID')
    const command = parsed.data
    if (command.hostId !== this.hostId || command.workspaceId !== this.workspaceId) {
      throw new RelayMetadataCommandError('RELAY_COMMAND_SCOPE_MISMATCH')
    }
    const issued = Date.parse(command.issuedAt)
    const expires = Date.parse(command.expiresAt)
    if (
      expires <= issued ||
      expires - issued > MAX_RELAY_ENVELOPE_LIFETIME_MS ||
      issued > now.getTime() + MAX_RELAY_CLOCK_SKEW_MS ||
      expires <= now.getTime()
    ) {
      throw new RelayMetadataCommandError('RELAY_COMMAND_EXPIRED')
    }
    // CANONICAL-JSON: site-specific semantics, see contracts canonicalJsonStringify
    // insertion-order stringify of a schema-pinned command; replay comparisons persist these strings byte-for-byte
    const canonical = JSON.stringify(command)
    const replay = await this.repository.get(command.commandId)
    if (replay !== undefined) {
      if (replay.command !== canonical) {
        throw new RelayMetadataCommandError('RELAY_COMMAND_CONFLICT')
      }
      return { ...replay.result, outcome: 'duplicate' }
    }
    const inFlight = this.#inFlight.get(command.commandId)
    if (inFlight !== undefined) {
      if (inFlight.command !== canonical) {
        throw new RelayMetadataCommandError('RELAY_COMMAND_CONFLICT')
      }
      return { ...(await inFlight.operation), outcome: 'duplicate' }
    }
    const operation = this.#accept(command)
    this.#inFlight.set(command.commandId, { command: canonical, operation })
    try {
      return await operation
    } finally {
      this.#inFlight.delete(command.commandId)
    }
  }

  async #accept(command: RelayMetadataCommand): Promise<RelayMetadataCommandResult<Result>> {
    const accepted = {
      outcome: 'accepted' as const,
      commandId: command.commandId,
      result: await this.accept(command),
    }
    await this.repository.put(command.commandId, JSON.stringify(command), accepted)
    return accepted
  }
}

export function assertRelayCannotDecrypt(snapshot: string, plaintextCanary: string): void {
  if (snapshot.includes(plaintextCanary)) {
    throw new RelayEnvelopeError('RELAY_ENVELOPE_INVALID')
  }
}
