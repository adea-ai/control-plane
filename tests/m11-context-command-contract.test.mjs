import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createQueuedContextCommandRecord } from '@control-plane/domain'
import {
  SqliteContextCommandRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { createFakeContextProvider } from '@control-plane/context'
import {
  CortanaContextProviderAdapter,
  FakeCortanaCompatibleServer,
} from '../packages/cortana-context-adapter/src/index.ts'

test('adapter-generated context commands match the durable ledger semantic hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-contract-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'ledger.sqlite') })
  try {
    await provider.migrate()
    const repository = new SqliteContextCommandRepository(provider)
    const bundle = JSON.parse(
      await readFile(
        new URL(
          '../packages/cortana-context-adapter/fixtures/golden/context-bundle.v1.json',
          import.meta.url
        ),
        'utf8'
      )
    )
    const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const now = '2026-08-25T12:00:00.000Z'
    const readModel = createFakeContextProvider({
      suffix: 'A',
      workspaceId,
      scopeDigest: bundle.scopeDigest,
      health: 'healthy',
      state: 'active',
      capabilities: { evidenceSearch: true, memoryRecall: true },
      kind: 'evidence',
      tokenCount: 1,
    }).readModel
    const server = new FakeCortanaCompatibleServer(bundle)
    let captured
    const adapter = new CortanaContextProviderAdapter({
      readModel,
      providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      mappedProjectRef: 'fixture-project',
      transport: 'runtime_node',
      bindRuntimeNodeRead: async ({ providerRef, request }) => ({
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        channelGeneration: 3,
        sequence: 7,
        workspaceId,
        providerRef,
        principalRef: request.principalRef,
        scopeDigest: request.scopeDigest,
        idempotencyKey: 'context-read:contract-test',
        authorizationRef: 'authz:context-contract-test',
        expiresAt: '2026-08-25T12:01:00.000Z',
      }),
      client: {
        read: async (request, signal) => {
          captured = createQueuedContextCommandRecord(request.gatewayCommand, now)
          expect((await repository.create(captured)).outcome).toBe('created')
          return server.read(request, signal)
        },
      },
    })
    await adapter.retrieve({
      workspaceId,
      scopeDigest: bundle.scopeDigest,
      principalRef: 'principal://test/user',
      executionLocation: 'cloud',
      capability: 'evidenceSearch',
      objective: 'Find fixture evidence',
      operationId: 'context-author:contract-test-0001',
      now,
      policy: {
        mode: 'required',
        providerIds: [],
        connectionIds: [],
        includeEvidence: true,
        includeMemory: true,
        maximumTokens: 100,
        maximumAgeSeconds: 3600,
        maximumProviderHealthAgeSeconds: 60,
        maximumLatencyMs: 1000,
        failureBehavior: 'fail',
      },
    })
    expect(await repository.getByOperation(captured.scope)).toEqual(captured)
    expect(server.requests).toHaveLength(1)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
