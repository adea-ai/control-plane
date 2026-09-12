import { isAbsolute } from 'node:path'
import {
  createPostgresConnection,
  PostgresContextCommandGrantRepository,
  PostgresContextCommandRepository,
  PostgresContextProviderRegistrationRepository,
  PostgresRuntimeChannelOwnershipRepository,
  PostgresRuntimeChannelSequenceRepository,
  type PostgresConnection,
} from '@control-plane/database'
import {
  ContextCommandGrantAuthority,
  ContextProviderAdministration,
  type ContextCommandGrantRepository,
  type ContextCommandRecord,
  type ContextCommandRepository,
  type ContextProviderRegistrationRepository,
} from '@control-plane/domain'
import {
  loadDatabaseCredentials,
  type DatabaseCredentials,
  type RawEnvironment,
} from '@control-plane/config'
import type { ObjectStore } from '@control-plane/deployment'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextCommandRepository,
  SqliteContextProviderRegistrationRepository,
  SqlitePersistenceProvider,
  SqliteRuntimeChannelSequenceRepository,
} from '@control-plane/sqlite-persistence'
import type { RuntimeChannelSequenceRepository } from '@control-plane/runtime-sdk'
import type { RuntimeNodeChannel } from './authentication.js'
import { ContextCommandDeliveryService } from './context-command-delivery.js'
import { ContextCommandRecoveryService } from './context-command-recovery.js'
import {
  GatewayContextProviderResolver,
  type GatewayContextProviderBinding,
} from './context-provider-composition.js'
import { ContextCommandArtifactStore } from './context-result-store.js'
import { RuntimeGatewayMessageRouter } from './runtime-message-handler.js'
import {
  InMemoryRuntimeNodeCoordination,
  RepositoryRuntimeNodeCoordination,
  type GatewayMetrics,
  type RuntimeNodeCoordinationPort,
  type RuntimeNodeReachabilityPublisher,
} from './websocket-coordination.js'
import {
  RuntimeGatewayWebSocketLifecycle,
  RuntimeGatewayWebSocketServer,
  type RuntimeGatewayWebSocketLimits,
} from './websocket-lifecycle.js'
import type { RuntimeGatewayNativeServe } from './websocket-server.js'

/**
 * Explicit, operator-provisioned store authority. There is no implicit backend:
 * start paths refuse to run when neither injected components nor this config exist.
 */
export type RuntimeGatewayStoreConfig =
  | { readonly backend: 'sqlite'; readonly path: string }
  | { readonly backend: 'postgres'; readonly credentials: DatabaseCredentials<'application'> }

/** Parses the gateway store backend from the environment; missing or invalid config fails closed. */
export function runtimeGatewayStoreConfigFromEnvironment(
  environment: RawEnvironment
): RuntimeGatewayStoreConfig {
  const backend = environment['RUNTIME_GATEWAY_STORE_BACKEND']
  if (backend === 'sqlite') {
    const path = environment['RUNTIME_GATEWAY_SQLITE_PATH']
    if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path))
      throw new Error('RUNTIME_GATEWAY_STORE_CONFIG_INVALID')
    return { backend: 'sqlite', path }
  }
  if (backend === 'postgres') {
    return { backend: 'postgres', credentials: loadDatabaseCredentials(environment, 'application') }
  }
  throw new Error('RUNTIME_GATEWAY_STORE_CONFIG_INVALID')
}

/** Conservative channel hardening limits; callers may tighten them per deployment. */
const defaultLifecycleLimits: RuntimeGatewayWebSocketLimits = {
  maxConnections: 256,
  maxConnectionsPerWorkspace: 32,
  maxFrameBytes: 262144,
  maxBufferedBytes: 1048576,
  heartbeatTimeoutMs: 30000,
  idleTimeoutMs: 60000,
}

export interface RuntimeGatewayCompositionOptions {
  readonly store: RuntimeGatewayStoreConfig
  /**
   * Host-provided ports. Each is validated at composition time: an absent port
   * fails closed instead of degrading to a permissive default.
   */
  readonly objectStore: ObjectStore | undefined
  readonly authenticateUpgrade: ((request: Request) => Promise<RuntimeNodeChannel>) | undefined
  readonly metrics: GatewayMetrics | undefined
  readonly reachability: RuntimeNodeReachabilityPublisher | undefined
  /** Supplied from the host's tracing context; never invented by the composition. */
  readonly traceId: (() => string) | undefined
  readonly instanceId: string
  readonly hostname: string
  readonly port: number
  readonly limits?: RuntimeGatewayWebSocketLimits
  readonly serve?: RuntimeGatewayNativeServe
}

export interface RuntimeGatewayComposition {
  readonly webSocketServer: RuntimeGatewayWebSocketServer
  readonly delivery: ContextCommandDeliveryService
  readonly recovery: ContextCommandRecoveryService
  readonly resolver: GatewayContextProviderResolver
  readonly artifacts: ContextCommandArtifactStore
  /** Trusted operator port over the same stores the administration CLI drives. */
  readonly administration: ContextProviderAdministration
  /** Closes the channel server first, then the owned store handles. */
  readonly close: () => Promise<void>
}

/**
 * Composes the context command delivery stack over explicitly configured stores.
 * SQLite stores are migrated idempotently here; PostgreSQL migration authority
 * stays separate and is never invoked by this composition.
 */
