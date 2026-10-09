// M17.02.2 (#1025, agent 1): crash/recovery and backup/restore proven through
// the supported composition roots with real implementations.
//
// - local: LocalControlPlaneComposition (real SQLite + embedded durable queue)
//   recovers an abandoned in-flight job after a simulated crash, fences the
//   crashed worker's stale lease, and retains terminal outcomes across reopen.
// - local + self-hosted-simple: real SqlitePersistenceProvider profiles survive
//   close/reopen and round-trip through the supported portability backup
//   (PersistencePortableStateSource) and restore (PersistencePortableStateDestination).
//   Backup refuses while active work exists (PORTABLE_ACTIVE_WORK).
// - hosted / self-hosted (fail closed): the profile adapters refuse to bind the
//   Hosted or Self-hosted product profiles to local SQLite storage or to the
//   local embedded queue — no silent fallback to the local Node path.
// - self-hosted-server (PostgreSQL): integration-gated (RUN_DATABASE_INTEGRATION
//   plus the standard local 127.0.0.1:54329 DATABASE_*_URL roles) total-loss
//   backup/restore from a seeded hosted-server database into a freshly
//   provisioned one through PostgresPortableStateSource/Destination.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, test } from 'bun:test'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/src/composition.ts'
import {
  SqliteContextPackageRepository,
  SqliteEvaluationRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { PostgresEvaluationRepository } from '@control-plane/database'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  PostgresPortableStateDestination,
  PostgresPortableStateSource,
  applyPortableImport,
  exportPortableState,
  planPortableImport,
} from '@control-plane/profile-portability'
import { observedEvaluationFixture } from '../packages/profile-portability/src/evaluation-fixture.mjs'
import {
  ProfileAdapterError,
  bindProfileStorage,
  bindProfileWorkflowWake,
} from '@control-plane/profile-adapters'

const createdAt = '2026-10-09T00:00:00.000Z'
const laterAt = '2026-10-09T00:01:00.000Z'
const executionKey = 'exe_01JABCDEF0123456789ABCDEFG'
const leaseMs = 1_000

const temporaryDirectories = []
const temporaryProviders = []

afterEach(async () => {
  const results = await Promise.all([
    Promise.allSettled(temporaryProviders.splice(0).map((provider) => provider.close())),
    Promise.allSettled(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    ),
  ])
  const failures = results
    .flat()
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'profile recovery cleanup failed')
})

async function openTempDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function sqliteProvider(directory, profile = 'local') {
  const provider = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
    profile,
  })
  temporaryProviders.push(provider)
  return provider
}

async function seedEvaluation(provider) {
  await provider.migrate()
  const evaluation = await observedEvaluationFixture()
  await new SqliteEvaluationRepository(provider).saveRun(evaluation)
  return evaluation
}

/** Retains the full guarded parent tuple the local composition's queue
 *  requires (context package, execution plan, lifecycle execution) and returns
 *  the accepted workflow input shape. */
async function seedRetainedExecution(composition) {
  const package_ = contextPackageSerializationFixtures.futurePi
  await new SqliteContextPackageRepository(composition.persistence).put(package_)
  const plan = createExecutionPlanTestFixture({ contextPackage: package_ })
  const reference = {
    ...(await new SqliteExecutionPlanRepository(composition.persistence).put(plan)),
    schemaVersion: plan.schemaVersion,
  }
  const input = {
    executionId: executionKey,
    workflowId: `wfl_${executionKey.slice(4)}`,
    executionPlan: reference,
    marketplacePluginReferences: [
      {
        pluginId: 'plugin:control-plane:guard-fixture',
        releaseId: `release:${'a'.repeat(64)}`,
        canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
      },
    ],
    deadlineAt: '2026-10-09T01:00:00.000Z',
  }
  await new ExecutionLifecycleService(
    new SqliteExecutionRepository(composition.persistence)
  ).createExecution({
    executionId: input.executionId,
    correlation: plan.correlation,
    executionPlan: reference,
    marketplacePluginReferences: input.marketplacePluginReferences,
    acceptedAt: createdAt,
  })
  return input
}

/** Minimal DeploymentComposition shape for fail-closed binding proofs; only the
 *  profile/persistence/workflow fields that bindProfileStorage validates. */
const deployment = (profile, dialect) => ({
  profile,
  persistence: { profile, dialect },
  workflow: { profile },
})

