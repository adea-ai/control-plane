import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  createUnfinishedChildProcessHarness,
  assertJ1DeniedRecovery,
  assertJ1QuarantinedRecovery,
  assertJ1ConcurrentRecovery,
  assertJ1ImmutableReplay,
  assertJ1FastTerminalRetention,
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
    assertJ1ImmutableReplay(replay)
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
  const harness = await createUnfinishedChildProcessHarness({ holdResponsesForRecovery: true })
  try {
    const original = await completeParentAndKill(harness)
    const pendingContenders = Promise.all([recover(harness), recover(harness)])
    pendingContenders.catch(() => {})
    await harness.waitFor((rows) => {
      const constructed = rows.filter((row) => row.stage === 'recovery_runtime_constructed')
      return new Set(constructed.map((row) => row.pid)).size === 2
    })
    harness.releaseResponses()
    const contenders = await pendingContenders
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

test('J1 proof oracle rejects storage failures masquerading as immutable replay conflicts', () => {
  const legacy = { replayOriginalRetained: true, replayChangedDenied: true }
  expect(legacy.replayChangedDenied).toBe(true)
  expect(() => assertJ1ImmutableReplay(legacy)).toThrow()
  const proven = {
    ...legacy,
    replayMutationRejections: ['expiresAt', 'requestDigest', 'externalSessionId'].map(
      (mutation) => ({
        mutation,
        code: 'PI_CHILD_CONTINUATION_DENIED',
        classification: 'immutable_conflict',
        persistenceFailureCode: null,
      })
    ),
  }
  expect(() => assertJ1ImmutableReplay(proven)).not.toThrow()
  for (const failure of ['SQLITE_BUSY', 5, 'ENOENT']) {
    const unrelated = structuredClone(proven)
    unrelated.replayMutationRejections[1].persistenceFailureCode = failure
    expect(() => assertJ1ImmutableReplay(unrelated)).toThrow()
  }
})

test('J1 fast native child terminal before grant retention cannot acquire continuation authority', async () => {
  const harness = await createUnfinishedChildProcessHarness()
  try {
    const worker = harness.start('fast_child_terminal_before_grant', 'bun')
    const snapshot = await harness.waitFor(
      (rows) =>
        rows.find((row) => row.stage === 'fast_terminal_snapshot' && row.pid === worker.child.pid),
      worker
    )
    expect((await worker.exit).code).toBe(0)
    assertJ1FastTerminalRetention(snapshot)
    expect(harness.transport.requests).toHaveLength(1)
    expect(snapshot.inboxTerminalCount).toBe(0)
    const { piDurableToolSourceKey } = await import('@control-plane/pi-durable-adapter')
    expect(snapshot.source.sourceKey).toBe(piDurableToolSourceKey(snapshot.source.source))
    expect(snapshot.sourceRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect((await harness.descriptor()).grant).toBeUndefined()
  } finally {
    await harness.close()
  }
}, 60000)

test('J1 fast-terminal oracle rejects allowed grants and unrelated storage denials', () => {
  const terminal = {
    stage: 'fast_terminal_snapshot',
    childNativeState: 'completed',
    childNativeTask: {
      kind: 'pi.generation',
      state: { status: 'terminal', outcome: { status: 'completed' } },
    },
    modelUsageCount: 1,
    openHoldCount: 0,
    parentState: 'running',
    retentionOutcome: 'expected_terminal_denial',
    grantDenied: true,
    grantDenialCode: 'PI_CHILD_CONTINUATION_DENIED',
    grant: null,
    retentionRejection: {
      code: 'PI_CHILD_CONTINUATION_DENIED',
      classification: 'terminal_child',
      persistenceFailureCode: null,
    },
  }
  expect(() => assertJ1FastTerminalRetention(terminal)).not.toThrow()
  expect(() =>
    assertJ1FastTerminalRetention({ ...terminal, retentionOutcome: 'allowed', grant: {} })
  ).toThrow()
  expect(() =>
    assertJ1FastTerminalRetention({
      ...terminal,
      retentionRejection: { ...terminal.retentionRejection, persistenceFailureCode: 'SQLITE_BUSY' },
    })
  ).toThrow()
  expect(() =>
    assertJ1FastTerminalRetention({ ...terminal, childNativeState: 'running' })
  ).toThrow()
})

test('J1 evidence poll waits for an incomplete trailing record and rejects malformed complete records', async () => {
  const harness = await createUnfinishedChildProcessHarness()
  try {
    const path = join(harness.directory, 'process-evidence.jsonl')
    // A live writer is mid-record: the complete row is read, the unterminated tail is not parsed.
    await writeFile(path, '{"stage":"parent_completed"}\n{"stage":"recovery_snap')
    expect(await harness.evidence()).toEqual([{ stage: 'parent_completed' }])
    // The record completes on a later poll and is then read in full.
    await appendFile(path, 'shot"}\n')
    expect(await harness.evidence()).toEqual([
      { stage: 'parent_completed' },
      { stage: 'recovery_snapshot' },
    ])
    // A malformed record that ends in a newline is never skipped, even with a tail after it.
    await appendFile(path, '{"stage":oops}\n{"stage":"tail')
    await expect(harness.evidence()).rejects.toThrow(SyntaxError)
  } finally {
    await harness.close()
  }
})
