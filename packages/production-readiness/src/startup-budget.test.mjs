// The startup/RSS budget probe's refusals and its child lifecycle.
//
// The pure cases decide the parsing and ownership rules. The command-level
// cases drive REAL subprocesses, so the lifecycle contract — a failed spawn,
// an early exit, a readiness timeout, a thrown dependency and the cleanup —
// is exercised against real processes rather than only against injected fakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import {
  assessListenerOwnership,
  assessRssSamples,
  classifyListener,
  coversProbeAddress,
  createOwnedChildHandle,
  parseRssSample,
  psParent,
  psRss,
  readListenerPids,
  runStartupBudgetProbe,
  stopOwnedChild,
  waitForExit,
} from './startup-budget-probe.mjs'

/**
 * A listener probe that reports nothing before the launch and the given
 * listeners afterwards: the probe refuses an occupied port BEFORE it starts,
 * so the ownership check only ever sees the listeners the launch produced.
 */
function listenersAfterLaunch(listeners) {
  let calls = 0
  return () => {
    calls += 1
    return calls === 1 ? [] : listeners
  }
}

/** A listener entry as the real lookup reports it. */
function listener(pid, address = '127.0.0.1:3917') {
  return { pid, address }
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

test('a listener set that mixes an owned and an unrelated listener fails closed', () => {
  const parents = new Map()
  const parentOf = (pid) => parents.get(pid)
  // The owned listener is first: checking only the first listener would
  // accept an ambiguous set.
  const mixed = assessListenerOwnership({
    listeners: [listener(4242), listener(9999)],
    childPid: 4242,
    parentOf,
  })
  assert.equal(mixed.owned, false)
  assert.match(mixed.reason, /not the launched child/u)

  // The order of the set does not change the verdict.
  const reversed = assessListenerOwnership({
    listeners: [listener(9999), listener(4242)],
    childPid: 4242,
    parentOf,
  })
  assert.equal(reversed.owned, false)
})

test('every listener on the port must be owned, whatever the order', () => {
  const parentOf = () => undefined
  assert.equal(
    assessListenerOwnership({ listeners: [listener(4242)], childPid: 4242, parentOf }).owned,
    true
  )
  assert.equal(
    assessListenerOwnership({
      listeners: [listener(4242), listener(9999), listener(9998)],
      childPid: 4242,
      parentOf,
    }).owned,
    false
  )
  assert.equal(
    assessListenerOwnership({ listeners: [listener(9999)], childPid: 4242, parentOf }).owned,
    false
  )
  assert.equal(assessListenerOwnership({ listeners: [], childPid: 4242, parentOf }).owned, false)
})

test('a listener whose address could not be read is refused, whoever owns it', () => {
  const parentOf = () => undefined
  // The case root named: the owned child on the probed address plus a socket
  // of the same child whose address could not be read. PID ownership alone
  // does not establish which local address that socket serves, so the set is
  // refused rather than accepted.
  const owned = assessListenerOwnership({
    listeners: [listener(4242), { pid: 4242, address: 'unknown' }],
    childPid: 4242,
    parentOf,
  })
  assert.equal(owned.owned, false)
  assert.match(owned.reason, /address could not be read/u)

  // A foreign PID with an unreadable address is refused as a foreign listener.
  const foreign = assessListenerOwnership({
    listeners: [listener(4242), { pid: 9999, address: 'unknown' }],
    childPid: 4242,
    parentOf,
  })
  assert.equal(foreign.owned, false)
  assert.match(foreign.reason, /not the launched child/u)

  // The unreadable socket on its own leaves nothing that covers the probed
  // address either.
  const alone = assessListenerOwnership({
    listeners: [{ pid: 4242, address: 'unknown' }],
    childPid: 4242,
    parentOf,
  })
  assert.equal(alone.owned, false)
})

test('a listener on another address only is refused, and a wildcard is accepted', () => {
  const parentOf = () => undefined
  const otherAddress = assessListenerOwnership({
    listeners: [listener(4242, '[::1]:3917')],
    childPid: 4242,
    parentOf,
  })
  assert.equal(otherAddress.owned, false)
  assert.match(otherAddress.reason, /probed address/u)

  const wildcard = assessListenerOwnership({
    listeners: [listener(4242, '*:3917')],
    childPid: 4242,
    parentOf,
  })
  assert.equal(wildcard.owned, true)
  assert.equal(coversProbeAddress('*:3917', '127.0.0.1'), true)
  assert.equal(coversProbeAddress('127.0.0.1:3917', '127.0.0.1'), true)
  assert.equal(coversProbeAddress('[::1]:3917', '127.0.0.1'), false)
  assert.equal(coversProbeAddress('unknown', '127.0.0.1'), false)
})

test('several owned listeners on different addresses are accepted', () => {
  const verdict = assessListenerOwnership({
    listeners: [listener(4242, '127.0.0.1:3917'), listener(4242, '[::1]:3917')],
    childPid: 4242,
    parentOf: () => undefined,
  })
  assert.equal(verdict.owned, true)
})

test('an unrelated listener on the port stops the probe before it starts', async () => {
  const child = fakeChild()
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: true }),
    listenerPids: () => [listener(9999)],
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
    listenerPids: listenersAfterLaunch([listener(9999)]),
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
    listenerPids: listenersAfterLaunch([listener(4242)]),
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
    listenerPids: listenersAfterLaunch([listener(4242)]),
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
    listenerPids: listenersAfterLaunch([listener(4242)]),
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

test('a real unrelated listener on another loopback address makes the port ambiguous', async () => {
  // The unrelated listener takes an ephemeral port on the IPv6 loopback; the
  // owned child then listens on the IPv4 loopback of the same port, which is
  // exactly the ambiguous set the ownership check must refuse.
  const unrelated = spawn(
    process.execPath,
    [
      '-e',
      "const s = Bun.serve({ port: 0, hostname: '::1', fetch: () => new Response('ok') }); console.log(s.port)",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const unrelatedHandle = createOwnedChildHandle(unrelated)
  let port
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the listener did not report a port')), 5_000)
      unrelated.stdout.once('data', (chunk) => {
        clearTimeout(timer)
        resolve(Number(chunk.toString().trim()))
      })
    })
    assert.equal(Number.isSafeInteger(port) && port > 0, true)

    const { handle } = spawnOwned(process.execPath, [
      '-e',
      `Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('ok') })`,
    ])
    let outcome
    try {
      // The child must be listening before the readiness probe succeeds.
      const deadline = Date.now() + 10_000
      let ready = false
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`)
          if (response.ok) {
            ready = true
            break
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      assert.equal(ready, true)

      const listeners = readListenerPids(port)
      assert.equal(listeners.length >= 2, true)

      // The pre-launch check sees an empty port and the post-readiness check
      // sees the real set: the ambiguous-set path, with real listener data.
      let calls = 0
      outcome = await runStartupBudgetProbe({
        spawnChild: () => handle,
        probeReady: async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/`)
            return { ok: response.ok }
          } catch {
            return { ok: false }
          }
        },
        listenerPids: () => {
          calls += 1
          return calls === 1 ? [] : readListenerPids(port)
        },
        parentOf: () => undefined,
        sampleRss: () => ({ status: 0, stdout: '1024' }),
        sleep: realSleep,
        now: () => Date.now(),
        readyTimeoutMs: 2_000,
      })
    } finally {
      await handle.stop()
    }
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /not the launched child/u)
    // The unrelated listener was never signalled: it is still serving.
    assert.equal(unrelatedHandle.hasExited(), false)
    const response = await fetch(`http://[::1]:${port}/`)
    assert.equal(await response.text(), 'ok')
  } finally {
    await unrelatedHandle.stop()
  }
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
    listenerPids: listenersAfterLaunch([listener(handle.pid)]),
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
      listenerPids: () => [listener(handle.pid, `127.0.0.1:${port}`)],
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
        listenerPids: listenersAfterLaunch([listener(handle.pid, `127.0.0.1:${port}`)]),
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

