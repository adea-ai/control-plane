// The single workspace UI. Both lanes render this exact component: the web
// entry feeds it the cookie bootstrap, the desktop entry feeds it the shell
// session bootstrap. Anything desktop-only is a flag-guarded surface
// (`updates`, account handlers, `platform`), never a forked render tree.
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import { useNavigate, useSearch } from '@tanstack/solid-router'
import { useQueryClient } from '@tanstack/solid-query'
import type { AgentHqApiClient, ApiWorkspaceDeleteResponse } from '@adea-ai/api-client'
import { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type { AccountDirectoryAgent } from '@adea-ai/types/account-directory'
import {
  settledData,
  useAgentListQuery,
  useUpdateWorkspaceMutation,
  useReorderWorkspacesMutation,
  useWorkspaceListQuery,
} from '@adea-ai/data'
import { useWorkspaceEventStream } from '@adea-ai/data/provider'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { PanelRightClose, PanelRightOpen, Users, Inbox as InboxIcon } from 'lucide-solid'
import type { WorkspaceSummary } from '@adea-ai/types'
import type {
  WorkspacePlatformServices,
  WorkspacePluginsProvider,
} from '@adea-ai/workspace-ui/platform'
import { devProjectFlow, type DevProjectFlow } from '@adea-ai/workspace-ui/create-project-flow'
import type { RegistryPluginsProviderOptions } from '@adea-ai/workspace-ui/plugins'
import type { RailPreferencesV1 } from '@adea-ai/workspace-ui/rail-preferences'
import {
  defaultRailPreferences,
  railMoveAnnouncement,
  readRailPreferences,
  reorderRailItems,
  reorderRailItemsRelativeTo,
  writeRailPreferences,
} from '@adea-ai/workspace-ui/rail-preferences'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import {
  workspaceSettingsHash,
  workspaceSettingsSectionFromHash,
  type WorkspaceSettingsSection,
} from '@adea-ai/workspace-ui/workspace-settings-section'
import {
  createSharedDevUtilityOwner,
  createUnavailableDevUtilityRuntime,
  type SharedDevUtilityOwner,
} from '@adea-ai/dev-view/utility-owner'
import { GlobalWorkspaceRail } from '@adea-ai/workspace-ui/global-workspace-rail'
import type {
  WorkspaceDeepLink,
  WorkspaceNavHost,
} from '@adea-ai/workspace-ui/conventional-workspace-shell'
import { useOptionalTheme } from '@adea-ai/app-ui/components/theme-provider'
import { paintWorkspaceAccent } from '@adea-ai/app-ui/components/workspace-accent'
import {
  enabledWorkspaceApps,
  orderedWorkspaceApps,
  reorderWorkspaceAppsRelativeTo,
  resolveWorkspaceApp,
  setWorkspaceAppEnabled,
  workspaceApps,
  type WorkspaceAppId,
} from '@adea-ai/workspace-ui/workspace-apps'
import {
  devBreadcrumbs,
  type DevBreadcrumbSelection,
  type WorkspaceBreadcrumb,
} from '@adea-ai/workspace-ui/workspace-breadcrumbs'
import type { WorkspaceRunSummaryItem } from '@adea-ai/types/dev-runtime'
import { WorkspaceTopBar } from './workspace-top-bar'
import {
  conversationOpenPatch,
  directoryTitle,
  parseDirectorySection,
  watchAccountIdentity,
  type AccountDirectorySection,
} from '../lib/account-directory'
import { createDeepLinkAttempts } from '../lib/workspace-deep-link'
import { stripWorkspaceDeepLinkSearch } from '../lib/workspace-search'
import {
  createDevWorkspaceNavHost,
  type DevGlobalNavContext,
  type DevGlobalNavSlots,
  type DevWorkspaceNavHost,
} from '../lib/dev-workspace-nav-host'
import { RuntimeResourcesControl } from './runtime-resources-control'
import type { WorkspaceSearch } from '../start/routes/__root'
import { desktopMacPermissionsService } from '../lib/desktop-permissions'
import { bindDesktopChatPresentation } from '../lib/desktop-chat-presentation'
import { isDesktopRuntime, openExternalUrl, pickDesktopFolder } from '../lib/desktop-bridge'
import { adeaFeedbackUrl } from '../lib/feedback'
import lazyComponent from './lazy-component'
import type { WorkspaceShellProps } from './workspace-shell'

// The native updater is available in local development and packaged desktop,
// and excluded by the existing lane flag in the production web build.
declare const __ADEA_DESKTOP_COMPONENTS__: boolean
const VersionDialog = __ADEA_DESKTOP_COMPONENTS__
  ? lazyComponent(() => import('./version-dialog').then((module) => module.VersionDialog))
  : () => null

const AppLibraryPage = lazyComponent(
  () => import('@adea-ai/workspace-ui/app-library-page').then((module) => module.AppLibraryPage),
  { loading: () => <WorkspaceEntryLoading /> }
)

// The account-wide directory surface (M11.03) rides its own chunk like the
// App Library: opening it is the only thing that pays for it.
const AccountDirectorySurface = lazyComponent(
  () => import('./account-directory').then(({ AccountDirectorySurface: Surface }) => Surface),
  { loading: () => <WorkspaceEntryLoading /> }
)

const DevWorkspace = lazyComponent(
  () =>
    import('@adea-ai/dev-view').then(
      async ({
        DevWorkspaceEntry,
        createUnavailableDevRuntimeService: createUnavailableDevRuntimeServiceFromView,
      }) => {
        // Fixture mode is DEV-only (`devE2e=preserved`). Reading the fixture
        // workspace behind the build constant lets a production build drop
        // it from the Dev entry chunk instead of shipping dead data.
        const fixtures = import.meta.env.DEV
          ? await import('@adea-ai/dev-view').then(
              ({ devViewFixtureProjects, scaleDevFixtureProjects }) => ({
                devViewFixtureProjects,
                scaleDevFixtureProjects,
              })
            )
          : undefined
        return (entryProps: {
          fixture: boolean
          runtime?: WorkspacePlatformServices['devRuntime']
          toolbarMount?: HTMLElement
          sidebarActionMount?: HTMLElement
          sidebarOpener?: () => HTMLElement | undefined
          utilityOwner?: SharedDevUtilityOwner
          utilityHostOwnedByShell?: boolean
          deepLinkSelection?: () => { projectId?: string; sessionId?: string } | undefined
          onSelectionChange?: (selection: { projectId: string; sessionId: string | null }) => void
          onBreadcrumbChange?: (crumb: DevBreadcrumbSelection | undefined) => void
          workspaceNav?: DevWorkspaceNavHost
          pickFolder?: () => Promise<string | null | undefined>
        }) => {
          const unavailable =
            entryProps.runtime ??
            createUnavailableDevRuntimeServiceFromView({ reason: 'channel_unauthenticated' })
          const runtime = entryProps.fixture
            ? {
                ...unavailable,
                preferenceScope: () => ({
                  accountId: '00000000-0000-4000-8000-000000000001',
                  workspaceId: '00000000-0000-4000-8000-000000000002',
                  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
                }),
              }
            : unavailable
          // #666 render-cost case: a DEV-only URL param scales the fixture
          // workspace so the sidebar can be exercised at 1,000+ rows.
          const fixtureScale =
            import.meta.env.DEV && entryProps.fixture
              ? Number(new URLSearchParams(window.location.search).get('devSidebarScale') ?? '0')
              : 0
          return (
            <DevWorkspaceEntry
              projects={
                import.meta.env.DEV && entryProps.fixture && fixtures
                  ? fixtureScale > 1
                    ? fixtures.scaleDevFixtureProjects(
                        fixtures.devViewFixtureProjects,
                        fixtureScale
                      )
                    : fixtures.devViewFixtureProjects
                  : undefined
              }
              storage={typeof window === 'undefined' ? undefined : window.localStorage}
              runtime={runtime}
              toolbarMount={entryProps.toolbarMount}
              sidebarActionMount={entryProps.sidebarActionMount}
              sidebarOpener={entryProps.sidebarOpener}
              utilityOwner={entryProps.utilityOwner}
              utilityHostOwnedByShell={entryProps.utilityHostOwnedByShell}
              deepLinkSelection={entryProps.deepLinkSelection}
              onSelectionChange={entryProps.onSelectionChange}
              onBreadcrumbChange={entryProps.onBreadcrumbChange}
              workspaceNav={entryProps.workspaceNav}
              pickFolder={entryProps.pickFolder}
            />
          )
        }
      }
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)

const SourceControlView = lazyComponent(
  () =>
    Promise.all([
      import('@adea-ai/dev-view/source-control-app'),
      import('@adea-ai/dev-view/platform'),
    ]).then(
      ([
        { SourceControlApp },
        { createUnavailableDevRuntimeService: createSourceControlRuntime },
      ]) => {
        return (entryProps: {
          runtime?: WorkspacePlatformServices['devRuntime']
          toolbarMount?: HTMLElement
          onOpenDev(): void
        }) => (
          <SourceControlApp
            runtime={
              entryProps.runtime ??
              createSourceControlRuntime({ reason: 'channel_unauthenticated' })
            }
            toolbarMount={entryProps.toolbarMount}
            onOpenDev={entryProps.onOpenDev}
          />
        )
      }
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)
const SharedDevUtilityHost = lazyComponent(
  () => import('@adea-ai/dev-view/utility-host').then(({ SharedDevUtilityHost: Host }) => Host),
  { loading: () => null }
)

const SharedUtilityArchiveShelf = lazyComponent(
  () =>
    import('@adea-ai/dev-view/utility-archive-shelf').then(
      ({ SharedUtilityArchiveShelf: Shelf }) => Shelf
    ),
  { loading: () => null }
)

// The global sidebar sections (ADR 0011) for the Dev sidebar, which the
// desktop runtime Chat also uses; Chat and Virtual render their own.
const WorkspaceGlobalNav = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/global-nav-sections').then(
      ({ WorkspaceGlobalNav: Sections }) => Sections
    ),
  { loading: () => null }
)

const ConventionalWorkspace = lazyComponent(
  () =>
    import('./conventional-workspace-entry').then(
      ({ ConventionalWorkspaceEntry }) => ConventionalWorkspaceEntry
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)

// Development-only ChatView visual fixture (#536 evidence lane). The import is
// lazy and the mount is `import.meta.env.DEV`-gated, so production bundles
// never contain the fixture route.
const ChatVisualFixture = lazyComponent(
  () => {
    if (import.meta.env.DEV) {
      return import('@adea-ai/dev-view/chat/visual-fixture').then(
        ({ ChatVisualFixture: Fixture }) => Fixture
      )
    }
    return Promise.resolve(() => <WorkspaceEntryLoading />)
  },
  { loading: () => <WorkspaceEntryLoading /> }
)

const SpatialWorkspace = lazyComponent(
  () => import('./workspace-shell').then(({ WorkspaceShell }) => WorkspaceShell),
  { loading: () => <WorkspaceEntryLoading /> }
)

const CharacterDesignerWorkspace = lazyComponent(() =>
  import('./character-designer-entry').then(({ CharacterDesignerEntry }) => CharacterDesignerEntry)
)

const RoomDesignerWorkspace = lazyComponent(
  () => import('./room-designer-entry').then(({ RoomDesignerEntry }) => RoomDesignerEntry),
  { loading: () => <WorkspaceEntryLoading /> }
)

const WorkspaceAboutDialog = lazyComponent(
  () =>
    import('@adea-ai/ui/components/composites/about-dialog').then(({ AboutDialog }) => AboutDialog),
  { ssr: false }
)

const WorkspaceHelpCenter = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/workspace-help-center').then(
      ({ WorkspaceHelpCenter: HelpCenter }) => HelpCenter
    ),
  { ssr: false }
)