export async function composeRuntimeGateway(
  options: RuntimeGatewayCompositionOptions
): Promise<RuntimeGatewayComposition> {
  const {
    store,
    objectStore,
    authenticateUpgrade,
    metrics,
    reachability,
    traceId,
    instanceId,
    hostname,
    port,
  } = options
  if (typeof instanceId !== 'string' || instanceId.length === 0)
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  if (typeof hostname !== 'string' || hostname.length === 0)
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  if (
    objectStore === undefined ||
    authenticateUpgrade === undefined ||
    metrics === undefined ||
    reachability === undefined ||
    traceId === undefined
  )
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')

  const limits = options.limits ?? defaultLifecycleLimits
  let repository: ContextCommandRepository
  let grants: ContextCommandGrantRepository
  let registrations: ContextProviderRegistrationRepository
  let sequences: RuntimeChannelSequenceRepository
  let coordination: RuntimeNodeCoordinationPort
  let closeStore: () => Promise<void>
  if (store.backend === 'sqlite') {
    if (typeof store.path !== 'string' || store.path.length === 0)
      throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
    const provider = new SqlitePersistenceProvider({ path: store.path })
    await provider.migrate()
    repository = new SqliteContextCommandRepository(provider)
    grants = new SqliteContextCommandGrantRepository(provider)
    registrations = new SqliteContextProviderRegistrationRepository(provider)
    sequences = new SqliteRuntimeChannelSequenceRepository(provider)
    // Durable channel ownership has no SQLite adapter: single-instance coordination only.
    coordination = new InMemoryRuntimeNodeCoordination()
    closeStore = async () => provider.close()
  } else {
    const connection: PostgresConnection = createPostgresConnection(store.credentials)
    repository = new PostgresContextCommandRepository(connection.database)
    grants = new PostgresContextCommandGrantRepository(connection.database)
    registrations = new PostgresContextProviderRegistrationRepository(connection.database)
    sequences = new PostgresRuntimeChannelSequenceRepository(connection.database)
    coordination = new RepositoryRuntimeNodeCoordination(
      new PostgresRuntimeChannelOwnershipRepository(connection.database)
    )
    closeStore = () => connection.close()
  }

  const artifacts = new ContextCommandArtifactStore(objectStore)
  let lifecycle: RuntimeGatewayWebSocketLifecycle
  const delivery = new ContextCommandDeliveryService({
    repository,
    coordination,
    results: artifacts,
    sender: {
      // The lifecycle sender rechecks current ownership and capability policy per frame.
      send: (command, signal) => lifecycle.send(command, signal),
    },
  })
  const grantAuthority = new ContextCommandGrantAuthority(grants)
  const recovery = new ContextCommandRecoveryService(delivery, (record: ContextCommandRecord) =>
    grantAuthority.authorize(record)
  )
  const notComposed = async () => {
    throw new Error('RUNTIME_GATEWAY_ROUTE_NOT_COMPOSED')
  }
  const router = new RuntimeGatewayMessageRouter({
    context: delivery,
    // Unrelated command families stay fail-closed until their own composition exists.
    inventory: { handle: notComposed },
    delivery: {
      acknowledge: notComposed,
      recordResult: notComposed,
      recordError: notComposed,
    },
    events: {
      ingestProgress: notComposed,
      ingestResult: notComposed,
      ingestError: notComposed,
    },
  })
  lifecycle = new RuntimeGatewayWebSocketLifecycle({
    contextRecovery: recovery,
    sequences,
    instanceId,
    coordination,
    metrics,
    reachability,
    limits,
    messages: router,
  })
  const webSocketServer = new RuntimeGatewayWebSocketServer({
    lifecycle,
    hostname,
    port,
    limits: {
      maxFrameBytes: limits.maxFrameBytes,
      maxBufferedBytes: limits.maxBufferedBytes,
      idleTimeoutSeconds: Math.floor(limits.idleTimeoutMs / 1000),
    },
    authenticateUpgrade,
    ...(options.serve ? { serve: options.serve } : {}),
  })
  return {
    webSocketServer,
    delivery,
    recovery,
    artifacts,
    resolver: new GatewayContextProviderResolver({
      delivery,
      artifacts,
      grants,
      coordination,
      nextSequence: (source) => lifecycle.nextSequence(source),
      traceId,
      // Provider bindings are read at request time from the registration store the CLI writes.
      readBindings: async (scope) => {
        const bindings: GatewayContextProviderBinding[] = []
        for (const registration of await registrations.list(scope)) {
          const {
            readModel,
            providerRef,
            mappedProjectRef,
            authorizationRef,
            maximumOutputBytes,
            expectedCorpusRevision,
            expectedMemoryRevision,
            expectedEmbeddingVersion,
            expectedRetrievalVersion,
          } = registration
          bindings.push({
            readModel,
            providerRef,
            mappedProjectRef,
            authorizationRef,
            ...(maximumOutputBytes === undefined ? {} : { maximumOutputBytes }),
            ...(expectedCorpusRevision === undefined ? {} : { expectedCorpusRevision }),
            ...(expectedMemoryRevision === undefined ? {} : { expectedMemoryRevision }),
            ...(expectedEmbeddingVersion === undefined ? {} : { expectedEmbeddingVersion }),
            ...(expectedRetrievalVersion === undefined ? {} : { expectedRetrievalVersion }),
          })
        }
        return bindings
      },
    }),
    administration: new ContextProviderAdministration(grants, registrations),
    close: async () => {
      await webSocketServer.close()
      await closeStore()
    },
  }
}
