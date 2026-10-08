import { expect, test } from 'bun:test'
import { createUnfinishedChildProcessHarness } from './j1-unfinished-child-process.fixture.mjs'

async function completeParentAndKill(harness, mode = 'before_reservation') {
  const worker = harness.start(mode, 'bun')
  await harness.waitFor((rows) => rows.find((row) => row.stage === 'parent_completed'), worker)
  const before = await harness.descriptor()
  expect(before.grant).toBeDefined()
  expect((await harness.kill(worker)).signal).toBe('SIGKILL')
  return before
}

async function recover(harness, mode = 'recover') {
  const worker = harness.start(mode)
  const snapshot = await harness.waitFor(
    (rows) => rows.find((row) => row.stage === 'recovery_snapshot' && row.pid === worker.child.pid),
    worker
  )
  expect((await worker.exit).code).toBe(0)
  expect(snapshot.productionMode).toBe('emitted')
  expect(snapshot.productionSourceHooksRegistered).toBe(false)
  expect(snapshot.productionModulePaths.length).toBeGreaterThan(0)
  for (const path of snapshot.productionModulePaths) {
    expect(path).toContain('/dist/')
    expect(path.endsWith('.js')).toBe(true)
    expect(path).not.toContain('/src/')
  }
  return snapshot
}

test('J1 unfinished child resumes the same native session after parent completion and owned process SIGKILL', async () => {
  const harness = await createUnfinishedChildProcessHarness()
  try {
    const original = await completeParentAndKill(harness)
    expect(harness.transport.requests).toHaveLength(0)
    const before = (await harness.evidence()).find((row) => row.stage === 'before_reservation')
    expect(before.task.state.checkpoint.phase).toBe('request')
    const snapshot = await recover(harness)
    expect(snapshot.state).toBe('completed')
    expect(snapshot.handle).toEqual(original.grant.child.handle)
    expect(snapshot.grant).toEqual(original.grant)
    expect(snapshot.parentState).toBe('completed')
    expect(snapshot.childState).toBe('completed')
    expect(snapshot.modelUsageCount).toBe(1)
    expect(snapshot.openHoldCount).toBe(0)
    expect(snapshot.inboxTerminalCount).toBe(1)
    expect(harness.transport.requests).toHaveLength(1)
    const replay = await recover(harness)
    expect(replay.handle).toEqual(snapshot.handle)
    expect(replay.grant).toEqual(original.grant)
    expect(replay.modelUsageCount).toBe(1)
    expect(replay.inboxTerminalCount).toBe(1)
    expect(harness.transport.requests).toHaveLength(1)
  } finally {
    await harness.close()
  }
}, 60000)

test('J1 crash after child admission before continuation retention cannot manufacture a grant on recovery', async () => {
  const harness = await createUnfinishedChildProcessHarness()
  try {
    const worker = harness.start('before_grant_retention', 'bun')
    await harness.waitFor(
      (rows) => rows.find((row) => row.stage === 'before_grant_retention'),
      worker
    )
    await harness.kill(worker)
    const snapshot = await recover(harness, 'recover_without_grant')
    expect(snapshot.grant).toBeNull()
    expect(snapshot.parentState).toBe('completed')
    expect(snapshot.blocked).toBe(true)
    expect(snapshot.state).not.toBe('completed')
    expect(snapshot.modelUsageCount).toBe(0)
    expect(snapshot.inboxTerminalCount).toBe(0)
    expect(harness.transport.requests).toHaveLength(0)
  } finally {
    await harness.close()
  }
}, 60000)

test('J1 retained continuation replay preserves exact bytes and expiry does not renew authority', async () => {
  const harness = await createUnfinishedChildProcessHarness()
  try {
    const original = await completeParentAndKill(harness)
    const replay = await recover(harness, 'replay_grant')
    expect(replay.grant).toEqual(original.grant)
    expect(replay.replayOriginalRetained).toBe(true)
    expect(replay.replayChangedDenied).toBe(true)
    await harness.setClock(original.grant.expiresAt)
    const expired = await recover(harness)
    expect(expired.grant).toEqual(original.grant)
    expect(expired.blocked).toBe(true)
    expect(expired.state).not.toBe('completed')
    expect(expired.modelUsageCount).toBe(0)
    expect(expired.openHoldCount).toBe(0)
    expect(expired.inboxTerminalCount).toBe(0)
    expect(harness.transport.requests).toHaveLength(0)
  } finally {
    await harness.close()
  }
}, 60000)

test('J1 concurrent recovery owners cannot duplicate the unfinished child physical send', async () => {
  const harness = await createUnfinishedChildProcessHarness()
  try {
    const original = await completeParentAndKill(harness)
    await Promise.all([recover(harness), recover(harness)])
    const settled = await recover(harness)
    expect(settled.state).toBe('completed')
    expect(settled.handle).toEqual(original.grant.child.handle)
    expect(settled.grant).toEqual(original.grant)
    expect(settled.modelUsageCount).toBe(1)
    expect(settled.inboxTerminalCount).toBe(1)
    expect(harness.transport.requests).toHaveLength(1)
  } finally {
    await harness.close()
  }
}, 60000)

test('J1 retained unknown physical send stays quarantined after parent completion and process death', async () => {
  const harness = await createUnfinishedChildProcessHarness({ ambiguous: true })
  try {
    const worker = harness.start('ambiguous_send', 'bun')
    await harness.waitFor((rows) => rows.find((row) => row.stage === 'parent_completed'), worker)
    await harness.waitFor(() => harness.transport.requests.length === 1, worker)
    const original = await harness.descriptor()
    await harness.kill(worker)
    const snapshot = await recover(harness)
    expect(snapshot.state).toBe('unknown')
    expect(snapshot.handle).toEqual(original.grant.child.handle)
    expect(snapshot.grant).toEqual(original.grant)
    expect(snapshot.modelUsageCount).toBe(0)
    expect(snapshot.openHoldCount).toBe(1)
    expect(snapshot.inboxTerminalCount).toBe(0)
    expect(harness.transport.requests).toHaveLength(1)
    const replay = await recover(harness)
    expect(replay.state).toBe('unknown')
    expect(replay.modelUsageCount).toBe(0)
    expect(replay.openHoldCount).toBe(1)
    expect(replay.inboxTerminalCount).toBe(0)
    expect(harness.transport.requests).toHaveLength(1)
  } finally {
    await harness.close()
  }
}, 60000)
