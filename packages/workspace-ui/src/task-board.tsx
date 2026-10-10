import type { AgentSummary, ProjectSummary, TaskSummary } from '@adea-ai/types'
import { Play, Plus, Search, X } from 'lucide-solid'
import { createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Avatar, AvatarFallback, initialsFrom } from '@adea-ai/ui/components/ui/avatar'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import {
  Board,
  BoardCardBody,
  BoardCardTrigger,
  type BoardColumn,
  type BoardMove,
} from '@adea-ai/ui/components/ui/board'
import { Button } from '@adea-ai/ui/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'
import { keyedRows, type KeyedRow } from './keyed-rows'
import type { PrivateContentResolver } from './platform'
import { TaskObjective } from './private-task-objective'
import { ProjectIcon } from './project-icon'
import { cancelTaskBackgroundLease, TaskPanel } from './task-detail'
import {
  kindOption,
  priorityOption,
  taskLanes,
  validTransitions,
  type TaskState,
} from './task-presentation'

type Props = Readonly<{
  agents: readonly AgentSummary[]
  busy: boolean
  onArchive: (task: TaskSummary) => Promise<void>
  onAssign: (task: TaskSummary, agentId: string | null) => Promise<void>
  onCancel: (task: TaskSummary) => Promise<void>
  onComplete: (task: TaskSummary) => Promise<void>
  onCreate: (
    input: Readonly<{
      kind?: TaskSummary['kind']
      objective: string
      priority: TaskSummary['priority']
      title: string
    }>
  ) => Promise<void>
  onDependencies: (task: TaskSummary, dependencyIds: readonly string[]) => Promise<void>
  onMoveProject: (task: TaskSummary, projectId: string | null) => Promise<void>
  onOpenConversation: (task: TaskSummary) => void
  onQueue: (task: TaskSummary) => Promise<void>
  onReview: (task: TaskSummary) => Promise<void>
  onSelect: (taskId: string | null) => void
  onStart: (task: TaskSummary) => Promise<void>
  onUpdate: (
    task: TaskSummary,
    update: Readonly<{
      kind?: TaskSummary['kind']
      objective?: string
      priority?: TaskSummary['priority']
      title?: string
    }>
  ) => Promise<void>
  privateContent?: PrivateContentResolver
  projects: readonly ProjectSummary[]
  selectedTaskId: string | null
  tasks: readonly TaskSummary[]
}>

