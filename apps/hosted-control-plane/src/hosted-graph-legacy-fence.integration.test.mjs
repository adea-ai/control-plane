import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { HostedServerGraphRuntime } from './hosted-graph-runtime.ts'

// Hosted fencing and admission through the hosted composition, against real disposable PostgreSQL databases.
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const storageThreadId = `${workspaceId}:${executionId}:thread-hosted-1`
const graph = {
  graphDefinitionId: 'hosted-legacy-graph',
  graphVersion: '1.0.0',
  contentDigest: `sha256:${'b'.repeat(64)}`,
}
const configuration = {
  schemaVersion: 1,
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  currency: 'USD',
  costMicrounits: 25,
  createdAt: '2026-10-10T12:00:00.000Z',
  publishedAt: '2026-10-10T12:00:00.000Z',
}

function uniqueIdentifier(prefix) {
  const seed = randomUUID()
    .replaceAll('-', '')
    .toUpperCase()
    .replace(/[ILOU]/g, 'A')
  return `${prefix}_${seed.slice(0, 26)}`
}

function resumeInput(checkpointId, threadId = 'thread-hosted-1') {
  return {
    executionId,
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    workspaceId,
    workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
    graph,
    threadId,
    checkpointId,
    response: { action: 'approve' },
    idempotencyKey: `hosted:legacy:resume:${threadId}`,
  }
}

function runInput(overrides) {
  return {
    executionId,
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    workspaceId,
    workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
    graph,
    threadId: 'thread-hosted-2',
    input: { objective: 'hosted admission check' },
    idempotencyKey: 'hosted:legacy:run',
    ...overrides,
  }
}

