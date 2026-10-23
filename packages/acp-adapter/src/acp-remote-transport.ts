import { createHash, randomBytes, type KeyObject } from 'node:crypto'
import {
  GatewayAcknowledgementEnvelopeSchema,
  GatewayCommandEnvelopeSchema,
  GatewayErrorEnvelopeSchema,
  GatewayInventoryEnvelopeSchema,
  GatewayProgressEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  type GatewayCommandEnvelope,
  type GatewayInventoryEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import type {
  AcpGatewayConnectionState,
  AcpGatewayExchange,
  AcpGatewayTransport,
  AcpLocalProjectGrantState,
} from './acp-gateway-types.js'
import {
  ACP_REMOTE_SUITE,
  canonicalJson,
  decodeBase64Url,
  generateRecipientKeyPair,
  hpkeOpen,
  hpkeSeal,
  sha256Digest,
  signCanonical,
  signingPublicKeyOf,
  utf8,
  utf8Decode,
  verifyCanonical,
  type RecipientKeyPair,
} from './acp-remote-crypto.ts'
import {
  ACP_REMOTE_CLOCK_SKEW_MS,
  ACP_REMOTE_MAX_COMMAND_LIFETIME_MS,
  ACP_REMOTE_MAX_INVENTORY_AGE_MS,
  ACP_REMOTE_MAX_PLAINTEXT_BYTES,
  AcpRemoteDenialReasonSchema,
  AcpRemoteDeviceRouteSchema,
  denyRemote,
  evaluateCommandWindow,
  evaluateRouteFence,
  remoteDenialError,
  type AcpRemoteDenialReason,
  type AcpRemoteDeviceRoute,
  type AcpRemoteFenceDecision,
} from './acp-remote-fence.ts'
import {
  InMemoryAcpRemoteDeviceStateStore,
  type AcpRemoteDeviceClaimResult,
  type AcpRemoteDeviceFenceRecord,
  type AcpRemoteDeviceLedgerRecord,
  type AcpRemoteDeviceOutcome,
  type AcpRemoteDeviceStateStore,
} from './acp-remote-device-state.ts'

/**
 * Authenticated, encrypted controller-to-device ACP transport.
 *
 * Commands are HPKE-sealed to the device recipient key with the header bound as associated data and
 * signed by the controller key. Responses are HPKE-sealed to a per-command ephemeral return key and
 * signed by the device identity key. The wire is untrusted: it can deny service, but it cannot read
 * prompts or results, forge a command or response, or cause an effect the device did not authorize.
 */

const AEAD_TAG_BYTES = 16
const DEFAULT_REPLAY_LEDGER_CAPACITY = 1024

/**
 * The most sealed commands kept for reuse. The cache holds one entry per live command, so this
 * bounds the memory a burst of live commands can cost while leaving the reuse window intact.
 */
const SEALED_COMMAND_CACHE_CAPACITY = 1024

const DOMAIN = Object.freeze({
  commandInfo: 'control-plane.acp-remote.command-info.v1',
  commandAad: 'control-plane.acp-remote.command-aad.v1',
  commandSignature: 'control-plane.acp-remote.command-signature.v1',
  responseInfo: 'control-plane.acp-remote.response-info.v1',
  responseAad: 'control-plane.acp-remote.response-aad.v1',
  responseSignature: 'control-plane.acp-remote.response-signature.v1',
  inventory: 'control-plane.acp-remote.inventory.v1',
  revocation: 'control-plane.acp-remote.revocation.v1',
})

const scopedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`))
const KeyIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/)
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)
const X25519PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const PayloadHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const IsoSchema = z.iso.datetime()

const CommandHeaderSchema = z.strictObject({
  suite: z.literal(ACP_REMOTE_SUITE),
  workspaceId: scopedId('wsp'),
  nodeId: scopedId('rnr'),
  runtimeConnectionId: scopedId('rtc'),
  commandId: scopedId('cmd'),
  payloadHash: PayloadHashSchema,
  issuedAt: IsoSchema,
  expiresAt: IsoSchema,
  channelGeneration: z.number().int().positive(),
  controllerKeyId: KeyIdSchema,
  recipientKeyId: KeyIdSchema,
  returnKeyId: KeyIdSchema,
  returnPublicKey: X25519PublicKeySchema,
})

const SealedCommandSchema = z.strictObject({
  header: CommandHeaderSchema,
  encapsulatedKey: Base64UrlSchema,
  ciphertext: Base64UrlSchema,
  signature: Base64UrlSchema,
})

const InventoryRequestIdSchema = z.string().regex(/^inv_[0-9a-f]{32}$/)

const ResponseHeaderSchema = z.strictObject({
  suite: z.literal(ACP_REMOTE_SUITE),
  workspaceId: scopedId('wsp'),
  nodeId: scopedId('rnr'),
  runtimeConnectionId: scopedId('rtc'),
  signerKeyId: KeyIdSchema,
  commandId: scopedId('cmd').optional(),
  payloadHash: PayloadHashSchema.optional(),
  returnKeyId: KeyIdSchema.optional(),
  requestId: InventoryRequestIdSchema.optional(),
})

const DenialReplySchema = z.strictObject({
  kind: z.literal('denial'),
  header: ResponseHeaderSchema,
  reason: AcpRemoteDenialReasonSchema,
  signature: Base64UrlSchema,
})

const ExchangeReplySchema = z.strictObject({
  kind: z.literal('exchange'),
  header: ResponseHeaderSchema,
  encapsulatedKey: Base64UrlSchema,
  ciphertext: Base64UrlSchema,
  signature: Base64UrlSchema,
})

const InventoryReplySchema = z.strictObject({
  kind: z.literal('inventory'),
  header: ResponseHeaderSchema,
  envelope: z.unknown(),
  signature: Base64UrlSchema,
})

const CommandReplySchema = z.discriminatedUnion('kind', [DenialReplySchema, ExchangeReplySchema])
const InventoryOrDenialSchema = z.discriminatedUnion('kind', [
  InventoryReplySchema,
  DenialReplySchema,
])

const ExchangeSchema = z.strictObject({
  ack: GatewayAcknowledgementEnvelopeSchema,
  progress: z.array(GatewayProgressEnvelopeSchema),
  result: GatewayResultEnvelopeSchema.optional(),
  error: GatewayErrorEnvelopeSchema.optional(),
})

const RevocationNoticeSchema = z.strictObject({
  kind: z.literal('device_revocation'),
  workspaceId: scopedId('wsp'),
  nodeId: scopedId('rnr'),
  runtimeConnectionId: scopedId('rtc'),
  controllerKeyId: KeyIdSchema,
  revokedAt: IsoSchema,
  signature: Base64UrlSchema,
})

export type AcpRemoteCommandHeader = z.output<typeof CommandHeaderSchema>
export type AcpRemoteSealedCommand = z.output<typeof SealedCommandSchema>
export type AcpRemoteResponseHeader = z.output<typeof ResponseHeaderSchema>
export type AcpRemoteSealedResponse = z.output<typeof CommandReplySchema>
export type AcpRemoteInventoryReply = z.output<typeof InventoryOrDenialSchema>
export type AcpRemoteRevocationNotice = z.output<typeof RevocationNoticeSchema>
type AcpRemoteDenialReply = z.output<typeof DenialReplySchema>

/** Thrown by a wire only when a command was definitely not delivered; any other wire failure is an unknown outcome. */
export class AcpRemoteUndeliveredError extends Error {
  constructor(readonly reason: 'device_offline' | 'state_unavailable' = 'device_offline') {
    super('ACP_REMOTE_UNDELIVERED')
    this.name = 'AcpRemoteUndeliveredError'
  }
}

/** Untrusted transport between controller and device (gateway, relay, or test double). */
export interface AcpRemoteWire {
  connectionState(): 'online' | 'offline'
  sendCommand(command: AcpRemoteSealedCommand): Promise<unknown>
  requestInventory(requestId: string): Promise<unknown>
  /**
   * `channel-authenticated` wires surface the EXISTING pushed inventory after the channel has
   * authenticated the node/connection and validated its generation: the controller then enforces
   * route binding and freshness only, and a bounded-wait timeout or reconnect denies `device_stale`
   * instead of waiting on a per-request device signature (no parallel polling protocol).
   */
  readonly inventoryMode?: 'device-signed' | 'channel-authenticated'
  /**
   * Required for `channel-authenticated` wires: the channel's CURRENT authenticated
   * node/connection channel generation. The controller asserts the generation returned with the
   * pushed inventory equals this value — a mismatch, an absent value, or a non-integer denies
   * `device_stale` (generation binding, never dropped).
   */
  readonly currentChannelGeneration?: () => number
}

/** Server-owned authority for the controller's currently enrolled signing key. */
export interface AcpRemoteControllerAuthorityPort {
  /** Synchronous cache corroborated after each durable assertion and used for connection state. */
  isCurrent(input: AcpRemoteControllerAuthorityBinding): boolean
  /** Durable/current view rechecked at each asynchronous wire boundary. */
  assertCurrent(input: AcpRemoteControllerAuthorityBinding): void | Promise<void>
}

export interface AcpRemoteControllerAuthorityBinding {
  readonly workspaceId: string
  readonly nodeId: string
  readonly runtimeConnectionId: string
  readonly controllerKeyId: string
  readonly controllerSigningPublicKey: string
}

export interface SecureAcpRemoteTransportOptions {
  readonly route: AcpRemoteDeviceRoute
  readonly wire: AcpRemoteWire
  readonly controller: { readonly keyId: string; readonly signingKey: KeyObject }
  /** Controller-recorded project grant view. The device re-checks its own grant before every effect. */
  readonly grantState: (grantRef: string) => AcpLocalProjectGrantState
  /** Omit only for isolated transport tests; production construction requires the enrollment port. */
  readonly controllerAuthority?: AcpRemoteControllerAuthorityPort
  readonly now?: () => Date
}

/** Controller side of one device route. It implements the AcpGatewayTransport contract and has no alternate route. */
export class SecureAcpRemoteTransport implements AcpGatewayTransport {
  readonly #route: AcpRemoteDeviceRoute
  readonly #wire: AcpRemoteWire
  readonly #signingKey: KeyObject
  readonly #grantState: (grantRef: string) => AcpLocalProjectGrantState
  readonly #controllerAuthority: AcpRemoteControllerAuthorityPort | undefined
  readonly #now: () => Date
  #controllerAuthorityVerified = false
  #revokedAt: string | undefined
  /**
   * The sealed command per inner command identity, reused by every retry of that command.
   */
  readonly #sealedCommands = new Map<
    string,
    {
      readonly returnKey: RecipientKeyPair
      readonly header: AcpRemoteCommandHeader
      readonly message: AcpRemoteSealedCommand
    }
  >()
  /**
   * The seal in flight per command identity, so concurrent duplicates of one command share ONE
   * seal instead of racing to seal it twice.
   */
  readonly #sealingCommands = new Map<
    string,
    Promise<{
      readonly returnKey: RecipientKeyPair
      readonly header: AcpRemoteCommandHeader
      readonly message: AcpRemoteSealedCommand
    }>
  >()

  constructor(options: SecureAcpRemoteTransportOptions) {
    this.#route = AcpRemoteDeviceRouteSchema.parse(options.route)
    if (
      options.controller.keyId !== this.#route.controllerKeyId ||
      signingPublicKeyOf(options.controller.signingKey) !== this.#route.controllerSigningPublicKey
    ) {
      throw new Error('ACP_REMOTE_IDENTITY_MISMATCH')
    }
    this.#wire = options.wire
    this.#signingKey = options.controller.signingKey
    this.#grantState = options.grantState
    this.#controllerAuthority = options.controllerAuthority
    this.#now = options.now ?? (() => new Date())
  }

  /** Route fence as of now. Any value other than `allowed` is a denial with no fallback. */
  fenceDecision(): AcpRemoteFenceDecision {
    return evaluateRouteFence({
      route: this.#route,
      now: this.#now(),
      transport: this.#wire.connectionState(),
      revokedAt: this.#revokedAt,
    })
  }

  connectionState(): AcpGatewayConnectionState {
    const decision = this.fenceDecision()
    if (decision.outcome === 'denied') {
      this.#invalidateControllerAuthority()
      return decision.reason === 'device_revoked' ? 'revoked' : 'offline'
    }
    if (this.#controllerAuthority !== undefined) {
      if (!this.#controllerAuthorityVerified) return 'offline'
      if (!this.#controllerIsCurrent()) {
        this.#controllerAuthorityVerified = false
        return 'revoked'
      }
    }
    return 'online'
  }

  grantState(grantRef: string): AcpLocalProjectGrantState {
    return this.#grantState(grantRef)
  }

  /** Synchronous test seam; enrolled transports require `revokeCurrent`. */
  revoke(revokedAt: string): AcpRemoteRevocationNotice {
    if (this.#controllerAuthority !== undefined)
      throw new Error('ACP_REMOTE_CONTROLLER_AUTHORITY_RECHECK_REQUIRED')
    return this.#createRevocationNotice(revokedAt)
  }

  /**
   * Rechecks the enrolled signer, then revokes this route locally and returns a
   * controller-signed notice for the device to apply.
   */
  async revokeCurrent(revokedAt: string): Promise<AcpRemoteRevocationNotice> {
    if (this.#controllerAuthority === undefined)
      throw new Error('ACP_REMOTE_CONTROLLER_AUTHORITY_REQUIRED')
    await this.#assertControllerCurrent()
    return this.#createRevocationNotice(revokedAt)
  }

  #createRevocationNotice(revokedAt: string): AcpRemoteRevocationNotice {
    this.#revokedAt ??= IsoSchema.parse(revokedAt)
    const body = {
      kind: 'device_revocation' as const,
      workspaceId: this.#route.workspaceId,
      nodeId: this.#route.nodeId,
      runtimeConnectionId: this.#route.runtimeConnectionId,
      controllerKeyId: this.#route.controllerKeyId,
      revokedAt: this.#revokedAt,
    }
    return { ...body, signature: signCanonical(DOMAIN.revocation, body, this.#signingKey) }
  }

  async inventory(signal?: AbortSignal): Promise<GatewayInventoryEnvelope> {
    this.#assertFenced()
    await this.#assertControllerCurrent()
    if (signalAborted(signal)) throw timeoutError()
    if (this.#wire.inventoryMode === 'channel-authenticated') {
      // Bounded wait over the existing pushed inventory: the authenticated channel validated the
      // node/connection and its generation; timeout or reconnect on the wire denies stale.
      let pushed: unknown
      try {
        pushed = await this.#wire.requestInventory(`inv_${randomBytes(16).toString('hex')}`)
      } catch {
        this.#invalidateControllerAuthority()
        throw remoteDenialError(denyRemote('device_stale'))
      }
      // Current-authority recheck after the wire await.
      await this.#assertControllerCurrent()
      this.#assertFenced()
      const bound =
        typeof pushed === 'object' && pushed !== null && 'inventory' in pushed
          ? (pushed as { inventory: unknown; channelGeneration?: unknown })
          : undefined
      if (bound === undefined) throw remoteDenialError(denyRemote('device_stale'))
      const generation = bound.channelGeneration
      const current = this.#wire.currentChannelGeneration?.()
      // Generation binding: the returned generation must be a safe integer matching the
      // channel's current authenticated generation; anything else denies stale.
      if (
        !Number.isSafeInteger(generation) ||
        (generation as number) < 0 ||
        !Number.isSafeInteger(current) ||
        generation !== current
      ) {
        throw remoteDenialError(denyRemote('device_stale'))
      }
      const direct = GatewayInventoryEnvelopeSchema.safeParse(bound.inventory)
      if (
        !direct.success ||
        direct.data.nodeId !== this.#route.nodeId ||
        direct.data.workspaceId !== this.#route.workspaceId
      ) {
        throw untrusted()
      }
      const channelAgeMs = this.#now().getTime() - Date.parse(direct.data.observedAt)
      if (!Number.isFinite(channelAgeMs)) throw remoteDenialError(denyRemote('clock_invalid'))
      if (
        channelAgeMs > ACP_REMOTE_MAX_INVENTORY_AGE_MS ||
        channelAgeMs < -ACP_REMOTE_CLOCK_SKEW_MS
      ) {
        throw remoteDenialError(denyRemote('device_stale'))
      }
      return direct.data
    }
    // A fresh request identifier binds each inventory reply to this request, so an earlier signed reply cannot answer it.
    const requestId = `inv_${randomBytes(16).toString('hex')}`
    let reply: unknown
    try {
      reply = await this.#wire.requestInventory(requestId)
    } catch {
      this.#invalidateControllerAuthority()
      throw remoteDenialError(denyRemote('device_offline'))
    }
    // Current-authority recheck after the wire await: revocation applied while the request was in
    // flight must stop the returned inventory from being published.
    await this.#assertControllerCurrent()
    this.#assertFenced()
    const parsed = InventoryOrDenialSchema.safeParse(reply)
    if (!parsed.success) throw untrusted()
    const { signature, ...unsigned } = parsed.data
    const domain = parsed.data.kind === 'inventory' ? DOMAIN.inventory : DOMAIN.responseSignature
    if (
      !verifyCanonical(domain, unsigned, signature, this.#route.deviceSigningPublicKey) ||
      !headerMatchesRoute(parsed.data.header, this.#route) ||
      parsed.data.header.requestId !== requestId
    ) {
      throw untrusted()
    }
    if (parsed.data.kind === 'denial') throw remoteDenialError(denyRemote(parsed.data.reason))
    const envelope = GatewayInventoryEnvelopeSchema.safeParse(parsed.data.envelope)
    if (
      !envelope.success ||
      envelope.data.nodeId !== this.#route.nodeId ||
      envelope.data.workspaceId !== this.#route.workspaceId
    ) {
      throw untrusted()
    }
    const ageMs = this.#now().getTime() - Date.parse(envelope.data.observedAt)
    // A non-finite clock would make every age comparison false (fail open); deny instead.
    if (!Number.isFinite(ageMs)) throw remoteDenialError(denyRemote('clock_invalid'))
    if (ageMs > ACP_REMOTE_MAX_INVENTORY_AGE_MS || ageMs < -ACP_REMOTE_CLOCK_SKEW_MS) {
      throw remoteDenialError(denyRemote('device_stale'))
    }
    return envelope.data
  }

  /**
   * The sealed command for one inner command, sealed once and reused by every retry of it.
   *
   * The seal is stable because the command IDENTITY is stable: the gateway identifies a
   * command by its full envelope, and the device seals its reply to the return key in the
   * command header. A retry therefore re-sends the same bytes and opens the reply the device
   * recorded for the first attempt, instead of looking like a second, different command.
   */
  async #sealedCommand(
    command: GatewayCommandEnvelope,
    plaintext: Uint8Array
  ): Promise<{
    readonly returnKey: RecipientKeyPair
    readonly header: AcpRemoteCommandHeader
    readonly message: AcpRemoteSealedCommand
  }> {
    // The key is the WHOLE inner command: the seal covers the command's plaintext AND its
    // header, which carries the validity window and the channel generation. A retry that
    // re-dispatches the same command therefore reuses its seal, while a command that moved
    // to a new generation or a new window is sealed again -- the device fences both.
    const identity = sha256Digest(canonicalJson(command))
    const existing = this.#sealedCommands.get(identity)
    if (existing !== undefined) return existing
    // Two concurrent dispatches of the same command must not both miss the cache and then seal
    // it twice: two seals of one command are two different carriers, and the durable command
    // repository refuses the second as a different command. The in-flight seal is shared, so
    // concurrent duplicates converge on ONE carrier.
    const inFlight = this.#sealingCommands.get(identity)
    if (inFlight !== undefined) return await inFlight
    const now = this.#now().getTime()
    if (!Number.isFinite(now)) throw remoteDenialError(denyRemote('clock_invalid'))
    for (const [key, entry] of this.#sealedCommands) {
      if (Date.parse(entry.header.expiresAt) <= now) this.#sealedCommands.delete(key)
    }
    if (this.#sealedCommands.size + this.#sealingCommands.size >= SEALED_COMMAND_CACHE_CAPACITY) {
      // Do not evict a live seal: it owns the return key and durable carrier identity needed by
      // retries. Backpressure before sealing keeps both the cache and in-flight work bounded.
      throw remoteDenialError(denyRemote('state_unavailable'))
    }
    const sealing = this.#seal(command, plaintext)
    this.#sealingCommands.set(identity, sealing)
    try {
      return await sealing
    } finally {
      this.#sealingCommands.delete(identity)
    }
  }

  /**
   * Seals one command and records the seal. The caller holds the in-flight slot, so only one
   * seal of a command exists at a time.
   */
  async #seal(
    command: GatewayCommandEnvelope,
    plaintext: Uint8Array
  ): Promise<{
    readonly returnKey: RecipientKeyPair
    readonly header: AcpRemoteCommandHeader
    readonly message: AcpRemoteSealedCommand
  }> {
    const returnKey = await generateRecipientKeyPair()
    await this.#assertControllerCurrent()
    const header: AcpRemoteCommandHeader = {
      suite: ACP_REMOTE_SUITE,
      workspaceId: command.workspaceId,
      nodeId: command.nodeId,
      runtimeConnectionId: this.#route.runtimeConnectionId,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
      channelGeneration: command.channelGeneration,
      controllerKeyId: this.#route.controllerKeyId,
      recipientKeyId: this.#route.deviceEncryptionKeyId,
      returnKeyId: returnKeyIdOf(returnKey),
      returnPublicKey: returnKey.publicKey,
    }
    const sealed = await hpkeSeal({
      recipientPublicKey: this.#route.deviceEncryptionPublicKey,
      info: DOMAIN.commandInfo,
      aad: associatedData(DOMAIN.commandAad, header),
      plaintext,
    })
    await this.#assertControllerCurrent()
    const body = { header, encapsulatedKey: sealed.encapsulatedKey, ciphertext: sealed.ciphertext }
    const message: AcpRemoteSealedCommand = {
      ...body,
      signature: signCanonical(DOMAIN.commandSignature, body, this.#signingKey),
    }
    const record = { returnKey, header, message }
    const identity = sha256Digest(canonicalJson(command))
    this.#sealedCommands.set(identity, record)
    // Prune any windows that closed while sealing. Live seals remain cached; capacity was reserved
    // in #sealedCommand before this asynchronous operation began.
    const now = this.#now().getTime()
    for (const [key, entry] of this.#sealedCommands) {
      if (key !== identity && Date.parse(entry.header.expiresAt) <= now)
        this.#sealedCommands.delete(key)
    }
    return record
  }

  async dispatch(
    commandInput: GatewayCommandEnvelope,
    signal?: AbortSignal
  ): Promise<AcpGatewayExchange> {
    this.#assertFenced()
    await this.#assertControllerCurrent()
    const command = GatewayCommandEnvelopeSchema.parse(commandInput)
    if (
      command.nodeId !== this.#route.nodeId ||
      command.workspaceId !== this.#route.workspaceId ||
      command.runtimeConnectionId !== this.#route.runtimeConnectionId
    ) {
      throw remoteDenialError(denyRemote('binding_mismatch'))
    }
    const commandWindow = evaluateCommandWindow({
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
      now: this.#now(),
      clockSkewMs: ACP_REMOTE_CLOCK_SKEW_MS,
      maxLifetimeMs: ACP_REMOTE_MAX_COMMAND_LIFETIME_MS,
    })
    if (commandWindow.outcome === 'denied') throw remoteDenialError(commandWindow)
    if (signalAborted(signal)) throw timeoutError()

    const plaintext = utf8(canonicalJson(command))
    if (plaintext.byteLength > ACP_REMOTE_MAX_PLAINTEXT_BYTES) {
      throw remoteDenialError(denyRemote('payload_too_large'))
    }
    // The sealed command is stable for one inner command. Both ends depend on that: the
    // gateway identifies a command by its FULL envelope, so a retry that re-sealed would be
    // refused as a different command, and the reply is sealed to this return key, so a retry
    // that re-keyed could not open the reply the device recorded for the first attempt.
    const sealedCommand = await this.#sealedCommand(command, plaintext)
    const returnKey = sealedCommand.returnKey
    const header = sealedCommand.header
    const message = sealedCommand.message
    // Authority can change while keys are generated and the payload is sealed: re-fence
    // immediately before send so no sealed command leaves after revocation, an offline wire, or an
    // abort, and so an already-expired window is never sealed. The authority read is awaited, so it
    // runs first: local revocation, expiry, abort or a wire disconnect can land while it is
    // suspended. The fences below are synchronous and nothing is awaited between them and the send.
    await this.#assertControllerCurrent()
    this.#assertFenced()
    const resendWindow = evaluateCommandWindow({
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
      now: this.#now(),
      clockSkewMs: ACP_REMOTE_CLOCK_SKEW_MS,
      maxLifetimeMs: ACP_REMOTE_MAX_COMMAND_LIFETIME_MS,
    })
    if (resendWindow.outcome === 'denied') throw remoteDenialError(resendWindow)
    if (signalAborted(signal)) throw timeoutError()

    let reply: unknown
    try {
      reply = await this.#wire.sendCommand(message)
    } catch (error) {
      this.#invalidateControllerAuthority()
      if (error instanceof AcpRemoteUndeliveredError) {
        throw remoteDenialError(denyRemote(error.reason))
      }
      // The command may have reached the device; the same command identity is safe to retry because
      // the device replay ledger returns the recorded outcome instead of repeating the effect.
      throw remoteDenialError(denyRemote('response_unknown'))
    }
    // Current-authority recheck after the send await: revocation or an abort that landed while the
    // command was on the wire must stop the reply from being opened and published to the caller.
    // The window is rechecked only when an exchange is opened: a signed device denial (for example
    // `command_expired`, with nothing executed) is the more accurate answer and is surfaced as is.
    await this.#assertControllerCurrent()
    this.#assertFencedAfterDelivery()
    if (signalAborted(signal)) throw timeoutError()
    return this.#openReply(reply, header, returnKey)
  }

  #assertFenced(): void {
    const decision = this.fenceDecision()
    if (decision.outcome === 'denied') {
      this.#invalidateControllerAuthority()
      throw remoteDenialError(decision)
    }
  }

  #invalidateControllerAuthority(): void {
    if (this.#controllerAuthority !== undefined) this.#controllerAuthorityVerified = false
  }

  #controllerAuthorityBinding(): AcpRemoteControllerAuthorityBinding {
    return {
      workspaceId: this.#route.workspaceId,
      nodeId: this.#route.nodeId,
      runtimeConnectionId: this.#route.runtimeConnectionId,
      controllerKeyId: this.#route.controllerKeyId,
      controllerSigningPublicKey: this.#route.controllerSigningPublicKey,
    }
  }

  #controllerIsCurrent(): boolean {
    try {
      return this.#controllerAuthority?.isCurrent(this.#controllerAuthorityBinding()) ?? true
    } catch {
      return false
    }
  }

  async #assertControllerCurrent(): Promise<void> {
    const authority = this.#controllerAuthority
    if (authority === undefined) return
    try {
      await authority.assertCurrent(this.#controllerAuthorityBinding())
      if (!this.#controllerIsCurrent()) throw new Error('CONTROLLER_AUTHORITY_CACHE_STALE')
      this.#controllerAuthorityVerified = true
    } catch {
      this.#invalidateControllerAuthority()
      throw new Error('ACP_REMOTE_CONTROLLER_AUTHORITY_DENIED')
    }
  }

  /**
   * Fence check once a reply is in hand. The command definitely reached the device, so the wire
   * going offline afterwards says nothing about authority and must not be reported as
   * `device_offline` (which callers read as "never delivered"). Revocation, staleness and a broken
   * clock still stop the reply from being published.
   */
  #assertFencedAfterDelivery(): void {
    const decision = this.fenceDecision()
    if (decision.outcome === 'denied') this.#invalidateControllerAuthority()
    if (decision.outcome === 'denied' && decision.reason !== 'device_offline') {
      throw remoteDenialError(decision)
    }
  }

  /**
   * Window check once the command may have executed. An expiry observed now does not mean nothing
   * ran, so it is reported as an unknown outcome (retryable on the same command identity, whose
   * recorded outcome the device replays) rather than as a non-retryable `command_expired`.
   */
  #assertWindowAfterDelivery(command: {
    readonly issuedAt: string
    readonly expiresAt: string
  }): void {
    const window = evaluateCommandWindow({
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
      now: this.#now(),
      clockSkewMs: ACP_REMOTE_CLOCK_SKEW_MS,
      maxLifetimeMs: ACP_REMOTE_MAX_COMMAND_LIFETIME_MS,
    })
    if (window.outcome !== 'denied') return
    throw remoteDenialError(
      window.reason === 'command_expired' ? denyRemote('response_unknown') : window
    )
  }

  async #openReply(
    reply: unknown,
    command: AcpRemoteCommandHeader,
    returnKey: RecipientKeyPair
  ): Promise<AcpGatewayExchange> {
    const parsed = CommandReplySchema.safeParse(reply)
    if (!parsed.success) throw untrusted()
    const { signature, ...unsigned } = parsed.data
    if (
      !verifyCanonical(
        DOMAIN.responseSignature,
        unsigned,
        signature,
        this.#route.deviceSigningPublicKey
      ) ||
      !headerMatchesRoute(parsed.data.header, this.#route) ||
      parsed.data.header.commandId !== command.commandId ||
      parsed.data.header.payloadHash !== command.payloadHash ||
      parsed.data.header.returnKeyId !== command.returnKeyId
    ) {
      throw untrusted()
    }
    if (parsed.data.kind === 'denial') throw remoteDenialError(denyRemote(parsed.data.reason))
    let exchange: unknown
    try {
      const plaintext = await hpkeOpen({
        recipientPrivateKey: returnKey.keyPair.privateKey,
        info: DOMAIN.responseInfo,
        aad: associatedData(DOMAIN.responseAad, parsed.data.header),
        encapsulatedKey: parsed.data.encapsulatedKey,
        ciphertext: parsed.data.ciphertext,
      })
      exchange = JSON.parse(utf8Decode(plaintext))
    } catch {
      throw untrusted()
    }
    // Current-authority recheck after the decrypt await: authority that changed while the sealed
    // reply was opening must stop the exchange from reaching the caller.
    await this.#assertControllerCurrent()
    this.#assertFencedAfterDelivery()
    this.#assertWindowAfterDelivery(command)
    const decoded = ExchangeSchema.safeParse(exchange)
    if (!decoded.success) throw untrusted()
    return {
      ack: decoded.data.ack,
      progress: decoded.data.progress,
      ...(decoded.data.result === undefined ? {} : { result: decoded.data.result }),
      ...(decoded.data.error === undefined ? {} : { error: decoded.data.error }),
    }
  }
}

export interface SecureAcpDeviceEndpointOptions {
  readonly route: AcpRemoteDeviceRoute
  readonly identity: { readonly keyId: string; readonly signingKey: KeyObject }
  readonly encryption: {
    readonly keyId: string
    readonly privateKey: RecipientKeyPair['keyPair']['privateKey']
    readonly publicKey: string
  }
  /** Device-local ACP executor. It runs only after every fence has passed. */
  readonly executor: Pick<AcpGatewayTransport, 'dispatch' | 'inventory'>
  /**
   * Durable fence state: revocation, highest accepted channel generation, and the replay ledger.
   * Defaults to the in-memory seam, which is explicitly not durable across restart and never a
   * production claim. Production construction goes through
   * `createPersistentSecureAcpDeviceEndpoint` (which always builds the scoped
   * `PersistenceProviderAcpRemoteDeviceStateStore` from the authenticated route) — wired into
   * `LocalControlPlaneComposition` via its `secureAcpRemoteRoute` option — so a composition that
   * carries this route can never run with the non-durable default.
   */
  readonly stateStore?: AcpRemoteDeviceStateStore
  readonly now?: () => Date
  readonly replayLedgerCapacity?: number
}

/** Bound on how often one delivery re-enters the pipeline after a superseded pipeline it coalesced onto. */
const ACP_REMOTE_MAX_READMISSIONS = 2

/** In-flight outcome pipeline for one command id; concurrent deliveries coalesce onto it. */
interface AcpRemoteInflight {
  readonly identity: string
  readonly outcome: Promise<AcpRemoteDeviceOutcome>
}

/**
 * Device side of one route. Every command passes the revocation, trust-freshness, authentication,
 * decryption, binding, window, generation, and ledger fences before the executor is reached; the
 * command-scoped fence (route authority + window + generation) is re-checked after EVERY await on
 * the effect and publication paths, the persisted fence is enforced atomically inside the durable
 * claim transaction, and every reply — fresh, sealed, or cached — passes a publication fence.
 */
export class SecureAcpDeviceEndpoint {
  readonly #route: AcpRemoteDeviceRoute
  readonly #signingKey: KeyObject
  readonly #identityKeyId: string
  readonly #encryption: SecureAcpDeviceEndpointOptions['encryption']
  readonly #executor: Pick<AcpGatewayTransport, 'dispatch' | 'inventory'>
  readonly #stateStore: AcpRemoteDeviceStateStore
  readonly #now: () => Date
  readonly #ledgerCapacity: number
  readonly #inflight = new Map<string, AcpRemoteInflight>()
  /** Denials signed for a delivery that dispatched nothing and left no claim behind. */
  readonly #preDispatchRefusals = new WeakSet<object>()
  readonly #delivered = new Map<
    string,
    {
      readonly returnKeyId: string
      readonly identity: string
      readonly response: AcpRemoteSealedResponse
    }
  >()
  #loadPromise: Promise<void> | undefined
  #stateLoaded = false
  #highestGeneration = 0
  #revokedAt: string | undefined

  constructor(options: SecureAcpDeviceEndpointOptions) {
    this.#route = AcpRemoteDeviceRouteSchema.parse(options.route)
    if (
      options.identity.keyId !== this.#route.deviceKeyId ||
      signingPublicKeyOf(options.identity.signingKey) !== this.#route.deviceSigningPublicKey
    ) {
      throw new Error('ACP_REMOTE_IDENTITY_MISMATCH')
    }
    if (
      options.encryption.keyId !== this.#route.deviceEncryptionKeyId ||
      options.encryption.publicKey !== this.#route.deviceEncryptionPublicKey
    ) {
      throw new Error('ACP_REMOTE_RECIPIENT_MISMATCH')
    }
    const capacity = options.replayLedgerCapacity ?? DEFAULT_REPLAY_LEDGER_CAPACITY
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('ACP_REMOTE_REPLAY_LEDGER_CAPACITY_INVALID')
    }
    this.#signingKey = options.identity.signingKey
    this.#identityKeyId = options.identity.keyId
    this.#encryption = options.encryption
    this.#executor = options.executor
    this.#stateStore = options.stateStore ?? new InMemoryAcpRemoteDeviceStateStore()
    this.#now = options.now ?? (() => new Date())
    this.#ledgerCapacity = capacity
  }

  isRevoked(): boolean {
    return this.#route.status === 'revoked' || this.#revokedAt !== undefined
  }

  /** Loads persisted fence state once; when already loaded the caller never suspends. */
  async #ensureLoaded(): Promise<void> {
    if (this.#stateLoaded) return
    this.#loadPromise ??= this.#loadState()
    await this.#loadPromise
  }

  async #loadState(): Promise<void> {
    try {
      const fence = await this.#stateStore.loadFence()
      this.#highestGeneration = Math.max(this.#highestGeneration, fence.highestGeneration)
      this.#revokedAt ??= fence.revokedAt
      this.#stateLoaded = true
    } catch (error) {
      this.#loadPromise = undefined
      throw error
    }
  }

  /**
   * Current-authority fence, invoked after every await. A non-finite clock fails closed first, then
   * terminal revocation, then trust-record staleness. Any value here must block the executor.
   */
  #fenceReason(): AcpRemoteDenialReason | undefined {
    const nowMs = this.#now().getTime()
    if (!Number.isFinite(nowMs)) return 'clock_invalid'
    if (this.isRevoked()) return 'device_revoked'
    if (nowMs >= Date.parse(this.#route.validUntil)) return 'device_stale'
    return undefined
  }

  /**
   * Command-scoped current-authority fence: the route fence, this delivery's window, and this
   * delivery's channel generation against the highest accepted generation. It is re-evaluated after
   * EVERY await on effect and publication paths — storage reads, ledger claim, execution, reply
   * sealing, and cached-response service — so a command whose window expires or whose generation
   * is superseded while parked is denied exactly like one that arrived expired or superseded.
   */
  #commandFenceReason(header: AcpRemoteCommandHeader): AcpRemoteDenialReason | undefined {
    const routeFence = this.#fenceReason()
    if (routeFence !== undefined) return routeFence
    const window = evaluateCommandWindow({
      issuedAt: header.issuedAt,
      expiresAt: header.expiresAt,
      now: this.#now(),
      clockSkewMs: ACP_REMOTE_CLOCK_SKEW_MS,
      maxLifetimeMs: ACP_REMOTE_MAX_COMMAND_LIFETIME_MS,
    })
    if (window.outcome === 'denied') return window.reason
    if (header.channelGeneration < this.#highestGeneration) return 'stale_channel_generation'
    return undefined
  }

  /**
   * Folds the persisted fence into the local mirror. A peer endpoint on the same scoped store can
   * durably revoke the device or accept a higher channel generation at any time, which this mirror
   * cannot observe on its own. A failed read is `state_unavailable`, never a continued grant.
   */
  async #refreshFence(): Promise<AcpRemoteDenialReason | undefined> {
    let fence: AcpRemoteDeviceFenceRecord
    try {
      fence = await this.#stateStore.loadFence()
    } catch {
      return 'state_unavailable'
    }
    this.#highestGeneration = Math.max(this.#highestGeneration, fence.highestGeneration)
    this.#revokedAt ??= fence.revokedAt
    return undefined
  }

  /** Route fence decided against the durable store, before inventory is produced or published. */
  async #currentRouteFence(): Promise<AcpRemoteDenialReason | undefined> {
    return (await this.#refreshFence()) ?? this.#fenceReason()
  }

  /** Command fence decided against the durable store, before any replay or publication. */
  async #currentCommandFence(
    header: AcpRemoteCommandHeader
  ): Promise<AcpRemoteDenialReason | undefined> {
    return (await this.#refreshFence()) ?? this.#commandFenceReason(header)
  }

  /**
   * Persists the generation of an accepted delivery that is answered without a new claim. A replay,
   * a coalesced duplicate, and a lost claim race are accepted deliveries too: a higher generation
   * must supersede older channels durably, or a distinct command on an older generation would be
   * accepted afterwards. A store failure is `state_unavailable`, never a served replay.
   */
  async #advanceGeneration(
    header: AcpRemoteCommandHeader
  ): Promise<AcpRemoteDenialReason | undefined> {
    try {
      const result = await this.#stateStore.advanceGeneration(header.channelGeneration)
      if (result !== 'advanced') return result
    } catch {
      return 'state_unavailable'
    }
    this.#highestGeneration = Math.max(this.#highestGeneration, header.channelGeneration)
    return undefined
  }

  /**
   * Applies a controller-signed revocation: the local mirror flips synchronously so a command parked
   * in flight is fenced immediately, and the durable record is written before this resolves so the
   * revocation survives a restart. Notices from any other key are rejected, never applied.
   */
  async applyRevocation(notice: unknown): Promise<void> {
    const parsed = RevocationNoticeSchema.safeParse(notice)
    if (
      !parsed.success ||
      parsed.data.controllerKeyId !== this.#route.controllerKeyId ||
      parsed.data.workspaceId !== this.#route.workspaceId ||
      parsed.data.nodeId !== this.#route.nodeId ||
      parsed.data.runtimeConnectionId !== this.#route.runtimeConnectionId
    ) {
      throw remoteDenialError(denyRemote('authentication_failed'))
    }
    const { signature, ...unsigned } = parsed.data
    if (
      !verifyCanonical(
        DOMAIN.revocation,
        unsigned,
        signature,
        this.#route.controllerSigningPublicKey
      )
    ) {
      throw remoteDenialError(denyRemote('authentication_failed'))
    }
    this.#revokedAt ??= parsed.data.revokedAt
    await this.#stateStore.applyRevocation(parsed.data.revokedAt)
  }

  async handleInventory(requestId: string): Promise<AcpRemoteInventoryReply> {
    const header = {
      suite: ACP_REMOTE_SUITE,
      workspaceId: this.#route.workspaceId,
      nodeId: this.#route.nodeId,
      runtimeConnectionId: this.#route.runtimeConnectionId,
      signerKeyId: this.#identityKeyId,
      requestId: InventoryRequestIdSchema.parse(requestId),
    }
    if (!this.#stateLoaded) {
      try {
        await this.#ensureLoaded()
      } catch {
        return this.#signDenial(header, 'state_unavailable')
      }
    }
    const fenced = await this.#currentRouteFence()
    if (fenced !== undefined) return this.#signDenial(header, fenced)
    const envelope = await this.#executor.inventory()
    GatewayInventoryEnvelopeSchema.parse(envelope)
    // Publication fence against the durable store: revocation from this endpoint or a peer on the
    // same store, or a broken clock, can land while inventory is produced.
    const afterAwait = await this.#currentRouteFence()
    if (afterAwait !== undefined) return this.#signDenial(header, afterAwait)
    const body = { kind: 'inventory' as const, header, envelope }
    return { ...body, signature: signCanonical(DOMAIN.inventory, body, this.#signingKey) }
  }

  /**
   * Authenticates, decrypts, and fences one sealed command. Authenticated refusals return signed denials;
   * unauthenticated input is rejected without any reply that could be read as a device outcome.
   * Revocation, staleness, window, and generation fences run before decryption, again after each
   * await — storage reads, ledger claim, execution, sealing — and inside the durable claim
   * transaction, so authority that changes mid-flight never reaches the executor and a parked
   * expired or superseded command can never execute.
   */
  async handleCommand(input: unknown): Promise<AcpRemoteSealedResponse> {
    const parsed = SealedCommandSchema.safeParse(input)
    if (!parsed.success) throw remoteDenialError(denyRemote('binding_mismatch'))
    const { header, encapsulatedKey, ciphertext, signature } = parsed.data
    // Unauthenticated input gets no signed reply. A signed refusal over header fields an intermediary
    // can copy would let it inject a false outcome while the original command still executes.
    if (
      header.controllerKeyId !== this.#route.controllerKeyId ||
      !verifyCanonical(
        DOMAIN.commandSignature,
        { header, encapsulatedKey, ciphertext },
        signature,
        this.#route.controllerSigningPublicKey
      )
    ) {
      throw remoteDenialError(denyRemote('authentication_failed'))
    }
    if (
      header.workspaceId !== this.#route.workspaceId ||
      header.nodeId !== this.#route.nodeId ||
      header.runtimeConnectionId !== this.#route.runtimeConnectionId ||
      header.recipientKeyId !== this.#route.deviceEncryptionKeyId
    ) {
      return this.#refuse(header, 'binding_mismatch')
    }
    if (decodeBase64Url(ciphertext).byteLength > ACP_REMOTE_MAX_PLAINTEXT_BYTES + AEAD_TAG_BYTES) {
      return this.#refuse(header, 'payload_too_large')
    }
    if (!this.#stateLoaded) {
      try {
        await this.#ensureLoaded()
      } catch {
        return this.#refuse(header, 'state_unavailable')
      }
    }
    const preDecrypt = this.#commandFenceReason(header)
    if (preDecrypt !== undefined) return this.#refuseBeforeEffect(header, preDecrypt)
    let plaintext: Uint8Array
    try {
      plaintext = await hpkeOpen({
        recipientPrivateKey: this.#encryption.privateKey,
        info: DOMAIN.commandInfo,
        aad: associatedData(DOMAIN.commandAad, header),
        encapsulatedKey,
        ciphertext,
      })
    } catch {
      return this.#refuse(header, 'decryption_failed')
    }
    const command = decodeCommand(plaintext)
    if (command === undefined || !plaintextMatchesHeader(command, header)) {
      return this.#refuse(header, 'binding_mismatch')
    }
    // Current-authority recheck after the decrypt await: revocation, staleness, a broken clock, an
    // expired window, or a superseded generation that landed while this command was parked must
    // prevent the executor below. The command-scoped fence also gates every replay of a recorded
    // outcome, so cached output is never re-sealed under stale delivery context.
    const postDecrypt = this.#commandFenceReason(header)
    if (postDecrypt !== undefined) return this.#refuseBeforeEffect(header, postDecrypt)
    const identity = semanticIdentityOf(command)
    const outcome = await this.#outcomeFor(header, command, identity)
    return this.#reply(outcome, header, identity)
  }

  /**
   * Resolves the recorded or to-be-recorded outcome for one command identity. The store is the
   * authority: entries live in durable state, concurrent deliveries coalesce onto one in-flight
   * pipeline, and every store await is followed by a current-authority fence before the executor.
   */
  async #outcomeFor(
    header: AcpRemoteCommandHeader,
    command: GatewayCommandEnvelope,
    identity: string,
    readmissions = 0
  ): Promise<AcpRemoteDeviceOutcome> {
    const inflight = this.#inflight.get(header.commandId)
    if (inflight !== undefined) {
      // A coalesced duplicate of the SAME command is an accepted delivery: it advances the durable
      // generation fence even though it never claims, then waits for the one pipeline that runs the
      // effect. A different command reusing the id is a conflict and mutates no fence.
      if (inflight.identity !== identity) return { kind: 'denial', reason: 'command_conflict' }
      const advanced = await this.#advanceGeneration(header)
      const outcome = await inflight.outcome
      const fenced = advanced ?? this.#commandFenceReason(header)
      if (fenced !== undefined) return withholdExchange(fenced, outcome)
      // The pipeline this delivery coalesced onto was superseded before it dispatched anything (its
      // claim was abandoned or never made). Its refusal belongs to the older generation, not to this
      // current one, so this delivery is admitted again on its own pipeline: a fresh claim runs the
      // effect at most once, and a record left by any other delivery is replayed instead.
      if (this.#preDispatchRefusals.has(outcome) && readmissions < ACP_REMOTE_MAX_READMISSIONS) {
        return this.#outcomeFor(header, command, identity, readmissions + 1)
      }
      return outcome
    }
    const pipeline = this.#pipeline(header, command, identity)
    const tracked: AcpRemoteInflight = { identity, outcome: pipeline }
    this.#inflight.set(header.commandId, tracked)
    const release = () => {
      if (this.#inflight.get(header.commandId) === tracked) {
        this.#inflight.delete(header.commandId)
      }
    }
    void pipeline.then(release, release)
    return pipeline
  }

  async #pipeline(
    header: AcpRemoteCommandHeader,
    command: GatewayCommandEnvelope,
    identity: string
  ): Promise<AcpRemoteDeviceOutcome> {
    try {
      const stored = await this.#stateStore.readLedger(header.commandId)
      // Recorded outcomes replay only after the durable fence confirms current authority.
      const fencedAfterRead = await this.#currentCommandFence(header)
      const replayed = replayOutcome(stored, identity)
      if (fencedAfterRead !== undefined) {
        return this.#refusalOutcome(header, identity, fencedAfterRead, stored)
      }
      if (replayed !== undefined) {
        // Served from the ledger without a claim: the delivery still moves the generation fence,
        // but only a delivery of the recorded command. A conflicting identity is refused and
        // mutates nothing.
        if (stored?.identity !== identity) return replayed
        const advanced = await this.#advanceGeneration(header)
        return advanced === undefined ? replayed : withholdExchange(advanced, replayed)
      }
      const fencedBeforeClaim = this.#commandFenceReason(header)
      if (fencedBeforeClaim !== undefined) {
        return this.#refusalOutcome(header, identity, fencedBeforeClaim)
      }
      let claimResult: AcpRemoteDeviceClaimResult
      try {
        // Capacity admission happens INSIDE the claim's serialized/CAS fence transaction (never
        // as a separate pre-read), so distinct concurrent commands at capacity one admit exactly
        // one effect; a duplicate replayed above still succeeds while the ledger is full.
        claimResult = await this.#stateStore.claim({
          commandId: header.commandId,
          identity,
          channelGeneration: header.channelGeneration,
          capacity: this.#ledgerCapacity,
          // Retention: a record whose delivery window has closed is compacted, not deleted. A retry
          // of the same command id with a fresh window passes the window fence, so its duplicate
          // protection must survive; compaction only releases the capacity the record held.
          expiresAtMs: Date.parse(header.expiresAt),
          compactExpiredAtOrBeforeMs: this.#now().getTime() - ACP_REMOTE_CLOCK_SKEW_MS,
        })
      } catch {
        return { kind: 'denial', reason: 'state_unavailable' }
      }
      if (claimResult === 'replay_ledger_full') {
        return { kind: 'denial', reason: 'replay_ledger_full' }
      }
      // Atomic durable fence results: the persisted fence rejected the claim inside the same
      // transaction that would have created the ledger entry, so nothing was written and nothing
      // may execute — including for an endpoint that loaded its in-process mirror once.
      if (claimResult === 'device_revoked') return { kind: 'denial', reason: claimResult }
      if (claimResult === 'stale_channel_generation') {
        return this.#refusalOutcome(header, identity, claimResult)
      }
      if (claimResult === 'already_claimed') {
        // Another delivery recorded this command first; replay its record instead of executing.
        // The winner can change at every await below (a pending winner may abandon and a replacement
        // delivery may record an outcome), so a refusal re-reads the ledger rather than reusing
        // this snapshot.
        const winner = await this.#stateStore.readLedger(header.commandId)
        const fencedAfterRace =
          (await this.#currentCommandFence(header)) ??
          (winner?.identity === identity ? await this.#advanceGeneration(header) : undefined)
        if (fencedAfterRace !== undefined) {
          return this.#refusalOutcome(header, identity, fencedAfterRace, winner)
        }
        return replayOutcome(winner, identity) ?? { kind: 'denial', reason: 'state_unavailable' }
      }
      this.#highestGeneration = Math.max(this.#highestGeneration, header.channelGeneration)
      // Final pre-effect boundary: a fresh durable fence read, with no await between its completion and
      // the dispatch call below. A revocation, supersession, expiry, or broken clock that the read
      // observes dispatches nothing and is recorded as the outcome. A failed read is not an authority
      // decision, so it is not recorded: the claim stays unrecorded, and a later delivery that reaches the
      // ledger reads it as outcome_uncertain. A commit landing after the read's snapshot is not observed.
      const refused = (await this.#refreshFence()) ?? this.#commandFenceReason(header)
      if (refused !== undefined) {
        const denial: AcpRemoteDeviceOutcome = { kind: 'denial', reason: refused }
        // Nothing was dispatched. Only a terminal revocation is recorded as the command's outcome;
        // every other pre-effect refusal (expired window, superseded generation, stale trust
        // record, clock or storage failure) is transient for the command id, so the claim is
        // released and a later delivery with a fresh window can still run it once.
        if (refused === 'device_revoked') {
          await this.#recordOutcome(header.commandId, denial)
        } else {
          if (await this.#abandonClaim(header.commandId, identity)) {
            this.#preDispatchRefusals.add(denial)
          }
        }
        return denial
      }
      const outcome = await this.#execute(command)
      if (outcome === undefined) return { kind: 'denial', reason: 'outcome_uncertain' }
      // Recording is best-effort: the claimed entry stays pending, and a later delivery or restart
      // reads pending as outcome_uncertain rather than re-running the effect.
      await this.#recordOutcome(header.commandId, outcome)
      return outcome
    } catch {
      return { kind: 'denial', reason: 'state_unavailable' }
    }
  }

  /**
   * Outcome for a delivery refused by a fence before it could claim or dispatch. The refusal reason
   * says what the fence saw, not whether the command ran: another endpoint over the shared store
   * may have recorded this same command since this pipeline's ledger read (it can complete between
   * the read and the fence, and a pending winner can abandon and be replaced). So the durable record
   * is read again, and the evidence decides: a recorded exchange is `response_unknown`, a claim
   * without an outcome `outcome_uncertain`, whatever the fence reason is (`stale_channel_generation`,
   * a window, `clock_invalid`, `device_stale`, `state_unavailable`). If that read fails, a record this
   * delivery already read (`known`) still counts; with neither, the evidence is unavailable and the
   * answer is `state_unavailable` (kept through publication by `withholdExchange`). Only a refusal with no record
   * for this identity is a no-effect refusal, and only that one may later be re-admitted for a
   * current-generation duplicate. A conflicting identity keeps the plain reason, and a revocation is
   * reported as itself before any evidence is consulted.
   */
  async #refusalOutcome(
    header: AcpRemoteCommandHeader,
    identity: string,
    reason: AcpRemoteDenialReason,
    known?: AcpRemoteDeviceLedgerRecord
  ): Promise<AcpRemoteDeviceOutcome> {
    const denial: AcpRemoteDeviceOutcome = { kind: 'denial', reason }
    if (reason === 'device_revoked') return denial
    let record: AcpRemoteDeviceLedgerRecord | undefined
    let fresh = true
    try {
      record = await this.#stateStore.readLedger(header.commandId)
    } catch {
      fresh = false
      record = known
    }
    if (record === undefined) {
      // No fresh read and nothing known: the evidence is unavailable, which proves nothing either way.
      if (!fresh) return { kind: 'denial', reason: 'state_unavailable' }
      this.#preDispatchRefusals.add(denial)
      return denial
    }
    if (record.identity !== identity) return denial
    return withholdExchange(reason, replayOutcome(record, identity))
  }

  /** True once the claim is released; a failed release leaves it pending (read as outcome_uncertain). */
  async #abandonClaim(commandId: string, identity: string): Promise<boolean> {
    try {
      await this.#stateStore.abandonClaim(commandId, identity)
      return true
    } catch {
      // The claim stays pending and a later delivery reads it as outcome_uncertain: fail closed.
      return false
    }
  }

  async #recordOutcome(commandId: string, outcome: AcpRemoteDeviceOutcome): Promise<void> {
    try {
      await this.#stateStore.recordOutcome(commandId, outcome)
    } catch {
      // Durable write failed after authority was checked; fail closed on recorded state, never by
      // repeating the effect.
    }
  }

  async #execute(command: GatewayCommandEnvelope): Promise<AcpRemoteDeviceOutcome | undefined> {
    try {
      return { kind: 'exchange', exchange: await this.#executor.dispatch(command) }
    } catch {
      // The executor may have applied an external effect before throwing. Keep the claimed ledger
      // entry pending so replay reports outcome_uncertain instead of asserting a terminal failure.
      return undefined
    }
  }

  /**
   * Seals an outcome to this delivery's return key, replaying byte-identical output when possible.
   * A cached response answers only the same delivery (same return key AND same semantic identity):
   * a different command reusing the command id gets its own outcome, such as `command_conflict`.
   */
  async #reply(
    outcome: AcpRemoteDeviceOutcome,
    header: AcpRemoteCommandHeader,
    identity: string
  ): Promise<AcpRemoteSealedResponse> {
    // Publication fence against the durable store before any output leaves: a cached response and a
    // freshly sealed exchange are both device publications, so current authority, window, and
    // generation must hold at serve time — not only when the effect first ran.
    const beforePublish = await this.#currentCommandFence(header)
    if (beforePublish !== undefined) return this.#withhold(header, beforePublish, outcome)
    const cached = this.#delivered.get(header.commandId)
    if (
      cached !== undefined &&
      cached.returnKeyId === header.returnKeyId &&
      cached.identity === identity
    ) {
      return cached.response
    }
    const response = await this.#sealOutcome(outcome, header)
    // Post-await publication fence: revocation, expiry, or supersession landing while the reply was
    // being sealed discards the sealed exchange. The recorded outcome stays durable for replay, so
    // the effect is never repeated to produce another response.
    const afterSeal = await this.#currentCommandFence(header)
    if (afterSeal !== undefined) return this.#withhold(header, afterSeal, outcome)
    if (!this.#delivered.has(header.commandId) && this.#delivered.size >= this.#ledgerCapacity) {
      const oldest = this.#delivered.keys().next().value
      if (oldest !== undefined) this.#delivered.delete(oldest)
    }
    this.#delivered.set(header.commandId, {
      returnKeyId: header.returnKeyId,
      identity,
      response,
    })
    return response
  }

  /** Refusal at a publication boundary; see `withholdExchange` for how a ran effect is reported. */
  #withhold(
    header: AcpRemoteCommandHeader,
    reason: AcpRemoteDenialReason,
    outcome: AcpRemoteDeviceOutcome
  ): Promise<AcpRemoteSealedResponse> {
    const withheld = withholdExchange(reason, outcome)
    return this.#sealOutcome(withheld, header)
  }

  /**
   * A delivery whose window is not open, whose channel generation is already superseded, or whose
   * device clock or trust record fails is refused before the plaintext is opened, but the same command
   * id may already have run under an earlier window or generation. `command_expired`,
   * `command_not_yet_valid` and `stale_channel_generation` tell the controller that nothing executed,
   * so they are only sent when the ledger holds no record; `clock_invalid` and `device_stale` also
   * yield to a recorded outcome. With a record, the controller gets the truth without any output:
   * a recorded exchange is `response_unknown` (retryable: a fresh window replays it), a claim
   * without an outcome or a compacted record is `outcome_uncertain`, and a recorded denial keeps its
   * reason. Identity is not compared here (the plaintext is not opened); a different command that
   * reuses the id gets `command_conflict` on its retry with a fresh window.
   */
  async #refuseBeforeEffect(
    header: AcpRemoteCommandHeader,
    reason: AcpRemoteDenialReason
  ): Promise<AcpRemoteSealedResponse> {
    if (!isPreEffectClaim(reason) && reason !== 'clock_invalid' && reason !== 'device_stale') {
      return this.#refuse(header, reason)
    }
    let stored: AcpRemoteDeviceLedgerRecord | undefined
    try {
      stored = await this.#stateStore.readLedger(header.commandId)
    } catch {
      return this.#refuse(header, 'state_unavailable')
    }
    if (stored === undefined) return this.#refuse(header, reason)
    if (stored.outcome === undefined) return this.#refuse(header, 'outcome_uncertain')
    return this.#refuse(
      header,
      stored.outcome.kind === 'exchange' ? 'response_unknown' : stored.outcome.reason
    )
  }

  #refuse(
    header: AcpRemoteCommandHeader,
    reason: AcpRemoteDenialReason
  ): Promise<AcpRemoteSealedResponse> {
    return this.#sealOutcome({ kind: 'denial', reason }, header)
  }

  async #sealOutcome(
    outcome: AcpRemoteDeviceOutcome,
    command: AcpRemoteCommandHeader
  ): Promise<AcpRemoteSealedResponse> {
    const header: AcpRemoteResponseHeader = {
      suite: ACP_REMOTE_SUITE,
      workspaceId: command.workspaceId,
      nodeId: command.nodeId,
      runtimeConnectionId: command.runtimeConnectionId,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      returnKeyId: command.returnKeyId,
      signerKeyId: this.#identityKeyId,
    }
    if (outcome.kind === 'denial') {
      return this.#signDenial(header, outcome.reason)
    }
    const sealed = await hpkeSeal({
      recipientPublicKey: command.returnPublicKey,
      info: DOMAIN.responseInfo,
      aad: associatedData(DOMAIN.responseAad, header),
      plaintext: utf8(canonicalJson(outcome.exchange)),
    })
    const body = {
      kind: 'exchange' as const,
      header,
      encapsulatedKey: sealed.encapsulatedKey,
      ciphertext: sealed.ciphertext,
    }
    return { ...body, signature: signCanonical(DOMAIN.responseSignature, body, this.#signingKey) }
  }

  #signDenial(
    header: AcpRemoteResponseHeader,
    reason: AcpRemoteDenialReason
  ): AcpRemoteDenialReply {
    const body = { kind: 'denial' as const, header, reason }
    return { ...body, signature: signCanonical(DOMAIN.responseSignature, body, this.#signingKey) }
  }
}

/** Reasons that tell the controller nothing executed, so they are only signed without contrary evidence. */
function isPreEffectClaim(reason: AcpRemoteDenialReason): boolean {
  return (
    reason === 'command_expired' ||
    reason === 'command_not_yet_valid' ||
    reason === 'stale_channel_generation'
  )
}

/**
 * Outcome interpretation for an existing durable record: identity conflicts and crash-pending
 * claims deny; recorded outcomes replay without an effect. `undefined` means no record exists yet.
 */
function replayOutcome(
  stored: AcpRemoteDeviceLedgerRecord | undefined,
  identity: string
): AcpRemoteDeviceOutcome | undefined {
  if (stored === undefined) return undefined
  if (stored.identity !== identity) return { kind: 'denial', reason: 'command_conflict' }
  if (stored.outcome !== undefined) return stored.outcome
  return { kind: 'denial', reason: 'outcome_uncertain' }
}

/**
 * Denial for a publication fence that failed after the command's outcome exists. When that outcome
 * is an exchange the effect already ran, so a transient reason (`command_expired`,
 * `stale_channel_generation`, ...) must not read as "nothing ran": it becomes `response_unknown`
 * (retryable on the same command identity, which replays the recorded outcome). A terminal
 * revocation is reported as itself. Outcome/fence matrix: a recorded effect is `response_unknown`, a
 * pending effect `outcome_uncertain`, unavailable evidence `state_unavailable` (all kept against any
 * later fence); only a proven no-effect denial yields to the fence reason.
 */
function withholdExchange(
  reason: AcpRemoteDenialReason,
  outcome: AcpRemoteDeviceOutcome | undefined
): AcpRemoteDeviceOutcome & { readonly kind: 'denial' } {
  if (reason === 'device_revoked') return { kind: 'denial', reason }
  if (outcome?.kind === 'exchange') return { kind: 'denial', reason: 'response_unknown' }
  // An outcome the device already knows is unknown stays unknown: a window or generation fence that
  // trips afterwards must not turn "an effect may have run" into a terminal pre-effect denial.
  // `state_unavailable` is storage-unknown evidence: the ledger or claim could not be read or written,
  // so nothing proves the command did not run, and a later window or generation fence must not turn it
  // into the terminal "nothing ran" `command_expired` / `stale_channel_generation`.
  if (
    outcome?.kind === 'denial' &&
    (outcome.reason === 'outcome_uncertain' ||
      outcome.reason === 'response_unknown' ||
      outcome.reason === 'state_unavailable')
  ) {
    return { kind: 'denial', reason: outcome.reason }
  }
  return { kind: 'denial', reason }
}

/** Re-reads the abort flag so narrowing from an earlier check cannot treat an abort as dead code. */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function timeoutError(): RuntimeAdapterError {
  return new RuntimeAdapterError({
    code: 'RUNTIME_GATEWAY_TIMEOUT',
    classification: 'timeout',
    message: 'RUNTIME_GATEWAY_TIMEOUT',
    retryable: true,
  })
}

function untrusted(): RuntimeAdapterError {
  return remoteDenialError(denyRemote('response_untrusted'))
}

function headerMatchesRoute(header: AcpRemoteResponseHeader, route: AcpRemoteDeviceRoute): boolean {
  return (
    header.suite === ACP_REMOTE_SUITE &&
    header.signerKeyId === route.deviceKeyId &&
    header.workspaceId === route.workspaceId &&
    header.nodeId === route.nodeId &&
    header.runtimeConnectionId === route.runtimeConnectionId
  )
}

function associatedData(domain: string, header: unknown): Uint8Array {
  return utf8(canonicalJson({ domain, header }))
}

function returnKeyIdOf(returnKey: RecipientKeyPair): string {
  return `ret_${createHash('sha256').update(returnKey.publicKey).digest('hex').slice(0, 32)}`
}

function decodeCommand(plaintext: Uint8Array): GatewayCommandEnvelope | undefined {
  try {
    const parsed = GatewayCommandEnvelopeSchema.safeParse(JSON.parse(utf8Decode(plaintext)))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function plaintextMatchesHeader(
  command: GatewayCommandEnvelope,
  header: AcpRemoteCommandHeader
): boolean {
  return (
    command.commandId === header.commandId &&
    command.workspaceId === header.workspaceId &&
    command.nodeId === header.nodeId &&
    command.runtimeConnectionId === header.runtimeConnectionId &&
    command.issuedAt === header.issuedAt &&
    command.expiresAt === header.expiresAt &&
    command.channelGeneration === header.channelGeneration &&
    command.payloadHash === header.payloadHash
  )
}

/**
 * Semantic identity of a command for duplicate detection. Transport and freshness fields (issuedAt,
 * expiresAt, sequence, sentAt, traceId) are excluded so a same-identity retry recognizes the first
 * delivery instead of being mistaken for a conflict.
 */
function semanticIdentityOf(command: GatewayCommandEnvelope): string {
  return sha256Digest(
    canonicalJson({
      commandId: command.commandId,
      workspaceId: command.workspaceId,
      nodeId: command.nodeId,
      runtimeConnectionId: command.runtimeConnectionId,
      executionId: command.executionId,
      attemptId: command.attemptId,
      family: command.family,
      operation: command.operation,
      driver: command.driver,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      requiredCapabilities: [...command.requiredCapabilities].toSorted(),
    })
  )
}

/** Domain labels, exported for fixtures that craft envelopes. Not re-exported from the package root. */
export { DOMAIN as ACP_REMOTE_DOMAIN }
