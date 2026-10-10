import type { AgentSummary, ProjectSummary } from '@adea-ai/types'
import { Bot, MessageCircle, Pencil, Plus, ShieldAlert, X } from 'lucide-solid'
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'

import { AgentStatus } from './agent-status'
import { agentProfileActionNotice } from './agent-profile-notice'
import { agentProfileStateNotice } from './agent-profile-state'
import { keyedRows } from './keyed-rows'
import { WorkspaceEmpty } from './workspace-states'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { PropertyList, PropertyTerm, PropertyValue } from '@adea-ai/ui/components/composites/stat'
import { Avatar, AvatarFallback } from '@adea-ai/ui/components/ui/avatar'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@adea-ai/ui/components/ui/card'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'

export type AgentCustomizationInput = Readonly<{
  avatarRef: string | null
  characterRef: string | null
  name: string
  profileId: string
  profileVersion: string
  roleSummary: string | null
  projectId: string | null
}>

type Props = Readonly<{
  /** Lead setup status, placed inside the directory's padding under the header. */
  leadStatus?: JSX.Element
  agents: readonly AgentSummary[]
  busy: boolean
  onCreate: (
    input: Readonly<{
      name: string
      profileId: string
      profileVersion: string
      roleSummary?: string
    }>
  ) => Promise<void>
  onArchive: (agentId: string) => Promise<void>
  onMessage: (agentId: string) => Promise<void>
  onUpdate: (agent: AgentSummary, input: AgentCustomizationInput) => Promise<void>
  projects: readonly ProjectSummary[]
}>

export function AgentRoster(props: Props) {
  const [creating, setCreating] = createSignal(false)
  // Keep the opening revision through refetches; a concurrent edit must conflict.
  const [editingAgent, setEditingAgent] = createSignal<AgentSummary | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const projectById = createMemo(
    () => new Map(props.projects.map((project) => [project.id, project]))
  )
  // Keyed by agent id: an agents refetch updates cards in place instead of
  // remounting the grid on every new object identity.
  const agentRows = keyedRows(
    () => props.agents,
    (agent) => agent.id,
    (previous, next) => previous.updatedAt === next.updatedAt
  )

  return (
    <section class="conventional-directory" aria-labelledby="agent-roster-title">
      <header class="conventional-surface-header">
        <div>
          <span>Durable identities</span>
          <h1 id="agent-roster-title">Agents</h1>
          <p>Status reflects configuration only. Runtime availability arrives later.</p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          New Agent
          <Bot aria-hidden="true" />
        </Button>
      </header>
      <Show when={props.leadStatus}>
        {(status) => <div class="conventional-surface-status">{status()}</div>}
      </Show>
      <Show when={creating()}>
        <AgentCreateForm
          busy={props.busy}
          error={error()}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            setError(null)
            try {
              await props.onCreate(input)
              setCreating(false)
            } catch (cause) {
              setError(agentProfileActionNotice(cause))
            }
          }}
        />
      </Show>
      <Show when={editingAgent()} keyed>
        {(agent) => (
          <AgentCustomizationForm
            agent={agent}
            busy={props.busy}
            error={error()}
            onArchive={async (target) => {
              setError(null)
              try {
                await props.onArchive(target.id)
                setEditingAgent(null)
              } catch {
                setError('Agent could not be archived. Resolve linked constraints and retry.')
              }
            }}
            onCancel={() => setEditingAgent(null)}
            onSubmit={async (target, input) => {
              setError(null)
              try {
                await props.onUpdate(target, input)
                setEditingAgent(null)
              } catch (cause) {
                setError(agentProfileActionNotice(cause))
              }
            }}
            projects={props.projects}
          />
        )}
      </Show>
      <div class="conventional-agent-grid">
        <For each={agentRows()}>
          {(entry) => (
            <article>
              <Card>
                <CardHeader>
                  <Avatar size="lg" aria-hidden="true">
                    <AvatarFallback name={entry.item().name} />
                  </Avatar>
                  <CardTitle role="heading" aria-level="2">
                    {entry.item().name}
                  </CardTitle>
                  <AgentStatus agent={entry.item()} compact />
                </CardHeader>
                <CardContent>
                  <div class="grid gap-3">
                    <p>{entry.item().roleSummary ?? 'No role summary yet.'}</p>
                    <PropertyList>
                      <PropertyTerm>Profile</PropertyTerm>
                      <PropertyValue>
                        {entry.item().profile.id} · {entry.item().profile.version}
                      </PropertyValue>
                      <PropertyTerm>Project</PropertyTerm>
                      <PropertyValue>
                        {entry.item().projectId
                          ? (projectById().get(entry.item().projectId!)?.name ??
                            'Unavailable Project')
                          : 'Unassigned'}
                      </PropertyValue>
                      <PropertyTerm>Profile state</PropertyTerm>
                      <PropertyValue>{entry.item().profile.state}</PropertyValue>
                    </PropertyList>
                    <Show when={entry.item().profile.state !== 'available'}>
                      <p>{agentProfileStateNotice(entry.item().profile)}</p>
                    </Show>
                  </div>
                </CardContent>
                <CardFooter>
                  <div class="flex w-full flex-col items-stretch gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void props.onMessage(entry.item().id)}
                    >
                      <MessageCircle aria-hidden="true" />
                      Open conversation
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setEditingAgent(entry.item())}
                    >
                      <Pencil aria-hidden="true" />
                      Customize
                    </Button>
                  </div>
                </CardFooter>
              </Card>
            </article>
          )}
        </For>
      </div>
      <Show when={!props.agents.length}>
        <WorkspaceEmpty
          title="No Agents yet"
          detail="Create a durable Agent identity, then start a direct conversation."
        />
      </Show>
    </section>
  )
}

