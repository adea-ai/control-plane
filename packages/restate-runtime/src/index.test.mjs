import { describe, expect, test } from 'bun:test'
import { LocalRestateRuntime, RemoteRestateRuntime, RESTATE_SERVER_VERSION } from './index.ts'

function processProvider() {
  const launches = []
  const stops = []
  return {
    launches,
    stops,
    provider: {
      launch: async (request) => {
        launches.push(request)
        return {
          pid: 4001,
          startedAt: '2026-08-29T00:00:00.000Z',
          wait: () => new Promise(() => undefined),
          stop: async (signal) => stops.push(signal),
        }
      },
    },
  }
}

describe('LocalRestateRuntime', () => {
  test('keeps all three listeners on explicitly selected isolated ports', async () => {
    const process = processProvider()
    const runtime = new LocalRestateRuntime({
      executablePath: '/opt/control-plane/restate-server',
      dataDirectory: '/tmp/control-plane-restate-isolated-test',
      processProvider: process.provider,
      inspectVersion: async () => RESTATE_SERVER_VERSION,
      adminUrl: 'http://127.0.0.1:49070',
      ingressUrl: 'http://127.0.0.1:48080',
      nodePort: 45122,
      fetch: async () => ({ ok: true }),
    })
    try {
      await runtime.start()
      expect(process.launches[0].environment).toMatchObject({
        RESTATE_ADMIN__BIND_ADDRESS: '127.0.0.1:49070',
        RESTATE_INGRESS__BIND_ADDRESS: '127.0.0.1:48080',
        RESTATE_BIND_PORT: '45122',
      })
    } finally {
      await runtime.stop()
    }
  })

  test('pins 1.7.9, loopback listeners, bounded memory, and durable data', async () => {
    const process = processProvider()
    const runtime = new LocalRestateRuntime({
      executablePath: '/opt/control-plane/restate-server',
      dataDirectory: '/tmp/control-plane-restate-test',
      processProvider: process.provider,
      inspectVersion: async () => RESTATE_SERVER_VERSION,
      fetch: async () => ({ ok: true }),
    })
    await runtime.start()
    expect(process.launches).toHaveLength(1)
    expect(process.launches[0]).toMatchObject({
      executable: '/opt/control-plane/restate-server',
      args: [],
      environment: {
        RESTATE_BASE_DIR: '/tmp/control-plane-restate-test',
        RESTATE_ADMIN__BIND_ADDRESS: '127.0.0.1:9070',
        RESTATE_INGRESS__BIND_ADDRESS: '127.0.0.1:8080',
        RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: '256 MiB',
      },
    })
    expect(await runtime.health()).toMatchObject({ ready: true, version: '1.7.9' })
    await runtime.stop()
    expect(process.stops).toEqual(['SIGTERM'])
  })

  test('fails before launch for an incompatible binary', async () => {
    const process = processProvider()
    const runtime = new LocalRestateRuntime({
      executablePath: '/opt/control-plane/restate-server',
      dataDirectory: '/tmp/control-plane-restate-test',
      processProvider: process.provider,
      inspectVersion: async () => '1.8.0',
    })
    await expect(runtime.start()).rejects.toMatchObject({
      code: 'RESTATE_BINARY_VERSION_MISMATCH',
    })
    expect(process.launches).toHaveLength(0)
  })

  test('stops the owned process when readiness never succeeds', async () => {
    const process = processProvider()
    const runtime = new LocalRestateRuntime({
      executablePath: '/opt/control-plane/restate-server',
      dataDirectory: '/tmp/control-plane-restate-test',
      processProvider: process.provider,
      inspectVersion: async () => RESTATE_SERVER_VERSION,
      fetch: async () => ({ ok: false }),
      readinessTimeoutMs: 1,
      pollIntervalMs: 1,
    })
    await expect(runtime.start()).rejects.toMatchObject({ code: 'RESTATE_READINESS_TIMEOUT' })
    expect(process.stops).toEqual([undefined])
  })

  test('registers the canonical workflow endpoint after Restate is ready', async () => {
    const process = processProvider()
    const requests = []
    const runtime = new LocalRestateRuntime({
      executablePath: '/opt/control-plane/restate-server',
      dataDirectory: '/tmp/control-plane-restate-test',
      deploymentUri: 'http://127.0.0.1:9080',
      processProvider: process.provider,
      inspectVersion: async () => RESTATE_SERVER_VERSION,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith('/health')) return { ok: true }
        return {
          ok: true,
          json: async () => ({
            id: 'dp_local_1',
            services: [{ name: 'execution-lifecycle' }],
          }),
        }
      },
    })

    await runtime.start()

    expect(requests.at(-1)).toMatchObject({
      url: 'http://127.0.0.1:9070/deployments',
      init: { method: 'POST' },
    })
    expect(JSON.parse(requests.at(-1).init.body)).toEqual({
      uri: 'http://127.0.0.1:9080/',
      force: false,
      use_http_11: true,
    })
    expect(await runtime.health()).toMatchObject({
      ready: true,
      details: { deploymentId: 'dp_local_1' },
    })
  })
})

describe('RemoteRestateRuntime', () => {
  test('waits for a private Restate service and registers the hosted endpoint', async () => {
    const requests = []
    const runtime = new RemoteRestateRuntime({
      profile: 'hosted-server',
      adminUrl: 'http://restate:9070',
      ingressUrl: 'http://restate:8080',
      deploymentUri: 'http://control-plane-server:9080',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith('/health')) return { ok: true }
        return {
          ok: true,
          json: async () => ({
            id: 'dp_hosted_1',
            services: [{ name: 'execution-lifecycle' }],
          }),
        }
      },
    })

    await runtime.start()

    expect(requests.at(-1)).toMatchObject({
      url: 'http://restate:9070/deployments',
      init: { method: 'POST' },
    })
    expect(JSON.parse(requests.at(-1).init.body)).toMatchObject({
      uri: 'http://control-plane-server:9080/',
    })
    expect(await runtime.health()).toMatchObject({
      ready: true,
      details: { profile: 'hosted-server', deploymentId: 'dp_hosted_1' },
    })
    await runtime.stop()
    expect(await runtime.health()).toMatchObject({ ready: false })
  })

  test('rejects credential-bearing or non-HTTP service URLs', () => {
    expect(
      () =>
        new RemoteRestateRuntime({
          profile: 'hosted-server',
          adminUrl: 'http://user:secret@restate:9070',
          ingressUrl: 'http://restate:8080',
          deploymentUri: 'http://control-plane-server:9080',
        })
    ).toThrow('Restate runtime operation failed')
    expect(
      () =>
        new RemoteRestateRuntime({
          profile: 'hosted-server',
          adminUrl: 'https://restate:9070',
          ingressUrl: 'http://restate:8080',
          deploymentUri: 'http://control-plane-server:9080',
        })
    ).toThrow('Restate runtime operation failed')
  })
})
