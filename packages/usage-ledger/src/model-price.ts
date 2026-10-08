import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { z } from 'zod'

const AmountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** Operator/provider price evidence, supplied by the server composition.
 * Parsing this snapshot does not establish a credential grant or purchased funding.
 * The rates cover text input and output only; cache and reasoning counts are subsets.
 */
export const ModelPriceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    deploymentId: ReferenceSchema,
    provider: ReferenceSchema,
    model: ReferenceSchema,
    version: ReferenceSchema,
    currency: z.literal('USD'),
    fundingSource: z.enum(['hq_managed', 'external_subscription']),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    maximumInputTokens: AmountSchema.positive(),
    maximumOutputTokens: AmountSchema.positive(),
    ratesMicrounitsPerMillionTokens: z
      .object({
        input: AmountSchema,
        cachedInput: AmountSchema,
        output: AmountSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const rates = snapshot.ratesMicrounitsPerMillionTokens
    if (
      Date.parse(snapshot.validUntil) <= Date.parse(snapshot.validFrom) ||
      !Number.isSafeInteger(snapshot.maximumInputTokens + snapshot.maximumOutputTokens) ||
      rates.cachedInput > rates.input ||
      (snapshot.fundingSource === 'external_subscription' &&
        (rates.input !== 0 || rates.cachedInput !== 0 || rates.output !== 0))
    )
      context.addIssue({ code: 'custom', message: 'Invalid model price bounds' })
  })

const QuoteInputSchema = z
  .object({
    requestDigest: DigestSchema,
    maximumOutputTokens: AmountSchema.positive(),
  })
  .strict()

const UsageSchema = z
  .object({
    inputTokens: AmountSchema,
    outputTokens: AmountSchema,
    cachedInputTokens: AmountSchema.default(0),
    reasoningTokens: AmountSchema.default(0),
  })
  .strict()

export interface ModelRequestQuote {
  readonly requestDigest: string
  readonly priceSnapshotDigest: string
  readonly fundingSource: 'hq_managed' | 'external_subscription'
  readonly currency: 'USD'
  readonly maximumInputTokens: number
  readonly maximumOutputTokens: number
  readonly maximumTokens: number
  readonly maximumMicrounits: number
  /** Trusted protocol adapters supply authoritative counts, never a client cost. */
  priceUsage(usage: unknown): {
    readonly costMicrounits: number
    readonly tokens: number
    readonly costExact: boolean
  }
}

/** Immutable price producer. No caller estimate reduces the conservative input hold.
 * Keep this instance and the outbound request behind the server's grant boundary.
 */
export class PinnedModelPrice {
  readonly #snapshot: z.output<typeof ModelPriceSnapshotSchema>
  readonly #digest: string
  readonly #now: () => string

  constructor(input: unknown, options: { readonly now?: () => string } = {}) {
    const parsed = ModelPriceSnapshotSchema.safeParse(input)
    if (!parsed.success) throw new Error('MODEL_PRICE_INVALID_SNAPSHOT')
    this.#snapshot = parsed.data
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#digest = `sha256:${createHash('sha256').update(canonicalJsonStringify(parsed.data)).digest('hex')}`
  }

  quote(input: unknown): ModelRequestQuote {
    const parsed = QuoteInputSchema.safeParse(input)
    if (!parsed.success) throw new Error('MODEL_PRICE_INVALID_REQUEST')
    const { requestDigest, maximumOutputTokens } = parsed.data
    const snapshot = this.#snapshot
    const now = z.iso.datetime().safeParse(this.#now())
    if (!now.success) throw new Error('MODEL_PRICE_INVALID_REQUEST')
    const requestedMs = Date.parse(now.data)
    if (
      maximumOutputTokens > snapshot.maximumOutputTokens ||
      requestedMs < Date.parse(snapshot.validFrom) ||
      requestedMs >= Date.parse(snapshot.validUntil)
    )
      throw new Error('MODEL_PRICE_INVALID_REQUEST')
    const maximumInputTokens = snapshot.maximumInputTokens
    const maximumMicrounits = priceTokens(snapshot, maximumInputTokens, 0, maximumOutputTokens)
    return Object.freeze({
      requestDigest,
      priceSnapshotDigest: this.#digest,
      currency: snapshot.currency,
      fundingSource: snapshot.fundingSource,
      maximumInputTokens,
      maximumOutputTokens,
      maximumTokens: maximumInputTokens + maximumOutputTokens,
      maximumMicrounits,
      priceUsage(usage: unknown) {
        const parsedUsage = UsageSchema.safeParse(usage)
        if (!parsedUsage.success) throw new Error('MODEL_PRICE_INVALID_USAGE')
        const { inputTokens, outputTokens, cachedInputTokens, reasoningTokens } = parsedUsage.data
        if (
          inputTokens > maximumInputTokens ||
          outputTokens > maximumOutputTokens ||
          cachedInputTokens > inputTokens ||
          reasoningTokens > outputTokens
        )
          throw new Error('MODEL_PRICE_INVALID_USAGE')
        return Object.freeze({
          costMicrounits: priceTokens(snapshot, inputTokens, cachedInputTokens, outputTokens),
          tokens: inputTokens + outputTokens,
          costExact: snapshot.fundingSource === 'hq_managed',
        })
      },
    })
  }
}

function priceTokens(
  snapshot: z.output<typeof ModelPriceSnapshotSchema>,
  input: number,
  cachedInput: number,
  output: number
): number {
  const rates = snapshot.ratesMicrounitsPerMillionTokens
  const numerator =
    BigInt(input - cachedInput) * BigInt(rates.input) +
    BigInt(cachedInput) * BigInt(rates.cachedInput) +
    BigInt(output) * BigInt(rates.output)
  const rounded = (numerator + 999_999n) / 1_000_000n
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MODEL_PRICE_OVERFLOW')
  return Number(rounded)
}
