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
import { createControlApiApplication } from './application.js'
import type { ServiceAuthenticator } from './auth/service-authentication.js'
import {
  createManagedCloudControlApiComposition,
  type PostgresConnectionFactory,
} from './cloud-composition.js'
import type { ExecutionValidationService } from './executions/execution-validation.service.js'
import type { ExecutionAcceptanceService } from './executions/execution-acceptance.service.js'
import type { InteractionCommandService } from './executions/interaction-command.controller.js'
import type { RuntimeDiscoveryRepository } from './runtime-discovery/runtime-discovery.repository.js'
import type { ProfileResolutionService } from './queries/profile-resolution.service.js'
import type { ProjectStateResolutionService } from './queries/project-state-resolution.service.js'
import type { ContextPackageResolutionService } from './queries/context-package-resolution.service.js'
import type { MarketplaceInstallationAuthority } from './marketplace/installation.js'
import type { MarketplaceRegistryService } from './marketplace/registry.js'

export const serviceName = 'control-api'

export interface ControlApiStartOptions {
  readonly interactionCommandService?: InteractionCommandService
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
  readonly contextPackageResolutionService?: ContextPackageResolutionService
  readonly serviceAuthenticator?: ServiceAuthenticator
  readonly marketplaceRegistryService?: MarketplaceRegistryService
  readonly marketplaceInstallationService?: MarketplaceInstallationAuthority
}

export interface StartedControlApi {
  readonly application: NestFastifyApplication
  readonly runtime: ServiceRuntime<'control-api'>
}

export async function start(options: ControlApiStartOptions = {}): Promise<StartedControlApi> {
  const logger = options.logger ?? jsonLogger
  let application: NestFastifyApplication | undefined
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
              options.contextAuthoring
            )
      if (cloudComposition !== undefined) {
        registerResource('control-api-postgres', () => cloudComposition.connection.close())
        await cloudComposition.connection.check()
      }
      const executionValidationService =
        options.executionValidationService ?? cloudComposition?.executionValidationService
      const executionAcceptanceService =
        options.executionAcceptanceService ?? cloudComposition?.executionAcceptanceService
      const serviceAuthenticator =
        options.serviceAuthenticator ?? cloudComposition?.serviceAuthenticator
      const profileResolutionService =
        options.profileResolutionService ?? cloudComposition?.profileResolutionService
      const projectStateResolutionService =
        options.projectStateResolutionService ?? cloudComposition?.projectStateResolutionService
      const contextPackageResolutionService =
        options.contextPackageResolutionService ?? cloudComposition?.contextPackageResolutionService
      const runtimeDiscoveryRepository =
        options.runtimeDiscoveryRepository ?? cloudComposition?.runtimeDiscoveryRepository
      const marketplaceRegistryService =
        options.marketplaceRegistryService ?? cloudComposition?.marketplaceRegistryService
      const marketplaceInstallationService =
        options.marketplaceInstallationService ?? cloudComposition?.marketplaceInstallationService
      application = await createControlApiApplication({
        ...(options.interactionCommandService === undefined
          ? {}
          : { interactionCommandService: options.interactionCommandService }),
        ...(executionAcceptanceService === undefined ? {} : { executionAcceptanceService }),
        ...(executionValidationService === undefined ? {} : { executionValidationService }),
        health,
        logger,
        metadata,
        readiness,
        ...(profileResolutionService === undefined ? {} : { profileResolutionService }),
        ...(projectStateResolutionService === undefined ? {} : { projectStateResolutionService }),
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
  return { application, runtime }
}

export { createControlApiApplication, createOpenApiDocument } from './application.js'
export { createManagedCloudControlApiComposition } from './cloud-composition.js'
export {
  DurableExecutionAcceptanceService,
  RestateExecutionWorkflowDispatcher,
  UnavailableExecutionAcceptanceService,
  createExecutionId,
  type ExecutionAcceptanceService,
} from './executions/execution-acceptance.service.js'
export { DurableExecutionValidationService } from './executions/execution-validation.service.js'
export {
  RepositoryProfileResolutionService,
  type ProfileResolutionService,
} from './queries/profile-resolution.service.js'
export {
  RepositoryProjectStateResolutionService,
  type ProjectStateResolutionService,
} from './queries/project-state-resolution.service.js'
export {
  RepositoryContextPackageResolutionService,
  type ContextPackageResolutionService,
} from './queries/context-package-resolution.service.js'
export { MarketplaceController } from './marketplace/marketplace.controller.js'
export {
  InMemoryMarketplaceInstallationRepository,
  MarketplaceInstallationService,
} from './marketplace/installation.js'
export { GithubReleaseVerifier } from './marketplace/github-release-verifier.js'
export { MarketplaceRegistryService } from './marketplace/registry.js'
export type { ServiceAuthenticator } from './auth/service-authentication.js'
export {
  createPrivateApiAuthentication,
  type PrivateApiAuthentication,
} from './auth/private-api-authentication.js'
