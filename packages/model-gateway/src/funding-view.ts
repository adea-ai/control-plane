import { z } from 'zod'
import {
  ModelFundingOwnerSchema,
  ModelSelectionFundingViewSchema,
  type ModelSelectionFundingView,
} from '@control-plane/contracts'
import { ModelPriceSnapshotSchema } from '@control-plane/usage-ledger'
import { RecordedModelSpendingAuthorizationSchema } from './litellm-http.js'
import {
  ExecutionModelSelectionBindingSchema,
  type ExecutionModelSelectionBinding,
  type createExecutionBoundModelSelectionService,
} from './execution-selection.js'
import { ModelSelectionError } from './selection-service.js'

/** Authenticated server record, not a caller's grant. Uses existing spending/price contracts. */
export const RecordedModelFundingDecisionSchema = z.strictObject({
  schemaVersion: z.literal('recorded-model-funding/v1'),
  executionPlanId: ExecutionModelSelectionBindingSchema.shape.executionPlanId,
  executionPlanDigest: ExecutionModelSelectionBindingSchema.shape.executionPlanDigest,
  selectionRef: ExecutionModelSelectionBindingSchema.shape.selectionRef,
  selectionRevision: ExecutionModelSelectionBindingSchema.shape.selectionRevision,
  canonicalActorPrincipalId: ExecutionModelSelectionBindingSchema.shape.canonicalActorPrincipalId,
  authorityRevision: ExecutionModelSelectionBindingSchema.shape.authorityRevision,
  grant: RecordedModelSpendingAuthorizationSchema,
  price: ModelPriceSnapshotSchema,
  fundingOwner: ModelFundingOwnerSchema,
})
export type RecordedModelFundingDecision = z.output<typeof RecordedModelFundingDecisionSchema>
export interface RecordedModelFundingAuthority {
  /** Re-read the authenticated recorded authorization and its explicit payer record.
   * Missing/revoked/unknown payer evidence denies. Schema validation is not authentication.
   */
  readCurrent(binding: ExecutionModelSelectionBinding): Promise<unknown | undefined>
}

/** Read-only pre-inference disclosure bound to current execution/account and recorded spend.
 * Neither a ready view nor its authorizationRef can authorize a physical send.
 */
export async function resolveModelSelectionFundingView(options: {
  binding: unknown
  selections: ReturnType<typeof createExecutionBoundModelSelectionService>
  fundingAuthority: RecordedModelFundingAuthority
  now?: () => string
}): Promise<ModelSelectionFundingView> {
  const binding = ExecutionModelSelectionBindingSchema.parse(options.binding)
  const base = {
    schemaVersion: 'model-funding-display/v1' as const,
    workspaceId: binding.workspaceId,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
    selectionRef: binding.selectionRef,
    selectionRevision: binding.selectionRevision,
  }
  try {
    options.selections.assertBinding(binding)
    const selection = await options.selections.resolveSelection({
      workspaceId: binding.workspaceId,
      selectionRef: binding.selectionRef,
      selectionRevision: binding.selectionRevision,
    })
    const record = RecordedModelFundingDecisionSchema.safeParse(
      await options.fundingAuthority.readCurrent(structuredClone(binding))
    )
    if (!record.success) throw new ModelSelectionError('READINESS_UNAVAILABLE')
    const { grant, price, fundingOwner } = record.data
    const at = Date.parse((options.now ?? (() => new Date().toISOString()))())
    if (
      !Number.isFinite(at) ||
      record.data.executionPlanId !== binding.executionPlanId ||
      record.data.executionPlanDigest !== binding.executionPlanDigest ||
      record.data.selectionRef !== binding.selectionRef ||
      record.data.selectionRevision !== binding.selectionRevision ||
      record.data.canonicalActorPrincipalId !== binding.canonicalActorPrincipalId ||
      record.data.authorityRevision !== binding.authorityRevision ||
      grant.workspaceId !== binding.workspaceId ||
      grant.executionId !== binding.executionId ||
      grant.attemptId !== binding.attemptId ||
      grant.principalRef !== binding.principalRef ||
      grant.alias !== binding.modelAlias ||
      grant.policySnapshotDigest !== binding.policySnapshotDigest ||
      ![
        selection.credentialRef,
        `vault://${selection.credentialRef}/${selection.credentialRevision}`,
      ].includes(grant.credentialRef) ||
      grant.fundingSource !== selection.fundingSource ||
      price.deploymentId !== grant.deploymentId ||
      price.provider !== selection.provider ||
      price.model !== selection.providerModel ||
      price.fundingSource !== grant.fundingSource ||
      price.currency !== grant.currency ||
      at < Date.parse(grant.issuedAt) ||
      at >= Date.parse(grant.expiresAt) ||
      at < Date.parse(price.validFrom) ||
      at >= Date.parse(price.validUntil)
    )
      throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
    await options.selections.assertReady(selection)
    const expiresAt = Math.min(Date.parse(grant.expiresAt), Date.parse(price.validUntil))
    const returnedAt = Date.parse((options.now ?? (() => new Date().toISOString()))())
    if (!Number.isFinite(returnedAt) || returnedAt < at || returnedAt >= expiresAt)
      throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
    return ModelSelectionFundingViewSchema.parse({
      ...base,
      state: 'ready',
      provider: selection.provider,
      providerModel: selection.providerModel,
      accountRef: selection.accountRef,
      authKind: selection.authKind,
      fundingSource: selection.fundingSource,
      fundingOwner,
      authorizationRef: grant.authorizationId,
      authorityRevision: binding.authorityRevision,
      expiresAt: new Date(expiresAt).toISOString(),
    })
  } catch (error) {
    const reason =
      error instanceof ModelSelectionError && error.code !== 'READY'
        ? error.code
        : 'READINESS_UNAVAILABLE'
    return ModelSelectionFundingViewSchema.parse({ ...base, state: 'blocked', reasonCode: reason })
  }
}
