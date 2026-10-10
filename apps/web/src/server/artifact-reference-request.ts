import 'server-only'

import type { AgentHqDatabase, ArtifactReferenceGrantPresentation } from '@adea-ai/db'
import { publishArtifactReference, retrieveArtifactReference } from '@adea-ai/db'
import {
  isArtifactReferenceTarget,
  type ArtifactReferenceTarget,
  type UserPrincipalRef,
} from '@adea-ai/types'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * Request shaping for cross-workspace artifact-reference publication and
 * retrieval (#1216). The wire contract carries identity only — target
 * workspace/artifact/version/checksum/audience plus the grant id and
 * revision. A location, filename or private URL is never accepted and never
 * returned: possession of a locator is not authorization, and the durable
 * grant store is the only thing that grants access.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const QUERY_KEYS = [
  'artifactId',
  'checksumSha256',
  'grantId',
  'revision',
  'sourceWorkspaceId',
  'version',
] as const

export type ArtifactReferenceRequestInput = Readonly<{
  grant: ArtifactReferenceGrantPresentation
  target: ArtifactReferenceTarget
}>

export type ArtifactReferenceAuthorizer = (
  principal: UserPrincipalRef,
  permission: 'workspace.read',
  workspaceId: string
) => Promise<{ allowed: boolean }>

function parseTarget(value: unknown, audienceWorkspaceId?: string): ArtifactReferenceTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  // Fail closed on smuggled fields: a target carries at most the five
  // identity fields, so a locator or URL riding alongside them makes it
  // invalid. The audience may be injected by the route instead of the wire.
  if (Object.keys(candidate).length > 5) return null
  const target = {
    artifactId: candidate.artifactId,
    audienceWorkspaceId: audienceWorkspaceId ?? candidate.audienceWorkspaceId,
    checksumSha256: candidate.checksumSha256,
    sourceWorkspaceId: candidate.sourceWorkspaceId,
    version: candidate.version,
  }
  // The guard enforces the exact five identity fields; anything smuggled
  // alongside them (a locator, URL or display name) is not a target.
  if (!isArtifactReferenceTarget(target)) return null
  if (
    !UUID.test(target.artifactId) ||
    !UUID.test(target.sourceWorkspaceId) ||
    !UUID.test(target.audienceWorkspaceId)
  )
    return null
  return target
}

function parseGrant(value: Record<string, unknown>): ArtifactReferenceGrantPresentation | null {
  const grantId = value.grantId
  const revision = value.revision
  if (typeof grantId !== 'string' || !grantId.trim() || grantId.length > 128) return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  return { grantId, revision }
}

export function parseArtifactReferenceBody(value: unknown): ArtifactReferenceRequestInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  // Exactly the identity contract: target + grantId + revision; no extra
  // body fields are considered (a smuggled locator makes the request invalid).
  if (
    Object.keys(body).length !== 3 ||
    !('target' in body) ||
    !('grantId' in body) ||
    !('revision' in body)
  )
    return null
  const target = parseTarget(body.target)
  const grant = parseGrant(body)
  if (!target || !grant) return null
  return { grant, target }
}

export function parseArtifactReferenceQuery(
  url: string,
  audienceWorkspaceId: string
): ArtifactReferenceRequestInput | null {
  const query = new URL(url).searchParams
  // Identity-only wire contract: exactly the documented keys, each once. An
  // unknown or duplicated field makes the request invalid rather than
  // silently resolving to one of several values.
  const keys = [...query.keys()]
  if (keys.length !== QUERY_KEYS.length) return null
  if (new Set(keys).size !== keys.length) return null
  if (keys.some((key) => !(QUERY_KEYS as readonly string[]).includes(key))) return null
  const target = parseTarget(
    {
      artifactId: query.get('artifactId'),
      checksumSha256: query.get('checksumSha256'),
      sourceWorkspaceId: query.get('sourceWorkspaceId'),
      version: Number(query.get('version')),
    },
    audienceWorkspaceId
  )
  const grant = parseGrant({
    grantId: query.get('grantId'),
    revision: Number(query.get('revision')),
  })
  if (!target || !grant) return null
  return { grant, target }
}

/**
 * Publication response for the source workspace. The workspace authorization
 * happens before the store is read; the decision carries only the exact
 * target, never a locator.
 */
export async function publishArtifactReferenceResponse(
  request: Request,
  database: AgentHqDatabase,
  caller: WorkspacePrincipalResolution,
  workspaceId: string,
  authorize: ArtifactReferenceAuthorizer
): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const input = parseArtifactReferenceBody(body)
  if (!input) return workspaceInvalidRequestResponse(request)
  // This route is the source workspace's publication route: the target's
  // source must be the route workspace, so another workspace's artifact can
  // never be announced through this workspace's access.
  if (input.target.sourceWorkspaceId !== workspaceId)
    return workspaceInvalidRequestResponse(request)
  if (!(await authorize(caller.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const result = await publishArtifactReference(database, input, caller.principal)
  if (!result.decision.ok)
    return workspaceJsonResponse(
      {
        code: 'artifact_reference_held',
        reason: result.decision.reason,
        stage: result.decision.stage,
      },
      caller,
      request,
      { status: 403 }
    )
  return workspaceJsonResponse({ reference: result.decision.target }, caller, request, {
    status: 202,
  })
}

/**
 * Retrieval response for the audience workspace. Everything is re-read from
 * current evidence and the current registration; a denial carries only a
 * typed reason and a success carries only the sanitized identity fields.
 */
export async function retrieveArtifactReferenceResponse(
  request: Request,
  database: AgentHqDatabase,
  caller: WorkspacePrincipalResolution,
  workspaceId: string,
  authorize: ArtifactReferenceAuthorizer
): Promise<Response> {
  const input = parseArtifactReferenceQuery(request.url, workspaceId)
  if (!input) return workspaceInvalidRequestResponse(request)
  if (!(await authorize(caller.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const result = await retrieveArtifactReference(database, {
    grant: input.grant,
    requestingWorkspaceId: workspaceId,
    target: input.target,
  })
  if (!result.decision.ok)
    return workspaceJsonResponse(
      {
        code: 'artifact_reference_denied',
        reason: result.decision.reason,
        stage: result.decision.stage,
      },
      caller,
      request,
      { status: 403 }
    )
  return workspaceJsonResponse(
    {
      artifact: result.evidence
        ? {
            availability: result.evidence.availability,
            checksumSha256: result.evidence.checksumSha256,
            id: result.evidence.id,
            sensitivity: result.evidence.sensitivity,
            version: result.evidence.version,
            workspaceId: result.evidence.workspaceId,
          }
        : null,
      reference: result.decision.target,
    },
    caller,
    request
  )
}
