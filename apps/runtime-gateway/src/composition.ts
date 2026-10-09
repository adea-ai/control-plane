import { isAbsolute } from 'node:path'
import {
  createPostgresConnection,
  PostgresContextCommandGrantRepository,
  PostgresContextCommandRepository,
  PostgresContextProviderRegistrationRepository,
  PostgresRuntimeCommandRepository,
  PostgresRuntimeChannelOwnershipRepository,
  PostgresRuntimeChannelSequenceRepository,
  PostgresRuntimeNodeIdentityRepository,
  type PostgresConnection,
  type RuntimeNodeIdentityRevocationClient,
} from '@control-plane/database'
import {
  type CredentialRevocationFence,
  ContextCommandGrantAuthority,
  ContextProviderAdministration,
  type ContextCommandGrantRepository,
  type ContextCommandRecord,
  type ContextCommandRepository,
  type ContextProviderRegistrationRepository,
  type ExecutionRepository,
  type RuntimeCommandRepository,
  type RuntimeCommandRecord,
} from '@control-plane/domain'
import {
  loadDatabaseCredentials,
  loadDatabaseSessionCredentials,
  databaseSessionCredentials,
  type DatabaseCredentials,
  type RawEnvironment,
} from '@control-plane/config'
import type { ObjectStore, PersistenceTransaction } from '@control-plane/deployment'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextCommandRepository,
  SqliteContextProviderRegistrationRepository,
  SqlitePersistenceProvider,
  SqliteRuntimeChannelSequenceRepository,
  SqliteRuntimeCommandCredentialFenceInvalidError,
  SqliteRuntimeCommandRepository,
} from '@control-plane/sqlite-persistence'
import type { RuntimeChannelSequenceRepository } from '@control-plane/runtime-sdk'
import type { RuntimeEventEffectSink } from '@control-plane/events'
import { GatewayArtifactReferenceSchema } from '@control-plane/runtime-gateway-protocol'
import {
  createConsistencyMetricEmitter,
  type MetricAdapter,
  type StructuredLogger,
} from '@control-plane/telemetry'
import { RuntimeNodeChannelAuthenticator, type RuntimeNodeChannel } from './authentication.js'
import type { RuntimeNodeIdentityGatewayPort } from './runtime-node-identity-port.js'
import {
  authenticateRuntimeNodeUpgrade,
  PostgresRuntimeNodeIdentityValidationPort,
  type RuntimeNodeIdentityTrustConfig,
} from './postgres-runtime-node-identity.js'
import { ContextCommandDeliveryService } from './context-command-delivery.js'
import { ContextCommandRecoveryService } from './context-command-recovery.js'
import {
  GatewayContextProviderResolver,
  type GatewayContextProviderBinding,
} from './context-provider-composition.js'
import { ContextCommandArtifactStore } from './context-result-store.js'
import { RuntimeCommandArtifactVerifier } from './runtime-artifact-verifier.js'
import { RuntimeGatewayMessageRouter } from './runtime-message-handler.js'
import {
  RuntimeCommandDeliveryError,
  RuntimeCommandDeliveryService,
  RuntimePendingCommandDispatcher,
} from './runtime-command-delivery.js'
import {
  RuntimeEventIngestionService,
  DefaultRuntimeAdapterEventNormalizer,
  type RuntimeAdapterEventNormalizer,
  type RuntimeEventQuarantine,
  type RuntimeNodeChannelAuthority,
} from './runtime-event-ingestion.js'
import {
  RuntimeReconnectReconciliationService,
  type ReconnectCommandValidator,
  type RetainedCommandOutcomeApplier,
  type ExecutionReconnectReconciler,
} from './reconnect-reconciliation.js'
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
import type { RuntimeInventoryMessageHandler } from './runtime-inventory-ingestion.js'

export interface RuntimeGatewayRuntimeOptions {
  readonly executions: ExecutionRepository
  readonly effects: RuntimeEventEffectSink
  readonly quarantine: RuntimeEventQuarantine
  readonly validator: ReconnectCommandValidator
  readonly outcomes: RetainedCommandOutcomeApplier
  readonly executionReconciler: ExecutionReconnectReconciler
  readonly artifactVerifier: {
    verify(input: {
      readonly command: RuntimeCommandRecord
      readonly artifact: ReturnType<typeof GatewayArtifactReferenceSchema.parse>
    }): Promise<void>
  }
  readonly inventory?: Pick<RuntimeInventoryMessageHandler, 'handle'>
  readonly now?: () => Date
}

