import {
  createMemoryWriteApplication,
  resolveMemoryWriteConfiguration,
  type MemoryWriteApplication,
  type MemoryWriteApplicationConfiguration,
} from '@control-plane/memory-writeback'
import { RepositoryGraphAdministrationService } from './graphs/graph-administration.service.js'
import { VaultCredentialAdministrationService } from './credentials/credential-administration.service.js'
import { CredentialVault, NeonEncryptedSecretProvider } from '@control-plane/credential-vault'
import type { StructuredLogger } from '@control-plane/bootstrap'
import {
  decidedRetentionPolicy,
  retentionClassPolicy,
  type ManagedCloudConfiguration,
  type RawEnvironment,
} from '@control-plane/config'
import {
  ContextPackageAuthoringService,
  type ContextAuthoringCompositionOptions,
} from '@control-plane/context'
import {
  createPostgresConnection,
  PostgresCatalogApprovalRepository,
  PostgresCatalogRepository,
  PostgresCredentialVaultRepository,
  PostgresEncryptedSecretStore,
  PostgresGraphDefinitionRepository,
  PostgresCommandAcceptanceRepository,
  PostgresExecutionEventRepository,
  PostgresInteractionRepository,
  PostgresMemoryWriteProposalRepository,
  PostgresInteractionCommandRepository,
  PostgresExecutionCancellationRepository,
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
  DurableExecutionCancellationService,
  DurableInteractionDeliveryService,
} from '@control-plane/domain'
import { RetentionSweep } from '@control-plane/deployment'
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
import type { MarketplaceHarnessProfileAuthority } from './marketplace/agent-plugins.js'
import { MarketplaceRegistryService } from './marketplace/registry.js'

const executionPlanCompilerVersion = '1.0.0'

/**
 * Stable label bound into each ciphertext's AAD. Changing it makes existing secrets
 * unreadable, so a key rotation must introduce a new label alongside the old one.
 */
export const MANAGED_CLOUD_SECRET_KEY_REFERENCE = 'control-plane-secret-encryption-key/v1'

function createCredentialAdministration(
  configuration: ManagedCloudConfiguration,
  database: PostgresConnection['database']
): VaultCredentialAdministrationService | undefined {
  if (!configuration.secretEncryptionKey) return undefined
  let provider: NeonEncryptedSecretProvider
  try {
    provider = new NeonEncryptedSecretProvider({
      store: new PostgresEncryptedSecretStore(database),
      encryptionKey: configuration.secretEncryptionKey,
      keyReference: MANAGED_CLOUD_SECRET_KEY_REFERENCE,
    })
  } catch {
    throw new ControlApiCloudCompositionError()
  }
  const repository = new PostgresCredentialVaultRepository(database)
  // The Control API never leases: no policy decision point is composed, so leases deny.
  return new VaultCredentialAdministrationService({
    vault: new CredentialVault({ provider, repository }),
    receipts: repository,
  })
}

const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 3_600_000

/** Sweep cadence override; invalid values fail closed before any resource is created. */
function resolveRetentionSweepIntervalMs(environment: RawEnvironment): number {
  const raw = environment['RETENTION_SWEEP_INTERVAL_MS']
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_SWEEP_INTERVAL_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ControlApiCloudCompositionError()
  }
  return value
}

export type PostgresConnectionFactory = typeof createPostgresConnection

