import { expect, test } from 'bun:test'
import {
  createUnfinishedChildProcessHarness,
  assertJ1DeniedRecovery,
  assertJ1QuarantinedRecovery,
  assertJ1ConcurrentRecovery,
} from './j1-unfinished-child-process.fixture.mjs'

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
    assertJ1DeniedRecovery(snapshot, 'PI_CHILD_CONTINUATION_REJECTED')
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
    assertJ1DeniedRecovery(expired, 'PI_CHILD_CONTINUATION_DENIED')
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
    const contenders = await Promise.all([recover(harness), recover(harness)])
    assertJ1ConcurrentRecovery(contenders)
    for (const contender of contenders) {
      expect(contender.handle).toEqual(original.grant.child.handle)
      expect(contender.grant).toEqual(original.grant)
    }
    expect(harness.transport.requests).toHaveLength(1)
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
    assertJ1QuarantinedRecovery(snapshot)
    expect(snapshot.state).toBe('unknown')
    expect(snapshot.handle).toEqual(original.grant.child.handle)
    expect(snapshot.grant).toEqual(original.grant)
    expect(snapshot.modelUsageCount).toBe(0)
    expect(snapshot.openHoldCount).toBe(1)
    expect(snapshot.inboxTerminalCount).toBe(0)
    expect(harness.transport.requests).toHaveLength(1)
    const replay = await recover(harness)
    assertJ1QuarantinedRecovery(replay)
    expect(replay.state).toBe('unknown')
    expect(replay.modelUsageCount).toBe(0)
    expect(replay.openHoldCount).toBe(1)
    expect(replay.inboxTerminalCount).toBe(0)
    expect(harness.transport.requests).toHaveLength(1)
  } finally {
    await harness.close()
  }
}, 60000)

test('J1 proof oracle rejects unrelated blocked errors and concurrent failures', () => {
  const unrelated = { blocked: true, reason: 'SQLITE_BUSY', state: 'unknown' }
  // The old blocked/state-only oracles accepted this unrelated storage error.
  expect(unrelated.blocked).toBe(true)
  expect(unrelated.state).toBe('unknown')
  expect(() => assertJ1DeniedRecovery(unrelated, 'PI_CHILD_CONTINUATION_REJECTED')).toThrow()
  expect(() => assertJ1DeniedRecovery(unrelated, 'PI_CHILD_CONTINUATION_DENIED')).toThrow()
  expect(() => assertJ1QuarantinedRecovery(unrelated)).toThrow()
  // A later sequential success cannot repair two failed concurrent contenders.
  expect(() => assertJ1ConcurrentRecovery([unrelated, unrelated])).toThrow()
  expect(() =>
    assertJ1ConcurrentRecovery([
      { state: 'running', reconciled: true },
      { state: 'running', reconciled: true },
    ])
  ).toThrow()
})

test('J1 proof oracle requires typed canonical denials and real concurrent recovery outcomes', () => {
  const receipt = {
    schemaVersion: 'pi-child-recovery-evidence/v1',
    recoveryBoundary: 'runtime_recover',
    runtimeConstructed: true,
    drainCompleted: true,
    reconciled: true,
    pid: 101,
    journalOwnership: { epoch: 2 },
  }
  const completed = { ...receipt, recoveryOutcome: 'completed', state: 'completed' }
  const competing = {
    ...receipt,
    pid: 102,
    recoveryOutcome: 'competing_owner',
    state: 'running',
    journalOwnership: { epoch: 2, ownerPid: 101, ownerEpoch: 2 },
  }
  expect(() => assertJ1ConcurrentRecovery([completed, competing])).not.toThrow()
  expect(() =>
    assertJ1ConcurrentRecovery([completed, { ...competing, runtimeConstructed: false }])
  ).toThrow()
  expect(() =>
    assertJ1ConcurrentRecovery([completed, { ...competing, journalOwnership: { epoch: 2 } }])
  ).toThrow()
  const quarantined = {
    ...receipt,
    state: 'unknown',
    recoveryOutcome: 'pending_physical_send',
    pendingReason: 'PI_PROCESS_PHYSICAL_SEND_PENDING',
    reconciled: false,
  }
  expect(() => assertJ1QuarantinedRecovery(quarantined)).not.toThrow()
  expect(() =>
    assertJ1QuarantinedRecovery({ ...quarantined, pendingReason: 'SQLITE_BUSY' })
  ).toThrow()
  const denied = {
    schemaVersion: receipt.schemaVersion,
    recoveryBoundary: 'assert_resume',
    recoveryOutcome: 'expected_denial',
    blocked: true,
    parentState: 'completed',
    grant: null,
    reason: 'PI_CHILD_CONTINUATION_REJECTED',
    rejection: {
      stage: 'assert_resume',
      code: 'PI_CHILD_CONTINUATION_REJECTED',
      classification: 'missing_grant',
    },
    expectedCanonicalCondition: {
      kind: 'missing_grant',
      parentState: 'completed',
      grantPresent: false,
    },
  }
  expect(() => assertJ1DeniedRecovery(denied, denied.reason)).not.toThrow()
  expect(() =>
    assertJ1DeniedRecovery(
      {
        ...denied,
        expectedCanonicalCondition: { ...denied.expectedCanonicalCondition, grantPresent: true },
      },
      denied.reason
    )
  ).toThrow()
  expect(() =>
    assertJ1ConcurrentRecovery([completed, { ...competing, pid: completed.pid }])
  ).toThrow()
  expect(() => assertJ1ConcurrentRecovery([completed, { ...competing, pid: 0 }])).toThrow()
})
