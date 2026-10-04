import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
const { publicKey } = generateKeyPairSync('ed25519')
import { createManagedCloudControlApiComposition } from './cloud-composition.ts'
const configuration = {
  service: 'control-api',
  database: { role: 'application', url: 'postgresql://unused' },
  serviceAuthentication: {
    audience: 'control-plane',
    issuer: 'https://memory-fixture.test',
    trustedKeys: [{ keyId: 'memory-fixture', publicKey: publicKey.export({ format: 'jwk' }).x }],
    revokedCredentialIds: [],
  },
  restate: { role: 'caller', ingressUrl: 'http://127.0.0.1:1' },
}
test('Cloud composes disabled memory writes without a database or provider operation', async () => {
  const composition = createManagedCloudControlApiComposition(
    configuration,
    { write: () => {} },
    () => ({ database: {}, close: async () => {}, check: async () => {} })
  )
  await expect(composition.memoryWrites.propose({})).rejects.toMatchObject({
    code: 'MEMORY_WRITE_DISABLED',
  })
})
test('Cloud rejects a configured provider without authority before connecting', () => {
  let connections = 0
  expect(() =>
    createManagedCloudControlApiComposition(
      configuration,
      { write: () => {} },
      () => {
        connections++
        return { database: {} }
      },
      undefined,
      undefined,
      {
        policy: {
          mode: 'approval_required',
          maximumBytes: 1024,
          allowedSensitivities: ['internal'],
          approvalPrincipalIds: ['svc_agent-hq'],
        },
        provider: {},
      }
    )
  ).toThrow('MEMORY_WRITE_AUTHORITY_UNAVAILABLE')
  expect(connections).toBe(0)
})
