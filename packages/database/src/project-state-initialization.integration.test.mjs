import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  InMemoryProjectStateRepository,
  initializeProjectStateOnce,
  initialProjectState,
} from '@control-plane/domain'
import { and, eq } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresProjectStateRepository } from './project-state-repository.ts'
import { outboxEvents } from './schema/messaging.ts'
import { projectStateInitializations } from './schema/project-state.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const initializedAt = '2026-10-06T12:00:00.000Z'
const command = {
  workspaceId,
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  callerId: 'svc_adea',
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  idempotencyKey: 'project-state-init:prj_01JABCDEF',
  payloadHash: 'a'.repeat(64),
  at: initializedAt,
}

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'PostgreSQL ProjectState initialization',
  () => {
    let isolated
    let repository

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase({
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      })
      await isolated.migrate()
      repository = new PostgresProjectStateRepository(isolated.application)
    }, integrationTestTimeout(60_000))

    afterAll(async () => {
      await isolated?.dispose()
    })

    test('commits revision zero, receipt and one initialized outbox event together', async () => {
      const scope = { ...command, projectId: 'prj_01JABCDEF0123456789ABCDEAA' }
      const result = await initializeProjectStateOnce(repository, scope)
      expect(result.replayed).toBe(false)
      expect(await repository.getHistory(workspaceId, scope.projectId)).toEqual([result.state])
      expect(await repository.getInitializationReceipt(workspaceId, scope.projectId)).toEqual(
        result.receipt
      )

      const replay = await initializeProjectStateOnce(
        new PostgresProjectStateRepository(isolated.application),
        { ...scope, commandId: 'cmd_01JBBCDEF0123456789ABCDEFG', at: '2026-10-06T12:05:00.000Z' }
      )
      expect(replay).toEqual({ ...result, replayed: true })

      const events = await isolated.application
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, `${workspaceId}:${scope.projectId}`),
            eq(outboxEvents.aggregateType, 'project_state')
          )
        )
      expect(events.map((event) => [event.eventType, event.payload])).toEqual([
        [
          'project_state.initialized',
          {
            workspaceId,
            projectId: scope.projectId,
            revision: 0,
            commandId: scope.commandId,
            initializedAt,
          },
        ],
      ])
    })

    test('admits one of two concurrent initializations and reports typed conflicts', async () => {
      const scope = { ...command, projectId: 'prj_01JABCDEF0123456789ABCDEBB' }
      const results = await Promise.allSettled([
        initializeProjectStateOnce(repository, scope),
        initializeProjectStateOnce(new PostgresProjectStateRepository(isolated.application), {
          ...scope,
          commandId: 'cmd_01JBBCDEF0123456789ABCDEFG',
          idempotencyKey: 'project-state-init:other-key',
        }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected').reason.code).toBe(
        'PROJECT_STATE_EXISTS'
      )
      const winner = await repository.getInitializationReceipt(workspaceId, scope.projectId)
      await expect(
        initializeProjectStateOnce(repository, {
          ...scope,
          idempotencyKey: winner.idempotencyKey,
          payloadHash: 'b'.repeat(64),
        })
      ).rejects.toMatchObject({ code: 'INITIALIZATION_IDEMPOTENCY_CONFLICT' })
      expect(await repository.getHistory(workspaceId, scope.projectId)).toHaveLength(1)
      const receipts = await isolated.application
        .select()
        .from(projectStateInitializations)
        .where(eq(projectStateInitializations.projectId, scope.projectId))
      expect(receipts).toHaveLength(1)
    })

    test('never claims a scope created without a receipt and matches the reference adapter', async () => {
      const bootstrapped = 'prj_01JABCDEF0123456789ABCDECC'
      expect(
        await repository.create(
          initialProjectState({ workspaceId, projectId: bootstrapped, at: initializedAt })
        )
      ).toBe(true)
      const reference = new InMemoryProjectStateRepository()
      await reference.create(
        initialProjectState({ workspaceId, projectId: bootstrapped, at: initializedAt })
      )
      const outcomes = []
      for (const target of [repository, reference]) {
        outcomes.push(
          await initializeProjectStateOnce(target, { ...command, projectId: bootstrapped }).then(
            () => 'initialized',
            (error) => error.code
          )
        )
      }
      expect(outcomes).toEqual(['PROJECT_STATE_EXISTS', 'PROJECT_STATE_EXISTS'])
      expect(await repository.getInitializationReceipt(workspaceId, bootstrapped)).toBeUndefined()
    })
  }
)
