import type { StructuredLogger } from '@control-plane/bootstrap'
import {
  GatewayCommandEnvelopeSchema,
  RuntimeNodeAuthenticationAttemptSchema,
  RuntimeNodeCredentialClaimsSchema,
  RuntimeNodeIdentityValidationError,
  type RuntimeNodeCredentialClaims,
  type RuntimeNodeIdentityValidationPort,
} from '@control-plane/runtime-gateway-protocol'

export * from './synthetic-node-identity.js'

export interface RuntimeNodeAuthenticationExpectation {
  readonly audience: string
  readonly issuer: string
  readonly nodeId: string
  readonly workspaceId: string
  readonly channelGeneration: number
  readonly challenge: string
}

export type RuntimeNodeChannelInvalidationReason = 'replaced' | 'revoked' | 'expired'

export class RuntimeNodeAuthenticationError extends Error {
  constructor(readonly code: string) {
    super('RuntimeNode authentication was rejected')
    this.name = 'RuntimeNodeAuthenticationError'
  }
}

export class RuntimeNodeChannel {
  readonly claims: RuntimeNodeCredentialClaims
  readonly #identityValidator: RuntimeNodeIdentityValidationPort
  readonly #now: () => Date
  readonly #clockSkewMs: number
  #invalidationReason: RuntimeNodeChannelInvalidationReason | undefined

  constructor(
    claims: RuntimeNodeCredentialClaims,
    identityValidator: RuntimeNodeIdentityValidationPort,
    options: { readonly now?: () => Date; readonly clockSkewMs?: number } = {}
  ) {
    this.claims = claims
    this.#identityValidator = identityValidator
    this.#now = options.now ?? (() => new Date())
    this.#clockSkewMs = options.clockSkewMs ?? 30_000
  }

  get active(): boolean {
    if (Date.parse(this.claims.expiresAt) < this.#now().getTime() - this.#clockSkewMs)
      this.invalidate('expired')
    return this.#invalidationReason === undefined
  }

  get invalidatedReason(): RuntimeNodeChannelInvalidationReason | undefined {
    return this.#invalidationReason
  }

  invalidate(reason: RuntimeNodeChannelInvalidationReason): void {
    this.#invalidationReason ??= reason
  }

  async assertCommandAllowed(commandValue: unknown): Promise<void> {
    if (
      await this.#identityValidator.isRevoked(
        this.claims.credentialId,
        this.claims.revocationVersion
      )
    ) {
      this.invalidate('revoked')
    }
    if (!this.active) {
      throw new RuntimeNodeAuthenticationError(
        this.#invalidationReason === 'revoked'
          ? 'RUNTIME_NODE_CREDENTIAL_REVOKED'
          : this.#invalidationReason === 'expired'
            ? 'RUNTIME_NODE_CREDENTIAL_EXPIRED'
            : 'RUNTIME_NODE_CHANNEL_REPLACED'
      )
    }
    const command = GatewayCommandEnvelopeSchema.parse(commandValue)
    if (
      command.nodeId !== this.claims.nodeId ||
      command.workspaceId !== this.claims.workspaceId ||
      command.channelGeneration !== this.claims.channelGeneration
    ) {
      throw new RuntimeNodeAuthenticationError('RUNTIME_NODE_COMMAND_SCOPE_MISMATCH')
    }
  }
}

export interface RuntimeNodeChannelAuthenticatorOptions {
  readonly identityValidator: RuntimeNodeIdentityValidationPort
  readonly logger: StructuredLogger
  readonly now?: () => Date
  readonly clockSkewMs?: number
}

export class RuntimeNodeChannelAuthenticator {
  readonly #activeChannels = new Map<string, RuntimeNodeChannel>()
  readonly #clockSkewMs: number
  readonly #identityValidator: RuntimeNodeIdentityValidationPort
  readonly #logger: StructuredLogger
  readonly #now: () => Date
  readonly #usedCredentialIds = new Set<string>()
  readonly #unsubscribe: () => void