function AgentCustomizationForm(props: {
  agent: AgentSummary
  busy: boolean
  error: string | null
  onArchive: (agent: AgentSummary) => Promise<void>
  onCancel: () => void
  onSubmit: (agent: AgentSummary, input: AgentCustomizationInput) => Promise<void>
  projects: readonly ProjectSummary[]
}) {
  const [archiveConfirmation, setArchiveConfirmation] = createSignal(false)
  return (
    <form
      class="conventional-inline-form conventional-agent-customization"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void props.onSubmit(props.agent, {
          avatarRef: String(form.get('avatarRef') ?? '').trim() || null,
          characterRef: String(form.get('characterRef') ?? '').trim() || null,
          name: String(form.get('name') ?? ''),
          profileId: String(form.get('profileId') ?? ''),
          profileVersion: String(form.get('profileVersion') ?? ''),
          roleSummary: String(form.get('roleSummary') ?? '').trim() || null,
          projectId: String(form.get('projectId') ?? '').trim() || null,
        })
      }}
    >
      <div class="conventional-inline-form__header">
        <div>
          <h2>Customize {props.agent.name}</h2>
          <p>Stable identity · {props.agent.id}</p>
        </div>
        <ActionButton
          type="button"
          aria-label="Close Agent customization"
          tooltip="Close Agent customization"
          variant="ghost"
          size="icon-sm"
          onClick={() => props.onCancel()}
        >
          <X aria-hidden="true" />
        </ActionButton>
      </div>
      <AgentStatus agent={props.agent} />
      <div class="conventional-form-grid">
        <Label>
          Name
          <Input name="name" required maxLength={120} value={props.agent.name} />
        </Label>
        <Label>
          Project
          <NativeSelect
            name="projectId"
            value={props.agent.projectId ?? ''}
            options={[
              { value: '', label: 'Unassigned' },
              ...props.projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        </Label>
        <Label class="col-span-full">
          Role or persona
          <Textarea
            name="roleSummary"
            rows={3}
            maxLength={500}
            value={props.agent.roleSummary ?? ''}
          />
        </Label>
        <Label>
          Avatar reference
          <Input
            name="avatarRef"
            maxLength={500}
            value={props.agent.avatarRef ?? ''}
            placeholder="Optional stable asset reference"
          />
        </Label>
        <Label>
          Character reference
          <Input
            name="characterRef"
            maxLength={500}
            value={props.agent.characterRef ?? ''}
            placeholder="Optional character reference"
          />
        </Label>
        <AgentProfileFields profile={props.agent.profile} />
      </div>
      <Show when={props.error}>{(error) => <p role="alert">{error()}</p>}</Show>
      <div class="conventional-agent-customization__actions">
        <Button type="submit" disabled={props.busy}>
          {props.busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Show
          when={archiveConfirmation()}
          fallback={
            <Button
              type="button"
              variant="outline"
              disabled={props.busy}
              onClick={() => setArchiveConfirmation(true)}
            >
              Archive Agent
            </Button>
          }
        >
          <div
            class="conventional-destructive-confirmation"
            role="alertdialog"
            aria-label={`Archive ${props.agent.name}`}
          >
            <ShieldAlert aria-hidden="true" />
            <p>
              Archive this Agent? Durable conversations and history remain linked to its stable
              identity.
            </p>
            <Button
              type="button"
              disabled={props.busy}
              onClick={() => void props.onArchive(props.agent)}
            >
              Confirm archive
            </Button>
            <Button type="button" onClick={() => setArchiveConfirmation(false)}>
              Cancel
            </Button>
          </div>
        </Show>
      </div>
      <p class="conventional-agent-delete-note">
        Permanent deletion is unavailable because it would break durable identity and conversation
        references.
      </p>
    </form>
  )
}

function AgentCreateForm(props: {
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: Props['onCreate']
}) {
  return (
    <form
      class="conventional-inline-form"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void props.onSubmit({
          name: String(form.get('name') ?? ''),
          profileId: String(form.get('profileId') ?? ''),
          profileVersion: String(form.get('profileVersion') ?? ''),
          roleSummary: String(form.get('roleSummary') ?? ''),
        })
      }}
    >
      <div class="conventional-inline-form__header">
        <h2>Create Agent</h2>
        <ActionButton
          type="button"
          aria-label="Cancel Agent creation"
          tooltip="Cancel Agent creation"
          variant="ghost"
          size="icon-sm"
          onClick={() => props.onCancel()}
        >
          <X aria-hidden="true" />
        </ActionButton>
      </div>
      <Label>
        Name
        <Input name="name" required maxLength={120} />
      </Label>
      <Label>
        Role or persona
        <Textarea name="roleSummary" rows={2} maxLength={500} />
      </Label>
      <AgentProfileFields />
      <Show when={props.error}>{(error) => <p role="alert">{error()}</p>}</Show>
      <Button type="submit" disabled={props.busy}>
        {props.busy ? 'Creating…' : 'Create Agent'}
      </Button>
    </form>
  )
}

function AgentProfileFields(props: { profile?: AgentSummary['profile'] }) {
  const id = props.profile?.id ?? ''
  const version = props.profile?.version ?? ''
  return (
    <>
      <Label>
        Profile ID
        <Input name="profileId" required placeholder="prf_…" maxLength={30} value={id} />
      </Label>
      <Label>
        Profile version ID
        <Input name="profileVersion" required placeholder="pfv_…" maxLength={30} value={version} />
      </Label>
      <p class="conventional-settings-note col-span-full">
        Published, approved IDs: Workspace settings › Skills. Future submissions.
      </p>
    </>
  )
}
