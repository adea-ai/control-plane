export { createCurrentModelConnectionComposition } from './models/current-model-composition.js'
export {
  createProductionPiLeadComposition,
  type ProductionPiLeadCompositionOptions,
} from './models/production-model-composition.js'
export {
  createProductionChildModelAuthority,
  ProductionChildModelRequestSchema,
} from './models/production-child-model-authority.js'
export { createProductionRoleModelSelection } from './models/production-role-selection.js'
export { ProductionLeadProductEvidenceSchema } from './models/production-lead-product.js'
export { createProductionProductHttpReader } from './models/production-product-http.js'
import {
  createProductionPiLeadComposition,
  type ProductionPiLeadCompositionOptions,
} from './models/production-model-composition.js'
export {
  createPiLeadModelAdmissionReadiness,
  type PiLeadModelAdmissionInput,
} from './models/pi-lead-model-readiness.js'
import type { GraphAdministrationService } from './graphs/graph-administration.service.js'
import type { PiDurableLeadService } from './pi-durable/pi-durable-lead.service.js'
import type { WorkspaceCatalogService } from './catalog/workspace-catalog.service.js'
import type { CredentialAdministrationService } from './credentials/credential-administration.service.js'
import {
  bootstrapService,
  jsonLogger,
  type ProcessAdapter,
  type ServiceRuntime,
  type StructuredLogger,
} from '@control-plane/bootstrap'
import type { RawEnvironment } from '@control-plane/config'
import type { ContextAuthoringCompositionOptions } from '@control-plane/context'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { databaseReadinessProbe } from '@control-plane/database'
import { createControlApiApplication } from './application.js'
import type { ServiceAuthenticator } from './auth/service-authentication.js'
import {
  createManagedCloudControlApiComposition,
  type PostgresConnectionFactory,
} from './cloud-composition.js'
import type { ExecutionValidationService } from './executions/execution-validation.service.js'
import type { ExecutionAcceptanceService } from './executions/execution-acceptance.service.js'
import type { InteractionCommandService } from './executions/interaction-command.controller.js'
import type { ExecutionCancellationService } from './executions/execution-cancellation.controller.js'
import type { AdmissionControlService } from './executions/admission-control.controller.js'
import type { RuntimeDiscoveryRepository } from './runtime-discovery/runtime-discovery.repository.js'
import type { ProfileResolutionService } from './queries/profile-resolution.service.js'
import type { ProjectStateResolutionService } from './queries/project-state-resolution.service.js'
import type { ProjectStateInitializationService } from './project-states/project-state-initialization.service.js'
import type { ContextPackageResolutionService } from './queries/context-package-resolution.service.js'
import type { MarketplaceInstallationAuthority } from './marketplace/installation.js'
import type { MarketplaceHarnessProfileAuthority } from './marketplace/agent-plugins.js'
import type { MarketplaceRegistryService } from './marketplace/registry.js'

import type {
  MemoryWriteApplication,
  MemoryWriteApplicationConfiguration,
} from '@control-plane/memory-writeback'

export const serviceName = 'control-api'

export interface ControlApiStartOptions {
  readonly piDurableProduction?: ProductionPiLeadCompositionOptions
  readonly piDurableLeadService?: PiDurableLeadService
  readonly graphAdministrationService?: GraphAdministrationService
  readonly workspaceCatalogService?: WorkspaceCatalogService
  readonly credentialAdministrationService?: CredentialAdministrationService
  readonly interactionCommandService?: InteractionCommandService
  readonly executionCancellationService?: ExecutionCancellationService
  readonly admissionControlService?: AdmissionControlService
  readonly memoryWriteback?: MemoryWriteApplicationConfiguration
  readonly contextAuthoring?: ContextAuthoringCompositionOptions
  readonly cwd?: string
  readonly environment?: RawEnvironment
  readonly executionAcceptanceService?: ExecutionAcceptanceService
  readonly executionValidationService?: ExecutionValidationService
  readonly listen?: boolean
  readonly logger?: StructuredLogger
  readonly processAdapter?: ProcessAdapter
  readonly postgresConnectionFactory?: PostgresConnectionFactory
  readonly runtimeDiscoveryRepository?: RuntimeDiscoveryRepository
  readonly profileResolutionService?: ProfileResolutionService
  readonly projectStateResolutionService?: ProjectStateResolutionService
  readonly projectStateInitializationService?: ProjectStateInitializationService
  readonly contextPackageResolutionService?: ContextPackageResolutionService
  readonly serviceAuthenticator?: ServiceAuthenticator
  readonly marketplaceRegistryService?: MarketplaceRegistryService
  readonly marketplaceInstallationService?: MarketplaceInstallationAuthority
  readonly marketplaceHarnessProfileAuthority?: MarketplaceHarnessProfileAuthority
}

