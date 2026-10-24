import {
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadPrepareResponseSchema,
  PiDurableLeadLookupRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadDispatchResponseSchema,
  PiDurableLeadStatusRequestSchema,
  PiDurableLeadStatusResponseSchema,
  PiDurableLeadChildrenRequestSchema,
  PiDurableLeadChildrenResponseSchema,
  PiDurableLeadProgressRequestSchema,
  PiDurableLeadProgressResponseSchema,
  PiDurableLeadCancelRequestSchema,
  PiDurableLeadCancelResponseSchema,
} from '@control-plane/runtime-sdk'
import {
  PiLeadPublicationRequestSchema,
  PiLeadPublicationResponseSchema,
  PiChildPublicationRequestSchema,
  PiChildPublicationResponseSchema,
  ModelSelectionFundingRequestSchema,
  ModelSelectionFundingResponseSchema,
  ModelConnectionCreateRequestSchema,
  ModelConnectionListRequestSchema,
  ModelConnectionListResponseSchema,
  ModelConnectionResponseSchema,
  ModelConnectionRevokeRequestSchema,
  ModelDefaultsGetRequestSchema,
  ModelDefaultsResponseSchema,
  ModelDefaultsSetRequestSchema,
  ModelSelectionResolveRequestSchema,
  ModelSelectionResponseSchema,
} from '@control-plane/contracts'
import {
  CredentialCreateRequestSchema,
  CredentialGetRequestSchema,
  CredentialListRequestSchema,
  CredentialListResponseSchema,
  CredentialResponseSchema,
  CredentialRevokeRequestSchema,
  CredentialRotateRequestSchema,
  RuntimeNodeCredentialRevocationResponseSchema,
  RuntimeNodeCredentialRevokeRequestSchema,
  GraphDefinitionPublishRequestSchema,
  GraphDefinitionDeprecationRequestSchema,
  GraphDefinitionRevocationRequestSchema,
  GraphDefinitionResolutionRequestSchema,
  GraphDefinitionResponseSchema,
  ExecutionCancellationCommandSchema,
  ExecutionCancellationCommandResultSchema,
  InteractionResponseCommandSchema,
  InteractionResponseCommandResultSchema,
  ContextPackageResolutionRequestSchema,
  ContextPackageResolutionResponseSchema,
  ExecutionAcceptanceRequestSchema,
  ExecutionAcceptanceResponseSchema,
  ExecutionRequestValidationRequestSchema,
  ExecutionRequestValidationResponseSchema,
  ProfileResolutionRequestSchema,
  ProfileResolutionResponseSchema,
  ProjectStateInitializationRequestSchema,
  ProjectStateInitializationResponseSchema,
  ProjectStateResolutionRequestSchema,
  ProjectStateResolutionResponseSchema,
  RuntimeListRequestSchema,
  RuntimeListResponseSchema,
  ServiceAuthenticationRequestSchema,
  ServiceAuthenticationResponseSchema,
  ExternalSessionGetRequestSchema,
  ExternalSessionGetResponseSchema,
  ExternalSessionListRequestSchema,
  ExternalSessionListResponseSchema,
  RuntimeConnectionGetRequestSchema,
  RuntimeConnectionGetResponseSchema,
  RuntimeConnectionListRequestSchema,
  RuntimeConnectionListResponseSchema,
  MarketplaceCatalogRequestSchema,
  MarketplaceCatalogResponseSchema,
  MarketplaceInstallPlanRequestSchema,
  MarketplaceInstallPlanResponseSchema,
  MarketplaceInstallRequestSchema,
  MarketplaceInstallResponseSchema,
  MarketplaceInstallationGetRequestSchema,
  MarketplaceInstallationGetResponseSchema,
  MarketplaceInstallationUninstallRequestSchema,
  MarketplaceInstallationUninstallResponseSchema,
  WorkspaceAgentProfileDeprecationRequestSchema,
  WorkspaceAgentProfileGetRequestSchema,
  WorkspaceAgentProfileGetResponseSchema,
  WorkspaceAgentProfileLifecycleResponseSchema,
  WorkspaceAgentProfileListRequestSchema,
  WorkspaceAgentProfileListResponseSchema,
  WorkspaceAgentProfilePublishRequestSchema,
  WorkspaceAgentProfilePublishResponseSchema,
  WorkspaceAgentProfileRevocationRequestSchema,
  WorkspaceSkillDeprecationRequestSchema,
  WorkspaceSkillGetRequestSchema,
  WorkspaceSkillGetResponseSchema,
  WorkspaceSkillLifecycleResponseSchema,
  WorkspaceSkillListRequestSchema,
  WorkspaceSkillListResponseSchema,
  WorkspaceSkillPublishRequestSchema,
  WorkspaceSkillPublishResponseSchema,
  WorkspaceSkillRevocationRequestSchema,
} from '@control-plane/contracts'

