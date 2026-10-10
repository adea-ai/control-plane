import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { ApiModelChoice, ApiModelRole } from '@adea-ai/api-client/model-connections'
import { settledData } from '@adea-ai/data'
import { useCloudConnectionsQuery } from '@adea-ai/data/control-plane'
import {
  useModelConnectionsQuery,
  useWorkspaceModelDefaultsQuery,
  useSetWorkspaceModelDefaultsMutation,
  useCreateModelConnectionMutation,
  useRevokeModelConnectionMutation,
} from '@adea-ai/data/model-connections'
import { SettingsRow, SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { createClientRequestId } from './request-id'
import { projectModelReadiness } from './lead-model-state'
import { markWorkspaceLeadChanged } from './workspace-lead-revision'
import { WorkspaceLeadStatus } from './workspace-lead-status'

const roles: readonly { role: ApiModelRole; label: string }[] = [
  { role: 'lead', label: 'Workspace lead' },
  { role: 'child', label: 'Delegated agents' },
  { role: 'direct', label: 'Direct sessions' },
]

export default function LeadModelPane(props: { client?: AgentHqApiClient; workspaceId: string }) {
  const scope = createMemo(() =>
    props.client ? { client: props.client, workspaceId: props.workspaceId } : undefined
  )
  return (
    <Show
      when={scope()}
      keyed
      fallback={
        <SettingsSection
          title="Agent models"
          description="Choose model defaults for this workspace."
        >
          <EmptyDescription role="status">
            Model setup is unavailable in this view. Your drafts and direct sessions remain
            available.
          </EmptyDescription>
        </SettingsSection>
      }
    >
      {(current) => <LeadModelContent {...current} />}
    </Show>
  )
}

function LeadModelContent(props: { client: AgentHqApiClient; workspaceId: string }) {
  const connections = useModelConnectionsQuery(props.client, () => props.workspaceId)
  const defaults = useWorkspaceModelDefaultsQuery(props.client, () => props.workspaceId)
  const save = useSetWorkspaceModelDefaultsMutation(props.client, () => props.workspaceId)
  const credentials = useCloudConnectionsQuery(props.client, () => props.workspaceId)
  const register = useCreateModelConnectionMutation(props.client, () => props.workspaceId)
  const disconnect = useRevokeModelConnectionMutation(props.client, () => props.workspaceId)
  const [notice, setNotice] = createSignal<string>()
  // A refetch hides its earlier successful result until current metadata settles.
  const inventory = () => (connections.isFetching ? undefined : settledData(connections))
  const configured = () => (defaults.isFetching ? undefined : settledData(defaults))
  const canManage = () =>
    inventory()?.availability === 'available' &&
    configured()?.availability === 'available' &&
    inventory()?.canManage &&
    configured()?.canManage
  const availableCredentials = () =>
    credentials.isFetching
      ? []
      : (settledData(credentials)?.connections ?? []).filter(
          (credential) =>
            credential.status === 'active' &&
            /^crd_[0-9A-HJKMNP-TV-Z]{26}$/.test(credential.credentialId) &&
            Number.isSafeInteger(credential.revision) &&
            credential.revision > 0
        )
  const manageConnection = async (operation: () => Promise<unknown>, message: string) => {
    if (!canManage() || register.isPending || disconnect.isPending) return
    const workspaceId = props.workspaceId
    setNotice(undefined)
    try {
      await operation()
      // Marked even if this pane was disposed mid-request: the change is real.
      markWorkspaceLeadChanged(workspaceId)
      if (workspaceId === props.workspaceId) setNotice(message)
    } catch {
      if (workspaceId === props.workspaceId)
        setNotice('Model connection could not be changed. Refresh and review provider setup.')
    }
  }
  const setDefault = async (role: ApiModelRole, choice: ApiModelChoice) => {
    const page = configured()
    const connection = inventory()?.connections.find(
      (item) => item.connectionRef === choice.connectionRef
    )
    const model = connection?.models.find((item) => item.providerModel === choice.providerModel)
    if (
      !canManage() ||
      save.isPending ||
      connection?.status !== 'active' ||
      !projectModelReadiness(model?.readiness).ready
    )
      return
    const workspaceId = props.workspaceId
    setNotice(undefined)
    try {
      await save.mutateAsync({
        ...(page?.defaults?.lead ? { lead: page.defaults.lead } : {}),
        ...(page?.defaults?.child ? { child: page.defaults.child } : {}),
        ...(page?.defaults?.direct ? { direct: page.defaults.direct } : {}),
        expectedRevision: page?.defaults?.revision ?? 0,
        [role]: choice,
        idempotencyKey: createClientRequestId(),
      })
      // Marked even if this pane was disposed mid-save: the default is persisted.
      markWorkspaceLeadChanged(workspaceId)
      if (workspaceId === props.workspaceId)
        setNotice(
          'Model default saved. Readiness and payer authorization are checked for each turn.'
        )
    } catch {
      if (workspaceId === props.workspaceId)
        setNotice('The model default could not be saved. Refresh connections and try again.')
    }
  }
  const defaultLabel = (role: ApiModelRole) => {
    if (!configured()) return 'Checking model defaults'
    if (configured()?.availability !== 'available') return 'Model settings unavailable'
    const choice = configured()?.defaults?.[role]
    if (!choice) return 'No model selected'
    const connection = inventory()?.connections.find(
      (item) => item.connectionRef === choice.connectionRef
    )
    return connection
      ? `${connection.provider} · ${choice.providerModel}`
      : 'Saved model connection unavailable'
  }
  return (
    <SettingsSection
      title="Agent models"
      description="Set separate defaults for the workspace lead, delegated agents and direct sessions. Credentials are managed in Connections; connector credentials alone do not establish model readiness."
      bodyLayout="content"
    >
      <WorkspaceLeadStatus client={props.client} workspaceId={props.workspaceId} />
      <div class="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={connections.isFetching || defaults.isFetching}
          onClick={() => {
            setNotice(undefined)
            markWorkspaceLeadChanged(props.workspaceId)
            void connections.refetch()
            void defaults.refetch()
          }}
        >
          Refresh models
        </Button>
      </div>
      <Show when={connections.isFetching || defaults.isFetching}>
        <EmptyDescription role="status">Checking model connections…</EmptyDescription>
      </Show>
      <Show
        when={
          connections.isError ||
          defaults.isError ||
          inventory()?.availability === 'unavailable' ||
          configured()?.availability === 'unavailable'
        }
      >
        <EmptyDescription role="status">
          Model setup is unavailable. Your lead customization, drafts and independent direct
          sessions are preserved.
        </EmptyDescription>
      </Show>
      <Show when={notice()}>
        {(message) => <EmptyDescription role="status">{message()}</EmptyDescription>}
      </Show>
      <Show when={canManage() && settledData(credentials)?.canManage}>
        <For each={availableCredentials()}>
          {(credential) => (
            <SettingsRow
              label={`Review ${credential.provider} for model use`}
              description="The server checks provider account, model and grant eligibility. An existing connector credential alone does not qualify a model."
            >
              <Button
                size="sm"
                variant="outline"
                disabled={register.isPending || disconnect.isPending}
                onClick={() =>
                  void manageConnection(
                    () =>
                      register.mutateAsync({
                        credentialRef: credential.credentialId,
                        credentialRevision: credential.revision,
                        idempotencyKey: createClientRequestId(),
                      }),
                    'Model connection registered. Refresh model readiness before choosing a default.'
                  )
                }
              >
                Register model connection
              </Button>
            </SettingsRow>
          )}
        </For>
      </Show>
      <For each={roles}>
        {({ role, label }) => (
          <SettingsRow label={label} description={defaultLabel(role)}>
            <Badge variant="outline">
              {configured()?.defaults?.[role] ? 'Selected' : 'Not configured'}
            </Badge>
          </SettingsRow>
        )}
      </For>
      <Show
        when={inventory()?.availability === 'available' && inventory()?.connections.length === 0}
      >
        <EmptyDescription role="status">
          No model connections are available. Add a supported provider credential in Connections,
          then refresh.
        </EmptyDescription>
      </Show>
      <For each={inventory()?.connections ?? []}>
        {(connection) => (
          <For each={connection.models}>
            {(model) => {
              const readiness = () => projectModelReadiness(model.readiness)
              return (
                <SettingsRow
                  label={`${connection.provider} · ${model.providerModel}`}
                  description={`Account: ${connection.accountRef} · Authentication: ${connection.authKind} · Funding: ${connection.fundingSource} · Location: ${inventory()?.target?.location ?? 'unavailable'}`}
                >
                  <div class="flex flex-col gap-2">
                    <Badge
                      variant={
                        readiness().ready && connection.status === 'active'
                          ? 'secondary'
                          : 'outline'
                      }
                    >
                      {connection.status === 'revoked'
                        ? 'Revoked'
                        : readiness().ready
                          ? 'Eligible model'
                          : 'Setup required'}
                    </Badge>
                    <Show when={!readiness().ready}>
                      <EmptyDescription>{readiness().remedy?.message}</EmptyDescription>
                    </Show>
                    <div class="flex flex-wrap items-center gap-2">
                      <For each={roles}>
                        {({ role, label }) => (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              !canManage() ||
                              save.isPending ||
                              connection.status !== 'active' ||
                              !readiness().ready
                            }
                            onClick={() =>
                              void setDefault(role, {
                                connectionRef: connection.connectionRef,
                                providerModel: model.providerModel,
                              })
                            }
                          >
                            Use for {label.toLocaleLowerCase()}
                          </Button>
                        )}
                      </For>
                      <Show when={canManage() && connection.status === 'active'}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={register.isPending || disconnect.isPending}
                          onClick={() =>
                            void manageConnection(
                              () =>
                                disconnect.mutateAsync({
                                  connectionRef: connection.connectionRef,
                                  expectedRevision: connection.revision,
                                  idempotencyKey: createClientRequestId(),
                                }),
                              'Model connection revoked. Existing drafts and direct sessions are preserved.'
                            )
                          }
                        >
                          Revoke model connection
                        </Button>
                      </Show>
                    </div>
                  </div>
                </SettingsRow>
              )
            }}
          </For>
        )}
      </For>
      <EmptyDescription>
        A saved default does not authorize spending. Each lead turn requires a current payer
        disclosure before model work starts.
      </EmptyDescription>
    </SettingsSection>
  )
}