export function TaskBoard(props: Props) {
  // The board releases any post-close background repair when it unmounts.
  // Solid disposes parent cleanups before child ones, so a lease created by a
  // panel closing during this same unmount is created after this cancel runs;
  // that lease is bounded by the frame's own lifetime (it ends when the frame
  // is replaced), which is what keeps it from outliving the surface.
  onCleanup(() => cancelTaskBackgroundLease())
  const [creating, setCreating] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [boardError, setBoardError] = createSignal<string | null>(null)
  const selected = createMemo(() => props.tasks.find(({ id }) => id === props.selectedTaskId))
  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])))
  const projectById = createMemo(
    () => new Map(props.projects.map((project) => [project.id, project]))
  )
  const dropActions: Partial<Record<TaskState, (task: TaskSummary) => Promise<void>>> = {
    cancelled: props.onCancel,
    completed: props.onComplete,
    in_progress: props.onStart,
    in_review: props.onReview,
    queued: props.onQueue,
  }

  const matches = (task: TaskSummary, needle: string) => {
    if (!needle) return true
    const agent = task.agentId ? agentById().get(task.agentId)?.name : undefined
    const project = task.projectId ? projectById().get(task.projectId)?.name : undefined
    return [task.title, task.objective, task.kind, task.priority, agent, project].some((value) =>
      value?.toLowerCase().includes(needle)
    )
  }
  const visibleTasks = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return props.tasks.filter((task) => matches(task, needle))
  })
  // Board's <For> sees stable wrappers even when the server returns fresh task
  // objects, so card DOM and focus survive a refetch. Every new object is still
  // pushed through: an optimistic move changes the lane without changing the
  // version, and a version-keyed comparison would hide it until the server
  // answered.
  const taskRows = keyedRows(visibleTasks, (task) => task.id)
  const boardColumns = createMemo<BoardColumn[]>(() =>
    taskLanes.map((lane) => ({
      ...lane,
      count: visibleTasks().filter((task) => task.lifecycleState === lane.id).length,
    }))
  )

  const queueFromCard = async (task: TaskSummary) => {
    setBoardError(null)
    try {
      await props.onQueue(task)
    } catch {
      setBoardError('This task could not be started. It may have changed elsewhere; try again.')
    }
  }

  const canMoveTask = (entry: KeyedRow<TaskSummary>, from: string, to: string) => {
    const task = entry.item()
    return (
      task.lifecycleState === from &&
      Boolean(dropActions[to as TaskState]) &&
      validTransitions[task.lifecycleState].includes(to as TaskState)
    )
  }

  const moveTask = async ({ itemId, from, to }: BoardMove) => {
    const task = props.tasks.find(({ id }) => id === itemId)
    if (!task) return
    const action = dropActions[to as TaskState]
    // The server owns transition validity; this check prevents stale board
    // state from sending an action that no longer matches the rendered lane.
    if (
      task.lifecycleState !== from ||
      !action ||
      !validTransitions[task.lifecycleState].includes(to as TaskState)
    )
      return
    setBoardError(null)
    try {
      await action(task)
    } catch {
      setBoardError('This task could not be moved. It may have changed elsewhere; try again.')
    }
  }

  const openTask = (taskId: string) => {
    setCreating(false)
    setBoardError(null)
    props.onSelect(taskId)
  }

  return (
    <section class="conventional-kanban" aria-labelledby="task-board-title">
      <header class="conventional-kanban__toolbar">
        <div class="conventional-kanban__heading">
          <h1 id="task-board-title">Kanban</h1>
          <Badge variant="subtle" size="sm" aria-label={taskCountLabel()}>
            {props.tasks.length}
          </Badge>
        </div>
        <InputGroup class="w-full max-w-72">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder="Filter tasks"
            aria-label="Filter tasks"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </InputGroup>
        <Show when={query()}>
          <span class="conventional-kanban__filter-result" role="status">
            {visibleTasks().length} of {props.tasks.length}
          </span>
        </Show>
        <Button
          type="button"
          class="ms-auto"
          onClick={() => {
            props.onSelect(null)
            setCreating(true)
          }}
        >
          <Plus aria-hidden="true" />
          New task
        </Button>
      </header>
      <Show when={boardError()}>
        {(message) => (
          <Alert variant="destructive" class="items-center">
            <AlertDescription>{message()}</AlertDescription>
            <ActionButton
              variant="ghost"
              size="icon-xs"
              tooltip="Dismiss"
              aria-label="Dismiss error"
              class="ms-auto"
              onClick={() => setBoardError(null)}
            >
              <X aria-hidden="true" />
            </ActionButton>
          </Alert>
        )}
      </Show>
      <Board
        columns={boardColumns()}
        items={taskRows()}
        itemId={(entry) => entry.item().id}
        itemColumn={(entry) => entry.item().lifecycleState}
        canDrop={canMoveTask}
        onMove={(move) => void moveTask(move)}
        label="Task board"
        collapseEmpty
        class="h-full flex-1"
        emptyColumn={(column) =>
          query()
            ? 'No matching tasks'
            : column.id === 'created'
              ? 'New tasks start here'
              : 'No tasks'
        }
      >
        {(entry) => {
          const task = entry.item
          const priority = () => priorityOption(task().priority)
          const kind = () => kindOption(task().kind)
          const project = () =>
            task().projectId ? projectById().get(task().projectId!) : undefined
          const agentName = () =>
            task().agentId ? (agentById().get(task().agentId!)?.name ?? 'Unavailable agent') : null
          return (
            <BoardCardBody>
              <div class="conventional-kanban-card__header">
                <BoardCardTrigger aria-haspopup="dialog" onClick={() => openTask(task().id)}>
                  {task().title}
                </BoardCardTrigger>
                <Badge variant={priority().badge} aria-label={`Priority: ${priority().label}`}>
                  <Dynamic component={priority().Icon} aria-hidden="true" />
                  {priority().label}
                </Badge>
              </div>
              <Show when={task().objective || task().objectiveContentRefId}>
                <p class="conventional-kanban-card__objective">
                  <TaskObjective privateContent={props.privateContent} task={task()} />
                </p>
              </Show>
              <div class="conventional-kanban-card__tags">
                <Badge variant={kind().badge} aria-label={`Type: ${kind().label}`}>
                  <Dynamic component={kind().Icon} aria-hidden="true" />
                  {kind().label}
                </Badge>
                <Show when={project()}>
                  {(value) => (
                    <Badge variant="subtle">
                      <ProjectIcon iconKey={value().iconKey} />
                      {value().name}
                    </Badge>
                  )}
                </Show>
              </div>
              <footer class="conventional-kanban-card__footer">
                <span class="conventional-kanban-card__assignee">
                  <Show when={agentName()} fallback={<span>Unassigned</span>}>
                    {(name) => (
                      <>
                        <Avatar size="xs">
                          <AvatarFallback>{initialsFrom(name())}</AvatarFallback>
                        </Avatar>
                        <span>{name()}</span>
                      </>
                    )}
                  </Show>
                </span>
                <Show when={task().lifecycleState === 'created'}>
                  <Button
                    type="button"
                    variant="success"
                    size="xs"
                    class="relative ms-auto"
                    disabled={props.busy}
                    onClick={() => void queueFromCard(task())}
                  >
                    <Play aria-hidden="true" />
                    Start
                  </Button>
                </Show>
              </footer>
            </BoardCardBody>
          )
        }}
      </Board>
      <Show when={creating()}>
        <TaskPanel
          {...props}
          mode="create"
          onClose={() => setCreating(false)}
          onError={setBoardError}
          onCreate={props.onCreate}
        />
      </Show>
      {/* Keyed on the task's id, not the task object. The panel's draft is
          initialised once at setup, so a different task must remount it — but
          every write hands back a fresh object for the *same* task, and keying
          on the object remounted the open panel on each one: it flickered shut
          and open on Save. */}
      <Show when={selected()?.id} keyed>
        {(taskId) => (
          <TaskPanel
            {...props}
            mode="edit"
            task={props.tasks.find(({ id }) => id === taskId)!}
            onClose={() => props.onSelect(null)}
            onError={setBoardError}
          />
        )}
      </Show>
    </section>
  )

  function taskCountLabel() {
    const count = props.tasks.length
    return `${count} ${count === 1 ? 'task' : 'tasks'}`
  }
}
