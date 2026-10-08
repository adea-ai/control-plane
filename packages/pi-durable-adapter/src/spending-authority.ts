import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { RecordedModelSpendingAuthorizationSchema } from '@control-plane/model-gateway'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import {
  ModelPriceSnapshotSchema,
  PinnedModelPrice,
  type DurableUsageLedger,
} from '@control-plane/usage-ledger'
import { PiDurableAdmissionSchema, type DurableExecutionAuthority } from './contracts.js'
import type { PiDurableUsageAuthorityOptions } from './usage-authority.js'

export interface PiRecordedModelDecision {
  readonly executionPlanId: string
  readonly executionPlanDigest: string
  readonly selectionRef: string
  readonly selectionRevision: number
  readonly grant: unknown
  readonly price: unknown
}

export interface PiSpendingSelection {
  readonly selectionRef: string
  readonly selectionRevision: number
  readonly workspaceId: string
  readonly credentialRef: string
  readonly provider: string
  readonly providerModel: string
  readonly fundingSource: string
}

export interface PiRecordedSpendingAuthorityOptions {
  readonly ledger: DurableUsageLedger
  readonly alias: string
  readonly now?: () => string
  /** Server composition only: authenticate a persisted authorization decision and
   * its plan/selection binding. Reject missing/revoked decisions. Never read this
   * evidence from runtime input or treat schema validation as authentication.
   */
  readonly readRecordedDecision: (
    authority: DurableExecutionAuthority
  ) => Promise<PiRecordedModelDecision>
  /** Resolve the exact eligible gateway selection, including current revocation,
   * credential revision, provider/location/harness policy and workspace grants.
   * The projected fields contain identifiers only, never a secret or lease.
   */
  readonly resolveSelection: (authority: DurableExecutionAuthority) => Promise<PiSpendingSelection>
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}

function denied(): never {
  throw new Error('PI_RECORDED_MODEL_SPENDING_DENIED')
}

/** Reuses the canonical recorded spending and price schemas; creates no grants,
 * budgets, funding, credentials, or model-selection decisions.
 */
export function createPiRecordedSpendingAuthority(
  options: PiRecordedSpendingAuthorityOptions
): Pick<PiDurableUsageAuthorityOptions, 'resolvePrice' | 'assertSpendingAuthorized'> {
  const now = options.now ?? (() => new Date().toISOString())

  async function read(authority: DurableExecutionAuthority) {
    const request = RuntimeStartRequestSchema.parse(authority.request)
    const admission = PiDurableAdmissionSchema.parse(authority.admission)
    const budget = request.attemptBudget
    if (!budget) denied()
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    const record = structuredClone(await options.readRecordedDecision(authority))
    const selection = structuredClone(await options.resolveSelection(authority))
    const grant = RecordedModelSpendingAuthorizationSchema.parse(record.grant)
    const price = ModelPriceSnapshotSchema.parse(record.price)
    const at = Date.parse(now())
    if (
      !Number.isFinite(at) ||
      at < Date.parse(grant.issuedAt) ||
      at >= Date.parse(grant.expiresAt) ||
      at < Date.parse(price.validFrom) ||
      at >= Date.parse(price.validUntil) ||
      at >= Date.parse(admission.authority.expiresAt) ||
      record.executionPlanId !== plan.executionPlanId ||
      record.executionPlanDigest !== plan.contentDigest ||
      record.selectionRef !== admission.selection.selectionRef ||
      record.selectionRevision !== admission.selection.selectionRevision ||
      selection.selectionRef !== record.selectionRef ||
      selection.selectionRevision !== record.selectionRevision ||
      selection.workspaceId !== budget.workspaceId ||
      grant.workspaceId !== budget.workspaceId ||
      grant.executionId !== budget.executionId ||
      grant.attemptId !== budget.attemptId ||
      grant.principalRef !== admission.authority.principalRef ||
      grant.policySnapshotDigest !== plan.policySnapshot.digest ||
      grant.alias !== options.alias ||
      !plan.constraints.models.some((model) => model.alias === options.alias) ||
      grant.credentialRef !== selection.credentialRef ||
      grant.deploymentId !== price.deploymentId ||
      price.provider !== selection.provider ||
      price.model !== selection.providerModel ||
      grant.fundingSource !== selection.fundingSource ||
      price.fundingSource !== grant.fundingSource ||
      grant.currency !== budget.currency ||
      price.currency !== grant.currency ||
      budget.maximumTokens > grant.maximumTokens ||
      (grant.fundingSource !== 'external_subscription' &&
        budget.maximumMicrounits > grant.maximumMicrounits)
    )
      denied()
    const allocation = await options.ledger.attemptAllocation(
      budget.workspaceId,
      budget.executionId,
      budget.attemptId
    )
    if (
      allocation.currency !== budget.currency ||
      allocation.maximumTokens !== budget.maximumTokens ||
      allocation.maximumMicrounits !== budget.maximumMicrounits ||
      allocation.maximumTokens > grant.maximumTokens ||
      (grant.fundingSource !== 'external_subscription' &&
        allocation.maximumMicrounits > grant.maximumMicrounits)
    )
      denied()
    // Explicit projection prevents any credential-bearing extension on a server
    // record/selection object from being retained or hashed as evidence.
    const bound = {
      executionPlanId: record.executionPlanId,
      executionPlanDigest: record.executionPlanDigest,
      selection: {
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
        workspaceId: selection.workspaceId,
        credentialRef: selection.credentialRef,
        provider: selection.provider,
        providerModel: selection.providerModel,
        fundingSource: selection.fundingSource,
      },
      grant,
      price,
    }
    return { grant, price, evidenceDigest: digest(bound), priceSnapshotDigest: digest(price) }
  }

  return {
    async resolvePrice(authority) {
      const resolved = await read(authority)
      return {
        price: new PinnedModelPrice(resolved.price, { now }),
        maximumOutputTokens: resolved.price.maximumOutputTokens,
      }
    },
    async assertSpendingAuthorized(authority, requested) {
      const resolved = await read(authority)
      const { grant, price } = resolved
      const budget = authority.request.attemptBudget
      if (
        !budget ||
        !/^sha256:[a-f0-9]{64}$/.test(requested.requestDigest) ||
        requested.priceSnapshotDigest !== resolved.priceSnapshotDigest ||
        requested.currency !== grant.currency ||
        requested.fundingSource !== grant.fundingSource ||
        requested.attemptMaximumTokens !== budget.maximumTokens ||
        requested.attemptMaximumMicrounits !== budget.maximumMicrounits ||
        !Number.isSafeInteger(requested.maximumTokens) ||
        !Number.isSafeInteger(requested.maximumMicrounits) ||
        requested.maximumTokens <= price.maximumInputTokens ||
        requested.maximumMicrounits < 0 ||
        requested.maximumTokens > grant.maximumTokens ||
        requested.maximumMicrounits > grant.maximumMicrounits
      )
        denied()
      const quote = new PinnedModelPrice(price, { now }).quote({
        requestDigest: requested.requestDigest,
        maximumOutputTokens: requested.maximumTokens - price.maximumInputTokens,
      })
      if (
        quote.maximumTokens !== requested.maximumTokens ||
        quote.maximumMicrounits !== requested.maximumMicrounits
      )
        denied()
      return {
        authorizationRef: grant.authorizationId,
        evidenceDigest: resolved.evidenceDigest,
        async assertActive() {
          const current = await read(authority)
          if (current.evidenceDigest !== resolved.evidenceDigest) denied()
        },
      }
    },
  }
}