// Local crash/recovery through the real composition root.
describe('M17.02.2 local profile crash recovery (embedded SQLite queue)', () => {
  test('local composition recovers an abandoned in-flight job after simulated crash', async () => {
    const directory = await openTempDirectory('profile-recovery-local-crash-')
    const crashed = new LocalControlPlaneComposition({ dataDirectory: directory })
    expect(crashed.profile).toBe('local')
    expect(crashed.durableExecution).toBe('embedded-sqlite')
    expect(crashed.workflowJobs).toBeDefined()
    await crashed.persistence.migrate()

    const input = await seedRetainedExecution(crashed)
    const enqueued = await crashed.workflowJobs.enqueue({
      workflowKey: executionKey,
      input,
      at: createdAt,
    })
    expect(enqueued.outcome).toBe('created')
    const [inflight] = await crashed.workflowJobs.claimDue({
      owner: 'worker-crashed',
      leaseMs,
      now: createdAt,
      limit: 5,
    })
    expect(inflight.status).toBe('running')
    expect(inflight.attempt).toBe(1)
    const crashedToken = inflight.lease.token

    // Simulated crash: close the store, abandon the lease, never complete.
    crashed.persistence.close()

    // Restart the same composition root over the same retained data directory.
    const restarted = new LocalControlPlaneComposition({ dataDirectory: directory })
    await restarted.persistence.migrate()
    const retained = await restarted.workflowJobs.get(executionKey)
    expect(retained.status).toBe('running')
    expect(retained.attempt).toBe(1)
    expect(retained.lease.owner).toBe('worker-crashed')
    expect(retained.input).toEqual(input)

    // After the lease expires a new owner recovers the same job identity.
    const [recovered] = await restarted.workflowJobs.claimDue({
      owner: 'worker-recovered',
      leaseMs,
      now: laterAt,
      limit: 5,
    })
    expect(recovered.workflowKey).toBe(executionKey)
    expect(recovered.attempt).toBe(2)
    expect(recovered.input).toEqual(input)
    expect(recovered.lease.owner).toBe('worker-recovered')
    expect(recovered.lease.token).not.toBe(crashedToken)

    await expect(
      restarted.workflowJobs.complete({
        workflowKey: executionKey,
        owner: 'worker-recovered',
        token: recovered.lease.token,
        outcome: { executionId: executionKey, status: 'completed' },
        at: laterAt,
      })
    ).resolves.toBe(true)
    await expect(
      restarted.workflowJobs.claimDue({ owner: 'worker-late', leaseMs, now: laterAt, limit: 5 })
    ).resolves.toHaveLength(0)
  })

  test('local composition fences the crashed worker: stale lease token cannot complete', async () => {
    const directory = await openTempDirectory('profile-recovery-local-fence-')
    const crashed = new LocalControlPlaneComposition({ dataDirectory: directory })
    await crashed.persistence.migrate()
    const input = await seedRetainedExecution(crashed)
    await crashed.workflowJobs.enqueue({ workflowKey: executionKey, input, at: createdAt })
    const [inflight] = await crashed.workflowJobs.claimDue({
      owner: 'worker-crashed',
      leaseMs,
      now: createdAt,
      limit: 5,
    })

    crashed.persistence.close()
    const restarted = new LocalControlPlaneComposition({ dataDirectory: directory })
    await restarted.persistence.migrate()
    const [recovered] = await restarted.workflowJobs.claimDue({
      owner: 'worker-recovered',
      leaseMs,
      now: laterAt,
      limit: 5,
    })

    // The crashed owner's single-use token is fenced out after recovery.
    await expect(
      restarted.workflowJobs.complete({
        workflowKey: executionKey,
        owner: 'worker-crashed',
        token: inflight.lease.token,
        outcome: { executionId: executionKey, status: 'failed' },
        at: laterAt,
      })
    ).resolves.toBe(false)
    expect((await restarted.workflowJobs.get(executionKey)).outcome).toBeUndefined()

    // The recovered owner completes exactly once.
    await expect(
      restarted.workflowJobs.complete({
        workflowKey: executionKey,
        owner: 'worker-recovered',
        token: recovered.lease.token,
        outcome: { executionId: executionKey, status: 'completed' },
        at: laterAt,
      })
    ).resolves.toBe(true)
  })
})

