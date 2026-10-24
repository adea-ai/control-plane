import {
  createMemoryWriteApplication,
  resolveMemoryWriteConfiguration,
  type MemoryWriteApplication,
  type MemoryWriteApplicationConfiguration,
} from '@control-plane/memory-writeback'
import type { StructuredLogger } from '@control-plane/bootstrap'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ContextPackageAuthoringService,
  GrantsBackedContextAuthoringAuthority,
  type ContextAuthoringCompositionOptions,
  type ContextAuthoringPolicy,
} from '@control-plane/context'
import {
  DurableExecutionAcceptanceService,
  DurableExecutionValidationService,
  RepositoryGraphAdministrationService,
  RepositoryWorkspaceCatalogService,
  RestateExecutionWorkflowDispatcher,
  RepositoryProfileResolutionService,
  RepositoryProjectStateResolutionService,
  RepositoryProjectStateInitializationService,
  RepositoryContextPackageResolutionService,
  RepositoryRuntimeNodeCredentialRevocationService,
  createExecutionId,
} from '@control-plane/control-api'
import {
  createPostgresConnection,
  PostgresCatalogApprovalRepository,
  PostgresCatalogRepository,
  PostgresGraphDefinitionRepository,
  PostgresWorkspaceCatalogCommandRepository,
  PostgresCommandAcceptanceRepository,
  PostgresDurableUsageStore,
  PostgresContextPackageRepository,
  PostgresContextAuthoringCommandRepository,
  PostgresContextCommandGrantRepository,
  PostgresContextProviderRegistrationRepository,
  PostgresExecutionEventRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionValidationCommandRepository,
  PostgresExecutionRepository,
  PostgresInteractionRepository,
  PostgresMemoryWriteProposalRepository,
  PostgresInteractionCommandRepository,
  PostgresExecutionCancellationRepository,
  PostgresProjectStateRepository,
  PostgresReconciliationCheckpointRepository,
  PostgresReconciliationEffects,
  PostgresReconciliationSource,
  PostgresRuntimeCommandRepository,
  PostgresRuntimeConnectionRepository,
  PostgresRuntimeDiscoveryRepository,
  PostgresRuntimeNodeIdentityRepository,
  type PostgresConnection,
} from '@control-plane/database'
import type {
  DeploymentComponentHealth,
  ObjectStore,
  SecretsProvider,
  WorkflowRuntime,
} from '@control-plane/deployment'
import {
  BufferedObservabilityProvider,
  DeploymentProfiles,
  LocalCoordinationProvider,
  StaticServiceDiscovery,
} from '@control-plane/deployment'
import {
  bindRetainedProfileWorkflowWake,
  ExecutionProfiles,
  ProfileAdapterError,
  type BoundProfileWorkflowWake,
  type CurrentProfileWorkflowWakeTopologyGuard,
  type ProfileExecutionGuards,
  type ProfileWorkflowWakeDriver,
  type RetainedProfileWorkflowWakeRecords,
  type TrustedProfilePlacement,
} from '@control-plane/profile-adapters'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  DurableInteractionCommandService,
  DurableExecutionCancellationService,
  DurableInteractionDeliveryService,
  ExecutionReconciliationService,
  type CommandInboxMetrics,
  type ReconciliationEffects,
  type ReconciliationRateLimit,
  type ReconciliationSource,
} from '@control-plane/domain'
import { createConsistencyMetricEmitter } from '@control-plane/telemetry'
import type { MetricAdapter } from '@control-plane/telemetry'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import { decidedRetentionPolicy, retentionClassPolicy } from '@control-plane/config'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { RemoteRestateRuntime, RESTATE_SERVER_VERSION } from '@control-plane/restate-runtime'
import type {
  ExecutionAcceptancePort,
  RemoteControlHostAdapter,
} from '@control-plane/remote-control-relay'
import type { ExecutionWorkflowInput } from '@control-plane/orchestration'
import {
  CompositeSecretsProvider,
  EnvironmentSecretsProvider,
  PrivateFileSecretsProvider,
} from '@control-plane/secrets'
import {
  createRestateEndpointFactory,
  type GraphSegmentActivityPort,
  type RestateEndpointFactory,
  type RestateEndpointHandle,
} from '@control-plane/workflow-runtime'
import { ReconciliationScheduler, RetentionSweep } from '@control-plane/deployment'
import { HostedServerGraphRuntime } from './hosted-graph-runtime.js'
import { createRetainedGraphReconciliationSubmitter } from './reconciliation-workflow-submitter.js'
import {
  parseHostedGraphToolConfiguration,
  type HostedGraphToolConfiguration,
} from './hosted-graph-tool-operations.js'
import {
  DisabledGraphSegmentActivities,
  DurableExecutionLifecycleActivities,
  DurableRuntimeBudgetAdmission,
  DurableRemoteWorkflowRuntime,
  ManagedPiRemoteCommandFactory,
  PollingRemoteRuntimeOutcomeWaiter,
  RuntimeDiscoveryAttemptRouter,
  type WorkflowRuntimeActivityPort,
} from '@control-plane/workflow-worker'

