import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ContextPackageAuthoringService,
  type ContextAuthoringCompositionOptions,
} from '@control-plane/context'
import {
  DurableExecutionAcceptanceService,
  DurableExecutionValidationService,
  RestateExecutionWorkflowDispatcher,
  RepositoryProfileResolutionService,
  RepositoryProjectStateResolutionService,
  RepositoryContextPackageResolutionService,
  createExecutionId,
} from '@control-plane/control-api'
import {
  createPostgresConnection,
  PostgresCatalogRepository,
  PostgresCommandAcceptanceRepository,
  PostgresContextPackageRepository,
  PostgresContextAuthoringCommandRepository,
  PostgresExecutionEventRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionValidationCommandRepository,
  PostgresExecutionRepository,
  PostgresInteractionRepository,
  PostgresInteractionCommandRepository,
  PostgresExecutionCancellationRepository,
  PostgresProjectStateRepository,
  PostgresRuntimeCommandRepository,
  PostgresRuntimeDiscoveryRepository,
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
  LocalCoordinationProvider,
  NodeProcessRuntimeProvider,
  StaticServiceDiscovery,
} from '@control-plane/deployment'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  DurableInteractionCommandService,
  DurableExecutionCancellationService,
  DurableInteractionDeliveryService,
} from '@control-plane/domain'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { RemoteRestateRuntime, RESTATE_SERVER_VERSION } from '@control-plane/restate-runtime'
import type {
  ExecutionAcceptancePort,
  RemoteControlHostAdapter,
} from '@control-plane/remote-control-relay'
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
import {
  DisabledGraphSegmentActivities,
  DurableExecutionLifecycleActivities,
  DurableRemoteWorkflowRuntime,
  ManagedPiRemoteCommandFactory,
  PollingRemoteRuntimeOutcomeWaiter,
  RuntimeDiscoveryAttemptRouter,
  type WorkflowRuntimeActivityPort,
} from '@control-plane/workflow-worker'

const COMPONENT_VERSION = '1.0.0'
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

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

export interface HostedServerCompositionOptions {
  readonly contextAuthoring?: ContextAuthoringCompositionOptions
  readonly dataDirectory: string
  readonly databaseUrl: string
  readonly restateAdminUrl?: string
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
}

export class HostedServerControlPlaneComposition {
  readonly dataDirectory: string
  readonly connection: PostgresConnection
  readonly objectStore: ObjectStore
  readonly secrets: SecretsProvider
  readonly workflow: WorkflowRuntime
  readonly remoteControl: RemoteControlHostAdapter<unknown> | undefined
  readonly coordination = new LocalCoordinationProvider()
  readonly processes = new NodeProcessRuntimeProvider()
  readonly observability = new BufferedObservabilityProvider()
  readonly discovery: StaticServiceDiscovery
  readonly executionAcceptanceService: DurableExecutionAcceptanceService
  readonly interactionCommandService: DurableInteractionCommandService
  readonly executionCancellationService: DurableExecutionCancellationService
  readonly executionValidationService: DurableExecutionValidationService
  readonly profileResolutionService: RepositoryProfileResolutionService
  readonly projectStateResolutionService: RepositoryProjectStateResolutionService
  readonly contextPackageResolutionService: RepositoryContextPackageResolutionService
  readonly runtimeDiscoveryRepository: PostgresRuntimeDiscoveryRepository
  readonly runtimeActivityPort: WorkflowRuntimeActivityPort
  readonly executionLifecycleActivities: DurableExecutionLifecycleActivities
  readonly runtimeAttemptRouter: RuntimeDiscoveryAttemptRouter
  readonly #endpointFactory: RestateEndpointFactory
  readonly #objectStoreKind: 'filesystem' | 's3-compatible'
  #endpoint: RestateEndpointHandle | undefined
  #started = false