/**
 * Explicit, operator-provisioned store authority. There is no implicit backend:
 * start paths refuse to run when neither injected components nor this config exist.
 */
export type RuntimeGatewayStoreConfig =
  | { readonly backend: 'sqlite'; readonly path: string }
  | {
      readonly backend: 'postgres'
      readonly credentials: DatabaseCredentials<'application'>
      readonly notificationUrl?: string
    }

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
    return {
      backend: 'postgres',
      credentials: loadDatabaseCredentials(environment, 'application'),
      notificationUrl: loadDatabaseSessionCredentials(environment).url,
    }
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
  /**
   * SQLite-profile credential authority for runtime-command fences: the SAME
   * runtime-node credential source the channel authenticator trusts. When
   * absent, fenced ACK/result settlements fail closed (never silently pass).
   */
  readonly runtimeNodeCredentialAuthority?: RuntimeNodeIdentityGatewayPort
  /** Required for PostgreSQL/server composition; contains only issuer public keys. */
  readonly runtimeNodeIdentity?: RuntimeNodeIdentityTrustConfig | undefined
  readonly metrics: GatewayMetrics | undefined
  readonly reachability: RuntimeNodeReachabilityPublisher | undefined
  /** Supplied from the host's tracing context; never invented by the composition. */
  readonly traceId: (() => string) | undefined
  /**
   * Injected metric adapter for consistency observability. When absent, no
   * consistency metrics are emitted; a no-op fallback is the only default.
   */
  readonly metricAdapter?: MetricAdapter | undefined
  /**
   * Host log sink for transport diagnostics (inbound drops and receive
   * failures). When absent, those diagnostics stay metrics-only.
   */
  readonly logger?: StructuredLogger | undefined
  readonly instanceId: string
  readonly hostname: string
  readonly port: number
  readonly limits?: RuntimeGatewayWebSocketLimits
  readonly serve?: RuntimeGatewayNativeServe
  /** Optional, explicit host-authorized runtime command/event stack. */
  readonly runtime?: RuntimeGatewayRuntimeOptions
}

export interface RuntimeGatewayComposition {
  readonly webSocketServer: RuntimeGatewayWebSocketServer
  readonly delivery: ContextCommandDeliveryService
  readonly recovery: ContextCommandRecoveryService
  readonly resolver: GatewayContextProviderResolver
  readonly artifacts: ContextCommandArtifactStore
  /** Trusted operator port over the same stores the administration CLI drives. */
  readonly administration: ContextProviderAdministration
  readonly runtime?: {
    readonly commands: RuntimeCommandRepository
    readonly delivery: RuntimeCommandDeliveryService
    readonly pending: RuntimePendingCommandDispatcher
    readonly events: RuntimeEventIngestionService
    readonly reconnect: RuntimeReconnectReconciliationService
  }
  /** Closes the channel server first, then the owned store handles. */
  readonly close: () => Promise<void>
}

/**
 * Composes the context command delivery stack over explicitly configured stores.
 * SQLite stores are migrated idempotently here; PostgreSQL migration authority
 * stays separate and is never invoked by this composition.
 */
/**
 * Credential-fence validator for SQLite-profile runtime-command repositories:
 * consults the SAME runtime-node credential authority the channel authenticator
 * uses, and receives the LIVE in-transaction handle so durable authorities can
 * read within the fenced transaction. Revoked (and, for version-aware
 * authorities, stale-generation) credentials reject with the wire parity code.
 */
export function createRuntimeCommandCredentialFenceValidator(
  authority: RuntimeNodeIdentityGatewayPort
) {
  return async (transaction: PersistenceTransaction, fence: CredentialRevocationFence) => {
    void transaction
    const revoked = await authority.isRevoked(fence.credentialId, fence.revocationVersion)
    if (revoked) throw new SqliteRuntimeCommandCredentialFenceInvalidError()
  }
}

/**
 * Production factory for the SQLite-profile runtime-command repository. A
 * missing authority keeps the fail-closed behavior: fenced settlements reject.
 */
