import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  RuntimeStartRequestSchema,
  RuntimeUsageSchema,
  type RuntimeUsage,
} from '@control-plane/runtime-sdk'
import {
  type DurableUsageLedger,
  type ModelRequestQuote,
  type PinnedModelPrice,
  type UsageLedgerEntry,
} from '@control-plane/usage-ledger'
import { PiDurableAdmissionSchema, type DurableExecutionAuthority } from './contracts.js'

export interface PiDurableUsageAuthorityOptions {
  readonly ledger: DurableUsageLedger
  /** Server-owned immutable price evidence for the eligible provider selection. Never accept caller prices. */
  readonly resolvePrice: (authority: DurableExecutionAuthority) => Promise<{
    readonly price: PinnedModelPrice
    readonly maximumOutputTokens: number
  }>
  /** Mandatory server integration with recorded ModelHttpAuthority spending authorization.
   * The host authenticates RecordedModelSpendingAuthorizationSchema evidence and verifies
   * principal, provider/credential/deployment, policy, grant lifetime and cumulative attempt ceilings.
   * A plan allowance, schema-valid grant supplied by a caller, or funded ledger is insufficient.
   */
  readonly assertSpendingAuthorized: (
    authority: DurableExecutionAuthority,
    request: {
      readonly priceSnapshotDigest: string
      readonly requestDigest: string
      readonly currency: 'USD'
      readonly fundingSource: ModelRequestQuote['fundingSource']
      readonly maximumMicrounits: number
      readonly maximumTokens: number
      readonly attemptMaximumMicrounits: number
      readonly attemptMaximumTokens: number
    }
  ) => Promise<{
    readonly authorizationRef: string
    readonly evidenceDigest: string
    readonly assertActive: () => Promise<void>
  }>
}

export interface PiInferenceUsageCounts {
  readonly cachedInputTokens?: number
  readonly reasoningTokens?: number
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
}