  constructor(options: HostedServerCompositionOptions) {
    if (
      options.endpointFactory === undefined &&
      !/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(options.requestIdentityPublicKey ?? '')
    ) {
      throw new Error('HOSTED_RESTATE_REQUEST_IDENTITY_REQUIRED')
    }
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
    this.secrets =
      options.secrets ??
      new CompositeSecretsProvider({
        env: new EnvironmentSecretsProvider({ references: {} }),
        file: new PrivateFileSecretsProvider({
          rootDirectory: join(this.dataDirectory, 'secrets'),
        }),
      })
    const restateIngressUrl = options.restateIngressUrl ?? 'http://restate:8080'
    const plans = new PostgresExecutionPlanRepository(this.connection.database)
    const catalog = new PostgresCatalogRepository(this.connection.database)
    const projectStates = new PostgresProjectStateRepository(this.connection.database)
    const contextPackages = new PostgresContextPackageRepository(this.connection.database)
    this.executionAcceptanceService = new DurableExecutionAcceptanceService({
      commands: new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(this.connection.database),
        executionIdFactory: createExecutionId,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans),
      }),
      dispatcher: new RestateExecutionWorkflowDispatcher({ ingressUrl: restateIngressUrl }),
    })
    if (options.remoteControl !== undefined && options.remoteControlFactory !== undefined) {
      throw new Error('HOSTED_REMOTE_CONTROL_CONFIGURATION_CONFLICT')
    }
    this.remoteControl =
      options.remoteControl ?? options.remoteControlFactory?.(this.executionAcceptanceService)
    this.executionValidationService = new DurableExecutionValidationService({
      compilerVersion: COMPONENT_VERSION,
      contextPackages,
      commands: new PostgresExecutionValidationCommandRepository(this.connection.database),
      ...(options.contextAuthoring === undefined
        ? {}
        : {
            contextAuthoring: new ContextPackageAuthoringService({
              compilerVersion: COMPONENT_VERSION,
              packages: contextPackages,
              projectStates,
              commands: new PostgresContextAuthoringCommandRepository(this.connection.database),
              authority: options.contextAuthoring.authority,
              ...(options.contextAuthoring.providerResolver === undefined
                ? {}
                : {
                    providerResolver: options.contextAuthoring.providerResolver,
                  }),
              now: options.contextAuthoring.now ?? (() => new Date()),
            }),
          }),
      profiles: catalog,
      projectStates,
      skills: catalog,
    })
    this.profileResolutionService = new RepositoryProfileResolutionService(catalog)
    this.projectStateResolutionService = new RepositoryProjectStateResolutionService(projectStates)
    this.contextPackageResolutionService = new RepositoryContextPackageResolutionService(
      contextPackages
    )
    this.runtimeDiscoveryRepository = new PostgresRuntimeDiscoveryRepository(
      this.connection.database
    )
    const executions = new PostgresExecutionRepository(this.connection.database)
    const runtimeCommands = new PostgresRuntimeCommandRepository(this.connection.database)
    const executionEvents = new PostgresExecutionEventRepository(this.connection.database)
    const interactions = new PostgresInteractionRepository(this.connection.database)
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
    })
    const activities = new DurableExecutionLifecycleActivities({
      lifecycle: new ExecutionLifecycleService(executions),
      plans,
      runtime: this.runtimeActivityPort,
      graph: options.graphActivities ?? new DisabledGraphSegmentActivities(),
      runtimeRouter: this.runtimeAttemptRouter,
      commands: new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(this.connection.database),
        executionIdFactory: unavailableExecutionIdFactory,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans),
      }),
    })
    this.executionLifecycleActivities = activities
    const workflowEndpointPort = options.workflowEndpointPort ?? 9080
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
    this.workflow =
      options.workflowRuntime ??
      new RemoteRestateRuntime({
        profile: 'hosted-server',
        adminUrl: options.restateAdminUrl ?? 'http://restate:9070',
        ingressUrl: restateIngressUrl,
        deploymentUri:
          options.workflowDeploymentUri ?? `http://control-plane-server:${workflowEndpointPort}`,
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

  async start(): Promise<void> {
    if (this.#started) throw new Error('HOSTED_CONTROL_PLANE_ALREADY_STARTED')
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
    await this.connection.check()
    this.#endpoint = await this.#endpointFactory.create()
    await this.#endpoint.run()
    try {
      await this.workflow.start()
      await this.remoteControl?.start()
    } catch (error) {
      await this.remoteControl?.stop()
      await this.workflow.stop().catch(() => undefined)
      await this.#endpoint.shutdown().catch(() => undefined)
      this.#endpoint = undefined
      throw error
    }
    this.#started = true
    this.observability.record({
      name: 'hosted-server-started',
      occurredAt: new Date().toISOString(),
      attributes: { profile: 'hosted-server' },
    })
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

  async close(): Promise<void> {
    this.#started = false
    await this.remoteControl?.stop()
    await this.workflow.stop().catch(() => undefined)
    await this.#endpoint?.shutdown().catch(() => undefined)
    this.#endpoint = undefined
    await this.secrets.close()
    await this.objectStore.close()
    await this.connection.close()
    this.coordination.close()
    this.observability.close()
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
