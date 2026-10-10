// Desktop runtime entry for the single workspace UI. The shell injects
// `window.__adeaDesktop` before this client boots, so this entry owns only the
// shell session bootstrap (guest credential, PKCE sign-in) and the start
// surface; the workspace itself renders through the shared
// `WorkspaceNavigation`.
import { createEffect, createMemo, createSignal, lazy, onCleanup, onMount, Show } from 'solid-js'
import type { AgentHqApiClient, ApiWorkspaceDeleteResponse } from '@adea-ai/api-client'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type { DesktopSession } from '@adea-ai/auth/desktop'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import type {
  WorkspacePlatformServices,
  UpdateChannelSetting,
} from '@adea-ai/workspace-ui/platform'
import { noteUpdatePhase } from '@adea-ai/workspace-ui/update-pending'
import type { DevProjectFlow } from '@adea-ai/workspace-ui/create-project-flow'
import type { WorkspaceSummary } from '@adea-ai/types'
import { invoke, listen, pickDesktopFolder } from '../lib/desktop-bridge'
import { createDesktopDevRuntimeService } from '../lib/desktop-dev-runtime'
import { createDesktopWorkspaceConnectionsService } from '../lib/desktop-workspace-connections'
import {
  createDesktopDevScopeSelector,
  devScopeCredential,
  type DesktopDevScopeSelector,
} from '../lib/desktop-dev-scope'
import { localContentAuthority } from '../lib/desktop-local-content'
import { desktopMemoryService } from '../lib/desktop-memory'
import {
  desktopCapabilityProvider,
  desktopSettingsProvider,
  registerDesktopWindowSurfaceMirror,
  systemTranscriptionProvider,
} from '../lib/desktop-platform-services'

// The glass appearance setting drives the native window's transparency
// (applied at window creation, so a change lands on relaunch); this module is
// desktop-only, so registering here never arms the mirror on the web lane.
registerDesktopWindowSurfaceMirror()
import { desktopRuntime } from '../lib/desktop-runtime'
import {
  bootstrapDesktopWorkspace,
  createWorkspaceRequestGuard,
  loadTemporaryWorkspaceCredential,
  type DesktopWorkspaceBootstrap,
} from '../lib/desktop-workspace-session'
import { createDeferredPluginsProvider, WorkspaceNavigation } from './workspace-navigation'
import { DesktopFirstRunChat } from './desktop-first-run-chat'
import { createDevSummaryPoll } from '../lib/dev-summary-poll'
import { createDesktopChatModelHost } from '../lib/desktop-chat-host'
import { createSharedDevUtilityOwner } from '@adea-ai/dev-view/utility-owner'
import type { WorkspaceShellProps } from './workspace-shell'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import {
  desktopWorkspaceDeletion,
  type PendingWorkspaceCleanup,
} from '../lib/desktop-workspace-deletion'

const WorkspaceEmpty = lazy(() =>
  import('./workspace-empty').then((module) => ({ default: module.WorkspaceEmpty }))
)

type AppStatus =
  | 'authenticated'
  | 'failed'
  | 'guest'
  | 'loading'
  | 'offline'
  | 'opening'
  | 'waiting'

const statusMark: Record<AppStatus, string> = {
  authenticated: 'ready',
  failed: 'error',
  guest: 'active',
  loading: 'active',
  offline: 'warning',
  opening: 'active',
  waiting: 'active',
}

