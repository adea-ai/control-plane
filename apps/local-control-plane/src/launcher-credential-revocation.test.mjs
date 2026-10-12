import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { CredentialApiFixtures } from '@control-plane/contracts'
import { start } from './index.ts'

// Synthetic marker only. It must never be echoed by the API or written to the database.
const CANARY = 'launcher-credential-revocation-SECRET-canary-3b9d'
const OPERATOR_KEY = 'e'.repeat(64)

async function startLocal(dataDirectory, environment) {
  return start({
    apiHost: '127.0.0.1',
    environment,
    logger: { write() {} },
    processAdapter: createProcessAdapter(),
    compositionOptions: {
      dataDirectory,
      runtimeTransport: { transportKind: 'direct-local' },
    },
  })
}

function createProcessAdapter() {
  const listeners = new Map()
  return {
    on(event, listener) {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    setExitCode() {},
  }
}

async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('LOCAL_TEST_PORT_UNAVAILABLE')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

async function post(baseUrl, url, payload, token) {
  const response = await fetch(new URL(url, baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, text: await response.text() }
}

test('the Local launcher serves credential revocation only with the operator-supplied key', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-credential-launcher-'))
  const port = await freeLoopbackPort()
  const baseUrl = `http://127.0.0.1:${port}`
  let service
  try {
    service = await startLocal(dataDirectory, {
      APP_ENV: 'test',
      INSTANCE_ID: 'local-credential-launcher-test',
      LOCAL_CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_SECRET_ENCRYPTION_KEY: OPERATOR_KEY,
    })
    expect(service.readiness().status).toBe('ready')
    const token = (await readFile(join(dataDirectory, 'auth', 'local-api.token'), 'utf8')).trim()

    const created = await post(
      baseUrl,
      '/v1/credentials/create',
      {
        ...CredentialApiFixtures.create.request,
        payload: { ...CredentialApiFixtures.create.request.payload, secret: CANARY },
      },
      token
    )
    expect(created.status).toBe(200)
    expect(created.text.includes(CANARY)).toBe(false)
    const credentialId = JSON.parse(created.text).data.credential.credentialId

    const revoked = await post(
      baseUrl,
      '/v1/credentials/revoke',
      { ...CredentialApiFixtures.revoke.request, payload: { credentialId } },
      token
    )
    expect(revoked.status).toBe(200)
    expect(JSON.parse(revoked.text).data.credential.status).toBe('revoked')
  } finally {
    if (service) await service.shutdown('launcher-credential-revocation-finally')
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('the Local launcher without the operator key reports credential revocation as unavailable', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-credential-launcher-off-'))
  const port = await freeLoopbackPort()
  const baseUrl = `http://127.0.0.1:${port}`
  let service
  try {
    service = await startLocal(dataDirectory, {
      APP_ENV: 'test',
      INSTANCE_ID: 'local-credential-launcher-off-test',
      LOCAL_CONTROL_PLANE_PORT: String(port),
    })
    const token = (await readFile(join(dataDirectory, 'auth', 'local-api.token'), 'utf8')).trim()
    const response = await post(
      baseUrl,
      '/v1/credentials/revoke',
      { ...CredentialApiFixtures.revoke.request, payload: { credentialId: 'credential-none' } },
      token
    )
    expect(response.status).toBe(503)
    expect(JSON.parse(response.text).error.code).toBe('CREDENTIAL_VAULT_NOT_CONFIGURED')
  } finally {
    if (service) await service.shutdown('launcher-credential-unavailable-finally')
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('a malformed operator key stops the Local launcher before it serves any request', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-credential-launcher-bad-'))
  const port = await freeLoopbackPort()
  try {
    await expect(
      startLocal(dataDirectory, {
        APP_ENV: 'test',
        INSTANCE_ID: 'local-credential-launcher-bad-test',
        LOCAL_CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_SECRET_ENCRYPTION_KEY: 'not-a-valid-key',
      })
    ).rejects.toThrow()
  } finally {
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
