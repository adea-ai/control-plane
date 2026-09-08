import type { StructuredLogger } from '@control-plane/bootstrap'
import type { ManagedCloudConfiguration } from '@control-plane/config'
import {
  ContextPackageAuthoringService,
  type ContextAuthoringCompositionOptions,
} from '@control-plane/context'
import {
  createPostgresConnection,
  PostgresCatalogRepository,
  PostgresCommandAcceptanceRepository,
  PostgresInteractionRepository,
  PostgresInteractionCommandRepository,
  PostgresContextPackageRepository,
  PostgresContextAuthoringCommandRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionValidationCommandRepository,
  PostgresProjectStateRepository,
  PostgresRuntimeDiscoveryRepository,
  type PostgresConnection,
} from '@control-plane/database'
import {
  CommandInboxService,
  DurableInteractionCommandService,
  DurableInteractionDeliveryService,
} from '@control-plane/domain'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import {
  ConfiguredCredentialRevocationChecker,
  Ed25519ServiceCredentialVerifier,
  PolicyServiceAuthenticator,
} from './auth/service-authentication.js'
import { DurableExecutionValidationService } from './executions/execution-validation.service.js'
import {
  DurableExecutionAcceptanceService,
  RestateExecutionWorkflowDispatcher,
  createExecutionId,
} from './executions/execution-acceptance.service.js'
import { RepositoryProfileResolutionService } from './queries/profile-resolution.service.js'
import { RepositoryProjectStateResolutionService } from './queries/project-state-resolution.service.js'
import { RepositoryContextPackageResolutionService } from './queries/context-package-resolution.service.js'
import { GithubReleaseVerifier } from './marketplace/github-release-verifier.js'
import {
  MarketplaceInstallationService,
  type MarketplaceInstallationAuthority,
} from './marketplace/installation.js'
import { PostgresMarketplaceInstallationRepository } from './marketplace/postgres-installation-repository.js'
import { MarketplaceRegistryService } from './marketplace/registry.js'

const executionPlanCompilerVersion = '1.0.0'

export type PostgresConnectionFactory = typeof createPostgresConnection

export interface ManagedCloudControlApiComposition {
  readonly interactionCommandService: DurableInteractionCommandService
  readonly connection: PostgresConnection
  readonly executionAcceptanceService: DurableExecutionAcceptanceService
  readonly executionValidationService: DurableExecutionValidationService
  readonly serviceAuthenticator: PolicyServiceAuthenticator
  readonly profileResolutionService: RepositoryProfileResolutionService
  readonly projectStateResolutionService: RepositoryProjectStateResolutionService
  readonly contextPackageResolutionService: RepositoryContextPackageResolutionService
  readonly runtimeDiscoveryRepository: PostgresRuntimeDiscoveryRepository
  readonly marketplaceRegistryService: MarketplaceRegistryService
  readonly marketplaceInstallationService: MarketplaceInstallationAuthority
}

export class ControlApiCloudCompositionError extends Error {
  constructor() {
    super('Managed Cloud Control API composition is invalid')
    this.name = 'ControlApiCloudCompositionError'
  }
}

export function createManagedCloudControlApiComposition(
  configuration: ManagedCloudConfiguration,
  logger: StructuredLogger,
  connectionFactory: PostgresConnectionFactory = createPostgresConnection,
  contextAuthoring?: ContextAuthoringCompositionOptions
): ManagedCloudControlApiComposition {
  if (
    configuration.service !== 'control-api' ||
    configuration.database === undefined ||
    configuration.serviceAuthentication === undefined ||
    configuration.restate?.role !== 'caller'
  ) {
    throw new ControlApiCloudCompositionError()
  }

  const authentication = configuration.serviceAuthentication
  const serviceAuthenticator = new PolicyServiceAuthenticator({
    audience: authentication.audience,
    issuer: authentication.issuer,
    logger,
    revocationChecker: new ConfiguredCredentialRevocationChecker(
      authentication.revokedCredentialIds
    ),
    verifier: new Ed25519ServiceCredentialVerifier(authentication.trustedKeys),
  })
  const connection = connectionFactory(configuration.database)
  const catalog = new PostgresCatalogRepository(connection.database)
  const plans = new PostgresExecutionPlanRepository(connection.database)
  const projectStates = new PostgresProjectStateRepository(connection.database)
  const contextPackages = new PostgresContextPackageRepository(connection.database)
  const registryToken = process.env['MARKETPLACE_REGISTRY_TOKEN']
  const marketplaceRegistryService = new MarketplaceRegistryService({
    ...(process.env['MARKETPLACE_REGISTRY_IMMUTABLE_BASE_URL'] === undefined
      ? {}
      : { immutableReleaseBaseUrl: process.env['MARKETPLACE_REGISTRY_IMMUTABLE_BASE_URL'] }),
    ...(process.env['MARKETPLACE_REGISTRY_LATEST_URL'] === undefined
      ? {}
      : { latestUrl: process.env['MARKETPLACE_REGISTRY_LATEST_URL'] }),
    releaseVerifier: new GithubReleaseVerifier(
      registryToken === undefined ? {} : { token: registryToken }
    ),
    ...(registryToken === undefined ? {} : { token: registryToken }),
  })

  return {
    connection,
    interactionCommandService: new DurableInteractionCommandService(
      new PostgresInteractionCommandRepository(connection.database),
      new DurableInteractionDeliveryService(
        new PostgresInteractionRepository(connection.database),
        new PostgresCommandAcceptanceRepository(connection.database),
        new RestateExecutionWorkflowDispatcher({ ingressUrl: configuration.restate.ingressUrl })
      )
    ),
    executionAcceptanceService: new DurableExecutionAcceptanceService({
      commands: new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(connection.database),
        executionIdFactory: createExecutionId,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans),
      }),
      dispatcher: new RestateExecutionWorkflowDispatcher({
        ingressUrl: configuration.restate.ingressUrl,
      }),
    }),
    executionValidationService: new DurableExecutionValidationService({
      compilerVersion: executionPlanCompilerVersion,
      contextPackages,
      commands: new PostgresExecutionValidationCommandRepository(connection.database),
      ...(contextAuthoring === undefined
        ? {}
        : {
            contextAuthoring: new ContextPackageAuthoringService({
              compilerVersion: executionPlanCompilerVersion,
              packages: contextPackages,
              projectStates,
              commands: new PostgresContextAuthoringCommandRepository(connection.database),
              authority: contextAuthoring.authority,
              now: contextAuthoring.now ?? (() => new Date()),
            }),
          }),
      profiles: catalog,
      projectStates,
      skills: catalog,
    }),
    profileResolutionService: new RepositoryProfileResolutionService(catalog),
    projectStateResolutionService: new RepositoryProjectStateResolutionService(projectStates),
    contextPackageResolutionService: new RepositoryContextPackageResolutionService(contextPackages),
    runtimeDiscoveryRepository: new PostgresRuntimeDiscoveryRepository(connection.database),
    serviceAuthenticator,
    marketplaceRegistryService,
    marketplaceInstallationService: new MarketplaceInstallationService({
      registry: marketplaceRegistryService,
      repository: new PostgresMarketplaceInstallationRepository(connection.database),
      policy: {
        authorizeSecurityClassification: async ({ classification }) =>
          classification['level'] === 'low',
      },
    }),
  }
}