export function DesktopWorkspaceEntry(props: {
  virtual: boolean
  virtualProps: WorkspaceShellProps
  characterDesigner?: boolean
  roomDesigner?: boolean
}) {
  const runtime = desktopRuntime()
  const [status, setStatus] = createSignal<AppStatus>('loading')
  const [message, setMessage] = createSignal('Opening your workspace…')
  const [workspaceState, setWorkspaceState] = createSignal<DesktopWorkspaceBootstrap | null>(null)
  const [session, setSession] = createSignal<DesktopSession | undefined>()
  const [appVersion, setAppVersion] = createSignal('0.0.0')
  const [updatesOpen, setUpdatesOpen] = createSignal(false)
  // Seed the update-pending badge from the shell's own updater state once per
  // desktop session. `desktop_update_status` answers from (or lazily starts)
  // the same check the version dialog drives — no second update-checker — so
  // the rail dot lights before the user ever opens the dialog.
  onMount(() => {
    void invoke<{ phase: string }>('desktop_update_status')
      .then((snapshot) => noteUpdatePhase(snapshot.phase))
      .catch(() => noteUpdatePhase(undefined))
  })
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  let temporaryCredential: string | null = null
  let clientRef: AgentHqApiClient | undefined
  const [pendingCleanup, setPendingCleanup] = createSignal<readonly PendingWorkspaceCleanup[]>([])
  const [cleanupBusy, setCleanupBusy] = createSignal(false)
  const deletion = desktopWorkspaceDeletion({
    credential: () => devScopeCredential(session(), temporaryCredential),
    pending: setPendingCleanup,
  })
  async function retryCleanup() {
    setCleanupBusy(true)
    try {
      const pending = await deletion.resume()
      for (const receipt of pending.filter((item) => item.state === 'local_complete')) {
        const client = clientRef
        if (!client) continue
        const { workspace } = await client.getWorkspace(receipt.workspaceId)
        await client.deleteWorkspace(receipt.workspaceId, {
          confirmationName: workspace.name,
          expectedVersion: workspace.version,
        })
      }
      await openWorkspace(session())
    } catch {
      await deletion.refreshPending().catch(() => undefined)
    } finally {
      setCleanupBusy(false)
    }
  }
  const workspaceRequestGuard = createWorkspaceRequestGuard()
  let authCallbackObserved = false
  // Each cloud workspace owns its own Dev partition: the shell selects the
  // device workspace scope only after proving membership with this session's
  // credential (ADR 0011). Dev mounts per workspace and re-reads its scope
  // after the selection settles.
  const devScope = createDesktopDevScopeSelector({
    credential: () => devScopeCredential(session(), temporaryCredential),
  })
  const activeWorkspace = (): WorkspaceSummary | undefined => {
    const state = workspaceState()
    return state
      ? (state.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
          state.workspace ??
          undefined)
      : undefined
  }
  // The plugins provider reads these lazily, so accessors deliver the current
  // ids directly — no mutable variables synchronized through effects.
  const plugins = createDeferredPluginsProvider({
    client: () => clientRef!,
    getWorkspaceId: () => activeWorkspace()?.id,
    getUserId: () => workspaceState()?.userId,
    requestedHarness: 'codex',
  })

  createEffect(() => {
    void runtime
      .getUserVersion()
      .then((version) => setAppVersion(version))
      .catch(() => undefined)
  })

  const openWorkspace = async (activeSession?: DesktopSession) => {
    const requestIsCurrent = workspaceRequestGuard.begin()
    setSession(activeSession)
    setStatus('loading')
    setMessage(
      activeSession ? 'Opening your saved workspace…' : 'Opening a private guest workspace…'
    )
    try {
      let storedTemporaryCredential = temporaryCredential
      if (!storedTemporaryCredential) {
        storedTemporaryCredential = await loadTemporaryWorkspaceCredential(
          runtime.temporaryVault.load
        )
      }
      const nextWorkspace = await bootstrapDesktopWorkspace({
        createClient: ({ session: clientSession, temporaryCredential: guestCredential }) =>
          runtime.createClient(clientSession, guestCredential),
        session: activeSession,
        storedTemporaryCredential,
        onTemporaryCredentialClaimed: () => {
          temporaryCredential = null
        },
        temporaryVault: runtime.temporaryVault,
      })
      if (!requestIsCurrent()) return
      if (nextWorkspace.workspace)
        await localContentAuthority.authorizeWorkspace(nextWorkspace.workspace.id)
      if (!requestIsCurrent()) return
      temporaryCredential = nextWorkspace.temporaryCredential
      // Resume before switching the device authority away from the old scope.
      await deletion.resume().catch(() => undefined)
      // Select the Dev scope for the bootstrapped workspace before Dev mounts.
      // A refusal never blocks the workspace: Dev reports itself unavailable.
      if (nextWorkspace.workspace)
        await devScope.select(
          nextWorkspace.workspace.id,
          devScopeCredential(activeSession, nextWorkspace.temporaryCredential)
        )
      if (!requestIsCurrent()) return
      // The scene is a router fact; WorkspaceNavigation reconciles the URL to
      // this workspace's scene once it mounts with the summary.
      workspaceStore.getState().switchWorkspace(nextWorkspace.workspace?.id ?? null)
      temporaryCredential = nextWorkspace.temporaryCredential
      setWorkspaceState(nextWorkspace)
      setStatus(activeSession ? 'authenticated' : 'guest')
      setMessage(
        activeSession
          ? 'Your workspace is saved to your Adea account.'
          : nextWorkspace.temporaryCredentialPersisted
            ? 'You can use this workspace now. Sign in whenever you want to save it to an account.'
            : 'You can use this workspace now. Sign in before closing the app to save it to an account.'
      )
    } catch {
      if (!requestIsCurrent()) return
      setStatus('offline')
      setMessage('Adea could not reach the workspace service. Your local credentials are safe.')
    }
  }

  createEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void runtime.sessionManager.restore().then((sessionState) => {
      if (disposed || authCallbackObserved) return
      void openWorkspace(sessionState.status === 'authenticated' ? sessionState.session : undefined)
    })

    async function receiveCallback() {
      let callbackUrl: string | null
      try {
        callbackUrl = await invoke<string | null>('desktop_auth_take_callback').catch(() => null)
      } catch {
        return
      }
      if (!callbackUrl || disposed) return
      authCallbackObserved = true
      workspaceRequestGuard.invalidate()
      try {
        const exchange = await runtime.consumeAuthorization(callbackUrl)
        const sessionState = await runtime.sessionManager.completeSignIn(exchange)
        if (sessionState.status !== 'authenticated') throw new Error('Authentication failed')
        await openWorkspace(sessionState.session)
      } catch {
        setStatus('failed')
        setMessage(
          callbackUrl.includes('error=early_access')
            ? "Adea is in early access. Please reach out on github if you'd like to contribute."
            : 'The sign-in callback was invalid or expired. Your guest workspace is unchanged.'
        )
      }
    }

    void listen('desktop-auth-callback-ready', () => void receiveCallback()).then((dispose) => {
      if (disposed) return dispose()
      unlisten = dispose
      void receiveCallback()
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  })

  createEffect(() => {
    const workspace = activeWorkspace()
    if (!workspace) return
    void localContentAuthority.authorizeWorkspace(workspace.id).catch(() => undefined)
  })

  // Stable identity: every reactive reader must get the same client for a
  // given session/workspace — creating one per call means each accessor read
  // allocates a fresh client and breaks reference equality for consumers.
  const client = createMemo(() => {
    const state = workspaceState()
    if (!state) return clientRef
    const nextClient = deletion.attach(
      runtime.createClient(session(), state.temporaryCredential ?? undefined)
    )
    clientRef = nextClient
    return nextClient
  })

  // The account-scoped directory client the global directory and inbox reads
  // through (M11.03). The surface captures ONE instance for its lifetime, so
  // the client re-resolves the session through the live `session` accessor on
  // every request (see `createAccountDirectoryClient`) — a rotation or
  // sign-out in the same workspace is honoured without a remount, unlike a
  // snapshot binding. `undefined` before the first bootstrap lands; the
  // surface only mounts after one.
  const accountDirectoryClient = createMemo(() => {
    const state = workspaceState()
    if (!state) return undefined
    return runtime.createAccountDirectoryClient(session, state.temporaryCredential ?? undefined)
  })

  async function beginSignIn() {
    setStatus('opening')
    setMessage('Opening your system browser…')
    try {
      const nextAttempt = await runtime.beginAuthorization()
      await invoke('desktop_auth_start', {
        authorizationUrl: runtime.authorizationUrl(nextAttempt),
      })
      setStatus('waiting')
      setMessage(
        'Finish signing in in your browser, then return here. This app will reopen automatically.'
      )
    } catch {
      await runtime.cancelAuthorization().catch(() => undefined)
      setStatus(workspaceState()?.temporary ? 'guest' : 'failed')
      setMessage('Adea could not open the trusted sign-in page. Your workspace is unchanged.')
    }
  }

  async function signOut() {
    setUpdatesOpen(false)
    await runtime.sessionManager.signOut().catch(() => undefined)
    setSession(undefined)
    setWorkspaceState(null)
    await openWorkspace()
  }

  const busy = () => status() === 'loading' || status() === 'opening' || status() === 'waiting'

  return (
    <>
      <Show when={pendingCleanup().length}>
        <Alert>
          <AlertDescription>
            Workspace device cleanup is pending. Keep this device online and retry cleanup.
            <Button variant="outline" disabled={cleanupBusy()} onClick={() => void retryCleanup()}>
              Retry cleanup
            </Button>
          </AlertDescription>
        </Alert>
      </Show>
      <Show
        when={activeWorkspace()}
        fallback={
          <Show
            when={workspaceState() && workspaceState()!.workspaces.length === 0 && client()}
            fallback={
              <DesktopStartSurface
                busy={busy()}
                message={message()}
                onRetry={() => void openWorkspace(session())}
                onSignIn={() => void beginSignIn()}
                showSignIn={!session() && status() !== 'waiting' && status() !== 'opening'}
                status={status()}
              />
            }
          >
            <WorkspaceEmpty
              onCreate={async (name) => {
                await client()!.createWorkspace({ idempotencyKey: crypto.randomUUID(), name })
                await openWorkspace(session())
              }}
              // The bootstrap account label is the only creator identity
              // this host holds; absent labels fall back to the generic
              // owner sentence and unknown placement renders honestly.
              creationContext={{ ownerLabel: workspaceState()?.accountLabel ?? undefined }}
            />
          </Show>
        }
      >
        {(workspace) => (
          // Keyed by workspace id: Dev's runtime, utility owner and chat host
          // bind one verified scope for their lifetime, so a switch remounts
          // them under the newly selected scope instead of reusing the old one.
          <Show when={workspace().id} keyed>
            {(workspaceId) => (
              <DesktopWorkspace
                accountLabel={workspaceState()?.accountLabel ?? undefined}
                activeWorkspace={workspace()}
                devScope={devScope}
                devScopeWorkspaceId={workspaceId}
                appVersion={appVersion()}
                busy={busy()}
                client={client()!}
                accountDirectoryClient={accountDirectoryClient}
                accountPrincipalId={() => workspaceState()?.userId ?? null}
                plugins={plugins}
                characterDesigner={props.characterDesigner ?? false}
                roomDesigner={props.roomDesigner ?? false}
                session={session()}
                onBeginSignIn={beginSignIn}
                onSignOut={signOut}
                onUpdatesOpenChange={setUpdatesOpen}
                updatesOpen={updatesOpen()}
                virtual={props.virtual}
                virtualProps={props.virtualProps}
                workspaces={workspaceState()?.workspaces ?? []}
                onWorkspaceDeleted={(result) =>
                  setWorkspaceState(
                    (current) =>
                      current && {
                        ...current,
                        workspace:
                          result.workspaces.find((candidate) => candidate.isPersonal) ??
                          result.workspaces[0] ??
                          null,
                        workspaces: result.workspaces,
                      }
                  )
                }
              />
            )}
          </Show>
        )}
      </Show>
    </>
  )
}

