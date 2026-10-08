import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  ModelSelectionFundingViewSchema,
  type ModelSelectionFundingView,
} from '@control-plane/contracts'
import {
  ExecutionModelSelectionBindingSchema,
  type ExecutionModelSelectionBinding,
  type CurrentModelExecutionAuthority,
} from './execution-selection.js'
import { ModelSelectionError } from './selection-service.js'

const Ready = ModelSelectionFundingViewSchema.options[0]
export const RetainedModelFundingConfirmationSchema = z.strictObject({
  schemaVersion: z.literal('retained-model-funding/v1'),
  binding: ExecutionModelSelectionBindingSchema,
  funding: Ready,
  confirmationRef: z.string().regex(/^funding-confirmation:[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  admissionDeadline: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
})
const RecordSchema = RetainedModelFundingConfirmationSchema
export type RetainedModelFundingConfirmation = z.output<typeof RecordSchema>
export interface ModelFundingConfirmationRepository {
  getByAttempt(
    binding: Pick<ExecutionModelSelectionBinding, 'workspaceId' | 'executionId' | 'attemptId'>
  ): Promise<unknown | undefined>
  /** Atomic, immutable, unique per workspace/execution/attempt; returns the retained winner. */
  putIfAbsent(record: RetainedModelFundingConfirmation): Promise<unknown>
}
export class ModelFundingConfirmationError extends Error {
  constructor(
    readonly code: 'PI_LEAD_FUNDING_CONFIRMATION_REQUIRED' | 'PI_LEAD_FUNDING_CONFIRMATION_STALE'
  ) {
    super(code)
    this.name = 'ModelFundingConfirmationError'
  }
}
const stale = (): never => {
  throw new ModelFundingConfirmationError('PI_LEAD_FUNDING_CONFIRMATION_STALE')
}
const same = (a: unknown, b: unknown) => canonicalJsonStringify(a) === canonicalJsonStringify(b)
const reference = (record: Omit<RetainedModelFundingConfirmation, 'confirmationRef'>) =>
  `funding-confirmation:${createHash('sha256').update(canonicalJsonStringify(record)).digest('hex')}`

/** Display confirmation only. No credential, spending grant, reservation or release is created.
 * R1 owns canonical unused-allocation expiry/cancellation. Use the returned authority for
 * BOTH provider and spending resolution to recheck the retained payer at every send boundary.
 */
export function createModelFundingPreparationService(options: {
  executionAuthority: CurrentModelExecutionAuthority
  confirmations: ModelFundingConfirmationRepository
  readFunding(binding: ExecutionModelSelectionBinding): Promise<ModelSelectionFundingView>
  now?: () => string
}) {
  const now = options.now ?? (() => new Date().toISOString())
  let lastObserved = -Infinity
  function time() {
    const at = Date.parse(now())
    if (!Number.isFinite(at) || at < lastObserved) stale()
    lastObserved = at
    return at
  }
  async function current(binding: ExecutionModelSelectionBinding) {
    try {
      await options.executionAuthority.assertCurrent(structuredClone(binding))
      const funding = ModelSelectionFundingViewSchema.parse(
        await options.readFunding(structuredClone(binding))
      )
      if (funding.state !== 'ready') throw new ModelSelectionError(funding.reasonCode)
      if (
        funding.workspaceId !== binding.workspaceId ||
        funding.executionId !== binding.executionId ||
        funding.attemptId !== binding.attemptId ||
        funding.selectionRef !== binding.selectionRef ||
        funding.selectionRevision !== binding.selectionRevision ||
        funding.authorityRevision !== binding.authorityRevision ||
        time() >= Date.parse(funding.expiresAt)
      )
        stale()
      await options.executionAuthority.assertCurrent(structuredClone(binding))
      return funding
    } catch (error) {
      if (error instanceof ModelSelectionError) throw error
      return stale()
    }
  }
  function retained(input: unknown, binding: ExecutionModelSelectionBinding) {
    const parsed = RecordSchema.safeParse(input)
    if (!parsed.success) return stale()
    const record = parsed.data
    const { confirmationRef, ...body } = record
    const at = time()
    const expiry = Date.parse(record.expiresAt)
    const created = Date.parse(record.createdAt)
    if (
      !same(record.binding, binding) ||
      reference(body) !== confirmationRef ||
      at >= expiry ||
      created > at ||
      expiry <= created ||
      expiry > created + 300_000 ||
      expiry > Date.parse(record.admissionDeadline) ||
      expiry > Date.parse(record.funding.expiresAt)
    )
      stale()
    return record
  }
  async function check(
    binding: ExecutionModelSelectionBinding,
    input: unknown,
    confirmationRef?: string
  ) {
    try {
      const record = retained(input, binding)
      if (confirmationRef !== undefined && confirmationRef !== record.confirmationRef) stale()
      if (!same(await current(binding), record.funding)) stale()
      retained(record, binding)
      return structuredClone(record)
    } catch {
      return stale()
    }
  }
  async function assertFundingCurrent(
    input: ExecutionModelSelectionBinding,
    confirmationRef: string
  ) {
    const binding = ExecutionModelSelectionBindingSchema.parse(input)
    const record = await options.confirmations.getByAttempt(binding)
    if (record === undefined)
      throw new ModelFundingConfirmationError('PI_LEAD_FUNDING_CONFIRMATION_REQUIRED')
    await check(binding, record, confirmationRef)
  }
  return {
    async prepareFunding(input: ExecutionModelSelectionBinding, admissionDeadline: string) {
      const binding = ExecutionModelSelectionBindingSchema.parse(input)
      const deadline = Date.parse(z.iso.datetime().parse(admissionDeadline))
      if (time() >= deadline) stale()
      const existing = await options.confirmations.getByAttempt(binding)
      if (existing !== undefined) {
        const record = await check(binding, existing)
        if (Date.parse(record.expiresAt) > deadline) stale()
        return record
      }
      const funding = await current(binding)
      const created = time()
      const body = {
        schemaVersion: 'retained-model-funding/v1' as const,
        binding,
        funding,
        createdAt: new Date(created).toISOString(),
        admissionDeadline,
        expiresAt: new Date(
          Math.min(created + 300_000, deadline, Date.parse(funding.expiresAt))
        ).toISOString(),
      }
      const candidate = RecordSchema.parse({ ...body, confirmationRef: reference(body) })
      const winner = await options.confirmations.putIfAbsent(structuredClone(candidate))
      const record = await check(binding, winner)
      if (Date.parse(record.expiresAt) > deadline) stale()
      return record
    },
    assertFundingCurrent,
    confirmedExecutionAuthority: {
      async assertCurrent(input: ExecutionModelSelectionBinding) {
        const binding = ExecutionModelSelectionBindingSchema.parse(input)
        const record = await options.confirmations.getByAttempt(binding)
        if (record === undefined)
          throw new ModelFundingConfirmationError('PI_LEAD_FUNDING_CONFIRMATION_REQUIRED')
        await check(binding, record)
      },
    } satisfies CurrentModelExecutionAuthority,
  }
}
