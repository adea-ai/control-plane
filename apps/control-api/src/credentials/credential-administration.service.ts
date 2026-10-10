import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  CredentialCreateRequestSchema,
  CredentialGetRequestSchema,
  CredentialListRequestSchema,
  CredentialListResponseSchema,
  CredentialResponseSchema,
  CredentialRevokeRequestSchema,
  CredentialRotateRequestSchema,
  canonicalJsonStringify,
  decodeCursor,
  encodeCursor,
  type CredentialListResponse,
  type CredentialResponse,
} from '@control-plane/contracts'
import {
  CredentialVault,
  CredentialVaultError,
  NeonEncryptedSecretProvider,
  createCredentialId,
  type CredentialCommandScope,
  type CredentialMetadata,
  type CredentialVaultRepository,
  type EncryptedSecretStore,
} from '@control-plane/credential-vault'

export const CREDENTIAL_ADMINISTRATION_SERVICE = Symbol('CREDENTIAL_ADMINISTRATION_SERVICE')

/**
 * Workspace credential administration. Every method receives the raw envelope and the
 * authenticated principal; the HTTP guard has already matched route scope, caller and workspace.
 */
export interface CredentialAdministrationService {
  create(input: unknown, principalId: string): Promise<CredentialResponse>
  rotate(input: unknown, principalId: string): Promise<CredentialResponse>
  revoke(input: unknown, principalId: string): Promise<CredentialResponse>
  get(input: unknown, principalId: string): Promise<CredentialResponse>
  list(input: unknown, principalId: string): Promise<CredentialListResponse>
}

export class UnavailableCredentialAdministrationService implements CredentialAdministrationService {
  async create(): Promise<never> {
    return unavailable()
  }
  async rotate(): Promise<never> {
    return unavailable()
  }
  async revoke(): Promise<never> {
    return unavailable()
  }
  async get(): Promise<never> {
    return unavailable()
  }
  async list(): Promise<never> {
    return unavailable()
  }
}

/**
 * Accepts a secret once per create or rotate, hands it to the vault and returns metadata only.
 * Secrets never enter idempotency hashes, receipts, responses, errors or logs.
 */
export class VaultCredentialAdministrationService implements CredentialAdministrationService {
  readonly #vault: CredentialVault
  readonly #receipts: Pick<CredentialVaultRepository, 'getCommandReceipt'>
  readonly #now: () => Date
  readonly #credentialIds: () => string

  constructor(options: {
    readonly vault: CredentialVault
    readonly receipts: Pick<CredentialVaultRepository, 'getCommandReceipt'>
    readonly now?: () => Date
    readonly credentialIds?: () => string
  }) {
    this.#vault = options.vault
    this.#receipts = options.receipts
    this.#now = options.now ?? (() => new Date())
    this.#credentialIds = options.credentialIds ?? createCredentialId
  }

