import {
  type ExecutionCancellationCommand,
  type ExecutionCancellationCommandResult,
  type InteractionResponseCommand,
  type InteractionResponseCommandResult,
  ContractVersionSchema,
  ErrorResponseEnvelopeSchema,
  PublicContractManifest,
  assessContractCompatibility,
  type ContextPackageResolutionRequest,
  type ContextPackageResolutionResponse,
  type ErrorClass,
  type ExecutionAcceptanceRequest,
  type ExecutionAcceptanceResponse,
  type ExecutionRequestValidationRequest,
  type ExecutionRequestValidationResponse,
  type ProfileResolutionRequest,
  type ProfileResolutionResponse,
  type ProjectStateResolutionRequest,
  type ProjectStateResolutionResponse,
  type RuntimeListRequest,
  type RuntimeListResponse,
  type ServiceAuthenticationRequest,
  type ServiceAuthenticationResponse,
  type ExternalSessionGetRequest,
  type ExternalSessionGetResponse,
  type ExternalSessionListRequest,
  type ExternalSessionListResponse,
  type RuntimeConnectionGetRequest,
  type RuntimeConnectionGetResponse,
  type RuntimeConnectionListRequest,
  type RuntimeConnectionListResponse,
  type MarketplaceCatalogRequest,
  type MarketplaceCatalogResponse,
  type MarketplaceInstallPlanRequest,
  type MarketplaceInstallPlanResponse,
  type MarketplaceInstallRequest,
  type MarketplaceInstallResponse,
} from '@control-plane/contracts'
import { ControlApiOperations } from './operations.js'

type FetchImplementation = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>
type CredentialProvider = string | (() => string | Promise<string>)
interface Schema<Input, Output> {
  parse(input: unknown): Output
  safeParse(
    input: unknown
  ): { readonly success: true; readonly data: Output } | { readonly success: false }
  readonly _input?: Input
}

export interface ControlPlaneClientOptions {
  readonly baseUrl: string | URL
  readonly credential: CredentialProvider
  readonly fetch?: FetchImplementation
  readonly timeoutMs?: number
}

export interface ControlPlaneClientErrorInput {
  readonly code: string
  readonly errorClass: ErrorClass
  readonly message: string
  readonly requestId: string
  readonly retryable: boolean
  readonly status?: number
}

export class ControlPlaneClientError extends Error {
  readonly code: string
  readonly errorClass: ErrorClass
  readonly requestId: string
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(input: ControlPlaneClientErrorInput) {
    super(input.message)
    this.name = 'ControlPlaneClientError'
    this.code = input.code
    this.errorClass = input.errorClass
    this.requestId = input.requestId
    this.retryable = input.retryable
    this.status = input.status
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      errorClass: this.errorClass,
      message: this.message,
      requestId: this.requestId,
      retryable: this.retryable,
      status: this.status,
    }
  }
}

export class ControlPlaneClient {
  readonly #baseUrl: URL
  readonly #credential: CredentialProvider
  readonly #fetch: FetchImplementation
  readonly #timeoutMs: number

