import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute, join } from 'node:path'
import {
  bootstrapService,
  jsonLogger,
  type ProcessAdapter,
  type StructuredLogger,
} from '@control-plane/bootstrap'
import type { RawEnvironment } from '@control-plane/config'
import {
  canonicalJsonStringify,
  GRAPH_TOOL_PINS_CAPABILITY,
  IdentifierSchemas,
  type ToolDefinitionId,
  type ToolVersionId,
  type WorkspaceId,
} from '@control-plane/contracts'
import { createControlApiApplication, MarketplaceRegistryService } from '@control-plane/control-api'
import type { GraphNodeOperation, GraphNodeOperationPort } from '@control-plane/orchestration'
import {
  SqliteToolRegistryRepository,
  type SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { ToolRegistry, ToolRegistryError } from '@control-plane/tool-execution'
import type { ToolDefinition, ToolVersionDraft } from '@control-plane/tool-sdk'
import {
  LocalControlPlaneComposition,
  type LocalControlPlaneCompositionOptions,
} from './composition.js'
import { createLocalApiAuthentication } from './authentication.js'
import { createLocalManagedPiRuntime } from './managed-pi-runtime.js'
import { createInstalledLocalAcpRuntime } from './installed-acp-runtime.js'
import { LocalGraphToolOperations } from './local-graph-tool-operations.js'
import type { ManagedLocalGraphRuntimeOptions } from './managed-graph-runtime.js'

export const serviceName = 'local-control-plane'

export interface LocalControlPlaneStartOptions {
  readonly apiHost?: string
  readonly environment?: RawEnvironment
  readonly logger?: StructuredLogger
  readonly processAdapter?: ProcessAdapter
  readonly composition?: LocalControlPlaneComposition
  readonly compositionOptions?: Omit<LocalControlPlaneCompositionOptions, 'dataDirectory'> & {
    readonly dataDirectory?: string
  }
}

interface LocalGraphToolConfiguration {
  readonly schemaVersion: 1
  readonly workspaceId: WorkspaceId
  readonly toolDefinitionId: ToolDefinitionId
  readonly toolVersionId: ToolVersionId
  readonly currency: 'USD'
  readonly costMicrounits: number
  readonly createdAt: string
  readonly publishedAt: string
}

const LOCAL_GRAPH_CONFIG_ENV = 'CONTROL_PLANE_LOCAL_GRAPH_CONFIG'
const LOCAL_GRAPH_CONFIG_MAX_BYTES = 16_384
const LOCAL_GRAPH_TOOL_NAME = 'local-object-store-json'
const LOCAL_GRAPH_TOOL_VERSION = '1.0.0'
const LOCAL_GRAPH_TOOL_OPERATION = 'store-json'
const LOCAL_GRAPH_NODE_ALIAS = 'store'
const LOCAL_GRAPH_TOOL_EXECUTOR = 'local.object-store-json.v1'

const supportedApiHosts = new Set(['127.0.0.1', '::1', '0.0.0.0', '::'])

export function resolveLocalApiHost(explicitHost?: string): string {
  const host = explicitHost ?? process.env['CONTROL_PLANE_BIND_HOST'] ?? '127.0.0.1'
  if (!supportedApiHosts.has(host)) throw new Error('LOCAL_CONTROL_PLANE_BIND_HOST_INVALID')
  return host
}

export function resolveEmbeddedDeploymentProfile(
  explicitProfile?: string
): 'local' | 'hosted-simple' {
  const profile = explicitProfile ?? process.env['CONTROL_PLANE_DEPLOYMENT_PROFILE'] ?? 'local'
  if (profile !== 'local' && profile !== 'hosted-simple') {
    throw new Error('EMBEDDED_DEPLOYMENT_PROFILE_INVALID')
  }
  return profile
}

export const start = (options: LocalControlPlaneStartOptions = {}) =>
  bootstrapService({
    serviceName,
    logger: options.logger ?? jsonLogger,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.processAdapter === undefined ? {} : { processAdapter: options.processAdapter }),
    start: async ({ config, health, markReady, readiness, registerResource }) => {
      const environment = options.environment ?? process.env
      let graphToolOperations: LocalGraphToolOperations | undefined
      const graphRuntime = await resolveLocalGraphRuntimeOptions(environment, (operations) => {
        graphToolOperations = operations
      })
      assertLocalGraphConfigurationCompatible(options, graphRuntime, environment)
      const composition =
        options.composition ??
        new LocalControlPlaneComposition({
          dataDirectory:
            options.compositionOptions?.dataDirectory ??
            process.env['CONTROL_PLANE_DATA_DIR'] ??
            join(homedir(), '.control-plane'),
          profile: resolveEmbeddedDeploymentProfile(),
          ...resolveLocalRuntimeOptions(environment),
          ...(graphRuntime === undefined ? {} : { graphRuntime }),
          ...(() => {
            const policy = resolveLocalCatalogApprovalPolicy(environment)
            return policy === undefined ? {} : { catalogApprovalPolicy: policy }
          })(),
          ...options.compositionOptions,
        })
      registerResource('local-control-plane-composition', () => composition.close())
      await composition.start()
      graphToolOperations?.bindRecoveryRuntime(composition)
      const authentication = await createLocalApiAuthentication(composition.dataDirectory)
      // Marketplace registry: enabled with MARKETPLACE_REGISTRY_ENABLED=1 (or a
      // custom MARKETPLACE_REGISTRY_LATEST_URL), otherwise the local profile
      // reports the marketplace as unavailable, matching the cloud default.
      const marketplaceRegistryService =
        process.env['MARKETPLACE_REGISTRY_ENABLED'] === '1' ||
        process.env['MARKETPLACE_REGISTRY_LATEST_URL']
          ? new MarketplaceRegistryService({
              // Full plugin catalogs exceed the default 12 MiB artifact cap.
              maxArtifactBytes: 64 * 1024 * 1024,
              ...(process.env['MARKETPLACE_REGISTRY_LATEST_URL']
                ? { latestUrl: process.env['MARKETPLACE_REGISTRY_LATEST_URL'] }
                : {}),
              ...(process.env['MARKETPLACE_REGISTRY_TOKEN']
                ? { token: process.env['MARKETPLACE_REGISTRY_TOKEN'] }
                : {}),
            })
          : undefined
      const application = await createControlApiApplication({
        ...(graphToolOperations === undefined
          ? {}
          : { toolEffectRecoveryService: graphToolOperations }),
        ...(marketplaceRegistryService ? { marketplaceRegistryService } : {}),
        interactionCommandService: composition.interactionCommandService,
        executionCancellationService: composition.executionCancellationService,
        executionAcceptanceService: composition.executionAcceptanceService,
        executionValidationService: composition.executionValidationService,
        graphAdministrationService: composition.graphAdministrationService,
        profileResolutionService: composition.profileResolutionService,
        projectStateResolutionService: composition.projectStateResolutionService,
        projectStateInitializationService: composition.projectStateInitializationService,
        contextPackageResolutionService: composition.contextPackageResolutionService,
        runtimeDiscoveryRepository: composition.runtimeDiscoveryRepository,
        serviceAuthenticator: authentication.authenticator,
        componentManifest: () => composition.manifest(),
        dependencyReadiness: async () =>
          (await composition.manifest()).components.every((component) => component.ready) &&
          (await composition.persistence.health()).ready,
        health,
        logger: options.logger ?? jsonLogger,
        metadata: config.metadata,
        readiness,
      })
      registerResource('local-control-plane-api', () => application.close())
      await application.listen({
        host: resolveLocalApiHost(options.apiHost),
        port: config.values.port,
      })
      markReady()
    },
  })

