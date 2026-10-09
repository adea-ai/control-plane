import type { NodePiDurableLeadAdmissionOptions } from '../pi-durable/node-admission.js'
import { ProductionLeadProductEvidenceSchema } from './production-lead-product.js'
import type { PiLeadModelAdmissionInput } from './pi-lead-model-readiness.js'

export function createProductionLeadReadiness(
  ready: (input: PiLeadModelAdmissionInput) => Promise<void>
): NonNullable<NodePiDurableLeadAdmissionOptions['assertProviderReady']> {
  return async (input) => {
    const actor = ProductionLeadProductEvidenceSchema.shape.canonicalActorPrincipalId.parse(
      input.evidence.canonicalActorPrincipalId
    )
    if (actor !== input.actorPrincipalId) throw new Error('PI_PRODUCTION_ACTOR_REQUIRED')
    await ready({ ...input, evidence: { ...input.evidence, canonicalActorPrincipalId: actor } })
  }
}