// Backup/restore through the supported portability composition roots.
describe('M17.02.2 portable backup/restore (SQLite profiles)', () => {
  test('local backup refuses while active work exists, then restores after total loss', async () => {
    const sourceDirectory = await openTempDirectory('profile-recovery-local-src-')
    const source = sqliteProvider(sourceDirectory, 'local')
    const evaluation = await seedEvaluation(source)

    await expect(
      exportPortableState(
        new PersistencePortableStateSource({
          persistence: source,
          componentVersions: { contracts: '1.0.0' },
          activeWorkIds: async () => [executionKey],
        }),
        { exportId: 'fenced-export', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_ACTIVE_WORK' })

    const backup = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: source,
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'local-backup', createdAt }
    )
    expect(backup).toMatchObject({
      sourceProfile: 'local',
      quiesced: true,
      compatibility: { sourcePersistence: 'sqlite' },
    })
    expect(backup.records.length).toBeGreaterThan(0)
    expect(typeof backup.contentDigest).toBe('string')

    // Total loss: a brand-new empty deployment directory is the restore target.
    const restoredDirectory = await openTempDirectory('profile-recovery-local-dst-')
    const restored = sqliteProvider(restoredDirectory, 'local')
    await restored.migrate()
    const destination = new PersistencePortableStateDestination({
      persistence: restored,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(backup, destination)
    expect(plan).toMatchObject({ applicable: true, conflicts: [] })
    await expect(
      applyPortableImport(backup, plan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })

    // Crash the restored deployment, reopen, and verify real retained state.
    restored.close()
    const reopened = sqliteProvider(restoredDirectory, 'local')
    await reopened.migrate()
    await expect(
      new SqliteEvaluationRepository(reopened).getRun(evaluation.evalRunId)
    ).resolves.toEqual(evaluation)

    // Replay of the same backup is idempotent, not a second write; the
    // reopened (post-crash) store is the live destination now.
    const replayDestination = new PersistencePortableStateDestination({
      persistence: reopened,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const replayPlan = await planPortableImport(backup, replayDestination)
    await expect(
      applyPortableImport(backup, replayPlan, replayDestination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'replayed' })
  })

  test('self-hosted simple SQLite profile survives crash/reopen and portable restore', async () => {
    const sourceDirectory = await openTempDirectory('profile-recovery-simple-src-')
    const source = sqliteProvider(sourceDirectory, 'hosted-simple')
    const evaluation = await seedEvaluation(source)

    // Crash simulation on the self-hosted store itself: close, reopen, retain.
    source.close()
    const reopened = sqliteProvider(sourceDirectory, 'hosted-simple')
    await reopened.migrate()
    await expect(
      new SqliteEvaluationRepository(reopened).getRun(evaluation.evalRunId)
    ).resolves.toEqual(evaluation)

    const backup = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: reopened,
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'hosted-simple-backup', createdAt }
    )
    expect(backup).toMatchObject({ sourceProfile: 'hosted-simple', quiesced: true })

    const restoredDirectory = await openTempDirectory('profile-recovery-simple-dst-')
    const restored = sqliteProvider(restoredDirectory, 'hosted-simple')
    await restored.migrate()
    const destination = new PersistencePortableStateDestination({
      persistence: restored,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(backup, destination)
    await expect(
      applyPortableImport(backup, plan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })
    restored.close()
    const reopenedRestore = sqliteProvider(restoredDirectory, 'hosted-simple')
    await reopenedRestore.migrate()
    await expect(
      new SqliteEvaluationRepository(reopenedRestore).getRun(evaluation.evalRunId)
    ).resolves.toEqual(evaluation)
  })

  test('physical snapshot backup restores into a fresh store and rejects tampered digests', async () => {
    const sourceDirectory = await openTempDirectory('profile-recovery-snapshot-src-')
    const source = sqliteProvider(sourceDirectory, 'hosted-simple')
    const evaluation = await seedEvaluation(source)

    // The provider's real cold backup primitive: a digest-stamped byte image.
    const snapshot = await source.backup()
    expect(snapshot.schemaVersion).toBeGreaterThan(0)
    expect(snapshot.bytes.byteLength).toBeGreaterThan(0)
    source.close()

    // Total loss of the source store; only the snapshot remains.
    await rm(join(sourceDirectory, 'control-plane.sqlite'), { force: true })

    const replacement = sqliteProvider(
      await openTempDirectory('profile-recovery-snapshot-dst-'),
      'hosted-simple'
    )
    await replacement.restore(snapshot)
    await expect(
      new SqliteEvaluationRepository(replacement).getRun(evaluation.evalRunId)
    ).resolves.toEqual(evaluation)

    // A tampered snapshot fails closed before touching the live connection.
    const tampered = { ...snapshot, digest: `sha256:${'0'.repeat(64)}` }
    await expect(replacement.restore(tampered)).rejects.toMatchObject({
      code: 'SQLITE_BACKUP_INVALID',
    })
    await expect(
      new SqliteEvaluationRepository(replacement).getRun(evaluation.evalRunId)
    ).resolves.toEqual(evaluation)
  })
})

// Hosted and Self-hosted fail closed: no silent fallback to the local path.
describe('M17.02.2 hosted fail-closed binding (no local fallback)', () => {
  test('hosted and self-hosted profiles refuse local SQLite storage and the embedded queue', async () => {
    const localSqlite = deployment('local', 'sqlite')
    expect(bindProfileStorage('Local', localSqlite).profile).toBe('local')

    // Hosted (cloud) never binds a local deployment.
    expect(() => bindProfileStorage('hosted', localSqlite)).toThrow(
      new ProfileAdapterError('PROFILE_DEPLOYMENT_MISMATCH')
    )
    // Self-hosted without an explicit hosted-simple/hosted-server variant fails.
    expect(() => bindProfileStorage('Self-hosted', localSqlite)).toThrow(
      new ProfileAdapterError('PROFILE_DEPLOYMENT_MISMATCH')
    )
    // Cloud deployment still cannot bind the local SQLite store.
    expect(() => bindProfileStorage('Hosted', deployment('cloud', 'sqlite'))).toThrow(
      new ProfileAdapterError('PROFILE_PERSISTENCE_MISMATCH')
    )

    // Wake fencing: the local embedded queue can never serve a hosted wake.
    await expect(
      bindProfileWorkflowWake({
        profile: 'hosted',
        deployment: deployment('cloud', 'postgresql'),
        driver: {
          deploymentProfile: 'cloud',
          kind: 'embedded-sqlite-queue',
          submit: async () => undefined,
        },
        placement: {
          controlPlaneHostId: 'cp-host',
          runtimeHostId: 'cloud-runtime-host',
          runtimeLocation: 'agent_hq_cloud',
          coLocated: false,
        },
        guards: {
          authority: { assertCurrent: async () => undefined },
          residency: { assertCurrent: async () => undefined },
        },
        topology: { assertCurrent: async () => undefined },
      })
    ).rejects.toMatchObject({ code: 'PROFILE_WAKE_MISMATCH' })
  })
})

// Self-hosted-server (PostgreSQL + Restate): integration-gated total-loss restore.
const pgEnabled =
  process.env.RUN_DATABASE_INTEGRATION === 'true' &&
  typeof process.env.DATABASE_URL === 'string' &&
  typeof process.env.DATABASE_ADMIN_URL === 'string' &&
  typeof process.env.DATABASE_MIGRATION_URL === 'string'

describe.skipIf(!pgEnabled)('M17.02.2 self-hosted-server backup/restore (PostgreSQL)', () => {
  test('hosted-server database restores a seeded evaluation into a fresh server after total loss', async () => {
    const { createIsolatedTestDatabase } = await import('@control-plane/database/testing')
    const evaluation = await observedEvaluationFixture()

    const lost = await createIsolatedTestDatabase({
      administration: { role: 'administration', url: process.env.DATABASE_ADMIN_URL },
      migration: { role: 'migration', url: process.env.DATABASE_MIGRATION_URL },
      application: { role: 'application', url: process.env.DATABASE_URL },
    })
    const replacement = await createIsolatedTestDatabase({
      administration: { role: 'administration', url: process.env.DATABASE_ADMIN_URL },
      migration: { role: 'migration', url: process.env.DATABASE_MIGRATION_URL },
      application: { role: 'application', url: process.env.DATABASE_URL },
    })
    try {
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
    } finally {
      await Promise.allSettled([lost.dispose(), replacement.dispose()])
    }
  }, 120_000)
})
