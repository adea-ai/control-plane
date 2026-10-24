// M17.02.2 (#1025): SIGKILL of the self-hosted simple composition while its owned, pinned Restate
// child runs.
//
// Scope label: this proof uses the legacy LangGraph test composition (`graphActivitiesFactory` over
// LocalControlPlaneComposition, profile `hosted-simple`, durable execution `restate`). It is not Pi
// Durable host wiring. The parent kills the composition process only. The launcher and native
// Restate server it started keep running as orphans. The parent then reaps exactly those recorded
// processes by hand before a second composition starts on the same data. Each is pinned by a Linux
// pidfd when recorded, so termination and liveness never go through a bare pid that the kernel
// could reissue; where pidfds are unavailable the proof fails closed. It does not adopt orphans.
//
// Proven here: the paused approval survives the kill with its execution, attempt, and version; the
// recovered composition serves the same execution; a duplicate run submission starts no second
// effect; one approval resumes the workflow; `prepare` runs once, `finalize` once, and one result
// artifact is written across both incarnations; owned processes are reaped through pinned handles.
//
// Not covered: automatic orphan adoption, Restate drain, upgrade, rollback, and Hosted. Those stay in
// docs/profile-recovery-acceptance-map.md.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { createRegisteredGraphPlan } from './fixtures/registered-graph-plan.mjs'
import { createCleanupRunner, installSignalCleanup } from './fixtures/runner-cleanup.mjs'
import {
  approvalInteractionId,
  artifactIdOf,
  boundedWait,
  fixturePath,
  graph,
  graphInput,
  liveIdentity,
  ownedNativeServer,
  parseProtocolLine,
  pinnedRestateCommands,
  processExit,
  runInputOf,
  spawnProtocolChild,
  spawnSelfHostedSimpleComposition,
  stopChild,
} from './fixtures/self-hosted-simple-sigkill.mjs'
import {
  createPidfdBackend,
  pinOwnedProcess,
  pinProcess,
  pinSpawned,
  readProcessIdentity,
  sameProcess,
} from './fixtures/pinned-process.mjs'

// This file sits in tests/, so one `..` is the repository root.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const pinned = pinnedRestateCommands()
const EXIT_BOUND_MS = 15_000
const FAILURE_PROBE_WAIT_MS = EXIT_BOUND_MS * 4
const cleanup = []
const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RUNNER_SIGNALS = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]
const OWNER_WITH_CHILD_HANDLE = String.raw`
const { spawn } = require('node:child_process')
const child = spawn('sleep', ['62'], { stdio: 'ignore' })
let transferred = false
let shuttingDown = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk.split(/\r?\n/).includes('transfer')) {
    transferred = true
    process.stdout.write('OWNERSHIP_TRANSFERRED\n')
  }
})
process.on('SIGTERM', () => {
  if (transferred) {
    process.exit(0)
    return
  }
  if (shuttingDown) return
  shuttingDown = true
  if (child.exitCode !== null || child.signalCode !== null) {
    process.exit(0)
    return
  }
  child.once('exit', () => process.exit(0))
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 1_000).unref()
})
process.stdout.write(String(child.pid) + '\n')
`