  constructor(options: RuntimeNodeChannelAuthenticatorOptions) {
    this.#identityValidator = options.identityValidator
    this.#logger = options.logger
    this.#now = options.now ?? (() => new Date())
    this.#clockSkewMs = options.clockSkewMs ?? 30_000
    this.#unsubscribe = this.#identityValidator.subscribeRevocations((credentialId) => {
      for (const channel of this.#activeChannels.values()) {
        if (channel.claims.credentialId !== credentialId) continue
        channel.invalidate('revoked')
        this.#audit(
          'warn',
          'runtime_node_auth.revoked',
          'RUNTIME_NODE_CREDENTIAL_REVOKED',
          channel.claims
        )
      }
    })
  }

  close(): void {
    this.#unsubscribe()
    for (const channel of this.#activeChannels.values()) channel.invalidate('replaced')
    this.#activeChannels.clear()
  }

  async authenticate(
    attemptValue: unknown,
    expected: RuntimeNodeAuthenticationExpectation
  ): Promise<RuntimeNodeChannel> {
    const attemptResult = RuntimeNodeAuthenticationAttemptSchema.safeParse(attemptValue)
    if (!attemptResult.success) this.#reject('RUNTIME_NODE_CREDENTIAL_MALFORMED')
    if (attemptResult.data.proof.challenge !== expected.challenge) {
      this.#reject('RUNTIME_NODE_PROOF_INVALID')
    }

    let claimsValue: unknown
    try {
      claimsValue = await this.#identityValidator.verify(attemptResult.data)
    } catch (error) {
      this.#reject(
        error instanceof RuntimeNodeIdentityValidationError && error.reason === 'proof'
          ? 'RUNTIME_NODE_PROOF_INVALID'
          : 'RUNTIME_NODE_CREDENTIAL_MALFORMED'
      )
    }
    const claimsResult = RuntimeNodeCredentialClaimsSchema.safeParse(claimsValue)
    if (!claimsResult.success) this.#reject('RUNTIME_NODE_CREDENTIAL_MALFORMED')
    const claims = claimsResult.data

    if (claims.issuer !== expected.issuer) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_INVALID_ISSUER', claims)
    }
    if (claims.audience !== expected.audience) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_INVALID_AUDIENCE', claims)
    }
    if (claims.nodeId !== expected.nodeId) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_NODE_MISMATCH', claims)
    }
    if (claims.workspaceId !== expected.workspaceId) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_WORKSPACE_MISMATCH', claims)
    }
    if (claims.channelGeneration !== expected.channelGeneration) {
      this.#reject('RUNTIME_NODE_CHANNEL_GENERATION_MISMATCH', claims)
    }

    const now = this.#now().getTime()
    if (Date.parse(claims.issuedAt) > now + this.#clockSkewMs) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_NOT_YET_VALID', claims)
    }
    if (Date.parse(claims.expiresAt) < now - this.#clockSkewMs) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_EXPIRED', claims)
    }
    if (this.#usedCredentialIds.has(claims.credentialId)) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_REPLAYED', claims)
    }
    if (await this.#identityValidator.isRevoked(claims.credentialId, claims.revocationVersion)) {
      this.#reject('RUNTIME_NODE_CREDENTIAL_REVOKED', claims)
    }

    const existing = this.#activeChannels.get(claims.nodeId)
    if (existing !== undefined && claims.channelGeneration <= existing.claims.channelGeneration) {
      this.#reject('RUNTIME_NODE_CHANNEL_GENERATION_STALE', claims)
    }

    const channel = new RuntimeNodeChannel(claims, this.#identityValidator, {
      now: this.#now,
      clockSkewMs: this.#clockSkewMs,
    })
    existing?.invalidate('replaced')
    this.#activeChannels.set(claims.nodeId, channel)
    this.#usedCredentialIds.add(claims.credentialId)
    this.#audit('info', 'runtime_node_auth.succeeded', 'RUNTIME_NODE_AUTHENTICATED', claims)
    return channel
  }

  #audit(
    level: 'info' | 'warn',
    event: string,
    code: string,
    claims?: RuntimeNodeCredentialClaims
  ): void {
    this.#logger.write({
      level,
      event,
      details: {
        code,
        ...(claims === undefined
          ? {}
          : {
              channelGeneration: claims.channelGeneration,
              nodeId: claims.nodeId,
              workspaceId: claims.workspaceId,
            }),
      },
    })
  }

  #reject(code: string, claims?: RuntimeNodeCredentialClaims): never {
    this.#audit('warn', 'runtime_node_auth.failed', code, claims)
    throw new RuntimeNodeAuthenticationError(code)
  }
}
