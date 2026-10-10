import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  RuntimeNodeCredentialRevocationResponseSchema,
  RuntimeNodeCredentialRevokeRequestSchema,
  type RuntimeNodeCredentialRevocationResponse,
} from '@control-plane/contracts'
import { RuntimeNodeIdentityRepositoryError } from '@control-plane/database'

export const RUNTIME_NODE_CREDENTIAL_REVOCATION_SERVICE = Symbol(
  'RUNTIME_NODE_CREDENTIAL_REVOCATION_SERVICE'
)

/**
 * Hosted RuntimeNode credential revocation. Every method receives the raw envelope and the
 * authenticated principal; the HTTP guard has already matched route scope and workspace.
 */
export interface RuntimeNodeCredentialRevocationService {
  revoke(input: unknown, principalId: string): Promise<RuntimeNodeCredentialRevocationResponse>
}

/**
 * The durable identity operation this control uses. `PostgresRuntimeNodeIdentityRepository`
 * satisfies it structurally. The migration-owned revocation function binds the credential to the
 * envelope workspace and records the audited outcome, so the control needs no separate pre-read.
 */
export interface RuntimeNodeCredentialRevocationRepository {
  revokeCredential(
    credentialId: string,
    now: Date,
    actor: { readonly workspaceId: string; readonly principalRef: string }
  ): Promise<{
    readonly credentialId: string
    readonly nodeId: string
    readonly workspaceId: string
    readonly revocationVersion: number
    readonly revokedAt: string | null
  }>
}

/** Explicit refusal for profiles that do not compose the hosted identity repository. */
export class UnavailableRuntimeNodeCredentialRevocationService implements RuntimeNodeCredentialRevocationService {
  async revoke(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'RUNTIME_NODE_CREDENTIAL_REVOCATION_NOT_CONFIGURED',
      message: 'Runtime-node credential revocation is not composed in this profile',
    })
  }
}

export class RepositoryRuntimeNodeCredentialRevocationService implements RuntimeNodeCredentialRevocationService {
  readonly #repository: RuntimeNodeCredentialRevocationRepository
  readonly #now: () => Date

  constructor(options: {
    readonly repository: RuntimeNodeCredentialRevocationRepository
    readonly now?: () => Date
  }) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
  }

  async revoke(
    input: unknown,
    principalId: string
  ): Promise<RuntimeNodeCredentialRevocationResponse> {
    const request = parseRequest(RuntimeNodeCredentialRevokeRequestSchema, input)
    assertCaller(request, principalId)
    const { credentialId } = request.payload

    // Revocation is idempotent: a repeated request returns the first revocation without bumping
    // the version or notifying the gateway again. A credential bound to another workspace is
    // refused by the function and reported exactly like an unknown one.
    const revoked = await repositoryCall(() =>
      this.#repository.revokeCredential(credentialId, this.#now(), {
        workspaceId: request.workspaceId,
        principalRef: principalId,
      })
    )
    if (revoked.workspaceId !== request.workspaceId || revoked.revokedAt === null) {
      throw unavailable('RUNTIME_NODE_CREDENTIAL_REVOCATION_UNAVAILABLE')
    }
    return RuntimeNodeCredentialRevocationResponseSchema.parse({
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      correlation: request.correlation,
      data: {
        credential: {
          credentialId: revoked.credentialId,
          nodeId: revoked.nodeId,
          workspaceId: revoked.workspaceId,
          revocationVersion: revoked.revocationVersion,
          revokedAt: revoked.revokedAt,
        },
      },
    })
  }
}

async function repositoryCall<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityRepositoryError) {
      if (error.code === 'RUNTIME_NODE_IDENTITY_CREDENTIAL_NOT_FOUND') throw notFound()
      if (error.code === 'RUNTIME_NODE_IDENTITY_VERSION_EXHAUSTED') {
        throw new ConflictException({
          code: 'RUNTIME_NODE_CREDENTIAL_REVOCATION_CONFLICT',
          message: 'Runtime-node credential revocation version cannot advance',
        })
      }
    }
    // The application role holds no UPDATE on the revocation columns (migration 0054), so a
    // deployed revocation is refused by the database. That is an explicit, fail-closed state.
    if (databaseErrorCode(error) === '42501') {
      throw unavailable('RUNTIME_NODE_CREDENTIAL_REVOCATION_NOT_PERMITTED')
    }
    throw unavailable('RUNTIME_NODE_CREDENTIAL_REVOCATION_UNAVAILABLE')
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = Reflect.get(current, 'code')
    if (typeof code === 'string') return code
    current = Reflect.get(current, 'cause')
  }
  return undefined
}

function notFound(): never {
  throw new NotFoundException({
    code: 'RUNTIME_NODE_CREDENTIAL_NOT_FOUND',
    message: 'Runtime-node credential was not found',
  })
}

function unavailable(code: string): never {
  throw new ServiceUnavailableException({
    code,
    message: 'Runtime-node credential revocation is unavailable',
  })
}

function parseRequest<Output>(
  schema: { safeParse(input: unknown): { success: true; data: Output } | { success: false } },
  input: unknown
): Output {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
  })
}

function assertCaller(request: { caller: { servicePrincipalId: string } }, principalId: string) {
  if (!principalId || request.caller.servicePrincipalId !== principalId) {
    throw new ForbiddenException({
      code: 'RUNTIME_NODE_CREDENTIAL_CALLER_MISMATCH',
      message: 'Runtime-node credential caller is not authorized',
    })
  }
}
