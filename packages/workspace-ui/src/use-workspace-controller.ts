import { createEffect, createMemo, createSignal } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import type { ChannelSummary, TaskSummary } from '@adea-ai/types'
import {
  settledData,
  settledConversationPage,
  useAgentListQuery,
  useArchiveAgentMutation,
  useArchiveChannelMutation,
  useArchiveTaskMutation,
  useArtifactListQuery,
  useAssignAgentProjectMutation,
  useAssignTaskMutation,
  useCancelTaskMutation,
  useChangeAgentProfileMutation,
  useChannelListQuery,
  useCompleteTaskMutation,
  useCreateAgentMutation,
  useCreateDirectChannelMutation,
  useCreateGroupChannelMutation,
  useCreateProjectMutation,
  useCreateTaskMutation,
  useUpdateTaskMutation,
  useMoveTaskProjectMutation,
  useMarkAllReadMutation,
  useMarkChannelReadMutation,
  useMarkThreadReadMutation,
  useQueueTaskMutation,
  useReadStateQuery,
  useReviewTaskMutation,
  useProjectListQuery,
  useSetTaskConversationMutation,
  useSetTaskDependenciesMutation,
  useStartTaskMutation,
  useTaskListQuery,
  useUpdateAgentPresentationMutation,
  useUpdateChannelMutation,
  useUpdateProjectMutation,
  useWorkspaceBootstrapQuery,
} from '@adea-ai/data'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'

import { projectWorkspaceNavigation, reconcileWorkspaceChannelSelection } from './workspace-model'
import { useWorkspacePersistence } from './use-workspace-persistence'
import { createClientRequestId } from './request-id'

const taskInput = (task: TaskSummary, prefix: string) => command(prefix, task.version)

function command(prefix: string, expectedVersion?: number) {
  const id = createClientRequestId()
  return {
    correlationId: `ui:${prefix}:${id}`,
    expectedVersion,
    idempotencyKey: `${prefix}:${id}`,
    requestId: id,
  }
}

const taskMutation = <T>(mutation: { mutateAsync: (input: T) => Promise<unknown> }, input: T) =>
  mutation.mutateAsync(input).then(() => undefined)

