import { createApiClient } from '@adea-ai/api-client'
import { AlertTriangle, X } from 'lucide-solid'
import {
  createEffect,
  createSignal,
  lazy,
  on,
  onCleanup,
  Show,
  Suspense,
  type ComponentProps,
  type JSX,
} from 'solid-js'
import { settledData, usePrefetchChannelMessages } from '@adea-ai/data'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'

import { ArtifactDetail } from './artifact-detail'
import { ConversationSurface } from './conversation-surface'
import { TaskBoard } from './task-board'
import type { DevProjectFlow } from './create-project-flow'
import { useWorkspaceController } from './use-workspace-controller'
import type { WorkspaceCreationContext } from '@adea-ai/workspace-nav/workspace-nav'
import { WorkspaceNavSidebar, type WorkspaceNavHost } from './workspace-nav-sidebar'
import { WorkspaceError, WorkspaceSkeleton } from './workspace-states'
import type { SearchResult } from './workspace-utility-dialogs'
import type { WorkspacePlatformServices } from './platform'
import type { WorkspaceView } from './workspace-view-toggle'
import {
  workspaceSettingsHash,
  workspaceSettingsSectionFromHash,
} from './workspace-settings-section'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

const CreateGroupDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.CreateGroupDialog }))
)
const ProjectCreateDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.ProjectCreateDialog }))
)
// The lead status is off the chat route's static graph: it loads when the Agents
// surface opens, and the chat route budget measures only static imports.
const WorkspaceLeadStatus = lazy(() =>
  import('./workspace-lead-status').then((module) => ({
    default: module.WorkspaceLeadStatus,
  }))
)
// The Agents roster is off the chat route's static graph too: it loads when the
// Agents surface opens. The wrapper keeps the call site and its props unchanged.
const LazyAgentRoster = lazy(() =>
  import('./agent-roster').then((module) => ({ default: module.AgentRoster }))
)
function AgentRoster(props: ComponentProps<typeof LazyAgentRoster>) {
  return (
    <Suspense fallback={null}>
      <LazyAgentRoster {...props} />
    </Suspense>
  )
}
const ModalDialog = lazy(() =>
  import('@adea-ai/ui/components/ui/modal-dialog').then((module) => ({
    default: module.ModalDialog,
  }))
)
const WorkspaceSearchDialog = lazy(() =>
  import('./workspace-utility-dialogs').then((module) => ({
    default: module.WorkspaceSearchDialog,
  }))
)
const WorkspaceSettingsDialog = lazy(() =>
  import('./workspace-settings').then((module) => ({ default: module.WorkspaceSettingsDialog }))
)
const WorkspaceDetailsDialog = lazy(() =>
  import('./workspace-details-dialog').then((module) => ({
    default: module.WorkspaceDetailsDialog,
  }))
)

type DialogId =
  | 'conversation-search'
  | 'create-group'
  | 'create-project'
  | 'details'
  | 'search'
  | 'settings'
  | 'workspace-settings'
  | null

export type { WorkspaceNavHost } from './workspace-nav-sidebar'

export type WorkspaceDeepLink = Readonly<{
  channel?: string
  message?: string
  task?: string
  thread?: string
  workspace?: string
}>

