// The startup/RSS budget probe's negative paths, driven deterministically.
//
// Every dependency of the probe is injected, so no process is launched, no
// port is opened and no signal is sent: the cases decide the probe's
// behaviour with fakes, which is what makes the fail-closed contract
// testable at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assessRssSamples,
  classifyListener,
  parseRssSample,
  runStartupBudgetProbe,
} from '../../../scripts/check-startup-budget.mjs'

/** A child handle that records every signal it is asked to receive. */
function fakeChild(pid = 4242) {
  const signals = []
  let exited = false
  return {
    signals,
    markExited() {
      exited = true
    },
    handle: {
      pid,
      hasExited: () => exited,
      stop: async () => {
        signals.push('SIGTERM')
        exited = true
      },
    },
  }
}

/**
 * A listener probe that reports nothing before the launch and the given
 * listeners afterwards: the probe refuses an occupied port BEFORE it starts,
 * so the ownership check only ever sees the listeners the launch produced.
 */
function listenersAfterLaunch(pids) {
  let calls = 0
  return () => {
    calls += 1
    return calls === 1 ? [] : pids
  }
}

test('an unsuccessful RSS sample is refused', () => {
  const sample = parseRssSample({ status: 1, stdout: '1024\n' })
  assert.equal(sample.ok, false)
  assert.match(sample.reason, /failed with status 1/u)
})

test('an empty RSS sample is refused', () => {
  const sample = parseRssSample({ status: 0, stdout: '' })
  assert.equal(sample.ok, false)
  assert.match(sample.reason, /no output/u)
})

test('a malformed RSS sample is refused', () => {
  const sample = parseRssSample({ status: 0, stdout: 'not-a-number\n' })
  assert.equal(sample.ok, false)
  assert.match(sample.reason, /malformed/u)
})

test('a zero RSS sample is refused', () => {
  const sample = parseRssSample({ status: 0, stdout: '0\n' })
  assert.equal(sample.ok, false)
  assert.match(sample.reason, /not a positive value/u)
})

test('a valid RSS sample is accepted', () => {
  const sample = parseRssSample({ status: 0, stdout: ' 180224 \n' })
  assert.equal(sample.ok, true)
  assert.equal(sample.kb, 180224)
})

test('a run with no valid sample fails instead of reporting zero megabytes', () => {
  const assessment = assessRssSamples([])
  assert.equal(assessment.ok, false)
  const refused = assessRssSamples([{ ok: false, reason: 'the RSS sample was malformed' }])
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /refused/u)
})

test('the listener must be the launched child or one of its descendants', () => {
  const parents = new Map([
    [5150, 4242],
    [5151, 5150],
  ])
  const parentOf = (pid) => parents.get(pid)
  assert.equal(classifyListener({ listenerPid: 4242, childPid: 4242, parentOf }).owned, true)
  assert.equal(classifyListener({ listenerPid: 5151, childPid: 4242, parentOf }).owned, true)
  const unrelated = classifyListener({ listenerPid: 9999, childPid: 4242, parentOf })
  assert.equal(unrelated.owned, false)
  assert.match(unrelated.reason, /not the launched child/u)
})

test('a listener PID that cannot be determined is not owned', () => {
  const verdict = classifyListener({
    listenerPid: undefined,
    childPid: 4242,
    parentOf: () => undefined,
  })
  assert.equal(verdict.owned, false)
})

test('an unrelated listener on the port stops the probe before it starts', async () => {
  const child = fakeChild()
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: true }),
    listenerPids: () => [9999],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1000,
    cleanupGraceMs: 10,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /already in use/u)
  // Nothing was launched and nothing was signalled.
  assert.deepEqual(child.signals, [])
})

test('readiness from a listener that is not the child fails closed', async () => {
  const child = fakeChild()
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: true }),
    listenerPids: listenersAfterLaunch([9999]),
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1000,
    cleanupGraceMs: 10,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /not the launched child/u)
})

test('a child that exits before readiness fails fast', async () => {
  const child = fakeChild()
  child.markExited()
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: false }),
    listenerPids: () => [],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 10_000,
    cleanupGraceMs: 10,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /exited before it became ready/u)
})

test('a spawn failure and a missing PID fail closed', async () => {
  const noChild = await runStartupBudgetProbe({
    spawnChild: () => undefined,
    probeReady: async () => ({ ok: false }),
    listenerPids: () => [],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1000,
    cleanupGraceMs: 10,
  })
  assert.equal(noChild.ok, false)
  assert.match(noChild.reason, /could not be launched/u)

  const noPid = await runStartupBudgetProbe({
    spawnChild: () => ({ pid: undefined, hasExited: () => false, stop: async () => {} }),
    probeReady: async () => ({ ok: false }),
    listenerPids: () => [],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1000,
    cleanupGraceMs: 10,
  })
  assert.equal(noPid.ok, false)
  assert.match(noPid.reason, /no PID/u)
})

test('a readiness deadline is bounded and fails closed', async () => {
  const child = fakeChild()
  let clock = 0
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: false }),
    listenerPids: () => [],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async () => {
      clock += 100
    },
    now: () => clock,
    readyTimeoutMs: 1_000,
    cleanupGraceMs: 10,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /never became ready/u)
})

test('a refused RSS sample fails the probe instead of being dropped', async () => {
  const child = fakeChild()
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: true }),
    listenerPids: listenersAfterLaunch([4242]),
    parentOf: () => undefined,
    sampleRss: () => ({ status: 1, stdout: '' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1_000,
    cleanupGraceMs: 10,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /RSS sample was refused/u)
})

test('the cleanup signals only the owned child and awaits it', async () => {
  const child = fakeChild(4242)
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: true }),
    listenerPids: listenersAfterLaunch([4242]),
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '180224' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1_000,
    cleanupGraceMs: 10,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.peakRssMb, Math.round((180224 / 1024) * 10) / 10)
  // Exactly one signal, and it went to the child the probe spawned.
  assert.deepEqual(child.signals, ['SIGTERM'])
})
