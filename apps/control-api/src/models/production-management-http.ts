import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import { managementCanonicalRequestDigest } from '../pi-durable/management-decision-issuer.js'

/**
 * Production CP-to-Adea management transport (#932). The host supplies the
 * existing Adea origin; this client creates no credentials, keys or defaults.
 * The signed `adea-management-authority/v1` decision is the only credential on
 * the call; the body binds the same opaque canonical request the decision's
 * `canonicalRequestDigest` covers, so Adea never constructs or interprets it.
 */

const callSchema = z.strictObject({
  canonicalRequest: z.unknown(),
  decision: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  input: z.record(z.string(), z.unknown()),
  operation: z.string().min(1).max(128),
  targetId: z.string().min(1).max(128).nullable(),
  workspaceId: IdentifierSchemas.workspaceId,
})

const successSchema = z.strictObject({
  operation: z.string().min(1).max(128),
  schemaVersion: z.literal('adea-management-result/v1'),
  value: z.unknown(),
})

const refusalSchema = z.strictObject({
  code: z.literal('LEAD_MANAGEMENT_REFUSED'),
  operation: z.string().min(1).max(128),
  reason: z.string().min(1).max(64).optional(),
})

export class PiDurableManagementTransportError extends Error {
  constructor() {
    super('PI_MANAGEMENT_CALL_UNAVAILABLE')
    this.name = 'PiDurableManagementTransportError'
  }
}

export interface ProductionManagementHttpCall {
  readonly canonicalRequest: unknown
  readonly decision: string
  readonly input: Record<string, unknown>
  readonly operation: string
  readonly targetId: string | null
  readonly workspaceId: string
}

export type ProductionManagementHttpResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{
      ok: false
      code: 'LEAD_MANAGEMENT_REFUSED'
      operation: string
      reason?: string
    }>

const maximumResponseBytes = 262_144

export function createProductionManagementHttpClient(options: {
  endpoint: string
  fetch?: typeof fetch
  timeoutMs?: number
}) {
  const endpoint = new URL(options.endpoint)
  const timeoutMs = options.timeoutMs ?? 5_000
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/internal/pi-durable/management' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30_000
  )
    throw new PiDurableManagementTransportError()
  const send = options.fetch ?? globalThis.fetch

  return {
    async call(input: ProductionManagementHttpCall): Promise<ProductionManagementHttpResult> {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const parsed = callSchema.parse(input)
        if (
          !managementCanonicalRequestDigest(parsed.canonicalRequest) ||
          !managementCanonicalRequestDigest(parsed.input)
        )
          throw new PiDurableManagementTransportError()
        if (parsed.decision.length > 8_192) throw new PiDurableManagementTransportError()
        const controller = new AbortController()
        timeout = setTimeout(() => controller.abort(), timeoutMs)
        const response = await send(endpoint, {
          body: JSON.stringify({
            canonicalRequest: parsed.canonicalRequest,
            input: parsed.input,
            operation: parsed.operation,
            schemaVersion: 'adea-management-call/v1',
            targetId: parsed.targetId,
            workspaceId: parsed.workspaceId,
          }),
          headers: {
            authorization: `Bearer ${parsed.decision}`,
            'content-type': 'application/json',
          },
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
        })
        if (response.status === 200) {
          const body = await readBounded(response)
          const value = successSchema.parse(body)
          if (value.operation !== parsed.operation) throw new PiDurableManagementTransportError()
          return Object.freeze({ ok: true as const, value: value.value })
        }
        if (
          response.status === 403 ||
          response.status === 409 ||
          response.status === 501 ||
          response.status === 503
        ) {
          const body = await readBounded(response)
          const value = refusalSchema.parse(body)
          if (value.operation !== parsed.operation) throw new PiDurableManagementTransportError()
          return Object.freeze({
            code: value.code,
            ok: false as const,
            operation: value.operation,
            ...(value.reason === undefined ? {} : { reason: value.reason }),
          })
        }
        if (response.body) await response.body.cancel().catch(() => undefined)
        throw new PiDurableManagementTransportError()
      } catch (error) {
        if (error instanceof PiDurableManagementTransportError) throw error
        throw new PiDurableManagementTransportError()
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new PiDurableManagementTransportError()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximumResponseBytes) throw new PiDurableManagementTransportError()
      chunks.push(chunk.value)
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'))
  } catch {
    throw new PiDurableManagementTransportError()
  }
}