  async create(input: unknown, principalId: string): Promise<CredentialResponse> {
    const request = parseRequest(CredentialCreateRequestSchema, input)
    assertCaller(request, principalId)
    const expiresAt =
      request.payload.expiresAt === undefined
        ? undefined
        : new Date(request.payload.expiresAt).toISOString()
    const scope = commandScope(request, principalId, 'create')
    const payloadHash = commandHash(scope, {
      connectorRef: request.payload.connectorRef,
      provider: request.payload.provider,
      expiresAt: expiresAt ?? null,
    })
    const replayed = await this.#replay(scope, payloadHash)
    if (replayed !== undefined) return credentialResponse(request, replayed)
    try {
      const credential = await this.#vault.create({
        credentialId: this.#credentialIds(),
        workspaceId: request.workspaceId,
        connectorRef: request.payload.connectorRef,
        provider: request.payload.provider,
        secret: request.payload.secret,
        createdAt: this.#now().toISOString(),
        createdBy: principalId,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        command: { receipt: { ...scope, payloadHash } },
      })
      return credentialResponse(request, credential)
    } catch (error) {
      if (error instanceof CredentialVaultError && error.code === 'CREDENTIAL_COMMAND_REPLAYED') {
        const winner = await this.#replay(scope, payloadHash)
        if (winner !== undefined) return credentialResponse(request, winner)
      }
      throw publicError(error)
    }
  }

  async rotate(input: unknown, principalId: string): Promise<CredentialResponse> {
    const request = parseRequest(CredentialRotateRequestSchema, input)
    assertCaller(request, principalId)
    const scope = commandScope(request, principalId, 'rotate')
    const payloadHash = commandHash(scope, {
      credentialId: request.payload.credentialId,
      expectedRevision: request.payload.expectedRevision,
    })
    const replayed = await this.#replay(scope, payloadHash)
    if (replayed !== undefined) return credentialResponse(request, replayed)
    try {
      const credential = await this.#vault.rotate(
        request.payload.credentialId,
        request.payload.secret,
        principalId,
        {
          workspaceId: request.workspaceId,
          expectedRevision: request.payload.expectedRevision,
          command: { receipt: { ...scope, payloadHash } },
        }
      )
      return credentialResponse(request, credential)
    } catch (error) {
      if (error instanceof CredentialVaultError && error.code === 'CREDENTIAL_COMMAND_REPLAYED') {
        const winner = await this.#replay(scope, payloadHash)
        if (winner !== undefined) return credentialResponse(request, winner)
      }
      throw publicError(error)
    }
  }

  async revoke(input: unknown, principalId: string): Promise<CredentialResponse> {
    const request = parseRequest(CredentialRevokeRequestSchema, input)
    assertCaller(request, principalId)
    try {
      // Revocation is naturally idempotent: a repeated request returns the revoked metadata.
      const credential = await this.#vault.revoke(request.payload.credentialId, principalId, {
        workspaceId: request.workspaceId,
      })
      return credentialResponse(request, credential)
    } catch (error) {
      throw publicError(error)
    }
  }

  async get(input: unknown, principalId: string): Promise<CredentialResponse> {
    const request = parseRequest(CredentialGetRequestSchema, input)
    assertCaller(request, principalId)
    try {
      return credentialResponse(
        request,
        await this.#vault.metadata(request.parameters.credentialId, request.workspaceId)
      )
    } catch (error) {
      throw publicError(error)
    }
  }

  async list(input: unknown, principalId: string): Promise<CredentialListResponse> {
    const request = parseRequest(CredentialListRequestSchema, input)
    assertCaller(request, principalId)
    let afterCredentialId: string | undefined
    if (request.parameters.cursor !== undefined) {
      try {
        const position = decodeCursor(request.parameters.cursor)
        if (position.sortKey !== position.id || !/^crd_[0-9A-HJKMNP-TV-Z]{26}$/.test(position.id)) {
          throw new Error('INVALID_CURSOR')
        }
        afterCredentialId = position.id
      } catch {
        throw new BadRequestException({
          code: 'CREDENTIAL_CURSOR_INVALID',
          message: 'Credential list cursor is invalid',
        })
      }
    }
    try {
      const page = await this.#vault.list(request.workspaceId, {
        limit: request.parameters.limit ?? 50,
        ...(afterCredentialId === undefined ? {} : { afterCredentialId }),
      })
      return CredentialListResponseSchema.parse({
        contractVersion: request.contractVersion,
        requestId: request.requestId,
        correlation: request.correlation,
        data: {
          credentials: page.credentials,
          ...(page.nextCredentialId === undefined
            ? {}
            : {
                nextCursor: encodeCursor({
                  sortKey: page.nextCredentialId,
                  id: page.nextCredentialId,
                }),
              }),
        },
      })
    } catch (error) {
      throw publicError(error)
    }
  }

  async #replay(
    scope: CredentialCommandScope,
    payloadHash: string
  ): Promise<CredentialMetadata | undefined> {
    const receipt = await this.#receipts.getCommandReceipt(scope)
    if (receipt === undefined) return undefined
    if (receipt.payloadHash !== payloadHash) {
      throw new ConflictException({
        code: 'CREDENTIAL_COMMAND_CONFLICT',
        message: 'Idempotency key was already used for a different credential command',
      })
    }
    return receipt.result
  }
}

/**
 * Parses an envelope without letting a raw validation error (which could reference input)
 * reach telemetry or the exception filter. Details carry issue codes and field paths only.
 */
function parseRequest<Output>(
  schema: {
    safeParse(input: unknown):
      | { readonly success: true; readonly data: Output }
      | {
          readonly success: false
          readonly error: {
            readonly issues: readonly {
              readonly code: string
              readonly path: readonly PropertyKey[]
            }[]
          }
        }
  },
  input: unknown
): Output {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    details: parsed.error.issues.map((issue) => ({
      codes: [issue.code],
      field: issue.path.map(String).join('.'),
    })),
  })
}

