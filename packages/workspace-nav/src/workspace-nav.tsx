import '@adea-ai/app-ui/workspace-nav.css'

import { useOptionalTheme } from '@adea-ai/app-ui/components/theme-provider'
import { paintWorkspaceAccent } from '@adea-ai/app-ui/components/workspace-accent'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { SidebarNavButton, SidebarNavLabel } from '@adea-ai/ui/components/layout/sidebar-nav'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Heading, Text } from '@adea-ai/ui/components/ui/typography'
import {
  AtSign,
  ChevronDown,
  CircleAlert,
  Inbox,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  Plus,
  Settings2,
} from 'lucide-solid'
import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  lazy,
  type JSX,
} from 'solid-js'

import { createViewAdapter, type NavMenuItemId, type NavView, type ViewAdapter } from './adapters'
import type { WorkspaceCreationContext } from './workspace-creation-context'
import {
  emptyWorkspaceHint,
  navGroupModes,
  needsYouFallbackGroupMode,
  sortWorkspaces,
  workspaceChips,
  type NavGroupMode,
  type NavLeaf,
  type NavProject,
  type NavTree,
  type NavWorkspace,
  type WorkspaceChip,
} from './model'
import { NavLeafTree } from './nav-leaf-tree'

// Creating a workspace is rare, so its inline row (and the shared Input it
// renders) loads on demand: hovering or focusing "New workspace" starts the
// import before the click mounts the row.
const loadWorkspaceDraftRow = () => import('./workspace-draft-row')
const WorkspaceDraftRow = lazy(() =>
  loadWorkspaceDraftRow().then((module) => ({ default: module.WorkspaceDraftRow }))
)

export { describeWorkspaceCreationContext } from './workspace-creation-context'
export type { WorkspaceCreationContext } from './workspace-creation-context'

export type WorkspaceNavProps = {
  tree: NavTree
  /** The view whose words and menus the tree uses; ignored when `adapter` is set. */
  view?: NavView
  adapter?: ViewAdapter
  /** Show "Switch branch…" on checkout menus when the default adapter is used. */
  branchSwitching?: boolean
  groupBy: NavGroupMode
  onGroupByChange: (mode: NavGroupMode) => void
  selectedLeafId?: string | null
  onSelectLeaf: (leaf: NavLeaf, project: NavProject) => void
  onSelectWorkspace: (workspaceId: string) => void
  onCreateWorkspace: (name: string) => void
  /**
   * Controlled inline-create state; omit to let the "New workspace" button own
   * it. While controlled, Enter keeps the draft row until the host closes it,
   * so a failed create can show `workspaceDraftError` beside the typed name.
   */
  creatingWorkspace?: boolean
  onCreatingWorkspaceChange?: (creating: boolean) => void
  /** Inline failure for the controlled draft; the typed name is kept. */
  workspaceDraftError?: string
  /**
   * Owner/placement facts for the inline draft's context line when the
   * host knows them; unknown labels render honestly. No host feeds this
   * today — the nav carries no account identity — so the row states the
   * generic owner sentence until one does.
   */
  creationContext?: WorkspaceCreationContext
  /** The controlled draft's create request is in flight. */
  workspaceDraftPending?: boolean
  onCreateProject?: (workspaceId: string) => void
  /**
   * The create affordance stays mounted while its action is unavailable (a
   * runtime scope still resolving, a workspace still preparing) — a disabled
   * control reads as "not yet", an absent one as "never".
   */
  createDisabled?: boolean
  onOpenWorkspaceSettings?: (workspaceId: string) => void
  onCreateLeaf?: (project: NavProject) => void
  onProjectMenuAction?: (id: NavMenuItemId, project: NavProject) => void
  onLeafMenuAction?: (id: NavMenuItemId, leaf: NavLeaf, project: NavProject) => void
  /** Hover or focus on a leaf, for prefetching what selecting it shows. */
  onLeafIntent?: (leaf: NavLeaf) => void
  /** Controlled collapsed projects of the active workspace. */
  collapsedProjectIds?: ReadonlySet<string>
  onProjectExpandedChange?: (projectId: string, expanded: boolean) => void
  /** "Needs you" strip activation; defaults to grouping by status. */
  onNeedsYou?: () => void
  /** Host quick actions (Agents, Mark all read) above the strip. */
  quickActions?: JSX.Element
  /** The host's global Conversations section. */
  conversations?: JSX.Element
  /** The host's footer (archive shelf). */
  footer?: JSX.Element
  portalMount?: HTMLElement
  /**
   * False inside a modal sheet: a focus tooltip there registers a top-most
   * dismissable layer that swallows the Escape meant to close the sheet.
   * Accessible names still carry every action.
   */
  tooltips?: boolean
  /** The navigation landmark's name. */
  label?: string
}

