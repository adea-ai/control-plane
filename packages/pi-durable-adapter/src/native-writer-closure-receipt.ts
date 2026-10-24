import { z } from 'zod'

const Reference = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.trim() === value)
const Epoch = z.number().int().nonnegative().safe()
const Instant = z.iso.datetime({ precision: 3 })

/**
 * C4 closure receipt shape. Pure evidence: a parser cannot show that anything closed. It is what
 * a candidate `closeWriters` would commit after sealing admission, settling in-flight commits and
 * bumping the store fence epoch. Nothing here closes, checkpoints, acquires or authorizes.
 */
export const PiWriterClosureReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-writer-closure-receipt/v1'),
    mutationId: Reference,
    ownerKey: Reference,
    lineageId: Reference,
    generation: Reference,
    previousEpoch: Epoch,
    epoch: Epoch,
    lastSeq: Epoch,
    settledInFlight: z.literal(true),
    closedAt: Instant,
  })
  .superRefine((receipt, context) => {
    if (receipt.epoch !== receipt.previousEpoch + 1)
      context.addIssue({ code: 'custom', path: ['epoch'], message: 'epoch must advance by one' })
  })
export type PiWriterClosureReceipt = z.infer<typeof PiWriterClosureReceiptSchema>

/** What the caller independently holds. A receipt is checked against it, never trusted alone. */
export interface PiWriterClosureExpectation {
  readonly mutationId: string
  readonly lineageId: string
  readonly generation: string
  readonly previousEpoch: number
  /** Highest commit sequence the caller already observed; a closure cannot precede it. */
  readonly observedSeq: number
}

export type PiWriterClosureEvidence = {
  readonly kind: 'writer-closure-evidence'
  readonly qualifiedAuthorization: false
  readonly receipt: PiWriterClosureReceipt
}

// The expectation is checked as strictly as the receipt: a NaN or missing floor would make every
// `lastSeq < observedSeq` comparison false and accept evidence below the floor the caller holds.
const ExpectationSchema = z.strictObject({
  mutationId: Reference,
  lineageId: Reference,
  generation: Reference,
  previousEpoch: Epoch,
  observedSeq: Epoch,
})

/** Fails closed with a stable code. The result is evidence only, never permission. */
export function assertPiWriterClosureReceipt(
  receiptInput: unknown,
  expectedInput: PiWriterClosureExpectation
): PiWriterClosureEvidence {
  const checked = ExpectationSchema.safeParse(expectedInput)
  if (!checked.success) throw new Error('PI_WRITER_CLOSURE_EXPECTATION_INVALID')
  const expected = checked.data
  const parsed = PiWriterClosureReceiptSchema.safeParse(receiptInput)
  if (!parsed.success) throw new Error('PI_WRITER_CLOSURE_RECEIPT_INVALID')
  const receipt = parsed.data
  if (receipt.mutationId !== expected.mutationId) throw new Error('PI_WRITER_CLOSURE_MUTATION')
  if (receipt.lineageId !== expected.lineageId) throw new Error('PI_WRITER_CLOSURE_LINEAGE')
  if (receipt.generation !== expected.generation) throw new Error('PI_WRITER_CLOSURE_GENERATION')
  if (receipt.previousEpoch !== expected.previousEpoch) throw new Error('PI_WRITER_CLOSURE_EPOCH')
  if (receipt.lastSeq < expected.observedSeq) throw new Error('PI_WRITER_CLOSURE_SEQUENCE')
  return Object.freeze({
    kind: 'writer-closure-evidence',
    qualifiedAuthorization: false,
    receipt: Object.freeze(receipt),
  })
}