export const ControlApiOperations = Object.freeze({
  getPiDurableLeadPublication: {
    operation: 'pi-durable.lead.publication.current',
    method: 'POST',
    path: '/v1/pi-durable/lead-publication/current',
    requestSchema: PiLeadPublicationRequestSchema as typeof PiLeadPublicationRequestSchema,
    responseSchema: PiLeadPublicationResponseSchema as typeof PiLeadPublicationResponseSchema,
  },
  getPiDurableChildPublication: {
    operation: 'pi-durable.child.publication.current',
    method: 'POST',
    path: '/v1/pi-durable/child-publication/current',
    requestSchema: PiChildPublicationRequestSchema as typeof PiChildPublicationRequestSchema,
    responseSchema: PiChildPublicationResponseSchema as typeof PiChildPublicationResponseSchema,
  },
  getModelSelectionFunding: {
    operation: 'model-selection.funding.get',
    method: 'POST',
    path: '/v1/model-connections/selection/funding/get',
    requestSchema: ModelSelectionFundingRequestSchema as typeof ModelSelectionFundingRequestSchema,
    responseSchema:
      ModelSelectionFundingResponseSchema as typeof ModelSelectionFundingResponseSchema,
  },
  createModelConnection: {
    operation: 'model-connections.create',
    method: 'POST',
    path: '/v1/model-connections/create',
    requestSchema: ModelConnectionCreateRequestSchema as typeof ModelConnectionCreateRequestSchema,
    responseSchema: ModelConnectionResponseSchema as typeof ModelConnectionResponseSchema,
  },
  revokeModelConnection: {
    operation: 'model-connections.revoke',
    method: 'POST',
    path: '/v1/model-connections/revoke',
    requestSchema: ModelConnectionRevokeRequestSchema as typeof ModelConnectionRevokeRequestSchema,
    responseSchema: ModelConnectionResponseSchema as typeof ModelConnectionResponseSchema,
  },
  listModelConnections: {
    operation: 'model-connections.list',
    method: 'POST',
    path: '/v1/model-connections/list',
    requestSchema: ModelConnectionListRequestSchema as typeof ModelConnectionListRequestSchema,
    responseSchema: ModelConnectionListResponseSchema as typeof ModelConnectionListResponseSchema,
  },
  getModelDefaults: {
    operation: 'model-defaults.get',
    method: 'POST',
    path: '/v1/model-connections/defaults/get',
    requestSchema: ModelDefaultsGetRequestSchema as typeof ModelDefaultsGetRequestSchema,
    responseSchema: ModelDefaultsResponseSchema as typeof ModelDefaultsResponseSchema,
  },
  setModelDefaults: {
    operation: 'model-defaults.set',
    method: 'POST',
    path: '/v1/model-connections/defaults/set',
    requestSchema: ModelDefaultsSetRequestSchema as typeof ModelDefaultsSetRequestSchema,
    responseSchema: ModelDefaultsResponseSchema as typeof ModelDefaultsResponseSchema,
  },
  resolveModelSelection: {
    operation: 'model-selection.resolve',
    method: 'POST',
    path: '/v1/model-connections/selection/resolve',
    requestSchema: ModelSelectionResolveRequestSchema as typeof ModelSelectionResolveRequestSchema,
    responseSchema: ModelSelectionResponseSchema as typeof ModelSelectionResponseSchema,
  },

  createCredential: {
    operation: 'credential.create',
    method: 'POST',
    path: '/v1/credentials/create',
    requestSchema: CredentialCreateRequestSchema as typeof CredentialCreateRequestSchema,
    responseSchema: CredentialResponseSchema as typeof CredentialResponseSchema,
  },
  rotateCredential: {
    operation: 'credential.rotate',
    method: 'POST',
    path: '/v1/credentials/rotate',
    requestSchema: CredentialRotateRequestSchema as typeof CredentialRotateRequestSchema,
    responseSchema: CredentialResponseSchema as typeof CredentialResponseSchema,
  },
  revokeCredential: {
    operation: 'credential.revoke',
    method: 'POST',
    path: '/v1/credentials/revoke',
    requestSchema: CredentialRevokeRequestSchema as typeof CredentialRevokeRequestSchema,
    responseSchema: CredentialResponseSchema as typeof CredentialResponseSchema,
  },
  getCredential: {
    operation: 'credential.get',
    method: 'POST',
    path: '/v1/credentials/get',
    requestSchema: CredentialGetRequestSchema as typeof CredentialGetRequestSchema,
    responseSchema: CredentialResponseSchema as typeof CredentialResponseSchema,
  },
  listCredentials: {
    operation: 'credential.list',
    method: 'POST',
    path: '/v1/credentials/list',
    requestSchema: CredentialListRequestSchema as typeof CredentialListRequestSchema,
    responseSchema: CredentialListResponseSchema as typeof CredentialListResponseSchema,
  },
  revokeRuntimeNodeCredential: {
    operation: 'runtime-node-credential.revoke',
    method: 'POST',
    path: '/v1/runtime-node-credentials/revoke',
    requestSchema:
      RuntimeNodeCredentialRevokeRequestSchema as typeof RuntimeNodeCredentialRevokeRequestSchema,
    responseSchema:
      RuntimeNodeCredentialRevocationResponseSchema as typeof RuntimeNodeCredentialRevocationResponseSchema,
  },
  publishGraph: {
    operation: 'graph.publish',
    method: 'POST',
    path: '/v1/graphs/publish',
    requestSchema:
      GraphDefinitionPublishRequestSchema as typeof GraphDefinitionPublishRequestSchema,
    responseSchema: GraphDefinitionResponseSchema as typeof GraphDefinitionResponseSchema,
  },
  deprecateGraph: {
    operation: 'graph.deprecate',
    method: 'POST',
    path: '/v1/graphs/deprecate',
    requestSchema:
      GraphDefinitionDeprecationRequestSchema as typeof GraphDefinitionDeprecationRequestSchema,
    responseSchema: GraphDefinitionResponseSchema as typeof GraphDefinitionResponseSchema,
  },
  revokeGraph: {
    operation: 'graph.revoke',
    method: 'POST',
    path: '/v1/graphs/revoke',
    requestSchema:
      GraphDefinitionRevocationRequestSchema as typeof GraphDefinitionRevocationRequestSchema,
    responseSchema: GraphDefinitionResponseSchema as typeof GraphDefinitionResponseSchema,
  },
  resolveGraph: {
    operation: 'graph.resolve',
    method: 'POST',
    path: '/v1/graphs/resolve',
    requestSchema:
      GraphDefinitionResolutionRequestSchema as typeof GraphDefinitionResolutionRequestSchema,
    responseSchema: GraphDefinitionResponseSchema as typeof GraphDefinitionResponseSchema,
  },
  listWorkspaceSkills: {
    operation: 'catalog.skill.list',
    method: 'POST',
    path: '/v1/catalog/skills/list',
    requestSchema: WorkspaceSkillListRequestSchema as typeof WorkspaceSkillListRequestSchema,
    responseSchema: WorkspaceSkillListResponseSchema as typeof WorkspaceSkillListResponseSchema,
  },
  getWorkspaceSkill: {
    operation: 'catalog.skill.get',
    method: 'POST',
    path: '/v1/catalog/skills/get',
    requestSchema: WorkspaceSkillGetRequestSchema as typeof WorkspaceSkillGetRequestSchema,
    responseSchema: WorkspaceSkillGetResponseSchema as typeof WorkspaceSkillGetResponseSchema,
  },
  publishWorkspaceSkill: {
    operation: 'catalog.skill.publish',
    method: 'POST',
    path: '/v1/catalog/skills/publish',
    requestSchema: WorkspaceSkillPublishRequestSchema as typeof WorkspaceSkillPublishRequestSchema,
    responseSchema:
      WorkspaceSkillPublishResponseSchema as typeof WorkspaceSkillPublishResponseSchema,
  },
  deprecateWorkspaceSkill: {
    operation: 'catalog.skill.deprecate',
    method: 'POST',
    path: '/v1/catalog/skills/deprecate',
    requestSchema:
      WorkspaceSkillDeprecationRequestSchema as typeof WorkspaceSkillDeprecationRequestSchema,
    responseSchema:
      WorkspaceSkillLifecycleResponseSchema as typeof WorkspaceSkillLifecycleResponseSchema,
  },
  revokeWorkspaceSkill: {
    operation: 'catalog.skill.revoke',
    method: 'POST',
    path: '/v1/catalog/skills/revoke',
    requestSchema:
      WorkspaceSkillRevocationRequestSchema as typeof WorkspaceSkillRevocationRequestSchema,
    responseSchema:
      WorkspaceSkillLifecycleResponseSchema as typeof WorkspaceSkillLifecycleResponseSchema,
  },
  listWorkspaceProfiles: {
    operation: 'catalog.profile.list',
    method: 'POST',
    path: '/v1/catalog/profiles/list',
    requestSchema:
      WorkspaceAgentProfileListRequestSchema as typeof WorkspaceAgentProfileListRequestSchema,
    responseSchema:
      WorkspaceAgentProfileListResponseSchema as typeof WorkspaceAgentProfileListResponseSchema,
  },
  getWorkspaceProfile: {
    operation: 'catalog.profile.get',
    method: 'POST',
    path: '/v1/catalog/profiles/get',
    requestSchema:
      WorkspaceAgentProfileGetRequestSchema as typeof WorkspaceAgentProfileGetRequestSchema,
    responseSchema:
      WorkspaceAgentProfileGetResponseSchema as typeof WorkspaceAgentProfileGetResponseSchema,
  },
  publishWorkspaceProfile: {
    operation: 'catalog.profile.publish',
    method: 'POST',
    path: '/v1/catalog/profiles/publish',
    requestSchema:
      WorkspaceAgentProfilePublishRequestSchema as typeof WorkspaceAgentProfilePublishRequestSchema,
    responseSchema:
      WorkspaceAgentProfilePublishResponseSchema as typeof WorkspaceAgentProfilePublishResponseSchema,
  },
  deprecateWorkspaceProfile: {
    operation: 'catalog.profile.deprecate',
    method: 'POST',
    path: '/v1/catalog/profiles/deprecate',
    requestSchema:
      WorkspaceAgentProfileDeprecationRequestSchema as typeof WorkspaceAgentProfileDeprecationRequestSchema,
    responseSchema:
      WorkspaceAgentProfileLifecycleResponseSchema as typeof WorkspaceAgentProfileLifecycleResponseSchema,
  },
  revokeWorkspaceProfile: {
    operation: 'catalog.profile.revoke',
    method: 'POST',
    path: '/v1/catalog/profiles/revoke',
    requestSchema:
      WorkspaceAgentProfileRevocationRequestSchema as typeof WorkspaceAgentProfileRevocationRequestSchema,
    responseSchema:
      WorkspaceAgentProfileLifecycleResponseSchema as typeof WorkspaceAgentProfileLifecycleResponseSchema,
  },
  cancelExecution: {
    responseStatus: 202,
    operation: 'execution.cancel',
    method: 'POST',
    path: '/v1/executions/cancel',
    requestSchema: ExecutionCancellationCommandSchema as typeof ExecutionCancellationCommandSchema,
    responseSchema:
      ExecutionCancellationCommandResultSchema as typeof ExecutionCancellationCommandResultSchema,
  },
  respondToInteraction: {
    responseStatus: 202,
    operation: 'interaction.respond',
    method: 'POST',
    path: '/v1/interactions/respond',
    requestSchema: InteractionResponseCommandSchema as typeof InteractionResponseCommandSchema,
    responseSchema:
      InteractionResponseCommandResultSchema as typeof InteractionResponseCommandResultSchema,
  },
  verifyAuthentication: {
    operation: 'authentication.verify',
    method: 'POST',
    path: '/v1/authentication/verify',
    requestSchema: ServiceAuthenticationRequestSchema as typeof ServiceAuthenticationRequestSchema,
    responseSchema:
      ServiceAuthenticationResponseSchema as typeof ServiceAuthenticationResponseSchema,
  },
  resolveProfile: {
    operation: 'profile.resolve',
    method: 'POST',
    path: '/v1/profiles/resolve',
    requestSchema: ProfileResolutionRequestSchema as typeof ProfileResolutionRequestSchema,
    responseSchema: ProfileResolutionResponseSchema as typeof ProfileResolutionResponseSchema,
  },
  resolveProjectState: {
    operation: 'project-state.resolve',
    method: 'POST',
    path: '/v1/project-states/resolve',
    requestSchema:
      ProjectStateResolutionRequestSchema as typeof ProjectStateResolutionRequestSchema,
    responseSchema:
      ProjectStateResolutionResponseSchema as typeof ProjectStateResolutionResponseSchema,
  },
  initializeProjectState: {
    operation: 'project-state.initialize',
    method: 'POST',
    path: '/v1/project-states/initialize',
    requestSchema:
      ProjectStateInitializationRequestSchema as typeof ProjectStateInitializationRequestSchema,
    responseSchema:
      ProjectStateInitializationResponseSchema as typeof ProjectStateInitializationResponseSchema,
  },
  resolveContextPackage: {
    operation: 'context-package.resolve',
    method: 'POST',
    path: '/v1/context-packages/resolve',
    requestSchema:
      ContextPackageResolutionRequestSchema as typeof ContextPackageResolutionRequestSchema,
    responseSchema:
      ContextPackageResolutionResponseSchema as typeof ContextPackageResolutionResponseSchema,
  },
  listRuntimes: {
    operation: 'runtime.list',
    method: 'POST',
    path: '/v1/runtimes/list',
    requestSchema: RuntimeListRequestSchema as typeof RuntimeListRequestSchema,
    responseSchema: RuntimeListResponseSchema as typeof RuntimeListResponseSchema,
  },
  listRuntimeConnections: {
    operation: 'runtime-connection.list',
    method: 'POST',
    path: '/v1/runtime-connections/list',
    requestSchema: RuntimeConnectionListRequestSchema as typeof RuntimeConnectionListRequestSchema,
    responseSchema:
      RuntimeConnectionListResponseSchema as typeof RuntimeConnectionListResponseSchema,
  },
  getRuntimeConnection: {
    operation: 'runtime-connection.get',
    method: 'POST',
    path: '/v1/runtime-connections/get',
    requestSchema: RuntimeConnectionGetRequestSchema as typeof RuntimeConnectionGetRequestSchema,
    responseSchema: RuntimeConnectionGetResponseSchema as typeof RuntimeConnectionGetResponseSchema,
  },
  listExternalSessions: {
    operation: 'external-session.list',
    method: 'POST',
    path: '/v1/external-sessions/list',
    requestSchema: ExternalSessionListRequestSchema as typeof ExternalSessionListRequestSchema,
    responseSchema: ExternalSessionListResponseSchema as typeof ExternalSessionListResponseSchema,
  },
  getExternalSession: {
    operation: 'external-session.get',
    method: 'POST',
    path: '/v1/external-sessions/get',
    requestSchema: ExternalSessionGetRequestSchema as typeof ExternalSessionGetRequestSchema,
    responseSchema: ExternalSessionGetResponseSchema as typeof ExternalSessionGetResponseSchema,
  },
  validateExecutionRequest: {
    operation: 'execution.validate',
    method: 'POST',
    path: '/v1/executions/validate',
    requestSchema:
      ExecutionRequestValidationRequestSchema as typeof ExecutionRequestValidationRequestSchema,
    responseSchema:
      ExecutionRequestValidationResponseSchema as typeof ExecutionRequestValidationResponseSchema,
  },
  acceptExecution: {
    operation: 'execution.accept',
    method: 'POST',
    path: '/v1/executions/accept',
    requestSchema: ExecutionAcceptanceRequestSchema as typeof ExecutionAcceptanceRequestSchema,
    responseSchema: ExecutionAcceptanceResponseSchema as typeof ExecutionAcceptanceResponseSchema,
  },
  marketplaceCatalog: {
    operation: 'marketplace.catalog.read',
    method: 'POST',
    path: '/v1/marketplace/catalog',
    requestSchema: MarketplaceCatalogRequestSchema as typeof MarketplaceCatalogRequestSchema,
    responseSchema: MarketplaceCatalogResponseSchema as typeof MarketplaceCatalogResponseSchema,
  },
  marketplaceInstall: {
    operation: 'marketplace.install.request',
    method: 'POST',
    path: '/v1/marketplace/install',
    requestSchema: MarketplaceInstallRequestSchema as typeof MarketplaceInstallRequestSchema,
    responseSchema: MarketplaceInstallResponseSchema as typeof MarketplaceInstallResponseSchema,
  },
  marketplaceInstallPlan: {
    operation: 'marketplace.install.plan',
    method: 'POST',
    path: '/v1/marketplace/install-plan',
    requestSchema:
      MarketplaceInstallPlanRequestSchema as typeof MarketplaceInstallPlanRequestSchema,
    responseSchema:
      MarketplaceInstallPlanResponseSchema as typeof MarketplaceInstallPlanResponseSchema,
  },
  marketplaceInstallationGet: {
    operation: 'marketplace.installation.get',
    method: 'POST',
    path: '/v1/marketplace/installations/get',
    requestSchema:
      MarketplaceInstallationGetRequestSchema as typeof MarketplaceInstallationGetRequestSchema,
    responseSchema:
      MarketplaceInstallationGetResponseSchema as typeof MarketplaceInstallationGetResponseSchema,
  },
  marketplaceInstallationUninstall: {
    operation: 'marketplace.installation.uninstall',
    method: 'POST',
    path: '/v1/marketplace/installations/uninstall',
    requestSchema:
      MarketplaceInstallationUninstallRequestSchema as typeof MarketplaceInstallationUninstallRequestSchema,
    responseSchema:
      MarketplaceInstallationUninstallResponseSchema as typeof MarketplaceInstallationUninstallResponseSchema,
  },
  preparePiDurableLead: {
    operation: 'pi-durable.lead.prepare',
    method: 'POST',
    path: '/v3/pi-durable/lead-dispatches/prepare',
    requestSchema: PiDurableLeadPrepareRequestSchema as typeof PiDurableLeadPrepareRequestSchema,
    responseSchema: PiDurableLeadPrepareResponseSchema as typeof PiDurableLeadPrepareResponseSchema,
  },
  dispatchPiDurableLead: {
    operation: 'pi-durable.lead.dispatch',
    method: 'POST',
    path: '/v3/pi-durable/lead-dispatches/dispatch',
    requestSchema: PiDurableLeadDispatchRequestSchema as typeof PiDurableLeadDispatchRequestSchema,
    responseSchema:
      PiDurableLeadDispatchResponseSchema as typeof PiDurableLeadDispatchResponseSchema,
    responseStatus: 202,
  },
  lookupPiDurableLead: {
    operation: 'pi-durable.lead.lookup',
    method: 'POST',
    path: '/v3/pi-durable/lead-dispatches/lookup',
    requestSchema: PiDurableLeadLookupRequestSchema as typeof PiDurableLeadLookupRequestSchema,
    responseSchema: PiDurableLeadLookupResponseSchema as typeof PiDurableLeadLookupResponseSchema,
  },
  getPiDurableLeadStatus: {
    operation: 'pi-durable.lead.status',
    method: 'POST',
    path: '/v3/pi-durable/lead-dispatches/status',
    requestSchema: PiDurableLeadStatusRequestSchema as typeof PiDurableLeadStatusRequestSchema,
    responseSchema: PiDurableLeadStatusResponseSchema as typeof PiDurableLeadStatusResponseSchema,
  },
  getPiDurableLeadProgress: {
    operation: 'pi-durable.lead.progress',
    method: 'POST',
    path: '/v3/pi-durable/lead-dispatches/progress',
    requestSchema: PiDurableLeadProgressRequestSchema as typeof PiDurableLeadProgressRequestSchema,
    responseSchema:
      PiDurableLeadProgressResponseSchema as typeof PiDurableLeadProgressResponseSchema,
  },
  getPiDurableLeadChildren: {
    operation: 'pi-durable.lead.children',
    method: 'POST',
    path: '/v3/pi-durable/lead-dispatches/children',
    requestSchema: PiDurableLeadChildrenRequestSchema as typeof PiDurableLeadChildrenRequestSchema,
    responseSchema:
      PiDurableLeadChildrenResponseSchema as typeof PiDurableLeadChildrenResponseSchema,
  },
  cancelPiDurableLead: {
    operation: 'pi-durable.lead.cancel',
    method: 'POST',
    path: '/v3/pi-durable/lead-dispatches/cancel',
    requestSchema: PiDurableLeadCancelRequestSchema as typeof PiDurableLeadCancelRequestSchema,
    responseSchema: PiDurableLeadCancelResponseSchema as typeof PiDurableLeadCancelResponseSchema,
    responseStatus: 202,
  },
} as const)

export type ControlApiOperationName = keyof typeof ControlApiOperations