/**
 * WorkspaceNav.
 *
 * The shared contextual sidebar of ADR 0011: quick actions, the cross-workspace
 * "Needs you" strip, the workspace accordion (only the active workspace is
 * expanded; the others are one row each with status chips), the active
 * workspace's project tree in the chosen grouping, and the host's
 * Conversations and footer slots. Presentational only: every datum and action
 * arrives through props.
 */
export function WorkspaceNav(props: WorkspaceNavProps) {
  const adapter = createMemo(
    () =>
      props.adapter ??
      createViewAdapter(props.view ?? 'dev', { branchSwitching: props.branchSwitching })
  )
  const workspaces = createMemo(() => sortWorkspaces(props.tree.workspaces))
  const [ownCreating, setOwnCreating] = createSignal(false)
  const creating = () => props.creatingWorkspace ?? ownCreating()
  const setCreating = (next: boolean) => {
    if (props.creatingWorkspace === undefined) setOwnCreating(next)
    props.onCreatingWorkspaceChange?.(next)
  }
  const groupLabel = () =>
    navGroupModes.find((entry) => entry.mode === props.groupBy)?.label ?? 'Project'
  const headingId = `workspace-nav-heading-${createUniqueId()}`

  return (
    <nav
      aria-label={props.label ?? 'Workspaces'}
      data-slot="workspace-nav"
      class="flex min-w-0 flex-col gap-3"
    >
      <Show when={props.quickActions}>
        <div class="flex flex-col gap-0.5">{props.quickActions}</div>
      </Show>
      <Show when={props.tree.needsYou > 0}>
        <SidebarNavButton
          data-slot="workspace-nav-needs-you"
          aria-pressed={props.groupBy === needsYouFallbackGroupMode}
          onClick={() =>
            (props.onNeedsYou ?? (() => props.onGroupByChange(needsYouFallbackGroupMode)))()
          }
        >
          <Inbox aria-hidden="true" class="text-warning" />
          {/* The count sums every workspace, not just the open one. */}
          <SidebarNavLabel>Needs you · all workspaces</SidebarNavLabel>
          <Badge variant="warning" size="sm">
            {props.tree.needsYou}
          </Badge>
        </SidebarNavButton>
      </Show>
      <section
        aria-labelledby={headingId}
        data-slot="workspace-nav-workspaces"
        class="flex min-w-0 flex-col gap-0.5"
      >
        {/* The heading's actions stay visible: grouping and creating a
            workspace are primary affordances, not hover extras. */}
        <div class="flex min-w-0 items-center gap-1 py-1 ps-2 pe-1">
          <h2
            id={headingId}
            class="min-w-0 flex-1 truncate text-2xs font-medium tracking-wide text-sidebar-muted-foreground uppercase"
          >
            Workspaces
          </h2>
          <span class="flex shrink-0 items-center gap-0.5" data-slot="workspace-nav-actions">
            <DropdownMenu>
              {/* The current grouping is visible text, not only a tooltip. */}
              <DropdownMenuTrigger
                as={Button}
                variant="ghost"
                size="xs"
                aria-label={`Group by, currently ${groupLabel()}`}
                data-slot="workspace-nav-group-by"
              >
                <ListFilter aria-hidden="true" />
                <span>{groupLabel()}</span>
                <ChevronDown aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                hideArrow
                placement="bottom-end"
                gutter={4}
                portalMount={props.portalMount}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Group by</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={props.groupBy}
                    onChange={(value) => props.onGroupByChange(value as NavGroupMode)}
                  >
                    <For each={navGroupModes}>
                      {(entry) => (
                        <DropdownMenuRadioItem value={entry.mode} closeOnSelect>
                          <span class="flex min-w-0 flex-col">
                            <span>{entry.label}</span>
                            <Text variant="caption" tone="muted">
                              {entry.description}
                            </Text>
                          </span>
                        </DropdownMenuRadioItem>
                      )}
                    </For>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ActionButton
              variant="ghost"
              size="icon-xs"
              tooltip={props.tooltips === false ? undefined : 'New workspace'}
              aria-label="New workspace"
              onPointerEnter={() => void loadWorkspaceDraftRow()}
              onFocus={() => void loadWorkspaceDraftRow()}
              onClick={() => setCreating(true)}
            >
              <Plus aria-hidden="true" />
            </ActionButton>
          </span>
        </div>
        <For each={workspaces()}>
          {(workspace) => (
            <Show
              when={workspace.id === props.tree.activeWorkspaceId}
              fallback={
                <CollapsedWorkspaceRow
                  workspace={workspace}
                  onSelect={() => props.onSelectWorkspace(workspace.id)}
                />
              }
            >
              <ActiveWorkspace {...props} workspace={workspace} adapter={adapter()} />
            </Show>
          )}
        </For>
        <Suspense>
          <Show when={creating()}>
            <WorkspaceDraftRow
              controlled={props.creatingWorkspace !== undefined}
              error={props.workspaceDraftError}
              pending={props.workspaceDraftPending}
              creationContext={props.creationContext}
              onCreate={(name) => {
                // A host-owned draft stays open until the host closes it, so a
                // failure can be shown beside the name the user typed.
                if (props.creatingWorkspace === undefined) setCreating(false)
                props.onCreateWorkspace(name)
              }}
              onCancel={() => setCreating(false)}
            />
          </Show>
        </Suspense>
      </section>
      <Show when={props.conversations}>{props.conversations}</Show>
      <Show when={props.footer}>{props.footer}</Show>
    </nav>
  )
}

