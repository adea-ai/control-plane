import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  ContractVersionSchema,
  ControlApiFixtures,
  IdentifierSchemas,
  type CorrelationMetadata,
} from '@control-plane/contracts'
import { ControlApiOperations } from './operations.js'

const defaultCredential = 'stub-agent-hq-token'
const fixtureByPath = new Map<string, unknown>([
  [ControlApiOperations.respondToInteraction.path, ControlApiFixtures.interactionResponse.response],
  [ControlApiOperations.verifyAuthentication.path, ControlApiFixtures.authentication.response],
  [ControlApiOperations.resolveProfile.path, ControlApiFixtures.profileResolution.response],
  [
    ControlApiOperations.resolveProjectState.path,
    ControlApiFixtures.projectStateResolution.response,
  ],
  [
    ControlApiOperations.resolveContextPackage.path,
    ControlApiFixtures.contextPackageResolution.response,
  ],
  [ControlApiOperations.listRuntimes.path, ControlApiFixtures.runtimeList.response],
  [ControlApiOperations.acceptExecution.path, ControlApiFixtures.executionAcceptance.response],
  [
    ControlApiOperations.validateExecutionRequest.path,
    ControlApiFixtures.executionValidation.response,
  ],
])
const operationByPath: ReadonlyMap<
  string,
  (typeof ControlApiOperations)[keyof typeof ControlApiOperations]
> = new Map(Object.values(ControlApiOperations).map((operation) => [operation.path, operation]))

export interface ControlPlaneStubRequest {
  readonly method: string
  readonly path: string
  readonly operation: string
  readonly requestId: string
}

export interface ControlPlaneStub {
  readonly url: string
  readonly requests: readonly ControlPlaneStubRequest[]
  close(): Promise<void>
}

export interface ControlPlaneStubOptions {
  readonly credential?: string
}

export async function createControlPlaneStub(
  options: ControlPlaneStubOptions = {}
): Promise<ControlPlaneStub> {
  const requests: ControlPlaneStubRequest[] = []
  const credential = options.credential ?? defaultCredential
  const server = createServer((request, response) => {
    void handleRequest(request, response, credential, requests)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Control Plane stub did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  credential: string,
  requests: ControlPlaneStubRequest[]
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://stub.invalid').pathname
  const operation = operationByPath.get(path)
  if (operation === undefined || request.method !== operation.method) {
    writeJson(response, 404, errorFixture(undefined, 'NOT_FOUND', 'validation', 'Route not found'))
    return
  }
  const body = await readJson(request)
  const context = requestContext(body)
  if (request.headers.authorization !== `Bearer ${credential}`) {
    writeJson(
      response,
      401,
      errorFixture(
        context,
        'SERVICE_CREDENTIAL_REJECTED',
        'authentication',
        'Service credential is not accepted'
      )
    )
    return
  }
  const parsed = operation.requestSchema.safeParse(body)
  if (!parsed.success) {
    writeJson(
      response,
      400,
      errorFixture(context, 'INVALID_REQUEST', 'validation', 'Request does not match the contract')
    )
    return
  }
  const fixture = fixtureByPath.get(path)
  if (fixture === undefined) {
    writeJson(response, 500, errorFixture(context, 'STUB_MISCONFIGURED', 'internal', 'Stub error'))
    return
  }
  requests.push({
    method: request.method,
    path,
    operation: operation.operation,
    requestId: parsed.data.requestId,
  })
  writeJson(response, 200, {
    ...fixture,
    contractVersion: parsed.data.contractVersion,
    requestId: parsed.data.requestId,
    correlation: parsed.data.correlation,
  })
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_048_576) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function requestContext(input: unknown):
  | {
      readonly contractVersion: { readonly major: number; readonly minor: number }
      readonly requestId: string
      readonly correlation: CorrelationMetadata
    }
  | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const contractVersion = ContractVersionSchema.safeParse(Reflect.get(input, 'contractVersion'))
  const requestId = IdentifierSchemas.requestId.safeParse(Reflect.get(input, 'requestId'))
  const correlationInput = Reflect.get(input, 'correlation')
  if (!contractVersion.success || !requestId.success) return undefined
  if (typeof correlationInput !== 'object' || correlationInput === null) return undefined
  const traceId = IdentifierSchemas.traceId.safeParse(Reflect.get(correlationInput, 'traceId'))
  if (!traceId.success) return undefined
  return {
    contractVersion: contractVersion.data,
    requestId: requestId.data,
    correlation: { traceId: traceId.data },
  }
}

function errorFixture(
  context: ReturnType<typeof requestContext>,
  code: string,
  errorClass: 'validation' | 'authentication' | 'internal',
  message: string
) {
  const fallback = ControlApiFixtures.authentication.response
  return {
    contractVersion: context?.contractVersion ?? fallback.contractVersion,
    requestId: context?.requestId ?? fallback.requestId,
    correlation: context?.correlation ?? fallback.correlation,
    error: {
      class: errorClass,
      code,
      message,
      retryable: false,
      source:
        errorClass === 'internal' ? 'system' : errorClass === 'authentication' ? 'auth' : 'client',
    },
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}
