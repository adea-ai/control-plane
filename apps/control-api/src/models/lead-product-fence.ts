import { z } from 'zod'
import { IdentifierSchemas, ServicePrincipalSchema } from '@control-plane/contracts'
import type { ProductionLeadProductEvidence } from './production-lead-product.js'

/** M18.01.3 typed rollback-fence consumer (Adea #1244 proposal, root-approved pinned v2). */

const INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTOR_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATOR_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
/**
 * Same expression as `ProductionLeadProductEvidenceSchema.canonicalActorPrincipalId`
 * (apps/control-api/src/models/production-lead-product.ts); duplicated to keep this
 * module dependency-free of the evidence module (no import cycle).
 */
const USER_PRINCIPAL_ID =
  /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Canonical UTC only, and never after the caller's clock. No skew tolerance. */
const fencedAt = (now: () => number) =>
  z.string().refine((value) => {
    const at = Date.parse(value)
    return Number.isFinite(at) && at <= now() && new Date(at).toISOString() === value
  }, 'fencedAt must be canonical UTC and not in the future')

const rollbackFenceShape = (now: () => number) =>
  z
    .object({
      fencedAt: fencedAt(now),
      reason: z.enum(['operator_intervention', 'rollback_cohort']),
      actor: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('user'), userId: z.string().regex(ACTOR_USER_ID) }).strict(),
        z
          .object({ kind: z.literal('operator'), operatorId: z.string().regex(OPERATOR_ID) })
          .strict(),
      ]),
    })
    .strict()

const fenceFactsShape = (now: () => number) =>
  z
    .object({
      intentId: z.string().regex(INTENT_ID),
      workspaceId: IdentifierSchemas.workspaceId,
      dispatchPermitted: z.literal(false),
      rollbackFence: rollbackFenceShape(now),
    })
    .strict()

/** Minimal fence facts (proposal v1): no authority pins; CP refuses every action. */
export const LeadIntentFenceFactsV1Schema = (now: () => number) =>
  z
    .object({
      schemaVersion: z.literal('pi-lead-intent-fence/v1'),
      ...fenceFactsShape(now).shape,
    })
    .strict()

/**
 * Root-approved pinned v2: v1 facts plus the four pins derived from the existing
 * producer's contract builders (shapes mirror
 * `VerifiedPiLeadIntentEvidenceSchema.authorityRevision/scopeRef/allowedPrincipalIds`
 * and `ProductionLeadProductEvidenceSchema.canonicalActorPrincipalId`).
 */
export const LeadIntentFenceFactsV2Schema = (now: () => number) =>
  z
    .object({
      schemaVersion: z.literal('pi-lead-intent-fence/v2'),
      ...fenceFactsShape(now).shape,
      authorityRevision: z.number().int().positive(),
      canonicalActorPrincipalId: z.string().regex(USER_PRINCIPAL_ID),
      scopeRef: z.string().min(1).max(256),
      allowedPrincipalIds: z
        .array(ServicePrincipalSchema.shape.principalId)
        .min(1)
        .max(64)
        .refine((values) => new Set(values).size === values.length),
    })
    .strict()

export type LeadIntentFenceFactsV1 = z.output<ReturnType<typeof LeadIntentFenceFactsV1Schema>>
export type LeadIntentFenceFactsV2 = z.output<ReturnType<typeof LeadIntentFenceFactsV2Schema>>
export type LeadIntentFenceFacts = LeadIntentFenceFactsV1 | LeadIntentFenceFactsV2

export type LeadFenceVariant = 'v1' | 'v2'

export type LeadProductReadResult =
  | { readonly kind: 'admission'; readonly evidence: ProductionLeadProductEvidence }
  | {
      readonly kind: 'fenced'
      readonly variant: LeadFenceVariant
      readonly facts: LeadIntentFenceFacts
    }

export type LeadOperation =
  | 'prepare'
  | 'dispatch'
  | 'status'
  | 'progress'
  | 'cancel'
  | 'resume'
  | 'publication'
export type LeadFenceDecision = 'refuse' | 'observe' | 'cancel-as-actor'

/** Minimal v1 refuses every action. */
const FENCED_OPERATION_POLICY_V1: Readonly<Record<LeadOperation, LeadFenceDecision>> = {
  prepare: 'refuse',
  dispatch: 'refuse',
  status: 'refuse',
  progress: 'refuse',
  cancel: 'refuse',
  resume: 'refuse',
  publication: 'refuse',
}

/**
 * Root-approved pinned v2: read-safe observation and original-actor cancellation only;
 * never prepare, dispatch, resume or publication.
 */
const FENCED_OPERATION_POLICY_V2: Readonly<Record<LeadOperation, LeadFenceDecision>> = {
  prepare: 'refuse',
  dispatch: 'refuse',
  status: 'observe',
  progress: 'observe',
  cancel: 'cancel-as-actor',
  resume: 'refuse',
  publication: 'refuse',
}

export function fencedOperationPolicy(
  variant: LeadFenceVariant
): Readonly<Record<LeadOperation, LeadFenceDecision>> {
  return variant === 'v2' ? FENCED_OPERATION_POLICY_V2 : FENCED_OPERATION_POLICY_V1
}

function isFenceSchemaVersion(
  value: unknown
): value is 'pi-lead-intent-fence/v1' | 'pi-lead-intent-fence/v2' {
  return value === 'pi-lead-intent-fence/v1' || value === 'pi-lead-intent-fence/v2'
}

/**
 * Parses one signed body from `createProductionProductHttpReader`. A fenced body
 * (root-approved v2, or minimal v1) is validated strictly and identity-checked
 * against the selectors; anything else returns `undefined` so callers keep the
 * existing `pi-lead-intent/v1` strict parse. Unknown fence schemas and identity
 * mismatches throw `PI_PRODUCT_READER_UNAVAILABLE`.
 */
export function parseLeadProductFence(
  body: unknown,
  selectors: { readonly workspaceId: string; readonly intentId: string },
  now: () => number
):
  | {
      readonly kind: 'fenced'
      readonly variant: LeadFenceVariant
      readonly facts: LeadIntentFenceFacts
    }
  | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const schemaVersion = (body as { schemaVersion?: unknown }).schemaVersion
  if (!isFenceSchemaVersion(schemaVersion)) return undefined
  try {
    const variant: LeadFenceVariant = schemaVersion.endsWith('/v2') ? 'v2' : 'v1'
    const facts: LeadIntentFenceFacts =
      variant === 'v2'
        ? LeadIntentFenceFactsV2Schema(now).parse(body)
        : LeadIntentFenceFactsV1Schema(now).parse(body)
    if (facts.workspaceId !== selectors.workspaceId || facts.intentId !== selectors.intentId)
      throw new Error('identity mismatch')
    return { kind: 'fenced', variant, facts }
  } catch {
    throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
  }
}
