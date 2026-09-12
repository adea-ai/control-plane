import { z } from 'zod'
import { ContextCommandRecordSchema, type ContextCommandRecord } from '@control-plane/domain'
import {
  CortanaHttpClient,
  validateCortanaContextBundle,
  type CortanaHttpClientOptions,
  type CortanaBundleValidationOptions,
} from '@control-plane/cortana-context-adapter'
import type { ContextNodeProviderDriver } from './context-node-handler.js'

const Parameters = z
  .object({
    mappedProjectRef: z.string().min(1).max(1024),
    operationId: z.string().min(16).max(128),
    principalRef: z.string().min(1).max(256),
    scopeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    objective: z.string().min(1).max(16384),
    capability: z.enum(['boundedRetrieval', 'evidenceSearch', 'memoryRecall']),
    maximumTokens: z.number().int().nonnegative(),
    maximumAgeSeconds: z.number().int().nonnegative(),
    includeEvidence: z.boolean(),
    includeMemory: z.boolean(),
  })
  .strict()

export interface ContextHttpDriverOptions {
  readonly workspaceId: string
  readonly nodeId: string
  readonly providerRef: string
  readonly mappedProjectRef: string
  readonly http: CortanaHttpClientOptions
  readonly validation?: CortanaBundleValidationOptions
}

/** One provider/project binding. Endpoints and credentials never come from command payloads. */
export class ContextHttpProviderDriver implements ContextNodeProviderDriver {
  readonly #options: ContextHttpDriverOptions
  readonly #client: CortanaHttpClient
  constructor(options: ContextHttpDriverOptions) {
    this.#options = structuredClone(options)
    this.#client = new CortanaHttpClient({
      ...options.http,
      maximumResponseBytes: Math.min(options.http.maximumResponseBytes ?? 262144, 262144),
    })
  }

  async execute(input: ContextCommandRecord, signal: AbortSignal) {
    const { command, parameters } = this.#bound(input)
    signal.throwIfAborted()
    const raw = await this.#client.read(
      {
        objective: parameters.objective,
        operationId: parameters.operationId,
        transport: 'http',
        mappedProjectRef: this.#options.mappedProjectRef,
        scopeDigest: parameters.scopeDigest,
        principalRef: parameters.principalRef,
        maximumTokens: parameters.maximumTokens,
        deadline: new Date(
          Math.min(Date.parse(command.expiresAt), Date.now() + 300000)
        ).toISOString(),
        includeEvidence: parameters.includeEvidence,
        includeMemory: parameters.includeMemory,
      },
      signal
    )
    signal.throwIfAborted()
    const bundle = validateCortanaContextBundle(
      raw,
      { scopeDigest: parameters.scopeDigest, policy: parameters },
      {
        ...this.#options.validation,
        maximumOutputBytes: Math.min(
          this.#options.validation?.maximumOutputBytes ?? 262144,
          262144
        ),
      }
    )
    const age = Date.now() - Date.parse(bundle.createdAt)
    if (age < 0 || age > parameters.maximumAgeSeconds * 1000)
      throw new Error('CONTEXT_HTTP_BUNDLE_STALE')
    return { status: 'succeeded', result: bundle }
  }

  async reconcile(input: ContextCommandRecord, signal: AbortSignal) {
    this.#bound(input)
    signal.throwIfAborted()
    // The HTTP read contract has no operation-status endpoint. Never POST another read to infer its outcome.
    return { status: 'unknown' }
  }

  #bound(input: ContextCommandRecord) {
    const command = ContextCommandRecordSchema.parse(input)
    const parameters = Parameters.parse(
      (command.commandEnvelope['payload'] as { parameters: unknown }).parameters
    )
    if (
      command.scope.workspaceId !== this.#options.workspaceId ||
      command.nodeId !== this.#options.nodeId ||
      command.scope.providerRef !== this.#options.providerRef ||
      parameters.mappedProjectRef !== this.#options.mappedProjectRef
    )
      throw new Error('CONTEXT_HTTP_BINDING_MISMATCH')
    return { command, parameters }
  }
}
