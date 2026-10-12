import { expect, mock, test } from 'bun:test'

let composedOptions
mock.module('./composition.js', () => ({
  async composeRuntimeGateway(options) {
    composedOptions = options
    return {
      webSocketServer: { start() {}, close: async () => {} },
      close: async () => {},
    }
  },
  runtimeGatewayStoreConfigFromEnvironment(environment) {
    const backend = environment['RUNTIME_GATEWAY_STORE_BACKEND']
    if (backend === 'sqlite')
      return { backend, path: environment['RUNTIME_GATEWAY_SQLITE_PATH'] ?? '' }
    if (backend === 'postgres') return { backend }
    throw new Error('RUNTIME_GATEWAY_STORE_CONFIG_INVALID')
  },
}))

const { start } = await import('./index.js')

class FakeProcessAdapter {
  listeners = new Map()

  on(event, listener) {
    this.listeners.set(event, listener)
  }

  off(event, listener) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event)
  }

  setExitCode() {}
}

test('forwards the host credential authority', async () => {
  const authority = { validateCredentialFenceInTransaction: async () => true }
  const runtime = await start({
    environment: {
      APP_ENV: 'test',
      COMMIT_SHA: 'runtime-gateway-startup-test',
      INSTANCE_ID: 'runtime-gateway-production-test',
      SERVICE_VERSION: '1.3.0',
    },
    logger: { write: () => undefined },
    processAdapter: new FakeProcessAdapter(),
    store: { backend: 'sqlite', path: '/tmp/runtime-gateway-start-authority.sqlite' },
    objectStore: {},
    authenticateUpgrade: async () => ({}),
    metrics: {},
    reachability: {},
    traceId: () => 'trc_01JABCDEF0123456789ABCDEFG',
    instanceId: 'runtime-gateway-authority-test',
    hostname: '127.0.0.1',
    runtimeNodeCredentialAuthority: authority,
  })

  expect(composedOptions.runtimeNodeCredentialAuthority).toBe(authority)
  await runtime.shutdown('test')
})