const DevNewProjectDialog = lazy(() =>
  import('@adea-ai/dev-view/sidebar/dev-nav-dialogs').then((module) => ({
    default: module.DevNewProjectDialog,
  }))
)

function DesktopWorkspace(props: {
  accountLabel?: string
  activeWorkspace: WorkspaceSummary
  onWorkspaceDeleted: (result: ApiWorkspaceDeleteResponse) => void
  appVersion: string
  busy: boolean
  client: AgentHqApiClient
  /** Session-bound builder for the account-wide directory surface (M11.03). */
  accountDirectoryClient: () => AccountDirectoryApiClient | undefined
  /** The shell session's principal id, for the account cache guard (M11.03). */
  accountPrincipalId: () => string | null | undefined
  devScope: DesktopDevScopeSelector
  devScopeWorkspaceId: string
  plugins: ReturnType<typeof createDeferredPluginsProvider>
  characterDesigner: boolean
  roomDesigner: boolean
  session: DesktopSession | undefined
  onBeginSignIn: () => Promise<void>
  onSignOut: () => Promise<void>
  onUpdatesOpenChange: (open: boolean) => void
  updatesOpen: boolean
  virtual: boolean
  virtualProps: WorkspaceShellProps
  workspaces: readonly WorkspaceSummary[]
}) {
  const signedIn = () => Boolean(props.session)
  const accountLabel = () => (signedIn() ? (props.accountLabel ?? 'Account') : 'Not signed in')
  // Invariant services are built once: rebuilding the object per evaluation
  // would also rebuild the dev runtime service on every busy/version update.
  // The scope is read only after this workspace's selection settles; a shell
  // scope for any other workspace keeps Dev unavailable (fail closed).
  const [projectAnnouncement, setProjectAnnouncement] = createSignal('')
  const renderProjectDialog: DevProjectFlow['renderDialog'] = (dialog) => (
    <DevNewProjectDialog
      scope={dialog.flow.scope}
      execute={dialog.flow.execute}
      knownProjectNames={dialog.flow.knownProjectNames}
      announce={setProjectAnnouncement}
      pickFolder={() => pickDesktopFolder()}
      workspaceName={dialog.workspaceName}
      onCreateProject={dialog.flow.onCreateProject}
      onImported={dialog.onImported}
      onClose={dialog.onClose}
    />
  )
  const devRuntime = createDesktopDevRuntimeService({
    scopeSelection: props.devScope.ensure(props.devScopeWorkspaceId),
    expectedWorkspaceId: props.devScopeWorkspaceId,
  })
  const connections = createDesktopWorkspaceConnectionsService(devRuntime)
  const chatModelHost = createDesktopChatModelHost(devRuntime)
  const utilityOwner = createSharedDevUtilityOwner(
    devRuntime,
    typeof window === 'undefined' ? undefined : window.localStorage
  )
  onCleanup(() => utilityOwner.dispose())
  // Collapsed workspace chips and "Needs you" read the desktop run counts.
  const devSummary = createDevSummaryPoll(devRuntime)
  const services = (): WorkspacePlatformServices => ({
    account: {
      authenticated: signedIn(),
      busy: props.busy,
      label: accountLabel(),
      onSignIn: () => void props.onBeginSignIn(),
      onSignOut: () => void props.onSignOut(),
    },
    app: { name: 'Adea', platform: 'desktop', version: props.appVersion },
    capabilities: desktopCapabilityProvider,
    client: props.client,
    connections,
    devRuntime,
    memory: desktopMemoryService,
    privateContent: localContentAuthority,
    plugins: props.plugins,
    settings: desktopSettingsProvider,
    transcription: systemTranscriptionProvider,
    updates: {
      channel: () => invoke<UpdateChannelSetting>('desktop_update_channel'),
      setChannel: (channel) =>
        invoke<UpdateChannelSetting>('desktop_update_channel_save', { channel }),
    },
  })

  return (
    <>
      <WorkspaceNavigation
        renderProjectDialog={renderProjectDialog}
        account={{
          authenticated: signedIn(),
          busy: props.busy,
          label: accountLabel(),
          onOpenUpdates: () => props.onUpdatesOpenChange(true),
          onSignIn: () => void props.onBeginSignIn(),
          onSignOut: () => void props.onSignOut(),
        }}
        activeWorkspace={props.activeWorkspace}
        onWorkspaceDeleted={props.onWorkspaceDeleted}
        devSummary={devSummary}
        chatEntry={(fallback, archiveAction, sidebarOpener, workspaceNav, teamChat) => (
          <DesktopFirstRunChat
            workspaceNav={workspaceNav}
            teamChat={teamChat}
            sidebarOpener={sidebarOpener}
            archiveAction={archiveAction}
            client={props.client}
            fallback={fallback}
            onOpenDev={() => {
              const nextUrl = new URL(window.location.href)
              nextUrl.searchParams.set('view', 'dev')
              window.history.replaceState(null, '', nextUrl)
              window.dispatchEvent(new PopStateEvent('popstate'))
            }}
            runtime={devRuntime}
            modelHost={chatModelHost}
            utilityOwner={utilityOwner}
            onCanonicalConversation={(binding) =>
              utilityOwner.handoffCanonicalChatConversation(binding)
            }
            onSignIn={props.onBeginSignIn}
            pickFolder={() => pickDesktopFolder()}
            temporary={!signedIn()}
            workspaceId={props.activeWorkspace.id}
          />
        )}
        client={props.client}
        accountDirectoryClient={props.accountDirectoryClient}
        accountPrincipalId={props.accountPrincipalId}
        onAuthorizeWorkspace={async (workspaceId) => {
          await localContentAuthority.authorizeWorkspace(workspaceId)
          // Switching workspaces switches the Dev scope before the store does;
          // the selection result is awaited, never thrown.
          await props.devScope.select(workspaceId)
        }}
        platform="desktop"
        characterDesigner={props.characterDesigner}
        roomDesigner={props.roomDesigner}
        services={services()}
        updates={{ open: props.updatesOpen, onOpenChange: props.onUpdatesOpenChange }}
        utilityOwner={utilityOwner}
        virtual={props.virtual}
        virtualProps={props.virtualProps}
        workspaces={props.workspaces}
      />
      <p class="sr-only" aria-live="polite">
        {projectAnnouncement()}
      </p>
    </>
  )
}

