import { randomUUID } from 'node:crypto'
import type { ApplicationEnvironment, RawEnvironment } from './environment.js'

export interface ApplicationMetadata<Service extends string = string> {
  readonly serviceName: Service
  readonly version: string
  readonly commitSha: string
  readonly environment: ApplicationEnvironment
  readonly instanceId: string
}

export interface MetadataParseResult<Service extends string> {
  readonly metadata?: ApplicationMetadata<Service>
  readonly invalid: readonly string[]
  readonly missing: readonly string[]
}

export function parseApplicationMetadata<Service extends string>(
  serviceName: Service,
  applicationEnvironment: ApplicationEnvironment,
  environment: RawEnvironment
): MetadataParseResult<Service> {
  const productionLike = applicationEnvironment === 'production'
  const version = environment['SERVICE_VERSION'] ?? environment['RAILWAY_DEPLOYMENT_ID']
  const commitSha = environment['COMMIT_SHA'] ?? environment['RAILWAY_GIT_COMMIT_SHA']
  const missing = [
    ...(productionLike && !version ? ['SERVICE_VERSION'] : []),
    ...(productionLike && !commitSha ? ['COMMIT_SHA'] : []),
  ]
  const resolvedVersion = version ?? defaultVersion(applicationEnvironment)
  const resolvedCommitSha = commitSha ?? defaultCommit(applicationEnvironment)
  const instanceId = environment['INSTANCE_ID'] ?? randomUUID()
  const invalid = [
    ...(!isMetadataValue(resolvedVersion) ? ['SERVICE_VERSION'] : []),
    ...(!isMetadataValue(resolvedCommitSha) ? ['COMMIT_SHA'] : []),
    ...(!isMetadataValue(instanceId) ? ['INSTANCE_ID'] : []),
  ]
  if (missing.length || invalid.length) return { invalid, missing }

  return {
    invalid,
    missing,
    metadata: {
      serviceName,
      version: resolvedVersion,
      commitSha: resolvedCommitSha,
      environment: applicationEnvironment,
      instanceId,
    },
  }
}

function defaultVersion(environment: ApplicationEnvironment): string {
  return environment === 'test' ? '0.0.0-test' : '0.0.0-development'
}

function defaultCommit(environment: ApplicationEnvironment): string {
  return environment === 'test' ? 'test' : 'local'
}

function isMetadataValue(value: string): boolean {
  return value.trim().length > 0 && value.length <= 128 && !/[\r\n]/.test(value)
}
