import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ModelSelectionReferenceSchema,
} from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { RuntimeStartRequestSchema, type RuntimeStartRequest } from '@control-plane/runtime-sdk'
import {
  PiDurableAdmissionSchema,
  type DurableExecutionAuthority,
  type PiDurableAdmission,
} from '@control-plane/pi-durable-adapter'
import type { RuntimeProviderSelection } from '@control-plane/model-gateway'
import type { createProductionLeadProductAuthority } from './production-lead-product.js'

export const ProductionChildModelRequestSchema = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  parentIntentId: z.uuid(),
  childRequestId: IdentifierSchemas.requestId,
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId,
  executionPlanId: IdentifierSchemas.executionPlanId,
  executionPlanDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  parentExecutionPlanId: IdentifierSchemas.executionPlanId,
  parentExecutionPlanDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  canonicalActorPrincipalId: z
    .string()
    .regex(/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  productReaderPrincipalId: z.string().min(1).max(256),
  authorityRevision: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  requestedSelection: ModelSelectionReferenceSchema.optional(),
})

/** The one child selection resolution: lead product pin, child request digest and requested role. */
export function resolveChildModelSelection(
  product: Pick<ReturnType<typeof createProductionLeadProductAuthority>, 'resolveChildSelection'>,
  child: z.output<typeof ProductionChildModelRequestSchema>
) {
  return product.resolveChildSelection(
    {
      schemaVersion: 'pi-lead-intent/v1',
      workspaceId: child.workspaceId,
      intentId: child.parentIntentId,
      principalId: child.productReaderPrincipalId,
    },
    {
      childRequestId: child.childRequestId,
      childRequestDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(child)).digest('hex')}`,
      canonicalActorPrincipalId: child.canonicalActorPrincipalId,
      ...(child.requestedSelection ? { requestedSelection: child.requestedSelection } : {}),
    }
  )
}

/** Inject into Node's existing childAuthority port. The host independently verifies canonical
 * lineage/approval/current grant. No model selection grants a budget, funds or credentials.
 */
export function createProductionChildModelAuthority(options: {
  product: Pick<ReturnType<typeof createProductionLeadProductAuthority>, 'resolveChildSelection'>
  readCurrent(request: RuntimeStartRequest): Promise<unknown | undefined>
  /** Existing canonical admission/allocation, called only AFTER selection readiness succeeds. */
  admit(
    request: RuntimeStartRequest,
    selection: RuntimeProviderSelection
  ): Promise<PiDurableAdmission>
  assertCurrent(authority: DurableExecutionAuthority): Promise<void>
  now?: () => string
}) {
  const now = options.now ?? (() => new Date().toISOString())
  const readCanonical = async (raw: RuntimeStartRequest) => {
    const request = RuntimeStartRequestSchema.parse(raw)
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    const child = ProductionChildModelRequestSchema.parse(await options.readCurrent(request))
    const observedAt = Date.parse(now())
    if (
      !plan.parentExecutionPlan ||
      child.workspaceId !== plan.correlation.workspaceId ||
      child.childRequestId !== plan.correlation.requestId ||
      child.executionId !== request.executionId ||
      child.attemptId !== request.attemptId ||
      child.executionPlanId !== plan.executionPlanId ||
      child.executionPlanDigest !== plan.contentDigest ||
      child.parentExecutionPlanId !== plan.parentExecutionPlan.executionPlanId ||
      child.parentExecutionPlanDigest !== plan.parentExecutionPlan.contentDigest ||
      !Number.isFinite(observedAt) ||
      Date.parse(child.expiresAt) <= observedAt
    )
      throw new Error('PI_CHILD_MODEL_AUTHORITY_DENIED')
    return { request, child }
  }
  const resolve = async (raw: RuntimeStartRequest) => {
    const { request, child } = await readCanonical(raw)
    const selection = await resolveChildModelSelection(options.product, child)
    const fresh = await readCanonical(request)
    if (canonicalJsonStringify(fresh.child) !== canonicalJsonStringify(child))
      throw new Error('PI_CHILD_MODEL_AUTHORITY_CHANGED')
    return { request, child, selection }
  }
  const assertMatches = (
    authority: DurableExecutionAuthority,
    current: Awaited<ReturnType<typeof resolve>>
  ) => {
    const admission = PiDurableAdmissionSchema.parse(authority.admission)
    if (
      admission.canonicalActorPrincipalId !== current.child.canonicalActorPrincipalId ||
      admission.selection.selectionRef !== current.selection.selectionRef ||
      admission.selection.selectionRevision !== current.selection.selectionRevision
    )
      throw new Error('PI_CHILD_MODEL_SELECTION_CHANGED')
  }
  return {
    async resolveAdmission(request: RuntimeStartRequest) {
      const current = await resolve(request)
      const admission = PiDurableAdmissionSchema.parse(
        await options.admit(current.request, current.selection)
      )
      const authority = { request: current.request, admission }
      assertMatches(authority, current)
      await options.assertCurrent(authority)
      assertMatches(authority, await resolve(current.request))
      return admission
    },
    async assertAuthority(authority: DurableExecutionAuthority) {
      await options.assertCurrent(authority)
      assertMatches(authority, await resolve(authority.request))
    },
  }
}
