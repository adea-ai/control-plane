import type { AgentHqApiClient } from '@adea-ai/api-client'
import {
  settledData,
  useAccountSummaryQuery,
  useArchiveProjectMutation,
  useCreateProjectMutation,
  useCreateWorkspaceMutation,
  useDeleteProjectMutation,
  useProjectListQuery,
  useTaskListQuery,
  useUpdateProjectMutation,
} from '@adea-ai/data'
import type {
  DevGlobalNavContext,
  DevGlobalNavSlots,
  DevWorkspaceNavHost,
} from '@adea-ai/dev-view/chat'
import type { TaskLifecycleState, WorkspaceSummary } from '@adea-ai/types'
import type { WorkspaceRunSummaryItem } from '@adea-ai/types/dev-runtime'
import { createMemo, type Accessor } from 'solid-js'

export type { DevGlobalNavContext, DevGlobalNavSlots, DevWorkspaceNavHost }

/** The icon a project created from Dev starts with; Chat's project settings change it. */
const DEV_PROJECT_ICON_KEY = 'engineering'

export type DevWorkspaceNavHostOptions = Readonly<{
  client: AgentHqApiClient
  activeWorkspace: Accessor<WorkspaceSummary | undefined>
  /** The signed-in owner's facts for the creation draft; undefined for guests and unknown identities. */
  creationContext?: Accessor<NonNullable<DevWorkspaceNavHost['creationContext']> | undefined>
  /**
   * Whether a Dev sidebar is rendered. The host lives at the navigation level
   * for every view, so its cloud queries subscribe only while a sidebar reads
   * them: a second Task list observer under Chat's Kanban holds the board's
   * post-create refetch and leaves the closed Task panel's modal
   * `aria-hidden` on the workspace frame.
   */
  active?: Accessor<boolean>
  workspaces: Accessor<readonly WorkspaceSummary[]>
  switchToWorkspace: (workspace: WorkspaceSummary) => unknown
  openWorkspaceSettings?: () => void
  /** The desktop `dev.summary.workspaces` counts; absent on the web lane. */
  devSummary?: Accessor<readonly WorkspaceRunSummaryItem[] | undefined>
  /** Agents, Mark all read and Conversations, the same sections Chat shows. */
  globalNav?: DevGlobalNavSlots
}>

function requestId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * The cloud side of the Dev sidebar (ADR 0011): the member's workspaces, the
 * active workspace's project list and task lifecycles, the account summary
 * and the desktop run summary, plus the cloud project and workspace
 * mutations. The queries share their cache entries with Chat and Virtual, so
 * switching views reuses them. Every field is a getter so the sidebar tracks
 * the queries reactively.
 */
export function createDevWorkspaceNavHost(
  options: DevWorkspaceNavHostOptions
): DevWorkspaceNavHost {
  const workspaceId = () => options.activeWorkspace()?.id
  const queriedWorkspaceId = () => (options.active?.() === false ? undefined : workspaceId())
  const projectsQuery = useProjectListQuery(options.client, queriedWorkspaceId)
  const tasksQuery = useTaskListQuery(options.client, queriedWorkspaceId)
  const accountSummary = useAccountSummaryQuery(options.client)
  const createWorkspace = useCreateWorkspaceMutation(options.client)
  const createProject = useCreateProjectMutation(options.client, () => workspaceId() ?? '')
  const updateProject = useUpdateProjectMutation(options.client, () => workspaceId() ?? '')
  const archiveProject = useArchiveProjectMutation(options.client, () => workspaceId() ?? '')
  const deleteProject = useDeleteProjectMutation(options.client, () => workspaceId() ?? '')

  const projects = createMemo(() => {
    const list = settledData(projectsQuery)
    return list
      ?.filter((project) => project.lifecycleState === 'active')
      .map((project) => ({
        id: project.id,
        name: project.name,
        sortOrder: project.sortOrder,
        iconKey: project.iconKey,
        sourceKind: project.sourceKind,
      }))
  })
  const taskStates = createMemo(() => {
    const tasks = settledData(tasksQuery)
    return tasks
      ? new Map<string, TaskLifecycleState>(tasks.map((task) => [task.id, task.lifecycleState]))
      : undefined
  })
  const workspaces = createMemo(() =>
    options.workspaces().map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      logo: workspace.logo,
      accent: workspace.accent,
      sortOrder: workspace.sortOrder,
    }))
  )

  return {
    globalNav: options.globalNav,
    get activeWorkspaceId() {
      return workspaceId()
    },
    get activeWorkspaceName() {
      return options.activeWorkspace()?.name
    },
    get creationContext() {
      return options.creationContext?.()
    },
    get workspaces() {
      return workspaces()
    },
    get projects() {
      return projects()
    },
    get taskStates() {
      return taskStates()
    },
    get accountSummary() {
      return settledData(accountSummary)?.workspaces
    },
    get devSummary() {
      return options.devSummary?.()
    },
    onSwitchWorkspace: (id) => {
      const workspace = options.workspaces().find((candidate) => candidate.id === id)
      if (workspace) void options.switchToWorkspace(workspace)
    },
    onCreateWorkspace: async (name) => {
      const result = await createWorkspace.mutateAsync({
        idempotencyKey: requestId(),
        name,
        scene: 'home',
      })
      await options.switchToWorkspace(result.workspace)
    },
    get onOpenWorkspaceSettings() {
      return options.openWorkspaceSettings
    },
    onCreateProject: async (name) => {
      // A client id makes a replayed create idempotent and is the id the
      // local repository binding is keyed by.
      const id = requestId()
      const result = await createProject.mutateAsync({
        id,
        name,
        iconKey: DEV_PROJECT_ICON_KEY,
        sourceKind: 'none',
      })
      return result.project.id
    },
    onRenameProject: async (projectId, name) => {
      await updateProject.mutateAsync({ projectId, update: { name } })
    },
    onSetProjectSource: async (projectId, sourceKind) => {
      await updateProject.mutateAsync({ projectId, update: { sourceKind } })
    },
    onArchiveProject: async (projectId) => {
      await archiveProject.mutateAsync(projectId)
    },
    onDeleteProject: async (projectId) => {
      await deleteProject.mutateAsync(projectId)
    },
  }
}