const COMPONENT_VERSION = '1.0.0'
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

/**
 * Explicit authoring policy for the supported hosted default authority. Provider content is
 * composed at the runtime gateway, so the control plane itself never requests provider
 * composition (mode disabled): authoring degrades to the documented no-provider path, and
 * only grants provisioned through the operator administration can authorize context.
 */
const HOSTED_CONTEXT_AUTHORING_POLICY: ContextAuthoringPolicy = {
  allowedSensitivities: ['public', 'internal'],
  allowedCapabilities: ['boundedRetrieval', 'evidenceSearch', 'memoryRecall'],
  executionLocation: 'runtime_node',
  allowedArtifactIds: [],
  permissions: [],
  maximumBytes: 1_048_576,
  maximumTokens: 32_768,
  maximumContextTtlSeconds: 3_600,
  providerPolicy: {
    mode: 'disabled',
    providerIds: [],
    connectionIds: [],
    includeEvidence: false,
    includeMemory: false,
    maximumTokens: 0,
    maximumAgeSeconds: 3_600,
    maximumProviderHealthAgeSeconds: 60,
    maximumLatencyMs: 10_000,
    failureBehavior: 'continue_without',
  },
}

export interface HostedServerManifest {
  readonly schemaVersion: 1
  readonly profile: 'hosted-server'
  readonly version: string
  readonly dataDirectory: string
  readonly components: readonly DeploymentComponentHealth[]
  readonly topology: {
    readonly externalServices: 2
    readonly runtimeTransport: 'remote-gateway' | 'unconfigured'
    readonly restateVersion: string
    readonly persistence: 'postgresql'
    readonly objectStore: 'filesystem' | 's3-compatible'
    readonly remoteControl: 'disabled' | 'outbound'
  }
}

/**
 * Explicit reconciliation-scheduling configuration. Scheduling is opt-in per
 * composition: absent configuration enables nothing, and invalid bounds fail
 * closed at composition construction. Either compose the production observation
 * projection (`projection: 'observation'`) or supply an explicit source and
 * effects pair; the two forms are mutually exclusive.
 */
export interface HostedReconciliationConfiguration {
  /**
   * Composes the production `PostgresReconciliationSource`/`Effects` pair from
   * this composition's own PostgreSQL repositories: bounded stale-candidate
   * scanning, lifecycle-respecting remediation, lost-ACK parking.
   */
  readonly projection?: 'observation'
  readonly source?: ReconciliationSource
  readonly effects?: ReconciliationEffects
  /** Completion-scheduled interval in milliseconds; validated by the scheduler. */
  readonly intervalMs: number
  /** Candidate limit per pass, 1..1_000; validated by the scheduler. */
  readonly batchLimit: number
  readonly staleAfterMs?: number
  readonly rateLimit?: ReconciliationRateLimit
}

/**
 * Explicit authority inputs for the retained Hosted Server wake path. The
 * placement is assembled by the caller from trusted host/runtime records;
 * both guards must re-read current authority and placement on every wake.
 * This does not supply a production actor or residency source by itself.
 */
export interface HostedProfileWorkflowWakeConfiguration {
  readonly placement: TrustedProfilePlacement
  readonly guards: ProfileExecutionGuards
}

