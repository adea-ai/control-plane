// M17.02.2 (#1025): crash/recovery and portable backup/restore through the
// LocalControlPlaneComposition root (real SQLite persistence and embedded queue).
//
// - Crash/restart: a job whose worker dies keeps its abandoned lease across
//   reopen, is recovered once under the next attempt with the identical workflow
//   key and input, and fences the crashed owner's single-use token.
// - Backup/restore: the composition's own persistence exports through the
//   portable source, refuses while work is active, and restores into a freshly
//   provisioned composition after the source composition is closed.
//
// Primitive semantics (lease token rules, record planning, digest validation,
// binding guards) are owned by the package tests listed in
// docs/profile-recovery-acceptance-map.md and are not repeated here. The
// self-hosted-server PostgreSQL restore is in
// tests/profile-recovery-postgres-restore.integration.test.mjs.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/src/composition.ts'
import {
  SqliteContextPackageRepository,
  SqliteEvaluationRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
} from '@control-plane/sqlite-persistence'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  applyPortableImport,
  exportPortableState,
  planPortableImport,
} from '@control-plane/profile-portability'
import { observedEvaluationFixture } from '../packages/profile-portability/src/evaluation-fixture.mjs'

const createdAt = '2026-10-09T00:00:00.000Z'
const laterAt = '2026-10-09T00:01:00.000Z'
const executionKey = 'exe_01JABCDEF0123456789ABCDEFG'
const leaseMs = 1_000

const temporaryDirectories = []
const temporaryCompositions = []

/** Releases what a composition holds before its directory is removed. A started
 *  composition drains and closes itself through `close()`. An unstarted one is
 *  not closed by `close()`, so its storage handle is released explicitly. Every
 *  release is attempted, and failures surface together. */
async function disposeComposition(composition) {
  const failures = []
  const release = async (step) => {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  await release(() => composition.close())
  await release(() => composition.persistence.close())
  await release(() => composition.coordination.close())
  await release(() => composition.observability.close())
  if (failures.length > 0) {
    throw new AggregateError(failures, 'LocalControlPlaneComposition disposal failed')
  }
}

afterEach(async () => {
  const failures = []
  for (const composition of temporaryCompositions.splice(0)) {
    try {
      await disposeComposition(composition)
    } catch (error) {
      failures.push(error)
    }
  }
  // Directories are removed only after every composition has released its storage.
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'profile recovery cleanup failed')
})

