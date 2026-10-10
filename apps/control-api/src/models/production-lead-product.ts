import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  RequestedRoleModelSelectionsSchema,
  ModelSelectionReferenceSchema,
} from '@control-plane/contracts'
import {
  ModelExecutionTargetSchema,
  RuntimeProviderSelectionSchema,
  type ModelSelectionService,
} from '@control-plane/model-gateway'
import {
  VerifiedPiLeadIntentEvidenceSchema,
  type PiLeadProductAuthorityPort,
} from '../pi-durable/node-admission.js'
import { parseLeadProductFence } from './lead-product-fence.js'
import { createProductionRoleModelSelection } from './production-role-selection.js'

/** Fresh authenticated Adea evidence, before CP supplies model/profile references. */
export const ProductionLeadProductEvidenceSchema = VerifiedPiLeadIntentEvidenceSchema.omit({
  selectionRef: true,
  selectionRevision: true,
  profileVersionId: true,
  profileContentDigest: true,
})
  .extend({
    canonicalActorPrincipalId: z
      .string()
      .regex(/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    requestedModelSelections: RequestedRoleModelSelectionsSchema.optional(),
    profileId: z.string().min(1).max(256),
    profileVersion: z.string().min(1).max(256),
    profileRevision: z.number().int().nonnegative(),
  })
  .strict()
export type ProductionLeadProductEvidence = z.output<typeof ProductionLeadProductEvidenceSchema>
const Pin = z.strictObject({
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  profileVersionId: IdentifierSchemas.profileVersionId,
  profileContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  selectionRef: RuntimeProviderSelectionSchema.shape.selectionRef,
  selectionRevision: RuntimeProviderSelectionSchema.shape.selectionRevision,
  childSelection: ModelSelectionReferenceSchema.optional(),
})

export function createProductionLeadProductAuthority(options: {
  database: DatabaseSync
  product: {
    readCurrent(
      input: Parameters<PiLeadProductAuthorityPort['readCurrent']>[0]
    ): Promise<unknown | undefined>
  }
  profiles: {
    resolveImmutable(
      input: Pick<
        ProductionLeadProductEvidence,
        'workspaceId' | 'profileId' | 'profileVersion' | 'profileRevision'
      >
    ): Promise<
      | {
          profileId: string
          profileVersion: string
          profileRevision: number
          profileVersionId: string
          profileContentDigest: string
        }
      | undefined
    >
  }
  selections: Pick<ModelSelectionService, 'select' | 'resolveSelection' | 'assertReady'>
  target: z.output<typeof ModelExecutionTargetSchema>
  now?: () => string
}) {
  const target = ModelExecutionTargetSchema.parse(options.target)
  if (
    target.harness !== 'pi_durable' ||
    target.harnessVersion !== '1.1.0' ||
    target.location !== 'remote_host' ||
    target.providerBinding !== 'pi_durable_models'
  )
    throw new Error('PI_PRODUCTION_TARGET_INCOMPATIBLE')
  const now = options.now ?? (() => new Date().toISOString())
  options.database.exec(
    'CREATE TABLE IF NOT EXISTS pi_production_lead_selections (workspace_id TEXT NOT NULL, intent_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(workspace_id,intent_id))'
  )
  const roles = createProductionRoleModelSelection({
    database: options.database,
    selections: options.selections,
    target,
  })
  const read = (workspaceId: string, intentId: string) => {
    const row = options.database
      .prepare(
        'SELECT record FROM pi_production_lead_selections WHERE workspace_id=? AND intent_id=?'
      )
      .get(workspaceId, intentId)
    return row ? Pin.parse(JSON.parse(String(row['record']))) : undefined
  }
  const readCanonicalProduct = async (
    input: Parameters<PiLeadProductAuthorityPort['readCurrent']>[0]
  ) => {
    const raw = await options.product.readCurrent(structuredClone(input))
    if (raw === undefined) return undefined
    // Fenced facts are never a dispatchable product: return them before any
    // profile, selection or model path is touched (M18.01.3).
    const fenced = parseLeadProductFence(raw, input, () => Date.parse(now()))
    if (fenced) return { fenced: fenced.facts }
    const evidence = ProductionLeadProductEvidenceSchema.parse(raw)
    if (
      evidence.workspaceId !== input.workspaceId ||
      evidence.intentId !== input.intentId ||
      !evidence.allowedPrincipalIds.includes(input.principalId) ||
      Date.parse(evidence.expiresAt) <= Date.parse(now())
    )
      throw new Error('PI_PRODUCTION_PRODUCT_DENIED')
    const profile = await options.profiles.resolveImmutable({
      workspaceId: evidence.workspaceId,
      profileId: evidence.profileId,
      profileVersion: evidence.profileVersion,
      profileRevision: evidence.profileRevision,
    })
    if (
      !profile ||
      profile.profileId !== evidence.profileId ||
      profile.profileVersion !== evidence.profileVersion ||
      profile.profileRevision !== evidence.profileRevision
    )
      throw new Error('PI_PRODUCTION_PROFILE_UNAVAILABLE')
    const evidenceDigest = `sha256:${createHash('sha256').update(canonicalJsonStringify(evidence)).digest('hex')}`
    return { evidence, profile, evidenceDigest }
  }
  const readCurrent: PiLeadProductAuthorityPort['readCurrent'] = async (input) => {
    const current = await readCanonicalProduct(input)
    if (current === undefined) return undefined
    if ('fenced' in current) return current.fenced
    const { evidence, profile, evidenceDigest } = current
    let pin = read(evidence.workspaceId, evidence.intentId)
    if (!pin) {
      const selection = evidence.requestedModelSelections?.lead
        ? await roles.resolve({
            workspaceId: evidence.workspaceId,
            admissionRef: evidence.intentId,
            role: 'lead',
            canonicalActorPrincipalId: evidence.canonicalActorPrincipalId,
            evidenceDigest,
            requestedSelection: evidence.requestedModelSelections.lead,
          })
        : await options.selections.select({
            workspaceId: evidence.workspaceId,
            role: 'lead',
            target,
          })
      const childSelection = evidence.requestedModelSelections?.child
        ? await roles.resolve({
            workspaceId: evidence.workspaceId,
            admissionRef: evidence.intentId,
            role: 'child',
            canonicalActorPrincipalId: evidence.canonicalActorPrincipalId,
            evidenceDigest,
            requestedSelection: evidence.requestedModelSelections.child,
          })
        : undefined
      const proposed = Pin.parse({
        evidenceDigest,
        profileVersionId: profile.profileVersionId,
        profileContentDigest: profile.profileContentDigest,
        selectionRef: selection.selectionRef,
        selectionRevision: selection.selectionRevision,
        ...(childSelection
          ? {
              childSelection: {
                selectionRef: childSelection.selectionRef,
                selectionRevision: childSelection.selectionRevision,
              },
            }
          : {}),
      })
      // No writer is held across product/profile/account/vault reads. Concurrent writers reuse one exact winner.
      options.database
        .prepare('INSERT OR IGNORE INTO pi_production_lead_selections VALUES (?,?,?)')
        .run(evidence.workspaceId, evidence.intentId, canonicalJsonStringify(proposed))
      pin = read(evidence.workspaceId, evidence.intentId)
    }
    if (
      !pin ||
      pin.evidenceDigest !== evidenceDigest ||
      pin.profileVersionId !== profile.profileVersionId ||
      pin.profileContentDigest !== profile.profileContentDigest
    )
      throw new Error('PI_PRODUCTION_PRODUCT_CHANGED')
    const selection = await options.selections.resolveSelection({
      workspaceId: evidence.workspaceId,
      selectionRef: pin.selectionRef,
      selectionRevision: pin.selectionRevision,
    })
    await options.selections.assertReady(selection)
    const {
      profileId: _id,
      profileVersion: _version,
      profileRevision: _revision,
      requestedModelSelections: _requested,
      ...product
    } = evidence
    return VerifiedPiLeadIntentEvidenceSchema.parse({
      ...product,
      profileVersionId: pin.profileVersionId,
      profileContentDigest: pin.profileContentDigest,
      selectionRef: pin.selectionRef,
      selectionRevision: pin.selectionRevision,
    })
  }
  return {
    readCurrent,
    /** Readiness/selection only. Canonical child authority must call this BEFORE allocation,
     * then retain this exact selection in its admission, spending record and continuation grant.
     * The override is supplied by an independent current canonical child request reader.
     */
    async resolveChildSelection(
      input: Parameters<PiLeadProductAuthorityPort['readCurrent']>[0],
      child: {
        childRequestId: string
        childRequestDigest: string
        canonicalActorPrincipalId: string
        requestedSelection?: z.output<typeof ModelSelectionReferenceSchema>
      }
    ) {
      const currentChild = z
        .strictObject({
          childRequestId: z.string().min(1).max(128),
          childRequestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          canonicalActorPrincipalId:
            ProductionLeadProductEvidenceSchema.shape.canonicalActorPrincipalId,
          requestedSelection: ModelSelectionReferenceSchema.optional(),
        })
        .parse(child)
      // Recheck canonical product actor, audience, message and immutable profile without
      // coupling a child's independent model to lead-model readiness.
      const current = await readCanonicalProduct(input)
      if (
        !current ||
        !('evidence' in current) ||
        current.evidence.canonicalActorPrincipalId !== currentChild.canonicalActorPrincipalId
      )
        throw new Error('PI_CHILD_MODEL_AUTHORITY_DENIED')
      const pin = read(input.workspaceId, input.intentId)
      if (
        !pin ||
        pin.evidenceDigest !== current.evidenceDigest ||
        pin.profileVersionId !== current.profile.profileVersionId ||
        pin.profileContentDigest !== current.profile.profileContentDigest
      )
        throw new Error('PI_CHILD_MODEL_AUTHORITY_DENIED')
      return roles.resolve({
        workspaceId: input.workspaceId,
        admissionRef: `child:${input.intentId}:${currentChild.childRequestId}`,
        role: 'child',
        canonicalActorPrincipalId: currentChild.canonicalActorPrincipalId,
        evidenceDigest: `sha256:${createHash('sha256')
          .update(
            canonicalJsonStringify({
              parent: pin.evidenceDigest,
              child: currentChild.childRequestDigest,
            })
          )
          .digest('hex')}`,
        ...((currentChild.requestedSelection ?? pin.childSelection)
          ? { requestedSelection: currentChild.requestedSelection ?? pin.childSelection }
          : {}),
      })
    },
  }
}
