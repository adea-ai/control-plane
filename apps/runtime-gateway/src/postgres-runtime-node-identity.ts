import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { compareCodePointOrder } from '@control-plane/contracts'
import {
  RuntimeNodeAuthenticationAttemptSchema,
  RuntimeNodeCredentialClaimsSchema,
  RuntimeNodeIdentityValidationError,
  runtimeNodeWebSocketChallenge,
  type RuntimeNodeCredentialClaims,
  type RuntimeNodeIdentityInvalidation,
} from '@control-plane/runtime-gateway-protocol'
import type { RawEnvironment } from '@control-plane/config'
import type { PostgresRuntimeNodeIdentityRepository } from '@control-plane/database'
import type {
  RuntimeNodeAuthenticationExpectation,
  RuntimeNodeChannel,
  RuntimeNodeChannelAuthenticator,
} from './authentication.js'
import type { RuntimeNodeIdentityGatewayPort } from './runtime-node-identity-port.js'

const MAX_TRUSTED_ISSUER_KEYS = 16
const MAX_PUBLIC_KEY_PEM_BYTES = 4096
const MAX_RUNTIME_NODE_CREDENTIAL_LIFETIME_MS = 10 * 60_000

export interface RuntimeNodeIdentityTrustConfig {
  readonly issuer: string
  readonly audience: string
  /** Map of operator-controlled issuer key ID to public Ed25519 PEM. */
  readonly issuerPublicKeys: ReadonlyMap<string, string>
}

/**
 * Builds the concrete upgrade authenticator used by the production WebSocket
 * listener. The token and proof stay in headers; the proof challenge is derived
 * from the per-request Sec-WebSocket-Key, never from a query string.
 */
export function authenticateRuntimeNodeUpgrade(
  request: Request,
  authenticator: RuntimeNodeChannelAuthenticator,
  trust: RuntimeNodeIdentityTrustConfig
): Promise<RuntimeNodeChannel> {
  const authorization = request.headers.get('authorization')
  const proofSignature = request.headers.get('x-runtime-node-proof')
  const secWebSocketKey = request.headers.get('sec-websocket-key')
  if (
    authorization === null ||
    !authorization.startsWith('RuntimeNode ') ||
    authorization.length > 16_396 ||
    proofSignature === null ||
    proofSignature.length > 4096 ||
    secWebSocketKey === null
  ) {
    throw new RuntimeNodeIdentityValidationError('credential')
  }
  const credential = authorization.slice('RuntimeNode '.length)
  let challenge: string
  let claims: RuntimeNodeCredentialClaims
  try {
    challenge = runtimeNodeWebSocketChallenge(secWebSocketKey)
    claims = parseUntrustedRuntimeNodeCredentialClaims(credential)
  } catch {
    throw new RuntimeNodeIdentityValidationError('credential')
  }
  const attempt = {
    credential,
    proof: { challenge, signature: proofSignature },
  }
  const expected: RuntimeNodeAuthenticationExpectation = {
    issuer: trust.issuer,
    audience: trust.audience,
    nodeId: claims.nodeId,
    workspaceId: claims.workspaceId,
    channelGeneration: claims.channelGeneration,
    challenge,
  }
  return authenticator.authenticate(attempt, expected)
}

/** Parses public-only RuntimeNode trust from environment; private PEM is rejected. */
export function runtimeNodeIdentityTrustConfigFromEnvironment(
  environment: RawEnvironment
): RuntimeNodeIdentityTrustConfig {
  const issuer = environment['RUNTIME_NODE_IDENTITY_ISSUER']
  const audience = environment['RUNTIME_NODE_IDENTITY_AUDIENCE']
  const rawKeySet = environment['RUNTIME_NODE_IDENTITY_ISSUER_PUBLIC_KEYS_JSON']
  if (
    typeof issuer !== 'string' ||
    issuer.length > 512 ||
    !isHttpsUrl(issuer) ||
    typeof audience !== 'string' ||
    audience.length < 3 ||
    audience.length > 256 ||
    typeof rawKeySet !== 'string' ||
    rawKeySet.length === 0 ||
    rawKeySet.length > MAX_TRUSTED_ISSUER_KEYS * MAX_PUBLIC_KEY_PEM_BYTES
  ) {
    throw new Error('RUNTIME_NODE_IDENTITY_TRUST_CONFIG_INVALID')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(rawKeySet)
  } catch {
    throw new Error('RUNTIME_NODE_IDENTITY_TRUST_CONFIG_INVALID')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('RUNTIME_NODE_IDENTITY_TRUST_CONFIG_INVALID')
  }
  const entries = Object.entries(decoded)
  if (entries.length === 0 || entries.length > MAX_TRUSTED_ISSUER_KEYS) {
    throw new Error('RUNTIME_NODE_IDENTITY_TRUST_CONFIG_INVALID')
  }
  const issuerPublicKeys = new Map<string, string>()
  for (const [keyId, value] of entries) {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(keyId) || typeof value !== 'string') {
      throw new Error('RUNTIME_NODE_IDENTITY_TRUST_CONFIG_INVALID')
    }
    parseEd25519PublicKey(value)
    issuerPublicKeys.set(keyId, value)
  }
  return { issuer, audience, issuerPublicKeys }
}

