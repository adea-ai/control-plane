// The startup/RSS budget probe's refusals and its child lifecycle.
//
// The pure cases decide the parsing and ownership rules. The command-level
// cases drive REAL subprocesses, so the lifecycle contract — a failed spawn,
// an early exit, a readiness timeout, a thrown dependency and the cleanup —
// is exercised against real processes rather than only against injected fakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'

import {
  assessRssSamples,
  classifyListener,
  createOwnedChildHandle,
  parseRssSample,
  runStartupBudgetProbe,
  stopOwnedChild,
  waitForExit,
} from './startup-budget-probe.mjs'

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
        return { ok: true, reason: 'the fake child exited' }
      },
    },
  }
}

/**
 * Spawns a REAL subprocess and wraps it in the PRODUCTION owned-child
 * handle. The tests therefore exercise the same ownership contract the
 * repository entry point ships, instead of a test-only reimplementation
 * that could mask a divergence.
 */
function spawnOwned(command, args) {
  const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  return { proc, handle: createOwnedChildHandle(proc) }
}

/**
 * Runs `run` against a REAL child and always tears the child down.
 *
 * The teardown is registered as soon as the child exists and is bounded and
 * awaited, so a timeout, a failed assertion or a thrown error inside `run`
 * can never leak the test-owned process. A teardown failure is reported; it
 * never replaces the primary failure.
 */
async function withOwnedChild(command, args, run) {
  const { proc, handle } = spawnOwned(command, args)
  let primary
  let result
  try {
    result = await run({ proc, handle })
  } catch (error) {
    primary = error
  }
  const teardown = await handle.stop()
  if (primary !== undefined) {
    if (teardown.ok === false) primary.cleanupFailure = teardown.reason
    throw primary
  }
  if (teardown.ok === false)
    throw new Error(`the test-owned child did not terminate: ${teardown.reason}`)
  return result
}

/**
 * Runs `run` against a REAL listener child, and always tears the child down.
 *
 * The listener is spawned once and torn down in a `finally`, so the
 * test-owned server cannot outlive the test — not on a timeout, not on a
 * failed assertion and not on a failed fetch.
 */
async function withRealListener(run) {
  const { proc, handle } = spawnOwned(process.execPath, [
    '-e',
    "const server = Bun.serve({ port: 0, fetch: () => new Response('ok') }); console.log(server.port)",
  ])
  let primary
  let result
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the listener did not report a port')), 5_000)
      proc.stdout.once('data', (chunk) => {
        clearTimeout(timer)
        resolve(Number(chunk.toString().trim()))
      })
      proc.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    assert.equal(Number.isSafeInteger(port) && port > 0, true)
    result = await run({ proc, handle, port })
  } catch (error) {
    primary = error
  }
  // The bounded, awaited teardown of the TEST-OWNED server, on every path.
  const teardown = await handle.stop()
  if (primary !== undefined) {
    if (teardown.ok === false) primary.cleanupFailure = teardown.reason
    throw primary
  }
  if (teardown.ok === false)
    throw new Error(`the test-owned listener did not terminate: ${teardown.reason}`)
  return result
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.peakRssMb, Math.round((180224 / 1024) * 10) / 10)
  assert.equal(outcome.cleanup.ok, true)
  // Exactly one signal, and it went to the child the probe spawned.
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('an unavailable listener ownership check fails closed', async () => {
  const child = fakeChild()
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: true }),
    listenerPids: () => {
      throw new Error('lsof could not be executed')
    },
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1_000,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /listener ownership check is unavailable/u)
  assert.deepEqual(child.signals, [])
})

test('a cleanup that does not terminate the child is an explicit failure', async () => {
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => ({
      pid: 4242,
      hasExited: () => false,
      stop: async () => ({ ok: false, reason: 'the child did not exit after SIGKILL' }),
    }),
    probeReady: async () => ({ ok: true }),
    listenerPids: listenersAfterLaunch([4242]),
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '180224' }),
    sleep: async () => {},
    now: () => 0,
    readyTimeoutMs: 1_000,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /did not terminate cleanly/u)
  assert.equal(outcome.cleanup.ok, false)
  assert.match(outcome.cleanup.reason, /did not exit after SIGKILL/u)
})

test('a cleanup that throws is reported as a cleanup failure', async () => {
  const cleanup = await stopOwnedChild({
    stop: async () => {
      throw new Error('the signal could not be delivered')
    },
  })
  assert.equal(cleanup.ok, false)
  assert.match(cleanup.reason, /could not be stopped/u)
})

