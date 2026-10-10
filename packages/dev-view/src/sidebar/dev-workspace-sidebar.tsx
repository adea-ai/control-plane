/*
 * The Dev contextual sidebar (ADR 0011): the shared `WorkspaceNav` accordion,
 * Dev adapter, inside the resizable `ContextualSidebar` shell. The active
 * workspace lists its cloud projects, each joined with its local repository
 * binding; a bound project lists its checkout and worktrees. Selecting a leaf
 * opens that worktree's most recent session (starting one when it has none).
 * Other workspaces are one row each with running, needs-you, mention and
 * unread chips; selecting one switches through the host.
 *
 * Runtime reads stay bounded: one scope-wide worktree list and harness-run
 * read per refresh (mount, projection change, window becoming visible, and a
 * 30s poll while visible), and one `dev.worktree.diffSummary` batch for the
 * worktree rows on screen (≤50 ids), refreshed when that set changes, when a
 * watched worktree reports a status invalidation, or on visibility — never
 * per keystroke. Mutations load on first use.
 */
import { cn } from '@adea-ai/app-ui/lib/utils'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import type { Scope } from '@adea-ai/types/dev-runtime'
import { ContextualSidebar } from '@adea-ai/ui/components/layout/contextual-sidebar'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import {
  createViewAdapter,
  type NavMenuItem,
  type NavMenuItemId,
  type ViewAdapter,
} from '@adea-ai/workspace-nav/adapters'
import {
  needsYouFallbackGroupMode,
  nextWorkspaceNeedingYou,
  stabilizeNavTree,
  type NavLeaf,
  type NavProject,
} from '@adea-ai/workspace-nav/model'
import {
  createSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STEP,
} from '@adea-ai/workspace-nav/sidebar-width'
import { WorkspaceNav, type WorkspaceCreationContext } from '@adea-ai/workspace-nav/workspace-nav'
import {
  Show,
  Suspense,
  children,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js'

import type { DevProjectNames, DevRuntimeService } from '../platform'
import type { DevCleanupPlan } from './dev-nav-actions'
import {
  buildDevNavSource,
  fixtureRuns,
  leafIdForSession,
  sessionForLeaf,
  visibleDiffWorktreeIds,
  type DevNavAccountSummary,
  type DevNavBinding,
  type DevNavCloudProject,
  type DevNavDevSummary,
  type DevNavRun,
  type DevNavWorkspaceInput,
  type DevNavWorktreeRecord,
} from './dev-nav-model'
import { listDevHarnessRuns, listDevWorktrees, readDevDiffSummaries } from './dev-nav-runtime'
import type { TaskLifecycleState } from '@adea-ai/types'

const DevNameDialog = lazy(() =>
  import('./dev-nav-dialogs').then((module) => ({ default: module.DevNameDialog }))
)
const DevConfirmDialog = lazy(() =>
  import('./dev-nav-dialogs').then((module) => ({ default: module.DevConfirmDialog }))
)
const DevAddRepositoryDialog = lazy(() =>
  import('./dev-nav-dialogs').then((module) => ({ default: module.DevAddRepositoryDialog }))
)
const DevNewProjectDialog = lazy(() =>
  import('./dev-nav-dialogs').then((module) => ({ default: module.DevNewProjectDialog }))
)
const DevProjectSettingsDialog = lazy(() =>
  import('./dev-nav-dialogs').then((module) => ({ default: module.DevProjectSettingsDialog }))
)
const loadActions = () => import('./dev-nav-actions')

/** Leaf status follows harness runs; the poll stops while the window is hidden. */
export const DEV_NAV_POLL_MS = 30_000
const DIFF_INVALIDATION_DEBOUNCE_MS = 500

/**
 * What the host that owns the cloud workspace hands the Dev sidebar: the
 * member's workspaces, the active workspace's project list, the counts the
 * collapsed rows show, and the cloud mutations. Every field is optional so a
 * direct integration (or a fixture) mounts the sidebar with runtime data only.
 */
/** Where the sidebar is rendering a global section. */
export type DevGlobalNavContext = Readonly<{
  /** Inside the compact modal sheet: menus mount in it and tooltips are off. */
  mobile: boolean
  portalMount?: HTMLElement
  /** Closes the compact sheet after a navigation; a no-op inline. */
  closeSheet: () => void
}>

/**
 * The sections every view's sidebar carries regardless of the active
 * workspace's projects (ADR 0011): quick actions (Agents, Mark all read)
 * above the Workspaces accordion and Conversations below it. The host
 * renders them from its cloud data; the archive shelf is the footer.
 */
export type DevGlobalNavSlots = Readonly<{
  quickActions?: (context: DevGlobalNavContext) => JSX.Element
  conversations?: (context: DevGlobalNavContext) => JSX.Element
}>

export type DevWorkspaceNavHost = Readonly<{
  /** The global quick actions and Conversations, shared with Chat and Virtual. */
  globalNav?: DevGlobalNavSlots
  activeWorkspaceId?: string
  activeWorkspaceName?: string
  /** The signed-in owner for the inline creation draft; absent for guests and unknown identities. */
  creationContext?: WorkspaceCreationContext
  workspaces?: readonly DevNavWorkspaceInput[]
  /** The active workspace's cloud projects; undefined until the list settles. */
  projects?: readonly DevNavCloudProject[]
  /** Linked cloud task lifecycles by task id (in review shows on the leaf). */
  taskStates?: ReadonlyMap<string, TaskLifecycleState>
  accountSummary?: readonly DevNavAccountSummary[]
  /** The desktop `dev.summary.workspaces` counts, polled by the host. */
  devSummary?: readonly DevNavDevSummary[]
  onSwitchWorkspace?: (workspaceId: string) => void
  onCreateWorkspace?: (name: string) => Promise<void>
  onOpenWorkspaceSettings?: () => void
  /** Create a cloud project and resolve its id; the repository step binds it. */
  onCreateProject?: (name: string) => Promise<string>
  onRenameProject?: (projectId: string, name: string) => Promise<void>
  /** Record on the cloud project whether a repository backs it. */
  onSetProjectSource?: (projectId: string, sourceKind: 'none' | 'repository') => Promise<void>
  onArchiveProject?: (projectId: string) => Promise<void>
  /** Soft delete: the project leaves every listing and its id is never reused. */
  onDeleteProject?: (projectId: string) => Promise<void>
  onShareProject?: (projectId: string) => void
}>

export type DevWorkspaceSidebarProps = Readonly<{
  runtime: DevRuntimeService
  /** The bound runtime scope; absent in fixture mode and while unavailable. */
  scope?: Scope
  /** E2E/development fixtures: no runtime reads, statuses from session badges. */
  fixture?: boolean
  bindings: readonly DevNavBinding[]
  host?: DevWorkspaceNavHost
  projectNames?: DevProjectNames
  selectedProjectId: string
  selectedSessionId: string
  compactOpen: boolean
  onOpenChange: (open: boolean) => void
  wideViewportAtLoad: boolean
  restoreFocusRef?: () => HTMLElement | undefined
  /** The navigation landmark's name inside the sidebar. */
  navigationLabel?: string
  /**
   * Owner/placement facts for the inline draft's context line. Unknown labels
   * render honestly. Forwarded to the shared nav; an explicit prop wins over
   * the host's owner, which the web host feeds from the signed-in account.
   */
  creationContext?: WorkspaceCreationContext
  /** Dev-only status line above the tree (runtime unavailable). */
  status?: JSX.Element
  /** The archive shelf. */
  footer?: JSX.Element
  /** Select a session (or only a project when the leaf has none). */
  onSelectSession: (projectId: string, sessionId: string | null) => void
  /** The register changed (import, unbind, new session): reload the projection. */
  onBindingsChanged: () => void | Promise<void>
  /** The selected leaf's project and checked-out branch, for the top bar. */
  onSelectedLeafChange?: (
    leaf: Readonly<{ projectId: string; projectName: string; branch?: string }> | undefined
  ) => void
  announce: (message: string) => void
  /**
   * The host's native folder picker for the add surface's authorize step,
   * when the host has one; the typed path input remains the fallback.
   */
  pickFolder?: () => Promise<string | null | undefined>
  /** Registers an opener so center-pane empty states can start "New project". */
  registerAddProject?: (open: () => void) => void
}>

type DialogState =
  | Readonly<{ kind: 'new-worktree'; project: NavProject; repoId: string; baseRef: string }>
  | Readonly<{ kind: 'rename-worktree'; record: DevNavWorktreeRecord; label: string }>
  | Readonly<{ kind: 'rename-project'; projectId: string; name: string }>
  | Readonly<{ kind: 'archive-worktree'; record: DevNavWorktreeRecord; label: string }>
  | Readonly<{
      kind: 'delete-worktree'
      record: DevNavWorktreeRecord
      label: string
      plan: DevCleanupPlan
    }>
  | Readonly<{ kind: 'archive-project' | 'delete-project'; projectId: string; name: string }>
  | Readonly<{ kind: 'project-settings'; projectId: string; name: string }>
  | Readonly<{ kind: 'add-repository'; projectId: string; name: string }>
  | Readonly<{ kind: 'new-project' }>

/** A Dev deep link to a leaf's session (or its project when it has none). */
function leafLink(projectId: string, sessionId: string | undefined): string {
  const url = new URL(window.location.href)
  url.searchParams.set('view', 'dev')
  url.searchParams.set('devProject', projectId)
  if (sessionId) url.searchParams.set('devSession', sessionId)
  else url.searchParams.delete('devSession')
  return url.toString()
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function DevWorkspaceSidebar(props: DevWorkspaceSidebarProps) {
  // The footer arrives as an unmemoized JSX getter; resolve it once so the
  // inline panel and the mobile sheet move one instance (the archive shelf
  // keeps its expanded state across the crossing).
  const footer = children(() => props.footer)
  // One stored width with the Chat and Virtual navigation. The variable must
  // reach the workspace frame (the Dev top bar's section alignment reads it
  // there); hosts without a frame fall back to the dev workspace root.
  const sidebarWidth = createSidebarWidth({ fallbackRootSelector: '.dev-workspace' })
  const [worktrees, setWorktrees] = createSignal<readonly DevNavWorktreeRecord[]>([])
  const [runs, setRuns] = createSignal<readonly DevNavRun[]>([])
  const [diffs, setDiffs] = createSignal<ReadonlyMap<string, { added: number; removed: number }>>(
    new Map()
  )
  const [visible, setVisible] = createSignal(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  )
  const [actionError, setActionError] = createSignal<string>()
  const [dialog, setDialog] = createSignal<DialogState>()
  const [pendingLeafId, setPendingLeafId] = createSignal<string>()
  const [creatingWorkspace, setCreatingWorkspace] = createSignal(false)
  const [workspaceDraftError, setWorkspaceDraftError] = createSignal<string>()
  const [workspaceDraftPending, setWorkspaceDraftPending] = createSignal(false)
  const [diffTick, setDiffTick] = createSignal(0)

  const production = () => !props.fixture && Boolean(props.scope)
  const activeWorkspaceId = () =>
    props.host?.activeWorkspaceId ?? props.scope?.workspaceId ?? 'dev-workspace'
  const groupBy = useWorkspaceState(
    (state) => state.sidebarGroupBy[activeWorkspaceId()] ?? 'project'
  )
  // One collapse set with Chat and Virtual: they render the same cloud projects.
  const collapsedIds = useWorkspaceState((state) => state.collapsedProjectIds)
  const collapsed = createMemo(() => new Set(collapsedIds()))

  // Fixture statuses come from the session badges; production reads runs.
  const effectiveRuns = () => (props.fixture ? fixtureRuns(props.bindings) : runs())

  const built = createMemo(() =>
    buildDevNavSource({
      activeWorkspaceId: activeWorkspaceId(),
      activeWorkspaceName: props.host?.activeWorkspaceName,
      workspaces: props.host?.workspaces ?? [],
      // Fixtures are not cloud projects, so they are never joined against one.
      cloudProjects: props.fixture ? undefined : props.host?.projects,
      bindings: props.bindings,
      worktrees: worktrees(),
      runs: effectiveRuns(),
      diffs: diffs(),
      taskStates: props.host?.taskStates,
      accountSummary: props.host?.accountSummary,
      devSummary: props.host?.devSummary,
    })
  )
  // Rebuilds that change nothing keep the rendered rows (and their focus).
  const source = createMemo<ReturnType<typeof buildDevNavSource>>((previous) => {
    const next = built()
    return { ...next, tree: stabilizeNavTree(previous?.tree, next.tree) }
  })

  // A binding with no cloud project row is hidden; say so once per binding.
  const reportedHidden = new Set<string>()
  createEffect(() => {
    for (const id of source().hiddenBindingIds) {
      if (reportedHidden.has(id)) continue
      reportedHidden.add(id)
      console.warn(`[dev-sidebar] hiding local binding ${id}: no cloud project with this id`)
    }
  })

  // A leaf chosen before it has a session (one is starting, or a fixture leaf
  // has none) stays selected until the user picks elsewhere or the selection
  // moves to another project.
  createEffect(
    on(
      () => props.selectedProjectId,
      (projectId) => {
        const pending = untrack(pendingLeafId)
        if (pending && source().targets.get(pending)?.projectId !== projectId)
          setPendingLeafId(undefined)
      },
      { defer: true }
    )
  )
  const selectedLeafId = createMemo(
    () => pendingLeafId() ?? leafIdForSession(source(), props.selectedSessionId) ?? null
  )
  createEffect(() => {
    const leafId = selectedLeafId()
    const target = leafId ? source().targets.get(leafId) : undefined
    const projectId = target?.projectId ?? props.selectedProjectId
    const project = source()
      .tree.workspaces.find((workspace) => workspace.id === activeWorkspaceId())
      ?.projects?.find((candidate) => candidate.id === projectId)
    const leaf = project?.leaves.find((candidate) => candidate.id === leafId)
    props.onSelectedLeafChange?.(
      project
        ? {
            projectId: project.id,
            projectName: project.name,
            ...(leaf?.branchRef ? { branch: leaf.branchRef } : {}),
          }
        : undefined
    )
  })
  onCleanup(() => props.onSelectedLeafChange?.(undefined))

  // ─── Runtime reads ────────────────────────────────────────────────────────
  let refreshGeneration = 0
  const refresh = async () => {
    const scope = props.scope
    if (!production() || !scope) return
    const generation = ++refreshGeneration
    const [nextWorktrees, nextRuns] = await Promise.all([
      listDevWorktrees(props.runtime, scope),
      listDevHarnessRuns(props.runtime, scope),
    ])
    if (generation !== refreshGeneration) return
    if (nextWorktrees) setWorktrees(nextWorktrees)
    if (nextRuns) setRuns(nextRuns)
    setDiffTick((tick) => tick + 1)
  }

  // The scope and the register's sessions both change what the reads return.
  createEffect(
    on(
      () => [props.scope, props.bindings, props.fixture] as const,
      () => {
        if (!production()) {
          setWorktrees([])
          setRuns([])
          setDiffs(new Map())
          return
        }
        void refresh()
      }
    )
  )

  onMount(() => {
    if (typeof document === 'undefined') return
    // Captures the visibility signal and the refresh from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const onVisibility = () => {
      const next = document.visibilityState !== 'hidden'
      setVisible(next)
      if (next) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibility))
  })

  createEffect(() => {
    if (!visible() || !production()) return
    const timer = setInterval(() => void refresh(), DEV_NAV_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // One batched diff read for the worktree rows on screen. The key changes
  // only when the visible set does, so typing, hovering or selecting never
  // re-reads it.
  const diffKey = createMemo(() => visibleDiffWorktreeIds(source(), collapsed()).join(','))
  let diffGeneration = 0
  createEffect(() => {
    const key = diffKey()
    void diffTick()
    const scope = props.scope
    if (!production() || !scope || !visible()) return
    const ids = key ? key.split(',') : []
    const generation = ++diffGeneration
    void readDevDiffSummaries(props.runtime, scope, ids).then((next) => {
      if (generation !== diffGeneration || !next) return
      setDiffs(next)
    })
  })

  createEffect(() => {
    const scope = props.scope
    const events = production() && scope ? props.runtime.events?.() : undefined
    if (!events || !scope) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = events.on('git.statusInvalidated', scope, (event) => {
      if (!untrack(diffKey).split(',').includes(event.worktreeId)) return
      clearTimeout(timer)
      timer = setTimeout(() => setDiffTick((tick) => tick + 1), DIFF_INVALIDATION_DEBOUNCE_MS)
    })
    onCleanup(() => {
      clearTimeout(timer)
      unsubscribe()
    })
  })

  onMount(() => props.registerAddProject?.(() => openNewProject()))

  // ─── Adapter and menus ────────────────────────────────────────────────────
  const baseAdapter = createViewAdapter('dev')
  const projectMenu = (project: NavProject): readonly NavMenuItem[] => {
    const entry = source().projects.get(project.id)
    const host = props.host
    const items: NavMenuItem[] = []
    for (const item of baseAdapter.projectMenu(project)) {
      if (item.id === 'rename' && !(host?.onRenameProject && entry?.cloud)) continue
      if (item.id === 'settings' && !production()) continue
      if (item.id === 'share' && !host?.onShareProject) continue
      if (item.id === 'archive' && !(host?.onArchiveProject && entry?.cloud)) continue
      if (item.id === 'delete' && !(host?.onDeleteProject && entry?.cloud)) continue
      items.push(item)
      if (item.id === 'settings' && (!entry?.binding || entry.binding.source === 'none'))
        items.push({ id: 'add-repository', label: 'Add repository…' })
    }
    return items
  }
  // Leaf sharing ships separately; until then Share stays out of the menu.
  const leafMenu = (leaf: NavLeaf): readonly NavMenuItem[] =>
    baseAdapter.leafMenu(leaf).filter((item) => item.id !== 'share')
  const adapter: ViewAdapter = { ...baseAdapter, projectMenu, leafMenu }

  const fail = (text: string) => {
    setActionError(text)
    props.announce(text)
  }

  const copyText = (text: string, label: string) => {
    setActionError(undefined)
    void navigator.clipboard
      .writeText(text)
      .then(() => props.announce(`${label} copied.`))
      .catch(() => fail(`${label} could not be copied.`))
  }

  const leafLabel = (leaf: NavLeaf, project: NavProject) => adapter.leafLabel(leaf, project).text

  const runAction = async (
    run: (actions: Awaited<ReturnType<typeof loadActions>>, scope: Scope) => Promise<unknown>
  ) => {
    const scope = props.scope
    if (!scope) {
      fail('Dev Runtime is unavailable until its authenticated command channel is ready.')
      return
    }
    setActionError(undefined)
    await run(await loadActions(), scope)
  }

  const leafAction = (id: NavMenuItemId, leaf: NavLeaf, project: NavProject) => {
    const target = source().targets.get(leaf.id)
    const record = target?.worktree
    const label = leafLabel(leaf, project)
    if (id === 'copy-link') {
      copyText(leafLink(project.id, target ? sessionForLeaf(target) : undefined), 'Link')
      return
    }
    if (id === 'copy-path') {
      if (record?.canonicalRoot) copyText(record.canonicalRoot, 'Path')
      else fail('This checkout has no reported path yet.')
      return
    }
    if (!record) {
      fail(`${label} is not listed by the runtime yet.`)
      return
    }
    if (id === 'rename') setDialog({ kind: 'rename-worktree', record, label })
    else if (id === 'archive') setDialog({ kind: 'archive-worktree', record, label })
    else if (id === 'open-in-finder')
      void runAction(async (actions, scope) => {
        const result = await actions.openWorktreeExternally(props.runtime, scope, record)
        if (!result.ok) fail(`${label} could not be opened: ${result.message}`)
      })
    else if (id === 'delete')
      void runAction(async (actions, scope) => {
        const plan = await actions.planWorktreeCleanup(props.runtime, scope, record)
        if (!plan.ok) fail(`${label} cannot be deleted: ${plan.message}`)
        else setDialog({ kind: 'delete-worktree', record, label, plan: plan.value })
      })
  }

  const projectAction = (id: NavMenuItemId, project: NavProject) => {
    setActionError(undefined)
    if (id === 'rename')
      setDialog({ kind: 'rename-project', projectId: project.id, name: project.name })
    else if (id === 'settings')
      setDialog({ kind: 'project-settings', projectId: project.id, name: project.name })
    else if (id === 'add-repository')
      setDialog({ kind: 'add-repository', projectId: project.id, name: project.name })
    else if (id === 'share') props.host?.onShareProject?.(project.id)
    else if (id === 'archive' || id === 'delete')
      setDialog({
        kind: id === 'archive' ? 'archive-project' : 'delete-project',
        projectId: project.id,
        name: project.name,
      })
  }

  const createLeaf = (project: NavProject) => {
    setActionError(undefined)
    const binding = source().projects.get(project.id)?.binding
    if (!binding || binding.source === 'none') {
      // A session runs in a worktree, so a project needs a repository first.
      if (production())
        setDialog({ kind: 'add-repository', projectId: project.id, name: project.name })
      else fail(`${project.name} has no local repository on this device.`)
      return
    }
    const checkout = [...source().targets.values()].find(
      (target) => target.projectId === project.id && target.worktree?.kind === 'primary'
    )?.worktree
    const repoId = checkout?.repoId ?? binding.repoIds?.[0] ?? binding.repository
    // New worktrees branch from the project's default base, else the
    // checkout's current branch.
    const baseRef = binding.branch || checkout?.headRef || checkout?.branchRef || 'HEAD'
    if (!repoId) {
      fail(`${project.name} has no registered repository to branch from.`)
      return
    }
    setDialog({ kind: 'new-worktree', project, repoId, baseRef })
  }

  const openNewProject = () => {
    if (!production()) return
    setActionError(undefined)
    setDialog({ kind: 'new-project' })
  }

  const switchWorkspace = (workspaceId: string) => props.host?.onSwitchWorkspace?.(workspaceId)

  // "Needs you" sums every workspace: activating it moves to the first other
  // workspace that needs the user, else groups this one by status.
  const openNeedsYou = () => {
    const next = nextWorkspaceNeedingYou(source().tree.workspaces, activeWorkspaceId())
    if (next && props.host?.onSwitchWorkspace) switchWorkspace(next.id)
    else workspaceStore.getState().setSidebarGroupBy(activeWorkspaceId(), needsYouFallbackGroupMode)
  }

  const createWorkspace = (name: string) => {
    const create = props.host?.onCreateWorkspace
    if (!create) {
      setCreatingWorkspace(false)
      return
    }
    setWorkspaceDraftError(undefined)
    setWorkspaceDraftPending(true)
    create(name)
      .then(() => setCreatingWorkspace(false))
      .catch(() => setWorkspaceDraftError('Workspace could not be created. Try again.'))
      .finally(() => setWorkspaceDraftPending(false))
  }

  const selectLeaf = (leaf: NavLeaf, project: NavProject, closeSheet: () => void) => {
    setActionError(undefined)
    const target = source().targets.get(leaf.id)
    if (!target) return
    const sessionId = sessionForLeaf(target, props.selectedSessionId)
    if (sessionId) {
      setPendingLeafId(undefined)
      props.onSelectSession(project.id, sessionId)
      closeSheet()
      return
    }
    setPendingLeafId(leaf.id)
    props.onSelectSession(project.id, null)
    closeSheet()
    const record = target.worktree
    if (!production() || !record) return
    const label = leafLabel(leaf, project)
    props.announce(`Starting a session on ${label}…`)
    void runAction(async (actions, scope) => {
      const created = await actions.createSessionOn(props.runtime, scope, project.id, record)
      if (!created.ok) {
        fail(`A session could not start on ${label}: ${created.message}`)
        return
      }
      await props.onBindingsChanged()
      if (pendingLeafId() === leaf.id) {
        setPendingLeafId(undefined)
        props.onSelectSession(project.id, created.value)
      }
    })
  }

  // ─── Dialog submissions ───────────────────────────────────────────────────
  const afterWorktreeChange = async () => {
    await refresh()
  }

  const submitNewWorktree = async (
    state: Extract<DialogState, { kind: 'new-worktree' }>,
    branchName: string
  ): Promise<string | undefined> => {
    const scope = props.scope
    if (!scope) return 'Dev Runtime is unavailable.'
    const actions = await loadActions()
    const result = await actions.createWorktree(props.runtime, scope, {
      projectId: state.project.id,
      repoId: state.repoId,
      baseRef: state.baseRef,
      branchName,
    })
    if (!result.ok) return result.message
    props.announce(`Worktree ${branchName} created in ${state.project.name}.`)
    await afterWorktreeChange()
    return undefined
  }

  const confirmProject = async (
    state: Extract<DialogState, { kind: 'archive-project' | 'delete-project' }>
  ): Promise<string | undefined> => {
    const host = props.host
    const run = state.kind === 'archive-project' ? host?.onArchiveProject : host?.onDeleteProject
    if (!run) return 'This project cannot be changed here.'
    try {
      await run(state.projectId)
    } catch (error) {
      return message(
        error,
        `${state.name} could not be ${state.kind === 'archive-project' ? 'archived' : 'deleted'}.`
      )
    }
    // The cloud project is gone from the list; its local binding goes with it.
    const binding = source().projects.get(state.projectId)?.binding
    const scope = props.scope
    if (binding && scope) {
      const actions = await loadActions()
      const unbound = await actions.unbindProject(
        props.runtime,
        scope,
        state.projectId,
        binding.version ?? 1
      )
      if (!unbound.ok) fail(`${state.name}'s local repository binding was kept: ${unbound.message}`)
      await props.onBindingsChanged()
    }
    props.announce(`${state.name} ${state.kind === 'archive-project' ? 'archived' : 'deleted'}.`)
    return undefined
  }

  const repositoryFlow = () => ({
    scope: props.scope!,
    execute: (command: Parameters<DevRuntimeService['execute']>[0]) =>
      props.runtime.execute(command),
    knownProjectNames: props.bindings.map((binding) => binding.name),
    announce: props.announce,
    ...(props.pickFolder ? { pickFolder: props.pickFolder } : {}),
  })

  const onRepositoryImported = async (projectId: string | undefined) => {
    if (projectId) await props.host?.onSetProjectSource?.(projectId, 'repository').catch(() => {})
    await props.onBindingsChanged()
  }

  const workspaceName = () =>
    source().tree.workspaces.find((workspace) => workspace.id === activeWorkspaceId())?.name ??
    'this workspace'

  return (
    <>
      <div class={cn('dev-sidebar', { 'dev-sidebar--open': props.compactOpen })}>
        <ContextualSidebar
          label="Workspace navigation"
          title={workspaceName()}
          open={props.compactOpen}
          onOpenChange={props.onOpenChange}
          wideViewportAtLoad={props.wideViewportAtLoad}
          restoreFocusRef={props.restoreFocusRef}
          width={sidebarWidth.width()}
          minimum={SIDEBAR_MIN_WIDTH}
          maximum={SIDEBAR_MAX_WIDTH}
          step={SIDEBAR_WIDTH_STEP}
          resizeLabel="Resize workspace navigation"
          sidebarClass="h-full w-full"
          titleVisibility="mobile"
          footerClass="max-h-1/2 overflow-y-auto"
          onSidebarElement={sidebarWidth.onSidebarElement}
          content={(context) => {
            const closeSheet = () => {
              if (context.mobile) props.onOpenChange(false)
            }
            const globalContext: DevGlobalNavContext = {
              mobile: context.mobile,
              portalMount: context.mobile ? context.portalMount() : undefined,
              closeSheet,
            }
            return (
              <WorkspaceNav
                label={props.navigationLabel ?? 'Workspaces'}
                creationContext={props.creationContext ?? props.host?.creationContext}
                tree={source().tree}
                adapter={adapter}
                groupBy={groupBy()}
                onGroupByChange={(mode) =>
                  workspaceStore.getState().setSidebarGroupBy(activeWorkspaceId(), mode)
                }
                selectedLeafId={selectedLeafId()}
                onSelectLeaf={(leaf, project) => selectLeaf(leaf, project, closeSheet)}
                onSelectWorkspace={(workspaceId) => {
                  switchWorkspace(workspaceId)
                  closeSheet()
                }}
                onCreateWorkspace={createWorkspace}
                creatingWorkspace={creatingWorkspace()}
                onCreatingWorkspaceChange={(creating) => {
                  setCreatingWorkspace(creating)
                  if (!creating) setWorkspaceDraftError(undefined)
                }}
                workspaceDraftError={workspaceDraftError()}
                workspaceDraftPending={workspaceDraftPending()}
                onCreateProject={props.fixture ? undefined : () => openNewProject()}
                createDisabled={!production()}
                onOpenWorkspaceSettings={
                  props.host?.onOpenWorkspaceSettings
                    ? () => {
                        props.host?.onOpenWorkspaceSettings?.()
                        closeSheet()
                      }
                    : undefined
                }
                onCreateLeaf={createLeaf}
                onProjectMenuAction={projectAction}
                onLeafMenuAction={leafAction}
                collapsedProjectIds={collapsed()}
                onProjectExpandedChange={(projectId, expanded) => {
                  if (expanded === collapsed().has(projectId))
                    workspaceStore.getState().toggleProjectCollapsed(projectId)
                }}
                onNeedsYou={openNeedsYou}
                portalMount={context.mobile ? context.portalMount() : undefined}
                tooltips={!context.mobile}
                quickActions={
                  props.host?.globalNav?.quickActions || props.status || actionError() ? (
                    <>
                      <Suspense fallback={null}>
                        {props.host?.globalNav?.quickActions?.(globalContext)}
                      </Suspense>
                      {props.status}
                      <Show when={actionError()}>
                        {(text) => (
                          <Alert variant="destructive">
                            <AlertDescription>{text()}</AlertDescription>
                          </Alert>
                        )}
                      </Show>
                    </>
                  ) : undefined
                }
                conversations={
                  props.host?.globalNav?.conversations ? (
                    <Suspense fallback={null}>
                      {props.host.globalNav.conversations(globalContext)}
                    </Suspense>
                  ) : undefined
                }
              />
            )
          }}
          footer={footer() ? () => footer() : undefined}
          onWidthChange={sidebarWidth.onWidthChange}
          onWidthCommit={sidebarWidth.onWidthCommit}
        />
      </div>
      <Suspense fallback={null}>
        <Show when={dialog()} keyed>
          {(state) => {
            // Captures the dialog signal from the component scope.
            // oxlint-disable-next-line unicorn/consistent-function-scoping
            const close = () => setDialog(undefined)
            if (state.kind === 'new-worktree')
              return (
                <DevNameDialog
                  title={`New worktree in ${state.project.name}`}
                  description={`Creates a branch from ${state.baseRef} in its own worktree.`}
                  label="Branch name"
                  placeholder="feature/my-change"
                  confirmLabel="Create worktree"
                  maxLength={200}
                  onSubmit={(branchName) => submitNewWorktree(state, branchName)}
                  onClose={close}
                />
              )
            if (state.kind === 'rename-worktree')
              return (
                <DevNameDialog
                  title={`Rename ${state.label}`}
                  description="The title stays on this device; the branch keeps its name."
                  label="Worktree title"
                  initialValue={state.record.title ?? ''}
                  confirmLabel="Rename"
                  allowEmpty
                  onSubmit={async (title) => {
                    const scope = props.scope
                    if (!scope) return 'Dev Runtime is unavailable.'
                    const actions = await loadActions()
                    const result = await actions.renameWorktree(
                      props.runtime,
                      scope,
                      state.record,
                      title
                    )
                    if (!result.ok) return result.message
                    await afterWorktreeChange()
                    return undefined
                  }}
                  onClose={close}
                />
              )
            if (state.kind === 'rename-project')
              return (
                <DevNameDialog
                  title={`Rename ${state.name}`}
                  description="The project's name is shared with everyone in this workspace."
                  label="Project name"
                  initialValue={state.name}
                  confirmLabel="Rename"
                  onSubmit={async (name) => {
                    try {
                      await props.host?.onRenameProject?.(state.projectId, name)
                      return undefined
                    } catch (error) {
                      return message(error, 'The project could not be renamed.')
                    }
                  }}
                  onClose={close}
                />
              )
            if (state.kind === 'archive-worktree')
              return (
                <DevConfirmDialog
                  title={`Archive ${state.label}?`}
                  description="The worktree leaves the sidebar. Its folder, branch and sessions are kept."
                  confirmLabel="Archive"
                  onConfirm={async () => {
                    const scope = props.scope
                    if (!scope) return 'Dev Runtime is unavailable.'
                    const actions = await loadActions()
                    const result = await actions.archiveWorktree(props.runtime, scope, state.record)
                    if (!result.ok) return result.message
                    props.announce(`${state.label} archived.`)
                    await afterWorktreeChange()
                    return undefined
                  }}
                  onClose={close}
                />
              )
            if (state.kind === 'delete-worktree')
              return (
                <DevConfirmDialog
                  title={`Delete ${state.label}?`}
                  description="This runs the cleanup plan below on this device. It cannot be undone."
                  steps={state.plan.steps}
                  blockers={state.plan.blockers}
                  consequences={state.plan.consequences
                    .filter((consequence) => !consequence.blocking)
                    .map((consequence) => consequence.detail)}
                  confirmLabel="Delete worktree"
                  destructive
                  onConfirm={async () => {
                    const scope = props.scope
                    if (!scope) return 'Dev Runtime is unavailable.'
                    const actions = await loadActions()
                    const result = await actions.commitWorktreeCleanup(
                      props.runtime,
                      scope,
                      state.record,
                      state.plan
                    )
                    if (!result.ok) return result.message
                    props.announce(`${state.label} deleted.`)
                    await afterWorktreeChange()
                    return undefined
                  }}
                  onClose={close}
                />
              )
            if (state.kind === 'archive-project' || state.kind === 'delete-project') {
              const archive = state.kind === 'archive-project'
              return (
                <DevConfirmDialog
                  title={`${archive ? 'Archive' : 'Delete'} ${state.name}?`}
                  description={
                    archive
                      ? 'The project leaves the sidebar for everyone; its history is kept. Its local repository binding on this device is removed; files are never touched.'
                      : 'The project leaves every list for everyone. This cannot be undone. Its local repository binding on this device is removed; files are never touched.'
                  }
                  confirmLabel={archive ? 'Archive project' : 'Delete project'}
                  destructive={!archive}
                  onConfirm={() => confirmProject(state)}
                  onClose={close}
                />
              )
            }
            if (state.kind === 'project-settings')
              return (
                <DevProjectSettingsDialog
                  {...repositoryFlow()}
                  projectId={state.projectId}
                  projectName={state.name}
                  bound={Boolean(source().projects.get(state.projectId)?.binding)}
                  projectNames={props.projectNames}
                  onRename={
                    props.host?.onRenameProject && source().projects.get(state.projectId)?.cloud
                      ? async (name) => {
                          try {
                            await props.host?.onRenameProject?.(state.projectId, name)
                            return undefined
                          } catch (error) {
                            return message(error, 'The project could not be renamed.')
                          }
                        }
                      : undefined
                  }
                  onAddRepository={() =>
                    setDialog({
                      kind: 'add-repository',
                      projectId: state.projectId,
                      name: state.name,
                    })
                  }
                  onClose={close}
                />
              )
            if (state.kind === 'add-repository')
              return (
                <DevAddRepositoryDialog
                  {...repositoryFlow()}
                  projectId={state.projectId}
                  projectName={state.name}
                  onImported={() => void onRepositoryImported(state.projectId)}
                  onClose={close}
                />
              )
            return (
              <DevNewProjectDialog
                {...repositoryFlow()}
                workspaceName={workspaceName()}
                onCreateProject={props.host?.onCreateProject}
                onImported={(projectId) => void onRepositoryImported(projectId)}
                onClose={close}
              />
            )
          }}
        </Show>
      </Suspense>
    </>
  )
}