const PluginsDialog = lazyComponent(
  () => import('@adea-ai/workspace-ui/plugins-dialog').then((module) => module.PluginsDialog),
  { ssr: false }
)

// The appearance surface is a dev-view subpath so opening it never pulls the
// Dev workspace chunk into Chat/Virtual.
const AppearancePanel = lazyComponent(
  () => import('@adea-ai/dev-view/appearance').then((module) => module.AppearancePanel),
  { ssr: false }
)

const WorkspaceSettingsDialog = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/workspace-settings').then(
      ({ WorkspaceSettingsDialog: SettingsDialog }) => SettingsDialog
    ),
  { ssr: false }
)

// The per-workspace settings dialog the sidebar's workspace gear opens. Lazy
// like app Settings: its chunk loads only when the dialog opens.
const WorkspaceDetailsDialog = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/workspace-details-dialog').then(
      ({ WorkspaceDetailsDialog: DetailsDialog }) => DetailsDialog
    ),
  { ssr: false }
)

function WorkspaceEntryLoading() {
  return (
    <main class="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

// Fetch a view's chunk on hover/focus so the switch feels instant. The
// specifiers match the lazy boundaries above, so the module map deduplicates
// a preload that races the mount itself.
function preloadView(nextView: WorkspaceView) {
  if (nextView === 'virtual') void import('./workspace-shell')
  // Destructured, not a bare namespace import: a namespace use keeps every
  // barrel export (the DEV-only fixtures among them) in the production chunk.
  else if (nextView === 'dev')
    void import('@adea-ai/dev-view').then(({ DevWorkspaceEntry }) => DevWorkspaceEntry)
  else void import('./conventional-workspace-entry')
}

// Same trick for the overlay panels: hovering the rail button or the account
// menu trigger downloads the dialog chunk before the click lands.
function preloadPanel(panel: 'about' | 'help' | 'plugins' | 'settings' | 'workspace-settings') {
  if (panel === 'plugins') {
    void import('@adea-ai/workspace-ui/plugins-dialog')
    // The dialog's catalog provider resolves through the same deferred import.
    void import('@adea-ai/workspace-ui/plugins')
  } else if (panel === 'settings') {
    void import('@adea-ai/workspace-ui/workspace-settings')
  } else if (panel === 'workspace-settings') {
    void import('@adea-ai/workspace-ui/workspace-details-dialog')
  } else if (panel === 'help') {
    void import('@adea-ai/workspace-ui/workspace-help-center')
  } else {
    void import('@adea-ai/ui/components/composites/about-dialog')
  }
}

function WorkspaceSettingsOverlay(props: {
  accountAuthenticated: boolean
  accountLabel: string
  busy: boolean
  client: AgentHqApiClient
  onClose: () => void
  onOpenAgents: () => void
  onSignIn: () => void
  onSignOut: () => void
  open: boolean
  restoreFocusRef?: Accessor<HTMLButtonElement | undefined>
  services: WorkspacePlatformServices
  workspace: WorkspaceSummary
}) {
  const agentsQuery = useAgentListQuery(props.client, () => props.workspace.id)
  return (
    <WorkspaceSettingsDialog
      accountAuthenticated={props.accountAuthenticated}
      appearancePanel={() => <AppearancePanel />}
      accountLabel={props.accountLabel}
      agents={settledData(agentsQuery) ?? []}
      busy={props.busy}
      onClose={props.onClose}
      onOpenAgents={props.onOpenAgents}
      onSignIn={props.onSignIn}
      onSignOut={props.onSignOut}
      open={props.open}
      restoreFocusRef={props.restoreFocusRef}
      permissionsService={isDesktopRuntime() ? desktopMacPermissionsService : undefined}
      services={props.services}
      workspace={props.workspace}
    />
  )
}

/**
 * The active workspace's own settings (identity, Memory, Skills,
 * Connections), opened from the sidebar's workspace gear. Workspace updates
 * save through the versioned workspace mutation.
 */
function WorkspaceDetailsOverlay(props: {
  client: AgentHqApiClient
  onClose: () => void
  open: boolean
  services: WorkspacePlatformServices
  workspace: WorkspaceSummary
  workspaceOrder: readonly WorkspaceSummary[]
}) {
  const reorderWorkspaces = useReorderWorkspacesMutation(props.client)
  const updateWorkspace = useUpdateWorkspaceMutation(props.client)
  return (
    <WorkspaceDetailsDialog
      workspaceOrder={props.workspaceOrder}
      onReorderWorkspaces={async (workspaceIds) => {
        await reorderWorkspaces.mutateAsync(workspaceIds)
      }}
      client={props.client}
      onClose={props.onClose}
      onUpdateWorkspace={async (update) => {
        await updateWorkspace.mutateAsync({ update, workspaceId: props.workspace.id })
      }}
      open={props.open}
      services={props.services}
      workspace={props.workspace}
    />
  )
}

export function createDeferredPluginsProvider(
  options: RegistryPluginsProviderOptions
): WorkspacePluginsProvider {
  let provider: Promise<WorkspacePluginsProvider> | undefined
  let loaded: WorkspacePluginsProvider | undefined
  const load = () => {
    provider ??= import('@adea-ai/workspace-ui/plugins')
      .then(({ createRegistryPluginsProvider }) => createRegistryPluginsProvider(options))
      .then((value) => {
        loaded = value
        return value
      })
    return provider
  }
  return {
    getState: () => loaded?.getState?.() ?? 'idle',
    list: () => load().then((value) => value.list()),
    requestInstall: (pluginId) => load().then((value) => value.requestInstall(pluginId)),
    requestUninstall: (pluginId) =>
      load().then((value) => {
        if (!value.requestUninstall) throw new Error('Uninstall is unavailable')
        return value.requestUninstall(pluginId)
      }),
  }
}

/**
 * The team Chat surfaces (a conversation, Agents) beside the desktop runtime
 * Chat's own sidebar. Opening one from the sidebar's global sections shows it;
 * selecting a runtime leaf returns to the runtime conversation.
 */
export type DesktopTeamChat = Readonly<{
  active: Accessor<boolean>
  surface: () => JSX.Element
  onRuntimeSelection: () => void
}>

export type WorkspaceNavigationAccount = Readonly<{
  authenticated: boolean
  busy: boolean
  label: string
  onOpenUpdates?(opener: HTMLButtonElement | undefined): void
  onSignIn(): void
  onSignOut(): void | Promise<void>
}>

export type WorkspaceNavigationProps = Readonly<{
  renderProjectDialog?: DevProjectFlow['renderDialog']
  account: WorkspaceNavigationAccount
  activeWorkspace?: WorkspaceSummary
  /**
   * Builds the account-scoped directory client for the account-wide directory
   * and inbox surface (M11.03). The desktop lane supplies one whose credential
   * re-resolves from the live shell session on every request; without it the
   * surface uses the cookie-authenticated browser default.
   */
  accountDirectoryClient?: () => AccountDirectoryApiClient | undefined
  /**
   * The signed-in principal's stable id, from the lane's own principal source.
   * A change clears the account-scoped caches (`watchAccountIdentity`); absent,
   * the guard stays inert.
   */
  accountPrincipalId?: () => string | null | undefined
  chatEntry?: (
    fallback: JSX.Element,
    archiveAction: JSX.Element,
    sidebarOpener: () => HTMLElement | undefined,
    workspaceNav: DevWorkspaceNavHost,
    teamChat: DesktopTeamChat
  ) => JSX.Element
  client: AgentHqApiClient
  /**
   * The desktop cross-workspace run counts (`dev.summary.workspaces`), polled
   * by the desktop lane; the web lane has none (ADR 0011).
   */
  devSummary?: Accessor<readonly WorkspaceRunSummaryItem[] | undefined>
  /** Desktop authorizes local content per workspace before switching. */
  onAuthorizeWorkspace?(workspaceId: string): Promise<void>
  onWorkspaceDeleted?(result: ApiWorkspaceDeleteResponse): void
  platform: 'desktop' | 'web'
  characterDesigner?: boolean
  roomDesigner?: boolean
  services: WorkspacePlatformServices
  updates?: Readonly<{ open: boolean; onOpenChange(open: boolean): void }>
  virtual: boolean
  virtualProps: WorkspaceShellProps
  utilityOwner?: SharedDevUtilityOwner
  workspaces: readonly WorkspaceSummary[]
}>

/** The rail's live-region announcement for one applied move of `id`. */
function railMoveAnnouncementFor(
  id: WorkspaceAppId,
  previous: RailPreferencesV1,
  next: RailPreferencesV1
): string {
  const position = enabledWorkspaceApps(next).findIndex((app) => app.id === id) + 1
  const moved = position !== enabledWorkspaceApps(previous).findIndex((app) => app.id === id) + 1
  return railMoveAnnouncement(
    workspaceApps.find((app) => app.id === id)?.name ?? id,
    position,
    enabledWorkspaceApps(next).length,
    moved
  )
}

/** The Library announcement follows every built-in tile, including hidden apps. */
function appLibraryMoveAnnouncementFor(
  id: WorkspaceAppId,
  previous: RailPreferencesV1,
  next: RailPreferencesV1
): string {
  const previousPosition = orderedWorkspaceApps(previous).findIndex((app) => app.id === id) + 1
  const ordered = orderedWorkspaceApps(next)
  const position = ordered.findIndex((app) => app.id === id) + 1
  return railMoveAnnouncement(
    workspaceApps.find((app) => app.id === id)?.name ?? id,
    position,
    ordered.length,
    position !== previousPosition
  )
}

// Rail customization applies the versioned order/hidden preference, keeping
// the active view visible even when it is hidden. Unknown ids preserved by
// the preference (contributions from other builds) never reach the rail.

export function WorkspaceNavigation(props: WorkspaceNavigationProps) {
  const workspaceList = useWorkspaceListQuery(props.client)
  const orderedWorkspaces = () => settledData(workspaceList) ?? props.workspaces
  const unavailableRuntime = createUnavailableDevUtilityRuntime('channel_unauthenticated')
  const utilityRuntime = props.services.devRuntime ?? {
    ...unavailableRuntime,
    preferenceScope: () =>
      import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      new URL(window.location.href).searchParams.get('devE2e') === 'preserved'
        ? {
            accountId: '00000000-0000-4000-8000-000000000001',
            workspaceId: '00000000-0000-4000-8000-000000000002',
            runtimeNodeId: '00000000-0000-4000-8000-000000000003',
          }
        : undefined,
  }
  const utilityOwner =
    props.utilityOwner ??
    createSharedDevUtilityOwner(
      utilityRuntime,
      typeof window === 'undefined' ? undefined : window.localStorage
    )
  if (!props.utilityOwner) onCleanup(() => utilityOwner.dispose())
  const archiveAction = <SharedUtilityArchiveShelf owner={utilityOwner} />
  const [updatesOpener, setUpdatesOpener] = createSignal<HTMLButtonElement>()
  const [feedbackError, setFeedbackError] = createSignal('')
  // Send Feedback opens GitHub's prefilled issue form. The browser gives no
  // success signal (noopener returns null even on success), so only a thrown
  // error surfaces the banner below. On the desktop shell window.open cannot
  // leave the CEF webview, so the link hands off to the system browser
  // through the shell's external-link command.
  const openFeedback = (opener: HTMLButtonElement | undefined) => {
    void opener
    const url = adeaFeedbackUrl(props.services.app?.version, props.platform)
    const opening = isDesktopRuntime()
      ? openExternalUrl(url)
      : Promise.try(() => window.open(url, '_blank', 'noopener,noreferrer'))
    void opening.then(
      () => setFeedbackError(''),
      (caught: unknown) => {
        setFeedbackError(
          caught instanceof Error
            ? `Could not open the Adea feedback form: ${caught.message}. Please try again.`
            : 'Could not open the Adea feedback form. Please try again.'
        )
      }
    )
  }
  // Project links (feedback, About's source, Help Center resources) share the
  // same handoff: undefined on web lets the shared composites use anchors.
  const openExternal = isDesktopRuntime() ? openExternalUrl : undefined
  // The Dev sidebar's authorize step offers the shell's native folder picker
  // only on the desktop runtime; on web the typed path input stays the sole
  // way in (mirrors the Chat lane's wiring).
  const pickFolder = isDesktopRuntime() ? () => pickDesktopFolder() : undefined
  const [sidebarActionMount, setSidebarActionMount] = createSignal<HTMLDivElement>()
  const [toolbarMount, setToolbarMount] = createSignal<HTMLDivElement>()
  const [sidebarOpener, setSidebarOpener] = createSignal<HTMLButtonElement>()
  // The chat shell reports its bootstrap fallback: while it renders the
  // skeleton or the error state, no contextual sidebar is mounted, so the top
  // bar's contextual toggle has nothing to control and hides (mirroring the
  // trailing slot, which hides when no view supplies it).
  const [chatShellBootstrapFallback, setChatShellBootstrapFallback] = createSignal(false)
  const [utilityOpener, setUtilityOpener] = createSignal<HTMLButtonElement>()
  // The Help Center closes imperatively (its panel mounts through a Show, not
  // a trigger), so Kobalte's own focus restoration never runs — without the
  // recorded opener, Escape drops keyboard focus to <body> (WCAG 2.4.3).
  const [helpOpener, setHelpOpener] = createSignal<HTMLButtonElement>()
  // The settings/about overlays open from the account menu's post-close cycle
  // (the menu hands over the trigger after suppressing its own focus
  // restore), from keyboard chords, and from deep links. The menu path
  // records its opener so the dialog restores focus to the trigger instead of
  // racing the closing menu; the other paths leave the signal undefined and
  // the shared dialog falls back to capturing the then-focused element.
  const [settingsOpener, setSettingsOpener] = createSignal<HTMLButtonElement>()
  const [aboutOpener, setAboutOpener] = createSignal<HTMLButtonElement>()
  const [characterDesignerEnabled, setCharacterDesignerEnabled] = createSignal(
    props.characterDesigner ?? false
  )
  const [roomDesignerEnabled, setRoomDesignerEnabled] = createSignal(props.roomDesigner ?? false)
  const globalPanel = useWorkspaceState((state) => state.globalPanel)
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  // Dev View records its resolved selection in the shared store (it is the
  // field family's single writer); the URL request flows in through the
  // `devDeepLinkSelection` prop and the resolution back through
  // `applyDevSelection`, so nothing here mirrors the store into the URL. The
  // session accessor feeds the desktop chat presentation hint only.
  const devSelectedSessionId = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  const devFocusMode = useWorkspaceState((state) => state.devFocusMode)
  // Rail customization is a device-local versioned preference with unknown-
  // contribution preservation; a corrupt record falls back without deleting
  // the unread value.
  const [librarySearchRequest, setLibrarySearchRequest] = createSignal(0)
  const [librarySearchRequestHandled, setLibrarySearchRequestHandled] = createSignal(0)
  const [railPreferences, setRailPreferences] = createSignal<RailPreferencesV1>(
    defaultRailPreferences,
    { equals: false }
  )
  createEffect(() => {
    setRailPreferences(
      readRailPreferences(typeof window === 'undefined' ? undefined : window.localStorage)
    )
  })
  const persistRailPreferences = (next: RailPreferencesV1) => {
    const requested = requestedAppId()
    const wasLibrary = libraryOpen()
    setRailPreferences(next)
    writeRailPreferences(window.localStorage, next)
    const destination = resolveWorkspaceApp(next, requested)
    if (!destination) openAppLibrary(true)
    else if (!wasLibrary && destination.id !== requested) changeApp(destination.id, true)
  }
  // The stream lives above view switching: chat/virtual/dev share the query
  // cache, so one subscription keeps every lane's lists fresh instead of
  // reconnecting and replaying on each surface change.
  useWorkspaceEventStream({
    headers: () => props.client.eventStreamHeaders(),
    url: () => {
      const id = props.activeWorkspace?.id
      return id ? props.client.workspaceEventStreamUrl(id) : undefined
    },
    workspaceId: () => props.activeWorkspace?.id,
  })
  const search = useSearch({ strict: false })
  const navigate = useNavigate()

  // Account-wide cache hygiene (M11.03): the directory and inbox keys live
  // outside the per-workspace prefix on purpose, so an account identity change
  // — and only that — clears them. A workspace switch keeps them, which is the
  // query-key independence the surface is built on. The identity accessor is
  // the lane's own principal source (the cookie bootstrap on web, the shell
  // session state on desktop) — never a second session-establishing bootstrap.
  watchAccountIdentity(useQueryClient(), () => props.accountPrincipalId?.() ?? null)

  const requestedAppId = () =>
    currentSearch().app ??
    (roomDesignerEnabled() || characterDesignerEnabled() ? 'virtual' : currentSearch().view) ??
    (props.virtual ? 'virtual' : 'chat')
  const activeApp = () => resolveWorkspaceApp(railPreferences(), requestedAppId())
  const activeAppId = (): WorkspaceAppId => activeApp()?.id ?? 'chat'
  const libraryOpen = () => currentSearch().app === 'library' || !activeApp()
  const view = (): WorkspaceView => activeApp()?.view ?? 'chat'
  const designerActive = () =>
    view() === 'virtual' && (roomDesignerEnabled() || characterDesignerEnabled())
  const contextualUtilitiesAvailable = () =>
    ['dev', 'chat', 'virtual'].includes(activeAppId()) &&
    !libraryOpen() &&
    !directoryOpen() &&
    !designerActive()
  const contextualUtilitiesVisible = () =>
    contextualUtilitiesAvailable() &&
    (view() !== 'dev' ||
      (!devFocusMode() &&
        !utilityOwner
          .utilityPreferences()
          .some((item) => item.side === 'left' && item.visible && item.fullWidth)))
  createEffect(() => utilityOwner.setView(contextualUtilitiesAvailable() ? view() : 'workspace'))
  const orderedViews = () => enabledWorkspaceApps(railPreferences()).map((app) => app.id)
  // The selected Dev session is a presentation hint only. Chat reports its
  // visible canonical conversation from DesktopFirstRunChat; the conventional
  // team Chat surface does not imply a RuntimeSession selection.
  const scene = () => {
    const value = currentSearch().scene
    return props.activeWorkspace?.scene ?? (value === 'work' ? 'work' : 'home')
  }
  const currentSearch = () => search() as WorkspaceSearch
  createEffect(() => {
    const query = currentSearch()
    setRoomDesignerEnabled(query.roomDesigner !== undefined && query.roomDesigner !== '0')
    setCharacterDesignerEnabled(
      query.characterDesigner !== undefined && query.characterDesigner !== '0'
    )
  })
  // Dev selection is presentation-only. Chat reports its visible canonical
  // conversation separately; leaving Dev clears only this source.
  bindDesktopChatPresentation('dev', () =>
    view() === 'dev' ? (devSelectedSessionId() ?? undefined) : undefined
  )
  // The ChatView visual fixture selector (#536 evidence lane). Only a DEV
  // build mounts the fixture; the param is inert in production.
  const chatVisualState = (): 'attention' | 'conversation' | 'reconnect' | 'streaming' => {
    const value = currentSearch().chatState
    return value === 'attention' || value === 'reconnect' || value === 'streaming'
      ? value
      : 'conversation'
  }
  // The workspace search contract lives on the root route and the router's
  // custom codec preserves it verbatim, so a patch is written through one
  // typed seam instead of restating the generated search schema.
  const applySearch = (patch: Partial<WorkspaceSearch>) =>
    void navigate({
      search: { ...currentSearch(), ...patch } as never,
      // Carry the hash through: a search update must not drop a deep link such
      // as `#settings/privacy-data` while the dialog it opened is mounting.
      hash: window.location.hash.replace(/^#/, ''),
      replace: true,
    })
  const setViewParam = (nextView: WorkspaceView) => applySearch({ view: nextView })
  const setScene = (nextScene: 'home' | 'work') => applySearch({ scene: nextScene })

  // Dev deep links: the URL request flows into Dev View through one prop and
  // the resolved selection flows back through one callback, so a stale,
  // archived, or cross-project link converges on the recovered selection (Dev
  // View corrects it; the guarded patch below rewrites the URL) instead of
  // pinning an invalid selection. No effect mirrors the store into the URL or
  // the URL into the store: the router owns the deep-linkable fact, Dev View
  // owns the store's presentation record. Unknown query keys survive every
  // patch because `applySearch` spreads the current search.
  const devDeepLinkSelection = () => {
    const query = currentSearch()
    if (query.devProject === undefined && query.devSession === undefined) return undefined
    return { projectId: query.devProject, sessionId: query.devSession }
  }
  const applyDevSelection = (selection: { projectId: string; sessionId: string | null }) => {
    const patch: Partial<WorkspaceSearch> = {}
    if ((currentSearch().devProject ?? undefined) !== (selection.projectId ?? undefined))
      patch.devProject = selection.projectId
    if ((currentSearch().devSession ?? undefined) !== (selection.sessionId ?? undefined))
      patch.devSession = selection.sessionId ?? undefined
    if ('devProject' in patch || 'devSession' in patch) applySearch(patch)
  }

  // Deep-link params are router state the chat surface consumes through
  // accessors — reactive, so notification links apply on SPA navigation too.
  // `onConsumeDeepLink` strips the params once the surface applies them so a
  // stale link can't re-select the destination on later channel changes.
  const deepLink = (): WorkspaceDeepLink => {
    const query = currentSearch()
    return {
      channel: query.channel,
      message: query.message,
      task: query.task,
      thread: query.thread,
      workspace: query.workspace,
    }
  }
  const consumeDeepLink = () => {
    // Functional updater: a completion that commits after a newer navigation
    // strips only the deep-link keys from that newer search. A value snapshot
    // would replace the search with the pre-switch state and drop
    // `app=kanban`, unmounting the board.
    void navigate({
      search: ((previous: WorkspaceSearch) => stripWorkspaceDeepLinkSearch(previous)) as never,
      hash: window.location.hash.replace(/^#/, ''),
      replace: true,
    })
  }
  // `?workspace=` switches the active workspace when the link scopes another
  // one — the surface's deep-link guard keeps channel/task params pending
  // until the switch lands and its lists reload.
  // Both switch paths (rail menu and `?workspace=` links) funnel through one
  // helper so the surface can show the in-flight affordance and an effect
  // re-run can't fire a second authorize for a switch already in progress.
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = createSignal<string>()
  const switchToWorkspace = (workspace: WorkspaceSummary) => {
    if (workspace.id === props.activeWorkspace?.id) return Promise.resolve(false)
    if (switchingWorkspaceId()) return Promise.resolve(false)
    setSwitchingWorkspaceId(workspace.id)
    return Promise.resolve(props.onAuthorizeWorkspace?.(workspace.id))
      .then(() => {
        workspaceStore.getState().switchWorkspace(workspace.id)
        // The scene is a router fact: this navigation is the single write.
        void setScene(workspace.scene)
        return true
      })
      .catch(() => false)
      .finally(() =>
        setSwitchingWorkspaceId((current) => (current === workspace.id ? undefined : current))
      )
  }

  // One switch per `?workspace=` link (lib/workspace-deep-link): a failed link waits
  // for an explicit re-issue, and only the current link's own completion strips the
  // param. The active workspace only catches up when the summary lands, so without
  // this every settle would re-run the switch and its scene write.
  const deepLinks = createDeepLinkAttempts({
    consume: (workspaceId) => {
      const rest = { ...currentSearch() }
      if (rest.workspace !== workspaceId) return
      delete rest.workspace
      void navigate({
        search: rest as never,
        hash: window.location.hash.replace(/^#/, ''),
        replace: true,
      })
    },
    requested: () => currentSearch().workspace,
    // The already-active branch below keeps the param for the same reason: a scoped
    // destination is applied against the target workspace, so the param stays until
    // the surface consumes the whole link.
    retain: () => {
      const query = currentSearch()
      return Boolean(query.channel || query.task || query.thread || query.message)
    },
    switchTo: (workspaceId) => {
      const workspace = orderedWorkspaces().find(({ id }) => id === workspaceId)
      return workspace ? switchToWorkspace(workspace) : Promise.resolve(false)
    },
  })
  createEffect(() => {
    const requestedWorkspace = currentSearch().workspace
    if (!requestedWorkspace) {
      deepLinks.release()
      return
    }
    if (requestedWorkspace === props.activeWorkspace?.id) {
      // Already there: drop the param unless channel/task deep links still
      // need it as a scoping guard for the surface.
      const query = currentSearch()
      if (!query.channel && !query.task && !query.thread && !query.message) {
        const rest = { ...query }
        delete rest.workspace
        void navigate({
          search: rest as never,
          hash: window.location.hash.replace(/^#/, ''),
          replace: true,
        })
      }
      return
    }
    const workspace = orderedWorkspaces().find(({ id }) => id === requestedWorkspace)
    if (!workspace || switchingWorkspaceId()) return
    deepLinks.start(workspace.id)
  })

  // The top bar's title slot shows Workspace › Project › Leaf (ADR 0011).
  // Chat and Virtual read the mounted shared sidebar's path; Dev, not on the
  // shared sidebar yet, reports its selected project and branch. Every other
  // surface keeps the plain title.
  const [navBreadcrumbs, setNavBreadcrumbs] =
    createSignal<Accessor<readonly WorkspaceBreadcrumb[]>>()
  const [devBreadcrumb, setDevBreadcrumb] = createSignal<DevBreadcrumbSelection>()
  const topBarBreadcrumbs = (): readonly WorkspaceBreadcrumb[] | undefined => {
    const workspace = props.activeWorkspace
    if (libraryOpen() || directoryOpen() || designerActive() || !workspace) return undefined
    if (activeAppId() === 'dev') return devBreadcrumbs(workspace, devBreadcrumb())
    if (activeAppId() === 'chat' || activeAppId() === 'virtual') return navBreadcrumbs()?.()
    return undefined
  }

  // The contextual sidebar's Workspaces accordion switches through the same
  // helper the `?workspace=` links use, so a click and a link authorize and
  // reset context identically.
  const workspaceHost: WorkspaceNavHost = {
    get workspaces() {
      return orderedWorkspaces()
    },
    get devSummary() {
      return props.devSummary?.()
    },
    onSwitchWorkspace: (workspace) => switchToWorkspace(workspace),
    onOpenWorkspaceSettings: () => openWorkspaceSettings(),
    registerBreadcrumbs: (crumbs) => {
      setNavBreadcrumbs(() => crumbs)
      return () => {
        if (navBreadcrumbs() === crumbs) setNavBreadcrumbs(undefined)
      }
    },
  }

  // Agents, Mark all read and Conversations are global (ADR 0011): the Dev
  // sidebar, which the desktop runtime Chat also uses, carries them too.
  // Opening one goes to Chat; on the desktop the team surface shows beside
  // the runtime sidebar until a runtime leaf is selected again.
  const [teamChatActive, setTeamChatActive] = createSignal(false)
  const selectedChannelId = useWorkspaceState((state) => state.selectedChannelId)
  const activeSurface = useWorkspaceState((state) => state.activeSurface)
  const openTeamChat = (surface: 'agents' | 'conversation', channelId?: string) => {
    const store = workspaceStore.getState()
    if (channelId) {
      store.setSelectedProjectId(null)
      store.setSelectedChannelId(channelId)
    }
    store.setActiveSurface(surface)
    setTeamChatActive(true)
    if (activeAppId() !== 'chat' || libraryOpen()) changeApp('chat')
  }
  const globalSection =
    (section: 'quick-actions' | 'conversations') => (context: DevGlobalNavContext) => (
      <WorkspaceGlobalNav
        section={section}
        client={props.client}
        workspaceId={props.activeWorkspace?.id}
        selectedChannelId={
          teamChatActive() && view() === 'chat' && activeSurface() === 'conversation'
            ? selectedChannelId()
            : null
        }
        onOpenAgents={() => {
          openTeamChat('agents')
          context.closeSheet()
        }}
        onOpenConversation={(channelId) => {
          openTeamChat('conversation', channelId)
          context.closeSheet()
        }}
        portalMount={context.portalMount}
        tooltips={!context.mobile}
      />
    )
  const globalNav: DevGlobalNavSlots = {
    quickActions: globalSection('quick-actions'),
    conversations: globalSection('conversations'),
  }

  // The Dev sidebar renders the same accordion from the same cloud queries,
  // joined with the desktop runtime's local bindings (ADR 0011).
  // The signed-in label is the owner of a new workspace. Guests and unknown identities
  // get no owner, so the creation draft keeps its generic wording.
  const creationOwner = () =>
    props.account.authenticated ? { ownerLabel: props.account.label } : undefined
  const devNavHost = createDevWorkspaceNavHost({
    globalNav,
    client: props.client,
    activeWorkspace: () => props.activeWorkspace,
    creationContext: creationOwner,
    workspaces: () => orderedWorkspaces(),
    // Dev renders the sidebar; desktop Chat renders it outside the Kanban board.
    active: () =>
      view() === 'dev' ||
      (props.chatEntry !== undefined && view() !== 'virtual' && activeAppId() !== 'kanban'),
    switchToWorkspace,
    openWorkspaceSettings: () => openWorkspaceSettings(),
    devSummary: () => props.devSummary?.(),
  })

  // One create-project flow everywhere a runtime can back it: when this host
  // carries a ready Dev Runtime, the Chat/Virtual sidebars' "Add project" runs
  // the detailed Dev dialog (name the project, optionally bind a repository)
  // with the shell's native folder picker; without one (the web lane) the
  // accessor resolves undefined and those sidebars keep the basic dialog.
  // The production web entry has no Dev Runtime composition root.
  const devProjectFlowHost = __ADEA_DESKTOP_COMPONENTS__
    ? (): DevProjectFlow | undefined => {
        const runtime = props.services.devRuntime
        if (!runtime || !props.renderProjectDialog) return undefined
        return devProjectFlow({
          runtime,
          renderDialog: props.renderProjectDialog,
          knownProjectNames: (devNavHost.projects ?? []).map(({ name }) => name),
          onCreateProject: (name) => devNavHost.onCreateProject!(name),
        })
      }
    : undefined

  // The active workspace's accent themes the whole app while it is active
  // (ADR 0011): it overrides the appearance accent, and a workspace without
  // one (null) keeps the appearance accent. It is painted on <body>, below
  // the document element the appearance provider writes, so portalled menus
  // and dialogs follow it and clearing it hands the roles straight back.
  const theme = useOptionalTheme()
  createEffect(() => {
    if (typeof document === 'undefined') return
    paintWorkspaceAccent(
      document.body,
      props.activeWorkspace?.accent ?? null,
      theme?.variantId() ?? ''
    )
  })
  onCleanup(() => {
    if (typeof document !== 'undefined') paintWorkspaceAccent(document.body, null, '')
  })

  const [hashSettingsOpen, setHashSettingsOpen] = createSignal(false)
  const settingsOpen = () => globalPanel() === 'settings' || hashSettingsOpen()
  const [hashWorkspaceSettingsOpen, setHashWorkspaceSettingsOpen] = createSignal(false)
  const workspaceSettingsOpen = () =>
    globalPanel() === 'workspace-settings' || hashWorkspaceSettingsOpen()

  createEffect(() => {
    const activeWorkspace = props.activeWorkspace
    if (!activeWorkspace) return
    // Reconcile the store with the server-authoritative active workspace. The
    // summary lands asynchronously, so this is a fill-in, not a user switch:
    // `switchWorkspace` resets per-workspace context (drafts, panels, the Dev
    // selection) and would wipe a deep-linked Dev selection seeded and
    // recovered before the summary arrived. User-initiated switches (rail
    // menu, `?workspace=`) go through `switchToWorkspace`, which performs the
    // full reset deliberately.
    if (selectedWorkspaceId() !== activeWorkspace.id)
      workspaceStore.getState().switchWorkspace(activeWorkspace.id, {
        // A summary arrival that lands after a Dev deep link seeded (and
        // Dev View recovered) the selection must reconcile the workspace
        // without wiping that freshly recovered selection.
        preserveDevSelection: true,
      })
    // The scene is a router fact. The workspace summary is the fact's
    // authority; the URL below is its single mirror, and this one navigation
    // (not a store write plus a param write) is what keeps it there.
    const currentScene = (search() as WorkspaceSearch).scene
    if (currentScene !== activeWorkspace.scene) void setScene(activeWorkspace.scene)
  })

  createEffect(() => {
    // Captures the component's settings-open signal and the workspace store setter.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const openDeepLinkedSettings = () => {
      // `#workspace-settings/<section>` opens the workspace settings dialog,
      // and so do the retired `#settings/workspace|memory|skills|connections`
      // links (the dialog rewrites them to the canonical hash). Every other
      // `#settings/<section>` opens app Settings.
      const workspaceSection = workspaceSettingsSectionFromHash(window.location.hash)
      const appSettings = !workspaceSection && window.location.hash.startsWith('#settings')
      setHashWorkspaceSettingsOpen(workspaceSection !== undefined)
      setHashSettingsOpen(appSettings)
      if (workspaceSection) workspaceStore.getState().setGlobalPanel('workspace-settings')
      else if (appSettings) workspaceStore.getState().setGlobalPanel('settings')
    }
    openDeepLinkedSettings()
    window.addEventListener('hashchange', openDeepLinkedSettings)
    return () => window.removeEventListener('hashchange', openDeepLinkedSettings)
  })

  const changeApp = (id: WorkspaceAppId, replace = false) => {
    const destination = resolveWorkspaceApp(railPreferences(), id)
    if (!destination || destination.id !== id) return
    setLibrarySearchRequestHandled(librarySearchRequest())
    workspaceStore.getState().setGlobalPanel(null)
    if (requestedAppId() === id && currentSearch().app !== 'library' && !designerActive()) return
    setRoomDesignerEnabled(false)
    setCharacterDesignerEnabled(false)
    void navigate({
      search: {
        // A pending deep link must not ride into another app's search and be
        // re-applied by the shell (which would switch the surface back and
        // drop `app=kanban`). Deep links are consumed once by their surface.
        ...stripWorkspaceDeepLinkSearch(currentSearch()),
        view: destination.view,
        roomDesigner: undefined,
        characterDesigner: undefined,
        app: id === 'kanban' || id === 'source-control' ? id : undefined,
      } as never,
      hash: '',
      replace,
    })
  }
  // Focus a runtime session in Dev (the resources sheet's "Go to session").
  // One navigation carries the app switch and the Dev deep-link params, so
  // the request wins over whatever selection the URL held; Dev View resolves
  // it and reports back through `applyDevSelection` like any deep link.
  const openDevSession = (target: { runtimeSessionId: string; projectId?: string }) => {
    const destination = resolveWorkspaceApp(railPreferences(), 'dev')
    if (destination?.id !== 'dev') return
    workspaceStore.getState().setGlobalPanel(null)
    setRoomDesignerEnabled(false)
    setCharacterDesignerEnabled(false)
    void navigate({
      search: {
        ...currentSearch(),
        view: destination.view,
        roomDesigner: undefined,
        characterDesigner: undefined,
        app: undefined,
        ...(target.projectId !== undefined ? { devProject: target.projectId } : {}),
        devSession: target.runtimeSessionId,
      } as never,
      hash: '',
    })
  }
  // Tasks are listed on the Kanban app only. A search result or link to a Task
  // opens it there; with Kanban turned off the board opens inside Chat instead.
  const openTaskBoard = () =>
    resolveWorkspaceApp(railPreferences(), 'kanban')?.id === 'kanban'
      ? () => changeApp('kanban')
      : undefined
  // Chat's team surfaces; `embedded` drops their sidebar beside the desktop
  // runtime Chat's own, and the Kanban app renders the board alone.
  const conventionalWorkspace = (embedded?: boolean) => (
    <ConventionalWorkspace
      archiveAction={archiveAction}
      restoreFocusRef={sidebarOpener}
      embedded={embedded}
      taskBoardOnly={activeAppId() === 'kanban'}
      client={props.client}
      creationContext={creationOwner()}
      createProjectFlow={devProjectFlowHost}
      deepLink={deepLink}
      manageSettings={false}
      onConsumeDeepLink={consumeDeepLink}
      onOpenTaskBoard={activeAppId() === 'kanban' ? undefined : openTaskBoard()}
      onBootstrapFallbackChange={setChatShellBootstrapFallback}
      onViewChange={changeView}
      services={props.services}
      workspaceHost={workspaceHost}
    />
  )
  const changeView = (nextView: WorkspaceView) => {
    if (resolveWorkspaceApp(railPreferences(), nextView)?.id !== nextView) openAppLibrary()
    else changeApp(nextView)
  }
  const openAppLibrary = (replace = false) => {
    workspaceStore.getState().setGlobalPanel(null)
    if (currentSearch().app === 'library') return
    setRoomDesignerEnabled(false)
    setCharacterDesignerEnabled(false)
    void navigate({
      search: {
        ...currentSearch(),
        app: 'library',
        roomDesigner: undefined,
        characterDesigner: undefined,
      } as never,
      hash: '',
      replace,
    })
  }

  // The account-wide directory surface (M11.03). Like the App Library it is a
  // global surface driven by the router search: `?directory=agents|inbox`
  // replaces the workspace view while the top bar and rail stay. Its results
  // never scope to the selected workspace.
  const directorySection = () => parseDirectorySection(currentSearch().directory)
  const directoryOpen = () => directorySection() !== undefined
  // The desktop lane supplies a builder whose client re-resolves the shell
  // session per request (so a same-workspace rotation reaches the mounted
  // surface); the web default is the cookie-authenticated browser client,
  // created once for this frame.
  const accountDirectoryClient = createMemo<AccountDirectoryApiClient>(
    () => props.accountDirectoryClient?.() ?? new AccountDirectoryApiClient()
  )
  const openDirectory = (section: AccountDirectorySection | undefined) =>
    applySearch({ directory: section })
  // Opening a directory Agent mirrors the search-result path: the Agent is
  // selected in its OWN workspace — a user-initiated switch's store reset has
  // already run by the time the switch resolves — and the Agents surface opens
  // in Chat.
  const openDirectoryAgent = (agent: AccountDirectoryAgent) => {
    openDirectory(undefined)
    const select = () => {
      const store = workspaceStore.getState()
      store.setSelectedAgentId(agent.id)
      store.setActiveSurface('agents')
      store.setGlobalPanel(null)
      if (activeAppId() !== 'chat' || libraryOpen()) changeApp('chat')
    }
    if (agent.workspaceId === props.activeWorkspace?.id) {
      select()
      return
    }
    // The ordered workspace list (the live server-side order) is the canonical
    // membership source, so a directory jump reaches workspaces the lane
    // bootstrap snapshot may not include yet.
    const workspace = orderedWorkspaces().find(({ id }) => id === agent.workspaceId)
    if (!workspace) return
    void switchToWorkspace(workspace).then((switched) => {
      if (switched) select()
    })
  }

  const setRoomDesignerRoute = (enabled: boolean) => {
    setRoomDesignerEnabled(enabled)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('roomDesigner', enabled ? '1' : '0')
    if (enabled) nextUrl.searchParams.set('view', 'virtual')
    window.history.replaceState(null, '', nextUrl)
    // `replaceState` emits no event, so the router never re-read the search
    // params. The reconcile effect then calls `navigate({ search: { ...currentSearch(), scene } })`
    // from the router's STALE search — which has no `roomDesigner` key — so it
    // re-serialised the query string and deleted `roomDesigner=1` from the
    // address bar while `roomDesignerEnabled()` stayed true. The designer stayed
    // mounted at a URL that no longer opened it, and a reload or a shared link
    // lost it. The sibling `replaceState` in `desktop-workspace-entry.tsx`
    // dispatches the same synthetic event; this now does too.
    window.dispatchEvent(new PopStateEvent('popstate'))
    if (enabled && view() !== 'virtual') void setViewParam('virtual')
  }
  const openSettings = (section: 'account' | 'input-notifications' | 'integrations') => {
    window.history.replaceState(null, '', `#settings/${section}`)
    setHashWorkspaceSettingsOpen(false)
    setHashSettingsOpen(true)
    // Settings is a global overlay. Keep the current surface mounted so the
    // virtual scene does not disappear before its dialog can open.
    workspaceStore.getState().setGlobalPanel('settings')
  }
  // The sidebar's workspace gear: the active workspace's own settings dialog,
  // a global overlay like app Settings, deep-linked the same way.
  const openWorkspaceSettings = (section: WorkspaceSettingsSection = 'general') => {
    window.history.replaceState(null, '', workspaceSettingsHash(section))
    setHashSettingsOpen(false)
    setHashWorkspaceSettingsOpen(true)
    workspaceStore.getState().setGlobalPanel('workspace-settings')
  }
  const openSearch = () => {
    // Source control keeps its pull-request search in the leading toolbar
    // group — right of the divider, like the Dev view's pane actions — and
    // advertises ⌘K on it, so the search command focuses that field while it
    // shows.
    const scmSearch =
      activeAppId() === 'source-control' && !libraryOpen()
        ? toolbarMount()?.querySelector<HTMLInputElement>('[data-scm-search] input')
        : undefined
    if (scmSearch) {
      scmSearch.focus()
      scmSearch.select()
      return
    }
    if (resolveWorkspaceApp(railPreferences(), 'chat')?.id !== 'chat') {
      setLibrarySearchRequest((request) => request + 1)
      openAppLibrary()
      return
    }
    if (libraryOpen() || view() !== 'chat') changeView('chat')
    workspaceStore.getState().setGlobalPanel('search')
  }
  createEffect(() => {
    // Recovery is a real destination. Enabling the first app must not dismiss
    // Library before the user chooses Open, including stale disabled links.
    if (currentSearch().app === 'library') return
    const destination = activeApp()
    if (!destination) openAppLibrary(true)
    else if (destination.id !== requestedAppId()) changeApp(destination.id, true)
  })
  return (
    <div
      class={`workspace-frame workspace-frame--${view()}`}
      data-designer-mode={designerActive() ? 'true' : undefined}
    >
      {/* The bypass mechanism must be the frame's first tabbable element: from
          here the repeated top bar, global rail, and contextual sidebar are
          all skippable in one Enter (WCAG 2.4.1). The per-view mains were too
          late — the skip link sat behind ~21 repeated controls. */}
      <a class="workspace-skip-link" href={view() === 'dev' ? '#dev-center' : '#workspace-main'}>
        Skip to workspace content
      </a>
      <WorkspaceTopBar
        hideSidebarToggle={designerActive() || chatShellBootstrapFallback()}
        platform={props.platform}
        title={
          directoryOpen()
            ? directoryTitle(directorySection() ?? 'agents')
            : libraryOpen()
              ? 'App Library'
              : (props.activeWorkspace?.name ?? 'Adea')
        }
        breadcrumbs={topBarBreadcrumbs()}
        onOpenNotifications={() => openSettings('input-notifications')}
        actionsMount={setToolbarMount}
        showDevActions={activeAppId() === 'dev'}
        resources={
          <>
            {/* The account-wide directory and inbox entries (M11.03): global
                surfaces, so the actions sit with the other workspace-wide
                controls in the top bar's end section. */}
            <ActionButton
              type="button"
              variant="toolbar"
              size="icon-sm"
              data-expanded={directoryOpen() && directorySection() === 'agents' ? '' : undefined}
              tooltip={
                directoryOpen() && directorySection() === 'agents'
                  ? 'Close the global Agents directory'
                  : 'Open the global Agents directory'
              }
              tooltipIcon={<Users aria-hidden="true" />}
              aria-label="Global Agents directory"
              aria-pressed={directoryOpen() && directorySection() === 'agents'}
              onClick={() =>
                openDirectory(
                  directoryOpen() && directorySection() === 'agents' ? undefined : 'agents'
                )
              }
            >
              <Users aria-hidden="true" />
            </ActionButton>
            <ActionButton
              type="button"
              variant="toolbar"
              size="icon-sm"
              data-expanded={directoryOpen() && directorySection() === 'inbox' ? '' : undefined}
              tooltip={
                directoryOpen() && directorySection() === 'inbox'
                  ? 'Close the global conversation inbox'
                  : 'Open the global conversation inbox'
              }
              tooltipIcon={<InboxIcon aria-hidden="true" />}
              aria-label="Global conversation inbox"
              aria-pressed={directoryOpen() && directorySection() === 'inbox'}
              onClick={() =>
                openDirectory(
                  directoryOpen() && directorySection() === 'inbox' ? undefined : 'inbox'
                )
              }
            >
              <InboxIcon aria-hidden="true" />
            </ActionButton>
            <RuntimeResourcesControl
              runtime={props.services.devRuntime}
              openExternal={openExternal}
              onOpenSession={openDevSession}
            />
          </>
        }
        showTitleControls={activeAppId() === 'source-control'}
        sidebarMount={setSidebarActionMount}
        showSidebarDivider={contextualUtilitiesAvailable()}
        sidebarToggleRef={setSidebarOpener}
      />
      <Show when={contextualUtilitiesAvailable() && sidebarActionMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <ActionButton
              ref={setUtilityOpener}
              type="button"
              variant="toolbar"
              size="icon-sm"
              data-expanded={utilityOwner.rightUtilityOpen() ? '' : undefined}
              tooltip={
                utilityOwner.rightUtilityOpen()
                  ? 'Collapse utility sidebar'
                  : 'Expand utility sidebar'
              }
              tooltipIcon={
                <Show
                  when={utilityOwner.rightUtilityOpen()}
                  fallback={<PanelRightOpen aria-hidden="true" />}
                >
                  <PanelRightClose aria-hidden="true" />
                </Show>
              }
              aria-label={
                utilityOwner.rightUtilityOpen()
                  ? 'Collapse utility sidebar'
                  : 'Expand utility sidebar'
              }
              aria-expanded={utilityOwner.rightUtilityOpen()}
              onClick={() => utilityOwner.toggleRightUtility()}
            >
              <Show
                when={utilityOwner.rightUtilityOpen()}
                fallback={<PanelRightOpen aria-hidden="true" />}
              >
                <PanelRightClose aria-hidden="true" />
              </Show>
            </ActionButton>
          </Portal>
        )}
      </Show>
      <GlobalWorkspaceRail
        account={{
          authenticated: props.account.authenticated,
          busy: props.account.busy,
          label: props.account.label,
          onSignIn: props.account.onSignIn,
          onSignOut: () => void props.account.onSignOut(),
          ...(props.account.onOpenUpdates
            ? {
                onOpenUpdates: (opener: HTMLButtonElement | undefined) => {
                  setUpdatesOpener(opener)
                  props.account.onOpenUpdates?.(opener)
                },
              }
            : {}),
          onOpenHelp: (opener: HTMLButtonElement | undefined) => {
            setHelpOpener(opener)
            workspaceStore.getState().setGlobalPanel('help')
          },
          onOpenFeedback: openFeedback,
          platform: props.platform,
        }}
        onOpenAbout={(opener) => {
          setAboutOpener(opener)
          workspaceStore.getState().setGlobalPanel('about')
        }}
        onOpenPlugins={() => workspaceStore.getState().setGlobalPanel('plugins')}
        onOpenAppLibrary={() => openAppLibrary()}
        libraryActive={libraryOpen()}
        onOpenSearch={openSearch}
        onOpenSettings={(opener) => {
          setSettingsOpener(opener)
          openSettings('account')
        }}
        activeWorkspace={props.activeWorkspace}
        onViewChange={(id) => changeApp(id)}
        onViewIntent={preloadView}
        onPanelIntent={preloadPanel}
        reorder={{
          onDrop: (id, targetId, position) => {
            const previous = railPreferences()
            const next = reorderRailItemsRelativeTo(previous, id, targetId, position)
            persistRailPreferences(next)
            return railMoveAnnouncementFor(id, previous, next)
          },
          onMove: (id, direction) => {
            const previous = railPreferences()
            const next = reorderRailItems(previous, id, direction, orderedViews())
            persistRailPreferences(next)
            return railMoveAnnouncementFor(id, previous, next)
          },
        }}
        view={activeAppId()}
        views={orderedViews()}
      />
      <div class="workspace-frame__surface" aria-busy={switchingWorkspaceId() ? true : undefined}>
        <Show when={feedbackError()}>
          {(message) => (
            <div class="workspace-feedback-error">
              <Alert variant="destructive" role="alert">
                <AlertDescription>{message()}</AlertDescription>
              </Alert>
            </div>
          )}
        </Show>
        <Show when={switchingWorkspaceId()}>
          <p class="workspace-switching" role="status">
            Switching workspace…
          </p>
        </Show>
        <div
          class={cn('workspace-contextual-utility-frame', {
            'workspace-contextual-utility-frame--utility-full':
              contextualUtilitiesVisible() &&
              Boolean(
                utilityOwner
                  .utilityPreferences()
                  .some((item) => item.side === 'right' && item.visible && item.fullWidth)
              ),
          })}
        >
          <div class="workspace-contextual-utility-frame__view">
            <Show
              when={!libraryOpen() && !directoryOpen()}
              fallback={
                libraryOpen() ? (
                  <AppLibraryPage
                    focusSearchRequest={librarySearchRequest()}
                    focusSearchRequestHandled={librarySearchRequestHandled()}
                    onFocusSearchRequestHandled={(request) =>
                      setLibrarySearchRequestHandled((handled) => Math.max(handled, request))
                    }
                    preferences={railPreferences()}
                    onReorder={(id, targetId, position) => {
                      const previous = railPreferences()
                      const next = reorderWorkspaceAppsRelativeTo(previous, id, targetId, position)
                      if (next !== previous) persistRailPreferences(next)
                      return appLibraryMoveAnnouncementFor(id, previous, next)
                    }}
                    onSetEnabled={(id, enabled) =>
                      persistRailPreferences(setWorkspaceAppEnabled(railPreferences(), id, enabled))
                    }
                    onOpen={(id) => changeApp(id)}
                    onReset={() => persistRailPreferences(defaultRailPreferences)}
                  />
                ) : (
                  <AccountDirectorySurface
                    client={accountDirectoryClient()}
                    section={directorySection() ?? 'agents'}
                    workspaces={props.workspaces}
                    onSwitchSection={(section) => openDirectory(section)}
                    onOpenAgent={openDirectoryAgent}
                    onOpenConversation={(entry) => applySearch(conversationOpenPatch(entry))}
                  />
                )
              }
            >
              <Show
                when={view() !== 'dev'}
                fallback={
                  <Show when={toolbarMount()} fallback={<WorkspaceEntryLoading />}>
                    {(mount) => (
                      <Show
                        when={activeAppId() === 'source-control'}
                        fallback={
                          <DevWorkspace
                            fixture={
                              import.meta.env.DEV &&
                              Reflect.get(currentSearch(), 'devE2e') === 'preserved'
                            }
                            runtime={utilityRuntime}
                            toolbarMount={mount()}
                            sidebarActionMount={sidebarActionMount()}
                            sidebarOpener={sidebarOpener}
                            utilityOwner={utilityOwner}
                            utilityHostOwnedByShell
                            deepLinkSelection={devDeepLinkSelection}
                            onSelectionChange={applyDevSelection}
                            onBreadcrumbChange={setDevBreadcrumb}
                            workspaceNav={devNavHost}
                            pickFolder={pickFolder}
                          />
                        }
                      >
                        <SourceControlView
                          runtime={utilityRuntime}
                          toolbarMount={mount()}
                          onOpenDev={() => changeApp('dev')}
                        />
                      </Show>
                    )}
                  </Show>
                }
              >
                <Show
                  when={view() === 'virtual'}
                  fallback={
                    <Show
                      when={import.meta.env.DEV && currentSearch().chatE2e === 'visual'}
                      fallback={
                        props.chatEntry && activeAppId() !== 'kanban'
                          ? props.chatEntry(
                              conventionalWorkspace(),
                              archiveAction,
                              sidebarOpener,
                              devNavHost,
                              {
                                active: teamChatActive,
                                onRuntimeSelection: () => setTeamChatActive(false),
                                surface: () => conventionalWorkspace(true),
                              }
                            )
                          : conventionalWorkspace()
                      }
                    >
                      <ChatVisualFixture state={chatVisualState()} />
                    </Show>
                  }
                >
                  <Show
                    when={designerActive()}
                    fallback={
                      <SpatialWorkspace
                        {...props.virtualProps}
                        archiveAction={archiveAction}
                        restoreFocusRef={sidebarOpener}
                        apiClient={props.client}
                        createProjectFlow={devProjectFlowHost}
                        initialScene={scene()}
                        onOpenRoomDesigner={() => setRoomDesignerRoute(true)}
                        onWorkspaceViewChange={changeView}
                        services={props.services}
                        workspaceHost={workspaceHost}
                        workspaceView={view()}
                      />
                    }
                  >
                    <Show
                      when={characterDesignerEnabled()}
                      fallback={
                        <RoomDesignerWorkspace
                          client={props.client}
                          restoreFocusRef={sidebarOpener}
                          onOpenChat={() => changeView('chat')}
                          initialCharacter={props.virtualProps.initialCharacter}
                          initialScene={scene()}
                          onClose={() => setRoomDesignerRoute(false)}
                        />
                      }
                    >
                      <CharacterDesignerWorkspace
                        initialCharacter={props.virtualProps.initialCharacter}
                        onClose={() => changeApp('virtual')}
                      />
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
          <Show when={contextualUtilitiesVisible() && utilityOwner.rightUtilityOpen()}>
            <SharedDevUtilityHost owner={utilityOwner} restoreFocusRef={utilityOpener} />
          </Show>
        </div>
      </div>
      <Show when={props.activeWorkspace && settingsOpen()}>
        <WorkspaceSettingsOverlay
          accountAuthenticated={props.account.authenticated}
          accountLabel={props.account.label}
          busy={props.account.busy}
          client={props.client}
          onClose={() => {
            setHashSettingsOpen(false)
            workspaceStore.getState().setGlobalPanel(null)
          }}
          onOpenAgents={() => {
            workspaceStore.getState().setActiveSurface('agents')
            workspaceStore.getState().setGlobalPanel(null)
            changeView('chat')
          }}
          onSignIn={props.account.onSignIn}
          onSignOut={() => void props.account.onSignOut()}
          open
          restoreFocusRef={settingsOpener}
          services={props.services}
          workspace={props.activeWorkspace!}
        />
      </Show>
      <Show when={props.activeWorkspace && workspaceSettingsOpen()}>
        <WorkspaceDetailsOverlay
          workspaceOrder={orderedWorkspaces()}
          client={props.client}
          onClose={() => {
            setHashWorkspaceSettingsOpen(false)
            workspaceStore.getState().setGlobalPanel(null)
          }}
          open
          services={props.services}
          workspace={props.activeWorkspace!}
        />
      </Show>
      {/* Both dialogs mount only when their panel opens: an always-mounted
          lazyComponent fetches its chunk at startup, which silently defeats
          the code split these boundaries exist to create. */}
      <Show when={globalPanel() === 'plugins' && props.activeWorkspace}>
        <PluginsDialog
          open
          onClose={() => workspaceStore.getState().setGlobalPanel(null)}
          provider={props.services.plugins}
        />
      </Show>
      <Show when={globalPanel() === 'about'}>
        <WorkspaceAboutDialog
          appName={props.services.app?.name ?? 'Adea'}
          appIcon="/icon.svg"
          copyright="Copyright © 2026 0xPlayerOne"
          open
          onOpenChange={(next) => {
            if (!next) workspaceStore.getState().setGlobalPanel(null)
          }}
          restoreFocusRef={aboutOpener}
          openExternal={openExternal}
          platform={props.platform}
          sourceUrl="https://github.com/adea-ai/adea"
          version={props.services.app?.version}
        />
      </Show>
      <Show when={globalPanel() === 'help'}>
        <WorkspaceHelpCenter
          appName={props.services.app?.name ?? 'Adea'}
          open
          restoreFocusRef={helpOpener}
          onClose={() => workspaceStore.getState().setGlobalPanel(null)}
          openExternal={openExternal}
        />
      </Show>
      <Show when={props.updates}>
        {(updates) => (
          <VersionDialog
            channelService={props.services.updates}
            open={updates().open}
            onOpenChange={updates().onOpenChange}
            restoreFocusRef={updatesOpener}
          />
        )}
      </Show>
    </div>
  )
}
