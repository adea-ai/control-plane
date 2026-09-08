import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'
import {
  ContextPackageAuthoringService,
  contextPackageSerializationFixtures,
} from '@control-plane/context'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteContextAuthoringCommandRepository,
  SqlitePersistenceProvider,
  SqliteProjectStateRepository,
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
  test('recovers acceptance after process exit immediately following the commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-accept-crash-'))
    const path = join(directory, 'state.sqlite')
    let provider
    try {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `
        import { CommandInboxService } from '@control-plane/domain';
        import { SqliteCommandAcceptanceRepository, SqlitePersistenceProvider } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
        const provider = new SqlitePersistenceProvider({ path: ${JSON.stringify(path)} });
        await provider.migrate();
        const service = new CommandInboxService({
          repository: new SqliteCommandAcceptanceRepository(provider),
          executionIdFactory: () => ${JSON.stringify(ids.executionId)},
          executionPlanValidator: { validate: async () => true },
          now: () => ${JSON.stringify(receivedAt)},
          failureInjector: { checkpoint(name) {
            if (name === 'control_api.after_accept') process.exit(73);
          } },
        });
        await service.acceptExecution(${JSON.stringify(commandInput())});
        console.log('UNEXPECTED_ACCEPTANCE_REPLY');
      `,
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: { PATH: process.env.PATH },
          encoding: 'utf8',
          timeout: 10_000,
        }
      )
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status).toBe(73)
      expect(child.stdout).toBe('')
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const recovered = new CommandInboxService({
        repository: new SqliteCommandAcceptanceRepository(provider),
        executionIdFactory: () => {
          throw new Error('REPLAY_MUST_NOT_ALLOCATE')
        },
        executionPlanValidator: {
          validate: async () => {
            throw new Error('REPLAY_MUST_NOT_REVALIDATE')
          },
        },
        now: () => receivedAt,
      })
      const results = await Promise.all(
        Array.from({ length: 8 }, () => recovered.acceptExecution(commandInput()))
      )
      expect(results.every((result) => result.replayed)).toBe(true)
      expect(results.every((result) => result.execution.executionId === ids.executionId)).toBe(true)
      expect(results.every((result) => result.command.commandId === ids.commandId)).toBe(true)
      expect(
        await provider.transaction((transaction) => transaction.list('executions'))
      ).toHaveLength(1)
      expect(
        await provider.transaction((transaction) => transaction.list('command-inbox'))
      ).toHaveLength(1)
      await expect(
        recovered.acceptExecution(commandInput({ payloadHash: 'c'.repeat(64) }))
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' })
    } finally {
      await provider?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test('retired command keys reject resurrection after payload removal and reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-retired-'))
    const path = join(directory, 'control-plane.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const accepted = await service(provider).acceptExecution(commandInput())
      let repository = new SqliteCommandAcceptanceRepository(provider)
      const retiredAt = '2026-09-24T10:00:00.000Z'
      expect(await repository.retireExpiredCommand(accepted.command, retiredAt)).toBe(false)
      const terminalCommand = {
        ...accepted.command,
        status: 'failed',
        terminalAt: receivedAt,
        errorReference: 'error://test/cancelled',
        version: 2,
      }
      expect(await repository.compareAndSet(1, terminalCommand)).toBe(true)
      expect(await repository.retireExpiredCommand(accepted.command, retiredAt)).toBe(false)
      await provider.transaction(async (transaction) => {
        const [execution] = await transaction.list('executions')
        await transaction.put({
          namespace: execution.namespace,
          id: execution.id,
          expectedRevision: execution.revision,
          value: { ...execution.value, state: 'cancelled', terminalAt: receivedAt },
        })
      })
      expect(
        await repository.retireExpiredCommand(accepted.command, accepted.command.retentionExpiresAt)
      ).toBe(false)
      expect(
        await Promise.all(
          Array.from({ length: 8 }, () =>
            repository.retireExpiredCommand(accepted.command, retiredAt)
          )
        )
      ).toEqual(Array(8).fill(true))
      await provider.transaction(async (transaction) => {
        const [command] = await transaction.list('command-inbox')
        // Simulate a future dependency-aware cleaner on this disposable database only.
        await transaction.delete(command.namespace, command.id, command.revision)
        const [tombstone] = await transaction.list('retired-command-keys')
        expect(tombstone.value).toEqual({
          retiredAt,
          commandId: ids.commandId,
          executionId: ids.executionId,
        })
      })
      provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      repository = new SqliteCommandAcceptanceRepository(provider)
      await expect(repository.get(accepted.command)).rejects.toMatchObject({
        code: 'COMMAND_RETENTION_EXPIRED',
      })
      await expect(
        repository.accept({ ...accepted.command, payloadHash: 'c'.repeat(64) }, accepted.execution)
      ).rejects.toMatchObject({ code: 'COMMAND_RETENTION_EXPIRED' })
      await expect(
        service(provider, retiredAt).acceptExecution(
          commandInput({
            commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW',
            receivedAt: retiredAt,
            retentionExpiresAt: '2026-11-24T10:00:00.000Z',
          })
        )
      ).rejects.toMatchObject({ code: 'COMMAND_RETENTION_EXPIRED' })
      expect(
        await repository.get({ ...accepted.command, callerPrincipalId: 'svc_other' })
      ).toBeUndefined()
      expect(
        await repository.get({ ...accepted.command, projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
      ).toBeUndefined()
      const snapshot = await provider.backup()
      provider.close()
      provider = new SqlitePersistenceProvider({ path: join(directory, 'restored.sqlite') })
      await provider.restore(snapshot)
      const restored = new SqliteCommandAcceptanceRepository(provider)
      await expect(restored.get(accepted.command)).rejects.toMatchObject({
        code: 'COMMAND_RETENTION_EXPIRED',
      })
      await expect(restored.accept(accepted.command, accepted.execution)).rejects.toMatchObject({
        code: 'COMMAND_RETENTION_EXPIRED',
      })
      expect(
        await provider.transaction((transaction) => transaction.list('command-inbox'))
      ).toEqual([])
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

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
      const scope = { workspaceId: ids.workspaceId, runtimeNodeRefId: ids.runtimeNodeRefId }
      const expected = runtimeDiscoveryModel()
      const next = {
        ...expected,
        observedAt: new Date(Date.parse(expected.observedAt) + 1_000).toISOString(),
      }
      const pointReads = new SqliteRuntimeDiscoveryRepository({
        transaction: (operation) =>
          provider.transaction((transaction) =>
            operation({
              get: (...args) => transaction.get(...args),
              list: () => {
                throw new Error('Point lookup must not list history')
              },
            })
          ),
      })
      expect(await pointReads.getRuntimeConnection(scope, ids.runtimeConnectionId)).toEqual(
        expected
      )
      expect(
        await reopened.compareAndSetRuntimeConnection(
          { ...scope, workspaceId: 'wsp_01BRZ3NDEKTSV4RRFFQ69G5FAV' },
          expected,
          next
        )
      ).toBe(false)
      const updates = await Promise.all(
        Array.from({ length: 8 }, () =>
          reopened.compareAndSetRuntimeConnection(scope, expected, next)
        )
      )
      expect(updates.filter(Boolean)).toHaveLength(1)
      expect(await reopened.compareAndSetRuntimeConnection(scope, expected, next)).toBe(false)
      await expect(reopened.compareAndSetRuntimeConnection(scope, next, expected)).rejects.toThrow(
        'RUNTIME_DISCOVERY_REFRESH_IDENTITY_MISMATCH'
      )
      await expect(
        reopened.compareAndSetRuntimeConnection(scope, next, {
          ...next,
          runtimeConnectionId: 'rtc_01BRZ3NDEKTSV4RRFFQ69G5FAV',
        })
      ).rejects.toThrow('RUNTIME_DISCOVERY_REFRESH_IDENTITY_MISMATCH')
      provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      expect(
        await new SqliteRuntimeDiscoveryRepository(provider).getRuntimeConnection(
          scope,
          ids.runtimeConnectionId
        )
      ).toEqual(next)
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

  test('authors from durable state and resolves the resulting package after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-authoring-'))
    const path = join(directory, 'control-plane.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const projectStates = new SqliteProjectStateRepository(provider)
      const scope = { workspaceId: ids.workspaceId, projectId: ids.projectId }
      expect(
        await projectStates.create({
          schemaVersion: 1,
          ...scope,
          revision: 0,
          items: [],
          createdAt: receivedAt,
          updatedAt: receivedAt,
        })
      ).toBe(true)
      const packages = new SqliteContextPackageRepository(provider)
      const authoring = new ContextPackageAuthoringService({
        compilerVersion: '1.0.0',
        projectStates,
        packages,
        commands: new SqliteContextAuthoringCommandRepository(provider),
        now: () => new Date(receivedAt),
        authority: {
          async authorize(principalRef, request) {
            if (
              principalRef !== 'service:standalone' ||
              request.workspaceId !== scope.workspaceId ||
              request.projectId !== scope.projectId
            )
              return undefined
            return {
              ...scope,
              principalRef,
              expiresAt: '2026-08-24T11:00:00.000Z',
              constraints: {
                allowedSensitivities: ['public'],
                allowedStateItemIds: [],
                allowedArtifactIds: [],
              },
              permissions: [],
              budgets: { maximumBytes: 1024, maximumTokens: 256 },
            }
          },
          async resolveArtifact() {
            throw new Error('Unexpected Artifact resolution')
          },
        },
      })
      const request = {
        ...scope,
        projectStateRevision: 0,
        objective: 'Run with no optional context provider',
        candidates: [],
        successCriteria: ['Return the pinned package'],
        returnContract: { contractRef: 'contract://standalone-result/v1' },
        budgets: { maximumBytes: 2048, maximumTokens: 512 },
      }
      await expect(authoring.create('service:other', request)).rejects.toThrow(
        'UNAUTHORIZED_CONTEXT'
      )
      const idempotencyKey = 'standalone-authoring-0001'
      const realCommands = authoring.options.commands
      authoring.options.commands = new SqliteContextAuthoringCommandRepository({
        transaction: (operation) =>
          provider.transaction((transaction) =>
            operation({
              get: transaction.get.bind(transaction),
              put: async (write) => {
                if (write.namespace === 'context-authoring-commands')
                  throw new Error('INJECTED_COMMAND_WRITE_FAILURE')
                return transaction.put(write)
              },
            })
          ),
      })
      await expect(
        authoring.createForCommand('service:standalone', idempotencyKey, request)
      ).rejects.toThrow('INJECTED_COMMAND_WRITE_FAILURE')
      await provider.transaction(async (transaction) => {
        expect(await transaction.list('context-packages')).toEqual([])
        expect(await transaction.list('context-authoring-commands')).toEqual([])
      })
      authoring.options.commands = realCommands
      let clockTicks = 0
      authoring.options.now = () => new Date(Date.parse(receivedAt) + clockTicks++ * 1000)
      const refs = await Promise.all(
        Array.from({ length: 8 }, () =>
          authoring.createForCommand('service:standalone', idempotencyKey, request)
        )
      )
      const ref = refs[0]
      expect(refs.every((value) => value.contextPackageId === ref.contextPackageId)).toBe(true)
      await provider.transaction(async (transaction) => {
        expect(await transaction.list('context-packages')).toHaveLength(1)
        expect(await transaction.list('context-authoring-commands')).toHaveLength(1)
      })
      const before = await packages.get(ref)
      expect(before.budgets).toEqual({ maximumBytes: 1024, maximumTokens: 256 })
      expect(before.providerComposition).toBeUndefined()
      provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const reopened = new SqliteContextPackageRepository(provider)
      expect(await reopened.get(ref)).toEqual(before)
      expect(await reopened.getById(ref.contextPackageId)).toEqual(before)
      authoring.options.commands = new SqliteContextAuthoringCommandRepository(provider)
      authoring.options.authority.authorize = async () => {
        throw new Error('Replay must not re-author')
      }
      authoring.options.now = () => new Date('2026-10-01T00:00:00.000Z')
      expect(
        await authoring.createForCommand('service:standalone', idempotencyKey, request)
      ).toEqual(ref)
      await expect(
        authoring.createForCommand('service:standalone', idempotencyKey, {
          ...request,
          objective: 'Changed input',
        })
      ).rejects.toThrow('CONTEXT_AUTHORING_COMMAND_CONFLICT')
      expect(
        await authoring.options.commands.get({
          principalRef: 'service:other',
          workspaceId: ids.workspaceId,
          projectId: ids.projectId,
          operation: 'context.author',
          idempotencyKey,
        })
      ).toBeUndefined()
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