/** The pre-workspace surface the desktop entry shows while no workspace is
 * active: loading, offline, or failed. Exported for the start-surface
 * presentation harness; the runtime entry keeps owning when it mounts. */
export function DesktopStartSurface(props: {
  busy: boolean
  message: string
  onRetry(): void
  onSignIn(): void
  showSignIn: boolean
  status: AppStatus
}) {
  return (
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="desktop-title" aria-busy={props.busy}>
        <p class="auth-eyebrow">Adea desktop</p>
        <h1 class="auth-title" id="desktop-title">
          Your workspace, ready when you are.
        </h1>
        <p class="auth-introduction">
          Start immediately without an account. Sign in later to keep this workspace across devices.
        </p>

        <div class="auth-status" role="status" aria-live="polite">
          <span
            class={`auth-status__mark auth-status__mark--${statusMark[props.status]}`}
            aria-hidden="true"
          />
          <p>{props.message}</p>
        </div>

        <div class="auth-actions">
          <Show when={props.status === 'offline' || props.status === 'failed'}>
            <Button type="button" onClick={() => props.onRetry()}>
              Try again
            </Button>
            <Show when={props.showSignIn}>
              <Button type="button" variant="outline" onClick={() => props.onSignIn()}>
                Sign in
              </Button>
            </Show>
          </Show>
        </div>

        <p class="auth-note">
          Guest access is protected by a device-only keychain credential. Optional sign-in uses
          PKCE; no session token is placed in the browser callback URL.
        </p>
      </section>
    </main>
  )
}