export interface StartedControlApi {
  readonly memoryWrites?: MemoryWriteApplication
  readonly application: NestFastifyApplication
  readonly runtime: ServiceRuntime<'control-api'>
}

export async function start(options: ControlApiStartOptions = {}): Promise<StartedControlApi> {
  if (options.piDurableProduction && options.piDurableLeadService)
    throw new Error('PI_PRODUCTION_CONFIGURATION_CONFLICT')
  const logger = options.logger ?? jsonLogger
  let application: NestFastifyApplication | undefined
  let memoryWrites: MemoryWriteApplication | undefined
  const runtime = await bootstrapService({
    serviceName,
    logger,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.processAdapter === undefined ? {} : { processAdapter: options.processAdapter }),
    start: async ({
      config,
      health,
      managedCloud,
      markReady,
      metadata,
      readiness,
      registerResource,
    }) => {
      const cloudComposition =
        managedCloud === undefined
          ? undefined
          : createManagedCloudControlApiComposition(
              managedCloud,
              logger,
              options.postgresConnectionFactory,
              options.contextAuthoring,
              options.marketplaceHarnessProfileAuthority,
              options.memoryWriteback
            )
      memoryWrites = cloudComposition?.memoryWrites
      if (cloudComposition !== undefined) {
        registerResource('control-api-postgres', () => cloudComposition.connection.close())
        registerResource('control-api-retention-sweep', () =>
          cloudComposition.retentionSweep.close()
        )
        await cloudComposition.connection.check()
        cloudComposition.retentionSweep.start()
      }
      const graphAdministrationService =
        options.graphAdministrationService ?? cloudComposition?.graphAdministrationService
      const workspaceCatalogService =
        options.workspaceCatalogService ?? cloudComposition?.workspaceCatalogService
      const credentialAdministrationService =
        options.credentialAdministrationService ?? cloudComposition?.credentialAdministrationService
      const executionValidationService =
        options.executionValidationService ?? cloudComposition?.executionValidationService
      const executionAcceptanceService =
        options.executionAcceptanceService ?? cloudComposition?.executionAcceptanceService
      const interactionCommandService =
        options.interactionCommandService ?? cloudComposition?.interactionCommandService
      const executionCancellationService =
        options.executionCancellationService ?? cloudComposition?.executionCancellationService
      const serviceAuthenticator =
        options.serviceAuthenticator ?? cloudComposition?.serviceAuthenticator
      const profileResolutionService =
        options.profileResolutionService ?? cloudComposition?.profileResolutionService
      const projectStateResolutionService =
        options.projectStateResolutionService ?? cloudComposition?.projectStateResolutionService
      const projectStateInitializationService =
        options.projectStateInitializationService ??
        cloudComposition?.projectStateInitializationService
      const contextPackageResolutionService =
        options.contextPackageResolutionService ?? cloudComposition?.contextPackageResolutionService
      const runtimeDiscoveryRepository =
        options.runtimeDiscoveryRepository ?? cloudComposition?.runtimeDiscoveryRepository
      const marketplaceRegistryService =
        options.marketplaceRegistryService ?? cloudComposition?.marketplaceRegistryService
      const marketplaceInstallationService =
        options.marketplaceInstallationService ?? cloudComposition?.marketplaceInstallationService
      if (options.piDurableProduction && !serviceAuthenticator)
        throw new Error('PI_PRODUCTION_AUTHENTICATION_REQUIRED')
      const production = options.piDurableProduction
        ? await createProductionPiLeadComposition(options.piDurableProduction)
        : undefined
      if (production) registerResource('pi-durable-production', () => production.close())
      application = await createControlApiApplication({
        ...(production
          ? {
              modelConnectionService: production.modelConnectionService,
              piLeadPublicationService: production.publicationService,
              ...(production.piDurableCurrentToolAuthority
                ? { piDurableCurrentToolAuthority: production.piDurableCurrentToolAuthority }
                : {}),
            }
          : {}),
        ...((production?.piDurableLeadService ?? options.piDurableLeadService) === undefined
          ? {}
          : {
              piDurableLeadService:
                production?.piDurableLeadService ?? options.piDurableLeadService,
            }),
        ...(graphAdministrationService === undefined ? {} : { graphAdministrationService }),
        ...(workspaceCatalogService === undefined ? {} : { workspaceCatalogService }),
        ...(credentialAdministrationService === undefined
          ? {}
          : { credentialAdministrationService }),
        ...(interactionCommandService === undefined ? {} : { interactionCommandService }),
        ...(executionCancellationService === undefined ? {} : { executionCancellationService }),
        ...(options.admissionControlService === undefined
          ? {}
          : { admissionControlService: options.admissionControlService }),
        ...(executionAcceptanceService === undefined ? {} : { executionAcceptanceService }),
        ...(executionValidationService === undefined ? {} : { executionValidationService }),
        health,
        logger,
        metadata,
        readiness,
        ...(cloudComposition === undefined
          ? {}
          : { dependencyReadiness: () => databaseReadinessProbe(cloudComposition.connection) }),
        ...(profileResolutionService === undefined ? {} : { profileResolutionService }),
        ...(projectStateResolutionService === undefined ? {} : { projectStateResolutionService }),
        ...(projectStateInitializationService === undefined
          ? {}
          : { projectStateInitializationService }),
        ...(contextPackageResolutionService === undefined
          ? {}
          : { contextPackageResolutionService }),
        ...(runtimeDiscoveryRepository === undefined ? {} : { runtimeDiscoveryRepository }),
        ...(serviceAuthenticator === undefined ? {} : { serviceAuthenticator }),
        ...(marketplaceRegistryService === undefined ? {} : { marketplaceRegistryService }),
        ...(marketplaceInstallationService === undefined ? {} : { marketplaceInstallationService }),
      })
      registerResource('control-api-http', () => application?.close())
      if (options.listen !== false) {
        await application.listen({ host: '0.0.0.0', port: config.values.port })
      }
      markReady()
    },
  })
  if (!application) throw new Error('Control API application did not initialize')
  return { application, runtime, ...(memoryWrites === undefined ? {} : { memoryWrites }) }
}

