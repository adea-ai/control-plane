// M17.02.2 (#1025): SIGKILL of the self-hosted simple composition while its owned, pinned Restate
// child runs.
//
// Scope label: this proof uses the legacy LangGraph test composition (`graphActivitiesFactory` over
// LocalControlPlaneComposition, profile `hosted-simple`, durable execution `restate`). It is not Pi
// Durable host wiring. The parent kills the composition process only. The launcher and native
// Restate server it started keep running as orphans. The parent then reaps exactly those recorded
// identities by hand before a second composition starts on the same data. It does not adopt orphans.
//
// Proven here: the paused approval survives the kill with its execution, attempt, and version; the
// recovered composition serves the same execution; a duplicate run submission starts no second
// effect; one approval resumes the workflow; `prepare` runs once, `finalize` once, and one result
// artifact is written across both incarnations; owned processes are reaped by recorded identity.
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
  graph,
  graphInput,
  identityOfPid,
  liveIdentity,
  ownedNativeServer,
  parseProtocolLine,
  pinnedRestateCommands,
  processExit,
  reapIdentity,
  runInputOf,
  spawnProtocolChild,
  spawnSelfHostedSimpleComposition,
  stopChild,
} from './fixtures/self-hosted-simple-sigkill.mjs'

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

/** Identity of a recorded pid whose command must include the expected pinned path. */
async function identityOf(pid, commandIncludes) {
  const row = await identityOfPid(pid)
  if (row === undefined || !row.command.includes(commandIncludes)) {
    throw new Error('OWNED_PROCESS_IDENTITY_MISMATCH')
  }
  return row
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

/** Records the launcher and native server of one incarnation, once its composition has started. */
async function recordOwnedRestate(owned, launcherPid) {
  const launcher = await identityOf(launcherPid, pinned.launcher)
  owned.push(launcher)
  const native = await ownedNativeServer(launcherPid, pinned.native)
  owned.push(native)
  return { launcher, native }
}

/** Attempts every recorded identity. A confirmed identity leaves `owned`; any other stays in it, with
 *  the reason, so it can be diagnosed or retried by identity. Each attempt is independent. */
async function reapOwned(owned) {
  const unconfirmed = []
  for (const identity of [...owned].toReversed()) {
    try {
      if (await reapIdentity(identity)) {
        owned.splice(owned.indexOf(identity), 1)
      } else {
        unconfirmed.push({ identity, reason: 'still live after SIGTERM and SIGKILL' })
      }
    } catch (error) {
      unconfirmed.push({ identity, reason: `signal failed: ${error.code ?? error.message}` })
    }
  }
  return unconfirmed
}

/** Ends every spawned composition, then every recorded Restate identity. Each step is attempted even
 *  after an earlier failure. The work directory is removed only when nothing remains unconfirmed;
 *  otherwise it and the recorded identities are kept for diagnosis. */
async function releaseOwnership({ work, incarnations, owned, exitBoundMs = EXIT_BOUND_MS }) {
  const problems = []
  for (const [index, incarnation] of incarnations.entries()) {
    const label = `composition incarnation ${index} (pid ${incarnation.child.pid ?? 'unspawned'})`
    try {
      await stopChild(incarnation, { label, timeoutMs: exitBoundMs })
    } catch (error) {
      problems.push(error)
    }
    // Without a started or failed record, that incarnation's Restate processes were never recorded.
    const reported = incarnation.stages.some(
      (entry) => entry.stage === 'started' || entry.stage === 'failed'
    )
    if (!reported) {
      problems.push(new Error(`RESTATE_OWNERSHIP_UNRECORDED: ${label}`))
    }
  }
  let unconfirmed = await reapOwned(owned)
  // One retry, limited to identities that are still recorded and not confirmed gone.
  if (unconfirmed.length > 0) unconfirmed = await reapOwned(owned)
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
    const initialOwned = await recordOwnedRestate(owned, started.launcherPid)
    const paused = await initial.next('awaiting_input', 60_000)
    expect(paused).toMatchObject({ state: 'awaiting_input', attemptCount: 1 })
    const { executionId } = paused

    // SIGKILL the composition process only. Its owned Restate child keeps running.
    expect(initial.child.kill('SIGKILL')).toBe(true)
    expect(await boundedWait(initial.exited, EXIT_BOUND_MS, 'initial composition exit')).toEqual({
      code: null,
      signal: 'SIGKILL',
    })
    expect(await liveIdentity(initialOwned.native)).toBeDefined()
    expect(await liveIdentity(initialOwned.launcher)).toBeDefined()

    // Manual orphan reap: the recovery composition needs the data directory and ports. Only the
    // identities recorded above are signalled.
    expect(await reapOwned(owned)).toEqual([])
    expect(await liveIdentity(initialOwned.native)).toBeUndefined()
    expect(await liveIdentity(initialOwned.launcher)).toBeUndefined()

    const recovery = spawnSelfHostedSimpleComposition('recover', { ...config, executionId })
    incarnations.push(recovery)
    const recoveredStarted = await recovery.next('started')
    const recoveredOwned = await recordOwnedRestate(owned, recoveredStarted.launcherPid)
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
    expect(await liveIdentity(recoveredOwned.native)).toBeUndefined()
    expect(await liveIdentity(recoveredOwned.launcher)).toBeUndefined()

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

  test('reaping signals only the recorded identity, never a reused pid or a same-named process', async () => {
    const bystander = spawn('sleep', ['60'], { stdio: 'ignore' })
    const bystanderExit = processExit(bystander)
    cleanup.push(async () => {
      if (bystander.exitCode === null && bystander.signalCode === null) bystander.kill('SIGKILL')
      await boundedWait(bystanderExit, EXIT_BOUND_MS, 'bystander exit')
    })
    let identity
    for (let attempt = 0; attempt < 50 && identity === undefined; attempt += 1) {
      identity = await identityOfPid(bystander.pid)
      if (identity === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(identity).toBeDefined()

    // A recorded start time that no longer matches means the pid was reused: nothing is signalled.
    expect(await reapIdentity({ ...identity, started: 'Mon Jan  1 00:00:00 2001' })).toBe(true)
    expect(await liveIdentity(identity)).toBeDefined()

    // The exact recorded identity is reaped.
    expect(await reapIdentity(identity)).toBe(true)
    expect(await liveIdentity(identity)).toBeUndefined()
    expect(await boundedWait(bystanderExit, EXIT_BOUND_MS, 'bystander exit')).toMatchObject({
      signal: 'SIGTERM',
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
