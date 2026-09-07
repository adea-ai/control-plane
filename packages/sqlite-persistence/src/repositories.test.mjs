import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqlitePersistenceProvider,
  SqliteRuntimeDiscoveryRepository,
} from './index.ts'

const ids = {
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeNodeRefId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

const receivedAt = '2026-08-24T10:00:00.000Z'

function commandInput(overrides = {}) {
  return {
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: ids.commandId,
    requestId: ids.requestId,
    idempotencyKey: 'task-submit-0001',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
    },
    executionPlan: {
      executionPlanId: ids.executionPlanId,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    receivedAt,
    retentionExpiresAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  }
}

function service(provider, now = receivedAt) {
  return new CommandInboxService({
    repository: new SqliteCommandAcceptanceRepository(provider),
    executionIdFactory: () => ids.executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => now,
  })
}

describe('SQLite domain repositories', () => {
  test.each([1, 30, 31])('preserves a %i-day replay deadline across reopen', async (days) => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-retention-'))
    const path = join(directory, 'control-plane.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    const deadline = new Date(Date.parse(receivedAt) + days * 86_400_000).toISOString()
    const input = commandInput({ retentionExpiresAt: deadline })
    try {
      await provider.migrate()
      let accepted
      if (days < 30) {
        const template = await new CommandInboxService({
          repository: new InMemoryCommandAcceptanceRepository(),
          executionIdFactory: () => ids.executionId,
          executionPlanValidator: { validate: async () => true },
          now: () => receivedAt,
        }).acceptExecution(commandInput())
        // Seed the pre-policy persisted shape without using new-acceptance validation.
        accepted = await new SqliteCommandAcceptanceRepository(provider).accept(
          { ...template.command, retentionExpiresAt: deadline },
          template.execution
        )
      } else {
        accepted = await service(provider).acceptExecution(input)
      }
      provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const replay = await service(provider, deadline).acceptExecution(input)
      expect(replay.replayed).toBe(true)
      expect(replay.command.retentionExpiresAt).toBe(deadline)
      expect(replay.execution).toEqual(accepted.execution)
      await expect(
        service(provider, new Date(Date.parse(deadline) + 1).toISOString()).acceptExecution(input)
      ).rejects.toMatchObject({ code: 'COMMAND_RETENTION_EXPIRED' })
      expect(
        await new SqliteCommandAcceptanceRepository(provider).getByExecutionId(ids.executionId)
      ).toMatchObject({ retentionExpiresAt: deadline })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists workspace-scoped runtime discovery projections across reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-discovery-'))
    const path = join(directory, 'control-plane.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = new SqliteRuntimeDiscoveryRepository(provider)
      await repository.putRuntimeConnection(ids.workspaceId, runtimeDiscoveryModel())
      await repository.putExternalSession(
        {
          workspaceId: ids.workspaceId,
          projectId: ids.projectId,
          runtimeNodeRefId: ids.runtimeNodeRefId,
        },
        externalSessionDiscoveryModel()
      )
      provider.close()

      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const reopened = new SqliteRuntimeDiscoveryRepository(provider)
      expect(await reopened.listRuntimeConnections({ workspaceId: ids.workspaceId })).toEqual([
        runtimeDiscoveryModel(),
      ])
      expect(
        await reopened.getRuntimeConnection(
          { workspaceId: ids.workspaceId },
          ids.runtimeConnectionId
        )
      ).toEqual(runtimeDiscoveryModel())
      expect(
        await reopened.listExternalSessions({
          workspaceId: ids.workspaceId,
          projectId: ids.projectId,
        })
      ).toEqual([externalSessionDiscoveryModel()])
      expect(
        await reopened.listRuntimeConnections({
          workspaceId: 'wsp_01BRZ3NDEKTSV4RRFFQ69G5FAV',
        })
      ).toEqual([])
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('resolves an immutable ContextPackage by stable ID after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-context-'))
    const path = join(directory, 'control-plane.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const package_ = contextPackageSerializationFixtures.futurePi
      await new SqliteContextPackageRepository(provider).put(package_)
      provider.close()

      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const repository = new SqliteContextPackageRepository(provider)
      expect(await repository.getById(package_.contextPackageId)).toEqual(package_)
      expect(await repository.getById('ctx_01JABCDEF0123456789ABCDEFG')).toBeUndefined()
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('serializes concurrent acceptance and replays it after a full reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-domain-'))
    const path = join(directory, 'control-plane.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const accepted = await Promise.all(
        Array.from({ length: 8 }, () => service(provider).acceptExecution(commandInput()))
      )
      expect(accepted.filter(({ replayed }) => !replayed)).toHaveLength(1)
      expect(new Set(accepted.map(({ execution }) => execution.executionId))).toEqual(
        new Set([ids.executionId])
      )
      provider.close()

      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const replay = await service(provider).acceptExecution(commandInput())
      expect(replay).toMatchObject({ replayed: true, execution: { executionId: ids.executionId } })

      await expect(
        service(provider).acceptExecution(commandInput({ payloadHash: 'c'.repeat(64) }))
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function runtimeDiscoveryModel() {
  return {
    runtimeConnectionId: ids.runtimeConnectionId,
    runtimeDefinitionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    family: 'mock',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    node: {
      runtimeNodeRefId: ids.runtimeNodeRefId,
      location: 'local_device',
      status: 'online',
      health: 'online',
      observedAt: receivedAt,
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: { state: 'fresh', observedAt: receivedAt },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0' },
    capabilities: ['tool.call'],
    capabilityDetails: [{ name: 'tool.call', support: 'supported' }],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt: receivedAt,
    limitations: [],
  }
}

function externalSessionDiscoveryModel() {
  return {
    externalSessionId: 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeConnectionId: ids.runtimeConnectionId,
    projectId: ids.projectId,
    state: 'active',
    recoverable: true,
    display: { origin: 'created_through_control_plane' },
    freshness: { state: 'fresh', observedAt: receivedAt },
    capabilitySummary: {
      version: 1,
      operations: ['session.resume'],
      controls: {
        reference: { available: true },
        resume: { available: true },
        load: { available: true },
        close: { available: true },
        history: { available: false, reason: 'HISTORY_UNAVAILABLE' },
      },
    },
    limitations: [],
  }
}
