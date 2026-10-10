import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import { HostedServerGraphRuntime } from './hosted-graph-runtime.ts'

// Hosted two-owner fencing through the hosted composition, against a real disposable PostgreSQL database.
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

function resumeInput(checkpointId) {
  return {
    executionId,
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    workspaceId,
    workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
    graph,
    threadId: 'thread-hosted-1',
    checkpointId,
    response: { action: 'approve' },
    idempotencyKey: 'hosted:legacy:resume',
  }
}

describe.skipIf(!enabled)('hosted legacy fence through the hosted graph activity boundary', () => {
  let isolated
  let runtime

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    const applicationUrl = new URL(loadDatabaseCredentials(process.env, 'application').url)
    applicationUrl.pathname = `/${isolated.name}`
    runtime = new HostedServerGraphRuntime({
      database: isolated.application,
      databaseUrl: applicationUrl.toString(),
      objectStore: {},
      configuration,
    })
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    const failures = []
    for (const cleanup of [() => runtime?.close(), () => isolated?.dispose()]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'HOSTED_LEGACY_FENCE_TEST_CLEANUP_FAILED')
  })

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

  test('the hosted admission gate stays open without deployed legacy inventory', async () => {
    const refusal = await runtime.activities
      .runGraphSegment({
        executionId,
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        workspaceId,
        workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
        graph,
        threadId: 'thread-hosted-2',
        input: { objective: 'hosted admission check' },
        idempotencyKey: 'hosted:legacy:run',
      })
      .then(
        () => undefined,
        (error) => error
      )
    expect(refusal?.code).not.toBe('LEGACY_ADMISSION_CLOSED')
  })
})
