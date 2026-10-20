import type { DatabaseSync } from 'node:sqlite'
import { DelegationEventSchema, type DelegationParentInbox } from '@control-plane/orchestration'
import { ServiceCallerAssertionSchema } from '@control-plane/contracts'
import { SqlitePiDurableLeadReceiptStore } from './pi-durable-lead.service.js'

/** A CP J1 terminal event is a durable wake-up, never Adea publication authority. Adea
 * independently reloads its original actor/audience/fence and CP's current grant before
 * committing the message plus receipt. No acknowledgement deletes the CP inbox event. */
export function createPiChildTimelineDelivery(options: {
  database: DatabaseSync
  parentInbox: Pick<DelegationParentInbox, 'list'>
  principalId: string
  notify(input: { workspaceId: string; intentId: string; principalId: string }): Promise<void>
}) {
  const principalId = ServiceCallerAssertionSchema.shape.servicePrincipalId.parse(
    options.principalId
  )
  const receipts = new SqlitePiDurableLeadReceiptStore(options.database)
  return {
    async reconcile() {
      const events = await options.parentInbox.list()
      if (!Array.isArray(events)) throw new Error('PI_CHILD_TIMELINE_SCAN_LIMIT')
      const parents = new Set<string>()
      for (const candidate of events) {
        const event = DelegationEventSchema.parse(candidate)
        if (
          ['delegation.completed', 'delegation.failed', 'delegation.cancelled'].includes(event.type)
        )
          parents.add(event.parentExecutionId)
      }
      let delivered = 0
      const blocked: string[] = []
      for (const executionId of parents) {
        const receipt = await receipts.findForChildDelivery(executionId)
        if (!receipt || receipt.state !== 'dispatched') continue
        try {
          await options.notify({
            workspaceId: receipt.workspaceId,
            intentId: receipt.intentId,
            principalId,
          })
          delivered++
        } catch {
          // Keep J1 intact for the next interval or the next process. No resend of the child.
          blocked.push(receipt.dispatchId)
        }
      }
      return { delivered, blocked }
    },
  }
}

/** Existing, operator-supplied CP service credential; no key or grant is created here. */
export function createPiChildTimelineHttpNotify(options: {
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
    endpoint.pathname !== '/api/internal/pi-durable/child-receipt/reconcile' ||
    typeof options.credentials?.getExistingCredential !== 'function'
  )
    throw new Error('PI_CHILD_TIMELINE_CONFIGURATION_REQUIRED')
  const send = options.fetch ?? globalThis.fetch
  return async (input: { workspaceId: string; intentId: string; principalId: string }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    const bounded = <T>(promise: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        const abort = () => reject(new Error('PI_CHILD_TIMELINE_UNAVAILABLE'))
        promise
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', abort))
        if (controller.signal.aborted) return abort()
        controller.signal.addEventListener('abort', abort, { once: true })
      })
    try {
      const credential = await bounded(
        options.credentials.getExistingCredential(
          {
            audience: 'adea-lead-product',
            workspaceId: input.workspaceId,
            principalId: input.principalId,
            scope: 'execution:read',
          },
          controller.signal
        )
      )
      if (
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential) ||
        credential.length > 131_072
      )
        throw new Error('PI_CHILD_TIMELINE_UNAVAILABLE')
      const response = await bounded(
        send(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        })
      )
      if (response.body) await bounded(response.body.cancel())
      if (response.status !== 204) throw new Error('PI_CHILD_TIMELINE_UNAVAILABLE')
    } catch {
      throw new Error('PI_CHILD_TIMELINE_UNAVAILABLE')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}