export interface HostedServerCompositionOptions {
  readonly memoryWriteback?: MemoryWriteApplicationConfiguration
  readonly contextAuthoring?: ContextAuthoringCompositionOptions
  readonly dataDirectory: string
  readonly databaseUrl: string
  readonly restateAdminUrl?: string
  /**
   * Optional catalog approval policy (#188): when required, resolution,
   * validation, and new execution acceptance require approved, version-bound
   * catalog pins. Absent leaves approval enforcement unchanged.
   */
  readonly catalogApprovalPolicy?: { readonly required: boolean; readonly requiredSince?: string }
  /**
   * Optional harness pin for attempt routing (M12/#670): when set, routing
   * attempts must select a runtime exposing this harness or fail closed with
   * HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME.
   */
  readonly pinnedHarnessId?: string
  /**
   * Optional per-model harness map (M12/#678): the deployment maps a model id
   * to the harness id that must serve it. When the map is present it is a
   * policy, not a fallback: an execution whose model is absent from the map,
   * or which carries no model at all, is denied instead of being routed to
   * another harness. Absent leaves routing exactly as it is today.
   */
  readonly harnessByModel?: Readonly<Record<string, string>>
  readonly restateIngressUrl?: string
  readonly workflowDeploymentUri?: string
  readonly workflowEndpointPort?: number
  readonly requestIdentityPublicKey?: string
  readonly endpointFactory?: RestateEndpointFactory
  readonly connection?: PostgresConnection
  readonly secrets?: SecretsProvider
  readonly workflowRuntime?: WorkflowRuntime
  readonly objectStore?: ObjectStore
  readonly objectStoreKind?: 'filesystem' | 's3-compatible'
  readonly remoteControl?: RemoteControlHostAdapter<unknown>
  readonly remoteControlFactory?: (
    acceptance: ExecutionAcceptancePort
  ) => RemoteControlHostAdapter<unknown>
  readonly runtimeActivityPort?: WorkflowRuntimeActivityPort
  readonly graphActivities?: GraphSegmentActivityPort
  /** Enables the Hosted PostgreSQL graph/tool authority path; disabled by default. */
  readonly hostedGraphEnabled?: boolean
  /** Required operator-owned graph tool IDs, publication timestamps, and tariff. */
  readonly hostedGraphToolConfiguration?: HostedGraphToolConfiguration
  readonly metricAdapter?: MetricAdapter
  readonly reconciliation?: HostedReconciliationConfiguration
  /** Opts acceptance and reconciliation submissions into retained wake guards. */
  readonly profileWorkflowWake?: HostedProfileWorkflowWakeConfiguration
  /** Retention sweep cadence override; defaults to one hour. */
  readonly retentionSweepIntervalMs?: number
}

export class HostedServerControlPlaneComposition {
  readonly memoryWrites: MemoryWriteApplication
  readonly dataDirectory: string
  readonly connection: PostgresConnection
  readonly objectStore: ObjectStore
  readonly secrets: SecretsProvider
  readonly workflow: WorkflowRuntime
  readonly remoteControl: RemoteControlHostAdapter<unknown> | undefined
  readonly coordination = new LocalCoordinationProvider()
  readonly observability = new BufferedObservabilityProvider()
  readonly discovery: StaticServiceDiscovery
  readonly executionAcceptanceService: DurableExecutionAcceptanceService
  readonly interactionCommandService: DurableInteractionCommandService
  readonly executionCancellationService: DurableExecutionCancellationService
  readonly graphAdministrationService: RepositoryGraphAdministrationService
  readonly executionValidationService: DurableExecutionValidationService
  readonly profileResolutionService: RepositoryProfileResolutionService
  readonly projectStateResolutionService: RepositoryProjectStateResolutionService
  readonly projectStateInitializationService: RepositoryProjectStateInitializationService
  readonly contextPackageResolutionService: RepositoryContextPackageResolutionService
  readonly runtimeDiscoveryRepository: PostgresRuntimeDiscoveryRepository
  readonly runtimeNodeCredentialRevocationService: RepositoryRuntimeNodeCredentialRevocationService
  readonly runtimeActivityPort: WorkflowRuntimeActivityPort
  readonly executionLifecycleActivities: DurableExecutionLifecycleActivities
  readonly runtimeAttemptRouter: RuntimeDiscoveryAttemptRouter
  readonly reconciliationService: ExecutionReconciliationService | undefined
  /** The composed observation source, exposed so the wiring is externally verifiable. */
  readonly reconciliationSource: ReconciliationSource | undefined
  /** The composed remediation effects, exposed so the wiring is externally verifiable. */
  readonly reconciliationEffects: ReconciliationEffects | undefined
  readonly #endpointFactory: RestateEndpointFactory
  readonly #objectStoreKind: 'filesystem' | 's3-compatible'
  readonly #hostedGraphRuntime: HostedServerGraphRuntime | undefined
  readonly #reconciliationScheduler: ReconciliationScheduler | undefined
  readonly #profileWorkflowWakeConfiguration: HostedProfileWorkflowWakeConfiguration | undefined
  readonly #profileWorkflowWakeDriver: ProfileWorkflowWakeDriver | undefined
  readonly #profileWorkflowWakeTopology: CurrentProfileWorkflowWakeTopologyGuard | undefined
  readonly #retainedProfileWorkflowWakeRecords: RetainedProfileWorkflowWakeRecords | undefined
  #profileWorkflowWake: BoundProfileWorkflowWake | undefined
  readonly #retentionSweep: RetentionSweep | undefined
  #endpoint: RestateEndpointHandle | undefined
  #started = false
  #starting: Promise<void> | undefined
  #closing: Promise<void> | undefined
  #closed = false

