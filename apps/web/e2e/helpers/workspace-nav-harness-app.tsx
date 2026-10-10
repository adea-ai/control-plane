import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { For, createMemo, createSignal } from 'solid-js'
import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import { WorkspaceNav } from '../../../../packages/workspace-nav/src/workspace-nav'
import type { NavGroupMode, NavTree } from '../../../../packages/workspace-nav/src/model'
import { workspaceNavFixtures } from './workspace-nav-fixtures'

/**
 * Renders the shared sidebar with fixture data. Every callback appends a line
 * to the "Nav events" log so the spec can assert what the host would receive.
 */
const [activeWorkspaceId, setActiveWorkspaceId] = createSignal('adea-ws')
const [groupBy, setGroupBy] = createSignal<NavGroupMode>('project')
const [selectedLeafId, setSelectedLeafId] = createSignal<string | null>(null)
const [events, setEvents] = createSignal<string[]>([])
const log = (line: string) => setEvents((current) => [...current, line])

const tree = createMemo<NavTree>(() => ({
  activeWorkspaceId: activeWorkspaceId(),
  needsYou: workspaceNavFixtures.reduce((total, ws) => total + ws.summary.needsYou, 0),
  // Collapsed workspaces read counts only; projects are sent for the active one.
  workspaces: workspaceNavFixtures.map((workspace) =>
    workspace.id === activeWorkspaceId() ? workspace : { ...workspace, projects: undefined }
  ),
}))

render(
  () => (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <div class="flex w-64 flex-col p-2">
        <WorkspaceNav
          creationContext={(() => {
            // Test-only owner feed (?owner=): proves a known label reaches
            // the draft row through the host call-site chain.
            const owner = new URLSearchParams(window.location.search).get('owner')
            return owner === null ? undefined : { ownerLabel: owner }
          })()}
          tree={tree()}
          view="dev"
          groupBy={groupBy()}
          onGroupByChange={(mode) => {
            log(`group:${mode}`)
            setGroupBy(mode)
          }}
          selectedLeafId={selectedLeafId()}
          onSelectLeaf={(leaf) => {
            log(`leaf:${leaf.id}`)
            setSelectedLeafId(leaf.id)
          }}
          onSelectWorkspace={(id) => {
            log(`workspace:${id}`)
            setActiveWorkspaceId(id)
          }}
          onCreateWorkspace={(name) => log(`create-workspace:${name}`)}
          onCreateProject={(id) => log(`create-project:${id}`)}
          onOpenWorkspaceSettings={(id) => log(`settings:${id}`)}
          onCreateLeaf={(project) => log(`create-leaf:${project.id}`)}
          onProjectMenuAction={(id, project) => log(`project-menu:${id}:${project.id}`)}
          onLeafMenuAction={(id, leaf) => log(`leaf-menu:${id}:${leaf.id}`)}
        />
      </div>
      <ol aria-label="Nav events">
        <For each={events()}>{(line) => <li>{line}</li>}</For>
      </ol>
    </TooltipProvider>
  ),
  document.querySelector('#harness-root')!
)