function ChipIcon(props: { chip: WorkspaceChip }) {
  return (
    <Switch>
      <Match when={props.chip.kind === 'needs_you'}>
        <CircleAlert aria-hidden="true" />
      </Match>
      <Match when={props.chip.kind === 'running'}>
        <LoaderCircle aria-hidden="true" />
      </Match>
      <Match when={props.chip.kind === 'mention'}>
        <AtSign aria-hidden="true" />
      </Match>
      <Match when={props.chip.kind === 'unread'}>
        <MessageSquare aria-hidden="true" />
      </Match>
    </Switch>
  )
}

const chipVariant = {
  needs_you: 'warning',
  running: 'info',
  mention: 'subtle',
  unread: 'secondary',
} as const

/** A collapsed workspace: one row whose click switches to it. */
function CollapsedWorkspaceRow(props: { workspace: NavWorkspace; onSelect: () => void }) {
  return (
    <SidebarNavButton
      data-workspace-id={props.workspace.id}
      aria-description="Switch to this workspace"
      onClick={() => props.onSelect()}
    >
      <span aria-hidden="true" class="flex shrink-0">
        <WorkspaceIdentityMark
          accent={props.workspace.accent}
          logo={props.workspace.logo}
          name={props.workspace.name}
          size="xs"
        />
      </span>
      <SidebarNavLabel>{props.workspace.name}</SidebarNavLabel>
      {/* The row keeps the name readable: the most urgent chip is shown,
          and every chip is announced. */}
      <Show when={workspaceChips(props.workspace)[0]}>
        {(chip) => (
          // The chip gives way before the name does: in a narrow column (or
          // at a large root size) it truncates while the name keeps width.
          <Badge
            variant={chipVariant[chip().kind]}
            size="sm"
            data-chip={chip().kind}
            aria-hidden="true"
            class="max-w-1/2 min-w-0 shrink"
          >
            <ChipIcon chip={chip()} />
            <span class="min-w-0 truncate">{chip().label}</span>
          </Badge>
        )}
      </Show>
      <Show when={workspaceChips(props.workspace).length > 0}>
        <span class="visually-hidden">
          {workspaceChips(props.workspace)
            .map((chip) => chip.label)
            .join(', ')}
        </span>
      </Show>
    </SidebarNavButton>
  )
}

