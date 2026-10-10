import type { AgentSummary, ProjectSummary, TaskSummary } from '@adea-ai/types'

import { describeExecutionAttempt } from './execution-location-copy'
import {
  captureDialogBackgroundState,
  hasVisibleModal,
  restoreDialogBackgroundState,
} from './dialog-background-state'
import {
  Archive,
  Bot,
  Check,
  CheckCircle2,
  CircleSlash,
  MessageCircle,
  Play,
  Plus,
  Send,
  Square,
} from 'lucide-solid'
import { createMemo, createSignal, createUniqueId, For, onCleanup, type JSX, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { FormField } from '@adea-ai/ui/components/ui/field'
import { Input } from '@adea-ai/ui/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type MenuSwatchTone,
} from '@adea-ai/ui/components/ui/select'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@adea-ai/ui/components/ui/sheet'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'

import { keyedRows } from './keyed-rows'
import type { PrivateContentResolver } from './platform'
import { ProjectIcon } from './project-icon'
import { kindOptions, laneFor, priorityOptions, swatchTone } from './task-presentation'

type TaskUpdate = Readonly<{
  kind?: TaskSummary['kind']
  objective?: string
  priority?: TaskSummary['priority']
  title?: string
}>

type SharedProps = Readonly<{
  agents: readonly AgentSummary[]
  busy: boolean
  onClose: () => void
  /** Reports a write that failed after the panel closed. */
  onError?: (message: string) => void
  privateContent?: PrivateContentResolver
  projects: readonly ProjectSummary[]
  tasks: readonly TaskSummary[]
}>

type CreateProps = SharedProps &
  Readonly<{
    mode: 'create'
    onCreate: (
      input: Readonly<{
        kind?: TaskSummary['kind']
        objective: string
        priority: TaskSummary['priority']
        title: string
      }>
    ) => Promise<void>
  }>

type EditProps = SharedProps &
  Readonly<{
    mode: 'edit'
    task: TaskSummary
    onArchive: (task: TaskSummary) => Promise<void>
    onAssign: (task: TaskSummary, agentId: string | null) => Promise<void>
    onCancel: (task: TaskSummary) => Promise<void>
    onComplete: (task: TaskSummary) => Promise<void>
    onDependencies: (task: TaskSummary, dependencyIds: readonly string[]) => Promise<void>
    onMoveProject: (task: TaskSummary, projectId: string | null) => Promise<void>
    onOpenConversation: (task: TaskSummary) => void
    onQueue: (task: TaskSummary) => Promise<void>
    onReview: (task: TaskSummary) => Promise<void>
    onStart: (task: TaskSummary) => Promise<void>
    onUpdate: (task: TaskSummary, update: TaskUpdate) => Promise<void>
  }>

const TITLE_LIMIT = 200
const OBJECTIVE_LIMIT = 20_000
const NONE = ''

type PickerOption = Readonly<{
  value: string
  label: string
  Icon: () => JSX.Element
  /** The card-badge tint this option shows as a leading dot; absent for pickers without a tone. */
  swatch?: MenuSwatchTone
}>

/**
 * A labelled Select. The shared Select does not read FormField's context, so
 * the visible label names the trigger through `aria-labelledby` instead.
 */
