import { homedir } from 'node:os'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  bootstrapService,
  jsonLogger,
  type ProcessAdapter,
  type StructuredLogger,
} from '@control-plane/bootstrap'
import type { RawEnvironment } from '@control-plane/config'
import {
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '@control-plane/control-api'
import { createS3CompatibleObjectStore } from '@control-plane/object-store'
import {
  HostedServerControlPlaneComposition,
  type HostedServerCompositionOptions,
} from './composition.js'
import { parseHostedGraphToolConfiguration } from './hosted-graph-tool-operations.js'
import { hostedDependencyReadiness } from './dependency-readiness.js'

export const serviceName = 'hosted-control-plane'

export interface HostedControlPlaneStartOptions {
  readonly apiHost?: string
  readonly environment?: RawEnvironment
  readonly logger?: StructuredLogger
  readonly processAdapter?: ProcessAdapter
  readonly composition?: HostedServerControlPlaneComposition
  readonly compositionOptions?: Partial<HostedServerCompositionOptions>
}

export const start = (options: HostedControlPlaneStartOptions = {}) =>
  bootstrapService({
    serviceName,
    logger: options.logger ?? jsonLogger,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.processAdapter === undefined ? {} : { processAdapter: options.processAdapter }),
    start: async ({ config, health, markReady, readiness, registerResource }) => {
      const environment = options.environment ?? process.env
      const graphEnabled =
        options.compositionOptions?.hostedGraphEnabled ?? resolveHostedGraphEnabled(environment)
      const graphConfigPath = environment['CONTROL_PLANE_HOSTED_GRAPH_TOOL_CONFIG']
      if (
        options.compositionOptions?.hostedGraphToolConfiguration !== undefined &&
        graphConfigPath !== undefined
      ) {
        throw new Error('HOSTED_GRAPH_TOOL_CONFIG_CONFLICT')
      }
      if (
        !graphEnabled &&
        (options.compositionOptions?.hostedGraphToolConfiguration !== undefined ||
          graphConfigPath !== undefined)
      ) {
        throw new Error('HOSTED_GRAPH_TOOL_CONFIG_DISABLED')
      }
      const graphConfiguration = graphEnabled
        ? (options.compositionOptions?.hostedGraphToolConfiguration ??
          (await resolveHostedGraphToolConfiguration(environment)))
        : undefined
      if (graphEnabled && graphConfiguration === undefined) {
        throw new Error('HOSTED_GRAPH_TOOL_CONFIG_REQUIRED')
      }
      const composition =
        options.composition ??
        new HostedServerControlPlaneComposition(
          resolveHostedCompositionConfiguration(environment, {
            ...options.compositionOptions,
            ...(graphConfiguration === undefined
              ? {}
              : { hostedGraphToolConfiguration: graphConfiguration }),
          })
        )
      registerResource('hosted-control-plane-composition', () => composition.close())
      await composition.start()
      const authentication = await createPrivateApiAuthentication(composition.dataDirectory)
      const application = await createControlApiApplication({
        executionAcceptanceService: composition.executionAcceptanceService,
        interactionCommandService: composition.interactionCommandService,
        executionCancellationService: composition.executionCancellationService,
        executionValidationService: composition.executionValidationService,
        graphAdministrationService: composition.graphAdministrationService,
        workspaceCatalogService: composition.createWorkspaceCatalogService(
          options.logger ?? jsonLogger
        ),
        profileResolutionService: composition.profileResolutionService,
        projectStateResolutionService: composition.projectStateResolutionService,
        projectStateInitializationService: composition.projectStateInitializationService,
        contextPackageResolutionService: composition.contextPackageResolutionService,
        runtimeDiscoveryRepository: composition.runtimeDiscoveryRepository,
        serviceAuthenticator: authentication.authenticator,
        componentManifest: () => composition.manifest(),
        dependencyReadiness: () => hostedDependencyReadiness(composition),
        health,
        logger: options.logger ?? jsonLogger,
        metadata: config.metadata,
        readiness,
      })
      registerResource('hosted-control-plane-api', () => application.close())
      await application.listen({
        host: resolveHostedApiHost(options.apiHost),
        port: config.values.port,
      })
      markReady()
    },
  })

export function resolveHostedCompositionConfiguration(
  environment: RawEnvironment,
  options: Partial<HostedServerCompositionOptions> = {}
): HostedServerCompositionOptions {
  const optional = <Key extends keyof HostedServerCompositionOptions>(key: Key) =>
    options[key] === undefined ? {} : { [key]: options[key] }
  const restateAdminUrl = options.restateAdminUrl ?? environment['RESTATE_ADMIN_URL']
  const restateIngressUrl = options.restateIngressUrl ?? environment['RESTATE_INGRESS_URL']
  const requestIdentityPublicKey =
    options.requestIdentityPublicKey ?? environment['RESTATE_REQUEST_IDENTITY_PUBLIC_KEY']
  const workflowDeploymentUri =
    options.workflowDeploymentUri ?? environment['WORKFLOW_DEPLOYMENT_URI']
  const pinnedHarnessId = options.pinnedHarnessId ?? environment['CONTROL_PLANE_PINNED_HARNESS_ID']
  const catalogApprovalPolicy = resolveCatalogApprovalPolicy(environment)
  const hostedGraphEnabled = options.hostedGraphEnabled ?? resolveHostedGraphEnabled(environment)
  if (hostedGraphEnabled !== (options.hostedGraphToolConfiguration !== undefined)) {
    throw new Error(
      hostedGraphEnabled ? 'HOSTED_GRAPH_TOOL_CONFIG_REQUIRED' : 'HOSTED_GRAPH_TOOL_CONFIG_DISABLED'
    )
  }
  return {
    dataDirectory:
      options.dataDirectory ??
      environment['CONTROL_PLANE_DATA_DIR'] ??
      join(homedir(), '.control-plane-hosted'),
    databaseUrl: options.databaseUrl ?? requiredEnvironment(environment, 'DATABASE_URL'),
    ...(restateAdminUrl === undefined ? {} : { restateAdminUrl }),
    ...(restateIngressUrl === undefined ? {} : { restateIngressUrl }),
    ...(requestIdentityPublicKey === undefined ? {} : { requestIdentityPublicKey }),
    ...(workflowDeploymentUri === undefined ? {} : { workflowDeploymentUri }),
    ...(pinnedHarnessId === undefined ? {} : { pinnedHarnessId }),
    ...(catalogApprovalPolicy === undefined ? {} : { catalogApprovalPolicy }),
    hostedGraphEnabled,
    ...(options.hostedGraphToolConfiguration === undefined
      ? {}
      : { hostedGraphToolConfiguration: options.hostedGraphToolConfiguration }),
    ...resolveHostedObjectStore(environment, options),
    ...optional('workflowEndpointPort'),
    ...optional('endpointFactory'),
    ...optional('connection'),
    ...optional('secrets'),
    ...optional('workflowRuntime'),
    ...optional('remoteControl'),
    ...optional('remoteControlFactory'),
    ...optional('runtimeActivityPort'),
    ...optional('graphActivities'),
    ...optional('contextAuthoring'),
    ...optional('memoryWriteback'),
  }
}

