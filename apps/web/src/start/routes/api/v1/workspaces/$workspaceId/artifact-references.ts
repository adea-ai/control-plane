import { createFileRoute } from '@tanstack/solid-router'

import {
  publishArtifactReferenceResponse,
  retrieveArtifactReferenceResponse,
} from '../../../../../../server/artifact-reference-request'
import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../server/request-scope'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import { workspaceUnavailableResponse } from '../../../../../../server/workspace-response'

type Context = { params: { workspaceId: string } }

async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  return retrieveArtifactReferenceResponse(
    request,
    applicationDatabase(),
    resolution,
    workspaceId,
    authorizeWorkspace
  )
}

async function post(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  return publishArtifactReferenceResponse(
    request,
    applicationDatabase(),
    resolution,
    workspaceId,
    authorizeWorkspace
  )
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/artifact-references')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