export * from './composition.js'
export * from './server.js'
export * from './authentication.js'
export * from './local-api-composition.js'
export * from './direct-runtime-activities.js'
export * from './managed-pi-runtime.js'
export * from './acp-runtime.js'
export * from './installed-acp-runtime.js'

/**
 * Optional catalog approval policy (#188) from CONTROL_PLANE_CATALOG_APPROVAL_*
 * — absent means resolution behaves exactly as before; malformed values fail
 * startup rather than silently leaving approval unenforced.
 */
export function resolveLocalCatalogApprovalPolicy(
  environment: Readonly<Record<string, string | undefined>>
): { readonly required: boolean; readonly requiredSince?: string } | undefined {
  const requiredValue = environment['CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED']
  if (requiredValue === undefined) return undefined
  if (requiredValue !== 'true' && requiredValue !== 'false') {
    throw new Error('LOCAL_CATALOG_APPROVAL_POLICY_INVALID')
  }
  const requiredSince = environment['CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED_SINCE']
  if (requiredSince !== undefined && Number.isNaN(Date.parse(requiredSince))) {
    throw new Error('LOCAL_CATALOG_APPROVAL_POLICY_INVALID')
  }
  return {
    required: requiredValue === 'true',
    ...(requiredSince === undefined ? {} : { requiredSince }),
  }
}

