import '../../src/start/globals.css'
import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { workspaceStore } from '@adea-ai/state'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type { DevCommand, Scope } from '@adea-ai/types/dev-runtime'
import { createSharedDevUtilityOwner } from '@adea-ai/dev-view/utility-owner'
import { DesktopFirstRunChat } from '../../src/components/desktop-first-run-chat'
import { createDesktopChatModelHost } from '../../src/lib/desktop-chat-host'

// Mounts the production DesktopFirstRunChat (first-run path: no runtime sessions)
// with a fake runtime and client. The managed Pi status and the lead route are
// controlled per test so the proof can show direct onboarding never depends on
// lead configuration.
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const projectId = '00000000-0000-4000-8000-000000000004'
const repoId = '00000000-0000-4000-8000-000000000007'
const worktreeId = '00000000-0000-4000-8000-000000000008'

let piState: 'ready' | 'absent' =
  (window as unknown as { adeaFirstRunPi?: 'ready' | 'absent' }).adeaFirstRunPi ?? 'ready'
let leadCalls = 0
let workspaceCalls = 0

const runtime: DevRuntimeService = {
  state: () => ({ status: 'ready' }),
  preferenceScope: () => scope,
  projection: async () => ({
    projects: [{ id: projectId, repoIds: [repoId], branch: 'main', sessions: [] }],
  }),
  capabilitySnapshot: async () => {
    throw new Error('Unexpected capability mutation')
  },
  execute: async (command: DevCommand) => {
    let value: unknown
    if (command.operation === 'dev.harness.managedPiStatus')
      value = { state: piState, updatedAt: '2026-10-09T00:00:00Z' }
    else if (command.operation === 'dev.worktree.list')
      value = {
        items: [
          {
            id: worktreeId,
            projectId,
            repoId,
            lifecycle: 'ready',
            archived: false,
            kind: 'primary',
            scope,
            headRef: 'main',
            generation: 1,
            version: 1,
          },
        ],
      }
    else if (command.operation === 'dev.session.list') value = { items: [] }
    else throw new Error(`Unexpected operation: ${command.operation}`)
    return {
      schemaVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      ok: true,
      value,
      observedAt: '2026-10-09T00:00:00Z',
    } as never
  },
  streams: () => ({
    connect: () => ({ open: true, send: () => undefined, close: () => undefined }),
  }),
}

// The workspace roster has an available, non-lead agent and no lead. Direct
// onboarding must read this as usable, independent of the lead route.
const client = {
  getWorkspace: async () => {
    workspaceCalls += 1
    return {
      agents: [
        {
          id: 'agent-research',
          name: 'Research Agent',
          isWorkspaceLead: false,
          lifecycleState: 'active',
          presentationMetadata: {},
          profile: { id: 'profile-research', state: 'available', version: '1' },
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          workspaceId: scope.workspaceId,
        },
      ],
    }
  },
  ensureWorkspaceLead: async () => {
    leadCalls += 1
    throw new Error('lead route is broken for this proof')
  },
  getWorkspaceLead: async () => {
    leadCalls += 1
    throw new Error('lead route is broken for this proof')
  },
} as unknown as AgentHqApiClient

const host = createDesktopChatModelHost(runtime)
let disposeUtilityOwner: () => void = () => undefined
const utilityOwner = createRoot((dispose) => {
  disposeUtilityOwner = dispose
  const owner = createSharedDevUtilityOwner(runtime)
  owner.setView('chat')
  return owner
})

const [mounted] = createSignal(true)
workspaceStore.getState().setSelectedDevProjectId(projectId)
workspaceStore.getState().setMobileSidebarOpen(false)
window.addEventListener('pagehide', () => {
  utilityOwner.dispose()
  disposeUtilityOwner()
})

window.directFirstRunHarness = {
  setPi: (state) => {
    piState = state
  },
  report: () => ({ leadCalls, workspaceCalls }),
}

declare global {
  interface Window {
    directFirstRunHarness: {
      setPi(state: 'ready' | 'absent'): void
      report(): { leadCalls: number; workspaceCalls: number }
    }
  }
}

const root = document.getElementById('harness-root')!
render(
  () => (
    <>
      {mounted() && (
        <DesktopFirstRunChat
          runtime={runtime}
          modelHost={host}
          utilityOwner={utilityOwner}
          client={client}
          fallback={<p>Legacy team chat</p>}
          workspaceId={scope.workspaceId}
          projectNames={new Map([[projectId, 'Canonical project']])}
          temporary={false}
          onSignIn={() => undefined}
          onOpenDev={() => undefined}
        />
      )}
    </>
  ),
  root
)