export function ConventionalWorkspaceShell(props: {
  /** The signed-in owner for the sidebar's creation draft; absent for guests and unknown identities. */
  creationContext?: WorkspaceCreationContext
  /** Router-backed deep link state. Reactive, so links apply on SPA navigation. */
  deepLink?: () => WorkspaceDeepLink
  /** Shared archived-session affordance at the end of the common sidebar. */
  archiveAction?: JSX.Element
  restoreFocusRef?: () => HTMLElement | undefined
  /** Render only the task board, full width with no workspace sidebar: the Kanban app. */
  taskBoardOnly?: boolean
  /**
   * Render the Chat surfaces without the workspace sidebar, for a host that
   * keeps its own sidebar beside them (the desktop runtime Chat, ADR 0011).
   */
  embedded?: boolean
  /**
   * Opens the standalone task board, when the host has one. Search results and
   * deep links to a Task go there; without it the board opens in place.
   */
  onOpenTaskBoard?: () => void
  manageSettings?: boolean
  /** Called after a deep link applies — the host removes its params. */
  onConsumeDeepLink?: () => void
  /**
   * Reports whether this shell renders its bootstrap fallback (skeleton or
   * error) instead of the workspace with its contextual sidebar. Hosts with a
   * frame top bar hide the sidebar toggle while nothing it controls renders.
   */
  onBootstrapFallbackChange?: (fallback: boolean) => void
  onViewChange?: (view: WorkspaceView) => void
  services?: WorkspacePlatformServices
  view?: WorkspaceView
  /**
   * The host's detailed create-project flow, sampled when "Add project"
   * opens: present, the Dev dialog runs (name the project, optionally bind a
   * repository); absent, the basic create dialog stays. Hosts without a Dev
   * Runtime simply omit it.
   */
  createProjectFlow?: () => DevProjectFlow | undefined
  /**
   * The integrated frame's workspace switching. Without it the sidebar lists
   * the bootstrap workspaces and switches through the workspace store.
   */
  workspaceHost?: WorkspaceNavHost
}) {
  const services = () => props.services
  const controller = useWorkspaceController(services()?.client)
  const prefetchChannelMessages = usePrefetchChannelMessages(
    services()?.client ?? createApiClient(),
    () => controller.workspaceId
  )
  const [dialog, setDialog] = createSignal<DialogId>(null)
  const [accountBusy, setAccountBusy] = createSignal(false)
  const [online, setOnline] = createSignal(true)
  const [searchTargetMessageId, setSearchTargetMessageId] = createSignal<string | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = createSignal<string | null>(null)
  const [sessionNoticeDismissed, setSessionNoticeDismissed] = createSignal(false)
  const chatSurface = useWorkspaceState((state) => state.activeSurface)
  const activeSurface = () => (props.taskBoardOnly ? 'tasks' : chatSurface())
  const setSurface = (surface: 'agents' | 'conversation' | 'tasks') => {
    if (props.taskBoardOnly && surface === 'tasks') return
    if (surface === 'tasks' && props.onOpenTaskBoard) {
      props.onOpenTaskBoard()
      return
    }
    workspaceStore.getState().setActiveSurface(surface)
    if (props.taskBoardOnly) props.onViewChange?.('chat')
  }
  const globalPanel = useWorkspaceState((state) => state.globalPanel)
  const collapsedProjectIds = useWorkspaceState((state) => state.collapsedProjectIds)
  const drafts = useWorkspaceState((state) => state.drafts)
  const mobileSidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const selectedAgentId = useWorkspaceState((state) => state.selectedAgentId)
  const selectedChannelId = useWorkspaceState((state) => state.selectedChannelId)
  const selectedTaskId = useWorkspaceState((state) => state.selectedTaskId)
  const threadRootMessageId = useWorkspaceState((state) => state.threadRootMessageId)
  const sessionRotated = () => settledData(controller.bootstrap)?.sessionRotated ?? false
  const sessionIdentity = () => settledData(controller.bootstrap)?.principal.userId
  const principal = () => settledData(controller.bootstrap)?.principal
  const accountAuthenticated = () =>
    services()?.account?.authenticated ?? Boolean(principal() && !principal()?.temporary)
  const accountLabel = () =>
    services()?.account?.label ??
    (accountAuthenticated() ? (principal()?.displayName ?? 'Account') : 'Sign in')

  createEffect(on(sessionIdentity, () => setSessionNoticeDismissed(false), { defer: true }))

  // Exactly the render condition of the fallback mains below: while it holds,
  // no contextual sidebar is mounted, so a frame top bar has nothing for its
  // sidebar toggle to control.
  createEffect(() => {
    props.onBootstrapFallbackChange?.(
      controller.bootstrap.isPending ||
        controller.bootstrap.isError ||
        !controller.persistenceReady ||
        !(controller.activeWorkspace && controller.workspaceId)
    )
  })

  const selectChannel = (channelId: string, projectId?: string) => {
    setSelectedArtifactId(null)
    setSearchTargetMessageId(null)
    controller.selectChannel(channelId, projectId)
    setSurface('conversation')
    // Selecting a conversation collapses the drawer only on narrow
    // viewports; at wider widths the sidebar stays as the user left it.
    if (window.matchMedia('(max-width: 48rem)').matches)
      workspaceStore.getState().setMobileSidebarOpen(false)
  }

  createEffect(() => {
    const panel = globalPanel()
    if ((panel === 'settings' || panel === 'workspace-settings') && !(props.manageSettings ?? true))
      return
    if (panel !== 'search' && panel !== 'settings' && panel !== 'workspace-settings') return
    setDialog(panel)
    workspaceStore.getState().setGlobalPanel(null)
  })

  createEffect(() => {
    if (!(props.manageSettings ?? true)) return
    // Captures setDialog from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const openDeepLinkedSettings = () => {
      // Workspace settings links (and the retired `#settings/workspace|memory|
      // skills|connections` ones) open the workspace dialog, not app Settings.
      if (workspaceSettingsSectionFromHash(window.location.hash)) setDialog('workspace-settings')
      else if (window.location.hash.startsWith('#settings')) setDialog('settings')
    }
    openDeepLinkedSettings()
    window.addEventListener('hashchange', openDeepLinkedSettings)
    onCleanup(() => window.removeEventListener('hashchange', openDeepLinkedSettings))
  })

  createEffect(() => {
    // Captures setOnline from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const updateOnlineStatus = () => setOnline(navigator.onLine)
    updateOnlineStatus()
    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    onCleanup(() => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    })
  })

  createEffect(() => {
    // Captures the shell's dialog and pane signals from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const onKeyDown = (event: KeyboardEvent) => {
      const editableTarget =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      const targetInClosingDialog =
        dialog() === null &&
        event.target instanceof HTMLElement &&
        Boolean(event.target.closest('[role="dialog"]'))
      const editable = editableTarget && !targetInClosingDialog
      if (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        setDialog('search')
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f' &&
        controller.selectedChannel &&
        !editable
      ) {
        event.preventDefault()
        setDialog('conversation-search')
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        void controller.readStateActions.markAllRead()
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'u' &&
        controller.selectedChannel
      ) {
        event.preventDefault()
        void controller.readStateActions.markChannel({
          action: 'unread',
          channelId: controller.selectedChannel.id,
        })
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        document.querySelector<HTMLTextAreaElement>('textarea[id^="composer-"]')?.focus()
      }
      if (event.altKey && !editable && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const destinations = controller.channels.filter(
          ({ lifecycleState }) => lifecycleState === 'active'
        )
        if (destinations.length) {
          event.preventDefault()
          const current = Math.max(
            destinations.findIndex(({ id }) => id === selectedChannelId()),
            0
          )
          const direction = event.key === 'ArrowDown' ? 1 : -1
          const next = (current + direction + destinations.length) % destinations.length
          selectChannel(destinations[next]!.id, destinations[next]!.projectId)
        }
      }
      if (event.key === 'Escape' && threadRootMessageId())
        workspaceStore.getState().setThreadRootMessageId(null)
      if (event.key === 'Escape' && selectedArtifactId()) setSelectedArtifactId(null)
    }
    // Capture workspace shortcuts before a portalled dialog's focus trap can
    // stop propagation while it restores focus after closing.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener('keydown', onKeyDown, { capture: true }))
  })

  createEffect(() => {
    document.title = controller.activeWorkspace
      ? `${controller.activeWorkspace.name} | Adea`
      : 'Adea'
  })

  // Deep links are read through the host's accessor when one is provided —
  // reactive to router search, so links apply on SPA navigation, not just at
  // mount. The URL fallback covers hosts without a router.
  const deepLinkQuery = (): WorkspaceDeepLink => {
    if (props.deepLink) return props.deepLink()
    const query = new URLSearchParams(window.location.search)
    return {
      channel: query.get('channel') ?? undefined,
      message: query.get('message') ?? undefined,
      task: query.get('task') ?? undefined,
      thread: query.get('thread') ?? undefined,
      workspace: query.get('workspace') ?? undefined,
    }
  }
  const consumeDeepLink = () => {
    if (props.onConsumeDeepLink) {
      props.onConsumeDeepLink()
      return
    }
    const url = new URL(window.location.href)
    for (const key of ['channel', 'thread', 'message', 'task', 'workspace'])
      url.searchParams.delete(key)
    window.history.replaceState(null, '', url)
  }
  createEffect(() => {
    const query = deepLinkQuery()
    // A link to another workspace the member belongs to (an accepted
    // invitation opens `/?workspace=<id>`) switches to it first; an unknown id
    // is ignored by selectWorkspace.
    if (query.workspace && controller.workspaceId && query.workspace !== controller.workspaceId) {
      controller.selectWorkspace(query.workspace)
      return
    }
    if (!controller.workspaceId || !controller.channels.length) return
    if (query.workspace && query.workspace !== controller.workspaceId) return
    const channelId = query.channel
    const taskId = query.task
    if (!channelId && !taskId && query.workspace) {
      // A workspace-only link has nothing further to select.
    } else if (channelId && controller.channels.some(({ id }) => id === channelId)) {
      const channel = controller.channels.find(({ id }) => id === channelId)!
      selectChannel(channel.id, channel.projectId)
      workspaceStore.getState().setThreadRootMessageId(query.thread ?? null)
      setSearchTargetMessageId(query.message ?? null)
    } else if (taskId && controller.tasks.some(({ id }) => id === taskId)) {
      workspaceStore.getState().setSelectedTaskId(taskId)
      setSurface('tasks')
    } else return
    // Consume the deep link: it applies once. Leaving the params in the URL
    // would re-select the stale destination every time the channel list
    // changes and re-runs this effect.
    consumeDeepLink()
  })

  const selectSearchResult = (result: SearchResult) => {
    if (result.kind === 'settings') {
      setDialog('settings')
      return
    }
    if (result.kind === 'action' && result.id === 'mark-all-read') {
      void controller.readStateActions.markAllRead()
      return
    }
    if (result.kind === 'channel') return selectChannel(result.id)
    if (result.kind === 'project') {
      const item = controller.navigation().projects.find(({ project }) => project.id === result.id)
      if (item?.selectionChannelId) selectChannel(item.selectionChannelId, item.project.id)
      return
    }
    if (result.kind === 'agent') {
      setSelectedArtifactId(null)
      workspaceStore.getState().setSelectedAgentId(result.id)
      setSurface('agents')
      return
    }
    if (result.kind === 'message' && result.channelId) {
      selectChannel(result.channelId, result.projectId)
      workspaceStore.getState().setThreadRootMessageId(result.threadRootMessageId ?? null)
      setSearchTargetMessageId(result.messageId ?? result.id)
      return
    }
    if (result.kind === 'artifact') {
      setSelectedArtifactId(result.id)
      return
    }
    workspaceStore.getState().setSelectedTaskId(result.id)
    setSelectedArtifactId(null)
    setSurface('tasks')
  }

  const workspaceHost = (): WorkspaceNavHost =>
    props.workspaceHost ?? {
      workspaces: settledData(controller.bootstrap)?.workspaces ?? [],
      onSwitchWorkspace: (workspace) => controller.selectWorkspace(workspace.id),
      onOpenWorkspaceSettings:
        (props.manageSettings ?? true)
          ? () => {
              window.history.replaceState(null, '', workspaceSettingsHash('general'))
              setDialog('workspace-settings')
            }
          : undefined,
    }

  const signOut = async () => {
    setAccountBusy(true)
    try {
      await services()?.account?.onSignOut()
    } finally {
      setAccountBusy(false)
    }
  }

  return (
    <Show
      when={!controller.bootstrap.isPending && controller.persistenceReady}
      fallback={
        <main class="conventional-workspace conventional-workspace--loading">
          <WorkspaceSkeleton />
        </main>
      }
    >
      <Show
        when={!controller.bootstrap.isError}
        fallback={
          <main class="conventional-workspace conventional-workspace--loading">
            <WorkspaceError
              error={controller.bootstrap.error}
              retry={() => void controller.bootstrap.refetch()}
            />
          </main>
        }
      >
        <Show when={controller.activeWorkspace && controller.workspaceId}>
          <main
            class={cn('conventional-workspace', {
              'conventional-workspace--board': props.taskBoardOnly || props.embedded,
            })}
          >
            <Show when={!props.taskBoardOnly && !props.embedded}>
              <WorkspaceNavSidebar
                view="chat"
                client={controller.client}
                creationContext={props.creationContext}
                activeWorkspace={controller.activeWorkspace}
                host={workspaceHost()}
                archiveAction={props.archiveAction}
                agents={controller.agents}
                restoreFocusRef={props.restoreFocusRef}
                channelBusy={controller.channelBusy}
                collapsedProjectIds={collapsedProjectIds()}
                mobileOpen={mobileSidebarOpen()}
                navigation={controller.navigation()}
                tasks={controller.tasks}
                taskBusy={controller.taskBusy}
                onArchiveChannel={controller.channelActions.archive}
                onArchiveTask={controller.taskActions.archive}
                onCreateGroup={() => setDialog('create-group')}
                onCreateProject={() => setDialog('create-project')}
                onRenameChannel={controller.channelActions.rename}
                onRenameTask={(task, title) => controller.taskActions.update(task, { title })}
                onOpenAgents={() => {
                  setSelectedArtifactId(null)
                  setSurface('agents')
                }}
                onOpenTask={(task) => {
                  setSelectedArtifactId(null)
                  workspaceStore.getState().setSelectedTaskId(task.id)
                  setSurface('tasks')
                }}
                onMarkAllRead={() => controller.readStateActions.markAllRead()}
                onChannelIntent={prefetchChannelMessages}
                onSelectChannel={selectChannel}
                onToggleMobile={(open) => workspaceStore.getState().setMobileSidebarOpen(open)}
                onToggleProject={(projectId) =>
                  workspaceStore.getState().toggleProjectCollapsed(projectId)
                }
                onUpdateProject={controller.projectActions.update}
                projectBusy={controller.projectBusy}
                selectedChannelId={selectedChannelId()}
                readState={controller.readState}
                share={
                  controller.workspaceId
                    ? {
                        client: controller.client,
                        currentUserId: sessionIdentity(),
                        workspaceId: controller.workspaceId,
                      }
                    : undefined
                }
              />
            </Show>

            <section id="workspace-main" class="conventional-main" tabIndex={-1}>
              <Show when={sessionRotated() && !sessionNoticeDismissed()}>
                <section class="conventional-session-notice" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <div>
                    <h2>Your previous session wasn&apos;t recognized</h2>
                    <p>
                      You&apos;re in a new temporary workspace, so earlier tasks and conversations
                      aren&apos;t visible here. Choose your previous workspace under Workspaces in
                      the sidebar to return to it if it&apos;s still available.
                    </p>
                  </div>
                  <ActionButton
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    tooltip="Dismiss this session notice"
                    aria-label="Dismiss session notice"
                    onClick={() => setSessionNoticeDismissed(true)}
                  >
                    <X aria-hidden="true" />
                  </ActionButton>
                </section>
              </Show>
              {/* Only a query that failed with no data may replace the
                  surface. A background refetch that fails keeps its data
                  (`isRefetchError`) and must leave the rendered board,
                  conversation and agents in place. */}
              <Show
                when={!controller.workspaceQueries.find(({ isLoadingError }) => isLoadingError)}
                fallback={(() => {
                  const queryError = controller.workspaceQueries.find(
                    ({ isLoadingError }) => isLoadingError
                  )!
                  return (
                    <WorkspaceError
                      error={queryError.error}
                      retry={() => void queryError.refetch()}
                    />
                  )
                })()}
              >
                <Show
                  when={controller.artifacts.find(({ id }) => id === selectedArtifactId())}
                  fallback={
                    <Show
                      when={activeSurface() === 'conversation'}
                      fallback={
                        <Show
                          when={activeSurface() === 'agents'}
                          fallback={
                            <TaskBoard
                              agents={controller.agents}
                              busy={controller.taskBusy}
                              onArchive={controller.taskActions.archive}
                              onAssign={controller.taskActions.assign}
                              onCancel={controller.taskActions.cancel}
                              onComplete={controller.taskActions.complete}
                              onCreate={controller.taskActions.create}
                              onDependencies={controller.taskActions.dependencies}
                              onMoveProject={controller.taskActions.moveProject}
                              onUpdate={controller.taskActions.update}
                              onOpenConversation={(task) =>
                                void controller.taskActions
                                  .openConversation(task)
                                  .then(() => setSurface('conversation'))
                              }
                              onQueue={controller.taskActions.queue}
                              onReview={controller.taskActions.review}
                              onSelect={(taskId) =>
                                workspaceStore.getState().setSelectedTaskId(taskId)
                              }
                              onStart={controller.taskActions.start}
                              privateContent={services()?.privateContent}
                              projects={controller.projects}
                              selectedTaskId={selectedTaskId()}
                              tasks={controller.tasks}
                            />
                          }
                        >
                          <AgentRoster
                            leadStatus={
                              <Suspense
                                fallback={<p role="status">Checking the workspace lead…</p>}
                              >
                                <WorkspaceLeadStatus
                                  client={controller.client}
                                  workspaceId={controller.workspaceId!}
                                  agents={controller.agents}
                                  onProvisioned={() => void controller.refreshAgents()}
                                />
                              </Suspense>
                            }
                            agents={controller.agents}
                            busy={controller.createAgentBusy || controller.agentBusy}
                            onArchive={controller.agentActions.archive}
                            onCreate={controller.createAgent}
                            onMessage={async (agentId) => {
                              await controller.openAgentConversation(agentId)
                              setSurface('conversation')
                            }}
                            onUpdate={async (agent, input) => {
                              // Presentation and placement share one Agent revision. Each saved edit
                              // names the revision it opened, and the next edit chains the revision
                              // the server returned; a superseded opening conflicts without writing.
                              let revision = agent.revision ?? 0
                              if (
                                input.name.trim() !== agent.name ||
                                input.roleSummary !== (agent.roleSummary ?? null) ||
                                input.avatarRef !== (agent.avatarRef ?? null) ||
                                input.characterRef !== (agent.characterRef ?? null)
                              )
                                revision =
                                  (
                                    await controller.agentActions.presentation(agent.id, {
                                      avatarRef: input.avatarRef,
                                      characterRef: input.characterRef,
                                      expectedRevision: revision,
                                      name: input.name,
                                      roleSummary: input.roleSummary,
                                    })
                                  ).revision ?? revision + 1
                              if (input.projectId !== (agent.projectId ?? null))
                                await controller.agentActions.assignProject(
                                  agent.id,
                                  input.projectId,
                                  revision
                                )
                              if (
                                input.profileId.trim() !== agent.profile.id ||
                                input.profileVersion.trim() !== agent.profile.version
                              )
                                await controller.agentActions.profile(agent.id, {
                                  expectedRevision: agent.profile.revision ?? 0,
                                  profileId: input.profileId,
                                  profileVersion: input.profileVersion,
                                })
                            }}
                            projects={controller.projects}
                          />
                        </Show>
                      }
                    >
                      <ConversationSurface
                        agents={controller.agents}
                        artifacts={controller.artifacts}
                        channel={controller.selectedChannel}
                        client={controller.client}
                        draft={selectedChannelId() ? (drafts()[selectedChannelId()!] ?? '') : ''}
                        onDraftChange={(value) =>
                          selectedChannelId() &&
                          workspaceStore.getState().setDraft(selectedChannelId()!, value)
                        }
                        onOpenDetails={() => setDialog('details')}
                        onOpenSearch={() => setDialog('conversation-search')}
                        onMarkRead={(lastReadSequence) =>
                          controller.readStateActions.markChannel({
                            action: 'read',
                            channelId: controller.selectedChannel!.id,
                            lastReadSequence,
                          })
                        }
                        onMarkThreadRead={(rootId, lastReadSequence) =>
                          controller.readStateActions.markThread({
                            action: 'read',
                            channelId: controller.selectedChannel!.id,
                            lastReadSequence,
                            threadRootMessageId: rootId,
                          })
                        }
                        onMarkThreadUnread={(rootId) =>
                          controller.readStateActions.markThread({
                            action: 'unread',
                            channelId: controller.selectedChannel!.id,
                            threadRootMessageId: rootId,
                          })
                        }
                        onMarkUnread={() =>
                          controller.readStateActions.markChannel({
                            action: 'unread',
                            channelId: controller.selectedChannel!.id,
                          })
                        }
                        onOpenTask={(taskId) => {
                          workspaceStore.getState().setSelectedTaskId(taskId)
                          setSurface('tasks')
                        }}
                        privateContent={services()?.privateContent}
                        onThreadChange={(messageId) =>
                          workspaceStore.getState().setThreadRootMessageId(messageId)
                        }
                        onThreadDraftChange={(value) =>
                          threadRootMessageId() &&
                          workspaceStore
                            .getState()
                            .setDraft(`thread:${threadRootMessageId()}`, value)
                        }
                        tasks={controller.tasks}
                        searchTargetMessageId={searchTargetMessageId()}
                        threadDraft={
                          threadRootMessageId()
                            ? (drafts()[`thread:${threadRootMessageId()}`] ?? '')
                            : ''
                        }
                        threadRootMessageId={threadRootMessageId()}
                        transcription={services()?.transcription}
                        workspaceId={controller.workspaceId!}
                      />
                    </Show>
                  }
                >
                  {(artifact) => (
                    <ArtifactDetail
                      artifact={artifact()}
                      dismiss={() => setSelectedArtifactId(null)}
                      openTask={(taskId) => {
                        workspaceStore.getState().setSelectedTaskId(taskId)
                        setSurface('tasks')
                        setSelectedArtifactId(null)
                      }}
                    />
                  )}
                </Show>
              </Show>
            </section>
            <Suspense fallback={null}>
              {/* Dialogs mount only while their id is active. Rendering every
                  lazy dialog unconditionally asks the browser for each chunk on
                  workspace mount (settings alone is ~108 KB raw), which is the
                  load-time half of the dynamic-import boundary. The dialog
                  primitives already mount only while open, so opening and
                  closing behaves exactly as before. */}
              <Show when={dialog() === 'create-project'}>
                <ProjectCreateDialog
                  busy={controller.createProjectBusy}
                  createProjectFlow={props.createProjectFlow}
                  workspace={controller.activeWorkspace!}
                  onImported={controller.refreshAfterProjectCreate}
                  onClose={() => setDialog(null)}
                  onCreate={controller.createProject}
                />
              </Show>
              <Show when={dialog() === 'create-group'}>
                <CreateGroupDialog
                  busy={controller.createGroupBusy}
                  onClose={() => setDialog(null)}
                  onCreate={controller.createGroup}
                  open
                />
              </Show>
              <Show when={dialog() === 'search' || dialog() === 'conversation-search'}>
                <WorkspaceSearchDialog
                  agents={controller.agents}
                  artifacts={controller.artifacts}
                  channels={controller.channels}
                  client={controller.client}
                  onChannelIntent={prefetchChannelMessages}
                  onClose={() => setDialog(null)}
                  online={online()}
                  onSelect={selectSearchResult}
                  open
                  privateContent={services()?.privateContent}
                  projects={controller.projects}
                  scopeChannelId={
                    dialog() === 'conversation-search' ? controller.selectedChannel?.id : undefined
                  }
                  tasks={controller.tasks}
                  workspaceId={controller.workspaceId!}
                />
              </Show>
              <Show when={(props.manageSettings ?? true) && dialog() === 'settings'}>
                <WorkspaceSettingsDialog
                  accountAuthenticated={accountAuthenticated()}
                  accountLabel={accountLabel()}
                  agents={controller.agents}
                  busy={services()?.account?.busy ?? accountBusy()}
                  onClose={() => setDialog(null)}
                  onOpenAgents={() => {
                    setSelectedArtifactId(null)
                    setSurface('agents')
                  }}
                  onSignIn={() => services()?.account?.onSignIn()}
                  onSignOut={() => void signOut()}
                  open
                  services={services()}
                  workspace={controller.activeWorkspace!}
                />
              </Show>
              <Show when={(props.manageSettings ?? true) && dialog() === 'workspace-settings'}>
                <WorkspaceDetailsDialog
                  onClose={() => setDialog(null)}
                  open
                  services={services()}
                  workspace={controller.activeWorkspace!}
                />
              </Show>
              <Show when={dialog() === 'details'}>
                <ModalDialog
                  modal={false}
                  class="max-h-full overflow-y-auto"
                  open
                  onClose={() => setDialog(null)}
                  title="Conversation details"
                  description="This conversation's identity and scope."
                >
                  <div class="grid gap-3">
                    <p class="border-border flex justify-between gap-4 border-b pb-3">
                      <span class="text-muted-foreground">Kind</span>
                      <strong>{controller.selectedChannel?.kind.replace('_', ' ')}</strong>
                    </p>
                    <p class="border-border flex justify-between gap-4 border-b pb-3">
                      <span class="text-muted-foreground">Visibility</span>
                      <strong>{controller.selectedChannel?.visibility}</strong>
                    </p>
                    <p class="border-border flex justify-between gap-4 border-b pb-3">
                      <span class="text-muted-foreground">Participants</span>
                      <strong>{controller.selectedChannel?.participants.length ?? 0}</strong>
                    </p>
                    <p class="border-border flex justify-between gap-4 border-b pb-3">
                      <span class="text-muted-foreground">Task link</span>
                      <strong>{controller.selectedChannel?.taskId ? 'Linked' : 'None'}</strong>
                    </p>
                  </div>
                </ModalDialog>
              </Show>
            </Suspense>
            <div class="visually-hidden" aria-live="polite">
              {online() ? 'Workspace online' : 'Workspace offline. Drafts remain on this device.'}
            </div>
            <Show when={selectedAgentId()}>
              <span class="visually-hidden">Selected Agent {selectedAgentId()}</span>
            </Show>
          </main>
        </Show>
      </Show>
    </Show>
  )
}
