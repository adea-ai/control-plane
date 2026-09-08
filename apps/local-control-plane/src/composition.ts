import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  DeploymentComponentHealth,
  ObjectStore,
  ProcessRuntimeProvider,
  SecretsProvider,
  WorkflowRuntime,
} from '@control-plane/deployment'
import {
  BufferedObservabilityProvider,
  LocalCoordinationProvider,
  NodeProcessRuntimeProvider,
  StaticServiceDiscovery,
} from '@control-plane/deployment'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { LocalRestateRuntime, RESTATE_SERVER_VERSION } from '@control-plane/restate-runtime'
import type {
  ExecutionAcceptancePort,
  RemoteControlHostAdapter,
} from '@control-plane/remote-control-relay'
import {
  UnavailableExecutionAcceptanceService,
  type ExecutionAcceptanceService,
} from '@control-plane/control-api'
import type { RuntimeAdapterWithTransport } from '@control-plane/runtime-sdk'
import {
  CompositeSecretsProvider,
  EnvironmentSecretsProvider,
  PrivateFileSecretsProvider,
} from '@control-plane/secrets'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  createRestateEndpointFactory,
  type ExecutionLifecycleActivities,
  type GraphSegmentActivityPort,
  type RestateEndpointFactory,
  type RestateEndpointHandle,
} from '@control-plane/workflow-runtime'
import { ExecutionLifecycleService } from '@control-plane/domain'
import {
  DisabledGraphSegmentActivities,
  DurableExecutionLifecycleActivities,
} from '@control-plane/workflow-worker'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.js'
import { LocalRuntimeInteractions } from './runtime-interactions.js'
import { LocalControlApiComposition } from './local-api-composition.js'
import type { ContextAuthoringCompositionOptions } from '@control-plane/context'

const require = createRequire(import.meta.url)
const COMPONENT_VERSION = '1.0.0'
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

export interface LocalComponentManifest {
  readonly schemaVersion: 1
  readonly profile: 'local' | 'hosted-simple'
  readonly version: string
  readonly dataDirectory: string
  readonly components: readonly DeploymentComponentHealth[]
  readonly topology: {
    readonly externalServices: 0
    readonly runtimeTransport: 'direct-local' | 'unconfigured'
    readonly restateVersion: string
    readonly persistence: 'sqlite'
    readonly objectStore: 'filesystem'
    readonly remoteControl: 'disabled' | 'outbound'
  }
}

/** Optional process lifecycle owned by the Local composition, not by individual attempts. */
export interface LocalRuntimeTransport extends RuntimeAdapterWithTransport {
  open?(): Promise<void>
  close?(): Promise<void>
}