function modelCallId(identity: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${identity.slice(0, 32)}`)
  let encoded = ''
  for (let position = 0; position < 26; position++) {
    encoded = alphabet[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return `mdc_${encoded}`
}

function scope(authority: DurableExecutionAuthority, key: string) {
  const request = RuntimeStartRequestSchema.safeParse(authority.request)
  const admission = PiDurableAdmissionSchema.safeParse(authority.admission)
  if (
    !request.success ||
    !admission.success ||
    !request.data.attemptBudget ||
    !key ||
    key.length > 2048
  ) {
    throw new Error('PI_USAGE_AUTHORITY_INVALID')
  }
  const budget = request.data.attemptBudget
  const identity = hash({ budget, admission: admission.data, inferenceKey: key })
  return {
    budget,
    modelCallId: modelCallId(identity),
    requestDigest: `sha256:${identity}`,
    sourceId: `pi-inference:${identity}`,
  }
}

function allowance(
  entries: readonly UsageLedgerEntry[],
  budget: ReturnType<typeof scope>['budget']
) {
  const attempt = entries.filter(
    (entry) =>
      entry.attemptId === budget.attemptId && entry.reservationKey === budget.reservationKey
  )
  const released = new Set(
    attempt.filter((entry) => entry.kind === 'model_release').map((entry) => entry.modelCallId)
  )
  let tokens = 0
  let money = 0
  for (const entry of attempt) {
    if (entry.kind === 'model_reservation' && !released.has(entry.modelCallId)) {
      tokens += entry.reservedTokens ?? 0
      money += entry.costMicrounits
    } else if (
      entry.kind === 'model_usage' ||
      entry.kind === 'tool_charge' ||
      entry.kind === 'sandbox_usage'
    ) {
      if (entry.quantity.unit === 'tokens') tokens += entry.quantity.value
      money += entry.costMicrounits
    }
    if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(money))
      throw new Error('PI_USAGE_AUTHORITY_INVALID')
  }
  return { tokens: budget.maximumTokens - tokens, money: budget.maximumMicrounits - money }
}

function assertHold(quote: ModelRequestQuote, hold: UsageLedgerEntry): void {
  if (
    hold.priceSnapshotDigest !== quote.priceSnapshotDigest ||
    hold.requestDigest !== quote.requestDigest ||
    hold.fundingSource !== quote.fundingSource ||
    hold.currency !== quote.currency ||
    hold.reservedTokens !== quote.maximumTokens ||
    hold.costMicrounits !== quote.maximumMicrounits
  ) {
    throw new Error('PI_PINNED_PRICE_HOLD_MISMATCH')
  }
}

async function authorizedQuote(
  options: PiDurableUsageAuthorityOptions,
  authority: DurableExecutionAuthority,
  binding: ReturnType<typeof scope>,
  price: PinnedModelPrice,
  maximumOutputTokens: number
) {
  const provisional = price.quote({ requestDigest: binding.requestDigest, maximumOutputTokens })
  const receipt = await options.assertSpendingAuthorized(authority, {
    priceSnapshotDigest: provisional.priceSnapshotDigest,
    requestDigest: binding.requestDigest,
    currency: provisional.currency,
    fundingSource: provisional.fundingSource,
    maximumMicrounits: provisional.maximumMicrounits,
    maximumTokens: provisional.maximumTokens,
    attemptMaximumMicrounits: binding.budget.maximumMicrounits,
    attemptMaximumTokens: binding.budget.maximumTokens,
  })
  if (
    !receipt ||
    typeof receipt.authorizationRef !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(receipt.authorizationRef) ||
    typeof receipt.evidenceDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.evidenceDigest) ||
    typeof receipt.assertActive !== 'function'
  ) {
    throw new Error('PI_MODEL_SPENDING_AUTHORIZATION_INVALID')
  }
  const requestDigest = `sha256:${hash({ scopeDigest: binding.requestDigest, authorizationRef: receipt.authorizationRef, evidenceDigest: receipt.evidenceDigest })}`
  return {
    quote: price.quote({ requestDigest, maximumOutputTokens }),
    assertActive: () => receipt.assertActive(),
  }
}

/** Ledger dispatch fence and pinned-price settlement. Never opens budgets or creates funding/access. */
export function createPiDurableUsageAuthority(options: PiDurableUsageAuthorityOptions) {
  if (typeof options.assertSpendingAuthorized !== 'function')
    throw new Error('PI_MODEL_SPENDING_AUTHORITY_REQUIRED')
  return {
    async authorizeInference(
      authority: DurableExecutionAuthority,
      key: string
    ): Promise<{
      maxOutputTokens: number
      maximumInputTokens: number
      assertActive: () => Promise<void>
    }> {
      const binding = scope(authority, key)
      const { budget } = binding
      const resolved = await options.resolvePrice(authority)
      if (!Number.isSafeInteger(resolved.maximumOutputTokens) || resolved.maximumOutputTokens < 1)
        throw new Error('PI_USAGE_AUTHORITY_INVALID')
      const entries = await options.ledger.entries(budget.workspaceId, budget.executionId)
      const existing = entries.find(
        (entry) => entry.kind === 'model_reservation' && entry.modelCallId === binding.modelCallId
      )
      const conservative = resolved.price.quote({
        requestDigest: binding.requestDigest,
        maximumOutputTokens: 1,
      })
      const remaining = allowance(entries, budget)
      // Reconstruct a prior dispatch's exact quote so the ledger itself rejects physical-send replay.
      const maximumOutputTokens = existing
        ? (existing.reservedTokens ?? 0) - conservative.maximumInputTokens
        : Math.min(resolved.maximumOutputTokens, remaining.tokens - conservative.maximumInputTokens)
      if (maximumOutputTokens < 1) throw new Error('PI_CONSERVATIVE_INPUT_BUDGET_EXHAUSTED')
      const { quote, assertActive } = await authorizedQuote(
        options,
        authority,
        binding,
        resolved.price,
        maximumOutputTokens
      )
      if (existing) assertHold(quote, existing)
      else if (quote.maximumMicrounits > remaining.money)
        throw new Error('PI_CONSERVATIVE_PRICE_BUDGET_EXHAUSTED')
      await assertActive()
      await options.ledger.reserveModelRequestForDispatch({
        workspaceId: budget.workspaceId,
        executionId: budget.executionId,
        attemptId: budget.attemptId,
        reservationKey: budget.reservationKey,
        modelCallId: binding.modelCallId,
        maximumMicrounits: quote.maximumMicrounits,
        maximumTokens: quote.maximumTokens,
        fundingSource: quote.fundingSource,
        priceSnapshotDigest: quote.priceSnapshotDigest,
        requestDigest: quote.requestDigest,
        source: { sourceId: binding.sourceId, idempotencyKey: `${binding.sourceId}:dispatch` },
      })
      await assertActive()
      return {
        maxOutputTokens: quote.maximumOutputTokens,
        maximumInputTokens: quote.maximumInputTokens,
        assertActive,
      }
    },

    async settleUsage(
      authority: DurableExecutionAuthority,
      key: string,
      usage: RuntimeUsage,
      counts: PiInferenceUsageCounts = {}
    ): Promise<RuntimeUsage> {
      const binding = scope(authority, key)
      const { budget } = binding
      // Cost/accounting supplied by Pi or another caller never enters trusted pricing.
      const trusted = RuntimeUsageSchema.parse({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: usage.durationMs,
      })
      const entries = await options.ledger.entries(budget.workspaceId, budget.executionId)
      const hold = entries.find(
        (entry) =>
          entry.kind === 'model_reservation' &&
          entry.modelCallId === binding.modelCallId &&
          entry.attemptId === budget.attemptId &&
          entry.reservationKey === budget.reservationKey
      )
      if (!hold) throw new Error('PI_INFERENCE_RESERVATION_NOT_FOUND')
      const resolved = await options.resolvePrice(authority)
      const conservative = resolved.price.quote({
        requestDigest: binding.requestDigest,
        maximumOutputTokens: 1,
      })
      const { quote } = await authorizedQuote(
        options,
        authority,
        binding,
        resolved.price,
        (hold.reservedTokens ?? 0) - conservative.maximumInputTokens
      )
      assertHold(quote, hold)
      const priced = quote.priceUsage({
        inputTokens: trusted.inputTokens,
        outputTokens: trusted.outputTokens,
        cachedInputTokens: counts.cachedInputTokens ?? 0,
        reasoningTokens: counts.reasoningTokens ?? 0,
      })
      const entry = await options.ledger.settleModelRequest({
        workspaceId: budget.workspaceId,
        executionId: budget.executionId,
        attemptId: budget.attemptId,
        reservationKey: budget.reservationKey,
        modelCallId: binding.modelCallId,
        costMicrounits: priced.costMicrounits,
        tokens: priced.tokens,
        source: { sourceId: binding.sourceId, idempotencyKey: `${binding.sourceId}:settle` },
      })
      const charged = BigInt(entry.costMicrounits)
      return RuntimeUsageSchema.parse({
        ...trusted,
        ...(entry.costExact
          ? {
              cost: {
                amount: `${charged / 1_000_000n}.${String(charged % 1_000_000n).padStart(6, '0')}`,
                currency: 'USD',
              },
              accounting: {
                schemaVersion: 1,
                sourceId: entry.source.sourceId,
                fundingSource: entry.fundingSource,
                currency: 'USD',
                chargedMicrounits: entry.costMicrounits,
                costExact: true,
              },
            }
          : {}),
      })
    },
  }
}
