import { createHash } from 'node:crypto'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ModelSelectionRefSchema,
} from '@control-plane/contracts'
import {
  ChildAdmissionRequestSchema,
  ChildAdmissionReceiptSchema,
  type ChildAdmissionAuthority,
  type ChildAdmissionReceipt,
  type ChildAdmissionReader,
} from '@control-plane/orchestration'
import {
  RuntimeProviderSelectionSchema,
  type RuntimeProviderSelection,
} from '@control-plane/model-gateway'
import { z } from 'zod'

const ActorPrincipalId = z
  .string()
  .regex(/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Reference = z.string().min(1).max(256)
const ModelSelectionReferenceSchema = z.strictObject({
  selectionRef: ModelSelectionRefSchema,
  selectionRevision: z.number().int().positive(),
})

/**
 * Strict structural copy of the #1016 child product request. Kept local so
 * this additive adapter can be reviewed independently while #1016 remains a
 * draft; the field names and constraints intentionally match that API.
 */
export const ProductionChildBudgetCurrentSchema = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  parentIntentId: z.uuid(),
  childRequestId: IdentifierSchemas.requestId,
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId,
  executionPlanId: IdentifierSchemas.executionPlanId,
  executionPlanDigest: Digest,
  parentExecutionPlanId: IdentifierSchemas.executionPlanId,
  parentExecutionPlanDigest: Digest,
  canonicalActorPrincipalId: ActorPrincipalId,
  productReaderPrincipalId: Reference,
  authorityRevision: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  requestedSelection: ModelSelectionReferenceSchema.optional(),
})

type ProductionChildBudgetCurrent = z.output<typeof ProductionChildBudgetCurrentSchema>
type ChildProductResolver = {
  /** Resolves the accepted child role and performs current model readiness checks. */
  resolveChildSelection(
    input: {
      readonly schemaVersion: 'pi-lead-intent/v1'
      readonly workspaceId: string
      readonly intentId: string
      readonly principalId: string
    },
    child: {
      readonly childRequestId: string
      readonly childRequestDigest: string
      readonly canonicalActorPrincipalId: string
      readonly requestedSelection?: z.output<typeof ModelSelectionReferenceSchema>
    }
  ): Promise<RuntimeProviderSelection>
}

const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`

function assertCurrentMatchesRequest(
  request: z.output<typeof ChildAdmissionRequestSchema>,
  current: ProductionChildBudgetCurrent,
  now: string
): void {
  if (
    current.workspaceId !== request.workspaceId ||
    current.parentIntentId !== request.parentIntentId ||
    current.childRequestId !== request.childRequestId ||
    current.executionId !== request.childExecutionId ||
    current.attemptId !== request.childAttemptId ||
    current.executionPlanId !== request.childPlan.executionPlanId ||
    current.executionPlanDigest !== request.childPlan.contentDigest ||
    current.parentExecutionPlanId !== request.parentPlan.executionPlanId ||
    current.parentExecutionPlanDigest !== request.parentPlan.contentDigest ||
    current.canonicalActorPrincipalId !== request.originalActorPrincipalId ||
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(current.expiresAt) <= Date.parse(now)
  ) {
    throw new Error('PI_CHILD_MODEL_AUTHORITY_DENIED')
  }
}

/**
 * Bridges the canonical child-admission preflight to current product actor,
 * audience, accepted role selection, and model readiness. It intentionally
 * returns only immutable selection references; credentials and provider
 * snapshots never enter the durable child-admission receipt.
 */
export function createProductionChildBudgetAdmissionAuthority(options: {
  readonly product: ChildProductResolver
  readCurrent(
    request: z.output<typeof ChildAdmissionRequestSchema>,
    reader?: ChildAdmissionReader
  ): Promise<unknown>
  readonly now?: () => string
}): ChildAdmissionAuthority {
  const now = options.now ?? (() => new Date().toISOString())

  const resolve = async (
    requestInput: z.output<typeof ChildAdmissionRequestSchema>,
    reader?: ChildAdmissionReader
  ): Promise<ChildAdmissionReceipt> => {
    const request = ChildAdmissionRequestSchema.parse(requestInput)
    const current = ProductionChildBudgetCurrentSchema.parse(
      await options.readCurrent(structuredClone(request), reader)
    )
    assertCurrentMatchesRequest(request, current, now())

    const childRequestDigest = digest(current)
    const selection = RuntimeProviderSelectionSchema.parse(
      await options.product.resolveChildSelection(
        {
          schemaVersion: 'pi-lead-intent/v1',
          workspaceId: current.workspaceId,
          intentId: current.parentIntentId,
          principalId: current.productReaderPrincipalId,
        },
        {
          childRequestId: current.childRequestId,
          childRequestDigest,
          canonicalActorPrincipalId: current.canonicalActorPrincipalId,
          ...(current.requestedSelection ? { requestedSelection: current.requestedSelection } : {}),
        }
      )
    )
    if (selection.workspaceId !== request.workspaceId) {
      throw new Error('PI_CHILD_MODEL_SELECTION_DENIED')
    }

    // Re-read the server-owned request after product/profile/readiness work to
    // reject mutation while the asynchronous resolver was running.
    const fresh = ProductionChildBudgetCurrentSchema.parse(
      await options.readCurrent(structuredClone(request), reader)
    )
    assertCurrentMatchesRequest(request, fresh, now())
    if (canonicalJsonStringify(fresh) !== canonicalJsonStringify(current)) {
      throw new Error('PI_CHILD_MODEL_AUTHORITY_CHANGED')
    }

    return ChildAdmissionReceiptSchema.parse({
      schemaVersion: 'pi-child-admission/v1',
      ...request,
      authorityRevision: current.authorityRevision,
      productRevision: digest({
        childRequestDigest,
        authorityRevision: current.authorityRevision,
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
      }),
      productReaderPrincipalId: current.productReaderPrincipalId,
      selectionRef: selection.selectionRef,
      selectionRevision: selection.selectionRevision,
      expiresAt: current.expiresAt,
    })
  }

  return {
    prepare(request) {
      return resolve(request)
    },
    async assertCurrent(request, receiptInput, reader?: ChildAdmissionReader) {
      const receipt = ChildAdmissionReceiptSchema.parse(receiptInput)
      const current = await resolve(request, reader)
      if (canonicalJsonStringify(current) !== canonicalJsonStringify(receipt)) {
        throw new Error('PI_CHILD_MODEL_AUTHORITY_CHANGED')
      }
    },
  }
}
