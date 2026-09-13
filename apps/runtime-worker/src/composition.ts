import { isAbsolute } from 'node:path'
import {
  createPostgresConnection,
  PostgresContextCommandGrantRepository,
  PostgresContextProviderRegistrationRepository,
} from '@control-plane/database'
import {
  ContextCommandGrantAuthority,
  ContextProviderAdministration,
  createQueuedContextCommandRecord,
  type ContextCommandGrantRepository,
  type ContextCommandRecord,
  type ContextNodeInboxRepository,
} from '@control-plane/domain'
import {
  loadDatabaseCredentials,
  type DatabaseCredentials,
  type RawEnvironment,
} from '@control-plane/config'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextNodeInboxRepository,
  SqliteContextProviderRegistrationRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import type { GatewayCommandEnvelope } from '@control-plane/runtime-gateway-protocol'
import { ContextNodeChannel } from './context-node-channel.js'
import { ContextNodeHandler, type ContextNodeProviderDriver } from './context-node-handler.js'

/**
 * Explicit, operator-provisioned node-local grant store. There is no implicit backend:
 * node-side grant enforcement refuses to run without this config.
 */
export type ContextNodeStoreConfig =
  | { readonly backend: 'sqlite'; readonly path: string }
  | { readonly backend: 'postgres'; readonly credentials: DatabaseCredentials<'application'> }

/** Parses the node grant store backend from the environment; missing or invalid config fails closed. */
export function contextNodeStoreConfigFromEnvironment(
  environment: RawEnvironment
): ContextNodeStoreConfig {
  const backend = environment['CONTEXT_NODE_STORE_BACKEND']
  if (backend === 'sqlite') {
    const path = environment['CONTEXT_NODE_SQLITE_PATH']
    if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path))
      throw new Error('CONTEXT_NODE_STORE_CONFIG_INVALID')
    return { backend: 'sqlite', path }
  }
  if (backend === 'postgres') {
    return { backend: 'postgres', credentials: loadDatabaseCredentials(environment, 'application') }
  }
  throw new Error('CONTEXT_NODE_STORE_CONFIG_INVALID')
}

export interface ContextNodeTransport {
  /** Sends one serialized frame on the authenticated channel; the transport owns the socket. */
  readonly send: (serialized: string) => Promise<void>
  /** Composition-owned allocator for the authenticated channel, not a locally invented sequence. */
  readonly nextSequence: () => Promise<number>
  /** Transport-owned current-channel assertion (credential, generation and scope). */
  readonly assertCurrent: (command: GatewayCommandEnvelope) => Promise<void>
}

export interface ContextNodeCompositionOptions {
  readonly store: ContextNodeStoreConfig
  readonly workspaceId: string
  readonly nodeId: string
  readonly timeoutMs: number
  /** Operator-provisioned provider binding; endpoints never come from command payloads. */
  readonly driver: ContextNodeProviderDriver
  /**
   * Durable node inbox. Derived from the SQLite store when omitted; required with
   * Postgres grant stores, which have no node inbox adapter to compose.
   */
  readonly inbox?: ContextNodeInboxRepository
  readonly transport: ContextNodeTransport
}

export interface ContextNodeComposition {
  readonly channel: ContextNodeChannel
  readonly handler: ContextNodeHandler
  readonly grants: ContextCommandGrantRepository
  /** The node-side grant authority wired over the configured store, exposed for re-checks. */
  readonly authorize: (record: ContextCommandRecord) => Promise<void>
  /** Trusted operator port over the same node-local stores the administration CLI drives. */
  readonly administration: ContextProviderAdministration
  /** Closes the owned store handles; the transport and driver are not owned. */
  readonly close: () => Promise<void>
}

/**
 * Composes the durable node execution stack with real grant enforcement over the
 * explicitly configured node-local store. SQLite stores are migrated idempotently
 * here; PostgreSQL migration authority stays separate and is never invoked.
 */
export async function composeContextNode(
  options: ContextNodeCompositionOptions
): Promise<ContextNodeComposition> {
  const { store, workspaceId, nodeId, timeoutMs, driver, transport } = options
  if (typeof workspaceId !== 'string' || workspaceId.length === 0)
    throw new Error('CONTEXT_NODE_COMPOSITION_INVALID')
  if (typeof nodeId !== 'string' || nodeId.length === 0)
    throw new Error('CONTEXT_NODE_COMPOSITION_INVALID')
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    driver === undefined ||
    transport === undefined ||
    transport.send === undefined ||
    transport.nextSequence === undefined ||
    transport.assertCurrent === undefined
  )
    throw new Error('CONTEXT_NODE_COMPOSITION_INVALID')

  let grants: ContextCommandGrantRepository
  let registrations: ContextProviderAdministration['registrations']
  let inbox: ContextNodeInboxRepository | undefined = options.inbox
  let closeStore: () => Promise<void>
  if (store.backend === 'sqlite') {
    if (typeof store.path !== 'string' || store.path.length === 0)
      throw new Error('CONTEXT_NODE_COMPOSITION_INVALID')
    const provider = new SqlitePersistenceProvider({ path: store.path })
    await provider.migrate()
    grants = new SqliteContextCommandGrantRepository(provider)
    registrations = new SqliteContextProviderRegistrationRepository(provider)
    inbox ??= new SqliteContextNodeInboxRepository(provider)
    closeStore = async () => provider.close()
  } else {
    const connection = createPostgresConnection(store.credentials)
    grants = new PostgresContextCommandGrantRepository(connection.database)
    registrations = new PostgresContextProviderRegistrationRepository(connection.database)
    closeStore = () => connection.close()
  }
  if (inbox === undefined) throw new Error('CONTEXT_NODE_INBOX_REPOSITORY_REQUIRED')

  const authority = new ContextCommandGrantAuthority(grants)
  const authorize = async (record: ContextCommandRecord) => {
    await authority.authorize(record)
    await transport.assertCurrent(record.commandEnvelope as GatewayCommandEnvelope)
  }
  const handler = new ContextNodeHandler({
    workspaceId,
    nodeId,
    timeoutMs,
    repository: inbox,
    driver,
    authorize: (record) => authorize(record),
  })
  const channel = new ContextNodeChannel({
    handler,
    assertCurrent: async (command) => {
      await authority.authorize(createQueuedContextCommandRecord(command, command.issuedAt))
      await transport.assertCurrent(command)
    },
    send: transport.send,
    nextSequence: transport.nextSequence,
  })
  return {
    channel,
    handler,
    grants,
    authorize: (record) => authority.authorize(record),
    administration: new ContextProviderAdministration(grants, registrations),
    close: closeStore,
  }
}
