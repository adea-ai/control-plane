import {
  EnvironmentNameError,
  loadEnvironment,
  resolveApplicationEnvironment,
  type EnvironmentLoadOptions,
  type RawEnvironment,
} from './environment.js'
import { parseApplicationMetadata, type ApplicationMetadata } from './metadata.js'

export const serviceNames = [
  'control-api',
  'workflow-worker',
  'runtime-worker',
  'runtime-gateway',
  'tool-gateway',
  'local-control-plane',
  'hosted-control-plane',
] as const

export type ServiceName = (typeof serviceNames)[number]

type ServiceValues = {
  readonly 'control-api': { readonly port: number }
  readonly 'workflow-worker': { readonly concurrency: number }
  readonly 'runtime-worker': { readonly concurrency: number }
  readonly 'runtime-gateway': { readonly port: number }
  readonly 'tool-gateway': { readonly port: number }
  readonly 'local-control-plane': { readonly port: number }
  readonly 'hosted-control-plane': { readonly port: number }
}

export interface ServiceConfiguration<Service extends ServiceName> {
  readonly metadata: ApplicationMetadata<Service>
  readonly values: ServiceValues[Service]
}

interface IntegerField {
  readonly environmentVariable: string
  readonly property: 'port' | 'concurrency'
  readonly defaultValue: number
  readonly maximum: number
}

const fields = {
  'control-api': {
    environmentVariable: 'CONTROL_API_PORT',
    property: 'port',
    defaultValue: 3000,
    maximum: 65_535,
  },
  'workflow-worker': {
    environmentVariable: 'WORKFLOW_WORKER_CONCURRENCY',
    property: 'concurrency',
    defaultValue: 1,
    maximum: 256,
  },
  'runtime-worker': {
    environmentVariable: 'RUNTIME_WORKER_CONCURRENCY',
    property: 'concurrency',
    defaultValue: 1,
    maximum: 256,
  },
  'runtime-gateway': {
    environmentVariable: 'RUNTIME_GATEWAY_PORT',
    property: 'port',
    defaultValue: 3001,
    maximum: 65_535,
  },
  'tool-gateway': {
    environmentVariable: 'TOOL_GATEWAY_PORT',
    property: 'port',
    defaultValue: 3002,
    maximum: 65_535,
  },
  'local-control-plane': {
    environmentVariable: 'LOCAL_CONTROL_PLANE_PORT',
    property: 'port',
    defaultValue: 3210,
    maximum: 65_535,
  },
  'hosted-control-plane': {
    environmentVariable: 'HOSTED_CONTROL_PLANE_PORT',
    property: 'port',
    defaultValue: 3000,
    maximum: 65_535,
  },
} as const satisfies Record<ServiceName, IntegerField>

export class ConfigurationError extends Error {
  readonly diagnostic: Readonly<Record<string, unknown>>

  constructor(diagnostic: Readonly<Record<string, unknown>>) {
    super('Service configuration is invalid')
    this.name = 'ConfigurationError'
    this.diagnostic = diagnostic
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { name: this.name, message: this.message, diagnostic: this.diagnostic }
  }
}

export async function loadServiceConfiguration<Service extends ServiceName>(
  serviceName: Service,
  baseEnvironment: RawEnvironment,
  options: EnvironmentLoadOptions = {}
): Promise<ServiceConfiguration<Service>> {
  let environment: RawEnvironment
  try {
    environment = await loadEnvironment(baseEnvironment, options)
  } catch (error) {
    if (error instanceof EnvironmentNameError) {
      throw configurationError(serviceName, 'invalid', ['APP_ENV'], [])
    }
    throw error
  }

  const applicationEnvironment = resolveApplicationEnvironment(environment)
  const metadataResult = parseApplicationMetadata(serviceName, applicationEnvironment, environment)
  const field = fields[serviceName]
  const configuredValue =
    environment[field.environmentVariable] ??
    (serviceName === 'control-api' ? environment['PORT'] : undefined)
  const parsedValue = parseInteger(configuredValue, field)
  const invalid = [
    ...metadataResult.invalid,
    ...(parsedValue === undefined ? [field.environmentVariable] : []),
  ]
  if (!metadataResult.metadata || metadataResult.missing.length || invalid.length) {
    throw configurationError(serviceName, applicationEnvironment, invalid, metadataResult.missing)
  }

  return {
    metadata: metadataResult.metadata,
    values: { [field.property]: parsedValue } as ServiceValues[Service],
  }
}

function parseInteger(value: string | undefined, field: IntegerField): number | undefined {
  if (value === undefined || value === '') return field.defaultValue
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= field.maximum ? parsed : undefined
}

function configurationError(
  serviceName: string,
  environment: string,
  invalid: readonly string[],
  missing: readonly string[]
): ConfigurationError {
  return new ConfigurationError({
    code: 'INVALID_CONFIGURATION',
    environment,
    serviceName,
    invalid: [...invalid].toSorted(),
    missing: [...missing].toSorted(),
  })
}
