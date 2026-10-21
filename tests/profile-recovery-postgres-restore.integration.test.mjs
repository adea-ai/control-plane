// M17.02.2 (#1025): self-hosted-server (PostgreSQL) total-loss backup/restore.
//
// Integration lane only. `bun run test:integration` sets RUN_DATABASE_INTEGRATION
// and the DATABASE_* roles for the disposable local Postgres on 127.0.0.1:54329.
// A seeded hosted-server database is exported through PostgresPortableStateSource
// and restored into a freshly provisioned database through
// PostgresPortableStateDestination. The restore reads only the exported backup.
//
// The cleanup contract below runs without a database: it uses fake provisioning
// so partial setup and disposal failures are proven deterministically.

import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { PostgresEvaluationRepository } from '@control-plane/database'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import {
  PostgresPortableStateDestination,
  PostgresPortableStateSource,
  applyPortableImport,
  exportPortableState,
  planPortableImport,
} from '@control-plane/profile-portability'
import { observedEvaluationFixture } from '../packages/profile-portability/src/evaluation-fixture.mjs'

const createdAt = '2026-10-09T00:00:00.000Z'
const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

function isolatedCredentials() {
  return {
    administration: { role: 'administration', url: process.env.DATABASE_ADMIN_URL },
    migration: { role: 'migration', url: process.env.DATABASE_MIGRATION_URL },
    application: { role: 'application', url: process.env.DATABASE_URL },
  }
}

/** Provisions `count` disposable databases, runs `run` with them, and disposes
 *  every database that was provisioned, including after a partial setup failure.
 *  Each failure is kept: a body or provisioning failure plus a disposal failure
 *  are reported together in one AggregateError. */
async function withIsolatedDatabases(count, run, provision = createIsolatedTestDatabase) {
  const databases = []
  let bodyFailed = false
  let bodyError
  try {
    for (let index = 0; index < count; index += 1) {
      databases.push(await provision(isolatedCredentials()))
    }
    await run(databases)
  } catch (error) {
    bodyFailed = true
    bodyError = error
  }
  const disposals = await Promise.allSettled(databases.map((database) => database.dispose()))
  const cleanupErrors = disposals.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors,
      'PostgreSQL recovery test cleanup failed'
    )
  }
  if (bodyFailed) throw bodyError
}

/** A provisioning fake that records disposal so cleanup can be asserted. */
function fakeDatabase(name, { disposeError } = {}) {
  const state = { name, disposed: 0 }
  return {
    state,
    database: {
      name,
      dispose: async () => {
        state.disposed += 1
        if (disposeError !== undefined) throw disposeError
      },
    },
  }
}

describe('M17.02.2 PostgreSQL disposable database cleanup (no database required)', () => {
  test('partial replacement setup disposes the database already provisioned and surfaces the setup failure', async () => {
    const first = fakeDatabase('control_plane_test_first')
    let calls = 0
    const provision = async () => {
      calls += 1
      if (calls === 1) return first.database
      throw new Error('SIMULATED_REPLACEMENT_SETUP_FAILURE')
    }

    await expect(
      withIsolatedDatabases(
        2,
        async () => {
          throw new Error('BODY_MUST_NOT_RUN')
        },
        provision
      )
    ).rejects.toThrow('SIMULATED_REPLACEMENT_SETUP_FAILURE')
    expect(first.state.disposed).toBe(1)
  })

  test('a disposal failure surfaces even when the body succeeded and every database is still attempted', async () => {
    const failing = fakeDatabase('control_plane_test_failing', {
      disposeError: new Error('SIMULATED_DISPOSE_FAILURE'),
    })
    const healthy = fakeDatabase('control_plane_test_healthy')
    const queue = [failing.database, healthy.database]
    const provision = async () => queue.shift()

    const outcome = await withIsolatedDatabases(2, async () => undefined, provision).catch(
      (error) => error
    )
    expect(outcome).toBeInstanceOf(AggregateError)
    expect(outcome.errors.map((error) => error.message)).toEqual(['SIMULATED_DISPOSE_FAILURE'])
    expect(failing.state.disposed).toBe(1)
    expect(healthy.state.disposed).toBe(1)
  })

  test('a body failure and a disposal failure are both reported', async () => {
    const failing = fakeDatabase('control_plane_test_body', {
      disposeError: new Error('SIMULATED_DISPOSE_FAILURE'),
    })
    const outcome = await withIsolatedDatabases(
      1,
      async () => {
        throw new Error('SIMULATED_BODY_FAILURE')
      },
      async () => failing.database
    ).catch((error) => error)
    expect(outcome).toBeInstanceOf(AggregateError)
    expect(outcome.errors.map((error) => error.message)).toEqual([
      'SIMULATED_BODY_FAILURE',
      'SIMULATED_DISPOSE_FAILURE',
    ])
  })
})

describe.skipIf(!integrationEnabled)(
  'M17.02.2 self-hosted-server backup/restore (PostgreSQL)',
  () => {
    test(
      'hosted-server database restores a seeded evaluation into a fresh server after total loss',
      async () => {
        const evaluation = await observedEvaluationFixture()

        await withIsolatedDatabases(2, async ([lost, replacement]) => {
          await lost.migrate()
          await replacement.migrate()
          await new PostgresEvaluationRepository(lost.application).saveRun(evaluation)

          const backup = await exportPortableState(
            new PostgresPortableStateSource({
              database: lost.application,
              profile: 'hosted-server',
              objectStore: 's3-compatible',
              componentVersions: { contracts: '1.0.0' },
            }),
            { exportId: 'hosted-server-backup', createdAt }
          )
          expect(backup).toMatchObject({
            sourceProfile: 'hosted-server',
            quiesced: true,
            compatibility: { sourcePersistence: 'postgresql' },
          })

          const destination = new PostgresPortableStateDestination({
            database: replacement.application,
            profile: 'hosted-server',
            capabilities: new Set(),
            secretProviders: new Set(),
          })
          const plan = await planPortableImport(backup, destination)
          expect(plan).toMatchObject({ applicable: true, conflicts: [] })
          await expect(
            applyPortableImport(backup, plan, destination, {}, () => createdAt)
          ).resolves.toMatchObject({ outcome: 'applied' })
          await expect(
            new PostgresEvaluationRepository(replacement.application).getRun(evaluation.evalRunId)
          ).resolves.toEqual(evaluation)

          const replayPlan = await planPortableImport(backup, destination)
          await expect(
            applyPortableImport(backup, replayPlan, destination, {}, () => createdAt)
          ).resolves.toMatchObject({ outcome: 'replayed' })
        })
      },
      integrationTestTimeout(120_000)
    )
  }
)