/**
 * Validates operator-signed credentials using public issuer keys and durable
 * RuntimeNode verification keys/credential records. This adapter has no
 * issuance or signing method and cannot create a credential.
 */
export class PostgresRuntimeNodeIdentityValidationPort implements RuntimeNodeIdentityGatewayPort {
  readonly #issuerKeys: ReadonlyMap<string, KeyObject>
  readonly #listeners = new Set<(invalidation: RuntimeNodeIdentityInvalidation) => void>()
  readonly #repository: PostgresRuntimeNodeIdentityRepository
  #stopRepositoryListener: (() => Promise<void>) | undefined

  constructor(
    repository: PostgresRuntimeNodeIdentityRepository,
    issuerPublicKeys: ReadonlyMap<string, string>
  ) {
    if (issuerPublicKeys.size === 0 || issuerPublicKeys.size > MAX_TRUSTED_ISSUER_KEYS) {
      throw new Error('RUNTIME_NODE_IDENTITY_TRUST_CONFIG_INVALID')
    }
    this.#repository = repository
    const issuerKeys = new Map<string, KeyObject>()
    for (const [keyId, pem] of issuerPublicKeys) {
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(keyId)) {
        throw new Error('RUNTIME_NODE_IDENTITY_TRUST_CONFIG_INVALID')
      }
      issuerKeys.set(keyId, parseEd25519PublicKey(pem))
    }
    this.#issuerKeys = issuerKeys
  }

  /** Establishes cross-process PostgreSQL revocation delivery before readiness. */
  async startRevocationListener(): Promise<void> {
    if (this.#stopRepositoryListener !== undefined) return
    this.#stopRepositoryListener = await this.#repository.subscribeRevocations((invalidation) => {
      for (const listener of this.#listeners) listener(invalidation)
    })
  }

  async close(): Promise<void> {
    const stop = this.#stopRepositoryListener
    this.#stopRepositoryListener = undefined
    if (stop !== undefined) await stop()
    this.#listeners.clear()
  }

  subscribeRevocations(
    listener: (invalidation: RuntimeNodeIdentityInvalidation) => void
  ): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async verify(attemptValue: unknown): Promise<RuntimeNodeCredentialClaims> {
    const attempt = RuntimeNodeAuthenticationAttemptSchema.safeParse(attemptValue)
    if (!attempt.success) throw new RuntimeNodeIdentityValidationError('credential')
    const parts = attempt.data.credential.split('.')
    const [headerPart, payloadPart, signaturePart] = parts
    if (
      parts.length !== 3 ||
      headerPart === undefined ||
      payloadPart === undefined ||
      signaturePart === undefined
    ) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }

    const header = decodeJson(headerPart)
    if (!isIssuerHeader(header)) throw new RuntimeNodeIdentityValidationError('credential')
    const issuerKey = this.#issuerKeys.get(header.kid)
    if (
      issuerKey === undefined ||
      !verifyCompact(`${headerPart}.${payloadPart}`, signaturePart, issuerKey)
    ) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }

    const claimsValue = decodeJson(payloadPart)
    const claimsResult = RuntimeNodeCredentialClaimsSchema.safeParse(claimsValue)
    if (!claimsResult.success) throw new RuntimeNodeIdentityValidationError('credential')
    const claims = claimsResult.data
    if (
      Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) >
      MAX_RUNTIME_NODE_CREDENTIAL_LIFETIME_MS
    ) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }
    const issued = await this.#repository.getIssuedCredential(claims.credentialId)
    if (
      issued === undefined ||
      issued.nodeId !== claims.nodeId ||
      issued.workspaceId !== claims.workspaceId ||
      issued.keyId !== claims.keyId ||
      issued.revocationVersion !== claims.revocationVersion ||
      !sameClaims(issued.claims, claims)
    ) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }

    const registered = await this.#repository.getVerificationKey(claims.keyId)
    if (
      registered === undefined ||
      registered.status !== 'active' ||
      registered.nodeId !== claims.nodeId ||
      registered.workspaceId !== claims.workspaceId ||
      registered.thumbprint !== claims.proofKeyThumbprint
    ) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }
    const deviceKey = parseEd25519PublicKey(registered.publicKeyPem)
    if (thumbprint(deviceKey) !== registered.thumbprint) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }
    const proofInput = `${createHash('sha256').update(attempt.data.credential).digest('base64url')}.${attempt.data.proof.challenge}`
    if (!verifyCompact(proofInput, attempt.data.proof.signature, deviceKey)) {
      throw new RuntimeNodeIdentityValidationError('proof')
    }
    return claims
  }

  async isRevoked(credentialId: string, revocationVersion: number): Promise<boolean> {
    return this.#repository.isCredentialRevoked(credentialId, revocationVersion)
  }

  consumeCredential(
    credentialId: string,
    revocationVersion: number,
    now: Date
  ): Promise<'consumed' | 'replayed' | 'revoked' | 'expired' | 'unknown'> {
    return this.#repository.consumeCredential(credentialId, revocationVersion, now.toISOString())
  }
}