  constructor(options: HostedServerCompositionOptions) {
    const memoryWriteback = resolveMemoryWriteConfiguration(options.memoryWriteback)
    if (
      options.endpointFactory === undefined &&
      !/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(options.requestIdentityPublicKey ?? '')
    ) {
      throw new Error('HOSTED_RESTATE_REQUEST_IDENTITY_REQUIRED')
    }
    if (options.hostedGraphEnabled === true && options.hostedGraphToolConfiguration === undefined) {
      throw new Error('HOSTED_GRAPH_TOOL_CONFIG_REQUIRED')
    }
    if (options.hostedGraphEnabled === true) {
      parseHostedGraphToolConfiguration(options.hostedGraphToolConfiguration)
    }
    this.#profileWorkflowWakeConfiguration = options.profileWorkflowWake
    this.dataDirectory = resolve(options.dataDirectory)
    this.connection =
      options.connection ??
      createPostgresConnection(
        { role: 'application', url: options.databaseUrl },
        { maxConnections: 10 }
      )
    if (options.objectStore === undefined && options.objectStoreKind === 's3-compatible') {
      throw new Error('HOSTED_OBJECT_STORE_CONFIGURATION_INVALID')
    }
    this.objectStore =
      options.objectStore ??
      new FilesystemObjectStore({
        rootDirectory: join(this.dataDirectory, 'artifacts'),
        maxObjectBytes: MAX_ARTIFACT_BYTES,
      })
    this.#objectStoreKind = options.objectStoreKind ?? 'filesystem'
    if (options.hostedGraphEnabled === true && options.graphActivities !== undefined) {
      throw new Error('HOSTED_GRAPH_ACTIVITY_CONFIGURATION_CONFLICT')
    }
    this.secrets =
      options.secrets ??
      new CompositeSecretsProvider({
        env: new EnvironmentSecretsProvider({ references: {} }),
        file: new PrivateFileSecretsProvider({
          rootDirectory: join(this.dataDirectory, 'secrets'),
        }),
      })
    const restateIngressUrl = options.restateIngressUrl ?? 'http://restate:8080'
    const workflowEndpointPort = options.workflowEndpointPort ?? 9080
    this.workflow =
      options.workflowRuntime ??
      new RemoteRestateRuntime({
        profile: 'hosted-server',
        adminUrl: options.restateAdminUrl ?? 'http://restate:9070',
        ingressUrl: restateIngressUrl,
        deploymentUri:
          options.workflowDeploymentUri ?? `http://control-plane-server:${workflowEndpointPort}`,
      })
    const workflowDispatcher = new RestateExecutionWorkflowDispatcher({
      ingressUrl: restateIngressUrl,
    })
    this.#profileWorkflowWakeDriver =
      this.#profileWorkflowWakeConfiguration === undefined
        ? undefined
        : Object.freeze({
            deploymentProfile: DeploymentProfiles.hostedServer,
            kind: 'restate-ingress',
            submit: (input: ExecutionWorkflowInput) => workflowDispatcher.submit(input),
          })
    this.#profileWorkflowWakeTopology =
      this.#profileWorkflowWakeDriver === undefined
        ? undefined
        : {
            assertCurrent: async (context, candidate) => {
              if (
                candidate !== this.#profileWorkflowWakeDriver ||
                context.profile !== ExecutionProfiles.selfHosted ||
                context.deploymentProfile !== this.workflow.profile ||
                context.expectedWakeKind !== 'restate-ingress'
              ) {
                throw new ProfileAdapterError('PROFILE_WAKE_MISMATCH')
              }
            },
          }
    // Consistency metrics flow through the telemetry redaction pipeline with bounded
    // label cardinality; without an injected metric adapter every hook is a no-op.
    const consistencyMetrics =
      options.metricAdapter === undefined
        ? undefined
        : createConsistencyMetricEmitter(options.metricAdapter, 'hosted-control-plane')
    const inboxMetrics: CommandInboxMetrics | undefined = consistencyMetrics
    this.graphAdministrationService = new RepositoryGraphAdministrationService({
      repository: (workspaceId) =>
        new PostgresGraphDefinitionRepository(this.connection.database, workspaceId),
    })
    const plans = new PostgresExecutionPlanRepository(this.connection.database)
    const executions = new PostgresExecutionRepository(this.connection.database)
    const acceptanceCommands = new PostgresCommandAcceptanceRepository(this.connection.database, {
      budgetAdmission: true,
    })
    this.#retainedProfileWorkflowWakeRecords =
      this.#profileWorkflowWakeConfiguration === undefined
        ? undefined
        : {
            commands: {
              getByExecutionId: (executionId) => acceptanceCommands.getByExecutionId(executionId),
              getExecution: (executionId) => executions.getExecution(executionId),
            },
            executions,
            plans,
          }
    const workflowSubmitter =
      this.#profileWorkflowWakeConfiguration === undefined
        ? workflowDispatcher
        : {
            submit: async (input: ExecutionWorkflowInput) => {
              if (this.#profileWorkflowWake === undefined) {
                throw new Error('HOSTED_PROFILE_WORKFLOW_WAKE_NOT_BOUND')
              }
              await this.#profileWorkflowWake.submit(input)
            },
          }
    const catalog = new PostgresCatalogRepository(this.connection.database)
    const catalogApprovals = new PostgresCatalogApprovalRepository(this.connection.database)
    const projectStates = new PostgresProjectStateRepository(this.connection.database)
    const contextPackages = new PostgresContextPackageRepository(this.connection.database)
    this.#hostedGraphRuntime =
      options.hostedGraphEnabled === true
        ? new HostedServerGraphRuntime({
            database: this.connection.database,
            databaseUrl: options.databaseUrl,
            objectStore: this.objectStore,
            configuration: parseHostedGraphToolConfiguration(options.hostedGraphToolConfiguration),
          })
        : undefined
    const executionPlanValidatorOptions = {
      catalog: { profiles: catalog, skills: catalog },
      ...(this.#hostedGraphRuntime === undefined
        ? {}
        : { graphs: this.#hostedGraphRuntime.authority }),
      ...(options.catalogApprovalPolicy === undefined
        ? {}
        : {
            approvalGate: {
              approvals: catalogApprovals,
              policy: options.catalogApprovalPolicy,
            },
          }),
    }
    this.executionAcceptanceService = new DurableExecutionAcceptanceService({
      plans,
      commands: new CommandInboxService({
        repository: acceptanceCommands,
        executionIdFactory: createExecutionId,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(
          plans,
          executionPlanValidatorOptions
        ),
        ...(inboxMetrics === undefined ? {} : { metrics: inboxMetrics }),
      }),
      dispatcher: workflowSubmitter,
    })
    if (options.remoteControl !== undefined && options.remoteControlFactory !== undefined) {
      throw new Error('HOSTED_REMOTE_CONTROL_CONFIGURATION_CONFLICT')
    }
    this.remoteControl =
      options.remoteControl ?? options.remoteControlFactory?.(this.executionAcceptanceService)
    // The supported default authorizes authoring from this composition's own PostgreSQL
    // grant and registration stores; an explicit injection always takes precedence.
    const contextAuthoring =
      options.contextAuthoring ??
      ({
        authority: new GrantsBackedContextAuthoringAuthority({
          grants: new PostgresContextCommandGrantRepository(this.connection.database),
          registrations: new PostgresContextProviderRegistrationRepository(
            this.connection.database
          ),
          artifacts: this.objectStore,
          policy: HOSTED_CONTEXT_AUTHORING_POLICY,
        }),
      } satisfies ContextAuthoringCompositionOptions)
    this.executionValidationService = new DurableExecutionValidationService({
      compilerVersion: COMPONENT_VERSION,
      contextPackages,
      commands: new PostgresExecutionValidationCommandRepository(this.connection.database),
      contextAuthoring: new ContextPackageAuthoringService({
        compilerVersion: COMPONENT_VERSION,
        packages: contextPackages,
        projectStates,
        commands: new PostgresContextAuthoringCommandRepository(this.connection.database),
        authority: contextAuthoring.authority,
        ...(contextAuthoring.providerResolver === undefined
          ? {}
          : {
              providerResolver: contextAuthoring.providerResolver,
            }),
        now: contextAuthoring.now ?? (() => new Date()),
      }),
      profiles: catalog,
      projectStates,
      skills: catalog,
      ...(this.#hostedGraphRuntime === undefined
        ? {}
        : { graphs: this.#hostedGraphRuntime.authority }),
      ...(options.catalogApprovalPolicy === undefined
        ? {}
        : {
            approvalGate: {
              approvals: catalogApprovals,
              policy: options.catalogApprovalPolicy,
            },
          }),
    })
    this.profileResolutionService = new RepositoryProfileResolutionService(
      catalog,
      options.catalogApprovalPolicy === undefined
        ? undefined
        : {
            approvals: catalogApprovals,
            skills: catalog,
            policy: options.catalogApprovalPolicy,
          }
    )
    this.projectStateResolutionService = new RepositoryProjectStateResolutionService(projectStates)
    this.projectStateInitializationService = new RepositoryProjectStateInitializationService(
      projectStates
    )
    this.contextPackageResolutionService = new RepositoryContextPackageResolutionService(
      contextPackages
    )
    this.runtimeDiscoveryRepository = new PostgresRuntimeDiscoveryRepository(
      this.connection.database
    )
    this.runtimeNodeCredentialRevocationService =
      new RepositoryRuntimeNodeCredentialRevocationService({
        repository: new PostgresRuntimeNodeIdentityRepository(this.connection.database),
      })
    const runtimeCommands = new PostgresRuntimeCommandRepository(this.connection.database)
    const executionEvents = new PostgresExecutionEventRepository(this.connection.database)
    const interactions = new PostgresInteractionRepository(this.connection.database)
    this.memoryWrites = createMemoryWriteApplication({
      repository: new PostgresMemoryWriteProposalRepository(this.connection.database),
      interactionRepository: interactions,
      configuration: memoryWriteback,
      ...(consistencyMetrics === undefined ? {} : { metrics: consistencyMetrics }),
    })
    this.interactionCommandService = new DurableInteractionCommandService(
      new PostgresInteractionCommandRepository(this.connection.database),
      new DurableInteractionDeliveryService(
        interactions,
        new PostgresCommandAcceptanceRepository(this.connection.database),
        new RestateExecutionWorkflowDispatcher({ ingressUrl: restateIngressUrl })
      )
    )
    this.executionCancellationService = new DurableExecutionCancellationService(
      new PostgresExecutionCancellationRepository(this.connection.database),
      new PostgresCommandAcceptanceRepository(this.connection.database),
      new RestateExecutionWorkflowDispatcher({ ingressUrl: restateIngressUrl })
    )
    this.runtimeActivityPort =
      options.runtimeActivityPort ??
      new DurableRemoteWorkflowRuntime({
        attempts: executions,
        commands: runtimeCommands,
        factory: new ManagedPiRemoteCommandFactory({
          contextPackages,
          executions,
          interactions,
          runtimeDiscovery: {
            getRuntimeConnection: ({ runtimeConnectionId, ...scope }) =>
              this.runtimeDiscoveryRepository.getRuntimeConnection(scope, runtimeConnectionId),
          },
        }),
        waiter: new PollingRemoteRuntimeOutcomeWaiter({
          executions,
          commands: runtimeCommands,
          events: executionEvents,
        }),
      })
    this.runtimeAttemptRouter = new RuntimeDiscoveryAttemptRouter({
      discovery: this.runtimeDiscoveryRepository,
      ...(options.pinnedHarnessId === undefined
        ? {}
        : { pinnedHarnessId: options.pinnedHarnessId }),
      // The per-model map is a deployment policy, not a fallback. It is handed
      // to the real router unchanged: a map that does not name the execution's
      // model denies the attempt rather than routing it to another harness.
      ...(options.harnessByModel === undefined ? {} : { harnessByModel: options.harnessByModel }),
    })
    const activities = new DurableExecutionLifecycleActivities({
      lifecycle: new ExecutionLifecycleService(executions),
      plans,
      runtime: this.runtimeActivityPort,
      graph:
        this.#hostedGraphRuntime?.activities ??
        options.graphActivities ??
        new DisabledGraphSegmentActivities(),
      runtimeRouter: this.runtimeAttemptRouter,
      budgetAdmission: new DurableRuntimeBudgetAdmission({
        store: new PostgresDurableUsageStore(this.connection.database),
        commands: new PostgresCommandAcceptanceRepository(this.connection.database, {
          budgetAdmission: true,
        }),
      }),
      commands: new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(this.connection.database, {
          budgetAdmission: true,
        }),
        executionIdFactory: unavailableExecutionIdFactory,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(
          plans,
          executionPlanValidatorOptions
        ),
        ...(inboxMetrics === undefined ? {} : { metrics: inboxMetrics }),
      }),
    })
    this.executionLifecycleActivities = activities
    const retentionPolicy = decidedRetentionPolicy
    const commandInboxRepository = new PostgresCommandAcceptanceRepository(this.connection.database)
    const executionEventRepository = new PostgresExecutionEventRepository(this.connection.database)
    this.#retentionSweep = new RetentionSweep({
      assessCommandInbox: (now) =>
        commandInboxRepository.assessExpiredInbox(now, {
          policyRetainMs: retentionClassPolicy(retentionPolicy, 'command-inbox').retainMs,
        }),
      assessExecutionEvents: (now) =>
        executionEventRepository.assessExpiredEvents(now, {
          policyRetainMs: retentionClassPolicy(retentionPolicy, 'execution-events').retainMs,
        }),
      intervalMs: options.retentionSweepIntervalMs ?? 3_600_000,
      onReport: (report) => {
        const level =
          report.assessment.commandInbox.eligible > 0 ||
          report.assessment.executionEvents.eligible > 0
            ? 'warn'
            : 'info'
        const output = JSON.stringify({
          level,
          event: 'retention.sweep',
          commandInbox: report.assessment.commandInbox,
          executionEvents: report.assessment.executionEvents,
        })
        if (level === 'warn') console.warn(output)
        else console.info(output)
      },
    })
    // Reconciliation scheduling is explicit composition configuration: absent
    // configuration enables nothing, and invalid bounds fail closed above.
    // `projection: 'observation'` composes the production adapters over this
    // composition's own PostgreSQL repositories.
    if (options.reconciliation !== undefined) {
      const reconciliation = options.reconciliation
      if (
        reconciliation.projection !== undefined &&
        (reconciliation.source !== undefined || reconciliation.effects !== undefined)
      ) {
        throw new Error('HOSTED_RECONCILIATION_CONFIGURATION_CONFLICT')
      }
      if (
        reconciliation.projection === undefined &&
        (reconciliation.source === undefined || reconciliation.effects === undefined)
      ) {
        throw new Error('HOSTED_RECONCILIATION_CONFIGURATION_INVALID')
      }
      const commandAcceptance = new PostgresCommandAcceptanceRepository(this.connection.database)
      const cancellations = new PostgresExecutionCancellationRepository(this.connection.database)
      const source =
        reconciliation.source ??
        new PostgresReconciliationSource({
          executions,
          runtimeCommands,
          runtimeConnections: new PostgresRuntimeConnectionRepository(this.connection.database),
          commands: commandAcceptance,
          events: executionEvents,
        })
      const effects =
        reconciliation.effects ??
        new PostgresReconciliationEffects({
          executions,
          commands: commandAcceptance,
          events: executionEvents,
          workflowSubmitter:
            this.#profileWorkflowWakeConfiguration === undefined
              ? workflowSubmitter
              : (() => {
                  const withRetainedGraph = createRetainedGraphReconciliationSubmitter({
                    plans,
                    submitter: workflowSubmitter,
                  })
                  return {
                    submit: async (input: ExecutionWorkflowInput) => {
                      // An unbound wake refuses before the plan is read.
                      if (this.#profileWorkflowWake === undefined) {
                        throw new Error('HOSTED_PROFILE_WORKFLOW_WAKE_NOT_BOUND')
                      }
                      await withRetainedGraph.submit(input)
                    },
                  }
                })(),
          cancellations,
        })
      this.reconciliationService = new ExecutionReconciliationService({
        repository: new PostgresReconciliationCheckpointRepository(this.connection.database),
        source,
        effects,
        ...(reconciliation.staleAfterMs === undefined
          ? {}
          : { policy: { staleAfterMs: reconciliation.staleAfterMs } }),
        ...(reconciliation.rateLimit === undefined ? {} : { rateLimit: reconciliation.rateLimit }),
        ...(consistencyMetrics === undefined ? {} : { metrics: consistencyMetrics }),
      })
      this.reconciliationSource = source
      this.reconciliationEffects = effects
      this.#reconciliationScheduler = new ReconciliationScheduler({
        service: this.reconciliationService,
        intervalMs: reconciliation.intervalMs,
        batchLimit: reconciliation.batchLimit,
      })
    }
    this.#endpointFactory =
      options.endpointFactory ??
      createRestateEndpointFactory({
        host: '0.0.0.0',
        port: workflowEndpointPort,
        activities,
        ...(options.requestIdentityPublicKey === undefined
          ? {}
          : { requestIdentityPublicKey: options.requestIdentityPublicKey }),
      })
    this.discovery = new StaticServiceDiscovery([
      { service: 'postgresql', url: databaseServiceUrl(options.databaseUrl), private: true },
      { service: 'restate', url: new URL(restateIngressUrl), private: true },
      {
        service: 'workflow-runtime',
        url: new URL(
          options.workflowDeploymentUri ?? `http://control-plane-server:${workflowEndpointPort}`
        ),
        private: true,
      },
    ])
  }

  /** Workspace catalog API over the hosted PostgreSQL catalog; audit events use `logger`. */
  createWorkspaceCatalogService(logger: StructuredLogger): RepositoryWorkspaceCatalogService {
    return new RepositoryWorkspaceCatalogService({
      catalog: new PostgresCatalogRepository(this.connection.database),
      commands: new PostgresWorkspaceCatalogCommandRepository(this.connection.database),
      logger,
    })
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('HOSTED_CONTROL_PLANE_CLOSED'))
    if (this.#started || this.#starting !== undefined) {
      return Promise.reject(new Error('HOSTED_CONTROL_PLANE_ALREADY_STARTED'))
    }
    this.#starting = this.#start().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  #assertStartupOpen(): void {
    if (this.#closed) throw new Error('HOSTED_CONTROL_PLANE_CLOSED')
  }

  async #start(): Promise<void> {
    this.#profileWorkflowWake = undefined
    try {
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
      this.#assertStartupOpen()
      await this.connection.check()
      this.#assertStartupOpen()
      if (this.#profileWorkflowWakeConfiguration !== undefined) {
        const driver = this.#profileWorkflowWakeDriver
        const topology = this.#profileWorkflowWakeTopology
        const retainedRecords = this.#retainedProfileWorkflowWakeRecords
        if (driver === undefined || topology === undefined || retainedRecords === undefined) {
          throw new Error('HOSTED_PROFILE_WORKFLOW_WAKE_CONFIGURATION_INVALID')
        }
        const wake = await bindRetainedProfileWorkflowWake({
          profile: ExecutionProfiles.selfHosted,
          deployment: {
            profile: DeploymentProfiles.hostedServer,
            persistence: { profile: DeploymentProfiles.hostedServer, dialect: 'postgresql' },
            workflow: this.workflow,
          },
          driver,
          placement: this.#profileWorkflowWakeConfiguration.placement,
          guards: this.#profileWorkflowWakeConfiguration.guards,
          topology,
          retainedRecords,
        })
        this.#assertStartupOpen()
        this.#profileWorkflowWake = wake
      }
      await this.#hostedGraphRuntime?.start()
      this.#assertStartupOpen()
      this.#endpoint = await this.#endpointFactory.create()
      this.#assertStartupOpen()
      await this.#endpoint.run()
      this.#assertStartupOpen()
      await this.workflow.start()
      this.#assertStartupOpen()
      await this.remoteControl?.start()
      this.#assertStartupOpen()
      this.#retentionSweep?.start()
      this.#reconciliationScheduler?.start()
      this.#started = true
      this.observability.record({
        name: 'hosted-server-started',
        occurredAt: new Date().toISOString(),
        attributes: { profile: 'hosted-server' },
      })
    } catch (error) {
      this.#profileWorkflowWake = undefined
      this.#started = false
      const cleanup: Array<() => Promise<unknown> | void> = [
        () => this.#reconciliationScheduler?.close(),
        () => this.#retentionSweep?.close(),
        () => this.remoteControl?.stop(),
        () => this.workflow.stop(),
        () => this.#endpoint?.shutdown(),
        () => this.#hostedGraphRuntime?.close(),
      ]
      for (const release of cleanup) {
        try {
          await release()
        } catch {
          // Cleanup is best-effort here; preserve the startup error and try all owners.
        }
      }
      this.#endpoint = undefined
      throw error
    }
  }

  async manifest(): Promise<HostedServerManifest> {
    let databaseReady = true
    try {
      await this.connection.check()
    } catch {
      databaseReady = false
    }
    const components = await Promise.all([
      Promise.resolve({
        ready: databaseReady,
        component: 'postgresql-persistence',
        version: '18',
        details: { profile: 'hosted-server' },
      }),
      this.workflow.health(),
      this.secrets.health(),
      this.observability.health(),
      ...(this.remoteControl === undefined ? [] : [this.remoteControl.health()]),
    ])
    return {
      schemaVersion: 1,
      profile: 'hosted-server',
      version: COMPONENT_VERSION,
      dataDirectory: this.dataDirectory,
      components,
      topology: {
        externalServices: 2,
        runtimeTransport: 'remote-gateway',
        restateVersion: RESTATE_SERVER_VERSION,
        persistence: 'postgresql',
        objectStore: this.#objectStoreKind,
        remoteControl: this.remoteControl === undefined ? 'disabled' : 'outbound',
      },
    }
  }

  close(): Promise<void> {
    this.#closed = true
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    // Startup owns its failure cleanup; it must never wait for this close.
    // Drain it first so late acquisitions are released before storage closes.
    await this.#starting?.catch(() => undefined)
    this.#started = false
    let closeError: unknown
    let failed = false
    const release = async (action: () => Promise<unknown> | void): Promise<void> => {
      try {
        await action()
      } catch (error) {
        if (!failed) {
          closeError = error
          failed = true
        }
      }
    }
    try {
      // Attempt every release even if one owner fails; preserve the first error.
      await release(async () => {
        try {
          await this.#reconciliationScheduler?.close()
        } finally {
          this.#profileWorkflowWake = undefined
        }
      })
      await release(() => this.#retentionSweep?.close())
      await release(() => this.remoteControl?.stop())
      await release(() => this.workflow.stop())
      await release(() => this.#endpoint?.shutdown())
      this.#endpoint = undefined
      await release(() => this.#hostedGraphRuntime?.close())
      await release(() => this.secrets.close())
      await release(() => this.objectStore.close())
      await release(() => this.connection.close())
      await release(() => this.coordination.close())
      await release(() => this.observability.close())
    } finally {
      this.#profileWorkflowWake = undefined
    }
    if (failed) throw closeError
  }
}

function unavailableExecutionIdFactory(): never {
  throw new Error('WORKFLOW_ENDPOINT_CANNOT_ACCEPT_EXECUTIONS')
}

function databaseServiceUrl(value: string): URL {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  url.search = ''
  return url
}
