import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto'
import {
  RuntimeNodeCredentialClaimsSchema,
  RuntimeNodeIdSchema,
  RuntimeNodeIdentityValidationError,
  RuntimeNodeWorkspaceIdSchema,
  type RuntimeNodeAuthenticationAttempt,
  type RuntimeNodeCredentialClaims,
  type RuntimeNodeIdentityInvalidation,
  type RuntimeNodeIdentityValidationPort,
} from '@control-plane/runtime-gateway-protocol'

export interface SyntheticRuntimeNodeIdentityAuthorityOptions {
  readonly audience: string
  readonly issuer: string
  readonly now?: () => Date
}

export interface SyntheticRuntimeNodeDevice {
  readonly nodeId: string
  readonly workspaceId: string
  readonly keyId: string
  readonly privateKey: string
  authenticationAttempt(credential: string, challenge: string): RuntimeNodeAuthenticationAttempt
}

interface RegisteredVerificationKey {
  readonly nodeId: string
  readonly workspaceId: string
  readonly publicKey: string
  readonly thumbprint: string
}

interface IssueCredentialOptions {
  readonly channelGeneration: number
  readonly audience?: string
  readonly issuer?: string
  readonly issuedAt?: string
  readonly expiresAt?: string
}

export class SyntheticRuntimeNodeIdentityAuthority {
  readonly #audience: string
  #credentialSequence = 0
  readonly #issuer: string
  #keySequence = 0
  readonly #keys = new Map<string, RegisteredVerificationKey>()
  readonly #listeners = new Set<(invalidation: RuntimeNodeIdentityInvalidation) => void>()
  readonly #now: () => Date
  readonly #revoked = new Set<string>()
  readonly #consumed = new Set<string>()

  constructor(options: SyntheticRuntimeNodeIdentityAuthorityOptions) {
    this.#audience = options.audience
    this.#issuer = options.issuer
    this.#now = options.now ?? (() => new Date())
  }

  registerNode(input: {
    readonly nodeId: string
    readonly workspaceId: string
  }): SyntheticRuntimeNodeDevice {
    RuntimeNodeIdSchema.parse(input.nodeId)
    RuntimeNodeWorkspaceIdSchema.parse(input.workspaceId)
    return this.#newDevice(input.nodeId, input.workspaceId)
  }

  rotateDeviceKey(device: SyntheticRuntimeNodeDevice): SyntheticRuntimeNodeDevice {
    return this.#newDevice(device.nodeId, device.workspaceId)
  }

  retireVerificationKey(keyId: string): void {
    if (!this.#keys.delete(keyId)) return
    for (const listener of this.#listeners) listener({ kind: 'key', keyId })
  }

  issueCredential(
    device: SyntheticRuntimeNodeDevice,
    options: IssueCredentialOptions
  ): { readonly credential: string; readonly claims: RuntimeNodeCredentialClaims } {
    const registered = this.#keys.get(device.keyId)
    if (registered === undefined) throw new Error('Synthetic device verification key is not active')
    const issuedAt = options.issuedAt ?? this.#now().toISOString()
    const claims = RuntimeNodeCredentialClaimsSchema.parse({
      schemaVersion: 1,
      credentialKind: 'runtime_node',
      credentialId: `rgc_${String(++this.#credentialSequence).padStart(16, '0')}`,
      issuer: options.issuer ?? this.#issuer,
      audience: options.audience ?? this.#audience,
      nodeId: device.nodeId,
      workspaceId: device.workspaceId,
      keyId: device.keyId,
      proofKeyThumbprint: registered.thumbprint,
      revocationVersion: 1,
      channelGeneration: options.channelGeneration,
      issuedAt,
      expiresAt: options.expiresAt ?? new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString(),
    })
    const header = encodeJson({ alg: 'EdDSA', typ: 'RNGC', kid: device.keyId })
    const payload = encodeJson(claims)
    const signingInput = `${header}.${payload}`
    return {
      claims,
      credential: `${signingInput}.${signatureFor(signingInput, device.privateKey)}`,
    }
  }

  revokeCredential(credentialId: string): void {
    this.#revoked.add(credentialId)
    for (const listener of this.#listeners) listener({ kind: 'credential', credentialId })
  }

  validationPort(): RuntimeNodeIdentityValidationPort {
    return {
      verify: async (attempt) => this.#verify(attempt),
      isRevoked: async (credentialId) => this.#revoked.has(credentialId),
      consumeCredential: async (credentialId) => {
        if (this.#revoked.has(credentialId)) return 'revoked'
        if (this.#consumed.has(credentialId)) return 'replayed'
        this.#consumed.add(credentialId)
        return 'consumed'
      },
      subscribeRevocations: (listener) => {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
      },
    }
  }

  #newDevice(nodeId: string, workspaceId: string): SyntheticRuntimeNodeDevice {
    const keyId = `rgk_${String(++this.#keySequence).padStart(12, '0')}`
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    })
    const thumbprint = `sha256:${createHash('sha256').update(publicKey).digest('hex')}`
    this.#keys.set(keyId, { nodeId, workspaceId, publicKey, thumbprint })
    return {
      nodeId,
      workspaceId,
      keyId,
      privateKey,
      authenticationAttempt: (credential, challenge) => ({
        credential,
        proof: {
          challenge,
          signature: signatureFor(proofInput(credential, challenge), privateKey),
        },
      }),
    }
  }

  #verify(attempt: RuntimeNodeAuthenticationAttempt): RuntimeNodeCredentialClaims {
    const parts = attempt.credential.split('.')
    const [headerPart, payloadPart, signature] = parts
    if (
      parts.length !== 3 ||
      headerPart === undefined ||
      payloadPart === undefined ||
      signature === undefined
    ) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }
    const header = parseJson(headerPart)
    if (!isCredentialHeader(header)) throw new RuntimeNodeIdentityValidationError('credential')
    const registered = this.#keys.get(header.kid)
    if (registered === undefined) throw new RuntimeNodeIdentityValidationError('credential')
    const signingInput = `${headerPart}.${payloadPart}`
    if (!validSignature(signingInput, signature, registered.publicKey)) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }
    const claims = RuntimeNodeCredentialClaimsSchema.safeParse(parseJson(payloadPart))
    if (
      !claims.success ||
      claims.data.keyId !== header.kid ||
      claims.data.nodeId !== registered.nodeId ||
      claims.data.workspaceId !== registered.workspaceId ||
      claims.data.proofKeyThumbprint !== registered.thumbprint
    ) {
      throw new RuntimeNodeIdentityValidationError('credential')
    }
    if (
      !validSignature(
        proofInput(attempt.credential, attempt.proof.challenge),
        attempt.proof.signature,
        registered.publicKey
      )
    ) {
      throw new RuntimeNodeIdentityValidationError('proof')
    }
    return claims.data
  }
}

function proofInput(credential: string, challenge: string): string {
  return `${createHash('sha256').update(credential).digest('base64url')}.${challenge}`
}

function signatureFor(value: string, privateKey: string): string {
  return signBytes(null, Buffer.from(value), privateKey).toString('base64url')
}

function validSignature(value: string, signature: string, publicKey: string): boolean {
  try {
    return verifyBytes(null, Buffer.from(value), publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new RuntimeNodeIdentityValidationError('credential')
  }
}

function isCredentialHeader(value: unknown): value is { readonly kid: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'alg') === 'EdDSA' &&
    Reflect.get(value, 'typ') === 'RNGC' &&
    typeof Reflect.get(value, 'kid') === 'string'
  )
}
