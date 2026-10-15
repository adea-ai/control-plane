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
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { createRegisteredGraphPlan } from './fixtures/registered-graph-plan.mjs'
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
} from './fixtures/pinned-process.mjs'

// This file sits in tests/, so one `..` is the repository root.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const pinned = pinnedRestateCommands()
const EXIT_BOUND_MS = 15_000
const cleanup = []

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

/** Records and pins the launcher and native server of one incarnation, once its composition has
 *  started. Ownership is anchored to the original spawned composition, not to a numeric pid from
 *  the protocol: the composition is pinned first and must still be running, the launcher must be
 *  its child, and the native server a child of the pinned launcher. Each launcher and native handle
 *  enters `owned` as soon as it is pinned, so a failure while recording the next process leaves the
 *  earlier one recorded for the reap. The composition anchor is released once the chain is pinned;
 *  the test stops the composition through its own child handle. */
async function recordOwnedRestate(incarnation, owned, mode, { pid: compositionPid, launcherPid }) {
  const composition = await pinSpawned(incarnation.child, compositionPid, {
    commandIncludes: `${fixturePath} ${mode}`,
  })
  try {
    const launcher = await pinOwnedProcess(launcherPid, {
      commandIncludes: pinned.launcher,
      parent: composition,
    })
    owned.push(launcher)
    // Discovery only names a candidate pid; the pin below decides whether it is the owned process.
    const candidate = await ownedNativeServer(launcherPid, pinned.native)
    const native = await pinOwnedProcess(candidate.pid, {
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

/** Ends every spawned composition, then every recorded Restate identity. Each step is attempted even
 *  after an earlier failure. The work directory is removed only when nothing remains unconfirmed;
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
    try {
      await stopChild(incarnation, { label, timeoutMs: exitBoundMs })
    } catch (error) {
      problems.push(error)
    }
    // Protocol progress does not prove that both the launcher and native server identities were
    // recorded. A failed startup or a failure during identity lookup must preserve the work state.
    if (incarnation.restateOwnershipRecorded !== true) {
      problems.push(new Error(`RESTATE_OWNERSHIP_UNRECORDED: ${label}`))
    }
  }
  let unconfirmed = await reapOwnedProcesses(owned)
  // One retry, limited to identities that are still recorded and not confirmed gone.
  if (unconfirmed.length > 0) unconfirmed = await reapOwnedProcesses(owned)
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
    try {
      if (await handle.terminate({ graceMs: 5000, forceMs: 5000 })) {
        handle.close()
      } else {
        unconfirmedHandles.push(handle)
        problems.push(new Error(`pinned process ${handle.identity.pid} is still running`))
      }
    } catch (error) {
      unconfirmedHandles.push(handle)
      problems.push(error)
    }
  }
  if (problems.length > 0) {
    const failure = new AggregateError(problems, 'owner teardown')
    // Keep failed pidfd handles reachable and open so callers can safely retry or diagnose them.
    failure.unconfirmedHandles = unconfirmedHandles
    throw failure
  }
}

afterEach(async () => {
  const failures = []
  for (const entry of cleanup.splice(0)) {
    try {
      await entry()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'self-hosted simple SIGKILL cleanup')
})

describe('M17.02.2 legacy LangGraph test composition: SIGKILL with manual orphan reap (not Pi Durable host wiring, no orphan adoption)', () => {
  test('SIGKILL of the composition while its pinned Restate child runs recovers the same execution with no duplicate effect', async () => {
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

    // Graceful close of the recovery composition stops its own Restate child.
    recovery.child.stdin.write('close\n')
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

      test('a real owner that exits cannot vouch for its child, and the orphan is refused', async () => {
        // A detached shell owner starts a sleeping child and prints its pid. Its isolated process
        // group is anchored by the still-running owner, so the TERM trap can stop both without
        // signaling a child pid that might have been reused.
        const owner = spawn(
          'sh',
          [
            '-c',
            'sleep 62 & trap \'trap "" TERM; /bin/kill -TERM -- -$$; wait; exit\' TERM; echo $!; wait',
          ],
          { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
        )
        const ownerExit = processExit(owner)
        let anchor
        let child
        // Teardown works only through handles and runs on every path, including a failure before or
        // after a pin. It never signals a pid.
        cleanup.push(() =>
          releaseSpawnedOwner({
            owner,
            ownerExit,
            handles: () => [child, anchor].filter((handle) => handle !== undefined),
          })
        )
        const childPid = Number(
          await boundedWait(
            new Promise((resolve) => {
              let buffer = ''
              owner.stdout.on('data', (chunk) => {
                buffer += chunk
                if (buffer.includes('\n')) resolve(buffer.trim())
              })
            }),
            EXIT_BOUND_MS,
            'owner child pid'
          )
        )
        anchor = await pinSpawned(owner, owner.pid, { commandIncludes: 'sh -c' })
        child = await pinOwnedProcess(childPid, {
          commandIncludes: 'sleep 62',
          parent: anchor,
        })
        expect(child.identity.ppid).toBe(owner.pid)

        // The owner exits; the child is reparented and the anchor reports the exit.
        owner.kill('SIGKILL')
        await boundedWait(ownerExit, EXIT_BOUND_MS, 'owner exit')
        expect(anchor.exited).toBe(true)
        await expect(
          pinOwnedProcess(childPid, { commandIncludes: 'sleep 62', parent: anchor })
        ).rejects.toThrow('PINNED_PROCESS_IDENTITY_MISMATCH')
        // A fresh anchor on the exited owner is refused as well.
        await expect(pinSpawned(owner, owner.pid, { commandIncludes: 'sh -c' })).rejects.toThrow(
          'the spawned process has already exited'
        )

        // The orphan is ended through its pinned handle. Teardown finds it gone and signals nothing.
        expect(await child.terminate()).toBe(true)
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
      // An unconfirmed handle remains open and reachable for safe retry, while later handles are
      // still attempted and closed when they are confirmed gone.
      let stuckCloseCalls = 0
      let healthyCloseCalls = 0
      const stuck = {
        identity: { pid: 1 },
        terminate: async () => false,
        close: () => {
          stuckCloseCalls += 1
        },
      }
      const healthy = {
        identity: { pid: 2 },
        terminate: async () => true,
        close: () => {
          healthyCloseCalls += 1
        },
      }
      const outcome = await releaseSpawnedOwner({
        owner: { exitCode: 0, signalCode: null, kill: () => {} },
        ownerExit: Promise.resolve(),
        handles: () => [stuck, healthy],
      }).catch((error) => error)
      expect(outcome).toBeInstanceOf(AggregateError)
      expect(outcome.message).toBe('owner teardown')
      expect(outcome.unconfirmedHandles).toEqual([stuck])
      expect(stuckCloseCalls).toBe(0)
      expect(healthyCloseCalls).toBe(1)
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
