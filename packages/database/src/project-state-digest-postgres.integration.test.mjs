import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  InMemoryStatePromotionProposalRepository,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
  projectStateMutationDigestV2,
  projectStateMutationMatchesDigest,
} from '@control-plane/domain'
import { and, eq, sql } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresProjectStateRepository } from './project-state-repository.ts'
import { outboxEvents } from './schema/messaging.ts'
import { projectStateMutations } from './schema/project-state.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const now = '2026-08-23T12:00:00.000Z'
const later = '2026-08-23T13:00:00.000Z'

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'PostgreSQL ProjectState digest versioning',
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

    test('the digest version column is present and nullable', async () => {
      const [column] = await isolated.application.execute(sql`
        select column_name, data_type, is_nullable
        from information_schema.columns
        where table_name = 'project_state_mutations'
          and column_name = 'input_digest_version'
      `)
      expect(column).toEqual({
        column_name: 'input_digest_version',
        data_type: 'integer',
        is_nullable: 'YES',
      })
    })

    test('the default writer keeps the untagged record it has always written', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEFG' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', scope.projectId, 0)
      await service.applyMutation(input)

      const stored = await repository.getMutation(workspaceId, scope.projectId, input.mutationId)
      expect(stored.inputDigestVersion).toBeUndefined()
      const [row] = await isolated.application
        .select()
        .from(projectStateMutations)
        .where(eq(projectStateMutations.mutationId, input.mutationId))
      expect(row.inputDigestVersion).toBeNull()
    })

    test('the versioned writer records the canonicalization it used', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEAA' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEAA', scope.projectId, 0)
      const written = await service.applyMutation(input, { digestVersion: 2 })
      expect(written.applied).toBe(true)

      const stored = await repository.getMutation(workspaceId, scope.projectId, input.mutationId)
      expect(stored.inputDigestVersion).toBe(2)
      const [row] = await isolated.application
        .select()
        .from(projectStateMutations)
        .where(eq(projectStateMutations.mutationId, input.mutationId))
      expect(row.inputDigestVersion).toBe(2)
    })

    test('a replay resolves through the record version and adds no revision or event', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEAB' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEAB', scope.projectId, 0)
      await service.applyMutation(input, { digestVersion: 2 })

      const replay = await service.applyMutation(input)
      expect(replay.applied).toBe(false)
      expect(replay.state.revision).toBe(1)
      expect(await repository.getHistory(workspaceId, scope.projectId)).toHaveLength(2)
      expect(await updateEvents(scope.projectId)).toHaveLength(1)
    })

    test('an altered input is refused for a versioned record', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEAC' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEAC', scope.projectId, 0)
      await service.applyMutation(input, { digestVersion: 2 })
      const altered = mutation('stm_01JABCDEF0123456789ABCDEAC', scope.projectId, 0, 'ship M3')

      await expect(service.applyMutation(altered)).rejects.toMatchObject({
        code: 'MUTATION_ID_REUSED',
      })
      expect(await repository.getHistory(workspaceId, scope.projectId)).toHaveLength(2)
      expect(await updateEvents(scope.projectId)).toHaveLength(1)
    })

    test('a record carrying an unsupported version is refused instead of replayed', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEAD' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEAD', scope.projectId, 0)
      await service.applyMutation(input)
      await isolated.application.execute(sql`
        update project_state_mutations
        set input_digest_version = 3
        where workspace_id = ${workspaceId}
          and project_id = ${scope.projectId}
          and mutation_id = ${input.mutationId}
      `)

      await expect(service.applyMutation(input)).rejects.toMatchObject({
        code: 'MUTATION_DIGEST_VERSION_UNSUPPORTED',
      })
      expect(await updateEvents(scope.projectId)).toHaveLength(1)
    })

    test('the published event carries the version only when the writer recorded one', async () => {
      const versioned = { projectId: 'prj_01JABCDEF0123456789ABCDEAF' }
      const versionedService = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await versionedService.initialize({ workspaceId, projectId: versioned.projectId, at: now })
      await versionedService.applyMutation(
        mutation('stm_01JABCDEF0123456789ABCDEAF', versioned.projectId, 0),
        { digestVersion: 2 }
      )
      expect((await updateEvents(versioned.projectId))[0]).toMatchObject({ inputDigestVersion: 2 })

      const untagged = { projectId: 'prj_01JABCDEF0123456789ABCDEAG' }
      const untaggedService = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await untaggedService.initialize({ workspaceId, projectId: untagged.projectId, at: now })
      await untaggedService.applyMutation(
        mutation('stm_01JABCDEF0123456789ABCDEAG', untagged.projectId, 0)
      )
      expect((await updateEvents(untagged.projectId))[0]).not.toHaveProperty('inputDigestVersion')
    })

    test('a reader from before the version metadata still verifies a versioned row', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEAH' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEAH', scope.projectId, 0)
      await service.applyMutation(input, { digestVersion: 2 })

      // A reader from before the version metadata existed reads only the digest column.
      const [row] = await isolated.application.execute(sql`
        select input_digest
        from project_state_mutations
        where workspace_id = ${workspaceId}
          and project_id = ${scope.projectId}
          and mutation_id = ${input.mutationId}
      `)
      expect(row.input_digest).toBe(projectStateMutationDigestV2(input))
      // And this release's untagged helper accepts that digest. This is compatibility evidence, not an
      // old-binary rollback execution.
      expect(projectStateMutationMatchesDigest(input, row.input_digest)).toBe(true)
      expect(projectStateMutationMatchesDigest(input, row.input_digest, 2)).toBe(true)
    })

    test('a compare-and-set loser resolves the winner record exactly like an ordinary replay', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEEA' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEEA', scope.projectId, 0)

      // The first attempt loses the revision race to a writer that used the same mutation
      // id, so the service has to resolve the winner's record instead of writing one.
      const racy = new PostgresProjectStateRepository(isolated.application)
      const originalCompareAndSet = racy.compareAndSet.bind(racy)
      let lost = false
      racy.compareAndSet = async (expectedRevision, state, record) => {
        if (!lost) {
          lost = true
          await originalCompareAndSet(expectedRevision, state, record)
          return false
        }
        return originalCompareAndSet(expectedRevision, state, record)
      }
      const losingService = serviceFor(racy)

      const loser = await losingService.applyMutation(input, { digestVersion: 2 })
      expect(loser.applied).toBe(false)
      expect(loser.state.revision).toBe(1)

      // The ordinary replay of the same record agrees with the loser.
      const replay = await service.applyMutation(input)
      expect(replay.applied).toBe(false)
      expect(replay.state.revision).toBe(1)

      expect(await repository.getHistory(workspaceId, scope.projectId)).toHaveLength(2)
      expect(await updateEvents(scope.projectId)).toHaveLength(1)
      const mutations = await isolated.application
        .select()
        .from(projectStateMutations)
        .where(
          and(
            eq(projectStateMutations.workspaceId, workspaceId),
            eq(projectStateMutations.projectId, scope.projectId),
            eq(projectStateMutations.mutationId, input.mutationId)
          )
        )
      expect(mutations).toHaveLength(1)
      expect(mutations[0].inputDigestVersion).toBe(2)
    })

    test('concurrent writers of one mutation id leave one revision, one mutation and one event', async () => {
      const scope = { projectId: 'prj_01JABCDEF0123456789ABCDEEB' }
      const service = serviceFor(new PostgresProjectStateRepository(isolated.application))
      await service.initialize({ workspaceId, projectId: scope.projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEEB', scope.projectId, 0)
      const results = await Promise.allSettled([
        service.applyMutation(input, { digestVersion: 2 }),
        service.applyMutation(input, { digestVersion: 2 }),
      ])

      // Exactly one writer commits. The loser either replays idempotently or is refused by
      // the pre-existing stale-revision conflict path; neither outcome duplicates anything.
      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      expect(fulfilled.filter((result) => result.value.applied)).toHaveLength(1)
      for (const result of fulfilled) expect(result.value.state.revision).toBe(1)
      for (const result of results.filter((entry) => entry.status === 'rejected')) {
        expect(result.reason).toMatchObject({ code: 'STALE_REVISION' })
      }

      expect(await repository.getHistory(workspaceId, scope.projectId)).toHaveLength(2)
      expect(await updateEvents(scope.projectId)).toHaveLength(1)
      const mutations = await isolated.application
        .select()
        .from(projectStateMutations)
        .where(
          and(
            eq(projectStateMutations.workspaceId, workspaceId),
            eq(projectStateMutations.projectId, scope.projectId),
            eq(projectStateMutations.mutationId, input.mutationId)
          )
        )
      expect(mutations).toHaveLength(1)
      expect(mutations[0].resultingRevision).toBe(1)
    })

    async function updateEvents(projectId) {
      const rows = await isolated.application
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, `${workspaceId}:${projectId}`),
            eq(outboxEvents.eventType, 'project_state.updated')
          )
        )
      return rows.map((row) => row.payload)
    }
  }
)

function serviceFor(repository) {
  return new ProjectStateService(
    repository,
    new InMemoryStatePromotionProposalRepository(),
    new RecordingProjectStateEventPublisher()
  )
}

function mutation(mutationId, projectId, expectedRevision, value = 'ship M2') {
  return {
    mutationId,
    workspaceId,
    projectId,
    expectedRevision,
    actorPrincipalRef: 'principal://agent-hq/user/42',
    operations: [
      {
        kind: 'append',
        item: {
          itemId: `psi_${mutationId.slice(4)}`,
          key: 'goal',
          value,
          sensitivity: 'internal',
          freshness: { observedAt: now },
          provenance: {
            sourceKind: 'principal',
            sourcePrincipalRef: 'principal://agent-hq/user/42',
            artifactRefs: [],
            capturedAt: now,
          },
        },
      },
    ],
    at: later,
  }
}