function PickerField(
  props: Readonly<{
    label: string
    value: string
    options: readonly PickerOption[]
    disabled?: boolean
    onChange: (value: string) => void
  }>
) {
  const labelId = createUniqueId()
  const selected = () => props.options.find((option) => option.value === props.value)
  return (
    <div class="conventional-task-panel__field">
      <span id={labelId} class="conventional-task-panel__label">
        {props.label}
      </span>
      <Select<PickerOption>
        options={[...props.options]}
        value={selected()}
        onChange={(option) => option && props.onChange(option.value)}
        optionValue="value"
        optionTextValue="label"
        disabled={props.disabled}
        itemComponent={(item) => (
          <SelectItem item={item.item} swatch={item.item.rawValue.swatch}>
            <span class="conventional-task-panel__option">
              <Dynamic component={item.item.rawValue.Icon} />
              {item.item.rawValue.label}
            </span>
          </SelectItem>
        )}
      >
        <SelectTrigger class="w-full" aria-labelledby={labelId}>
          <SelectValue>
            {() => (
              <span class="conventional-task-panel__option">
                <Show when={selected()}>{(option) => <Dynamic component={option().Icon} />}</Show>
                {selected()?.label}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    </div>
  )
}

const iconOption = (
  value: string,
  label: string,
  Icon: (props: { 'aria-hidden'?: 'true' }) => JSX.Element,
  swatch?: MenuSwatchTone
): PickerOption => ({ value, label, Icon: () => <Icon aria-hidden="true" />, swatch })

const kindPickerOptions = kindOptions.map((option) =>
  iconOption(option.value, option.label, option.Icon, swatchTone(option.badge))
)
const priorityPickerOptions = priorityOptions.map((option) =>
  iconOption(option.value, option.label, option.Icon, swatchTone(option.badge))
)

/**
 * Creates or edits one Task in an inset Sheet — the same docked panel the
 * Appearance settings use: a heading over a rule, a scrolling body and a
 * full-width footer that holds the decision. The board stays where it is.
 *
 * Edits are a draft. Save is offered only while there is something to save, and
 * saving closes the panel at once: the board already shows the change (task
 * writes are optimistic), and a write the server refuses is reported on the
 * board. Escape, the close button and Cancel discard the draft. Lifecycle
 * actions (Start, Complete…) apply immediately because they are moves, not
 * edits.
 */
let activeBackgroundLease: (() => void) | undefined

/** Cancels the active post-close background lease (a new owner took over). */
export function cancelTaskBackgroundLease() {
  activeBackgroundLease?.()
  activeBackgroundLease = undefined
}

export function TaskPanel(props: CreateProps | EditProps) {
  const editing = () => (props.mode === 'edit' ? props : undefined)
  const initial = props.mode === 'edit' ? props.task : undefined
  let version = initial?.version ?? 0
  const [title, setTitle] = createSignal(initial?.title ?? '')
  const [objective, setObjective] = createSignal(initial?.objective ?? '')
  const [kind, setKind] = createSignal<TaskSummary['kind']>(initial?.kind ?? 'feature')
  const [priority, setPriority] = createSignal<TaskSummary['priority']>(
    initial?.priority ?? 'normal'
  )
  const [agentId, setAgentId] = createSignal<string | null>(initial?.agentId ?? null)
  const [projectId, setProjectId] = createSignal<string | null>(initial?.projectId ?? null)
  const [dependencyIds, setDependencyIds] = createSignal<readonly string[]>(
    initial?.dependencyIds ?? []
  )
  const [dependencyQuery, setDependencyQuery] = createSignal('')
  const [status, setStatus] = createSignal<string | null>(null)
  const [titleError, setTitleError] = createSignal<string | undefined>()
  const [saving, setSaving] = createSignal(false)
  // The sheet must close through Kobalte's own lifecycle: the dialog restores
  // the background's aria-hidden/pointer-events state while it closes, and the
  // parent unmounts this panel in response to onClose. Unmounting first (the
  // previous `open` constant + immediate onClose) raced that restoration and
  // could leave the workspace frame aria-hidden, hiding the board from role
  // queries while it stayed visually rendered.
  const [sheetOpen, setSheetOpen] = createSignal(true)
  const [closePending, setClosePending] = createSignal(false)
  // Set when this panel unmounts. Kobalte dispatches the close autofocus from
  // a timer, so after the board has swapped this panel for another task the
  // stale callback still fires — on a detached content element. It must then
  // do nothing: the newer panel owns the selection, the background, and focus.
  let disposed = false
  const requestClose = () => {
    if (saving() || closePending()) return
    setClosePending(true)
    setSheetOpen(false)
  }
  // Capture the frame element and the state this panel found before its modal
  // hid it, and restore exactly that state once the modal is gone. Kobalte
  // defers its aria-hidden write with setTimeout → requestAnimationFrame and
  // never guards that write against disposal, so a write scheduled before
  // close can land afterwards; this panel-owned repair re-checks on the same
  // deferral window and on frame attribute mutations, restoring only the state
  // captured here. The element is captured once: restoration is bound to the
  // frame the panel actually covered, never to whatever element a later
  // navigation rendered into the same selector.
  const frameElement =
    typeof document === 'undefined'
      ? undefined
      : document.querySelector<HTMLElement>('.workspace-frame')
  const capturedBackground = captureDialogBackgroundState(
    frameElement,
    typeof document === 'undefined' ? { style: { pointerEvents: '' } } : document.body
  )
  // A panel mounted while another modal was still visible (its own sheet was
  // mid-close) records that: the hidden state it found is the other modal's
  // containment, not this frame's baseline, so neither this panel's release
  // nor any lease built from it may restore the frame back into hiding.
  const capturedWhileOtherModalOpen =
    typeof document === 'undefined' ? false : hasVisibleModal(document)
  // Capture the opener synchronously at panel setup: the dialog's own
  // auto-focus can otherwise win the race and make the shared restoration
  // target an element inside the closing content.
  const restoreFocusTarget =
    typeof document === 'undefined' || typeof HTMLElement === 'undefined'
      ? undefined
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined
  // One lease owns the frame's post-close restoration at a time, and it is
  // the earliest close that is still unfinished: a panel mounted while that
  // lease is alive contributes nothing (the lease's other-modal guard defers
  // its work while the new modal owns the background and restores the true
  // pre-open baseline once the last modal closes). Cancelling on mount would
  // hand the baseline to this panel's capture — which, taken mid-close, saw
  // the previous modal's hidden state and would write it back after closing.
  onCleanup(() => {
    disposed = true
    if (typeof document === 'undefined' || !capturedBackground) return
    if (activeBackgroundLease) return
    let cancelled = false
    const restore = () => {
      // Bound to the captured element: a frame replaced by navigation is never
      // read or written, and losing it ends the lease instead of leaving an
      // observer behind.
      if (!frameElement?.isConnected) {
        cancel()
        return
      }
      restoreDialogBackgroundState({
        element: frameElement,
        body: document.body,
        captured: capturedBackground,
        capturedWhileOtherModalOpen,
        hasOtherModal: () => hasVisibleModal(document),
      })
    }
    let observer: MutationObserver | undefined
    const cancel = () => {
      cancelled = true
      observer?.disconnect()
      if (activeBackgroundLease === cancel) activeBackgroundLease = undefined
    }
    if (typeof MutationObserver !== 'undefined' && frameElement) {
      // The lease is owned by this close until the board (or the frame) is
      // gone. A write Kobalte scheduled before disposal can land at any later
      // frame, so it deliberately does not expire on a timer; it only ever
      // restores the state captured before this panel's modal opened and
      // skips while a visible modal owns the background. Solid disposes
      // parent cleanups before child ones (verified: TaskBoard's cancelling
      // cleanup runs first), so a lease created by this panel's own unmount
      // is bounded by the frame's lifetime, not by the board's cancel — the
      // frame-disconnect check above is the guarantee.
      observer = new MutationObserver(() => {
        if (!cancelled) restore()
      })
      observer.observe(frameElement, {
        attributes: true,
        attributeFilter: ['aria-hidden', 'inert'],
      })
      // Frame replacement can nest the removal below body, so liveness needs
      // the subtree, not just body's direct children.
      observer.observe(document.body, { childList: true, subtree: true })
    }
    activeBackgroundLease = cancel
    // Release the background once on the same deferral boundary Kobalte uses;
    // later writes are caught by the observers above.
    setTimeout(() =>
      requestAnimationFrame(() => {
        if (!cancelled) restore()
      })
    )
  })

  const trimmedTitle = () => title().trim()
  const trimmedObjective = () => objective().trim()
  const titleChanged = () => trimmedTitle() !== (initial?.title ?? '')
  const objectiveChanged = () =>
    (trimmedObjective() || undefined) !== (initial?.objective ?? undefined)
  const kindChanged = () => kind() !== (initial?.kind ?? 'feature')
  const priorityChanged = () => priority() !== (initial?.priority ?? 'normal')
  const agentChanged = () => agentId() !== (initial?.agentId ?? null)
  const projectChanged = () => projectId() !== (initial?.projectId ?? null)
  const dependenciesChanged = () =>
    JSON.stringify([...dependencyIds()].toSorted()) !==
    JSON.stringify([...(initial?.dependencyIds ?? [])].toSorted())
  const dirty = () =>
    titleChanged() ||
    objectiveChanged() ||
    kindChanged() ||
    priorityChanged() ||
    agentChanged() ||
    projectChanged() ||
    dependenciesChanged()
  const titleValid = () => trimmedTitle().length > 0 && trimmedTitle().length <= TITLE_LIMIT
  const canSave = () =>
    !saving() && !props.busy && titleValid() && (props.mode === 'create' || dirty())
  const fieldsDisabled = () => props.busy || saving()

  // Refetches hand these lists fresh object identities; keying by id keeps the
  // open list's rows (and their hover/focus) stable.
  const projectRows = keyedRows(
    () => props.projects,
    (project) => project.id
  )
  const agentRows = keyedRows(
    () => props.agents,
    (agent) => agent.id
  )
  const projectOptions = createMemo<PickerOption[]>(() => [
    { value: NONE, label: 'No project', Icon: () => <CircleSlash aria-hidden="true" /> },
    ...projectRows().map((entry) => ({
      value: entry.item().id,
      label: entry.item().name,
      Icon: () => <ProjectIcon iconKey={entry.item().iconKey} />,
    })),
  ])
  const agentOptions = createMemo<PickerOption[]>(() => [
    { value: NONE, label: 'Unassigned', Icon: () => <CircleSlash aria-hidden="true" /> },
    ...agentRows().map((entry) => ({
      value: entry.item().id,
      label: entry.item().name,
      Icon: () => <Bot aria-hidden="true" />,
    })),
  ])

  const dependencyCandidates = createMemo(() =>
    props.tasks.filter(
      (task) =>
        task.id !== initial?.id &&
        task.lifecycleState !== 'archived' &&
        task.title.toLowerCase().includes(dependencyQuery().trim().toLowerCase())
    )
  )
  const dependencyRows = keyedRows(dependencyCandidates, (task) => task.id)
  const toggleDependency = (taskId: string) =>
    setDependencyIds((ids) =>
      ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId]
    )

  const validate = () => {
    if (!trimmedTitle()) {
      setTitleError('Give the task a title.')
      return false
    }
    if (trimmedTitle().length > TITLE_LIMIT) {
      setTitleError(`Keep the title under ${TITLE_LIMIT} characters.`)
      return false
    }
    setTitleError(undefined)
    return true
  }

  /** The writes a Save makes, in order, each against the version the last left. */
  const pendingWrites = (edit: EditProps) => {
    const writes: ((task: TaskSummary) => Promise<void>)[] = []
    const update: {
      kind?: TaskSummary['kind']
      objective?: string
      priority?: TaskSummary['priority']
      title?: string
    } = {}
    if (titleChanged()) update.title = trimmedTitle()
    if (objectiveChanged() && trimmedObjective().length <= OBJECTIVE_LIMIT)
      update.objective = trimmedObjective()
    if (kindChanged()) update.kind = kind()
    if (priorityChanged()) update.priority = priority()
    if (Object.keys(update).length) writes.push((task) => edit.onUpdate(task, update))
    const nextAgent = agentId()
    const nextProject = projectId()
    const nextDependencies = dependencyIds()
    if (agentChanged()) writes.push((task) => edit.onAssign(task, nextAgent))
    if (projectChanged()) writes.push((task) => edit.onMoveProject(task, nextProject))
    if (dependenciesChanged()) writes.push((task) => edit.onDependencies(task, nextDependencies))
    return writes
  }

  const save = async () => {
    if (!canSave() || !validate()) return
    setStatus(null)
    if (props.mode === 'create') {
      setSaving(true)
      let created = false
      try {
        await props.onCreate({
          kind: kind(),
          objective: trimmedObjective(),
          priority: priority(),
          title: trimmedTitle(),
        })
        created = true
      } catch {
        setStatus('The task could not be created. Check the fields and try again.')
      } finally {
        setSaving(false)
      }
      // Close through the dialog lifecycle so the modal restores the
      // background before the board unmounts this panel.
      if (created) requestClose()
      return
    }
    const edit = props
    const writes = pendingWrites(edit)
    let current: TaskSummary = { ...edit.task, version }
    // Close through the dialog lifecycle: the writes are optimistic, so the
    // board already shows the result, but the panel must stay mounted until
    // the modal has restored the background (a bare onClose unmounts early and
    // can leave the workspace frame aria-hidden).
    requestClose()
    try {
      for (const write of writes) {
        await write(current)
        current = { ...current, version: current.version + 1 }
      }
    } catch {
      edit.onError?.(
        `“${edit.task.title}” could not be saved. It may have changed elsewhere; open it and try again.`
      )
    }
  }

  const runLifecycle = async (action: (task: TaskSummary) => Promise<void>) => {
    const edit = editing()
    if (!edit) return false
    setStatus(null)
    try {
      await action({ ...edit.task, version })
      version += 1
      return true
    } catch {
      setStatus('This task changed elsewhere or the request could not be completed. Try again.')
      return false
    }
  }

  const lane = () => {
    const edit = editing()
    return edit ? laneFor(edit.task.lifecycleState) : undefined
  }
  const activeState = () => {
    const state = editing()?.task.lifecycleState
    return (
      state === 'created' || state === 'queued' || state === 'in_progress' || state === 'in_review'
    )
  }

  return (
    <Sheet
      open={sheetOpen()}
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <SheetContent
        side="end"
        closeLabel={props.mode === 'create' ? 'Close new task' : 'Close task'}
        restoreFocusRef={() => (restoreFocusTarget?.isConnected ? restoreFocusTarget : undefined)}
        onCloseAutoFocus={(event) => {
          // Kobalte has finished closing the dialog and restored the background.
          // A stale dispatch after the board swapped this panel for another
          // task must not run: it would clear the newer panel's selection.
          if (disposed) return
          if (!closePending()) return
          setClosePending(false)
          // Release the captured background before the shared focus
          // restoration reads it: a lingering aria-hidden would suppress focus
          // return. The ownership guard excludes this closing dialog and
          // anything nested inside it (the archive confirmation), so a second
          // overlay present during the close keeps the background it is
          // hiding — and keeps focus, since the shared restoration refuses to
          // move focus while another overlay is up.
          if (typeof document !== 'undefined') {
            const content =
              event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
            restoreDialogBackgroundState({
              element: frameElement?.isConnected ? frameElement : undefined,
              body: document.body,
              captured: capturedBackground,
              capturedWhileOtherModalOpen,
              hasOtherModal: () => hasVisibleModal(document, content),
            })
          }
          props.onClose()
        }}
      >
        <SheetHeader>
          <SheetTitle>{props.mode === 'create' ? 'New task' : 'Edit task'}</SheetTitle>
          <SheetDescription>
            <Show
              when={lane()}
              fallback="New tasks start in Planned. Start one to queue it for an agent."
            >
              {(current) => (
                <span class="conventional-task-panel__state">
                  <Badge variant="subtle">{current().label}</Badge>
                  <span>Changes apply when you save.</span>
                </span>
              )}
            </Show>
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="task-panel-form"
            class="conventional-task-panel"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <FormField label="Title" error={titleError()}>
              <Input
                name="title"
                value={title()}
                maxLength={TITLE_LIMIT}
                placeholder="What needs doing?"
                disabled={fieldsDisabled()}
                aria-invalid={titleError() ? true : undefined}
                onInput={(event) => {
                  setTitle(event.currentTarget.value)
                  if (titleError()) setTitleError(undefined)
                }}
              />
            </FormField>
            <FormField label="Description">
              <Textarea
                name="objective"
                rows={5}
                maxLength={OBJECTIVE_LIMIT}
                placeholder={
                  initial?.objectiveContentRefId && !initial.objective
                    ? 'Replace linked content with plain text…'
                    : 'What should be done, and how will you know it is done?'
                }
                value={objective()}
                disabled={fieldsDisabled()}
                onInput={(event) => setObjective(event.currentTarget.value)}
              />
            </FormField>
            <div class="conventional-task-panel__grid">
              <PickerField
                label="Type"
                value={kind() ?? 'feature'}
                options={kindPickerOptions}
                disabled={fieldsDisabled()}
                onChange={(value) => setKind(value as TaskSummary['kind'])}
              />
              <PickerField
                label="Priority"
                value={priority()}
                options={priorityPickerOptions}
                disabled={fieldsDisabled()}
                onChange={(value) => setPriority(value as TaskSummary['priority'])}
              />
            </div>
            <Show when={editing()}>
              <div class="conventional-task-panel__grid">
                <PickerField
                  label="Project"
                  value={projectId() ?? NONE}
                  options={projectOptions()}
                  disabled={fieldsDisabled()}
                  onChange={(value) => setProjectId(value || null)}
                />
                <PickerField
                  label="Agent"
                  value={agentId() ?? NONE}
                  options={agentOptions()}
                  disabled={fieldsDisabled()}
                  onChange={(value) => setAgentId(value || null)}
                />
              </div>
              <FormField label="Dependencies" group>
                <div class="conventional-task-panel__dependencies">
                  <Input
                    type="search"
                    placeholder="Search tasks…"
                    aria-label="Search tasks to link as dependencies"
                    value={dependencyQuery()}
                    disabled={fieldsDisabled()}
                    onInput={(event) => setDependencyQuery(event.currentTarget.value)}
                  />
                  <ul class="conventional-dependency-results">
                    <For each={dependencyRows()}>
                      {(entry) => {
                        const linked = () => dependencyIds().includes(entry.item().id)
                        return (
                          <li>
                            <Button
                              type="button"
                              variant={linked() ? 'subtle' : 'ghost'}
                              size="sm"
                              class="w-full justify-start"
                              aria-pressed={linked()}
                              disabled={fieldsDisabled()}
                              onClick={() => toggleDependency(entry.item().id)}
                            >
                              <Show when={linked()} fallback={<Plus aria-hidden="true" />}>
                                <Check aria-hidden="true" />
                              </Show>
                              <span class="truncate">{entry.item().title}</span>
                            </Button>
                          </li>
                        )
                      }}
                    </For>
                    <Show when={!dependencyCandidates().length}>
                      <li class="conventional-dependency-results__empty">
                        {dependencyQuery().trim()
                          ? 'No matching tasks.'
                          : 'No other tasks to depend on yet.'}
                      </li>
                    </Show>
                  </ul>
                </div>
              </FormField>
              <Show when={initial?.execution} keyed>
                {(execution) => (
                  <FormField label="Execution" group>
                    <ul class="conventional-task-panel__executions">
                      <For each={execution.attempts}>
                        {(attempt) => (
                          <li
                            title={
                              attempt.runtimeNodeId !== undefined
                                ? attempt.runtimeNodeId
                                : undefined
                            }
                          >
                            {describeExecutionAttempt(attempt)}
                          </li>
                        )}
                      </For>
                    </ul>
                  </FormField>
                )}
              </Show>
            </Show>
          </form>
          <Show when={editing()}>
            {(edit) => (
              <section class="conventional-task-panel__actions" aria-label="Task actions">
                <Show when={edit().task.lifecycleState === 'in_review'}>
                  <p class="conventional-task-panel__note">
                    Waiting on review. A new comment in the linked conversation reopens the task.
                  </p>
                </Show>
                <div class="conventional-task-panel__action-row">
                  <Show when={edit().task.lifecycleState === 'created'}>
                    <Button
                      type="button"
                      variant="success"
                      size="sm"
                      onClick={() => void runLifecycle(edit().onQueue)}
                    >
                      <Play aria-hidden="true" />
                      Start
                    </Button>
                  </Show>
                  <Show when={edit().task.lifecycleState === 'queued'}>
                    <Button
                      type="button"
                      variant="success"
                      size="sm"
                      onClick={() => void runLifecycle(edit().onStart)}
                    >
                      <Play aria-hidden="true" />
                      Begin work
                    </Button>
                  </Show>
                  <Show when={edit().task.lifecycleState === 'in_progress'}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void runLifecycle(edit().onReview)}
                    >
                      <Send aria-hidden="true" />
                      Submit for review
                    </Button>
                  </Show>
                  <Show when={activeState()}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void runLifecycle(edit().onComplete)}
                    >
                      <CheckCircle2 aria-hidden="true" />
                      Complete
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void runLifecycle(edit().onCancel)}
                    >
                      <Square aria-hidden="true" />
                      Cancel task
                    </Button>
                  </Show>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => edit().onOpenConversation(edit().task)}
                  >
                    <MessageCircle aria-hidden="true" />
                    Open conversation
                  </Button>
                </div>
              </section>
            )}
          </Show>
          <p class="conventional-task-panel__status" role="status">
            {status()}
          </p>
        </SheetBody>
        <SheetFooter>
          <Show when={editing()}>
            {(edit) => (
              <AlertDialog>
                <AlertDialogTrigger
                  as={Button}
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="me-auto"
                  disabled={fieldsDisabled()}
                >
                  <Archive aria-hidden="true" />
                  Archive
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Archive this task?</AlertDialogTitle>
                    <AlertDialogDescription>
                      “{edit().task.title}” leaves the board. Archived tasks cannot be moved back.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel as={Button} type="button" variant="outline">
                      Keep task
                    </AlertDialogCancel>
                    <AlertDialogAction
                      as={Button}
                      type="button"
                      variant="destructive"
                      onClick={() =>
                        void runLifecycle(edit().onArchive).then((done) => done && requestClose())
                      }
                    >
                      Archive
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </Show>
          <Show when={props.mode === 'edit' && dirty()}>
            <span class="conventional-task-panel__unsaved" role="status">
              Unsaved changes
            </span>
          </Show>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving()}
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" form="task-panel-form" disabled={!canSave()}>
            {props.mode === 'create' ? (saving() ? 'Creating…' : 'Create task') : 'Save'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