export { createControlApiApplication, createOpenApiDocument } from './application.js'
export {
  createCredentialAdministrationService,
  type CredentialAdministrationComposition,
  VaultCredentialAdministrationService,
} from './credentials/credential-administration.service.js'
export {
  RepositoryRuntimeNodeCredentialRevocationService,
  UnavailableRuntimeNodeCredentialRevocationService,
  type RuntimeNodeCredentialRevocationRepository,
  type RuntimeNodeCredentialRevocationService,
} from './runtime-node-credentials/runtime-node-credential-revocation.service.js'
export { createManagedCloudControlApiComposition } from './cloud-composition.js'
export {
  DurableExecutionAcceptanceService,
  RestateExecutionWorkflowDispatcher,
  UnavailableExecutionAcceptanceService,
  createExecutionId,
  type ExecutionAcceptanceService,
  type ExecutionWorkflowDispatcher,
} from './executions/execution-acceptance.service.js'
export { DurableExecutionValidationService } from './executions/execution-validation.service.js'
export type { AdmissionControlService } from './executions/admission-control.controller.js'
export {
  RepositoryProfileResolutionService,
  type ProfileResolutionService,
} from './queries/profile-resolution.service.js'
export {
  RepositoryProjectStateResolutionService,
  type ProjectStateResolutionService,
} from './queries/project-state-resolution.service.js'
export {
  RepositoryProjectStateInitializationService,
  UnavailableProjectStateInitializationService,
  type ProjectStateInitializationService,
} from './project-states/project-state-initialization.service.js'
export {
  RepositoryContextPackageResolutionService,
  type ContextPackageResolutionService,
} from './queries/context-package-resolution.service.js'
export { MarketplaceController } from './marketplace/marketplace.controller.js'
export {
  createMarketplaceAgentPluginsPlan,
  type MarketplaceAgentPluginsPlanRequest,
  type MarketplaceHarnessProfileAuthority,
} from './marketplace/agent-plugins.js'
export {
  InMemoryMarketplaceInstallationRepository,
  MarketplaceInstallationService,
} from './marketplace/installation.js'
export { GithubReleaseVerifier } from './marketplace/github-release-verifier.js'
export { MarketplaceRegistryService } from './marketplace/registry.js'
export type { ServiceAuthenticator } from './auth/service-authentication.js'
export {
  ConfiguredCredentialRevocationChecker,
  Ed25519ServiceCredentialVerifier,
  PolicyServiceAuthenticator,
} from './auth/service-authentication.js'
export {
  createPrivateApiAuthentication,
  type PrivateApiAuthentication,
} from './auth/private-api-authentication.js'

export * from './graphs/graph-administration.service.js'
export * from './catalog/workspace-catalog.service.js'
export * from './pi-durable/pi-durable-lead.service.js'
export * from './pi-durable/node-admission.js'
export * from './pi-durable/node-composition.js'
export * from './pi-durable/lead-preparation.js'
export * from './pi-durable/unused-lead-allocation.js'
export * from './pi-durable/child-progress-scanner.js'
export * from './pi-durable/lead-running-lifecycle.js'
export * from './pi-durable/sqlite-child-continuations.js'
export * from './pi-durable/model-product-authority.js'

export * from './models/model-connections.service.js'

export * from './models/recorded-model-funding.js'
export * from './models/canonical-model-host.js'
export * from './models/sqlite-funding-confirmations.js'
export * from './models/canonical-model-composition.js'
