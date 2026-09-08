import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  bootstrapService,
  jsonLogger,
  type ProcessAdapter,
  type StructuredLogger,
} from '@control-plane/bootstrap'
import type { RawEnvironment } from '@control-plane/config'
import { createControlApiApplication } from '@control-plane/control-api'
import {
  LocalControlPlaneComposition,
  type LocalControlPlaneCompositionOptions,
} from './composition.js'
import { createLocalApiAuthentication } from './authentication.js'
import { createLocalManagedPiRuntime } from './managed-pi-runtime.js'

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
      const composition =
        options.composition ??
        new LocalControlPlaneComposition({
          dataDirectory:
            options.compositionOptions?.dataDirectory ??
            process.env['CONTROL_PLANE_DATA_DIR'] ??
            join(homedir(), '.control-plane'),
          profile: resolveEmbeddedDeploymentProfile(),
          ...resolveLocalRuntimeOptions(options.environment ?? process.env),
          ...options.compositionOptions,
        })
      registerResource('local-control-plane-composition', () => composition.close())
      await composition.start()
      const authentication = await createLocalApiAuthentication(composition.dataDirectory)
      const application = await createControlApiApplication({
        interactionCommandService: composition.interactionCommandService,
        executionAcceptanceService: composition.executionAcceptanceService,
        executionValidationService: composition.executionValidationService,
        profileResolutionService: composition.profileResolutionService,
        projectStateResolutionService: composition.projectStateResolutionService,
        contextPackageResolutionService: composition.contextPackageResolutionService,
        runtimeDiscoveryRepository: composition.runtimeDiscoveryRepository,
        serviceAuthenticator: authentication.authenticator,
        componentManifest: () => composition.manifest(),
        dependencyReadiness: async () =>
          (await composition.manifest()).components.every((component) => component.ready),
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

export function resolveLocalRuntimeOptions(
  environment: Readonly<Record<string, string | undefined>>
): Pick<LocalControlPlaneCompositionOptions, 'runtimeFactory'> {
  const family = environment['CONTROL_PLANE_LOCAL_RUNTIME']
  if (family === undefined || family.length === 0) return {}
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