test('a real spawn failure is reported and nothing is left running', async () => {
  const { proc, handle } = spawnOwned('/nonexistent/adea-startup-budget-entrypoint', [])
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => handle,
    probeReady: async () => ({ ok: false }),
    listenerPids: () => [],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: realSleep,
    now: () => Date.now(),
    readyTimeoutMs: 2_000,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /could not be launched/u)
  assert.equal(outcome.cleanup.ok, true)
  // The spawn never produced a process, so nothing was left running.
  assert.equal(handle.pid, undefined)
  assert.equal(proc.exitCode, null)
  assert.equal(proc.signalCode, null)
})

test('a real child that never becomes ready fails closed and is cleaned up', async () => {
  const { handle } = spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => handle,
    probeReady: async () => ({ ok: false }),
    listenerPids: () => [],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: realSleep,
    now: () => Date.now(),
    readyTimeoutMs: 300,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /never became ready/u)
  assert.equal(outcome.cleanup.ok, true)
  // The owned child was actually terminated, not merely signalled.
  assert.equal(handle.hasExited(), true)
})

test('a real child that exits early fails fast and is cleaned up', async () => {
  const { handle } = spawnOwned(process.execPath, ['-e', 'process.exit(0)'])
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => handle,
    probeReady: async () => ({ ok: false }),
    listenerPids: () => [],
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: realSleep,
    now: () => Date.now(),
    readyTimeoutMs: 5_000,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /exited before it became ready/u)
  assert.equal(outcome.cleanup.ok, true)
  assert.equal(handle.hasExited(), true)
})

test('a thrown dependency fails closed and still cleans the child up', async () => {
  const { handle } = spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => handle,
    probeReady: async () => ({ ok: true }),
    listenerPids: listenersAfterLaunch([handle.pid]),
    parentOf: () => undefined,
    sampleRss: () => {
      throw new Error('the ps sample exploded')
    },
    sleep: realSleep,
    now: () => Date.now(),
    readyTimeoutMs: 2_000,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /the probe failed: the ps sample exploded/u)
  assert.equal(outcome.cleanup.ok, true)
  assert.equal(handle.hasExited(), true)
})

test('the real ps command refuses a dead process', async () => {
  await withOwnedChild(process.execPath, ['-e', 'process.exit(0)'], async ({ proc, handle }) => {
    assert.equal(await waitForExit(proc, 5_000), true)
    const sample = parseRssSample(spawnSync('ps', ['-o', 'rss=', '-p', String(handle.pid)]))
    assert.equal(sample.ok, false)
  })
})

test('a real unrelated listener is refused and is never signalled', async () => {
  await withRealListener(async ({ handle, port }) => {
    const child = fakeChild()
    const outcome = await runStartupBudgetProbe({
      spawnChild: () => child.handle,
      probeReady: async () => ({ ok: true }),
      listenerPids: () => [handle.pid],
      parentOf: () => undefined,
      sampleRss: () => ({ status: 0, stdout: '1024' }),
      sleep: realSleep,
      now: () => Date.now(),
      readyTimeoutMs: 2_000,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /already in use/u)

    // The unrelated listener is still alive and still serving: the probe never
    // signalled a process it does not own.
    assert.equal(handle.hasExited(), false)
    const response = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(await response.text(), 'ok')
  })
})

test('a real unrelated listener is refused after the launch and never signalled', async () => {
  await withRealListener(async ({ handle, port }) => {
    // The probe owns this child, but the teardown is registered here as well
    // so a failure inside the probe cannot leak it.
    const { handle: child } = spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    let outcome
    try {
      outcome = await runStartupBudgetProbe({
        spawnChild: () => child,
        probeReady: async () => ({ ok: true }),
        listenerPids: listenersAfterLaunch([handle.pid]),
        parentOf: () => undefined,
        sampleRss: () => ({ status: 0, stdout: '1024' }),
        sleep: realSleep,
        now: () => Date.now(),
        readyTimeoutMs: 2_000,
      })
    } finally {
      await child.stop()
    }
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /not the launched child/u)
    // The OWNED child was cleaned up; the unrelated listener was not signalled.
    assert.equal(child.hasExited(), true)
    assert.equal(handle.hasExited(), false)
    const response = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(await response.text(), 'ok')
  })
})

test('a failing body still tears the test-owned listener down', async () => {
  let observed
  await assert.rejects(
    withRealListener(async ({ handle }) => {
      observed = handle
      throw new Error('the body failed')
    }),
    /the body failed/u
  )
  assert.notEqual(observed, undefined)
  // The listener was terminated even though the body threw: the test-owned
  // server cannot outlive a failed test.
  assert.equal(observed.hasExited(), true)
})

test('a failing body still tears the test-owned child down', async () => {
  let observed
  await assert.rejects(
    withOwnedChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], async ({ handle }) => {
      observed = handle
      throw new Error('the body failed')
    }),
    /the body failed/u
  )
  assert.notEqual(observed, undefined)
  assert.equal(observed.hasExited(), true)
})