async function isolatedPorts() {
  const servers = []
  const ports = {}
  try {
    for (const name of [
      'restateAdminPort',
      'restateIngressPort',
      'restateNodePort',
      'workflowEndpointPort',
    ]) {
      const server = createServer()
      servers.push(server)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      ports[name] = server.address().port
    }
    return ports
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

async function ingressPost(ports, executionId, path, body) {
  return fetch(
    `http://127.0.0.1:${ports.restateIngressPort}/execution-lifecycle/${executionId}/${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    }
  )
}

async function waitForFailureOutcome(incarnation, probePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return { kind: 'probe', evidence: JSON.parse(await readFile(probePath, 'utf8')) }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    const failed = incarnation.stages.find((stage) => stage.stage === 'failed')
    if (failed !== undefined) return { kind: 'failed', record: failed }
    const started = incarnation.stages.find((stage) => stage.stage === 'started')
    if (started !== undefined) return { kind: 'started', record: started }
    if (incarnation.child.exitCode !== null || incarnation.child.signalCode !== null) {
      return {
        kind: 'exit',
        result: await boundedWait(incarnation.exited, EXIT_BOUND_MS, 'failure owner exit'),
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { kind: 'timeout' }
}

function completeFailureRestateIdentities(identities) {
  if (!Array.isArray(identities) || identities.length !== 2) return undefined
  const launchers = identities.filter(
    (identity) =>
      typeof identity?.command === 'string' && identity.command.includes(pinned.launcher)
  )
  const natives = identities.filter(
    (identity) => typeof identity?.command === 'string' && identity.command.includes(pinned.native)
  )
  if (launchers.length !== 1 || natives.length !== 1) return undefined

  const [launcher] = launchers
  const [native] = natives
  if (
    !Number.isSafeInteger(launcher.pid) ||
    launcher.pid < 1 ||
    !Number.isSafeInteger(launcher.startTicks) ||
    typeof launcher.started !== 'string' ||
    launcher.started.length === 0 ||
    !Number.isSafeInteger(native.pid) ||
    native.pid < 1 ||
    native.pid === launcher.pid ||
    native.ppid !== launcher.pid ||
    !Number.isSafeInteger(native.startTicks) ||
    typeof native.started !== 'string' ||
    native.started.length === 0
  ) {
    return undefined
  }
  return [launcher, native]
}

async function pinFailureIdentityWithLiveAnchor(identity, parent) {
  const commandIncludes = identity.command.includes(pinned.launcher)
    ? pinned.launcher
    : pinned.native
  const handle = await pinOwnedProcess(identity.pid, { commandIncludes, parent })
  if (!sameProcess(handle.identity, identity)) {
    handle.close()
    throw new Error('PINNED_PROCESS_IDENTITY_MISMATCH: failure identity changed after discovery')
  }
  return handle
}

async function pinOrConfirmFailureIdentities(
  identities,
  owned,
  {
    pinIdentity = pinFailureIdentityWithLiveAnchor,
    identityReader = readProcessIdentity,
    ownershipAnchor,
  } = {}
) {
  const problems = []
  const [launcherIdentity] = identities
  for (const identity of identities) {
    if (owned.some((handle) => sameProcess(handle.identity, identity))) continue
    const isLauncher = identity.command.includes(pinned.launcher)
    const owner = isLauncher
      ? ownershipAnchor
      : owned.find((handle) => sameProcess(handle.identity, launcherIdentity))
    let pinError
    if (owner !== undefined && owner.exited !== true) {
      try {
        owned.push(await pinIdentity(identity, owner))
        continue
      } catch (error) {
        pinError = error
      }
    }
    try {
      const actual = await identityReader(identity.pid)
      if (actual === undefined) continue
      if (
        actual.pid === identity.pid &&
        Number.isSafeInteger(actual.startTicks) &&
        actual.startTicks !== identity.startTicks
      ) {
        // A different kernel start tick proves the recorded process is gone. If ticks match or
        // cannot be read, this may be a same-tick pid reuse and late pinning cannot disambiguate it.
        continue
      }
      problems.push(
        new Error(
          `OWNED_PROCESS_UNPINNED: pid ${identity.pid} may still be the recorded process; no live owner anchor remains`,
          { cause: pinError }
        )
      )
    } catch (readError) {
      problems.push(
        new Error(`OWNED_PROCESS_IDENTITY_READ_FAILED: pid ${identity.pid}`, {
          cause: readError,
        })
      )
    }
  }
  return problems
}

async function cleanupFailureComposition({
  work,
  incarnation,
  owned,
  releasePath,
  timeoutMs,
  pinIdentity = pinFailureIdentityWithLiveAnchor,
  identityReader = readProcessIdentity,
  ownershipAnchor,
}) {
  // Releasing the fixture gate lets a still-starting child fail through its own `finally` and
  // close the composition. Until both Restate processes are pinned, cleanup must not kill the
  // owner and orphan an unrecorded child.
  await writeFile(releasePath, 'cleanup')
  if (incarnation.restateOwnershipRecorded === true) {
    await releaseOwnership({ work, incarnations: [incarnation], owned })
    return
  }
  await boundedWait(incarnation.exited, timeoutMs, 'unrecorded failure composition close')

  // A close can return after a swallowed stop failure. A complete launcher/native pair is needed
  // to pin both exact processes or confirm each recorded identity is gone; partial evidence keeps
  // the work directory even after any already-pinned handles are safely reaped.
  const failed = incarnation.stages.find((stage) => stage.stage === 'failed')
  const identities = completeFailureRestateIdentities(failed?.processIdentities)
  const problems =
    identities === undefined
      ? [new Error('RESTATE_FAILURE_IDENTITIES_INCOMPLETE')]
      : await pinOrConfirmFailureIdentities(identities, owned, {
          pinIdentity,
          identityReader,
          ownershipAnchor,
        })
  let unconfirmed = await reapOwned(owned)
  if (unconfirmed.length > 0) unconfirmed = await reapOwned(owned)
  for (const { identity, reason } of unconfirmed) {
    problems.push(new Error(`OWNED_PROCESS_UNCONFIRMED: pid ${identity.pid} (${reason})`))
  }
  if (problems.length > 0 || owned.length > 0) {
    if (owned.length > 0 && unconfirmed.length === 0) {
      problems.push(new Error('OWNED_PROCESS_HANDLES_RETAINED'))
    }
    throw new AggregateError(
      problems,
      `cleanup incomplete; state preserved for diagnosis at ${work}`
    )
  }
  await rm(work, { recursive: true, force: true })
}

async function exerciseRejectedCompositionBeforeHandshake(
  failureMethod,
  { probeDelayMs = 0 } = {}
) {
  const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-health-failure-'))
  const releasePath = join(work, `release-${failureMethod}-failure`)
  const config = {
    dataDirectory: join(work, 'data'),
    ports: await isolatedPorts(),
    failureBeforeOwnershipHandshake: {
      method: failureMethod,
      probePath: join(work, `${failureMethod}-failure.json`),
      stopFailurePath: join(work, `${failureMethod}-stop-failure.json`),
      failStopAfterStart: failureMethod === 'start',
      probeDelayMs,
      releasePath,
    },
  }
  const owned = []
  const initial = spawnSelfHostedSimpleComposition('initial', config)
  const incarnation = initial
  const probeWaitMs = FAILURE_PROBE_WAIT_MS + probeDelayMs
  let cleanupHandled = false
  const cleanupFailure = async () => {
    if (cleanupHandled) return
    await cleanupFailureComposition({
      work,
      incarnation,
      owned,
      releasePath,
      timeoutMs: probeWaitMs + EXIT_BOUND_MS * 2,
    })
    cleanupHandled = true
  }
  cleanup.push(cleanupFailure)

  const outcome = await waitForFailureOutcome(
    initial,
    config.failureBeforeOwnershipHandshake.probePath,
    probeWaitMs
  )
  let evidence
  if (outcome.kind === 'probe') {
    evidence = outcome.evidence
  } else if (outcome.kind === 'started') {
    // If the fixture unexpectedly reaches its normal handshake, still pin the owner tree before
    // failing this expectation so afterEach can clean it without risking an orphan.
    await recordOwnedRestate(incarnation, owned, 'initial', outcome.record)
  }
  expect(outcome.kind).toBe('probe')
  expect(evidence.method).toBe(failureMethod)
  expect(evidence.probeDelayMs).toBe(probeDelayMs)
  expect(evidence.probeDelayElapsedMs).toBeGreaterThanOrEqual(probeDelayMs)
  expect(evidence.processIdentities).toHaveLength(2)
  const recorded = await recordOwnedRestate(incarnation, owned, 'initial', evidence)
  expect(owned.map((handle) => handle.identity)).toEqual(evidence.processIdentities)

  await writeFile(releasePath, 'continue')
  await expect(initial.next('started', EXIT_BOUND_MS)).rejects.toThrow(
    `PROTOCOL_CHILD_FAILED: SELF_HOSTED_SIMPLE_INJECTED_${failureMethod.toUpperCase()}_FAILURE`
  )
  expect(initial.stages.some((stage) => stage.stage === 'started')).toBe(false)
  expect(initial.stages.find((stage) => stage.stage === 'failed')).toMatchObject({
    processIdentities: evidence.processIdentities,
  })
  if (failureMethod === 'start') {
    expect(existsSync(config.failureBeforeOwnershipHandshake.stopFailurePath)).toBe(true)
    await cleanupFailure()
    expect(
      await boundedWait(initial.exited, EXIT_BOUND_MS, 'partially started composition cleanup')
    ).toBeDefined()
    expect(owned).toEqual([])
    expect(existsSync(work)).toBe(false)
    return
  }
  expect(await boundedWait(initial.exited, EXIT_BOUND_MS, 'failed composition exit')).toEqual({
    code: 1,
    signal: null,
  })
  expect(recorded.launcher.exited).toBe(true)
  expect(recorded.native.exited).toBe(true)
}

function spawnHandleOwner() {
  const owner = spawn(process.execPath, ['-e', OWNER_WITH_CHILD_HANDLE], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const exited = processExit(owner)
  const lines = []
  const waiters = []
  let buffer = ''
  owner.stdout.setEncoding('utf8')
  owner.stdout.on('data', (chunk) => {
    buffer += chunk
    const output = buffer.split('\n')
    buffer = output.pop()
    for (const line of output) {
      const waiter = waiters.shift()
      if (waiter) waiter(line.trim())
      else lines.push(line.trim())
    }
  })
  const nextLine = () =>
    lines.length > 0
      ? Promise.resolve(lines.shift())
      : new Promise((resolve) => waiters.push(resolve))
  return { owner, exited, nextLine }
}

/** Records and pins the launcher and native server of one incarnation, once its composition has
 *  started. Ownership is anchored to the original spawned composition, not to a numeric pid from
 *  the protocol: the composition is pinned first and must still be running, the launcher must be
 *  its child, and the native server a child of the pinned launcher. Each launcher and native handle
 *  enters `owned` as soon as it is pinned, so a failure while recording the next process leaves the
 *  earlier one recorded for the reap. The composition anchor is released once the chain is pinned;
 *  the test stops the composition through its own child handle. */
async function recordOwnedRestate(
  incarnation,
  owned,
  mode,
  { pid: compositionPid, launcherPid },
  discoverNative = ownedNativeServer
) {
  const composition = await pinSpawned(incarnation.child, compositionPid, {
    commandIncludes: `${fixturePath} ${mode}`,
  })
  try {
    const launcher = await pinOwnedProcess(launcherPid, {
      commandIncludes: pinned.launcher,
      parent: composition,
    })
    owned.push(launcher)
    // Discovery records a full candidate identity; the pin below proves the same process is still
    // the owned child before it can be reaped.
    const candidate = await discoverNative(launcherPid, pinned.native)
    const native = await pinRecordedOwnedProcess(candidate, {
      commandIncludes: pinned.native,
      parent: launcher,
    })
    owned.push(native)
    incarnation.restateOwnershipRecorded = true
    return { launcher, native }
  } finally {
    composition.close()
  }
}

/** Pins the process discovered as a native child and rejects a same-pid replacement before it is
 *  treated as the recorded Restate server. Parentage is checked by pinOwnedProcess; startTicks
 *  distinguishes same-command replacements that begin in the same ps start-time second. */
async function pinRecordedOwnedProcess(
  expected,
  { commandIncludes, parent, parentPid, ...options }
) {
  const ownerPid = parentPid ?? parent?.identity.pid
  if (ownerPid === undefined) throw new Error('PINNED_PROCESS_OWNER_IDENTITY_MISSING')
  if (expected.startTicks === undefined) {
    throw new Error('PINNED_PROCESS_IDENTITY_INCOMPLETE: native candidate has no start ticks')
  }
  if (expected.ppid !== ownerPid) {
    throw new Error(
      'PINNED_PROCESS_IDENTITY_MISMATCH: native candidate is not owned by its launcher'
    )
  }
  const handle = await pinOwnedProcess(expected.pid, {
    commandIncludes,
    parent,
    parentPid: ownerPid,
    ...options,
  })
  if (!sameProcess(handle.identity, expected)) {
    handle.close()
    throw new Error('PINNED_PROCESS_IDENTITY_MISMATCH: native process changed after discovery')
  }
  return handle
}

/** Terminates every pinned process. A confirmed one leaves `owned` and its handle is released; any
 *  other stays in it, handle and identity intact, with the reason, so the same process can be
 *  diagnosed or retried. Each attempt is independent, and nothing is signalled by bare pid. */
async function reapOwned(owned, options) {
  const unconfirmed = []
  for (const handle of [...owned].toReversed()) {
    try {
      if (await handle.terminate(options)) {
        handle.close()
        owned.splice(owned.indexOf(handle), 1)
      } else {
        unconfirmed.push({
          identity: handle.identity,
          reason: 'still live after SIGTERM and SIGKILL',
        })
      }
    } catch (error) {
      unconfirmed.push({
        identity: handle.identity,
        reason: `signal failed: ${error.code ?? error.message}`,
      })
    }
  }
  return unconfirmed
}

/** Pins any missing ownership chain before ending a live composition, then reaps recorded Restate
 *  identities. Incomplete chains retain live owners and handles without signalling them. The work
 *  directory is removed only when nothing remains unconfirmed;
 *  otherwise it and the recorded identities are kept for diagnosis. */
async function releaseOwnership({
  work,
  incarnations,
  owned,
  exitBoundMs = EXIT_BOUND_MS,
  reapOwnedProcesses = reapOwned,
}) {
  const problems = []
  for (const [index, incarnation] of incarnations.entries()) {
    const label = `composition incarnation ${index} (pid ${incarnation.child.pid ?? 'unspawned'})`
    if (
      incarnation.restateOwnershipRecorded !== true &&
      incarnation.child.exitCode === null &&
      incarnation.child.signalCode === null
    ) {
      try {
        if (!['initial', 'recover'].includes(incarnation.mode)) {
          throw new Error('RESTATE_CLEANUP_MODE_MISSING')
        }
        incarnation.child.stdin.write('pin_cleanup\n')
        const started = await incarnation.next('cleanup_started', exitBoundMs, {
          ignoreFailures: true,
        })
        await recordOwnedRestate(incarnation, owned, incarnation.mode, started)
      } catch (error) {
        problems.push(error)
      }
    }
    if (incarnation.restateOwnershipRecorded !== true) {
      // Preserve the live owner and partial handles. Killing either the composition or just the
      // launcher can orphan a native child that was never pinned. No force fallback is safe.
      problems.push(new Error(`RESTATE_OWNERSHIP_UNRECORDED: ${label}`))
      continue
    }
    try {
      await stopChild(incarnation, { label, timeoutMs: exitBoundMs })
    } catch (error) {
      problems.push(error)
    }
  }
  const incomplete = incarnations.some((entry) => entry.restateOwnershipRecorded !== true)
  let unconfirmed
  if (incomplete) {
    unconfirmed = []
    for (const handle of owned.toReversed()) {
      if (handle.exited) {
        handle.close()
        owned.splice(owned.indexOf(handle), 1)
      } else {
        unconfirmed.push({
          identity: handle.identity,
          reason: 'ownership chain incomplete; retained',
        })
      }
    }
  } else {
    unconfirmed = await reapOwnedProcesses(owned)
    // One retry, limited to identities that are still recorded and not confirmed gone.
    if (unconfirmed.length > 0) unconfirmed = await reapOwnedProcesses(owned)
  }
  for (const { identity, reason } of unconfirmed) {
    problems.push(
      new Error(
        `OWNED_PROCESS_UNCONFIRMED: pid ${identity.pid} started ${identity.started} (${reason})`
      )
    )
  }
  if (problems.length > 0) {
    throw new AggregateError(
      problems,
      `cleanup incomplete; state preserved for diagnosis at ${work}`
    )
  }
  await rm(work, { recursive: true, force: true })
}

/** Ends a spawned owner and whatever was pinned beneath it, through handles only: the owner's
 *  ChildProcess (SIGTERM, then SIGKILL after the bound) and the pinned child and anchor. It is safe
 *  after any failure, including a child that is already terminated and closed, and signals no bare
 *  pid, so a reused pid can never be hit. Each step is attempted even after an earlier failure. */
async function releaseSpawnedOwner({ owner, ownerExit, handles, exitBoundMs = EXIT_BOUND_MS }) {
  const problems = []
  try {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGTERM')
    await boundedWait(ownerExit, exitBoundMs, 'owner exit').catch(async () => {
      owner.kill('SIGKILL')
      await boundedWait(ownerExit, exitBoundMs, 'owner exit after SIGKILL')
    })
  } catch (error) {
    problems.push(error)
  }
  const unconfirmedHandles = []
  for (const handle of handles()) {
    let terminated = false
    try {
      terminated = await handle.terminate({ graceMs: 5000, forceMs: 5000 })
      if (!terminated) {
        problems.push(new Error(`pinned process ${handle.identity.pid} is still running`))
      }
    } catch (error) {
      problems.push(error)
    }
    if (terminated) {
      try {
        handle.close()
      } catch (error) {
        problems.push(error)
      }
    } else {
      unconfirmedHandles.push(handle)
    }
  }
  if (problems.length > 0) {
    const failure = new AggregateError(problems, 'owner teardown')
    // Keep failed pidfd handles reachable and open so callers can safely retry or diagnose them.
    failure.unconfirmedHandles = unconfirmedHandles
    throw failure
  }
}

const runRegisteredCleanup = createCleanupRunner(cleanup, 'self-hosted simple SIGKILL cleanup')

afterEach(() => runRegisteredCleanup())

// A runner ended by a signal (a CI timeout, Ctrl-C) never reaches afterEach, and would leave the
// composition and its Restate children running. The signal path shares afterEach's serialized
// cleanup, so it waits for any cleanup already in flight, runs what remains through the same
// handles, then exits with the conventional signal status.
installSignalCleanup({ run: runRegisteredCleanup, signals: RUNNER_SIGNALS })

describe('M17.02.2 legacy LangGraph test composition: SIGKILL with manual orphan reap (not Pi Durable host wiring, no orphan adoption)', () => {
  async function exerciseSigkillRecovery(recoveryCloseVia) {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-sigkill-'))
    const dataDirectory = join(work, 'data')
    const evidencePath = join(work, 'effects.jsonl')
    const ports = await isolatedPorts()
    const owned = []
    const incarnations = []
    cleanup.push(() => releaseOwnership({ work, incarnations, owned }))
    const config = { dataDirectory, ports, evidencePath }

    const initial = spawnSelfHostedSimpleComposition('initial', config)
    incarnations.push(initial)
    const started = await initial.next('started')
    const initialOwned = await recordOwnedRestate(initial, owned, 'initial', started)
    const paused = await initial.next('awaiting_input', 60_000)
    expect(paused).toMatchObject({ state: 'awaiting_input', attemptCount: 1 })
    const { executionId } = paused

    // SIGKILL the composition process only. Its owned Restate child keeps running.
    expect(initial.child.kill('SIGKILL')).toBe(true)
    expect(await boundedWait(initial.exited, EXIT_BOUND_MS, 'initial composition exit')).toEqual({
      code: null,
      signal: 'SIGKILL',
    })
    expect(await liveIdentity(initialOwned.native.identity)).toBeDefined()
    expect(await liveIdentity(initialOwned.launcher.identity)).toBeDefined()

    // Manual orphan reap: the recovery composition needs the data directory and ports. Only the
    // identities recorded above are signalled.
    expect(await reapOwned(owned)).toEqual([])
    expect(await liveIdentity(initialOwned.native.identity)).toBeUndefined()
    expect(await liveIdentity(initialOwned.launcher.identity)).toBeUndefined()

    const recovery = spawnSelfHostedSimpleComposition('recover', { ...config, executionId })
    incarnations.push(recovery)
    const recoveredStarted = await recovery.next('started')
    const recoveredOwned = await recordOwnedRestate(recovery, owned, 'recover', recoveredStarted)
    const recovered = await recovery.next('recovered')
    // Same execution identity, attempt, and version as before the kill.
    expect(recovered).toMatchObject({
      executionId,
      state: 'awaiting_input',
      version: paused.version,
      attemptCount: 1,
      latestAttemptId: paused.latestAttemptId,
    })

    // A duplicate run submission from a second owner starts no second effect.
    const plan = createRegisteredGraphPlan(graph, graphInput)
    expect(
      (await ingressPost(ports, executionId, 'run/send', runInputOf(plan, executionId))).ok
    ).toBe(true)
    // One approval resumes the workflow; a conflicting second answer must not apply.
    expect(
      (
        await ingressPost(ports, executionId, 'respondToInteraction', {
          interactionId: approvalInteractionId,
          responseId: 'self-hosted-response-one',
          action: 'approve',
        })
      ).ok
    ).toBe(true)
    await ingressPost(ports, executionId, 'respondToInteraction', {
      interactionId: approvalInteractionId,
      responseId: 'self-hosted-response-two',
      action: 'deny',
    })
    const completed = await recovery.next('completed', 60_000)
    expect(completed).toMatchObject({
      executionId,
      state: 'completed',
      attemptCount: 1,
      latestAttemptId: paused.latestAttemptId,
      terminalResultRef: artifactIdOf(executionId),
      result: { decision: 'approve' },
    })

    // Graceful close of the recovery composition stops its own Restate child. Either an explicit
    // close request or the parent ending its pipe (a parent that died) closes it.
    if (recoveryCloseVia === 'stdin-eof') recovery.child.stdin.end()
    else recovery.child.stdin.write('close\n')
    await recovery.next('closed')
    expect(await boundedWait(recovery.exited, EXIT_BOUND_MS, 'recovery composition exit')).toEqual({
      code: 0,
      signal: null,
    })
    expect(await liveIdentity(recoveredOwned.native.identity)).toBeUndefined()
    expect(await liveIdentity(recoveredOwned.launcher.identity)).toBeUndefined()

    // Effects across both incarnations: each graph operation and the result artifact once.
    const effects = (await readFile(evidencePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      effects
        .filter((entry) => entry.kind === 'operation')
        .map((entry) => [entry.incarnation, entry.detail])
    ).toEqual([
      ['initial', 'prepare'],
      ['recovery', 'finalize'],
    ])
    expect(effects.filter((entry) => entry.kind === 'artifact')).toHaveLength(1)
    expect(new Set(effects.map((entry) => entry.pid)).size).toBe(2)
  }

  test('SIGKILL of the composition while its pinned Restate child runs recovers the same execution with no duplicate effect', async () => {
    await exerciseSigkillRecovery('close-line')
  }, 120000)

  test('a recovered composition whose parent ends its pipe closes itself and its Restate child instead of waiting forever', async () => {
    await exerciseSigkillRecovery('stdin-eof')
  }, 120000)

  test('a stranded initial composition closes its Restate child when its parent ends its pipe', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-parent-gone-'))
    const owned = []
    const incarnations = []
    cleanup.push(() => releaseOwnership({ work, incarnations, owned }))
    const config = {
      dataDirectory: join(work, 'data'),
      ports: await isolatedPorts(),
      evidencePath: join(work, 'effects.jsonl'),
    }
    const initial = spawnSelfHostedSimpleComposition('initial', config)
    incarnations.push(initial)
    const started = await initial.next('started')
    const initialOwned = await recordOwnedRestate(initial, owned, 'initial', started)
    await initial.next('awaiting_input', 60_000)

    // The parent goes away without SIGKILLing the composition. It must not sit out its keep-alive
    // holding the ports, the data directory and its Restate child.
    initial.child.stdin.end()
    expect(
      await boundedWait(initial.exited, EXIT_BOUND_MS, 'stranded initial composition exit')
    ).toEqual({ code: 0, signal: null })
    expect(await liveIdentity(initialOwned.native.identity)).toBeUndefined()
    expect(await liveIdentity(initialOwned.launcher.identity)).toBeUndefined()
  }, 120000)

  describe('pinned process termination', () => {
    /** A bystander this test owns, with its recorded identity and an exit promise. */
    async function spawnBystander(argv = ['60']) {
      const bystander = spawn('sleep', argv, { stdio: 'ignore' })
      const exit = processExit(bystander)
      cleanup.push(async () => {
        if (bystander.exitCode === null && bystander.signalCode === null) bystander.kill('SIGKILL')
        await boundedWait(exit, EXIT_BOUND_MS, 'bystander exit')
      })
      let identity
      for (let attempt = 0; attempt < 50 && identity === undefined; attempt += 1) {
        identity = await readProcessIdentity(bystander.pid)
        if (identity === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(identity).toBeDefined()
      return { bystander, exit, identity }
    }

    /** Forbids bare-pid signalling for the duration of `run`, and reports any attempt. */
    async function withoutPidSignals(run) {
      const attempts = []
      const original = process.kill
      process.kill = (...args) => {
        attempts.push(args)
        throw new Error('PID_SIGNAL_FORBIDDEN')
      }
      try {
        await run()
      } finally {
        process.kill = original
      }
      expect(attempts).toEqual([])
    }

    test('terminating a pinned process signals exactly that process, through its handle and never its pid', async () => {
      const { bystander, exit, identity } = await spawnBystander()
      const other = await spawnBystander()
      const handle = await pinProcess(identity)
      expect(handle.identity).toMatchObject({ pid: identity.pid, command: identity.command })
      expect(handle.identity.startTicks).toBeGreaterThan(0)

      await withoutPidSignals(async () => {
        expect(await handle.terminate()).toBe(true)
      })
      expect(await boundedWait(exit, EXIT_BOUND_MS, 'bystander exit')).toMatchObject({
        signal: 'SIGTERM',
      })
      expect(bystander.exitCode ?? bystander.signalCode).not.toBeNull()
      // The other process of the same command was never touched.
      expect(other.bystander.exitCode).toBeNull()
      expect(other.bystander.signalCode).toBeNull()
      expect(await liveIdentity(other.identity)).toBeDefined()
      handle.close()
    })

    test('a stale or foreign identity is refused before any signal, and a later correct pin still works', async () => {
      const { bystander, exit, identity } = await spawnBystander()
      const refusals = [
        // A recorded start time that no longer matches: the pid was reissued.
        { ...identity, started: 'Mon Jan  1 00:00:00 2001' },
        // Same pid, different recorded start tick.
        { ...identity, startTicks: identity.startTicks + 1 },
        // A same-named process is not the recorded command.
        { ...identity, command: `${identity.command} --impostor` },
        // A pid that no process holds.
        { ...identity, pid: 2 ** 22 + 1 },
      ]
      await withoutPidSignals(async () => {
        for (const stale of refusals) {
          await expect(pinProcess(stale)).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
        }
      })
      expect(bystander.exitCode).toBeNull()
      expect(bystander.signalCode).toBeNull()
      expect(await liveIdentity(identity)).toBeDefined()

      // The failed attempts left nothing behind: the exact identity still pins and terminates.
      const handle = await pinProcess(identity)
      expect(await handle.terminate()).toBe(true)
      expect(await boundedWait(exit, EXIT_BOUND_MS, 'bystander exit')).toMatchObject({
        signal: 'SIGTERM',
      })
      handle.close()
    })

    test('a pinned handle stays bound to its process after it exits and never reaches a later holder of the pid', async () => {
      const { bystander, exit, identity } = await spawnBystander()
      const handle = await pinProcess(identity)
      expect(handle.exited).toBe(false)

      bystander.kill('SIGKILL')
      await boundedWait(exit, EXIT_BOUND_MS, 'bystander exit')
      // The handle reports the pinned process gone and refuses to signal; it does not fall back to
      // the pid, which the kernel may now hand to any other process.
      expect(handle.exited).toBe(true)
      await withoutPidSignals(async () => {
        expect(handle.signal('SIGKILL')).toBe(false)
        expect(await handle.terminate()).toBe(true)
      })
      handle.close()
    })

    test('a pid reissued to another process after pinning is never signalled', async () => {
      // Deterministic reissue: the injected pid table hands the pinned pid to an impostor once the
      // pinned process exits. Real pid reuse cannot be forced without privileges.
      const impostor = { alive: true, signals: [] }
      const pinnedProcess = { alive: true, signals: [] }
      const holders = new Map([[777, pinnedProcess]])
      const descriptors = new Map()
      const backend = {
        open: (pid) => {
          const holder = holders.get(pid)
          if (holder === undefined) return undefined
          descriptors.set(7, holder)
          return 7
        },
        send: (fd, signal) => {
          const target = descriptors.get(fd)
          if (!target.alive) return false
          target.signals.push(signal)
          if (signal === 9) target.alive = false
          return true
        },
        exited: (fd) => !descriptors.get(fd).alive,
        close: (fd) => descriptors.delete(fd),
      }
      const expected = { pid: 777, started: 'fixture', command: 'fixture-command', startTicks: 1 }
      const handle = await pinProcess(expected, {
        backend,
        readIdentity: async () => ({ ...expected, startTicks: 1 }),
      })

      // The pinned process exits on its own and its pid is reissued to the impostor.
      pinnedProcess.alive = false
      holders.set(777, impostor)

      await withoutPidSignals(async () => {
        expect(await handle.terminate()).toBe(true)
        expect(handle.signal('SIGKILL')).toBe(false)
      })
      expect(impostor.signals).toEqual([])
      expect(pinnedProcess.signals).toEqual([])
    })

    test('a process that outlives termination keeps its handle and identity, and a retry reaches the same process', async () => {
      const survivor = { alive: true, signals: [], ignoreSignals: 3 }
      const closed = []
      const backend = {
        open: () => 9,
        send: (_fd, signal) => {
          survivor.signals.push(signal)
          if (survivor.ignoreSignals > 0) {
            survivor.ignoreSignals -= 1
          } else {
            survivor.alive = false
          }
          return true
        },
        exited: () => !survivor.alive,
        close: (fd) => closed.push(fd),
      }
      const expected = { pid: 4242, started: 'fixture', command: 'fixture-command', startTicks: 5 }
      const handle = await pinProcess(expected, {
        backend,
        readIdentity: async () => ({ ...expected, startTicks: 5 }),
      })
      const identityBefore = structuredClone(handle.identity)
      const owned = [handle]

      // First pass: SIGTERM and SIGKILL are both ignored. Nothing is lost.
      const first = await reapOwned(owned, { graceMs: 30, forceMs: 30, pollMs: 5 })
      expect(first).toEqual([
        { identity: identityBefore, reason: 'still live after SIGTERM and SIGKILL' },
      ])
      expect(owned).toEqual([handle])
      expect(handle.identity).toEqual(identityBefore)
      expect(closed).toEqual([])
      expect(survivor.signals).toEqual([15, 9])

      // The retry uses the same handle, reaches the same process, and only then releases it.
      expect(await reapOwned(owned, { graceMs: 30, forceMs: 30, pollMs: 5 })).toEqual([])
      expect(owned).toEqual([])
      expect(closed).toEqual([9])
      expect(survivor.signals).toEqual([15, 9, 15, 9])
    })

    test('a failing signal keeps the handle and identity for diagnosis and retry', async () => {
      let failing = true
      const backend = {
        open: () => 3,
        send: () => {
          if (failing) throw Object.assign(new Error('denied'), { code: 'EPERM' })
          return true
        },
        exited: () => !failing,
        close: () => {},
      }
      const expected = { pid: 11, started: 'fixture', command: 'fixture-command', startTicks: 2 }
      const handle = await pinProcess(expected, {
        backend,
        readIdentity: async () => ({ ...expected, startTicks: 2 }),
      })
      const owned = [handle]
      expect(await reapOwned(owned, { graceMs: 20, forceMs: 20, pollMs: 5 })).toEqual([
        { identity: handle.identity, reason: 'signal failed: EPERM' },
      ])
      expect(owned).toEqual([handle])
      failing = false
      expect(await reapOwned(owned, { graceMs: 20, forceMs: 20, pollMs: 5 })).toEqual([])
      expect(owned).toEqual([])
    })

    test('cleanup retains a failed pinned handle through its retries, then releases that same handle after recovery', async () => {
      let failing = true
      const closed = []
      const backend = {
        open: () => 13,
        send: () => {
          if (failing) throw Object.assign(new Error('denied'), { code: 'EPERM' })
          return true
        },
        exited: () => !failing,
        close: (fd) => closed.push(fd),
      }
      const expected = { pid: 41, started: 'fixture', command: 'fixture-command', startTicks: 7 }
      const handle = await pinProcess(expected, {
        backend,
        readIdentity: async () => ({ ...expected, startTicks: 7 }),
      })
      const owned = [handle]
      const incarnation = {
        child: {
          pid: 40,
          exitCode: 0,
          signalCode: null,
          kill: () => true,
        },
        exited: Promise.resolve({ code: 0, signal: null }),
        restateOwnershipRecorded: true,
      }
      const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-retry-cleanup-'))

      try {
        const cleanupError = await releaseOwnership({
          work,
          incarnations: [incarnation],
          owned,
          reapOwnedProcesses: reapOwned,
        }).catch((error) => error)
        expect(cleanupError).toBeInstanceOf(AggregateError)
        expect(cleanupError.errors.map((error) => error.message)).toContainEqual(
          expect.stringContaining('OWNED_PROCESS_UNCONFIRMED')
        )
        expect(owned).toEqual([handle])
        expect(handle.identity).toMatchObject(expected)
        expect(closed).toEqual([])

        failing = false
        expect(await reapOwned(owned, { graceMs: 20, forceMs: 20, pollMs: 5 })).toEqual([])
        expect(owned).toEqual([])
        expect(closed).toEqual([13])
      } finally {
        if (owned.includes(handle)) {
          failing = false
          await reapOwned(owned, { graceMs: 20, forceMs: 20, pollMs: 5 })
        }
        await rm(work, { recursive: true, force: true })
      }
    })

    /** An injected pid table: `open` pins whatever holds the pid, `send` records every signal. */
    function scriptedBackend(holder) {
      const events = []
      return {
        events,
        open: (pid) => {
          events.push(`open:${pid}`)
          return holder === undefined ? undefined : 5
        },
        send: (_fd, signal) => {
          events.push(`send:${signal}`)
          return true
        },
        exited: () => false,
        close: (fd) => events.push(`close:${fd}`),
      }
    }

    const secondOfStart = 'Wed Oct 14 15:00:00 2026'
    const nativeCommand = '/pinned/restate-server --node-name n'

    test('a same-command replacement in the same second before pidfd_open is refused and never signalled', async () => {
      // The recorded process (ticks 1000) exited and its pid went to a process with the same command
      // that started in the same ps second (ticks 1003). Only kernel ticks tell them apart.
      const recorded = {
        pid: 500,
        started: secondOfStart,
        command: nativeCommand,
        startTicks: 1000,
      }
      const replacement = { ...recorded, ppid: 900, startTicks: 1003 }
      const backend = scriptedBackend(replacement)
      await expect(
        pinProcess(recorded, { backend, readIdentity: async () => replacement })
      ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
      expect(backend.events).toEqual(['open:500', 'close:5'])
    })

    test('a same-command replacement under the same owner in the same second is refused before signaling', async () => {
      const launcherPid = 321
      const recorded = {
        pid: 500,
        ppid: launcherPid,
        started: secondOfStart,
        command: nativeCommand,
        startTicks: 1000,
      }
      const replacement = { ...recorded, startTicks: 1003 }
      const backend = scriptedBackend(replacement)
      await expect(
        pinRecordedOwnedProcess(recorded, {
          commandIncludes: '/pinned/restate-server',
          parentPid: launcherPid,
          backend,
          readIdentity: async () => replacement,
        })
      ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH: native process changed after discovery')
      expect(backend.events).toEqual(['open:500', 'close:5'])
    })

    // Regression for the native server: its `ps`-only row carried no ticks, so a replacement with the
    // same command in the same ps second was indistinguishable from it and was pinned instead.
    test('an identity recorded without kernel start ticks is refused before any descriptor is opened', async () => {
      const backend = scriptedBackend({})
      await expect(
        pinProcess(
          { pid: 500, started: secondOfStart, command: nativeCommand },
          { backend, readIdentity: async () => ({ ppid: 1, startTicks: 7 }) }
        )
      ).rejects.toThrow('PINNED_PROCESS_IDENTITY_INCOMPLETE')
      // A reader that cannot supply ticks is refused the same way, after closing what it opened.
      const recorded = { pid: 500, started: secondOfStart, command: nativeCommand, startTicks: 7 }
      await expect(
        pinProcess(recorded, {
          backend,
          readIdentity: async () => ({ ...recorded, startTicks: undefined }),
        })
      ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
      expect(backend.events).toEqual(['open:500', 'close:5'])
    })

    test('an owned child must be a child of its pinned owner, so a same-command stranger in the same second is refused', async () => {
      const launcherPid = 321
      const child = {
        pid: 500,
        ppid: launcherPid,
        started: secondOfStart,
        command: nativeCommand,
        startTicks: 2000,
      }
      const stranger = { ...child, ppid: 777, startTicks: 2004 }

      const refusedBackend = scriptedBackend(stranger)
      await expect(
        pinOwnedProcess(500, {
          commandIncludes: '/pinned/restate-server',
          parentPid: launcherPid,
          backend: refusedBackend,
          readIdentity: async () => stranger,
        })
      ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
      expect(refusedBackend.events).toEqual(['open:500', 'close:5'])

      // The owner's real child is accepted, and its ticks come from the pinned process itself.
      const acceptedBackend = scriptedBackend(child)
      const handle = await pinOwnedProcess(500, {
        commandIncludes: '/pinned/restate-server',
        parentPid: launcherPid,
        backend: acceptedBackend,
        readIdentity: async () => child,
      })
      expect(handle.identity).toEqual(child)

      // An owner that has already exited cannot vouch for a child.
      const orphaned = { exited: true, identity: { pid: launcherPid } }
      await expect(
        pinOwnedProcess(500, {
          commandIncludes: '/pinned/restate-server',
          parent: orphaned,
          backend: scriptedBackend(child),
          readIdentity: async () => child,
        })
      ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
    })

    test('a real same-command process started in the same second, with a different start tick, is not accepted for a recorded one', async () => {
      // Two identical commands in one ps second but at different kernel ticks. Selection is explicit:
      // a spawn that shares the first one's tick (or lands in the next second) is discarded.
      let first
      let second
      for (let attempt = 0; attempt < 40 && second === undefined; attempt += 1) {
        if (first === undefined) first = await spawnBystander(['61'])
        await new Promise((resolve) => setTimeout(resolve, 15))
        const candidate = await spawnBystander(['61'])
        if (candidate.identity.started !== first.identity.started) {
          // The second boundary passed: start over with a fresh first process.
          first.bystander.kill('SIGKILL')
          candidate.bystander.kill('SIGKILL')
          first = undefined
        } else if (candidate.identity.startTicks === first.identity.startTicks) {
          candidate.bystander.kill('SIGKILL')
        } else {
          second = candidate
        }
      }
      expect(second).toBeDefined()
      expect(second.identity.started).toBe(first.identity.started)
      expect(second.identity.command).toBe(first.identity.command)
      expect(second.identity.startTicks).not.toBe(first.identity.startTicks)

      // The record of the first process, aimed at the second one's pid.
      await expect(pinProcess({ ...first.identity, pid: second.identity.pid })).rejects.toThrow(
        'PINNED_PROCESS_IDENTITY_MISMATCH'
      )
      expect(second.bystander.exitCode).toBeNull()
      expect(second.bystander.signalCode).toBeNull()
      expect(await liveIdentity(second.identity)).toBeDefined()

      // Ownership is the parent: both are children of this test, neither of pid 1.
      await expect(
        pinOwnedProcess(second.identity.pid, { commandIncludes: 'sleep', parentPid: 1 })
      ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
      const owned = await pinOwnedProcess(second.identity.pid, {
        commandIncludes: 'sleep',
        parentPid: process.pid,
      })
      expect(owned.identity.startTicks).toBe(second.identity.startTicks)
      expect(await owned.terminate()).toBe(true)
      owned.close()
      expect(first.bystander.exitCode).toBeNull()
    })

    describe('anchoring ownership to the original spawned composition', () => {
      const compositionCommand = '/usr/bin/node /fixtures/self-hosted-simple-sigkill.mjs initial'
      const composition = {
        pid: 900,
        ppid: process.pid,
        started: secondOfStart,
        command: compositionCommand,
        startTicks: 3000,
      }
      /** A stand-in for the spawned ChildProcess whose exit state the test controls. */
      const spawned = (overrides = {}) => ({
        pid: 900,
        exitCode: null,
        signalCode: null,
        ...overrides,
      })

      test('a protocol pid that is not the spawned composition is refused before any descriptor is opened', async () => {
        const backend = scriptedBackend(composition)
        await expect(
          pinSpawned(spawned({ pid: 901 }), 900, {
            commandIncludes: compositionCommand,
            backend,
            readIdentity: async () => composition,
          })
        ).rejects.toThrow('the reported pid is not the spawned process')
        expect(backend.events).toEqual([])
      })

      test('an exited composition whose pid now belongs to a same-command process is refused', async () => {
        // The original composition was reaped; its pid went to a process with the same command line
        // started in the same ps second, even a child of this test.
        const backend = scriptedBackend(composition)
        await expect(
          pinSpawned(spawned({ exitCode: 0 }), 900, {
            commandIncludes: compositionCommand,
            backend,
            readIdentity: async () => composition,
          })
        ).rejects.toThrow('the spawned process has already exited')
        expect(backend.events).toEqual([])
      })

      test('an owner that exits while it is being pinned is refused and its descriptor closed', async () => {
        const child = spawned()
        const backend = scriptedBackend(composition)
        await expect(
          pinSpawned(child, 900, {
            commandIncludes: compositionCommand,
            backend,
            readIdentity: async () => {
              // The spawned child is reaped, and its pid reissued, while the identity is read.
              child.exitCode = 0
              return composition
            },
          })
        ).rejects.toThrow('the spawned process exited while it was being pinned')
        expect(backend.events).toEqual(['open:900', 'close:5'])
      })

      test('a reissued pid owned by another parent is refused', async () => {
        const backend = scriptedBackend(composition)
        await expect(
          pinSpawned(spawned(), 900, {
            commandIncludes: compositionCommand,
            backend,
            readIdentity: async () => ({ ...composition, ppid: 4242 }),
          })
        ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
        expect(backend.events).toEqual(['open:900', 'close:5'])
      })

      test('a pinned composition vouches for its launcher only while it is running', async () => {
        const launcher = {
          pid: 910,
          ppid: 900,
          started: secondOfStart,
          command: '/pinned/restate/lib/index.js',
          startTicks: 3010,
        }
        let owner
        const ownerBackend = scriptedBackend(composition)
        owner = await pinSpawned(spawned(), 900, {
          commandIncludes: compositionCommand,
          backend: ownerBackend,
          readIdentity: async () => composition,
        })
        const accept = {
          commandIncludes: '/pinned/restate/lib/index.js',
          parent: owner,
          backend: scriptedBackend(launcher),
          readIdentity: async () => launcher,
        }
        const handle = await pinOwnedProcess(910, accept)
        expect(handle.identity).toEqual(launcher)

        // Once the owner is gone (here: its pinned process reports exit), nothing it spawned is
        // claimed, even a process that still reports it as parent.
        const exitedOwner = { identity: owner.identity, exited: true }
        await expect(
          pinOwnedProcess(910, {
            ...accept,
            backend: scriptedBackend(launcher),
            parent: exitedOwner,
          })
        ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
        // An orphaned launcher is no longer a child of the owner it was recorded under.
        await expect(
          pinOwnedProcess(910, {
            ...accept,
            backend: scriptedBackend(launcher),
            readIdentity: async () => ({ ...launcher, ppid: 1 }),
          })
        ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
      })

      test('a real owner that exits cannot vouch for its transferred child, and the orphan is refused', async () => {
        // The owner retains a ChildProcess handle until the test pins the child and explicitly
        // transfers ownership. After transfer, SIGTERM exits the owner and leaves the pinned child.
        const { owner, exited: ownerExit, nextLine } = spawnHandleOwner()
        let anchor
        let child
        // Teardown works only through handles and runs on every path, including a failure before or
        // after a pin. It never signals a pid.
        const ownerCleanup = () =>
          releaseSpawnedOwner({
            owner,
            ownerExit,
            handles: () => [child, anchor].filter((handle) => handle !== undefined),
          })
        cleanup.push(ownerCleanup)
        const childPid = Number(await boundedWait(nextLine(), EXIT_BOUND_MS, 'owner child pid'))
        anchor = await pinSpawned(owner, owner.pid, { commandIncludes: '-e' })
        child = await pinOwnedProcess(childPid, {
          commandIncludes: 'sleep 62',
          parent: anchor,
        })
        expect(child.identity.ppid).toBe(owner.pid)
        owner.stdin.write('transfer\n')
        expect(await boundedWait(nextLine(), EXIT_BOUND_MS, 'owner transfer acknowledgement')).toBe(
          'OWNERSHIP_TRANSFERRED'
        )

        // After ownership transfer, the owner exits while the child remains live and is reparented.
        // It does not signal the child's numeric pid, which may be reused after observation.
        owner.kill('SIGTERM')
        await boundedWait(ownerExit, EXIT_BOUND_MS, 'owner exit')
        expect(await liveIdentity(child.identity)).toBeDefined()
        expect(anchor.exited).toBe(true)
        await expect(
          pinOwnedProcess(childPid, { commandIncludes: 'sleep 62', parent: anchor })
        ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
        // A fresh anchor on the exited owner is refused as well.
        await expect(pinSpawned(owner, owner.pid, { commandIncludes: '-e' })).rejects.toThrow(
          'the spawned process has already exited'
        )

        // The orphan is ended through its pinned handle. Teardown finds it gone and signals nothing.
        expect(await child.terminate()).toBe(true)
      })

      test('a pre-pin failure lets the owner end its child through the retained child handle', async () => {
        const { owner, exited: ownerExit, nextLine } = spawnHandleOwner()
        let anchor
        const ownerCleanup = () =>
          releaseSpawnedOwner({
            owner,
            ownerExit,
            handles: () => [anchor].filter((handle) => handle !== undefined),
          })
        cleanup.push(ownerCleanup)

        const childPid = Number(await boundedWait(nextLine(), EXIT_BOUND_MS, 'owner child pid'))
        anchor = await pinSpawned(owner, owner.pid, { commandIncludes: '-e' })
        let childIdentity
        for (let attempt = 0; attempt < 50 && childIdentity === undefined; attempt += 1) {
          childIdentity = await readProcessIdentity(childPid)
          if (childIdentity === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(childIdentity).toBeDefined()
        await expect(
          pinOwnedProcess(childPid, {
            commandIncludes: 'this-command-does-not-match',
            parent: anchor,
          })
        ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')

        await ownerCleanup()
        cleanup.splice(cleanup.indexOf(ownerCleanup), 1)
        expect(await liveIdentity(childIdentity)).toBeUndefined()
        expect(OWNER_WITH_CHILD_HANDLE).toContain("child.kill('SIGTERM')")
        expect(OWNER_WITH_CHILD_HANDLE).not.toMatch(/process\.kill\(/)
      })
    })

    test('teardown after the child was terminated and its handle closed signals no pid, even if the pid is reused', async () => {
      // The child is gone and its handle closed; its pid may now belong to anyone. Teardown must go
      // through handles only, so it signals nothing by number.
      const ownerChild = spawn('sleep', ['63'], { stdio: 'ignore' })
      const ownerExit = processExit(ownerChild)
      const identity = await readProcessIdentity(ownerChild.pid)
      const handle = await pinProcess(identity)
      expect(await handle.terminate()).toBe(true)
      await boundedWait(ownerExit, EXIT_BOUND_MS, 'terminated owner exit')
      handle.close()

      await withoutPidSignals(async () => {
        await releaseSpawnedOwner({ owner: ownerChild, ownerExit, handles: () => [handle] })
      })
    })

    test('teardown still ends the owner and its pinned handles after a failure mid-test, by handle only', async () => {
      const owner = spawn('sleep', ['64'], { stdio: 'ignore' })
      const ownerExit = processExit(owner)
      const identity = await readProcessIdentity(owner.pid)
      const handle = await pinProcess(identity)
      await withoutPidSignals(async () => {
        await releaseSpawnedOwner({ owner, ownerExit, handles: () => [handle] })
      })
      expect(owner.signalCode).toBe('SIGTERM')
      expect(handle.exited).toBe(true)
      // A handle that cannot be confirmed gone is reported, not hidden, and the rest still runs.
      let stillRunning = true
      const terminationAttempts = []
      const closes = []
      const stuck = {
        identity: { pid: 1 },
        terminate: async () => {
          terminationAttempts.push(stuck.identity.pid)
          return !stillRunning
        },
        close: () => closes.push(stuck.identity.pid),
      }
      const exited = Promise.resolve({ code: 0, signal: null })
      const fakeOwner = { exitCode: 0, signalCode: null, kill: () => {} }
      const cleanupOwner = () =>
        releaseSpawnedOwner({
          owner: fakeOwner,
          ownerExit: exited,
          handles: () => [stuck],
        })
      const outcome = await cleanupOwner().catch((error) => error)
      expect(outcome).toBeInstanceOf(AggregateError)
      expect(outcome.message).toBe('owner teardown')
      expect(outcome.unconfirmedHandles).toEqual([stuck])
      expect(terminationAttempts).toEqual([1])
      expect(closes).toEqual([])
      expect(stuck.identity).toEqual({ pid: 1 })

      stillRunning = false
      await cleanupOwner()
      expect(terminationAttempts).toEqual([1, 1])
      expect(closes).toEqual([1])
    })

    test('no test or fixture signals a bare pid', async () => {
      for (const file of [
        'tests/profile-recovery-self-hosted-simple-sigkill.integration.test.mjs',
        'tests/fixtures/pinned-process.mjs',
        'tests/fixtures/self-hosted-simple-sigkill.mjs',
      ]) {
        const source = await readFile(join(repositoryRoot, file), 'utf8')
        expect(source).not.toMatch(/process\.kill\s*\(/)
        expect(source).not.toMatch(/\bkill\s+(?:(?:-[A-Za-z]+|--)\s+)*\$[A-Za-z_]/)
      }
    })

    test('pinning fails closed instead of falling back to a bare pid where pidfds are unavailable', async () => {
      await expect(createPidfdBackend({ platform: 'darwin' })).rejects.toThrow(
        'PINNED_PROCESS_UNSUPPORTED'
      )
      await expect(createPidfdBackend({ platform: 'linux', arch: 'riscv64' })).rejects.toThrow(
        'PINNED_PROCESS_UNSUPPORTED'
      )
    })
  })

  describe('runner cleanup shared by afterEach and signals', () => {
    function heldCleanup() {
      const events = []
      const queue = []
      let release
      const held = new Promise((resolve) => {
        release = resolve
      })
      queue.push(async () => {
        events.push('held-start')
        await held
        events.push('held-done')
      })
      return { events, queue, release }
    }
    const signals = [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ]

    test('a signal during an in-flight afterEach cleanup waits for it before exiting', async () => {
      const { events, queue, release } = heldCleanup()
      const run = createCleanupRunner(queue, 'test cleanup')
      const target = new EventEmitter()
      const exits = []
      installSignalCleanup({
        run,
        signals,
        target,
        exit: (status) => exits.push(status),
      })

      const afterEachRun = run()
      await delayMs(20)
      expect(events).toEqual(['held-start'])
      // The queue is already taken: a runner that drained it only once would see nothing left.
      expect(queue).toEqual([])

      target.emit('SIGTERM')
      target.emit('SIGINT')
      await delayMs(50)
      expect(exits).toEqual([])

      release()
      await afterEachRun
      await delayMs(20)
      expect(events).toEqual(['held-start', 'held-done'])
      expect(exits.toSorted()).toEqual([130, 143])
      // Cleanup ran once, not once per delivery.
      expect(events.filter((event) => event === 'held-start')).toHaveLength(1)
    })

    test('cleanup registered while another cleanup runs is still run, and failures do not stop later callbacks', async () => {
      const queue = []
      const events = []
      const run = createCleanupRunner(queue, 'test cleanup')
      queue.push(async () => {
        events.push('first')
        queue.push(async () => {
          events.push('registered-late')
        })
        throw new Error('first failed')
      })
      queue.push(async () => {
        events.push('second')
      })
      const outcome = await run().catch((error) => error)
      expect(outcome).toBeInstanceOf(AggregateError)
      expect(outcome.message).toBe('test cleanup')
      expect(outcome.errors.map((error) => error.message)).toEqual(['first failed'])
      expect(events).toEqual(['first', 'second', 'registered-late'])
    })

    describe('with real process signals', () => {
      const childPath = join(repositoryRoot, 'tests/fixtures/runner-cleanup-signal.child.mjs')

      async function startCleanupChild(mode) {
        const work = await mkdtemp(join(tmpdir(), 'runner-cleanup-signal-'))
        const releasePath = join(work, 'release')
        const markerPath = join(work, 'markers')
        const child = spawn(process.execPath, [childPath, releasePath, markerPath, mode], {
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        const exited = processExit(child)
        cleanup.push(async () => {
          // Handle-only: the child belongs to this test and is ended through its ChildProcess.
          try {
            await stopChild({ child, exited }, { label: 'cleanup signal child', timeoutMs: 10_000 })
          } finally {
            await rm(work, { recursive: true, force: true })
          }
        })
        let output = ''
        child.stdout.setEncoding('utf8')
        const ready = new Promise((resolve) => {
          child.stdout.on('data', (chunk) => {
            output += chunk
            if (output.includes('ready')) resolve()
          })
        })
        await boundedWait(ready, EXIT_BOUND_MS, 'cleanup signal child ready')
        const markers = async () =>
          existsSync(markerPath) ? (await readFile(markerPath, 'utf8')).trim().split('\n') : []
        return { child, exited, releasePath, markers }
      }

      for (const [signal, status] of [
        ['SIGTERM', 143],
        ['SIGINT', 130],
        ['SIGHUP', 129],
      ]) {
        for (const mode of ['in-flight', 'idle']) {
          test(`${signal} during ${mode} cleanup holds the process until cleanup finishes, then exits ${status}`, async () => {
            const { child, exited, releasePath, markers } = await startCleanupChild(mode)
            expect(child.kill(signal)).toBe(true)

            // The cleanup callback is held. The process must still be alive while it runs, and
            // must have started it exactly once.
            for (let attempt = 0; attempt < 200; attempt += 1) {
              if ((await markers()).includes('cleanup-start')) break
              await delayMs(10)
            }
            await delayMs(300)
            expect(child.exitCode).toBeNull()
            expect(child.signalCode).toBeNull()
            expect(await markers()).toEqual(['cleanup-start'])

            await writeFile(releasePath, 'release')
            expect(await boundedWait(exited, EXIT_BOUND_MS, 'cleanup signal child exit')).toEqual({
              code: status,
              signal: null,
            })
            expect(await markers()).toEqual(['cleanup-start', 'cleanup-done', `exit:${status}`])
          })
        }
      }

      test('a second, different signal while cleanup is held neither exits early nor repeats cleanup', async () => {
        const { child, exited, releasePath, markers } = await startCleanupChild('in-flight')
        expect(child.kill('SIGTERM')).toBe(true)
        expect(child.kill('SIGHUP')).toBe(true)
        await delayMs(300)
        expect(child.exitCode).toBeNull()
        expect(await markers()).toEqual(['cleanup-start'])
        await writeFile(releasePath, 'release')
        const exit = await boundedWait(exited, EXIT_BOUND_MS, 'cleanup signal child exit')
        // Whichever signal's listener finishes first decides the status; both are signal statuses.
        expect([143, 129]).toContain(exit.code)
        expect(exit.signal).toBeNull()
        const finalMarkers = await markers()
        expect(finalMarkers.slice(0, 2)).toEqual(['cleanup-start', 'cleanup-done'])
        expect(finalMarkers.filter((line) => line === 'cleanup-start')).toHaveLength(1)
      })
    })

    test('a signal exits with its status after a failed cleanup and reports it', async () => {
      const queue = [
        async () => {
          throw new Error('stuck owner')
        },
      ]
      const target = new EventEmitter()
      const exits = []
      const reports = []
      installSignalCleanup({
        run: createCleanupRunner(queue, 'test cleanup'),
        signals,
        target,
        exit: (status) => exits.push(status),
        report: (message) => reports.push(message),
      })
      target.emit('SIGHUP')
      await delayMs(30)
      expect(exits).toEqual([129])
      expect(reports).toEqual(['runner SIGHUP cleanup incomplete: test cleanup'])
    })
  })

  test('the protocol reader ignores non-protocol JSON and malformed records without throwing', async () => {
    expect(parseProtocolLine('{"level":"info","stage":"started","launcherPid":9}')).toBeUndefined()
    expect(parseProtocolLine('{"stage":"started","pid":1}')).toBeUndefined()
    expect(parseProtocolLine('SELF_HOSTED_SIMPLE_PROTOCOL {not json')).toBeUndefined()
    expect(parseProtocolLine('SELF_HOSTED_SIMPLE_PROTOCOL {"stage":"unknown"}')).toBeUndefined()
    expect(parseProtocolLine('SELF_HOSTED_SIMPLE_PROTOCOL null')).toBeUndefined()

    // A real child writes framework JSON, a bare protocol-shaped line, and a malformed record
    // before the valid record. The stdout handler must survive all of them.
    const script = [
      'process.stdout.write(\'{"level":"warn","msg":"framework"}\\n\')',
      'process.stdout.write(\'{"stage":"started","pid":1}\\n\')',
      "process.stdout.write('SELF_HOSTED_SIMPLE_PROTOCOL {broken\\n')",
      "process.stdout.write('SELF_HOSTED_SIMPLE_PROTOCOL ' + JSON.stringify({ stage: 'started', pid: 2, launcherPid: 3 }) + '\\n')",
    ].join(';')
    const child = spawnProtocolChild({
      executable: process.execPath,
      args: ['-e', script],
      cwd: repositoryRoot,
    })
    cleanup.push(() => stopChild(child, { label: 'protocol child', timeoutMs: EXIT_BOUND_MS }))
    expect(await child.next('started', 10_000)).toEqual({
      stage: 'started',
      pid: 2,
      launcherPid: 3,
    })
    expect(await boundedWait(child.exited, EXIT_BOUND_MS, 'protocol child exit')).toEqual({
      code: 0,
      signal: null,
    })
  })

  for (const failure of [
    'startup timeout',
    'partial identity capture',
    'rejected start with failed stop',
    'provider stop rejection',
    'pending startup',
  ]) {
    test(`main cleanup closes Restate after ${failure} before ownership is recorded`, async () => {
      const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-main-cleanup-'))
      const releasePath = join(work, 'release-health')
      const probePath = join(work, 'health-probe.json')
      const config = {
        dataDirectory: join(work, 'data'),
        evidencePath: join(work, 'effects.jsonl'),
        ports: await isolatedPorts(),
        ...(failure === 'provider stop rejection'
          ? { processStopFailure: join(work, 'process-stop-failure.json') }
          : {}),
        ...(failure !== 'partial identity capture'
          ? {
              failureBeforeOwnershipHandshake: {
                method: failure === 'startup timeout' ? 'health' : 'start',
                probePath,
                releasePath,
                failStopAfterStart: ['rejected start with failed stop', 'pending startup'].includes(
                  failure
                ),
                stopFailurePath: join(work, 'stop-failure.json'),
              },
            }
          : {}),
      }
      const initial = spawnSelfHostedSimpleComposition('initial', config)
      const owned = []
      // Independent observer handles make the regression safe even against the old cleanup:
      // they are never passed to main cleanup and never mark its ownership handshake complete.
      const observers = []
      cleanup.push(async () => {
        if (existsSync(work)) await writeFile(releasePath, 'test teardown')
        if (observers.length === 2) {
          await stopChild(initial, { label: 'independently pinned regression owner' })
          expect(await reapOwned(observers)).toEqual([])
        } else {
          await boundedWait(initial.exited, FAILURE_PROBE_WAIT_MS, 'unrecorded regression owner')
        }
        for (const handle of owned) handle.close()
        await rm(work, { recursive: true, force: true })
      })
      let started
      if (failure !== 'partial identity capture') {
        const outcome = await waitForFailureOutcome(initial, probePath, FAILURE_PROBE_WAIT_MS)
        expect(outcome.kind).toBe('probe')
        started = outcome.evidence
      } else {
        started = await initial.next('started')
      }
      const observed = await recordOwnedRestate({ ...initial }, observers, 'initial', started)
      expect(initial.restateOwnershipRecorded).toBeUndefined()
      let cleanupInProgress
      if (failure === 'pending startup') {
        cleanupInProgress = releaseOwnership({ work, incarnations: [initial], owned }).catch(
          (error) => error
        )
        expect(await initial.next('cleanup_requested', EXIT_BOUND_MS)).toMatchObject({
          startupPending: true,
        })
        expect(initial.stages.some((stage) => stage.stage === 'cleanup_started')).toBe(false)
        expect(initial.restateOwnershipRecorded).toBeUndefined()
        expect(observed.native.exited).toBe(false)
        await writeFile(releasePath, 'settle pending startup')
      } else if (failure === 'startup timeout') {
        await expect(initial.next('started', 100)).rejects.toThrow('PROTOCOL_CHILD_TIMEOUT_started')
      } else if (
        failure === 'rejected start with failed stop' ||
        failure === 'provider stop rejection'
      ) {
        await writeFile(releasePath, 'reject startup')
        await expect(initial.next('started', EXIT_BOUND_MS)).rejects.toThrow(
          'SELF_HOSTED_SIMPLE_INJECTED_START_FAILURE'
        )
        if (failure === 'provider stop rejection') {
          expect(JSON.parse(await readFile(config.processStopFailure, 'utf8'))).toMatchObject({
            launcherPid: started.launcherPid,
            signal: 'SIGTERM',
            pending: true,
          })
        } else {
          expect(existsSync(config.failureBeforeOwnershipHandshake.stopFailurePath)).toBe(true)
        }
      } else {
        await expect(
          recordOwnedRestate(initial, owned, 'initial', started, async () => {
            throw new Error('NATIVE_IDENTITY_CAPTURE_INJECTED')
          })
        ).rejects.toThrow('NATIVE_IDENTITY_CAPTURE_INJECTED')
        expect(owned).toHaveLength(1)
      }
      const cleanupError = await (
        cleanupInProgress ?? releaseOwnership({ work, incarnations: [initial], owned })
      ).catch((error) => error)
      expect(observed.native.exited).toBe(true)
      if (cleanupError !== undefined) throw cleanupError
      expect(initial.restateOwnershipRecorded).toBe(true)
      expect(observed.launcher.exited).toBe(true)
      expect(await initial.exited).toEqual({ code: null, signal: 'SIGKILL' })
      expect(owned).toEqual([])
      expect(existsSync(work)).toBe(false)
    }, 60_000)
  }

  test('cleanup attempts every child after one exit is unconfirmed, and keeps the state for diagnosis', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-cleanup-'))
    const signalled = []
    // Test doubles for spawned children: one never exits, one exits on SIGKILL.
    const neverExits = {
      child: {
        pid: 1,
        exitCode: null,
        signalCode: null,
        kill: () => {
          signalled.push('never-exits')
          return true
        },
      },
      exited: new Promise(() => {}),
      stages: [{ stage: 'started' }],
      // This cleanup-only double models an incarnation whose Restate ownership was recorded.
      restateOwnershipRecorded: true,
    }
    const exits = {
      child: {
        pid: 2,
        exitCode: null,
        signalCode: null,
        kill: () => {
          signalled.push('exits')
          return true
        },
      },
      exited: Promise.resolve({ code: null, signal: 'SIGKILL' }),
      stages: [{ stage: 'started' }],
      restateOwnershipRecorded: true,
    }
    const error = await releaseOwnership({
      work,
      incarnations: [neverExits, exits],
      owned: [],
      exitBoundMs: 200,
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain(`state preserved for diagnosis at ${work}`)
    expect(error.errors.map((entry) => entry.message)).toEqual([
      expect.stringContaining('BOUNDED_WAIT_TIMEOUT'),
    ])
    expect(signalled).toEqual(['never-exits', 'exits'])
    expect(existsSync(work)).toBe(true)
    await rm(work, { recursive: true, force: true })
  })

  test('main cleanup retains the live owner and partial handle when ownership repair fails', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-unconfirmed-main-'))
    const signals = []
    const requests = []
    const partial = {
      identity: { pid: 302, started: 'unconfirmed-launcher' },
      exited: false,
      terminate: () => {
        throw new Error('PARTIAL_LAUNCHER_MUST_NOT_BE_TERMINATED')
      },
      close: () => {
        throw new Error('LIVE_HANDLE_MUST_NOT_BE_RELEASED')
      },
    }
    const owned = [partial]
    try {
      const error = await releaseOwnership({
        work,
        owned,
        incarnations: [
          {
            mode: 'initial',
            child: {
              pid: 301,
              exitCode: null,
              signalCode: null,
              stdin: { write: (request) => requests.push(request) },
              kill: (signal) => signals.push(signal),
            },
            next: async () => {
              throw new Error('PINNED_PROCESS_IDENTITY_MISMATCH')
            },
            exited: new Promise(() => {}),
          },
        ],
      }).catch((caught) => caught)
      expect(error).toBeInstanceOf(AggregateError)
      expect(error.errors.map((entry) => entry.message)).toEqual([
        'PINNED_PROCESS_IDENTITY_MISMATCH',
        expect.stringContaining('RESTATE_OWNERSHIP_UNRECORDED'),
        expect.stringContaining('OWNED_PROCESS_UNCONFIRMED'),
      ])
      expect(requests).toEqual(['pin_cleanup\n'])
      expect(signals).toEqual([])
      expect(owned).toEqual([partial])
      expect(existsSync(work)).toBe(true)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test('cleanup preserves state when Restate ownership was not fully recorded', async () => {
    const stageCases = [
      [{ stage: 'failed' }],
      [{ stage: 'started' }],
      [{ stage: 'started' }, { stage: 'failed' }],
    ]

    for (const [index, stages] of stageCases.entries()) {
      const work = await mkdtemp(join(tmpdir(), `self-hosted-simple-unrecorded-${index}-`))
      const signalled = []
      try {
        const error = await releaseOwnership({
          work,
          incarnations: [
            {
              child: {
                pid: 100 + index,
                exitCode: 1,
                signalCode: null,
                kill: (signal) => {
                  signalled.push(signal)
                  return true
                },
              },
              exited: Promise.resolve({ code: 1, signal: null }),
              stages,
            },
          ],
          owned: [],
        }).catch((caught) => caught)

        expect(error).toBeInstanceOf(AggregateError)
        expect(error.errors.map((entry) => entry.message)).toContainEqual(
          expect.stringContaining('RESTATE_OWNERSHIP_UNRECORDED')
        )
        expect(signalled).toEqual([])
        expect(existsSync(work)).toBe(true)
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    }
  })

  test('failure cleanup preserves diagnostics when identity capture records only the launcher', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-partial-failure-cleanup-'))
    const launcherIdentity = {
      pid: 301,
      ppid: 300,
      started: 'fixture-launcher',
      command: pinned.launcher,
      startTicks: 31,
    }
    const incarnation = {
      child: { pid: 300, exitCode: 1, signalCode: null },
      exited: Promise.resolve({ code: 1, signal: null }),
      stages: [
        {
          stage: 'failed',
          message: 'SELF_HOSTED_SIMPLE_FAILURE_IDENTITY_CAPTURE_INJECTED',
          processIdentities: [launcherIdentity],
        },
      ],
    }

    try {
      const error = await cleanupFailureComposition({
        work,
        incarnation,
        owned: [],
        releasePath: join(work, 'release'),
        timeoutMs: 100,
      }).catch((caught) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      expect(error.message).toContain(`state preserved for diagnosis at ${work}`)
      expect(existsSync(work)).toBe(true)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test('failure cleanup retries an unresolved pinned identity through the same retained handle', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-partial-retry-cleanup-'))
    const launcherIdentity = {
      pid: 311,
      ppid: 310,
      started: 'fixture-launcher',
      command: pinned.launcher,
      startTicks: 41,
    }
    let terminateAttempts = 0
    let closeAttempts = 0
    const attemptedHandles = []
    const handle = {
      identity: launcherIdentity,
      terminate: async function () {
        attemptedHandles.push(this)
        terminateAttempts += 1
        return terminateAttempts === 2
      },
      close: () => {
        closeAttempts += 1
      },
    }
    const incarnation = {
      child: { pid: 310, exitCode: 1, signalCode: null },
      exited: Promise.resolve({ code: 1, signal: null }),
      stages: [{ stage: 'failed', processIdentities: [launcherIdentity] }],
    }
    const owned = [handle]

    try {
      const error = await cleanupFailureComposition({
        work,
        incarnation,
        owned,
        releasePath: join(work, 'release'),
        timeoutMs: 100,
      }).catch((caught) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      expect(terminateAttempts).toBe(2)
      expect(attemptedHandles).toEqual([handle, handle])
      expect(closeAttempts).toBe(1)
      expect(owned).toEqual([])
      expect(existsSync(work)).toBe(true)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test('late cleanup does not pin or signal an impostor with the exact recorded identity tuple', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-same-tick-impostor-'))
    const identities = [
      {
        pid: 331,
        ppid: 330,
        started: 'fixture-launcher',
        command: pinned.launcher,
        startTicks: 61,
      },
      {
        pid: 332,
        ppid: 331,
        started: 'fixture-native',
        command: pinned.native,
        startTicks: 62,
      },
    ]
    const descriptors = new Map()
    const exited = new Set()
    const backendEvents = []
    let nextFd = 20
    const backend = {
      open(pid) {
        const fd = nextFd
        nextFd += 1
        descriptors.set(fd, pid)
        backendEvents.push(`open:${pid}`)
        return fd
      },
      send(fd, signal) {
        backendEvents.push(`signal:${descriptors.get(fd)}:${signal}`)
        exited.add(fd)
        return true
      },
      exited: (fd) => exited.has(fd),
      close(fd) {
        backendEvents.push(`close:${descriptors.get(fd)}`)
      },
    }
    const identityReader = async (pid) => identities.find((identity) => identity.pid === pid)
    const incarnation = {
      child: { pid: 330, exitCode: 1, signalCode: null },
      exited: Promise.resolve({ code: 1, signal: null }),
      stages: [{ stage: 'failed', processIdentities: identities }],
    }

    try {
      const error = await cleanupFailureComposition({
        work,
        incarnation,
        owned: [],
        releasePath: join(work, 'release'),
        timeoutMs: 100,
        identityReader,
        pinIdentity: (identity) =>
          pinProcess(identity, {
            backend,
            readIdentity: identityReader,
          }),
      }).catch((caught) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      expect(error.message).toContain(`state preserved for diagnosis at ${work}`)
      expect(backendEvents.filter((event) => event.startsWith('open:'))).toEqual([])
      expect(backendEvents.filter((event) => event.startsWith('signal:'))).toEqual([])
      expect(existsSync(work)).toBe(true)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test('unrecorded failure cleanup removes state only after both reported Restate identities are gone', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-complete-failure-cleanup-'))
    const identities = [
      {
        pid: 321,
        ppid: 320,
        started: 'fixture-launcher',
        command: pinned.launcher,
        startTicks: 51,
      },
      {
        pid: 322,
        ppid: 321,
        started: 'fixture-native',
        command: pinned.native,
        startTicks: 52,
      },
    ]
    const terminated = []
    const closed = []
    const owned = identities.map((identity) => ({
      identity,
      terminate: async () => {
        terminated.push(identity.pid)
        return true
      },
      close: () => closed.push(identity.pid),
    }))
    const incarnation = {
      child: { pid: 320, exitCode: 1, signalCode: null },
      exited: Promise.resolve({ code: 1, signal: null }),
      stages: [{ stage: 'failed', processIdentities: identities }],
    }

    try {
      await cleanupFailureComposition({
        work,
        incarnation,
        owned,
        releasePath: join(work, 'release'),
        timeoutMs: 100,
      })

      expect(terminated).toEqual([322, 321])
      expect(closed).toEqual([322, 321])
      expect(owned).toEqual([])
      expect(existsSync(work)).toBe(false)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  for (const failureMethod of ['start', 'health']) {
    test(`a rejected composition ${failureMethod} after Restate starts closes before the ownership handshake`, async () => {
      await exerciseRejectedCompositionBeforeHandshake(failureMethod)
    })
  }

  test('a failed ownership probe retains complete identities for safe cleanup after composition close', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-probe-write-failure-'))
    const probePath = join(work, 'probe-write-failure.json')
    const releasePath = join(work, 'release-probe-write-failure')
    const config = {
      dataDirectory: join(work, 'data'),
      ports: await isolatedPorts(),
      failureBeforeOwnershipHandshake: {
        method: 'start',
        probePath,
        probeWriteFailure: true,
        releasePath,
      },
    }
    const initial = spawnSelfHostedSimpleComposition('initial', config)
    const owned = []
    let cleanupHandled = false
    const cleanupFailure = async () => {
      if (cleanupHandled) return
      await cleanupFailureComposition({
        work,
        incarnation: initial,
        owned,
        releasePath,
        timeoutMs: FAILURE_PROBE_WAIT_MS + EXIT_BOUND_MS * 2,
      })
      cleanupHandled = true
    }
    cleanup.push(cleanupFailure)

    const outcome = await waitForFailureOutcome(initial, probePath, FAILURE_PROBE_WAIT_MS)
    expect(outcome.kind).toBe('failed')
    expect(outcome.record.message).toBe('SELF_HOSTED_SIMPLE_FAILURE_PROBE_WRITE_INJECTED')
    const identities = outcome.record.processIdentities
    expect(identities).toHaveLength(2)
    expect(identities[0].command).toContain(pinned.launcher)
    expect(identities[1].command).toContain(pinned.native)
    await expect(
      boundedWait(initial.exited, EXIT_BOUND_MS, 'probe failure composition exit')
    ).resolves.toEqual({
      code: 1,
      signal: null,
    })

    await cleanupFailure()
    expect(existsSync(work)).toBe(false)
    for (const identity of identities) expect(await liveIdentity(identity)).toBeUndefined()
  })

  test('delayed failure discovery waits for the probe and safely reaps pinned Restate processes', async () => {
    await exerciseRejectedCompositionBeforeHandshake('start', {
      probeDelayMs: EXIT_BOUND_MS + 250,
    })
  })

  test('cleanup removes state after recorded Restate identities are confirmed gone', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-recorded-cleanup-'))
    const recordedIdentities = [
      { pid: 101, started: 'fixture-launcher', command: pinned.launcher },
      { pid: 102, started: 'fixture-server', command: pinned.native },
    ]
    const owned = [...recordedIdentities]
    const reapAttempts = []
    const signalled = []

    try {
      await releaseOwnership({
        work,
        incarnations: [
          {
            child: {
              pid: 100,
              exitCode: 0,
              signalCode: null,
              kill: (signal) => {
                signalled.push(signal)
                return true
              },
            },
            exited: Promise.resolve({ code: 0, signal: null }),
            stages: [{ stage: 'started' }],
            restateOwnershipRecorded: true,
          },
        ],
        owned,
        reapOwnedProcesses: async (identities) => {
          reapAttempts.push([...identities])
          identities.splice(0, identities.length)
          return []
        },
      })

      expect(reapAttempts).toEqual([recordedIdentities])
      expect(owned).toEqual([])
      expect(signalled).toEqual([])
      expect(existsSync(work)).toBe(false)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test('a spawn failure is reported promptly instead of hanging the protocol wait', async () => {
    const child = spawnProtocolChild({
      executable: join(repositoryRoot, 'no-such-composition-binary'),
    })
    cleanup.push(() => stopChild(child, { label: 'spawn-failed child', timeoutMs: EXIT_BOUND_MS }))
    await expect(child.next('started', 10_000)).rejects.toThrow(
      'PROTOCOL_CHILD_SPAWN_FAILED: ENOENT'
    )
    const exit = await boundedWait(child.exited, EXIT_BOUND_MS, 'spawn-failed child exit')
    expect(exit.error).toMatchObject({ code: 'ENOENT' })
  })
})