function applicationUrlFor(databaseName) {
  const url = new URL(loadDatabaseCredentials(process.env, 'application').url)
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function isolatedDatabase() {
  const isolated = await createIsolatedTestDatabase({
    administration: loadDatabaseCredentials(process.env, 'administration'),
    application: loadDatabaseCredentials(process.env, 'application'),
    migration: loadDatabaseCredentials(process.env, 'migration'),
  })
  await isolated.migrate()
  return isolated
}

describe.skipIf(!enabled)(
  'hosted legacy fence and admission through the hosted graph activity boundary',
  () => {
    let isolated
    let runtime
    const runtimes = []

    beforeAll(async () => {
      isolated = await isolatedDatabase()
      runtime = new HostedServerGraphRuntime({
        database: isolated.application,
        databaseUrl: applicationUrlFor(isolated.name),
        objectStore: {},
        configuration,
      })
      runtimes.push(runtime)
    }, integrationTestTimeout(60_000))

    afterAll(async () => {
      // A runtime built over a database that the test disposed may already be unusable; its close is best effort.
      for (const hosted of runtimes) await hosted.close().catch(() => undefined)
      await isolated?.dispose()
    })

    async function seedExecution() {
      const seeded = uniqueIdentifier('exe')
      const plan = createExecutionPlanTestFixture()
      await new PostgresContextPackageRepository(isolated.application).put(
        contextPackageSerializationFixtures.futurePi
      )
      await new PostgresExecutionPlanRepository(isolated.application).put(plan)
      const lifecycle = new ExecutionLifecycleService(
        new PostgresExecutionRepository(isolated.application)
      )
      const execution = await lifecycle.createExecution({
        executionId: seeded,
        correlation: plan.correlation,
        executionPlan: {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        },
        acceptedAt: new Date().toISOString(),
      })
      return {
        executionId: seeded,
        lifecycle,
        execution,
        workspaceId: plan.correlation.workspaceId,
      }
    }

    test('two hosted owners cannot both fence a thread, and resume is refused until the exact claim is released', async () => {
      const a = await runtime.legacyDrainFence.claim({ storageThreadId, owner: 'drain-a' })
      await expect(
        runtime.activities.resumeGraphSegment(resumeInput('ckpt-1'))
      ).rejects.toMatchObject({
        code: 'LEGACY_DRAIN_FENCE_HELD',
      })
      await expect(
        runtime.legacyDrainFence.claim({ storageThreadId, owner: 'drain-b' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_HELD' })
      await expect(
        runtime.legacyDrainFence.release({ ...a, owner: 'drain-b' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_NOT_OWNED' })
      expect(await runtime.legacyDrainFence.release(a)).toBe(true)
      const afterRelease = await runtime.activities.resumeGraphSegment(resumeInput('ckpt-1')).then(
        () => undefined,
        (error) => error
      )
      expect(afterRelease?.code).not.toBe('LEGACY_DRAIN_FENCE_HELD')
    })

    test('owners racing for one thread serialize generations and revisions and never both hold it', async () => {
      const thread = `${workspaceId}:${executionId}:thread-race`
      let previous
      for (let round = 1; round <= 12; round += 1) {
        const settled = await Promise.allSettled([
          runtime.legacyDrainFence.claim({ storageThreadId: thread, owner: 'race-a' }),
          runtime.legacyDrainFence.claim({ storageThreadId: thread, owner: 'race-b' }),
        ])
        const winners = settled
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value)
        const losers = settled.filter((result) => result.status === 'rejected')
        expect(winners).toHaveLength(1)
        expect(losers).toHaveLength(1)
        expect(losers[0].reason).toMatchObject({ code: 'LEGACY_DRAIN_FENCE_HELD' })
        const [holder] = winners
        // A fresh thread: each successful claim advances the generation by one, and each claim-release cycle
        // advances the revision by two. Claim N has generation N and revision 2N-1.
        expect(holder).toMatchObject({
          storageThreadId: thread,
          generation: round,
          revision: 2 * round - 1,
        })
        if (previous !== undefined) {
          // The previous holder's handle names an earlier generation. It is refused, and it cannot remove this claim.
          const refusal = await runtime.legacyDrainFence.release(previous).then(
            () => undefined,
            (error) => error
          )
          expect(refusal?.code).toBe(
            previous.owner === holder.owner
              ? 'LEGACY_DRAIN_FENCE_STALE'
              : 'LEGACY_DRAIN_FENCE_NOT_OWNED'
          )
          await expect(
            runtime.activities.resumeGraphSegment(resumeInput('ckpt-race', 'thread-race'))
          ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_HELD' })
        }
        expect(await runtime.legacyDrainFence.release(holder)).toBe(true)
        previous = holder
      }
    })

    test(
      'a disconnected fence store refuses claim, release, and resume rather than allowing them',
      async () => {
        const disconnected = await isolatedDatabase()
        const offline = new HostedServerGraphRuntime({
          database: disconnected.application,
          databaseUrl: applicationUrlFor(disconnected.name),
          objectStore: {},
          configuration,
        })
        runtimes.push(offline)
        await disconnected.dispose()
        const offlineThread = `${workspaceId}:${executionId}:thread-offline`
        const claimRefusal = await offline.legacyDrainFence
          .claim({ storageThreadId: offlineThread, owner: 'drain-a' })
          .then(
            () => undefined,
            (error) => error
          )
        expect(claimRefusal).toBeInstanceOf(Error)
        const releaseRefusal = await offline.legacyDrainFence
          .release({ storageThreadId: offlineThread, owner: 'drain-a', generation: 1, revision: 1 })
          .then(
            () => undefined,
            (error) => error
          )
        expect(releaseRefusal).toBeInstanceOf(Error)
        const resumeRefusal = await offline.activities
          .resumeGraphSegment(resumeInput('ckpt-offline', 'thread-offline'))
          .then(
            () => undefined,
            (error) => error
          )
        expect(resumeRefusal).toBeInstanceOf(Error)
        expect(resumeRefusal?.code).not.toBe('LEGACY_DRAIN_FENCE_HELD')
      },
      integrationTestTimeout(60_000)
    )

    test(
      'a retained uncertain effect refuses admission for its execution until it is reconciled',
      async () => {
        const seeded = await seedExecution()
        const uncertain = await seeded.lifecycle.transitionExecution({
          executionId: seeded.executionId,
          expectedVersion: seeded.execution.version,
          to: 'reconciliation_required',
          transitionedAt: new Date(Date.parse(seeded.execution.acceptedAt) + 1_000).toISOString(),
        })
        expect(uncertain.state).toBe('reconciliation_required')
        const admission = runInput({
          executionId: seeded.executionId,
          workspaceId: seeded.workspaceId,
          threadId: 'thread-uncertain',
          idempotencyKey: 'hosted:uncertain:run',
        })
        const refused = await runtime.activities.runGraphSegment(admission).then(
          () => undefined,
          (error) => error
        )
        expect(refused).toMatchObject({ code: 'LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED' })

        // Reconciliation is the control plane's transition. Once it records the effect as settled, admission is allowed.
        await seeded.lifecycle.transitionExecution({
          executionId: seeded.executionId,
          expectedVersion: uncertain.version,
          to: 'cancelled',
          transitionedAt: new Date(Date.parse(seeded.execution.acceptedAt) + 2_000).toISOString(),
        })
        const admitted = await runtime.activities.runGraphSegment(admission).then(
          () => undefined,
          (error) => error
        )
        expect(admitted?.code).not.toBe('LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED')
      },
      integrationTestTimeout(60_000)
    )

    test('the hosted admission gate stays open without deployed legacy inventory', async () => {
      const refusal = await runtime.activities.runGraphSegment(runInput({})).then(
        () => undefined,
        (error) => error
      )
      expect(refusal?.code).not.toBe('LEGACY_ADMISSION_CLOSED')
      expect(refusal?.code).not.toBe('LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED')
    })
  }
)