  constructor(options: ControlPlaneClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#credential = options.credential
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error('Control Plane client timeout must be a positive integer')
    }
  }

  verifyAuthentication(
    input: ServiceAuthenticationRequest
  ): Promise<ServiceAuthenticationResponse> {
    return this.#request(ControlApiOperations.verifyAuthentication, input)
  }

  resolveProfile(input: ProfileResolutionRequest): Promise<ProfileResolutionResponse> {
    return this.#request(ControlApiOperations.resolveProfile, input)
  }

  resolveProjectState(
    input: ProjectStateResolutionRequest
  ): Promise<ProjectStateResolutionResponse> {
    return this.#request(ControlApiOperations.resolveProjectState, input)
  }

  resolveContextPackage(
    input: ContextPackageResolutionRequest
  ): Promise<ContextPackageResolutionResponse> {
    return this.#request(ControlApiOperations.resolveContextPackage, input)
  }

  listRuntimes(input: RuntimeListRequest): Promise<RuntimeListResponse> {
    return this.#request(ControlApiOperations.listRuntimes, input)
  }

  listRuntimeConnections(
    input: RuntimeConnectionListRequest
  ): Promise<RuntimeConnectionListResponse> {
    return this.#request(ControlApiOperations.listRuntimeConnections, input)
  }

  getRuntimeConnection(input: RuntimeConnectionGetRequest): Promise<RuntimeConnectionGetResponse> {
    return this.#request(ControlApiOperations.getRuntimeConnection, input)
  }

  listExternalSessions(input: ExternalSessionListRequest): Promise<ExternalSessionListResponse> {
    return this.#request(ControlApiOperations.listExternalSessions, input)
  }

  getExternalSession(input: ExternalSessionGetRequest): Promise<ExternalSessionGetResponse> {
    return this.#request(ControlApiOperations.getExternalSession, input)
  }

  validateExecutionRequest(
    input: ExecutionRequestValidationRequest
  ): Promise<ExecutionRequestValidationResponse> {
    return this.#request(ControlApiOperations.validateExecutionRequest, input)
  }

  acceptExecution(input: ExecutionAcceptanceRequest): Promise<ExecutionAcceptanceResponse> {
    return this.#request(ControlApiOperations.acceptExecution, input)
  }

  respondToInteraction(
    input: InteractionResponseCommand
  ): Promise<InteractionResponseCommandResult> {
    return this.#request(ControlApiOperations.respondToInteraction, input)
  }

  cancelExecution(
    input: ExecutionCancellationCommand
  ): Promise<ExecutionCancellationCommandResult> {
    return this.#request(ControlApiOperations.cancelExecution, input)
  }

  marketplaceCatalog(input: MarketplaceCatalogRequest): Promise<MarketplaceCatalogResponse> {
    return this.#request(ControlApiOperations.marketplaceCatalog, input)
  }

  marketplaceInstall(input: MarketplaceInstallRequest): Promise<MarketplaceInstallResponse> {
    return this.#request(ControlApiOperations.marketplaceInstall, input)
  }

  marketplaceInstallPlan(
    input: MarketplaceInstallPlanRequest
  ): Promise<MarketplaceInstallPlanResponse> {
    return this.#request(ControlApiOperations.marketplaceInstallPlan, input)
  }

  async #request<RequestInput, RequestOutput, ResponseOutput>(
    operation: {
      readonly method: 'POST'
      readonly path: string
      readonly requestSchema: Schema<RequestInput, RequestOutput>
      readonly responseSchema: Schema<unknown, ResponseOutput>
    },
    input: RequestInput
  ): Promise<ResponseOutput> {
    const request = operation.requestSchema.parse(input) as RequestOutput & {
      readonly requestId: string
      readonly correlation: { readonly traceId: string }
    }
    const credential = await resolveCredential(this.#credential)
    const response = await this.#fetch(new URL(operation.path.slice(1), this.#baseUrl), {
      method: operation.method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        'x-correlation-id': request.correlation.traceId,
        'x-request-id': request.requestId,
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    const body = await parseResponseBody(response, request.requestId)

    if (!response.ok) {
      const parsedError = ErrorResponseEnvelopeSchema.safeParse(body)
      if (!parsedError.success) {
        throw invalidResponse(request.requestId, response.status)
      }
      assertCompatibleVersion(parsedError.data.contractVersion, request.requestId, response.status)
      throw new ControlPlaneClientError({
        code: parsedError.data.error.code,
        errorClass: parsedError.data.error.class,
        message: parsedError.data.error.message,
        requestId: parsedError.data.requestId,
        retryable: parsedError.data.error.retryable,
        status: response.status,
      })
    }

    const version = ContractVersionSchema.safeParse(versionFrom(body))
    if (!version.success) throw invalidResponse(request.requestId, response.status)
    assertCompatibleVersion(version.data, request.requestId, response.status)
    const parsedResponse = operation.responseSchema.safeParse(body)
    if (!parsedResponse.success) throw invalidResponse(request.requestId, response.status)
    return parsedResponse.data
  }
}

function normalizeBaseUrl(input: string | URL): URL {
  const url = new URL(input)
  const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) {
    throw new Error('Control Plane base URL must use HTTPS except for loopback test servers')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  url.search = ''
  url.hash = ''
  return url
}

async function resolveCredential(provider: CredentialProvider): Promise<string> {
  const credential = typeof provider === 'function' ? await provider() : provider
  if (credential.trim().length === 0)
    throw new Error('Control Plane service credential is required')
  return credential
}

async function parseResponseBody(response: Response, requestId: string): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw invalidResponse(requestId, response.status)
  }
}

function versionFrom(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  return Reflect.get(body, 'contractVersion')
}

function assertCompatibleVersion(version: unknown, requestId: string, status: number): void {
  const producer = ContractVersionSchema.safeParse(version)
  if (
    !producer.success ||
    !assessContractCompatibility({
      consumer: PublicContractManifest.current,
      producer: producer.data,
    }).compatible
  ) {
    throw new ControlPlaneClientError({
      code: 'INCOMPATIBLE_CONTRACT_VERSION',
      errorClass: 'validation',
      message: 'Control Plane contract version is incompatible with this SDK',
      requestId,
      retryable: false,
      status,
    })
  }
}

function invalidResponse(requestId: string, status: number): ControlPlaneClientError {
  return new ControlPlaneClientError({
    code: 'INVALID_CONTROL_PLANE_RESPONSE',
    errorClass: 'internal',
    message: 'Control Plane returned an invalid response',
    requestId,
    retryable: false,
    status,
  })
}
