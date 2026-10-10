import { IdentifierSchemas, ServiceCallerAssertionSchema } from '@control-plane/contracts'
import { z } from 'zod'
import type { PiLeadProductAuthorityPort } from '../pi-durable/node-admission.js'
import { ProductionLeadProductEvidenceSchema } from './production-lead-product.js'
import { parseLeadProductFence } from './lead-product-fence.js'

const Selectors = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  intentId: z.uuid(),
  principalId: ServiceCallerAssertionSchema.shape.servicePrincipalId,
})
/** Project the internal versioned port onto the agreed strict three-field wire protocol. */
export function productionProductHttpRequest(
  input: Parameters<PiLeadProductAuthorityPort['readCurrent']>[0]
) {
  return Selectors.parse({
    workspaceId: input.workspaceId,
    intentId: input.intentId,
    principalId: input.principalId,
  })
}

/** Uses an operator-configured existing service credential supplier. Creates no keys, grants or tokens.
 * Adea independently verifies the Ed25519 assertion, current revocation, audience and workspace scope.
 */
export function createProductionProductHttpReader(options: {
  endpoint: string
  credentials: {
    getExistingCredential(
      input: {
        audience: 'adea-lead-product'
        workspaceId: string
        principalId: string
        scope: 'execution:read'
      },
      signal: AbortSignal
    ): Promise<string>
  }
  fetch?: typeof fetch
}) {
  const endpoint = new URL(options.endpoint)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/internal/pi-durable/lead-product/current' ||
    typeof options.credentials?.getExistingCredential !== 'function'
  )
    throw new Error('PI_PRODUCT_READER_CONFIGURATION_REQUIRED')
  const send = options.fetch ?? globalThis.fetch
  return {
    async readCurrent(input: Parameters<PiLeadProductAuthorityPort['readCurrent']>[0]) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5_000)
      const bounded = <T>(promise: Promise<T>) =>
        new Promise<T>((resolve, reject) => {
          const abort = () => reject(new Error('PI_PRODUCT_READER_UNAVAILABLE'))
          promise
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener('abort', abort))
          if (controller.signal.aborted) {
            abort()
            return
          }
          controller.signal.addEventListener('abort', abort, { once: true })
        })
      try {
        const selectors = productionProductHttpRequest(input)
        const credential = await bounded(
          options.credentials.getExistingCredential(
            {
              audience: 'adea-lead-product',
              workspaceId: selectors.workspaceId,
              principalId: selectors.principalId,
              scope: 'execution:read',
            },
            controller.signal
          )
        )
        if (
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential) ||
          credential.length > 131_072
        )
          throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
        const response = await bounded(
          send(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
            body: JSON.stringify(selectors),
            signal: controller.signal,
          })
        )
        if (response.status === 404) {
          if (response.body) await bounded(response.body.cancel())
          return undefined
        }
        if (!response.ok || !response.body) {
          if (response.body) await bounded(response.body.cancel())
          throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const chunk = await bounded(reader.read())
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > 262_144) throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
            chunks.push(chunk.value)
          }
        } finally {
          try {
            await bounded(reader.cancel())
          } finally {
            reader.releaseLock()
          }
        }
        const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const fenced = parseLeadProductFence(parsedBody, selectors, () => Date.now())
        if (fenced) return fenced.facts
        const evidence = ProductionLeadProductEvidenceSchema.parse(parsedBody)
        if (
          evidence.workspaceId !== selectors.workspaceId ||
          evidence.intentId !== selectors.intentId ||
          !evidence.allowedPrincipalIds.includes(selectors.principalId)
        )
          throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
        return evidence
      } catch {
        throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
      } finally {
        clearTimeout(timeout)
        controller.abort()
      }
    },
  }
}