export interface LocalControlPlaneCompositionOptions {
  readonly contextAuthoring?: ContextAuthoringCompositionOptions
  readonly dataDirectory: string
  readonly profile?: 'local' | 'hosted-simple'
  readonly workflowEndpointPort?: number
  readonly processProvider?: ProcessRuntimeProvider
  readonly workflowRuntime?: WorkflowRuntime
  readonly endpointFactory?: RestateEndpointFactory
  readonly activities?: ExecutionLifecycleActivities
  readonly graphActivities?: GraphSegmentActivityPort
  readonly graphActivitiesFactory?: (input: {
    readonly persistence: SqlitePersistenceProvider
  }) => GraphSegmentActivityPort
  readonly runtimeTransport?: LocalRuntimeTransport
  readonly runtimeFactory?: (input: {
    readonly catalog: LocalControlApiComposition['catalog']
    readonly contextPackages: LocalControlApiComposition['contextPackages']
    readonly dataDirectory: string
  }) => LocalRuntimeTransport
  readonly secrets?: SecretsProvider
  readonly remoteControl?: RemoteControlHostAdapter<unknown>
  readonly remoteControlFactory?: (
    acceptance: ExecutionAcceptancePort
  ) => RemoteControlHostAdapter<unknown>
  readonly environmentSecretReferences?: Readonly<Record<string, string>>
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export class LocalControlPlaneComposition {
  readonly interactionCommandService: LocalControlApiComposition['interactionCommandService']
  readonly executionCancellationService: LocalControlApiComposition['executionCancellationService']
  readonly dataDirectory: string
  readonly profile: 'local' | 'hosted-simple'
  readonly persistence: SqlitePersistenceProvider
  readonly objectStore: ObjectStore
  readonly workflow: WorkflowRuntime
  readonly secrets: SecretsProvider
  readonly runtimeTransport: LocalRuntimeTransport | undefined
  readonly remoteControl: RemoteControlHostAdapter<unknown> | undefined
  readonly executionAcceptanceService: ExecutionAcceptanceService
  readonly executionValidationService: LocalControlApiComposition['executionValidationService']
  readonly profileResolutionService: LocalControlApiComposition['profileResolutionService']
  readonly projectStateResolutionService: LocalControlApiComposition['projectStateResolutionService']
  readonly contextPackageResolutionService: LocalControlApiComposition['contextPackageResolutionService']
  readonly executionEvents: LocalControlApiComposition['executionEvents']
  readonly statePromotionProposals: LocalControlApiComposition['statePromotionProposals']
  readonly reconciliationCheckpoints: LocalControlApiComposition['reconciliationCheckpoints']
  readonly runtimeCommands: LocalControlApiComposition['runtimeCommands']
  readonly runtimeInventoryCheckpoints: LocalControlApiComposition['runtimeInventoryCheckpoints']
  readonly runtimeEventEffects: LocalControlApiComposition['runtimeEventEffects']
  readonly runtimeDiscoveryRepository: LocalControlApiComposition['runtimeDiscoveryRepository']
  readonly catalog: LocalControlApiComposition['catalog']
  readonly contextPackages: LocalControlApiComposition['contextPackages']
  readonly executionPlans: LocalControlApiComposition['executionPlans']
  readonly executions: LocalControlApiComposition['executions']
  readonly interactions: LocalControlApiComposition['interactions']
  readonly commands: LocalControlApiComposition['commands']
  readonly commandRepository: LocalControlApiComposition['commandRepository']
  readonly executionLifecycleActivities: ExecutionLifecycleActivities
  readonly coordination = new LocalCoordinationProvider()
  readonly observability = new BufferedObservabilityProvider()
  readonly discovery: StaticServiceDiscovery
  readonly #endpointFactory: RestateEndpointFactory
  #endpoint: RestateEndpointHandle | undefined
  #started = false

  constructor(options: LocalControlPlaneCompositionOptions) {
    const graphConfigured =
      options.graphActivities !== undefined || options.graphActivitiesFactory !== undefined
    if (options.graphActivities !== undefined && options.graphActivitiesFactory !== undefined)
      throw new Error('LOCAL_GRAPH_FACTORY_CONFIGURATION_CONFLICT')
    if (graphConfigured && options.activities !== undefined)
      throw new Error('LOCAL_GRAPH_ACTIVITIES_CONFIGURATION_CONFLICT')
    if (
      graphConfigured &&
      options.runtimeTransport === undefined &&
      options.runtimeFactory === undefined
    )
      throw new Error('LOCAL_GRAPH_RUNTIME_REQUIRED')
    this.dataDirectory = resolve(options.dataDirectory)
    this.profile = options.profile ?? 'local'
    const processProvider = options.processProvider ?? new NodeProcessRuntimeProvider()
    const workflowEndpointPort = options.workflowEndpointPort ?? 9080
    this.persistence = new SqlitePersistenceProvider({
      path: join(this.dataDirectory, 'control-plane.sqlite'),
      profile: this.profile,
    })
    this.objectStore = new FilesystemObjectStore({
      rootDirectory: join(this.dataDirectory, 'artifacts'),
      maxObjectBytes: MAX_ARTIFACT_BYTES,
    })
    this.secrets =
      options.secrets ??
      new CompositeSecretsProvider({
        env: new EnvironmentSecretsProvider({
          references: options.environmentSecretReferences ?? {},
          ...(options.environment === undefined ? {} : { environment: options.environment }),
        }),
        file: new PrivateFileSecretsProvider({
          rootDirectory: join(this.dataDirectory, 'secrets'),
        }),
      })
    if (options.runtimeTransport !== undefined && options.runtimeFactory !== undefined) {
      throw new Error('LOCAL_RUNTIME_CONFIGURATION_CONFLICT')
    }
    const controlApi = new LocalControlApiComposition(
      this.persistence,
      'http://127.0.0.1:8080',
      options.contextAuthoring
    )
    const runtimeTransport =
      options.runtimeTransport ??
      options.runtimeFactory?.({
        catalog: controlApi.catalog,
        contextPackages: controlApi.contextPackages,
        dataDirectory: this.dataDirectory,
      })
    if (runtimeTransport?.transportKind === 'remote-gateway') {
      throw new Error('LOCAL_RUNTIME_TRANSPORT_MUST_BE_DIRECT')
    }
    this.runtimeTransport = runtimeTransport
    this.executionAcceptanceService =
      options.activities === undefined && runtimeTransport === undefined
        ? new UnavailableExecutionAcceptanceService()
        : controlApi.executionAcceptanceService
    this.executionValidationService = controlApi.executionValidationService
    this.interactionCommandService = controlApi.interactionCommandService
    this.executionCancellationService = controlApi.executionCancellationService
    this.profileResolutionService = controlApi.profileResolutionService
    this.projectStateResolutionService = controlApi.projectStateResolutionService
    this.contextPackageResolutionService = controlApi.contextPackageResolutionService
    this.executionEvents = controlApi.executionEvents
    this.statePromotionProposals = controlApi.statePromotionProposals
    this.reconciliationCheckpoints = controlApi.reconciliationCheckpoints
    this.runtimeCommands = controlApi.runtimeCommands
    this.runtimeInventoryCheckpoints = controlApi.runtimeInventoryCheckpoints
    this.runtimeEventEffects = controlApi.runtimeEventEffects
    this.runtimeDiscoveryRepository = controlApi.runtimeDiscoveryRepository
    this.catalog = controlApi.catalog
    this.contextPackages = controlApi.contextPackages
    this.executionPlans = controlApi.executionPlans
    this.executions = controlApi.executions
    this.interactions = controlApi.interactions
    this.commands = controlApi.commands
    this.commandRepository = controlApi.commandRepository
    if (options.remoteControl !== undefined && options.remoteControlFactory !== undefined) {
      throw new Error('LOCAL_REMOTE_CONTROL_CONFIGURATION_CONFLICT')
    }
    this.remoteControl =
      options.remoteControl ?? options.remoteControlFactory?.(this.executionAcceptanceService)
    const activities: ExecutionLifecycleActivities | undefined =
      options.activities ??
      (runtimeTransport === undefined
        ? undefined
        : new DurableExecutionLifecycleActivities({
            lifecycle: new ExecutionLifecycleService(this.executions),
            plans: this.executionPlans,
            runtime: new DirectRuntimeActivityPort(
              this.persistence,
              this.objectStore,
              runtimeTransport,
              new LocalRuntimeInteractions(this.interactions, this.commandRepository)
            ),
            graph:
              options.graphActivities ??
              options.graphActivitiesFactory?.({ persistence: this.persistence }) ??
              new DisabledGraphSegmentActivities(),
            commands: this.commands,
          }))
    this.executionLifecycleActivities = activities ?? new UnconfiguredLocalExecutionActivities()
    this.#endpointFactory =
      options.endpointFactory ??
      createRestateEndpointFactory({
        host: '127.0.0.1',
        // Local Restate connects directly: allow control signals during long-running activities.
        bidirectional: true,
        port: workflowEndpointPort,
        activities: this.executionLifecycleActivities,
      })
    this.workflow =
      options.workflowRuntime ??
      new LocalRestateRuntime({
        executablePath: join(
          resolve(require.resolve('@restatedev/restate-server/package.json'), '..'),
          'lib',
          'index.js'
        ),
        dataDirectory: join(this.dataDirectory, 'restate'),
        profile: this.profile,
        processProvider,
        deploymentUri: `http://127.0.0.1:${workflowEndpointPort}`,
      })
    this.discovery = new StaticServiceDiscovery([
      { service: 'restate', url: new URL('http://127.0.0.1:8080'), private: true },
      {
        service: 'workflow-runtime',
        url: new URL(`http://127.0.0.1:${workflowEndpointPort}`),
        private: true,
      },
    ])
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('LOCAL_CONTROL_PLANE_ALREADY_STARTED')
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
    await this.persistence.migrate()
    try {
      await this.runtimeTransport?.open?.()
      this.#endpoint = await this.#endpointFactory.create()
      await this.#endpoint.run()
      await this.workflow.start()
      await this.remoteControl?.start()
    } catch (error) {
      await Promise.resolve()
        .then(() => this.remoteControl?.stop())
        .catch(() => undefined)
      await this.workflow.stop().catch(() => undefined)
      await this.#endpoint?.shutdown().catch(() => undefined)
      await this.runtimeTransport?.close?.().catch(() => undefined)
      this.#endpoint = undefined
      throw error
    }
    this.#started = true
    this.observability.record({
      name: 'local-started',
      occurredAt: new Date().toISOString(),
      attributes: { profile: this.profile },
    })
  }

  async manifest(): Promise<LocalComponentManifest> {
    const components = await Promise.all([
      this.persistence.health(),
      this.workflow.health(),
      this.secrets.health(),
      this.observability.health(),
      ...(this.remoteControl === undefined ? [] : [this.remoteControl.health()]),
    ])
    return {
      schemaVersion: 1,
      profile: this.profile,
      version: COMPONENT_VERSION,
      dataDirectory: this.dataDirectory,
      components,
      topology: {
        externalServices: 0,
        runtimeTransport: this.runtimeTransport === undefined ? 'unconfigured' : 'direct-local',
        restateVersion: RESTATE_SERVER_VERSION,
        persistence: 'sqlite',
        objectStore: 'filesystem',
        remoteControl: this.remoteControl === undefined ? 'disabled' : 'outbound',
      },
    }
  }

  async close(): Promise<void> {
    if (!this.#started && this.#endpoint === undefined) return
    this.#started = false
    try {
      await this.remoteControl?.stop()
    } finally {
      await this.workflow.stop().catch(() => undefined)
      await this.#endpoint?.shutdown().catch(() => undefined)
      this.#endpoint = undefined
      try {
        await this.runtimeTransport?.close?.()
      } finally {
        await this.secrets.close()
        await this.objectStore.close()
        this.persistence.close()
        this.coordination.close()
        this.observability.close()
      }
    }
  }
}

class UnconfiguredLocalExecutionActivities implements ExecutionLifecycleActivities {
  async ensureAttempt(): Promise<never> {
    throw new Error('LOCAL_RUNTIME_NOT_CONFIGURED')
  }

  async persistStatus(): Promise<never> {
    throw new Error('LOCAL_RUNTIME_NOT_CONFIGURED')
  }

  async dispatch(): Promise<never> {
    throw new Error('LOCAL_RUNTIME_NOT_CONFIGURED')
  }

  async applyInteraction(): Promise<never> {
    throw new Error('LOCAL_RUNTIME_NOT_CONFIGURED')
  }

  async runGraphSegment(): Promise<never> {
    throw new Error('LOCAL_GRAPH_RUNTIME_NOT_CONFIGURED')
  }

  async resumeGraphSegment(): Promise<never> {
    throw new Error('LOCAL_GRAPH_RUNTIME_NOT_CONFIGURED')
  }

  async continueGraphSegment(): Promise<never> {
    throw new Error('LOCAL_GRAPH_RUNTIME_NOT_CONFIGURED')
  }

  async cancelActive(): Promise<never> {
    throw new Error('LOCAL_RUNTIME_NOT_CONFIGURED')
  }

  async cleanup(): Promise<never> {
    throw new Error('LOCAL_RUNTIME_NOT_CONFIGURED')
  }
}