async function openTempDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function openComposition(directory, options = {}) {
  const composition = new LocalControlPlaneComposition({ dataDirectory: directory, ...options })
  temporaryCompositions.push(composition)
  return composition
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

describe('M17.02.2 local composition crash recovery (embedded SQLite queue)', () => {
  test('an abandoned job is recovered once under the next attempt and the crashed owner is fenced', async () => {
    const directory = await openTempDirectory('profile-recovery-local-crash-')
    const crashed = openComposition(directory)
    expect(crashed.profile).toBe('local')
    expect(crashed.durableExecution).toBe('embedded-sqlite')
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
    expect(inflight).toMatchObject({ status: 'running', attempt: 1 })
    const crashedToken = inflight.lease.token

    // Simulated crash: storage closes mid-attempt with the lease held and no outcome.
    crashed.persistence.close()

    // Restart the same composition root over the same retained data directory.
    const restarted = openComposition(directory)
    await restarted.persistence.migrate()
    const retained = await restarted.workflowJobs.get(executionKey)
    expect(retained).toMatchObject({
      status: 'running',
      attempt: 1,
      lease: { owner: 'worker-crashed' },
    })
    expect(retained.input).toEqual(input)

    // The abandoned lease is still live at the crash instant, so nothing is reclaimed.
    await expect(
      restarted.workflowJobs.claimDue({ owner: 'worker-early', leaseMs, now: createdAt, limit: 5 })
    ).resolves.toEqual([])

    // After the lease expires a new owner recovers the same job identity and input.
    const [recovered] = await restarted.workflowJobs.claimDue({
      owner: 'worker-recovered',
      leaseMs,
      now: laterAt,
      limit: 5,
    })
    expect(recovered).toMatchObject({
      workflowKey: executionKey,
      attempt: 2,
      input,
      lease: { owner: 'worker-recovered' },
    })
    expect(recovered.lease.token).not.toBe(crashedToken)

    // The crashed owner's single-use token lands nothing after recovery.
    await expect(
      restarted.workflowJobs.complete({
        workflowKey: executionKey,
        owner: 'worker-crashed',
        token: crashedToken,
        outcome: { executionId: executionKey, status: 'failed' },
        at: laterAt,
      })
    ).resolves.toBe(false)
    expect((await restarted.workflowJobs.get(executionKey)).outcome).toBeUndefined()

    // The recovered owner completes exactly once; a terminal job is never reclaimed.
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
})

describe('M17.02.2 local composition graceful drain', () => {
  test('close waits for an in-flight scheduled reconciliation pass before storage closes', async () => {
    const directory = await openTempDirectory('profile-recovery-local-drain-')
    let releasePass
    const gate = new Promise((resolve) => {
      releasePass = resolve
    })
    let markPassStarted
    const passStarted = new Promise((resolve) => {
      markPassStarted = resolve
    })
    let passFinished = false
    const source = {
      async load() {
        throw new Error('UNEXPECTED_OBSERVATION_LOAD')
      },
      async listCandidates() {
        markPassStarted()
        await gate
        passFinished = true
        return []
      },
    }
    const composition = openComposition(directory, {
      reconciliation: { source, effects: {}, intervalMs: 1, batchLimit: 1 },
    })
    await composition.start()
    await passStarted

    let closed = false
    const closing = composition.close().then(() => {
      closed = true
    })
    try {
      // The pass is held open, so the drain cannot complete however long we wait.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(closed).toBe(false)
      expect(passFinished).toBe(false)
    } finally {
      // Release the gate even when an assertion fails, so the drain settles and
      // storage is not left closing under a pending pass.
      releasePass()
      await closing
    }
    expect(passFinished).toBe(true)
    expect(closed).toBe(true)
  })
})

describe('M17.02.2 local composition portable backup/restore', () => {
  test('backup refuses active work, then restores the evaluation into a fresh composition after total loss', async () => {
    const sourceDirectory = await openTempDirectory('profile-recovery-local-src-')
    const source = openComposition(sourceDirectory)
    await source.persistence.migrate()
    const evaluation = await observedEvaluationFixture()
    await new SqliteEvaluationRepository(source.persistence).saveRun(evaluation)

    await expect(
      exportPortableState(
        new PersistencePortableStateSource({
          persistence: source.persistence,
          componentVersions: { contracts: '1.0.0' },
          activeWorkIds: async () => [executionKey],
        }),
        { exportId: 'fenced-export', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_ACTIVE_WORK' })

    const backup = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: source.persistence,
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

    // Total loss: the source composition is closed before the restore target is opened.
    await disposeComposition(source)
    const restoredDirectory = await openTempDirectory('profile-recovery-local-dst-')
    const restored = openComposition(restoredDirectory)
    await restored.persistence.migrate()
    const destination = new PersistencePortableStateDestination({
      persistence: restored.persistence,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(backup, destination)
    expect(plan).toMatchObject({ applicable: true, conflicts: [] })
    await expect(
      applyPortableImport(backup, plan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })

    // Reopen the restored composition: the retained state is read back from disk.
    await disposeComposition(restored)
    const reopened = openComposition(restoredDirectory)
    await reopened.persistence.migrate()
    await expect(
      new SqliteEvaluationRepository(reopened.persistence).getRun(evaluation.evalRunId)
    ).resolves.toEqual(evaluation)
  })
})