function assertCaller(request: { caller: { servicePrincipalId: string } }, principalId: string) {
  if (!principalId || request.caller.servicePrincipalId !== principalId) {
    throw new ForbiddenException({
      code: 'CREDENTIAL_CALLER_MISMATCH',
      message: 'Credential caller is not authorized',
    })
  }
}

function commandScope(
  request: { readonly workspaceId: string; readonly idempotencyKey: string },
  principalId: string,
  operation: 'create' | 'rotate'
): CredentialCommandScope {
  return {
    workspaceId: request.workspaceId,
    callerId: principalId,
    operation,
    idempotencyKey: request.idempotencyKey,
  }
}

/** Server-computed idempotency hash over non-secret fields only. */
function commandHash(scope: CredentialCommandScope, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJsonStringify([scope.workspaceId, scope.callerId, scope.operation, payload]))
    .digest('hex')
}

function credentialResponse(
  request: {
    readonly contractVersion: { readonly major: number; readonly minor: number }
    readonly requestId: string
    readonly correlation: unknown
  },
  credential: CredentialMetadata
): CredentialResponse {
  return CredentialResponseSchema.parse({
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    correlation: request.correlation,
    data: { credential },
  })
}

function publicError(error: unknown): unknown {
  if (!(error instanceof CredentialVaultError)) {
    if (error instanceof RangeError) {
      return new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
      })
    }
    return error
  }
  switch (error.code) {
    case 'CREDENTIAL_MISSING':
      return new NotFoundException({
        code: 'CREDENTIAL_NOT_FOUND',
        message: 'Credential was not found',
      })
    case 'CREDENTIAL_SECRET_INVALID':
      return new BadRequestException({
        code: 'CREDENTIAL_SECRET_INVALID',
        message: 'Credential secret is invalid',
      })
    case 'PROVIDER_OPERATION_FAILED':
      return new ServiceUnavailableException({
        code: 'CREDENTIAL_PROVIDER_UNAVAILABLE',
        message: 'Credential secret provider is unavailable',
      })
    case 'CREDENTIAL_EXISTS':
    case 'CREDENTIAL_CONNECTOR_IN_USE':
    case 'CREDENTIAL_REVISION_CONFLICT':
    case 'CREDENTIAL_REVOKED':
    case 'CREDENTIAL_EXPIRED':
    case 'CREDENTIAL_COMMAND_REPLAYED':
      return new ConflictException({
        code: error.code,
        message: 'Credential command conflicts with current state',
      })
    default:
      return new ConflictException({
        code: 'CREDENTIAL_COMMAND_REJECTED',
        message: 'Credential command was rejected',
      })
  }
}

function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'CREDENTIAL_VAULT_NOT_CONFIGURED',
    message: 'Credential vault is not configured',
  })
}

export interface CredentialAdministrationComposition {
  /** Durable metadata, lease, audit and receipt repository (for example SQLite or Postgres). */
  readonly repository: CredentialVaultRepository
  /** Durable ciphertext store; it only ever sees ciphertext and key references. */
  readonly secretStore: EncryptedSecretStore
  /** Operator-configured AES-256-GCM key. This factory never generates or stores one. */
  readonly encryptionKey: string
  readonly keyReference: string
  readonly secretPrefix: string
}

/**
 * Composes the existing vault-backed credential administration over a caller-supplied durable
 * repository and secret store. An invalid key fails closed at construction, before any request
 * is served. Nothing is generated, provisioned, or replaced by a default key.
 */
export function createCredentialAdministrationService(
  options: CredentialAdministrationComposition
): VaultCredentialAdministrationService {
  let provider: NeonEncryptedSecretProvider
  try {
    provider = new NeonEncryptedSecretProvider({
      store: options.secretStore,
      encryptionKey: options.encryptionKey,
      keyReference: options.keyReference,
      secretPrefix: options.secretPrefix,
    })
  } catch {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY_INVALID')
  }
  return new VaultCredentialAdministrationService({
    vault: new CredentialVault({ provider, repository: options.repository }),
    receipts: options.repository,
  })
}
