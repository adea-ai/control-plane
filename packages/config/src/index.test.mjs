import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigurationError,
  loadDatabaseCredentials,
  loadEnvironment,
  loadServiceConfiguration,
  redactDiagnostics,
} from './index.ts'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-config-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('loadServiceConfiguration', () => {
  test('rejects unsupported environments', async () => {
    await expect(
      loadServiceConfiguration('control-api', { APP_ENV: 'preview' })
    ).rejects.toBeInstanceOf(ConfigurationError)
  })

  test('fails closed when production metadata is incomplete without exposing values', async () => {
    const environment = {
      APP_ENV: 'production',
      SERVICE_VERSION: '1.2.3',
      DATABASE_URL: 'postgres://admin:top-secret@example.internal/control-plane',
    }

    try {
      await loadServiceConfiguration('control-api', environment)
      throw new Error('Expected configuration loading to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError)
      expect(error.diagnostic).toEqual({
        code: 'INVALID_CONFIGURATION',
        environment: 'production',
        serviceName: 'control-api',
        invalid: [],
        missing: ['COMMIT_SHA'],
      })
      expect(JSON.stringify(error)).not.toContain('top-secret')
    }
  })

  test('uses Railway deployment metadata when application aliases are absent', async () => {
    const configuration = await loadServiceConfiguration('runtime-gateway', {
      APP_ENV: 'production',
      RAILWAY_DEPLOYMENT_ID: 'railway-deployment-123',
      RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef',
    })

    expect(configuration.metadata).toEqual(
      expect.objectContaining({
        commitSha: '0123456789abcdef',
        version: 'railway-deployment-123',
      })
    )
  })

  test('keeps explicit application metadata authoritative on Railway', async () => {
    const configuration = await loadServiceConfiguration('runtime-gateway', {
      APP_ENV: 'production',
      COMMIT_SHA: 'explicit-commit',
      SERVICE_VERSION: 'explicit-version',
      RAILWAY_DEPLOYMENT_ID: 'railway-deployment-123',
      RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef',
    })

    expect(configuration.metadata).toEqual(
      expect.objectContaining({ commitSha: 'explicit-commit', version: 'explicit-version' })
    )
  })

  test('provides distinct typed configuration surfaces for HTTP services and workers', async () => {
    const metadata = {
      APP_ENV: 'test',
      SERVICE_VERSION: '1.2.3',
      COMMIT_SHA: 'abc123',
      INSTANCE_ID: 'test-instance',
    }
    const api = await loadServiceConfiguration('control-api', {
      ...metadata,
      CONTROL_API_PORT: '4100',
    })
    const worker = await loadServiceConfiguration('workflow-worker', {
      ...metadata,
      WORKFLOW_WORKER_CONCURRENCY: '7',
    })

    expect(api.values).toEqual({ port: 4100 })
    expect(worker.values).toEqual({ concurrency: 7 })
    expect(api.metadata.serviceName).toBe('control-api')
    expect(worker.metadata.serviceName).toBe('workflow-worker')
  })

  test('uses Railway PORT for Control API unless the explicit service port wins', async () => {
    const metadata = {
      APP_ENV: 'test',
      SERVICE_VERSION: '1.2.3',
      COMMIT_SHA: 'abc123',
      INSTANCE_ID: 'test-instance',
      PORT: '4200',
    }

    expect((await loadServiceConfiguration('control-api', metadata)).values).toEqual({ port: 4200 })
    expect(
      (
        await loadServiceConfiguration('control-api', {
          ...metadata,
          CONTROL_API_PORT: '4300',
        })
      ).values
    ).toEqual({ port: 4300 })
  })
})

describe('loadEnvironment', () => {
  test('loads local development files without mutating or leaking between environments', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, '.env'), 'CONTROL_API_PORT=4001\nSHARED_VALUE=base\n')
    await writeFile(join(cwd, '.env.development'), 'CONTROL_API_PORT=4002\nDEV_ONLY=true\n')
    await writeFile(join(cwd, '.env.test'), 'CONTROL_API_PORT=4003\nTEST_ONLY=true\n')
    const developmentBase = Object.freeze({ APP_ENV: 'development', CONTROL_API_PORT: '4999' })

    const development = await loadEnvironment(developmentBase, { cwd })
    const testEnvironment = await loadEnvironment({ APP_ENV: 'test' }, { cwd })

    expect(development.CONTROL_API_PORT).toBe('4999')
    expect(development.DEV_ONLY).toBe('true')
    expect(development.TEST_ONLY).toBeUndefined()
    expect(testEnvironment.CONTROL_API_PORT).toBe('4003')
    expect(testEnvironment.TEST_ONLY).toBe('true')
    expect(developmentBase).toEqual({ APP_ENV: 'development', CONTROL_API_PORT: '4999' })
  })

  test('never loads dotenv files in production', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, '.env'), 'COMMIT_SHA=from-file\nDATABASE_URL=secret-from-file\n')

    const environment = await loadEnvironment(
      { APP_ENV: 'production', SERVICE_VERSION: '1.2.3' },
      { cwd }
    )

    expect(environment.COMMIT_SHA).toBeUndefined()
    expect(environment.DATABASE_URL).toBeUndefined()
  })
})

describe('loadDatabaseCredentials', () => {
  test('keeps application, migration, and administration credentials distinct', () => {
    const environment = {
      DATABASE_URL: 'postgresql://app:app-secret@database/control_plane',
      DATABASE_MIGRATION_URL: 'postgresql://migrator:migration-secret@database/control_plane',
      DATABASE_ADMIN_URL: 'postgresql://admin:admin-secret@database/postgres',
    }

    expect(loadDatabaseCredentials(environment, 'application').url).toContain('app-secret')
    expect(loadDatabaseCredentials(environment, 'migration').url).toContain('migration-secret')
    expect(loadDatabaseCredentials(environment, 'administration').url).toContain('admin-secret')
  })

  test('reports only a missing credential name', () => {
    try {
      loadDatabaseCredentials(
        { DATABASE_URL: 'postgresql://app:secret@database/control_plane' },
        'migration'
      )
      throw new Error('Expected credential loading to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError)
      expect(error.diagnostic).toEqual({
        code: 'INVALID_DATABASE_CONFIGURATION',
        invalid: [],
        missing: ['DATABASE_MIGRATION_URL'],
        role: 'migration',
      })
      expect(JSON.stringify(error)).not.toContain('postgresql://')
    }
  })
})

test('redacts nested and explicitly named secrets without mutating input', () => {
  const diagnostic = {
    databaseUrl: 'postgres://admin:secret@example.internal/control-plane',
    headers: { authorization: 'Bearer super-secret', requestId: 'request-1' },
    nested: [{ customCredential: 'credential-value', safe: true }],
  }

  const redacted = redactDiagnostics(diagnostic, ['databaseUrl'])

  expect(redacted).toEqual({
    databaseUrl: '[REDACTED]',
    headers: { authorization: '[REDACTED]', requestId: 'request-1' },
    nested: [{ customCredential: '[REDACTED]', safe: true }],
  })
  expect(diagnostic.databaseUrl).toContain('secret')
})