export function resolveLocalRuntimeOptions(
  environment: Readonly<Record<string, string | undefined>>
): Pick<LocalControlPlaneCompositionOptions, 'runtimeFactory'> {
  const family = environment['CONTROL_PLANE_LOCAL_RUNTIME']
  if (family === undefined || family.length === 0) return {}
  if (family === 'codex-acp') {
    const required = (suffix: string) => {
      const value = environment[`CONTROL_PLANE_CODEX_ACP_${suffix}`]
      if (!value) throw new Error(`LOCAL_CODEX_ACP_${suffix}_REQUIRED`)
      return value
    }
    const options = {
      installationDirectory: required('INSTALLATION'),
      nodeExecutable: required('NODE'),
      cwd: required('CWD'),
      codexHome: required('HOME'),
      provider: required('PROVIDER'),
      model: required('MODEL'),
      modelAlias: required('MODEL_ALIAS'),
      modelCapabilities: required('MODEL_CAPABILITIES')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      providerClass: required('PROVIDER_CLASS'),
      dataResidency: required('DATA_RESIDENCY'),
    }
    return {
      runtimeFactory: (repositories) => createInstalledLocalAcpRuntime(repositories, options),
    }
  }
  if (family !== 'managed-pi') throw new Error('LOCAL_RUNTIME_FAMILY_INVALID')
  const provider = environment['CONTROL_PLANE_MANAGED_PI_PROVIDER']
  const model = environment['CONTROL_PLANE_MANAGED_PI_MODEL']
  const modelAlias = environment['CONTROL_PLANE_MANAGED_PI_MODEL_ALIAS']
  const providerClass = environment['CONTROL_PLANE_MANAGED_PI_PROVIDER_CLASS']
  const dataResidency = environment['CONTROL_PLANE_MANAGED_PI_DATA_RESIDENCY']
  const modelCapabilities = environment['CONTROL_PLANE_MANAGED_PI_MODEL_CAPABILITIES']
  if (
    provider === undefined ||
    model === undefined ||
    modelAlias === undefined ||
    providerClass === undefined ||
    dataResidency === undefined ||
    modelCapabilities === undefined
  ) {
    throw new Error('LOCAL_MANAGED_PI_MODEL_CONFIGURATION_REQUIRED')
  }
  const executablePath = environment['CONTROL_PLANE_MANAGED_PI_EXECUTABLE'] ?? 'pi'
  const childEnvironment = pickEnvironment(environment, [
    'HOME',
    'PATH',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ])
  return {
    runtimeFactory: (repositories) =>
      createLocalManagedPiRuntime(repositories, {
        executablePath,
        provider,
        model,
        modelAlias,
        providerClass,
        dataResidency,
        modelCapabilities: modelCapabilities
          .split(',')
          .map((capability) => capability.trim())
          .filter((capability) => capability.length > 0),
        environment: childEnvironment,
        // CP-RNODE-025: the managed Pi executable is pinned to the configured
        // binary; launches of anything else are rejected before spawn.
        spawnPolicy: { allowedExecutables: [executablePath] },
      }),
  }
}

function pickEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = environment[name]
      return value === undefined ? [] : [[name, value]]
    })
  )
}

/** Resolve one bounded Local graph-tool binding from an operator-owned JSON file. */
export async function resolveLocalGraphRuntimeOptions(
  environment: Readonly<Record<string, string | undefined>>,
  onOperationsReady?: (operations: LocalGraphToolOperations) => void
): Promise<ManagedLocalGraphRuntimeOptions | undefined> {
  const path = environment[LOCAL_GRAPH_CONFIG_ENV]
  if (path === undefined) return undefined
  if (!path || !isAbsolute(path)) throw new Error('LOCAL_GRAPH_CONFIG_PATH_INVALID')

  let config: LocalGraphToolConfiguration
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > LOCAL_GRAPH_CONFIG_MAX_BYTES) {
      throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
    }
    const contents = await file.readFile('utf8')
    if (Buffer.byteLength(contents, 'utf8') > LOCAL_GRAPH_CONFIG_MAX_BYTES) {
      throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
    }
    config = parseLocalGraphToolConfiguration(JSON.parse(contents))
  } catch {
    throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
  } finally {
    await file?.close()
  }

  return createLocalGraphRuntimeOptions(config, onOperationsReady)
}

function parseLocalGraphToolConfiguration(input: unknown): LocalGraphToolConfiguration {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
  }
  const record = input as Record<string, unknown>
  const expectedKeys = [
    'costMicrounits',
    'createdAt',
    'currency',
    'publishedAt',
    'schemaVersion',
    'toolDefinitionId',
    'toolVersionId',
    'workspaceId',
  ]
  if (!isDeepStrictEqual(Object.keys(record).toSorted(), expectedKeys)) {
    throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
  }
  if (
    record['schemaVersion'] !== 1 ||
    record['currency'] !== 'USD' ||
    typeof record['costMicrounits'] !== 'number' ||
    !Number.isSafeInteger(record['costMicrounits']) ||
    record['costMicrounits'] < 0 ||
    typeof record['createdAt'] !== 'string' ||
    typeof record['publishedAt'] !== 'string'
  ) {
    throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
  }
  const createdAt = parseOperatorTimestamp(record['createdAt'])
  const publishedAt = parseOperatorTimestamp(record['publishedAt'])
  if (Date.parse(publishedAt) < Date.parse(createdAt)) {
    throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
  }
  try {
    return {
      schemaVersion: 1,
      workspaceId: IdentifierSchemas.workspaceId.parse(record['workspaceId']),
      toolDefinitionId: IdentifierSchemas.toolDefinitionId.parse(record['toolDefinitionId']),
      toolVersionId: IdentifierSchemas.toolVersionId.parse(record['toolVersionId']),
      currency: 'USD',
      costMicrounits: record['costMicrounits'],
      createdAt,
      publishedAt,
    }
  } catch {
    throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
  }
}

function parseOperatorTimestamp(value: string): string {
  const parsed = Date.parse(value)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error('LOCAL_GRAPH_CONFIG_INVALID')
  }
  return value
}

function assertLocalGraphConfigurationCompatible(
  options: LocalControlPlaneStartOptions,
  graphRuntime: ManagedLocalGraphRuntimeOptions | undefined,
  environment: Readonly<Record<string, string | undefined>>
): void {
  if (graphRuntime === undefined) return
  const compositionOptions = options.compositionOptions
  if (
    options.composition !== undefined ||
    compositionOptions?.graphRuntime !== undefined ||
    compositionOptions?.graphActivities !== undefined ||
    compositionOptions?.graphActivitiesFactory !== undefined ||
    compositionOptions?.activities !== undefined
  ) {
    throw new Error('LOCAL_GRAPH_CONFIGURATION_CONFLICT')
  }
  if (
    compositionOptions?.runtimeTransport === undefined &&
    compositionOptions?.runtimeFactory === undefined &&
    resolveLocalRuntimeOptions(environment).runtimeFactory === undefined
  ) {
    throw new Error('LOCAL_GRAPH_RUNTIME_REQUIRED')
  }
}