/**
 * A stand-in for `lsof` that stalls from the `stallFrom`-th call on.
 *
 * The stall is REAL: the script is what the command boundary actually
 * executes, so the probe's own bound is what ends the wait. `exec` replaces the
 * shell with the sleeper, so the timeout's signal reaches the sleeper itself
 * and no process is left behind by the test.
 */
function writeStallingLsof(directory, stallFrom) {
  const counter = join(directory, 'calls')
  const script = [
    '#!/bin/sh',
    `calls=$(cat "${counter}" 2>/dev/null || echo 0)`,
    'calls=$((calls + 1))',
    `echo "$calls" > "${counter}"`,
    `if [ "$calls" -ge ${String(stallFrom)} ]; then exec sleep 30; fi`,
    'exit 1',
    '',
  ].join('\n')
  const file = join(directory, 'lsof')
  writeFileSync(file, script, { mode: 0o700 })
  return file
}

/**
 * A directory whose `lsof` stalls, and the environment that finds it.
 *
 * The command is resolved through `PATH`, so the stand-in is used by the real
 * `readListenerPids` without changing the function under test.
 */
function stallingLsofEnvironment(directory, stallFrom) {
  writeStallingLsof(directory, stallFrom)
  return {
    ...process.env,
    PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
  }
}

// The TERM disposition survives exec, so these finite stand-ins cannot be
// stopped by spawnSync's default timeout signal. The start marker proves the
// trap was installed before the timeout, rather than testing an early kill.
for (const { name, command, inspect } of [
  {
    name: 'RSS',
    command: 'ps',
    inspect: (env) => {
      const sample = psRss(4242, { timeoutMs: 500, env })
      assert.equal(sample.error?.code, 'ETIMEDOUT')
      assert.equal(parseRssSample(sample).ok, false)
    },
  },
  {
    name: 'parent-PID',
    command: 'ps',
    inspect: (env) => assert.throws(() => psParent(4242, { timeoutMs: 500, env }), /timed out/u),
  },
  {
    name: 'listener',
    command: 'lsof',
    inspect: (env) =>
      assert.throws(() => readListenerPids(3917, { timeoutMs: 500, env }), /timed out/u),
  },
]) {
  test(`a TERM-resistant ${name} inspection cannot outlive its timeout`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'control-plane-inspection-term-'))
    const startedFile = join(directory, 'started')
    try {
      writeFileSync(
        join(directory, command),
        '#!/bin/sh\ntrap "" TERM\nprintf started > "$INSPECTION_STARTED_FILE"\nexec /bin/sleep 2\n',
        { mode: 0o700 }
      )
      // Warm subprocess startup before measuring the inspection timeout itself.
      assert.equal(spawnSync('/usr/bin/true').status, 0)
      const startedAt = Date.now()
      inspect({
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
        INSPECTION_STARTED_FILE: startedFile,
      })
      const elapsedMs = Date.now() - startedAt
      assert.equal(readFileSync(startedFile, 'utf8'), 'started')
      assert.ok(elapsedMs < 1_500, `the inspection ignored its timeout for ${elapsedMs} ms`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test('the real listener lookup refuses a stalled lsof within its bound', async () => {
  // The bound itself, at the command boundary: the real lookup is pointed at a
  // stand-in that never returns, and it must give up inside the bound instead
  // of waiting for the command. An inspection that cannot be made is an
  // inability to prove ownership, so it throws rather than reporting an empty
  // listener set.
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-lsof-bound-'))
  try {
    const env = stallingLsofEnvironment(directory, 1)
    const startedAt = Date.now()
    assert.throws(() => readListenerPids(3917, { timeoutMs: 250, env }), /timed out/u)
    assert.ok(Date.now() - startedAt < 2_000, 'the lookup waited for the stalled command')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a stalled ownership inspection is bounded, fails closed, and still terminates the owned child', async () => {
  // The COMMAND BOUNDARY: the real `lsof` is a stalled stand-in, so the
  // probe's own bound is what ends the wait. Without the bound the probe
  // would hold the owned child open forever, because the cleanup runs after
  // the inspection returns.
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-stalled-lsof-'))
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const { handle: child } = spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  let outcome
  let unrelatedAlive
  const startedAt = Date.now()
  try {
    outcome = await runStartupBudgetProbe({
      spawnChild: () => child,
      probeReady: async () => ({ ok: true }),
      // The first call is the pre-launch check and reports nothing; the second
      // is the post-launch ownership inspection and stalls.
      listenerPids: () =>
        readListenerPids(3917, { timeoutMs: 300, env: stallingLsofEnvironment(directory, 2) }),
      parentOf: () => undefined,
      sampleRss: () => ({ status: 0, stdout: '1024' }),
      sleep: realSleep,
      now: () => Date.now(),
      readyTimeoutMs: 5_000,
    })
    // Observed BEFORE the teardown below: the unrelated process is alive, and
    // the probe never signalled it.
    unrelatedAlive = unrelated.exitCode === null && unrelated.signalCode === null
  } finally {
    await child.stop()
    unrelated.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /timed out/u)
  // The stalled inspection did not hold the probe open: it failed closed
  // within the inspection bound, and the OWNED child was terminated.
  assert.equal(child.hasExited(), true)
  assert.ok(Date.now() - startedAt < 5_000, 'the probe waited for the stalled inspection')
  // The UNRELATED process was never signalled: only the owned child's handle
  // is ever stopped.
  assert.equal(unrelatedAlive, true)
})

test('a stalled ownership inspection before the launch fails closed and launches nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-stalled-lsof-first-'))
  const child = fakeChild()
  let outcome
  try {
    outcome = await runStartupBudgetProbe({
      spawnChild: () => child.handle,
      probeReady: async () => ({ ok: true }),
      // The very first inspection stalls: the port cannot be shown to be free.
      listenerPids: () =>
        readListenerPids(3917, { timeoutMs: 300, env: stallingLsofEnvironment(directory, 1) }),
      parentOf: () => undefined,
      sampleRss: () => ({ status: 0, stdout: '1024' }),
      sleep: realSleep,
      now: () => Date.now(),
      readyTimeoutMs: 1_000,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /ownership check is unavailable/u)
  assert.match(outcome.reason, /timed out/u)
  // Nothing was launched and nothing was signalled.
  assert.deepEqual(child.signals, [])
})

test('the reported ready time is the observation, not the end of a delayed ownership inspection', async () => {
  // The inspection VALIDATES the readiness observation; a slow inspection
  // must not be counted into the measured time-to-ready. The observation is
  // still reported only because the validation passes.
  const child = fakeChild()
  let clock = 0
  let calls = 0
  const outcome = await runStartupBudgetProbe({
    spawnChild: () => child.handle,
    probeReady: async () => ({ ok: true }),
    // The pre-launch check reports nothing; the post-launch ownership
    // inspection takes 1.2 s of the probe's own clock.
    listenerPids: () => {
      calls += 1
      if (calls === 1) return []
      clock += 1_200
      return [listener(child.handle.pid)]
    },
    parentOf: () => undefined,
    sampleRss: () => ({ status: 0, stdout: '1024' }),
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    readyTimeoutMs: 10_000,
  })
  assert.equal(outcome.ok, true)
  // The observation is timestamped after the first poll (100 ms) and before the
  // 1.2 s inspection, so the reported time is 0.1 s and not 1.3 s.
  assert.equal(outcome.readySeconds, 0.1)
})