/** The expanded, active workspace: its header actions and project tree. */
function ActiveWorkspace(
  props: WorkspaceNavProps & { workspace: NavWorkspace; adapter: ViewAdapter }
) {
  // The active workspace themes its own subtree: the header, project rows,
  // selection and focus rings follow its accent; a null accent inherits.
  const theme = useOptionalTheme()
  const [host, setHost] = createSignal<HTMLDivElement>()
  createEffect(() => {
    const element = host()
    if (element) paintWorkspaceAccent(element, props.workspace.accent, theme?.variantId() ?? '')
  })
  return (
    <div
      ref={setHost}
      class="flex min-w-0 flex-col gap-0.5"
      data-workspace-id={props.workspace.id}
      data-active-workspace=""
    >
      {/* The header lines up with the collapsed rows' leading edge
          (SidebarNavButton's px-3 + gap-2.5) so selecting a workspace never
          shifts its indentation. */}
      <div class="flex min-w-0 items-center gap-2.5 ps-3">
        <span aria-hidden="true" class="flex shrink-0">
          <WorkspaceIdentityMark
            accent={props.workspace.accent}
            logo={props.workspace.logo}
            name={props.workspace.name}
            size="xs"
          />
        </span>
        <span class="min-w-0 flex-1 truncate">
          <Heading as="h3" size="subsection">
            {props.workspace.name}
          </Heading>
        </span>
        <span class="flex shrink-0 items-center gap-0.5">
          <Show when={props.onCreateProject}>
            <ActionButton
              variant="ghost"
              size="icon-xs"
              disabled={props.createDisabled}
              tooltip={props.tooltips === false ? undefined : props.adapter.createProjectLabel}
              aria-label={`${props.adapter.createProjectLabel} in ${props.workspace.name}`}
              onClick={() => props.onCreateProject?.(props.workspace.id)}
            >
              <Plus aria-hidden="true" />
            </ActionButton>
          </Show>
          <Show when={props.onOpenWorkspaceSettings}>
            <ActionButton
              variant="ghost"
              size="icon-xs"
              tooltip={props.tooltips === false ? undefined : 'Workspace settings'}
              aria-label={`Workspace settings for ${props.workspace.name}`}
              onClick={() => props.onOpenWorkspaceSettings?.(props.workspace.id)}
            >
              <Settings2 aria-hidden="true" />
            </ActionButton>
          </Show>
        </span>
      </div>
      <Show
        when={(props.workspace.projects ?? []).length > 0}
        fallback={
          <p class="ps-9 pe-2 py-1" data-slot="workspace-nav-empty">
            <Text variant="caption" tone="muted">
              {emptyWorkspaceHint(props.adapter.nouns.project, {
                create: Boolean(props.onCreateProject) && props.createDisabled !== true,
                settings: Boolean(props.onOpenWorkspaceSettings),
              })}
            </Text>
          </p>
        }
      >
        <NavLeafTree
          label={`${props.workspace.name} ${props.adapter.nouns.project.toLowerCase()}s`}
          projects={props.workspace.projects ?? []}
          adapter={props.adapter}
          groupBy={props.groupBy}
          selectedLeafId={props.selectedLeafId}
          onSelectLeaf={props.onSelectLeaf}
          onCreateLeaf={props.onCreateLeaf}
          onProjectMenuAction={props.onProjectMenuAction}
          onLeafMenuAction={props.onLeafMenuAction}
          onLeafIntent={props.onLeafIntent}
          collapsedProjectIds={props.collapsedProjectIds}
          onProjectExpandedChange={props.onProjectExpandedChange}
          portalMount={props.portalMount}
          tooltips={props.tooltips}
        />
      </Show>
    </div>
  )
}
