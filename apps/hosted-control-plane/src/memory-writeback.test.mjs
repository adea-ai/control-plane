import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHostedCompositionConfiguration } from './index.ts'
import { HostedServerControlPlaneComposition } from './composition.ts'
const endpointFactory = {
  create: async () => {
    throw new Error('unexpected endpoint')
  },
}
test('Hosted Server composes disabled memory writes without starting dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-m11-memory-compose-'))
  try {
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory: directory,
      databaseUrl: 'postgresql://unused',
      connection: { database: {}, close: async () => {}, check: async () => {} },
      endpointFactory,
    })
    await expect(composition.memoryWrites.propose({})).rejects.toMatchObject({
      code: 'MEMORY_WRITE_DISABLED',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('Hosted Server validates memory authority before allocating a connection', () => {
  expect(
    () =>
      new HostedServerControlPlaneComposition({
        dataDirectory: '/unused',
        databaseUrl: 'postgresql://unused',
        endpointFactory,
        memoryWriteback: {
          policy: {
            mode: 'proposal_only',
            maximumBytes: 1024,
            allowedSensitivities: ['internal'],
            approvalPrincipalIds: [],
          },
          provider: {},
        },
        get connection() {
          throw new Error('unexpected connection')
        },
      })
  ).toThrow('MEMORY_WRITE_AUTHORITY_UNAVAILABLE')
})

test('Hosted Server start configuration preserves the trusted memory capability', () => {
  const memoryWriteback = {
    policy: {
      mode: 'proposal_only',
      maximumBytes: 1024,
      allowedSensitivities: ['internal'],
      approvalPrincipalIds: [],
    },
    provider: {},
    authority: { authorize: async () => {} },
  }
  expect(
    resolveHostedCompositionConfiguration(
      {},
      { databaseUrl: 'postgresql://unused', memoryWriteback }
    ).memoryWriteback
  ).toBe(memoryWriteback)
})
