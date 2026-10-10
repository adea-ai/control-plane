import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferencePublicationDecision,
  ArtifactReferenceRetrievalDecision,
  ArtifactReferenceTarget,
  UserPrincipalRef,
} from '@adea-ai/types'
import { isArtifactReferenceTarget } from '@adea-ai/types'

import {
  readCurrentArtifactReferenceGrant,
  type ArtifactReferenceGrantPresentation,
} from './artifact-reference-grants'
import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
  readArtifactReferenceEvidence,
} from './artifact-reference-policy'
import { readArtifactReferenceEvidenceById } from './artifacts'
import type { AgentHqDatabase } from './connection'

/** The presented grant's revocation marker; the policy only tests non-null. */
const REVOKED_AT = '1970-01-01T00:00:00.000Z'

/**
 * Trusted wall clock. Sampled at the authorization decision — after every
 * evidence and registration read — so a grant that expires while those reads
 * are in flight is evaluated against the decision time, never a stale entry
 * time. Tests inject a deterministic clock.
 */
const defaultClock = (): string => new Date().toISOString()

function presentedGrant(
  state: ArtifactReferenceGrantState,
  target: ArtifactReferenceTarget
): ArtifactReferenceGrant {
  return {
    artifactId: state.artifactId,
    audienceWorkspaceId: target.audienceWorkspaceId,
    checksumSha256: state.checksumSha256,
    expiresAt: state.expiresAt,
    grantId: state.grantId,
    revokedAt: state.revoked ? REVOKED_AT : null,
    revision: state.revision,
    sourceWorkspaceId: state.sourceWorkspaceId,
    version: state.version,
  }
}

/**
 * The presented grant when the store holds no current registration. The
 * fields are bound to the requested target so the policy reports the precise
 * `grant_not_registered` refusal instead of treating the request as a
 * malformed grant.
 */
function unregisteredGrant(
  presentation: ArtifactReferenceGrantPresentation,
  target: ArtifactReferenceTarget
): ArtifactReferenceGrant {
  return {
    artifactId: target.artifactId,
    audienceWorkspaceId: target.audienceWorkspaceId,
    checksumSha256: target.checksumSha256,
    expiresAt: null,
    grantId: presentation.grantId,
    revokedAt: null,
    revision: presentation.revision,
    sourceWorkspaceId: target.sourceWorkspaceId,
    version: target.version,
  }
}

export type ArtifactReferenceServiceResult<Decision> = Readonly<{
  decision: Decision
  evidence: ArtifactReferenceEvidence | null
}>

/**
 * Publication wiring for the durable grant store. The caller presents the
 * exact target and the grant identity only; current artifact evidence is read
 * by identity and the current registration from the store, so a URL, locator
 * or artifact id alone never participates in the decision.
 */
export async function publishArtifactReference(
  database: AgentHqDatabase,
  request: Readonly<{
    target: ArtifactReferenceTarget
    grant: ArtifactReferenceGrantPresentation
  }>,
  principal: UserPrincipalRef,
  clock: () => string = defaultClock
): Promise<ArtifactReferenceServiceResult<ArtifactReferencePublicationDecision>> {
  const { target, grant } = request
  // Publication evidence is read through the caller's own source-workspace
  // access (`getArtifactForUser` project visibility included): a member
  // without visibility into the artifact's project cannot publish it, and a
  // locator or URL never participates in the decision.
  const evidence = isArtifactReferenceTarget(target)
    ? await readArtifactReferenceEvidence(
        database,
        target.sourceWorkspaceId,
        target.artifactId,
        principal
      )
    : null
  const state = await readCurrentArtifactReferenceGrant(database, grant)
  // Sampled after the reads: the decision time is the current time, not the
  // time the call started.
  const now = clock()
  return {
    decision: authorizeArtifactReferencePublication({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: state ? presentedGrant(state, target) : unregisteredGrant(grant, target),
      grantState: state,
      now,
      target,
    }),
    evidence,
  }
}

/**
 * Retrieval wiring for the durable grant store. Everything is re-read at
 * decision time: evidence by identity, the current registration from the
 * store, and the requesting workspace checked against the registered
 * audience — a revoked or superseded grant is denied rather than delivered.
 */
export async function retrieveArtifactReference(
  database: AgentHqDatabase,
  request: Readonly<{
    target: ArtifactReferenceTarget
    grant: ArtifactReferenceGrantPresentation
    requestingWorkspaceId: string
  }>,
  clock: () => string = defaultClock
): Promise<ArtifactReferenceServiceResult<ArtifactReferenceRetrievalDecision>> {
  const { target, grant, requestingWorkspaceId } = request
  const evidence = isArtifactReferenceTarget(target)
    ? await readArtifactReferenceEvidenceById(database, target.sourceWorkspaceId, target.artifactId)
    : null
  const state = await readCurrentArtifactReferenceGrant(database, grant)
  // Sampled after the reads: the decision time is the current time, not the
  // time the call started.
  const now = clock()
  return {
    decision: authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: state ? presentedGrant(state, target) : unregisteredGrant(grant, target),
      grantState: state,
      now,
      requestingWorkspaceId,
      target,
    }),
    evidence,
  }
}
