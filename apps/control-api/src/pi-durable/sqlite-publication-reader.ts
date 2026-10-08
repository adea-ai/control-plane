import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { canonicalJsonStringify, ModelSelectionFundingViewSchema } from '@control-plane/contracts'
import {
  RuntimeStartRequestSchema,
  RuntimeExecutionHandleSchema,
  type RuntimeAdapter,
} from '@control-plane/runtime-sdk'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { SqlitePiDurableLeadIntentStore } from './node-admission.js'
import { SqlitePiDurableLeadReceiptStore } from './pi-durable-lead.service.js'
import type { PiLeadPublicationPorts } from './publication-current.service.js'

const Preparation = z.object({
  preparationRef: z.string(),
  principalId: z.string(),
  state: z.literal('dispatched'),
  admission: z.object({
    workspaceId: z.string(),
    intentId: z.uuid(),
    admissionDigest: z.string(),
    startRequest: RuntimeStartRequestSchema,
  }),
  runtimeHandle: RuntimeExecutionHandleSchema,
  funding: ModelSelectionFundingViewSchema,
})
/** Reads the SAME durable Node preparation/receipt/marker/journal. No product callback or runtime start. */
export function createSqlitePiLeadPublicationReader(options: {
  database: DatabaseSync
  adapter: Pick<RuntimeAdapter, 'status'> & {
    findExistingHandle(
      request: z.output<typeof RuntimeStartRequestSchema>
    ): Promise<z.output<typeof RuntimeExecutionHandleSchema> | undefined>
  }
}): PiLeadPublicationPorts['readRetained'] {
  const receipts = new SqlitePiDurableLeadReceiptStore(options.database)
  const intents = new SqlitePiDurableLeadIntentStore(options.database)
  return async (input) => {
    const receipt = await receipts.get(input.dispatchId)
    const row = options.database
      .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
      .get(input.preparationRef)
    if (
      !receipt ||
      !row ||
      receipt.state !== 'dispatched' ||
      receipt.workspaceId !== input.workspaceId
    )
      return undefined
    const preparation = Preparation.parse(JSON.parse(String(row['record'])))
    const admission = preparation.admission
    const marker = intents.marker(receipt.intentId)
    const request = admission.startRequest
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    const funding = preparation.funding
    const startDigest = `sha256:${createHash('sha256').update(canonicalJsonStringify(request)).digest('hex')}`
    if (
      !marker ||
      marker.state !== 'ready' ||
      !marker.intent.canonicalActorPrincipalId ||
      admission.intentId !== receipt.intentId ||
      admission.workspaceId !== input.workspaceId ||
      preparation.preparationRef !== input.preparationRef ||
      receipt.admissionDigest !== admission.admissionDigest ||
      receipt.startDigest !== startDigest ||
      plan.executionPlanId !== marker.planPin.executionPlanId ||
      plan.contentDigest !== marker.planPin.contentDigest ||
      request.executionId !== receipt.executionId ||
      request.attemptId !== receipt.attemptId ||
      marker.intent.executionId !== receipt.executionId ||
      marker.intent.attemptId !== receipt.attemptId ||
      funding.state !== 'ready' ||
      funding.workspaceId !== input.workspaceId ||
      funding.executionId !== receipt.executionId ||
      funding.attemptId !== receipt.attemptId ||
      funding.selectionRef !== marker.intent.selectionRef ||
      funding.selectionRevision !== marker.intent.selectionRevision
    )
      return undefined
    const handle = await options.adapter.findExistingHandle(request)
    if (
      !handle ||
      !receipt.handle ||
      !handle.externalSessionId ||
      canonicalJsonStringify(handle) !== canonicalJsonStringify(receipt.handle) ||
      canonicalJsonStringify(handle) !== canonicalJsonStringify(preparation.runtimeHandle)
    )
      return undefined
    return {
      binding: {
        schemaVersion: 'pi-lead-publication/v1',
        workspaceId: receipt.workspaceId,
        intentId: receipt.intentId,
        dispatchId: receipt.dispatchId,
        preparationRef: input.preparationRef,
        executionId: receipt.executionId,
        attemptId: receipt.attemptId,
        runtimeSessionId: handle.externalSessionId,
        selectionRef: funding.selectionRef,
        selectionRevision: funding.selectionRevision,
        canonicalActorPrincipalId: marker.intent.canonicalActorPrincipalId,
      },
      status: await options.adapter.status(handle),
    }
  }
}
