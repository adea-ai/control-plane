import {
  VerifiedPiLeadIntentEvidenceSchema,
  type PiLeadProductAuthorityPort,
  type VerifiedPiLeadIntentEvidence,
} from './node-admission.js'

/** Normalize only fresh authenticated product evidence for the canonical model
 * host. Workspace support is a trusted host check, never a client/plan inference.
 * The model host separately rechecks current kernel scope, actor and plan pins.
 */
export function createPiLeadModelProductAuthority(options: {
  product: PiLeadProductAuthorityPort
  workspaceScope?: {
    assertSupported(evidence: VerifiedPiLeadIntentEvidence): Promise<void>
  }
}) {
  return {
    async readCurrent(input: Parameters<PiLeadProductAuthorityPort['readCurrent']>[0]) {
      const raw = await options.product.readCurrent(input)
      if (raw === undefined) return undefined
      const evidence = VerifiedPiLeadIntentEvidenceSchema.parse(raw)
      if (evidence.workspaceId !== input.workspaceId || evidence.intentId !== input.intentId)
        throw new Error('PI_LEAD_PRODUCT_SCOPE_REJECTED')
      const {
        projectId,
        prompt: _prompt,
        profileVersionId: _profile,
        profileContentDigest: _digest,
        ...metadata
      } = evidence
      if (projectId !== undefined && projectId !== null)
        return {
          ...metadata,
          projectId,
          executionScope: { schemaVersion: 1 as const, kind: 'project' as const, projectId },
        }
      if (!options.workspaceScope || !evidence.canonicalActorPrincipalId)
        throw new Error('PI_LEAD_PROJECT_SCOPE_REQUIRED')
      await options.workspaceScope.assertSupported(structuredClone(evidence))
      return {
        ...metadata,
        executionScope: { schemaVersion: 1 as const, kind: 'workspace' as const },
      }
    },
  }
}
