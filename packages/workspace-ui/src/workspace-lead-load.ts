import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
import type {
  ApiModelConnectionsResponse,
  ApiModelDefaultsResponse,
  ApiWorkspaceModelDefaults,
} from '@adea-ai/api-client/model-connections'
import { projectWorkspaceLeadSetup, type WorkspaceLeadSetup } from './workspace-lead-setup'
import {
  projectWorkspaceLeadPresentation,
  type WorkspaceLeadPresentation,
} from './workspace-lead-presentation'

export type WorkspaceLeadClient = Pick<
  AgentHqApiClient,
  'getWorkspaceLead' | 'ensureWorkspaceLead' | 'listModelConnections' | 'getWorkspaceModelDefaults'
>

export type WorkspaceLeadLoad =
  | Readonly<{
      current: true
      setup: WorkspaceLeadSetup
      presentation: WorkspaceLeadPresentation
    }>
  | Readonly<{ current: false }>

const STALE: WorkspaceLeadLoad = { current: false }

function failureOf(error: unknown): 'auth_required' | 'unavailable' {
  return error instanceof ApiClientError && error.status === 401 ? 'auth_required' : 'unavailable'
}

/**
 * Loads lead setup for one workspace. The lead is provisioned only when no lead
 * exists, the client's manage hint allows it, and the scope is still current
 * immediately before the write. The server re-checks `workspace.update` on every
 * write; the hint only avoids a request that cannot succeed. A result that lands
 * after a scope switch is reported as stale and must not be applied. Inventory or
 * defaults read failures fail closed.
 */
export async function loadWorkspaceLeadSetup(input: {
  client: WorkspaceLeadClient
  workspaceId: string
  isCurrent(): boolean
  /** Called once a lead was written in the current scope, so the roster list can refetch. */
  onProvisioned?: () => void
}): Promise<WorkspaceLeadLoad> {
  const { client, workspaceId } = input
  const [leadRead, connections, defaultsPage] = await Promise.all([
    client.getWorkspaceLead(workspaceId).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    ),
    client.listModelConnections(workspaceId).catch((): ApiModelConnectionsResponse | null => null),
    client
      .getWorkspaceModelDefaults(workspaceId)
      .catch((): ApiModelDefaultsResponse | null => null),
  ])
  if (!input.isCurrent()) return STALE
  const defaults: ApiWorkspaceModelDefaults | null | undefined = defaultsPage?.defaults
  // Only an explicit `false` from either inventory read denies provisioning.
  const denied = connections?.canManage === false || defaultsPage?.canManage === false
  if (!leadRead.ok)
    return {
      current: true,
      setup: projectWorkspaceLeadSetup({
        lead: null,
        failure: failureOf(leadRead.error),
        connections,
        defaults,
      }),
      presentation: projectWorkspaceLeadPresentation({ lead: null, leadKnown: false, connections }),
    }
  let lead = leadRead.value.lead
  let provisioning: 'failed' | undefined
  let failure: 'auth_required' | 'not_permitted' | undefined
  let written = false
  if (!lead && denied) failure = 'not_permitted'
  else if (!lead) {
    // The scope check sits immediately before the write.
    if (!input.isCurrent()) return STALE
    try {
      const response = (await client.ensureWorkspaceLead(workspaceId)).lead
      if (response?.isWorkspaceLead) {
        lead = response
        written = true
      } else provisioning = 'failed'
    } catch (error) {
      if (failureOf(error) === 'auth_required') failure = 'auth_required'
      else provisioning = 'failed'
    }
    // A write that completes after a scope switch is not applied to the new scope.
    if (!input.isCurrent()) return STALE
    if (written) input.onProvisioned?.()
  }
  return {
    current: true,
    setup: projectWorkspaceLeadSetup({
      lead,
      ...(failure ? { failure } : {}),
      ...(provisioning ? { provisioning } : {}),
      connections,
      defaults,
    }),
    presentation: projectWorkspaceLeadPresentation({ lead, connections }),
  }
}