const HOSTED_GRAPH_CONFIG_MAX_BYTES = 16_384

/** Reads only an operator-owned regular JSON file; runtime graph callers cannot set pricing. */
export async function resolveHostedGraphToolConfiguration(
  environment: Readonly<Record<string, string | undefined>>
) {
  const path = environment['CONTROL_PLANE_HOSTED_GRAPH_TOOL_CONFIG']
  if (path === undefined) return undefined
  if (!path || !isAbsolute(path)) throw new Error('HOSTED_GRAPH_TOOL_CONFIG_PATH_INVALID')
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > HOSTED_GRAPH_CONFIG_MAX_BYTES) {
      throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
    }
    const contents = await file.readFile('utf8')
    if (Buffer.byteLength(contents, 'utf8') > HOSTED_GRAPH_CONFIG_MAX_BYTES) {
      throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
    }
    return parseHostedGraphToolConfiguration(JSON.parse(contents))
  } catch {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
  } finally {
    await file?.close()
  }
}

function resolveHostedGraphEnabled(environment: RawEnvironment): boolean {
  const value = environment['CONTROL_PLANE_HOSTED_GRAPH_ENABLED']
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new Error('HOSTED_GRAPH_CONFIGURATION_INVALID')
}

export function resolveHostedApiHost(explicitHost?: string): string {
  const host = explicitHost ?? process.env['CONTROL_PLANE_BIND_HOST'] ?? '127.0.0.1'
  if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) {
    throw new Error('HOSTED_CONTROL_PLANE_BIND_HOST_INVALID')
  }
  return host
}

function resolveCatalogApprovalPolicy(
  environment: RawEnvironment
): { readonly required: boolean; readonly requiredSince?: string } | undefined {
  const requiredValue = environment['CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED']
  if (requiredValue === undefined) return undefined
  if (requiredValue !== 'true' && requiredValue !== 'false') {
    throw new Error('HOSTED_CATALOG_APPROVAL_POLICY_INVALID')
  }
  const requiredSince = environment['CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED_SINCE']
  if (requiredSince !== undefined && Number.isNaN(Date.parse(requiredSince))) {
    throw new Error('HOSTED_CATALOG_APPROVAL_POLICY_INVALID')
  }
  return {
    required: requiredValue === 'true',
    ...(requiredSince === undefined ? {} : { requiredSince }),
  }
}

function requiredEnvironment(environment: RawEnvironment, name: string): string {
  const value = environment[name]
  if (value === undefined || value === '') throw new Error(`HOSTED_CONFIGURATION_MISSING_${name}`)
  return value
}

export function resolveHostedObjectStore(
  environment: RawEnvironment,
  options: Partial<HostedServerCompositionOptions> | undefined
): Partial<Pick<HostedServerCompositionOptions, 'objectStore' | 'objectStoreKind'>> {
  if (options?.objectStore !== undefined) {
    return {
      objectStore: options.objectStore,
      objectStoreKind: options.objectStoreKind ?? 'filesystem',
    }
  }
  const kind = options?.objectStoreKind ?? environment['HOSTED_OBJECT_STORE'] ?? 'filesystem'
  if (kind === 'filesystem') return {}
  if (kind !== 's3-compatible') throw new Error('HOSTED_OBJECT_STORE_KIND_INVALID')
  const endpoint = requiredEnvironment(environment, 'S3_ENDPOINT')
  if (!validS3Endpoint(endpoint)) throw new Error('HOSTED_OBJECT_STORE_ENDPOINT_INVALID')
  return {
    objectStoreKind: 's3-compatible' as const,
    objectStore: createS3CompatibleObjectStore(
      {
        endpoint,
        bucket: requiredEnvironment(environment, 'S3_BUCKET'),
        region: requiredEnvironment(environment, 'S3_REGION'),
        accessKeyId: requiredEnvironment(environment, 'S3_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnvironment(environment, 'S3_SECRET_ACCESS_KEY'),
      },
      { maxObjectBytes: 64 * 1024 * 1024 }
    ),
  }
}

function validS3Endpoint(value: string): boolean {
  try {
    const endpoint = new URL(value)
    return (
      endpoint.protocol === 'https:' &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.search === '' &&
      endpoint.hash === ''
    )
  } catch {
    return false
  }
}

export * from './composition.js'
