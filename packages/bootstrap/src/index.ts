import process from 'node:process'
import {
  ConfigurationError,
  loadServiceConfiguration,
  loadManagedCloudConfiguration,
  managedCloudServices,
  redactDiagnostics,
  type EnvironmentLoadOptions,
  type ManagedCloudConfiguration,
  type RawEnvironment,
  type ServiceName,
} from '@control-plane/config'
import { jsonLogger, type StructuredLogger } from './logger.js'
import { nodeProcessAdapter, type ProcessAdapter } from './process.js'
import { ServiceRuntime, type ServiceStartContext } from './runtime.js'

export const HEALTH_PATH = '/health'
export const READY_PATH = '/ready'

export interface BootstrapOptions<Service extends ServiceName> extends EnvironmentLoadOptions {
  readonly serviceName: Service
  readonly environment?: RawEnvironment
  readonly logger?: StructuredLogger
  readonly processAdapter?: ProcessAdapter
  readonly start: (context: ServiceStartContext<Service>) => void | Promise<void>
}

export interface ServiceStartOptions {
  readonly environment?: RawEnvironment
  readonly logger?: StructuredLogger
  readonly processAdapter?: ProcessAdapter
}

export class ServiceStartupError extends Error {
  constructor() {
    super('Service startup failed')
    this.name = 'ServiceStartupError'
  }
}

export async function bootstrapService<Service extends ServiceName>(
  options: BootstrapOptions<Service>
): Promise<ServiceRuntime<Service>> {
  const logger = options.logger ?? jsonLogger
  const processAdapter = options.processAdapter ?? nodeProcessAdapter
  let config
  let managedCloud: ManagedCloudConfiguration | undefined
  try {
    const environment = options.environment ?? process.env
    config = await loadServiceConfiguration(
      options.serviceName,
      environment,
      options.cwd === undefined ? {} : { cwd: options.cwd }
    )
    if (
      (config.metadata.environment === 'production' ||
        (config.metadata.environment === 'test' &&
          environment['CONTROL_PLANE_CLOUD_RUNTIME'] === 'certification')) &&
      isManagedCloudService(options.serviceName)
    ) {
      managedCloud = loadManagedCloudConfiguration(environment, options.serviceName)
    }
  } catch (error) {
    processAdapter.setExitCode(1)
    logger.write({
      level: 'error',
      event: 'service.configuration_invalid',
      details: error instanceof ConfigurationError ? error.diagnostic : redactDiagnostics(error),
    })
    throw error
  }

  const runtime = new ServiceRuntime(config, logger, processAdapter, managedCloud)
  logger.write({
    level: 'info',
    event: 'service.starting',
    metadata: config.metadata,
    details: { configuration: config.values },
  })
  try {
    await options.start(runtime.context())
    logger.write({ level: 'info', event: 'service.started', metadata: config.metadata })
    return runtime
  } catch (error) {
    await runtime.handleFatal('startup', error)
    throw new ServiceStartupError()
  }
}

function isManagedCloudService(
  service: ServiceName
): service is (typeof managedCloudServices)[number] {
  return (managedCloudServices as readonly ServiceName[]).includes(service)
}

export { jsonLogger } from './logger.js'
export type { StructuredLogEntry, StructuredLogger } from './logger.js'
export type { ProcessAdapter, ProcessEvent, ProcessListener } from './process.js'
export type {
  HealthResponse,
  ReadinessResponse,
  ServiceResource,
  ServiceStartContext,
} from './runtime.js'
export { ServiceRuntime } from './runtime.js'
