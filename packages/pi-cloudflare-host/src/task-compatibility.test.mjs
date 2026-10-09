import { expect, test } from 'bun:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createRegistry, defineTask } from '@earendil-works/pi-durable'
import {
  pinCloudflareTaskCatalog,
  assertCloudflareTaskCompatibility,
} from './task-compatibility.ts'
import { pins, fixture } from './test-fixtures.mjs'
import { openCloudflarePiStorage } from './storage.ts'

function catalog(version = 1, migrations = [], migrate) {
  const registry = createRegistry()
  const task = defineTask({
    name: 'preflight-probe',
    version,
    initial: () => ({ phase: 'test' }),
    phases: {
      test: async () => {
        throw new Error('MUST_NOT_RUN')
      },
    },
    abort: async () => {
      throw new Error('MUST_NOT_ABORT')
    },
    ...(migrate ? { migrate } : {}),
  })
  registry.install({ name: 'probe', tasks: [task] })
  return {
    registry,
    task,
    input: {
      schemaVersion: 1,
      configurationDigest: pins.configurationDigest,
      registry: registry.snapshot(),
      migrations,
    },
  }
}
const record = (version = 1, status = 'pending', kind = 'preflight-probe') => ({
  kind,
  version,
  state: { status },
})
async function check(records, pinned, current = async () => {}) {
  return assertCloudflareTaskCompatibility(
    { scanTasks: async () => ({ items: records }) },
    pinned,
    current,
    BACKGROUND_CONTEXT
  )
}

test('exact native definition and explicitly allowed older migration pass without running code', async () => {
  let migrations = 0
  const c = catalog(2, [{ kind: 'preflight-probe', fromVersion: 1, toVersion: 2 }], () => {
    migrations++
    throw new Error('MUST_NOT_MIGRATE')
  })
  const pinned = pinCloudflareTaskCatalog(c.input, pins)
  await check([record(1), record(2, 'running'), record(1, 'waiting')], pinned)
  expect(migrations).toBe(0)
  c.registry.uninstall(c.registry.snapshot().extension('probe'))
  expect(pinned.registry.snapshot().task('preflight-probe').definition.version).toBe(2)
  c.input.migrations[0].fromVersion = 3
  await check([record(1)], pinned)
})
test('removed, newer, unapproved older and invalid native definitions fail typed nonretryable', async () => {
  for (const entry of [record(1, 'pending', 'removed'), record(2), record(0), record(1.5)]) {
    try {
      await check([entry], pinCloudflareTaskCatalog(catalog().input, pins))
      throw new Error('EXPECTED_DENIAL')
    } catch (error) {
      expect(error.retryable).toBe(false)
      expect(error.classification).toBe('unsupported')
    }
  }
  await expect(
    check([record(1)], pinCloudflareTaskCatalog(catalog(2, [], () => {}).input, pins))
  ).rejects.toThrow('CLOUDFLARE_TASK_VERSION_UNSUPPORTED')
  await check(
    [record(99, 'terminal', 'removed'), record(99, 'completing', 'removed')],
    pinCloudflareTaskCatalog(catalog().input, pins)
  )
})
test('catalog mismatch and nonexistent migration fail before scanning', () => {
  expect(() =>
    pinCloudflareTaskCatalog(
      { ...catalog().input, configurationDigest: `sha256:${'b'.repeat(64)}` },
      pins
    )
  ).toThrow('CLOUDFLARE_TASK_CATALOG_IDENTITY_UNSUPPORTED')
  expect(() =>
    pinCloudflareTaskCatalog(
      catalog(2, [{ kind: 'preflight-probe', fromVersion: 1, toVersion: 2 }]).input,
      pins
    )
  ).toThrow('CLOUDFLARE_TASK_MIGRATION_UNSUPPORTED')
})
test('every page await fences revocation and owner epoch before reading records or another page', async () => {
  for (const message of ['REVOKED', 'OWNER_STALE']) {
    let changed = false,
      scans = 0
    await expect(
      assertCloudflareTaskCompatibility(
        {
          scanTasks: async () => {
            scans++
            changed = true
            return { items: [record()], next: { after: scans } }
          },
        },
        pinCloudflareTaskCatalog(catalog().input, pins),
        async () => {
          if (changed) throw new Error(message)
        },
        BACKGROUND_CONTEXT
      )
    ).rejects.toThrow(message)
    expect(scans).toBe(1)
  }
})
test('pagination has a documented failclosed capacity and rejects stalled cursors', async () => {
  let scans = 0
  const pinned = pinCloudflareTaskCatalog(catalog().input, pins)
  await expect(
    assertCloudflareTaskCompatibility(
      {
        scanTasks: async () => ({
          items: Array.from({ length: 64 }, () => record()),
          next: { after: ++scans },
        }),
      },
      pinned,
      async () => {},
      BACKGROUND_CONTEXT
    )
  ).rejects.toThrow('CLOUDFLARE_TASK_SCAN_LIMIT')
  expect(scans).toBe(16)
  await expect(
    assertCloudflareTaskCompatibility(
      { scanTasks: async () => ({ items: [record()], next: { after: 1 } }) },
      pinned,
      async () => {},
      BACKGROUND_CONTEXT
    )
  ).rejects.toThrow('CLOUDFLARE_TASK_SCAN_INVALID')
})
test('actual native storage scan preserves unknown task input/checkpoint and terminal receipts', async () => {
  const f = fixture()
  const storage = await openCloudflarePiStorage(f.storage)
  try {
    const conversationId = await storage.mintId(),
      taskId = await storage.mintId()
    await storage.commit(
      [
        { type: 'conversation', value: { id: conversationId } },
        {
          type: 'task',
          value: {
            id: taskId,
            conversationId,
            kind: 'removed',
            version: 7,
            input: { opaque: 'retained' },
            background: false,
            abortRequested: false,
            state: { status: 'pending', checkpoint: { phase: 'retained' } },
          },
        },
      ],
      BACKGROUND_CONTEXT
    )
    const before = await storage.scanTasks({}, 64, undefined, BACKGROUND_CONTEXT)
    await expect(
      assertCloudflareTaskCompatibility(
        storage,
        pinCloudflareTaskCatalog(catalog().input, pins),
        async () => {},
        BACKGROUND_CONTEXT
      )
    ).rejects.toThrow('CLOUDFLARE_TASK_DEFINITION_MISSING')
    expect(await storage.scanTasks({}, 64, undefined, BACKGROUND_CONTEXT)).toEqual(before)
  } finally {
    await storage.close(BACKGROUND_CONTEXT)
    f.db.close()
  }
})