export function useWorkspaceController(providedClient?: AgentHqApiClient) {
  const [defaultClient] = createSignal(createApiClient())
  const client = () => providedClient ?? defaultClient()
  const persistenceReady = useWorkspacePersistence()
  const bootstrap = useWorkspaceBootstrapQuery(client())
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const selectedChannelId = useWorkspaceState((state) => state.selectedChannelId)
  const bootstrapData = () => settledData(bootstrap)
  const activeWorkspace = () =>
    bootstrapData()?.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
    bootstrapData()?.activeWorkspace ??
    undefined
  const workspaceId = () => activeWorkspace()?.id
  const projects = useProjectListQuery(client(), workspaceId)
  const channels = useChannelListQuery(client(), workspaceId)
  const agents = useAgentListQuery(client(), workspaceId)
  const tasks = useTaskListQuery(client(), workspaceId)
  const artifacts = useArtifactListQuery(client(), workspaceId)
  const readState = useReadStateQuery(client(), workspaceId)
  const audienceEpoch = useWorkspaceState(
    (state) => state.conversationAudienceEpochs[workspaceId() ?? ''] ?? 0
  )
  const channelData = () => {
    const list = settledConversationPage(channels, audienceEpoch())
    return list?.conversationWorkspaceId === workspaceId() ? list : undefined
  }
  const selectionAuthority = () => ({ workspaceId: workspaceId(), epoch: audienceEpoch() })
  const currentSelectionAuthority = (authority: ReturnType<typeof selectionAuthority>) =>
    authority.workspaceId === workspaceId() && authority.epoch === audienceEpoch()
  const navigation = createMemo(() =>
    projectWorkspaceNavigation(settledData(projects) ?? [], channelData() ?? [])
  )
  const createProject = useCreateProjectMutation(client(), () => workspaceId() ?? '')
  const createGroup = useCreateGroupChannelMutation(client(), () => workspaceId() ?? '')
  const createDirect = useCreateDirectChannelMutation(client(), () => workspaceId() ?? '')
  const createAgent = useCreateAgentMutation(client(), () => workspaceId() ?? '')
  const archiveAgent = useArchiveAgentMutation(client(), () => workspaceId() ?? '')
  const assignAgentProject = useAssignAgentProjectMutation(client(), () => workspaceId() ?? '')
  const changeAgentProfile = useChangeAgentProfileMutation(client(), () => workspaceId() ?? '')
  const updateAgentPresentation = useUpdateAgentPresentationMutation(
    client(),
    () => workspaceId() ?? ''
  )
  const createTask = useCreateTaskMutation(client(), () => workspaceId() ?? '')
  const updateTask = useUpdateTaskMutation(client(), () => workspaceId() ?? '')
  const assignTask = useAssignTaskMutation(client(), () => workspaceId() ?? '')
  const moveTask = useMoveTaskProjectMutation(client(), () => workspaceId() ?? '')
  const dependencies = useSetTaskDependenciesMutation(client(), () => workspaceId() ?? '')
  const queueTask = useQueueTaskMutation(client(), () => workspaceId() ?? '')
  const startTask = useStartTaskMutation(client(), () => workspaceId() ?? '')
  const completeTask = useCompleteTaskMutation(client(), () => workspaceId() ?? '')
  const reviewTask = useReviewTaskMutation(client(), () => workspaceId() ?? '')
  const cancelTask = useCancelTaskMutation(client(), () => workspaceId() ?? '')
  const archiveTask = useArchiveTaskMutation(client(), () => workspaceId() ?? '')
  const taskConversation = useSetTaskConversationMutation(client(), () => workspaceId() ?? '')
  const markAllRead = useMarkAllReadMutation(client(), () => workspaceId() ?? '')
  const markChannelRead = useMarkChannelReadMutation(client(), () => workspaceId() ?? '')
  const markThreadRead = useMarkThreadReadMutation(client(), () => workspaceId() ?? '')
  const updateProject = useUpdateProjectMutation(client(), () => workspaceId() ?? '')
  const updateChannel = useUpdateChannelMutation(client(), () => workspaceId() ?? '')
  const archiveChannel = useArchiveChannelMutation(client(), () => workspaceId() ?? '')

  createEffect(() => {
    const data = bootstrapData()
    if (!persistenceReady() || !data || activeWorkspace()) return
    workspaceStore.getState().setSelectedWorkspaceId(data.activeWorkspace?.id ?? null)
  })

  let explicitSelection: string | null = null
  let selectionScope = selectionAuthority()
  createEffect(() => {
    if (!currentSelectionAuthority(selectionScope)) {
      explicitSelection = null
      selectionScope = selectionAuthority()
    }
    const decision = reconcileWorkspaceChannelSelection({
      channels: channelData(),
      explicitSelection,
      navigation: navigation(),
      selectedChannelId: selectedChannelId(),
    })
    if (decision.action === 'preserve') {
      if (decision.clearExplicitSelection) explicitSelection = null
      return
    }
    if (decision.action === 'clear') {
      workspaceStore.getState().setSelectedProjectId(null)
      workspaceStore.getState().setSelectedChannelId(null)
      return
    }
    if (decision.action !== 'select') return
    workspaceStore.getState().setSelectedProjectId(decision.projectId)
    workspaceStore.getState().setSelectedChannelId(decision.channelId)
  })

  const selectWorkspace = (nextWorkspaceId: string) => {
    const nextWorkspace = bootstrapData()?.workspaces.find(({ id }) => id === nextWorkspaceId)
    if (!nextWorkspace || nextWorkspace.id === activeWorkspace()?.id) return
    // The scene is a router fact (reconciled by WorkspaceNavigation); the
    // store reset here covers only the workspace's own context.
    workspaceStore.getState().switchWorkspace(nextWorkspace.id)
  }
  const selectChannel = (channelId: string, projectId?: string) => {
    explicitSelection = channelId
    workspaceStore.getState().setSelectedProjectId(projectId ?? null)
    workspaceStore.getState().setSelectedChannelId(channelId)
  }

  return {
    get activeWorkspace() {
      return activeWorkspace()
    },
    get agents() {
      return settledData(agents) ?? []
    },
    get artifacts() {
      return settledData(artifacts) ?? []
    },
    agentActions: {
      archive: (agentId: string) => archiveAgent.mutateAsync(agentId).then(() => undefined),
      assignProject: (agentId: string, projectId: string | null, expectedRevision: number) =>
        assignAgentProject
          .mutateAsync({ agentId, expectedRevision, projectId })
          .then((result) => result.agent),
      profile: (
        agentId: string,
        profile: Parameters<typeof changeAgentProfile.mutateAsync>[0]['profile']
      ) => changeAgentProfile.mutateAsync({ agentId, profile }).then(() => undefined),
      presentation: (
        agentId: string,
        presentation: Parameters<typeof updateAgentPresentation.mutateAsync>[0]['presentation']
      ) =>
        updateAgentPresentation
          .mutateAsync({ agentId, presentation })
          .then((result) => result.agent),
    },
    get agentBusy() {
      return [archiveAgent, assignAgentProject, changeAgentProfile, updateAgentPresentation].some(
        ({ isPending }) => isPending
      )
    },
    bootstrap,
    get channels() {
      return channelData() ?? []
    },
    client: client(),
    createAgent: (input: Parameters<typeof createAgent.mutateAsync>[0]) =>
      createAgent.mutateAsync(input).then(() => undefined),
    get createAgentBusy() {
      return createAgent.isPending
    },
    createGroup: async (title: string) => {
      const authority = selectionAuthority()
      const result = await createGroup.mutateAsync({
        idempotencyKey: createClientRequestId(),
        title,
      })
      if (currentSelectionAuthority(authority)) selectChannel(result.channel.id)
    },
    get createGroupBusy() {
      return createGroup.isPending
    },
    createProject: async (input: Readonly<{ iconKey: string; name: string }>) => {
      const result = await createProject.mutateAsync(input)
      const refreshedChannels = await channels.refetch()
      const primaryChannel = settledData(refreshedChannels)?.find(
        (channel) =>
          channel.kind === 'project' &&
          channel.projectId === result.project.id &&
          channel.isPrimaryProjectChannel
      )
      if (primaryChannel) selectChannel(primaryChannel.id, result.project.id)
      else workspaceStore.getState().setSelectedProjectId(result.project.id)
    },
    get createProjectBusy() {
      return createProject.isPending
    },
    /**
     * Refetches the channel list after a create-project flow that bypassed
     * this controller (the Dev Runtime's detailed dialog): the cloud create
     * invalidates the project list through the shared query cache, but the
     * new project's primary channel only appears through this refetch.
     */
    refreshAfterProjectCreate: async () => {
      await channels.refetch()
    },
    /**
     * Refetches the roster's agent list after a write that bypassed the agent
     * mutations (the workspace lead's provisioning), so the new row reaches the
     * roster and every consumer of the list without a reload.
     */
    refreshAgents: async () => {
      await agents.refetch()
    },
    projectActions: {
      update: (projectId: string, update: Readonly<{ iconKey?: string; name?: string }>) =>
        updateProject.mutateAsync({ projectId, update }).then(() => undefined),
    },
    get projectBusy() {
      return updateProject.isPending
    },
    channelActions: {
      archive: (channel: ChannelSummary) =>
        archiveChannel
          .mutateAsync({ channelId: channel.id, expectedVersion: channel.version })
          .then(() => undefined),
      rename: (channel: ChannelSummary, title: string) =>
        updateChannel
          .mutateAsync({
            channelId: channel.id,
            expectedVersion: channel.version,
            update: { title },
          })
          .then(() => undefined),
    },
    get channelBusy() {
      return updateChannel.isPending || archiveChannel.isPending
    },
    navigation,
    get readState() {
      return settledData(readState)?.readState ?? []
    },
    readStateActions: {
      markAllRead: () => markAllRead.mutateAsync().then(() => undefined),
      markChannel: (input: Parameters<typeof markChannelRead.mutateAsync>[0]) =>
        markChannelRead.mutateAsync(input).then(() => undefined),
      markThread: (input: Parameters<typeof markThreadRead.mutateAsync>[0]) =>
        markThreadRead.mutateAsync(input).then(() => undefined),
    },
    openAgentConversation: async (agentId: string) => {
      const authority = selectionAuthority()
      const result = await createDirect.mutateAsync(agentId)
      if (currentSelectionAuthority(authority)) selectChannel(result.channel.id)
    },
    get persistenceReady() {
      return persistenceReady()
    },
    get projects() {
      return settledData(projects) ?? []
    },
    selectChannel,
    selectWorkspace,
    get selectedChannel() {
      return channelData()?.find(({ id }) => id === selectedChannelId())
    },
    taskActions: {
      archive: (task: TaskSummary) =>
        taskMutation(archiveTask, { command: taskInput(task, 'archive'), taskId: task.id }),
      assign: (task: TaskSummary, agentId: string | null) =>
        taskMutation(assignTask, { agentId, command: taskInput(task, 'assign'), taskId: task.id }),
      cancel: (task: TaskSummary) =>
        taskMutation(cancelTask, { command: taskInput(task, 'cancel'), taskId: task.id }),
      create: (
        task: Readonly<{
          kind?: TaskSummary['kind']
          objective: string
          priority: TaskSummary['priority']
          title: string
        }>
      ) => taskMutation(createTask, { command: command('create-task'), task }),
      update: (
        task: TaskSummary,
        update: Readonly<{
          kind?: TaskSummary['kind']
          objective?: string
          priority?: TaskSummary['priority']
          title?: string
        }>
      ) =>
        taskMutation(updateTask, {
          command: taskInput(task, 'update'),
          taskId: task.id,
          update,
        }),
      dependencies: (task: TaskSummary, dependencyIds: readonly string[]) =>
        taskMutation(dependencies, {
          command: taskInput(task, 'dependencies'),
          dependencyIds,
          taskId: task.id,
        }),
      moveProject: (task: TaskSummary, projectId: string | null) =>
        taskMutation(moveTask, {
          command: taskInput(task, 'move-project'),
          projectId,
          taskId: task.id,
        }),
      openConversation: async (task: TaskSummary) => {
        let channelId = task.conversation.channelId
        if (!channelId && task.projectId)
          channelId = navigation().projects.find(
            ({ project }) => project.id === task.projectId
          )?.selectionChannelId
        if (!channelId) throw new Error('Task conversation unavailable')
        if (!task.conversation.channelId)
          await taskConversation.mutateAsync({
            command: taskInput(task, 'conversation'),
            conversation: { channelId },
            taskId: task.id,
          })
        selectChannel(channelId, task.projectId)
      },
      queue: (task: TaskSummary) =>
        taskMutation(queueTask, { command: taskInput(task, 'queue'), taskId: task.id }),
      review: (task: TaskSummary) =>
        taskMutation(reviewTask, { command: taskInput(task, 'review'), taskId: task.id }),
      start: (task: TaskSummary) =>
        taskMutation(startTask, { command: taskInput(task, 'start'), taskId: task.id }),
      complete: (task: TaskSummary) =>
        taskMutation(completeTask, { command: taskInput(task, 'complete'), taskId: task.id }),
    },
    get taskBusy() {
      return [
        archiveTask,
        assignTask,
        cancelTask,
        completeTask,
        createTask,
        dependencies,
        moveTask,
        queueTask,
        reviewTask,
        startTask,
        taskConversation,
        updateTask,
      ].some(({ isPending }) => isPending)
    },
    get tasks() {
      return settledData(tasks) ?? []
    },
    get workspaceId() {
      return workspaceId()
    },
    workspaceQueries: [projects, channels, agents, tasks, artifacts, readState],
  }
}
