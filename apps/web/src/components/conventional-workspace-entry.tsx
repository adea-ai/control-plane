import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import {
  ConventionalWorkspaceShell,
  type WorkspaceDeepLink,
  type WorkspaceNavHost,
} from '@adea-ai/workspace-ui/conventional-workspace-shell'
import type { DevProjectFlow } from '@adea-ai/workspace-ui/create-project-flow'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { WorkspaceCreationContext } from '@adea-ai/workspace-nav/workspace-nav'
import type { JSX } from 'solid-js'

export function ConventionalWorkspaceEntry(props: {
  client: AgentHqApiClient
  archiveAction?: JSX.Element
  /** The signed-in owner for the sidebar's creation draft; absent for guests and unknown identities. */
  creationContext?: WorkspaceCreationContext
  restoreFocusRef?: () => HTMLElement | undefined
  /** The host's detailed create-project flow; absent keeps the basic dialog. */
  createProjectFlow?: () => DevProjectFlow | undefined
  deepLink?: () => WorkspaceDeepLink
  taskBoardOnly?: boolean
  /** Chat surfaces without the workspace sidebar; the host renders its own. */
  embedded?: boolean
  manageSettings?: boolean
  onConsumeDeepLink?: () => void
  /** Forwards the shell's bootstrap-fallback state to the frame's top bar. */
  onBootstrapFallbackChange?: (fallback: boolean) => void
  onOpenTaskBoard?: () => void
  onViewChange: (view: WorkspaceView) => void
  services: WorkspacePlatformServices
  workspaceHost?: WorkspaceNavHost
}) {
  return (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <ConventionalWorkspaceShell
        taskBoardOnly={props.taskBoardOnly}
        embedded={props.embedded}
        archiveAction={props.archiveAction}
        creationContext={props.creationContext}
        restoreFocusRef={props.restoreFocusRef}
        createProjectFlow={props.createProjectFlow}
        deepLink={props.deepLink}
        manageSettings={props.manageSettings ?? true}
        onBootstrapFallbackChange={props.onBootstrapFallbackChange}
        onConsumeDeepLink={props.onConsumeDeepLink}
        onOpenTaskBoard={props.onOpenTaskBoard}
        onViewChange={props.onViewChange}
        view="chat"
        services={{ ...props.services, client: props.client }}
        workspaceHost={props.workspaceHost}
      />
    </TooltipProvider>
  )
}
