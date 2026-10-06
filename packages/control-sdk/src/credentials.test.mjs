import { expect, test } from 'bun:test'
import { ControlPlaneClient, CredentialApiFixtures } from './index.ts'

test('SDK credential methods use versioned routes and parse metadata-only responses', async () => {
  const calls = []
  let respond = (body, fixture) => fixture
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'fixture-token',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, init, body })
      const fixture = Object.values(CredentialApiFixtures).find(
        ({ request }) => request.operation === body.operation
      ).response
      return Response.json(respond(body, { ...fixture, requestId: body.requestId }))
    },
  })
  const created = await client.createCredential(CredentialApiFixtures.create.request)
  expect(created.data.credential).toEqual(CredentialApiFixtures.create.response.data.credential)
  await client.rotateCredential(CredentialApiFixtures.rotate.request)
  await client.revokeCredential(CredentialApiFixtures.revoke.request)
  await client.getCredential(CredentialApiFixtures.get.request)
  await client.listCredentials(CredentialApiFixtures.list.request)
  expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
    '/v1/credentials/create',
    '/v1/credentials/rotate',
    '/v1/credentials/revoke',
    '/v1/credentials/get',
    '/v1/credentials/list',
  ])
  for (const { init } of calls) expect(init.headers.authorization).toBe('Bearer fixture-token')

  // A server response that leaks secret material does not satisfy the response contract.
  respond = (_body, fixture) => ({
    ...fixture,
    data: { credential: { ...fixture.data.credential, secret: 'leaked-secret-value' } },
  })
  await expect(client.getCredential(CredentialApiFixtures.get.request)).rejects.toThrow()

  // Invalid secrets fail locally before any request is sent.
  const before = calls.length
  await expect(
    client.createCredential({
      ...CredentialApiFixtures.create.request,
      payload: { ...CredentialApiFixtures.create.request.payload, secret: 'bad\nsecret-value' },
    })
  ).rejects.toThrow()
  expect(calls).toHaveLength(before)
})
