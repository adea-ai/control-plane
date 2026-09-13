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
  RestateExecutionWorkflowDispatcher,
  UnavailableExecutionAcceptanceService,
  type ExecutionAcceptanceService,
} from '@control-plane/control-api'
import type { RuntimeAdapterWithTransport } from '@control-plane/runtime-sdk'
import {
  CompositeSecretsProvider,
  EnvironmentSecretsProvider,
  PrivateFileSecretsProvider,
} from '@control-plane/secrets'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextProviderRegistrationRepository,
  SqliteExecutionCancellationRepository,
  SqlitePersistenceProvider,
  SqliteReconciliationEffects,
  SqliteReconciliationSource,
} from '@control-plane/sqlite-persistence'
import {
  createRestateEndpointFactory,
  type ExecutionLifecycleActivities,
  type GraphSegmentActivityPort,
  type RestateEndpointFactory,
  type RestateEndpointHandle,
} from '@control-plane/workflow-runtime'
import { ExecutionLifecycleService, ExecutionReconciliationService } from '@control-plane/domain'
import type {
  ReconciliationEffects,
  ReconciliationRateLimit,
  ReconciliationSource,
} from '@control-plane/domain'
import {
  DisabledGraphSegmentActivities,
  DurableExecutionLifecycleActivities,
} from '@control-plane/workflow-worker'
import { createConsistencyMetricEmitter } from '@control-plane/telemetry'
import type { MetricAdapter } from '@control-plane/telemetry'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.js'
import { LocalRuntimeInteractions } from './runtime-interactions.js'
import { LocalControlApiComposition } from './local-api-composition.js'
import { ReconciliationScheduler } from './reconciliation-scheduler.js'
import {
  GrantsBackedContextAuthoringAuthority,
  type ContextAuthoringCompositionOptions,
  type ContextAuthoringPolicy,
} from '@control-plane/context'

const require = createRequire(import.meta.url)
const COMPONENT_VERSION = '1.0.0'
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

/**
 * Explicit authoring policy for the supported local default authority. Provider content is
 * composed at the runtime gateway, so the control plane itself never requests provider
 * composition (mode disabled): authoring degrades to the documented no-provider path, and
 * only grants provisioned through the operator administration can authorize context.
 */