function createLocalGraphRuntimeOptions(
  config: LocalGraphToolConfiguration,
  onOperationsReady?: (operations: LocalGraphToolOperations) => void
): ManagedLocalGraphRuntimeOptions {
  let operations: LocalGraphToolOperations | undefined
  const requireOperations = () => {
    if (operations === undefined) throw new Error('LOCAL_GRAPH_TOOL_NOT_INITIALIZED')
    return operations
  }
  const operationPort: GraphNodeOperationPort = {
    invoke: (operation: GraphNodeOperation) => requireOperations().invoke(operation),
    cancel: (executionId, threadId, idempotencyKey) =>
      requireOperations().cancel(executionId, threadId, idempotencyKey),
  }
  return {
    capabilities: [GRAPH_TOOL_PINS_CAPABILITY],
    compiler: {
      operationAllowlist: [{ kind: 'tool', name: LOCAL_GRAPH_NODE_ALIAS }],
      schemaRegistry: {
        getValidator(reference) {
          if (reference === 'local.graph-json-object.v1') return isJsonObject
          if (reference === 'local.graph-state.v1') return isLocalGraphState
          return undefined
        },
      },
      maximumSteps: 8,
    },
    operations: operationPort,
    initialize: async (resources) => {
      await assertUnchangedLocalGraphConfiguration(resources.persistence, config)
      const registry = new ToolRegistry(
        new SqliteToolRegistryRepository(resources.persistence, config.workspaceId)
      )
      const definition = localGraphToolDefinition(config)
      const draft = localGraphToolVersionDraft(config)
      await ensureLocalGraphToolDefinition(registry, definition, config.workspaceId)
      await ensureLocalGraphToolVersion(registry, draft, config.workspaceId)
      const version = await registry.readVersion(config.toolVersionId, config.workspaceId)
      if (version.lifecycle !== 'published' && version.lifecycle !== 'deprecated') {
        throw new Error('LOCAL_GRAPH_TOOL_VERSION_UNAVAILABLE')
      }
      await pinLocalGraphConfiguration(resources.persistence, config)
      operations = new LocalGraphToolOperations({
        api: resources.api,
        persistence: resources.persistence,
        objectStore: resources.objectStore,
        prices: [
          {
            pin: {
              toolDefinitionId: version.toolDefinitionId,
              toolVersionId: version.toolVersionId,
              contentDigest: version.contentDigest,
              operation: LOCAL_GRAPH_TOOL_OPERATION,
            },
            currency: config.currency,
            costMicrounits: config.costMicrounits,
          },
        ],
      })
      onOperationsReady?.(operations)
    },
  }
}

function localGraphToolDefinition(config: LocalGraphToolConfiguration): ToolDefinition {
  return {
    toolDefinitionId: config.toolDefinitionId,
    name: LOCAL_GRAPH_TOOL_NAME,
    displayName: 'Local JSON Object Store',
    description:
      'Stores canonical JSON as an immutable Local Artifact and returns its Artifact reference and SHA-256 digest.',
    ownership: { scope: 'workspace', workspaceId: config.workspaceId },
    createdAt: config.createdAt,
  }
}

function localGraphToolVersionDraft(config: LocalGraphToolConfiguration): ToolVersionDraft {
  return {
    toolDefinitionId: config.toolDefinitionId,
    toolVersionId: config.toolVersionId,
    semanticVersion: LOCAL_GRAPH_TOOL_VERSION,
    operations: [
      {
        name: LOCAL_GRAPH_TOOL_OPERATION,
        riskClass: 'medium',
        approvalMode: 'always',
        idempotency: 'inherent',
        requiredCapabilities: ['object-store.write'],
      },
    ],
    executor: { type: 'internal', reference: LOCAL_GRAPH_TOOL_EXECUTOR },
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: {
      type: 'object',
      properties: {
        artifactRef: { type: 'string', pattern: '^art_[0-9A-HJKMNP-TV-Z]{26}$' },
        contentDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        size: { type: 'integer', minimum: 0 },
      },
      required: ['artifactRef', 'contentDigest', 'size'],
      additionalProperties: false,
    },
    limits: { maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 5000 },
    createdAt: config.createdAt,
    publishedAt: config.publishedAt,
  }
}

