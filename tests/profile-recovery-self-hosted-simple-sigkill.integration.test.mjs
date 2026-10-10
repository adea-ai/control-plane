// M17.02.2 (#1025): SIGKILL of the self-hosted simple composition while its owned, pinned Restate
// child runs. The composition is the supported LocalControlPlaneComposition (profile
// `hosted-simple`, durable execution `restate`) in a child process. The parent kills that process
// only. The launcher and native Restate server it started keep running as orphans. The parent
// reaps exactly those recorded identities, then a second composition recovers the same execution.
//
// Proven here: the paused approval survives the kill with its execution, attempt, and version;
// the recovered composition serves the same execution; a duplicate run submission starts no second
// effect; one approval resumes the workflow; `prepare` runs once, `finalize` runs once, and one
// result artifact is written across both incarnations; owned processes are reaped by identity.
//
// Not covered: Restate drain, upgrade, rollback, and Hosted. Those stay in
// docs/profile-recovery-acceptance-map.md.

import { spawn } from 'node:child_process'
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
  fixturePath,
  graph,
  graphInput,
  liveIdentity,
  ownedNativeServer,
  pinnedRestateCommands,
  processTable,
  reapIdentity,
  runInputOf,
} from './fixtures/self-hosted-simple-sigkill.mjs'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const pinned = pinnedRestateCommands()
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

/** A composition child process with a line protocol on stdout. */
function spawnComposition(mode, config) {
  const child = spawn(process.execPath, [fixturePath, mode], {
    cwd: repositoryRoot,
    env: { ...process.env, SELF_HOSTED_SIMPLE_CONFIG: JSON.stringify(config) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stages = []
  let buffer = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()
    // Restate and framework logs share stdout; only protocol records are parsed.
    for (const line of lines) if (line.startsWith('{')) stages.push(JSON.parse(line))
  })
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096)
  })
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  )
  async function next(stage, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = stages.find((entry) => entry.stage === stage)
      if (found) return found
      const failed = stages.find((entry) => entry.stage === 'failed')
      if (failed) throw new Error(`COMPOSITION_CHILD_FAILED: ${failed.message}`)
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`COMPOSITION_CHILD_EXITED_BEFORE_${stage}: ${stderr}`)
      }
      if (Date.now() > deadline) throw new Error(`COMPOSITION_CHILD_TIMEOUT_${stage}: ${stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return { child, exited, next }
}

/** Identity of a live process row, recorded before the parent signals anything. */
async function identityOf(pid, commandIncludes) {
  const row = (await processTable()).find((entry) => entry.pid === pid)
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

/** Records the owned launcher and native server of one incarnation, once its composition started. */
async function recordOwnedRestate(owned, launcherPid) {
  const launcher = await identityOf(launcherPid, pinned.launcher)
  owned.push(launcher)
  const native = await ownedNativeServer(launcherPid, pinned.native)
  owned.push(native)
  return { launcher, native }
}

async function reapOwned(owned) {
  const leftovers = []
  for (const identity of owned.splice(0).toReversed()) {
    if (!(await reapIdentity(identity))) leftovers.push(identity)
  }
  if (leftovers.length > 0) {
    throw new Error(`OWNED_PROCESS_REAP_FAILED: ${leftovers.map((entry) => entry.pid).join(',')}`)
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

describe('M17.02.2 self-hosted simple SIGKILL recovery (hosted-simple, owned pinned Restate)', () => {
  test('SIGKILL of the composition while its pinned Restate child runs recovers the same execution with no duplicate effect', async () => {
    const work = await mkdtemp(join(tmpdir(), 'self-hosted-simple-sigkill-'))
    const dataDirectory = join(work, 'data')
    const evidencePath = join(work, 'effects.jsonl')
    const ports = await isolatedPorts()
    const owned = []
    const incarnations = []
    cleanup.push(async () => {
      for (const incarnation of incarnations) {
        if (incarnation.child.exitCode === null && incarnation.child.signalCode === null) {
          incarnation.child.kill('SIGKILL')
        }
      }
      await reapOwned(owned)
      await rm(work, { recursive: true, force: true })
    })
    const config = { dataDirectory, ports, evidencePath }

    const initial = spawnComposition('initial', config)
    incarnations.push(initial)
    const started = await initial.next('started')
    const initialOwned = await recordOwnedRestate(owned, started.launcherPid)
    const paused = await initial.next('awaiting_input', 60_000)
    expect(paused).toMatchObject({ state: 'awaiting_input', attemptCount: 1 })
    const { executionId } = paused

    // SIGKILL the composition process only. Its owned Restate child keeps running.
    expect(initial.child.kill('SIGKILL')).toBe(true)
    expect(await initial.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(await liveIdentity(initialOwned.native)).toBeDefined()
    expect(await liveIdentity(initialOwned.launcher)).toBeDefined()

    // The recovery composition needs the data directory and ports, so the orphans are reaped
    // first. Only the identities recorded above are signalled.
    await reapOwned(owned)
    expect(await liveIdentity(initialOwned.native)).toBeUndefined()
    expect(await liveIdentity(initialOwned.launcher)).toBeUndefined()

    const recovery = spawnComposition('recover', { ...config, executionId })
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
    expect(await recovery.exited).toEqual({ code: 0, signal: null })
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
    cleanup.push(async () => {
      if (bystander.exitCode === null && bystander.signalCode === null) bystander.kill('SIGKILL')
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const identity = (await processTable()).find((row) => row.pid === bystander.pid)
    expect(identity).toBeDefined()

    // A recorded start time that no longer matches means the pid was reused: nothing is signalled.
    expect(await reapIdentity({ ...identity, started: 'Mon Jan  1 00:00:00 2001' })).toBe(true)
    expect(await liveIdentity(identity)).toBeDefined()

    // The exact recorded identity is reaped.
    expect(await reapIdentity(identity)).toBe(true)
    expect(await liveIdentity(identity)).toBeUndefined()
  })
})