export function createSqliteRuntimeCommandRepository(
  provider: SqlitePersistenceProvider,
  credentialAuthority?: RuntimeNodeIdentityGatewayPort
): SqliteRuntimeCommandRepository {
  return new SqliteRuntimeCommandRepository(
    provider,
    credentialAuthority === undefined
      ? undefined
      : createRuntimeCommandCredentialFenceValidator(credentialAuthority)
  )
}

export async function composeRuntimeGateway(
  options: RuntimeGatewayCompositionOptions
): Promise<RuntimeGatewayComposition> {
  const { store, objectStore, metrics, reachability, traceId, instanceId, hostname, port } = options
  if (typeof instanceId !== 'string' || instanceId.length === 0)
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  if (typeof hostname !== 'string' || hostname.length === 0)
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  if (
    objectStore === undefined ||
    metrics === undefined ||
    reachability === undefined ||
    traceId === undefined
  )
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  if (
    (store.backend === 'postgres' &&
      (options.runtimeNodeIdentity === undefined || options.authenticateUpgrade !== undefined)) ||
    (store.backend === 'sqlite' &&
      (options.runtimeNodeIdentity !== undefined || options.authenticateUpgrade === undefined))
  ) {
    throw new Error('RUNTIME_GATEWAY_IDENTITY_AUTHORITY_REQUIRED')
  }
  if (options.runtime !== undefined) assertRuntimePorts(options.runtime)

  const limits = options.limits ?? defaultLifecycleLimits
  assertLifecycleLimits(limits)
  if (limits.idleTimeoutMs < 1_000) throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
  let repository: ContextCommandRepository
  let runtimeCommands: RuntimeCommandRepository | undefined
  let grants: ContextCommandGrantRepository
  let registrations: ContextProviderRegistrationRepository
  let sequences: RuntimeChannelSequenceRepository
  let coordination: RuntimeNodeCoordinationPort
  let closeStore: () => Promise<void>
  let postgresIdentityRepository: PostgresRuntimeNodeIdentityRepository | undefined
  if (store.backend === 'sqlite') {
    if (typeof store.path !== 'string' || store.path.length === 0)
      throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
    const provider = new SqlitePersistenceProvider({ path: store.path })
    try {
      await provider.migrate()
    } catch (error) {
      try {
        await provider.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'RUNTIME_GATEWAY_STORE_OPEN_FAILED', {
          cause: closeError,
        })
      }
      throw error
    }
    repository = new SqliteContextCommandRepository(provider)
    grants = new SqliteContextCommandGrantRepository(provider)
    registrations = new SqliteContextProviderRegistrationRepository(provider)
    if (options.runtime !== undefined)
      runtimeCommands = createSqliteRuntimeCommandRepository(
        provider,
        options.runtimeNodeCredentialAuthority
      )
    sequences = new SqliteRuntimeChannelSequenceRepository(provider)
    // Durable channel ownership has no SQLite adapter: single-instance coordination only.
    coordination = new InMemoryRuntimeNodeCoordination()
    closeStore = async () => provider.close()
  } else {
    const notificationCredentials = databaseSessionCredentials(
      store.credentials,
      store.notificationUrl
    )
    const connection: PostgresConnection = createPostgresConnection(store.credentials)
    const notificationConnection = createPostgresConnection(notificationCredentials, {
      maxConnections: 1,
    })
    repository = new PostgresContextCommandRepository(connection.database)
    grants = new PostgresContextCommandGrantRepository(connection.database)
    registrations = new PostgresContextProviderRegistrationRepository(connection.database)
    if (options.runtime !== undefined)
      runtimeCommands = new PostgresRuntimeCommandRepository(connection.database)
    sequences = new PostgresRuntimeChannelSequenceRepository(connection.database)
    coordination = new RepositoryRuntimeNodeCoordination(
      new PostgresRuntimeChannelOwnershipRepository(connection.database)
    )
    postgresIdentityRepository = new PostgresRuntimeNodeIdentityRepository(connection.database, {
      revocationClient: (
        notificationConnection.database as typeof notificationConnection.database & {
          $client: RuntimeNodeIdentityRevocationClient
        }
      ).$client,
    })
    closeStore = async () => {
      const results = await Promise.allSettled([notificationConnection.close(), connection.close()])
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (errors.length > 0) throw new AggregateError(errors, 'RUNTIME_GATEWAY_STORE_CLOSE_FAILED')
    }
  }

  let storeClosed = false
  const closeOwnedStore = async () => {
    if (storeClosed) return
    storeClosed = true
    await closeStore()
  }

  let identityValidation: PostgresRuntimeNodeIdentityValidationPort | undefined
  let channelAuthenticator: RuntimeNodeChannelAuthenticator | undefined
  try {
    let authenticateUpgrade = options.authenticateUpgrade
    if (store.backend === 'postgres') {
      const trust = options.runtimeNodeIdentity
      if (trust === undefined || postgresIdentityRepository === undefined)
        throw new Error('RUNTIME_GATEWAY_IDENTITY_AUTHORITY_REQUIRED')
      identityValidation = new PostgresRuntimeNodeIdentityValidationPort(
        postgresIdentityRepository,
        trust.issuerPublicKeys
      )
      await identityValidation.startRevocationListener()
      channelAuthenticator = new RuntimeNodeChannelAuthenticator({
        identityValidator: identityValidation,
        logger: options.logger ?? runtimeGatewayAuthenticationLogger,
      })
      authenticateUpgrade = (request) =>
        authenticateRuntimeNodeUpgrade(request, channelAuthenticator!, trust)
    }
    if (authenticateUpgrade === undefined)
      throw new Error('RUNTIME_GATEWAY_IDENTITY_AUTHORITY_REQUIRED')
    const artifacts = new ContextCommandArtifactStore(objectStore)
    // Consistency metrics flow through the telemetry redaction pipeline with bounded
    // label cardinality; without an injected metric adapter nothing is emitted.
    const consistencyMetrics =
      options.metricAdapter === undefined
        ? undefined
        : createConsistencyMetricEmitter(options.metricAdapter, 'runtime-gateway')
    let lifecycle: RuntimeGatewayWebSocketLifecycle
    const channelAuthority: RuntimeNodeChannelAuthority = {
      isActive: (source) => lifecycle.isChannelActive(source),
    }
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
    const runtimeOptions = options.runtime
    let runtime: RuntimeGatewayComposition['runtime']
    let runtimeDelivery: RuntimeCommandDeliveryService | undefined
    let runtimeEvents: RuntimeEventIngestionService | undefined
    let runtimeReconnect: RuntimeReconnectReconciliationService | undefined
    let runtimePending: RuntimePendingCommandDispatcher | undefined
    if (runtimeOptions !== undefined && runtimeCommands !== undefined) {
      const baseNormalizer = new DefaultRuntimeAdapterEventNormalizer()
      const storedArtifactVerifier = new RuntimeCommandArtifactVerifier(objectStore)
      const normalizer: RuntimeAdapterEventNormalizer = {
        normalizeProgress: (input) => baseNormalizer.normalizeProgress(input),
        normalizeError: (input) => baseNormalizer.normalizeError(input),
        normalizeResult: async (input) => {
          if (input.frame.status === 'succeeded' && 'artifact' in input.frame.result) {
            const artifact = GatewayArtifactReferenceSchema.parse(input.frame.result.artifact)
            await storedArtifactVerifier.verify({ command: input.command, artifact })
            await runtimeOptions.artifactVerifier.verify({ command: input.command, artifact })
          }
          return baseNormalizer.normalizeResult(input)
        },
      }
      const validator: ReconnectCommandValidator = {
        validate: async (command) => {
          const validation: unknown = await runtimeOptions.validator.validate(command)
          if (validation === null || typeof validation !== 'object' || !('valid' in validation)) {
            return { valid: false, reason: 'runtime_incompatible' }
          }
          if ((validation as { valid?: unknown }).valid === true) return { valid: true }
          const reason = (validation as { reason?: unknown }).reason
          if (
            reason === 'node_revoked' ||
            reason === 'grant_revoked' ||
            reason === 'runtime_incompatible' ||
            reason === 'capability_changed'
          )
            return { valid: false, reason }
          return { valid: false, reason: 'runtime_incompatible' }
        },
      }
      const authorize = async (command: Parameters<ReconnectCommandValidator['validate']>[0]) => {
        const validation = await validator.validate(command)
        if (!validation.valid) {
          throw new RuntimeCommandDeliveryError('RUNTIME_COMMAND_AUTHORIZATION_DENIED')
        }
      }
      runtimeDelivery = new RuntimeCommandDeliveryService({
        repository: runtimeCommands,
        metrics,
        authorize,
        ...(runtimeOptions.now === undefined ? {} : { now: runtimeOptions.now }),
        sender: {
          send: async (envelope) => {
            // Authorization is checked again after the durable dispatch CAS and
            // directly before send. Re-read the immutable ledger identity so a
            // changed/replaced record cannot borrow the earlier permission.
            const current = await runtimeCommands?.get(envelope.commandId)
            if (
              current === undefined ||
              current.nodeId !== envelope.nodeId ||
              current.workspaceId !== envelope.workspaceId ||
              current.payloadHash !== envelope.payloadHash ||
              current.executionId !== envelope.executionId ||
              current.attemptId !== envelope.attemptId ||
              current.runtimeConnectionId !== envelope.runtimeConnectionId
            ) {
              throw new RuntimeCommandDeliveryError('RUNTIME_COMMAND_AUTHORIZATION_DENIED')
            }
            await authorize(current)
            // lifecycle.send independently rechecks active coordination owner,
            // authenticated scope, and negotiated protocol immediately before
            // the socket write.
            await lifecycle.send(envelope)
          },
        },
      })
      runtimePending = new RuntimePendingCommandDispatcher({
        repository: runtimeCommands,
        delivery: runtimeDelivery,
        ...(runtimeOptions.now === undefined ? {} : { now: runtimeOptions.now }),
      })
      runtimeReconnect = new RuntimeReconnectReconciliationService({
        repository: runtimeCommands,
        delivery: runtimeDelivery,
        validator,
        outcomes: runtimeOptions.outcomes,
        executions: runtimeOptions.executionReconciler,
        metrics,
        ...(runtimeOptions.now === undefined ? {} : { now: runtimeOptions.now }),
      })
      runtimeEvents = new RuntimeEventIngestionService({
        commands: runtimeCommands,
        executions: runtimeOptions.executions,
        effects: runtimeOptions.effects,
        normalizer,
        quarantine: runtimeOptions.quarantine,
        metrics,
        ...(runtimeOptions.now === undefined ? {} : { now: runtimeOptions.now }),
        channelAuthority,
      })
      runtime = {
        commands: runtimeCommands,
        delivery: runtimeDelivery,
        pending: runtimePending,
        events: runtimeEvents,
        reconnect: runtimeReconnect,
      }
    }
    const notComposed = async () => {
      throw new Error('RUNTIME_GATEWAY_ROUTE_NOT_COMPOSED')
    }
    const router = new RuntimeGatewayMessageRouter({
      channelAuthority,
      context: delivery,
      // Unrelated command families stay fail-closed until their own composition exists.
      inventory: runtimeOptions?.inventory ?? { handle: notComposed },
      delivery: {
        acknowledge: runtimeDelivery?.acknowledge.bind(runtimeDelivery) ?? notComposed,
        recordResult: runtimeDelivery?.recordResult.bind(runtimeDelivery) ?? notComposed,
        recordError: runtimeDelivery?.recordError.bind(runtimeDelivery) ?? notComposed,
      },
      events: {
        ingestProgress: runtimeEvents?.ingestProgress.bind(runtimeEvents) ?? notComposed,
        ingestResult: runtimeEvents?.ingestResult.bind(runtimeEvents) ?? notComposed,
        ingestError: runtimeEvents?.ingestError.bind(runtimeEvents) ?? notComposed,
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
      // Frames dropped before authentication, parsing, or routing are otherwise
      // invisible: the metric stays fixed-cardinality and the host log carries
      // the connection identity for diagnosis.
      onInboundDrop: (drop) =>
        options.logger?.write({
          level: 'warn',
          event: 'inbound_frame_dropped',
          metadata: drop,
        }),
      ...(runtimeReconnect === undefined
        ? {}
        : {
            reconnect: {
              reconcile: (hello, source, nextSequence) =>
                runtimeReconnect.reconcile(hello, source, nextSequence),
            },
          }),
      ...(runtimePending === undefined ? {} : { pending: runtimePending }),
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
      onReceiveError: (error) =>
        options.logger?.write({
          level: 'warn',
          event: 'inbound_receive_failed',
          metadata: { message: error instanceof Error ? error.message : String(error) },
        }),
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
        ...(consistencyMetrics === undefined ? {} : { metrics: consistencyMetrics }),
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
      ...(runtime === undefined ? {} : { runtime }),
      close: async () => {
        let serverFailure: unknown
        let identityFailure: unknown
        let storeFailure: unknown
        try {
          await webSocketServer.close()
        } catch (error) {
          serverFailure = error
        }
        try {
          channelAuthenticator?.close()
          await identityValidation?.close()
        } catch (error) {
          identityFailure = error
        }
        try {
          await closeOwnedStore()
        } catch (error) {
          storeFailure = error
        }
        const closeFailures = [serverFailure, identityFailure, storeFailure].filter(
          (error) => error !== undefined
        )
        if (closeFailures.length > 1)
          throw new Error('RUNTIME_GATEWAY_CLOSE_FAILED', {
            cause: new AggregateError(closeFailures),
          })
        if (serverFailure !== undefined) throw serverFailure
        if (identityFailure !== undefined) throw identityFailure
        if (storeFailure !== undefined) throw storeFailure
      },
    }
  } catch (error) {
    let identityCloseError: unknown
    try {
      // Partial composition can establish LISTEN before a later route/server
      // validation fails; always close the subscriber before its DB pool.
      channelAuthenticator?.close()
      await identityValidation?.close()
    } catch (closeError) {
      identityCloseError = closeError
    }
    try {
      await closeOwnedStore()
    } catch (closeError) {
      identityCloseError ??= closeError
    }
    if (identityCloseError !== undefined)
      throw new AggregateError([error, identityCloseError], 'RUNTIME_GATEWAY_COMPOSITION_FAILED', {
        cause: error,
      })
    throw error
  }
}

function assertRuntimePorts(options: RuntimeGatewayRuntimeOptions): void {
  if (typeof options !== 'object' || options === null)
    throw new Error('RUNTIME_GATEWAY_RUNTIME_PORT_INVALID')
  const methods: readonly [unknown, string][] = [
    [options.executions?.getExecution, 'executions.getExecution'],
    [options.executions?.getAttempt, 'executions.getAttempt'],
    [options.effects?.applyProgress, 'effects.applyProgress'],
    [options.effects?.applyTerminal, 'effects.applyTerminal'],
    [options.quarantine?.record, 'quarantine.record'],
    [options.validator?.validate, 'validator.validate'],
    [options.outcomes?.apply, 'outcomes.apply'],
    [options.executionReconciler?.reconcile, 'executionReconciler.reconcile'],
    [
      options.executionReconciler?.requireManualIntervention,
      'executionReconciler.requireManualIntervention',
    ],
    [options.artifactVerifier?.verify, 'artifactVerifier.verify'],
  ]
  if (methods.some(([method]) => typeof method !== 'function'))
    throw new Error('RUNTIME_GATEWAY_RUNTIME_PORT_INVALID')
  if (options.inventory !== undefined && typeof options.inventory.handle !== 'function')
    throw new Error('RUNTIME_GATEWAY_RUNTIME_PORT_INVALID')
  if (options.now !== undefined && typeof options.now !== 'function')
    throw new Error('RUNTIME_GATEWAY_RUNTIME_PORT_INVALID')
}

function assertLifecycleLimits(limits: RuntimeGatewayWebSocketLimits): void {
  if (
    !Number.isSafeInteger(limits.maxConnections) ||
    limits.maxConnections < 1 ||
    !Number.isSafeInteger(limits.maxConnectionsPerWorkspace) ||
    limits.maxConnectionsPerWorkspace < 1 ||
    !Number.isSafeInteger(limits.maxFrameBytes) ||
    limits.maxFrameBytes < 1 ||
    !Number.isSafeInteger(limits.maxBufferedBytes) ||
    limits.maxBufferedBytes < 1 ||
    !Number.isSafeInteger(limits.heartbeatTimeoutMs) ||
    limits.heartbeatTimeoutMs < 1 ||
    !Number.isSafeInteger(limits.idleTimeoutMs) ||
    limits.idleTimeoutMs < 1000 ||
    limits.heartbeatTimeoutMs >= limits.idleTimeoutMs
  )
    throw new Error('RUNTIME_GATEWAY_COMPOSITION_INVALID')
}

const runtimeGatewayAuthenticationLogger: StructuredLogger = {
  write(entry) {
    // The authenticator emits only normalized outcome codes and node/workspace
    // scope. Never serialize request headers, compact credentials or proofs.
    const message = JSON.stringify(entry)
    if (entry.level === 'error') console.error(message)
    else if (entry.level === 'warn') console.warn(message)
    else console.info(message)
  },
}