async function assertUnchangedLocalGraphConfiguration(
  persistence: SqlitePersistenceProvider,
  config: LocalGraphToolConfiguration
): Promise<void> {
  const configDigest = createHash('sha256').update(canonicalJsonStringify(config)).digest('hex')
  const current = await persistence.transaction((transaction) =>
    transaction.get('local-graph-launcher-config', config.workspaceId)
  )
  if (current !== undefined) {
    const value = current.value as { readonly schemaVersion?: unknown; readonly digest?: unknown }
    if (value.schemaVersion !== 1 || value.digest !== configDigest) {
      throw new Error('LOCAL_GRAPH_CONFIGURATION_CHANGED')
    }
  }
}

async function pinLocalGraphConfiguration(
  persistence: SqlitePersistenceProvider,
  config: LocalGraphToolConfiguration
): Promise<void> {
  const configDigest = createHash('sha256').update(canonicalJsonStringify(config)).digest('hex')
  await persistence.transaction(async (transaction) => {
    const current = await transaction.get('local-graph-launcher-config', config.workspaceId)
    if (current !== undefined) {
      const value = current.value as { readonly schemaVersion?: unknown; readonly digest?: unknown }
      if (value.schemaVersion !== 1 || value.digest !== configDigest) {
        throw new Error('LOCAL_GRAPH_CONFIGURATION_CHANGED')
      }
      return
    }
    await transaction.put({
      namespace: 'local-graph-launcher-config',
      id: config.workspaceId,
      value: { schemaVersion: 1, digest: configDigest },
    })
  })
}

async function ensureLocalGraphToolDefinition(
  registry: ToolRegistry,
  definition: ToolDefinition,
  workspaceId: string
): Promise<void> {
  try {
    await registry.createDefinition(definition)
  } catch (error) {
    if (!(error instanceof ToolRegistryError) || error.code !== 'DEFINITION_EXISTS') throw error
  }
  const stored = await registry.readDefinition(definition.toolDefinitionId, workspaceId)
  if (!isDeepStrictEqual(stored, definition)) {
    throw new Error('LOCAL_GRAPH_TOOL_DEFINITION_CONFLICT')
  }
}

async function ensureLocalGraphToolVersion(
  registry: ToolRegistry,
  draft: ToolVersionDraft,
  workspaceId: string
): Promise<void> {
  try {
    await registry.publishVersion(draft)
  } catch (error) {
    if (
      !(error instanceof ToolRegistryError) ||
      !['VERSION_EXISTS', 'SEMANTIC_VERSION_CONFLICT'].includes(error.code)
    ) {
      throw error
    }
  }
  const version = await registry.readVersion(draft.toolVersionId, workspaceId)
  const { revision: _revision, lifecycle, contentDigest: _contentDigest, ...storedDraft } = version
  if (
    !isDeepStrictEqual(storedDraft, draft) ||
    (lifecycle !== 'published' && lifecycle !== 'deprecated')
  ) {
    throw new Error('LOCAL_GRAPH_TOOL_VERSION_CONFLICT')
  }
  const sameName = (await registry.list(workspaceId)).flatMap((entry) =>
    entry.definition.name === LOCAL_GRAPH_TOOL_NAME ? entry.versions : []
  )
  if (
    sameName.some(
      (candidate) =>
        candidate.toolVersionId !== draft.toolVersionId &&
        candidate.semanticVersion === LOCAL_GRAPH_TOOL_VERSION
    )
  ) {
    throw new Error('LOCAL_GRAPH_TOOL_VERSION_CONFLICT')
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function isLocalGraphState(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    isJsonObject(value['input']) &&
    isJsonObject(value['values']) &&
    isJsonObject(value['output'])
  )
}

export {
  LocalGraphToolOperations,
  type LocalGraphToolOperationsOptions,
  type LocalGraphToolPrice,
} from './local-graph-tool-operations.js'
