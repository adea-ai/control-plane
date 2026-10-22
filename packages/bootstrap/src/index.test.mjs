import { describe, expect, test } from 'bun:test'
import { bootstrapService, HEALTH_PATH, READY_PATH } from './index.ts'

class FakeProcessAdapter {
  exitCode = undefined
  listeners = new Map()

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener)
  }

  setExitCode(code) {
    this.exitCode = code
  }

  async emit(event, value) {
    await Promise.all([...(this.listeners.get(event) ?? [])].map((listener) => listener(value)))
  }
}

const productionEnvironment = {
  APP_ENV: 'test',
  SERVICE_VERSION: '1.2.3',
  COMMIT_SHA: 'abc123',
  INSTANCE_ID: 'instance-1',
  CONTROL_API_PORT: '4000',
  API_TOKEN: 'must-never-appear',
}

describe('bootstrapService', () => {
  test('provides validated managed-cloud dependencies to staging startup', async () => {
    const logs = []
    let startupConfiguration
    const runtime = await bootstrapService({
      serviceName: 'control-api',
      environment: {
        APP_ENV: 'production',
        SERVICE_VERSION: '1.2.3',
        COMMIT_SHA: 'abc123',
        INSTANCE_ID: 'staging-1',
        DATABASE_URL:
          'postgresql://app:database-secret@postgres.example.invalid/control_plane?sslmode=require',
        CONTROL_PLANE_SECRET_ENCRYPTION_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        CONTROL_PLANE_SERVICE_AUTH_ISSUER: 'https://agent-hq.example',
        CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS: JSON.stringify([
          { keyId: 'agent-hq-2026-08', publicKey: 'A'.repeat(43) },
        ]),
        CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS: '[]',
        R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        R2_BUCKET: 'ctrl-plane',
        R2_REGION: 'auto',
        R2_ACCESS_KEY_ID: 'access-key',
        R2_SECRET_ACCESS_KEY: 'secret-key-that-is-not-logged',
        RESTATE_INGRESS_URL: 'http://control-planerestate.railway.internal:8080',
      },
      logger: { write: (entry) => logs.push(entry) },
      processAdapter: new FakeProcessAdapter(),
      start: async ({ managedCloud, markReady }) => {
        startupConfiguration = managedCloud
        markReady()
      },
    })

    expect(startupConfiguration).toMatchObject({
      service: 'control-api',
      database: { role: 'application' },
      objectStore: { bucket: 'ctrl-plane', region: 'auto' },
    })
    expect(JSON.stringify(logs)).not.toContain('database-secret')
    expect(JSON.stringify(logs)).not.toContain('secret-key-that-is-not-logged')
    await runtime.shutdown('test-complete')
  })

  test('does not fabricate managed-cloud dependencies for test startup', async () => {
    let startupConfiguration = 'not-observed'
    const runtime = await bootstrapService({
      serviceName: 'control-api',
      environment: productionEnvironment,
      processAdapter: new FakeProcessAdapter(),
      start: async ({ managedCloud, markReady }) => {
        startupConfiguration = managedCloud
        markReady()
      },
    })

    expect(startupConfiguration).toBeUndefined()
    await runtime.shutdown('test-complete')
  })

  test('fails closed for a staging service without managed-cloud dependencies', async () => {
    const processAdapter = new FakeProcessAdapter()
    await expect(
      bootstrapService({
        serviceName: 'control-api',
        environment: {
          APP_ENV: 'production',
          SERVICE_VERSION: '1.2.3',
          COMMIT_SHA: 'abc123',
          INSTANCE_ID: 'staging-1',
        },
        processAdapter,
        start: async () => undefined,
      })
    ).rejects.toMatchObject({ diagnostic: { missing: expect.arrayContaining(['DATABASE_URL']) } })
    expect(processAdapter.exitCode).toBe(1)
  })

  test('exposes health and readiness conventions without secrets', async () => {
    const logs = []
    const runtime = await bootstrapService({
      serviceName: 'control-api',
      environment: productionEnvironment,
      logger: { write: (entry) => logs.push(entry) },
      processAdapter: new FakeProcessAdapter(),
      start: async ({ markReady }) => markReady(),
    })

    expect(HEALTH_PATH).toBe('/health')
    expect(READY_PATH).toBe('/ready')
    expect(runtime.health()).toEqual({ status: 'ok', metadata: runtime.metadata })
    expect(runtime.readiness()).toEqual({ status: 'ready', metadata: runtime.metadata })
    expect(
      JSON.stringify({ health: runtime.health(), ready: runtime.readiness(), logs })
    ).not.toContain('must-never-appear')

    await runtime.shutdown('test-complete')
  })

  test('closes registered resources in reverse order before completing shutdown', async () => {
    const closed = []
    const runtime = await bootstrapService({
      serviceName: 'workflow-worker',
      environment: {
        APP_ENV: 'test',
        SERVICE_VERSION: '1.2.3',
        COMMIT_SHA: 'abc123',
        INSTANCE_ID: 'worker-1',
      },
      processAdapter: new FakeProcessAdapter(),
      start: async ({ markReady, registerResource }) => {
        registerResource('database', async () => closed.push('database'))
        registerResource('queue', async () => closed.push('queue'))
        markReady()
      },
    })

    await runtime.shutdown('SIGTERM')
    await runtime.shutdown('duplicate')

    expect(closed).toEqual(['queue', 'database'])
    expect(runtime.readiness().status).toBe('not_ready')
  })

  test('handles termination signals through graceful shutdown', async () => {
    const processAdapter = new FakeProcessAdapter()
    const closed = []
    const runtime = await bootstrapService({
      serviceName: 'runtime-worker',
      environment: {
        APP_ENV: 'test',
        SERVICE_VERSION: '1.2.3',
        COMMIT_SHA: 'abc123',
        INSTANCE_ID: 'worker-1',
      },
      processAdapter,
      start: async ({ registerResource }) => {
        registerResource('runtime', async () => closed.push('runtime'))
      },
    })

    await processAdapter.emit('SIGINT')

    expect(closed).toEqual(['runtime'])
    expect(processAdapter.exitCode).toBe(0)
    expect(runtime.readiness().status).toBe('not_ready')
  })

  test('redacts fatal errors, shuts down, and marks the process failed', async () => {
    const processAdapter = new FakeProcessAdapter()
    const logs = []
    const closed = []
    await bootstrapService({
      serviceName: 'tool-gateway',
      environment: {
        APP_ENV: 'test',
        SERVICE_VERSION: '1.2.3',
        COMMIT_SHA: 'abc123',
        INSTANCE_ID: 'gateway-1',
      },
      logger: { write: (entry) => logs.push(entry) },
      processAdapter,
      start: async ({ registerResource }) => {
        registerResource('server', async () => closed.push('server'))
        throw new Error('startup failed with token=super-secret')
      },
    }).catch(() => undefined)

    expect(closed).toEqual(['server'])
    expect(processAdapter.exitCode).toBe(1)
    expect(JSON.stringify(logs)).not.toContain('super-secret')
  })
})