export function runtimeNodePublicKeyThumbprint(publicKeyPem: string): string {
  return thumbprint(parseEd25519PublicKey(publicKeyPem))
}

export function parseUntrustedRuntimeNodeCredentialClaims(
  credential: string
): RuntimeNodeCredentialClaims {
  const [headerPart, payloadPart, signaturePart, ...extra] = credential.split('.')
  if (
    extra.length !== 0 ||
    headerPart === undefined ||
    payloadPart === undefined ||
    signaturePart === undefined
  ) {
    throw new RuntimeNodeIdentityValidationError('credential')
  }
  const claims = RuntimeNodeCredentialClaimsSchema.safeParse(decodeJson(payloadPart))
  if (!claims.success) throw new RuntimeNodeIdentityValidationError('credential')
  return claims.data
}

function parseEd25519PublicKey(pem: string): KeyObject {
  if (
    typeof pem !== 'string' ||
    Buffer.byteLength(pem) > MAX_PUBLIC_KEY_PEM_BYTES ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(pem)
  ) {
    throw new Error('RUNTIME_NODE_PUBLIC_KEY_INVALID')
  }
  try {
    const key = createPublicKey(pem)
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new Error('RUNTIME_NODE_PUBLIC_KEY_INVALID')
    }
    return key
  } catch {
    throw new Error('RUNTIME_NODE_PUBLIC_KEY_INVALID')
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function decodeJson(part: string): unknown {
  try {
    const bytes = decodeBase64Url(part)
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new RuntimeNodeIdentityValidationError('credential')
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid compact base64url')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error('Non-canonical compact base64url')
  return decoded
}

function isIssuerHeader(
  value: unknown
): value is { readonly alg: 'EdDSA'; readonly typ: 'RNGC'; readonly kid: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    Reflect.get(value, 'alg') === 'EdDSA' &&
    Reflect.get(value, 'typ') === 'RNGC' &&
    typeof Reflect.get(value, 'kid') === 'string' &&
    /^[A-Za-z0-9_-]{4,64}$/.test(Reflect.get(value, 'kid'))
  )
}

function verifyCompact(value: string, encodedSignature: string, key: KeyObject): boolean {
  try {
    const signature = decodeBase64Url(encodedSignature)
    return verifySignature(null, Buffer.from(value), key, signature)
  } catch {
    return false
  }
}

function thumbprint(key: KeyObject): string {
  return `sha256:${createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex')}`
}

function sameClaims(value: unknown, claims: RuntimeNodeCredentialClaims): boolean {
  const parsed = RuntimeNodeCredentialClaimsSchema.safeParse(value)
  if (!parsed.success) return false
  const left = stableJson(parsed.data)
  const right = stableJson(claims)
  return left === right
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value).toSorted(([left], [right]) =>
    compareCodePointOrder(left, right)
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}
