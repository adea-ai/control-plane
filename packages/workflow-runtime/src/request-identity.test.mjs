import http from 'node:http'
import { createPrivateKey, sign } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { createRestateEndpointOptions } from './index.ts'

const requestIdentityPublicKey = 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f'

async function withEndpoint(options, operation) {
  const server = http.createServer(
    restate.createEndpointHandler(createRestateEndpointOptions(options))
  )
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    await operation(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
}

describe('Restate request identity HTTP boundary', () => {
  test('accepts discovery signed by the configured Restate identity', async () => {
    // Public test fixture: the all-zero ED25519 seed, never a deployment credential.
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.alloc(32),
      ]),
      format: 'der',
      type: 'pkcs8',
    })
    const key = 'publickeyv1_4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS'
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const payload = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: key })}.${encode({ aud: '/discover', iat: now, nbf: now - 1, exp: now + 60 })}`
    const token = `${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`
    await withEndpoint({ requestIdentityPublicKey: key }, async (url) => {
      const response = await fetch(`${url}/discover`, {
        headers: {
          accept: 'application/vnd.restate.endpointmanifest.v3+json',
          'x-restate-signature-scheme': 'v1',
          'x-restate-jwt-v1': token,
        },
      })
      expect(response.status).toBe(200)
    })
  })

  test('rejects unsigned discovery when request identity is configured', async () => {
    await withEndpoint({ requestIdentityPublicKey }, async (url) => {
      const response = await fetch(`${url}/discover`, {
        headers: { accept: 'application/vnd.restate.endpointmanifest.v3+json' },
      })
      expect(response.status).toBe(401)
    })
  })

  test('rejects a malformed signature rather than falling back to unsigned discovery', async () => {
    await withEndpoint({ requestIdentityPublicKey }, async (url) => {
      const response = await fetch(`${url}/discover`, {
        headers: {
          accept: 'application/vnd.restate.endpointmanifest.v3+json',
          'x-restate-signature-scheme': 'v1',
          'x-restate-jwt-v1': 'invalid.signature.value',
        },
      })
      expect(response.status).toBe(401)
    })
  })

  test('preserves discovery for the explicitly unsigned loopback Local endpoint', async () => {
    await withEndpoint({}, async (url) => {
      const response = await fetch(`${url}/discover`, {
        headers: { accept: 'application/vnd.restate.endpointmanifest.v3+json' },
      })
      expect(response.status).toBe(200)
    })
  })
})