const LOCAL_CONTEXT_AUTHORING_POLICY: ContextAuthoringPolicy = {
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

/**
 * Explicit reconciliation-scheduling configuration. Scheduling is opt-in per
 * composition: absent configuration enables nothing, and invalid bounds fail
 * closed at composition construction. Either compose the production observation
 * projection (`projection: 'observation'`) or supply an explicit source and
 * effects pair; the two forms are mutually exclusive.
 */
export interface LocalReconciliationConfiguration {
  /**
   * Composes the production `SqliteReconciliationSource`/`Effects` pair from
   * this composition's own SQLite stores: bounded stale-candidate scanning,
   * lifecycle-respecting remediation, lost-ACK parking.
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

export interface LocalControlPlaneCompositionOptions {
  readonly contextAuthoring?: ContextAuthoringCompositionOptions
  readonly dataDirectory: string
  readonly profile?: 'local' | 'hosted-simple'
  readonly workflowEndpointPort?: number
  readonly restateAdminPort?: number
  readonly restateIngressPort?: number
  readonly restateNodePort?: number
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
  readonly metricAdapter?: MetricAdapter
  readonly reconciliation?: LocalReconciliationConfiguration
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
  readonly reconciliationService: ExecutionReconciliationService | undefined
  /** The composed observation source, exposed so the wiring is externally verifiable. */
  readonly reconciliationSource: ReconciliationSource | undefined
  /** The composed remediation effects, exposed so the wiring is externally verifiable. */
  readonly reconciliationEffects: ReconciliationEffects | undefined
  readonly coordination = new LocalCoordinationProvider()
  readonly observability = new BufferedObservabilityProvider()
  readonly discovery: StaticServiceDiscovery
  readonly #endpointFactory: RestateEndpointFactory
  readonly #reconciliationScheduler: ReconciliationScheduler | undefined
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
    const restateAdminUrl = `http://127.0.0.1:${options.restateAdminPort ?? 9070}`
    const restateIngressUrl = `http://127.0.0.1:${options.restateIngressPort ?? 8080}`
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
    // The supported default authorizes authoring from this composition's own SQLite grant
    // and registration stores; an explicit injection always takes precedence.
    const contextAuthoring =
      options.contextAuthoring ??
      ({
        authority: new GrantsBackedContextAuthoringAuthority({
          grants: new SqliteContextCommandGrantRepository(this.persistence),
          registrations: new SqliteContextProviderRegistrationRepository(this.persistence),
          artifacts: this.objectStore,
          policy: LOCAL_CONTEXT_AUTHORING_POLICY,
        }),
      } satisfies ContextAuthoringCompositionOptions)
    // Consistency metrics flow through the telemetry redaction pipeline with bounded
    // label cardinality; without an injected metric adapter every hook is a no-op.
    const consistencyMetrics =
      options.metricAdapter === undefined
        ? undefined
        : createConsistencyMetricEmitter(options.metricAdapter, 'local-control-plane')
    const controlApi = new LocalControlApiComposition(
      this.persistence,
      restateIngressUrl,
      contextAuthoring,
      consistencyMetrics
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
    // Reconciliation scheduling is explicit composition configuration: absent
    // configuration enables nothing, and invalid bounds fail closed above.
    // `projection: 'observation'` composes the production adapters over this
    // composition's own SQLite stores.
    if (options.reconciliation !== undefined) {
      const reconciliation = options.reconciliation
      if (
        reconciliation.projection !== undefined &&
        (reconciliation.source !== undefined || reconciliation.effects !== undefined)
      ) {
        throw new Error('LOCAL_RECONCILIATION_CONFIGURATION_CONFLICT')
      }
      if (
        reconciliation.projection === undefined &&
        (reconciliation.source === undefined || reconciliation.effects === undefined)
      ) {
        throw new Error('LOCAL_RECONCILIATION_CONFIGURATION_INVALID')
      }
      const source =
        reconciliation.source ??
        new SqliteReconciliationSource({
          executions: controlApi.executions,
          commands: controlApi.commandRepository,
          runtimeCommands: controlApi.runtimeCommands,
          runtimeConnections: controlApi.runtimeDiscoveryRepository,
          events: controlApi.executionEvents,
        })
      const effects =
        reconciliation.effects ??
        new SqliteReconciliationEffects({
          executions: controlApi.executions,
          commands: controlApi.commandRepository,
          events: controlApi.executionEvents,
          workflowSubmitter: new RestateExecutionWorkflowDispatcher({
            ingressUrl: restateIngressUrl,
          }),
          cancellations: new SqliteExecutionCancellationRepository(this.persistence),
        })
      this.reconciliationService = new ExecutionReconciliationService({
        repository: controlApi.reconciliationCheckpoints,
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
        adminUrl: restateAdminUrl,
        ingressUrl: restateIngressUrl,
        ...(options.restateNodePort === undefined ? {} : { nodePort: options.restateNodePort }),
        deploymentUri: `http://127.0.0.1:${workflowEndpointPort}`,
      })
    this.discovery = new StaticServiceDiscovery([
      { service: 'restate', url: new URL(restateIngressUrl), private: true },
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
      this.#reconciliationScheduler?.start()
    } catch (error) {
      await this.#reconciliationScheduler?.close().catch(() => undefined)
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
    // Drain the scheduler first: a clean close never abandons an in-flight pass.
    await this.#reconciliationScheduler?.close()
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
        try {
          this.persistence.close({ checkpoint: true })
        } finally {
          this.coordination.close()
          this.observability.close()
        }
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
