import { createSignal, Show } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'

import {
  describeWorkspaceCreationContext,
  type WorkspaceCreationContext,
} from '@adea-ai/workspace-nav/workspace-nav'

export function WorkspaceEmpty(props: {
  onCreate(name: string): Promise<void>
  /** Owner/placement facts when the host knows them; unknown labels render honestly. */
  creationContext?: WorkspaceCreationContext
}) {
  const [name, setName] = createSignal('')
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal('')
  const create = async () => {
    if (!name().trim() || name().trim().length > 80 || pending()) return
    setPending(true)
    setError('')
    try {
      await props.onCreate(name().trim())
    } catch {
      setError('Workspace could not be created. Try again.')
    } finally {
      setPending(false)
    }
  }
  return (
    <section
      class="flex min-h-screen flex-col items-center justify-center gap-4"
      aria-label="No workspaces"
    >
      <h1>No workspaces yet</h1>
      <p>Create a workspace to start fresh.</p>
      <p>{describeWorkspaceCreationContext(props.creationContext)}</p>
      <Label for="empty-new-workspace">New workspace name</Label>
      <Input
        id="empty-new-workspace"
        class="max-w-sm"
        value={name()}
        disabled={pending()}
        maxLength={80}
        onInput={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void create()
        }}
      />
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Button disabled={pending() || !name().trim()} onClick={() => void create()}>
        {pending() ? 'Creating…' : 'Create workspace'}
      </Button>
    </section>
  )
}