export interface ManagedCloudControlApiComposition {
  readonly memoryWrites: MemoryWriteApplication
  readonly interactionCommandService: DurableInteractionCommandService
  readonly executionCancellationService: DurableExecutionCancellationService
  readonly connection: PostgresConnection
  readonly executionAcceptanceService: DurableExecutionAcceptanceService
  readonly graphAdministrationService: RepositoryGraphAdministrationService
  /** Absent when no secret-encryption key is configured; the routes then fail closed. */
  readonly credentialAdministrationService?: VaultCredentialAdministrationService
  readonly executionValidationService: DurableExecutionValidationService
  readonly serviceAuthenticator: PolicyServiceAuthenticator
  readonly profileResolutionService: RepositoryProfileResolutionService
  readonly projectStateResolutionService: RepositoryProjectStateResolutionService
  readonly contextPackageResolutionService: RepositoryContextPackageResolutionService
  readonly runtimeDiscoveryRepository: PostgresRuntimeDiscoveryRepository
  readonly marketplaceRegistryService: MarketplaceRegistryService
  readonly marketplaceInstallationService: MarketplaceInstallationAuthority
  readonly retentionSweep: RetentionSweep
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
  contextAuthoring?: ContextAuthoringCompositionOptions,
  marketplaceHarnessProfileAuthority?: MarketplaceHarnessProfileAuthority,
  memoryWriteback?: MemoryWriteApplicationConfiguration
): ManagedCloudControlApiComposition {
  const memoryConfiguration = resolveMemoryWriteConfiguration(memoryWriteback)
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
  const retentionIntervalMs = resolveRetentionSweepIntervalMs(process.env)
  const connection = connectionFactory(configuration.database)
  const catalog = new PostgresCatalogRepository(connection.database)
  const catalogApprovals = new PostgresCatalogApprovalRepository(connection.database)
  const plans = new PostgresExecutionPlanRepository(connection.database)
  const projectStates = new PostgresProjectStateRepository(connection.database)
  const contextPackages = new PostgresContextPackageRepository(connection.database)
  const retentionPolicy = decidedRetentionPolicy
  const commandInboxRepository = new PostgresCommandAcceptanceRepository(connection.database)
  const executionEventRepository = new PostgresExecutionEventRepository(connection.database)
  const retentionSweep = new RetentionSweep({
    assessCommandInbox: (now) =>
      commandInboxRepository.assessExpiredInbox(now, {
        policyRetainMs: retentionClassPolicy(retentionPolicy, 'command-inbox').retainMs,
      }),
    assessExecutionEvents: (now) =>
      executionEventRepository.assessExpiredEvents(now, {
        policyRetainMs: retentionClassPolicy(retentionPolicy, 'execution-events').retainMs,
      }),
    intervalMs: retentionIntervalMs,
    onError: () => logger.write({ level: 'error', event: 'retention.sweep_failed' }),
    onReport: (report) =>
      logger.write({
        level:
          report.assessment.commandInbox.eligible > 0 ||
          report.assessment.executionEvents.eligible > 0
            ? 'warn'
            : 'info',
        event: 'retention.sweep',
        metadata: {
          commandInbox: report.assessment.commandInbox,
          executionEvents: report.assessment.executionEvents,
        },
      }),
  })
  const registryToken = process.env['MARKETPLACE_REGISTRY_TOKEN']
  const marketplaceRegistryService = new MarketplaceRegistryService({
    // Full plugin catalogs exceed the registry's default 12 MiB artifact cap.
    maxArtifactBytes: 64 * 1024 * 1024,
    ...(process.env['MARKETPLACE_REGISTRY_IMMUTABLE_BASE_URL'] === undefined
      ? {}
      : {
          immutableArtifactBaseUrl: process.env['MARKETPLACE_REGISTRY_IMMUTABLE_BASE_URL'],
        }),
    ...(process.env['MARKETPLACE_REGISTRY_LATEST_URL'] === undefined
      ? {}
      : { latestUrl: process.env['MARKETPLACE_REGISTRY_LATEST_URL'] }),
    releaseVerifier: new GithubReleaseVerifier(
      registryToken === undefined ? {} : { token: registryToken }
    ),
    ...(registryToken === undefined ? {} : { token: registryToken }),
  })

  const credentialAdministrationService = createCredentialAdministration(
    configuration,
    connection.database
  )
  return {
    ...(credentialAdministrationService === undefined ? {} : { credentialAdministrationService }),
    memoryWrites: createMemoryWriteApplication({
      repository: new PostgresMemoryWriteProposalRepository(connection.database),
      interactionRepository: new PostgresInteractionRepository(connection.database),
      configuration: memoryConfiguration,
    }),
    connection,
    retentionSweep,
    executionCancellationService: new DurableExecutionCancellationService(
      new PostgresExecutionCancellationRepository(connection.database),
      new PostgresCommandAcceptanceRepository(connection.database),
      new RestateExecutionWorkflowDispatcher({ ingressUrl: configuration.restate.ingressUrl })
    ),
    interactionCommandService: new DurableInteractionCommandService(
      new PostgresInteractionCommandRepository(connection.database),
      new DurableInteractionDeliveryService(
        new PostgresInteractionRepository(connection.database),
        new PostgresCommandAcceptanceRepository(connection.database),
        new RestateExecutionWorkflowDispatcher({ ingressUrl: configuration.restate.ingressUrl })
      )
    ),
    executionAcceptanceService: new DurableExecutionAcceptanceService({
      plans,
      commands: new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(connection.database, {
          budgetAdmission: true,
        }),
        executionIdFactory: createExecutionId,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans, {
          catalog: { profiles: catalog, skills: catalog },
          ...(configuration.catalogApproval === undefined
            ? {}
            : {
                approvalGate: {
                  approvals: catalogApprovals,
                  policy: configuration.catalogApproval,
                },
              }),
        }),
      }),
      dispatcher: new RestateExecutionWorkflowDispatcher({
        ingressUrl: configuration.restate.ingressUrl,
      }),
    }),
    graphAdministrationService: new RepositoryGraphAdministrationService({
      repository: (workspaceId) =>
        new PostgresGraphDefinitionRepository(connection.database, workspaceId),
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
              ...(contextAuthoring.providerResolver === undefined
                ? {}
                : {
                    providerResolver: contextAuthoring.providerResolver,
                  }),
              now: contextAuthoring.now ?? (() => new Date()),
            }),
          }),
      profiles: catalog,
      projectStates,
      skills: catalog,
      ...(configuration.catalogApproval === undefined
        ? {}
        : {
            approvalGate: { approvals: catalogApprovals, policy: configuration.catalogApproval },
          }),
    }),
    profileResolutionService: new RepositoryProfileResolutionService(
      catalog,
      configuration.catalogApproval === undefined
        ? undefined
        : {
            approvals: catalogApprovals,
            skills: catalog,
            policy: configuration.catalogApproval,
          }
    ),
    projectStateResolutionService: new RepositoryProjectStateResolutionService(projectStates),
    contextPackageResolutionService: new RepositoryContextPackageResolutionService(contextPackages),
    runtimeDiscoveryRepository: new PostgresRuntimeDiscoveryRepository(connection.database),
    serviceAuthenticator,
    marketplaceRegistryService,
    marketplaceInstallationService: new MarketplaceInstallationService({
      registry: marketplaceRegistryService,
      repository: new PostgresMarketplaceInstallationRepository(connection.database),
      policy: {
        ...(marketplaceHarnessProfileAuthority === undefined
          ? {}
          : { harnessProfile: marketplaceHarnessProfileAuthority }),
        authorizeSecurityClassification: async ({ classification }) =>
          classification['level'] === 'low',
      },
    }),
  }
}
