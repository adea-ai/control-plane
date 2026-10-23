import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { postgresImageVariable } from './docker-pull-backoff.mjs'
import { pullPostgresImage } from './pull-postgres-image.mjs'
import {
  INTEGRATION_SHARD_IDS,
  integrationFileArguments,
  parseIntegrationShard,
  selectIntegrationShard,
} from './integration-shards.mjs'

// Keep the documented production-like command visible to repository policy tests.
const COMPOSE_COMMAND = 'docker compose'

// `--shard=<n>` (or INTEGRATION_SHARD) runs one explicit slice of the suite.
// The local PR lane runs all three inventory-checked slices concurrently
// against one runner-owned disposable PostgreSQL service. Trusted-main Neon
// verification does not invoke this full portable integration suite.
const integrationShard = parseIntegrationShard(
  process.argv.find((argument) => argument.startsWith('--shard='))?.slice('--shard='.length) ??
    process.env.INTEGRATION_SHARD
)
if (integrationShard !== null) {
  console.log(`Running integration shard ${integrationShard} of the partitioned suite.`)
}

const CHILD_COMMAND_TIMEOUT_MS = 90_000
// How long an owned child's COMPLETION may take once it has been terminated.
//
// A terminated child can leave a nested build descendant alive, and that
// descendant keeps the inherited pipes open, so the child's `close` event —
// which waits for those pipes — never arrives. The completion is therefore
// bounded after termination: the run fails closed with the bound instead of
// waiting forever for a pipe nobody owns.
const CHILD_COMPLETION_TIMEOUT_MS = 10_000
// How long the owned descendants are given to disappear after they were
// signalled, before a survivor is reported. A signal is delivered
// asynchronously, so this is the window in which a killed process is still
// visible.
const OWNED_TREE_EXIT_WAIT_MS = 2_000

// Every owned child is started with a unique value of this variable. A
// descendant inherits it, so it stays attributable to the child that started it
// after the direct child has exited and the kernel has re-parented the
// descendant to init, which is when the parent links can no longer prove it.
const OWNER_TOKEN_VARIABLE = 'CONTROL_PLANE_RUNNER_OWNER'

// Runner-owned children stay in the runner's own process group. They are
// recorded here so an interruption signals only them, and they also share the
// runner's group so a supervising group termination reaps them rather than
// leaving orphans. The runner never looks up or kills processes by name.
const activeChildren = new Set()

// Per-child state: the command it runs, whether it has been terminated, and
// the bound that makes its completion settle.
const childStates = new WeakMap()

function trackRunnerChild(child, command, ownerToken) {
  activeChildren.add(child)
  childStates.set(child, {
    command,
    ownerToken,
    terminated: false,
    completionTimer: undefined,
    failWith: undefined,
    abandon: undefined,
  })
  const release = () => {
    activeChildren.delete(child)
    const state = childStates.get(child)
    if (state?.completionTimer !== undefined) clearTimeout(state.completionTimer)
  }
  child.once('close', release)
  child.once('error', release)
  // The direct child can exit while a descendant still holds the inherited
  // pipes, so `close` never arrives. Its exit starts the same bounded wait that
  // a termination does; a normal exit closes the pipes at once and clears it.
  child.once('exit', () => armCompletionBound(child))
  return child
}

/**
 * Releases the pipes of an abandoned child.
 *
 * A child that was terminated but whose descendant still holds the inherited
 * pipes keeps the runner's own stdout/stderr readers open, and an open reader
 * keeps the event loop alive — so the runner would never exit even though its
 * work is finished. Abandoning the child closes the runner's ends of those
 * pipes, which is what lets the runner settle.
 */
function abandonChildPipes(child) {
  try {
    child.stdout?.destroy()
  } catch {
    // The stream is already gone.
  }
  try {
    child.stderr?.destroy()
  } catch {
    // The stream is already gone.
  }
  try {
    child.unref?.()
  } catch {
    // The child handle does not support unref.
  }
}

/**
 * The descendants of an owned child, from one process-tree snapshot.
 *
 * The runner walks the parent links of the PIDs it already owns; it never
 * looks a process up by name, and it never walks upwards, so the caller's own
 * process and process group are outside the result by construction.
 */
function ownedDescendants(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return []
  // `-A` is required: without it the listing covers only the current terminal's
  // processes, which would silently omit a descendant that was started with a
  // different session.
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  if (result.error !== undefined && result.error !== null) return []
  if (result.status !== 0) return []
  const childrenByParent = new Map()
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u)
    if (match === null) continue
    const child = Number.parseInt(match[1], 10)
    const parent = Number.parseInt(match[2], 10)
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent)) continue
    if (child <= 1 || child === process.pid) continue
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
    childrenByParent.get(parent).push(child)
  }
  const descendants = []
  const stack = [pid]
  const seen = new Set([pid])
  while (stack.length > 0) {
    const current = stack.pop()
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      descendants.push(child)
      stack.push(child)
    }
  }
  return descendants
}

/** Whether a PID still names a live process. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    // A permission error still means the process exists.
    return true
  }
}

/**
 * The live processes that carry an owned child's token.
 *
 * Only a descendant of that child can carry its token, so the result is owned
 * by construction, and unlike the parent links it still names a descendant that
 * outlived the child and was re-parented to init. It reads /proc, so on a
 * platform without it the result is empty and the parent links are all there is.
 */
function pidsCarryingOwnerToken(token, directChildPid) {
  if (typeof token !== 'string' || token === '') return []
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  // Entries are NUL-separated; the leading NUL anchors the name at an entry start.
  const needle = `\0${OWNER_TOKEN_VARIABLE}=${token}\0`
  const owned = []
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    const pid = Number.parseInt(entry, 10)
    // The direct child carries its own token; it is signalled and reaped as the
    // child, not reported as a descendant.
    if (pid <= 1 || pid === process.pid || pid === directChildPid) continue
    try {
      if (`\0${readFileSync(`/proc/${pid}/environ`, 'latin1')}\0`.includes(needle)) owned.push(pid)
    } catch {
      // The process is gone, or belongs to someone else and cannot be read.
    }
  }
  return owned
}

/** Waits without yielding the event loop, for a bounded time. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The owned descendants that are still alive after the termination.
 *
 * A signal is delivered asynchronously, so a process that was just killed is
 * still visible for a moment. The survivors are therefore the ones that are
 * still alive AFTER a bounded wait: a process that is on its way out is not a
 * survivor, and a process that is still there when the wait is over is.
 */
function survivingOwnedPids(pids) {
  const deadline = Date.now() + OWNED_TREE_EXIT_WAIT_MS
  let alive = pids.filter((pid) => isProcessAlive(pid))
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(25)
    alive = alive.filter((pid) => isProcessAlive(pid))
  }
  return alive
}

/**
 * Binds a child's completion to the promise that waits for it.
 *
 * The completion of a terminated child is bounded: the inherited pipes may be
 * held by a descendant, so `close` is not guaranteed to arrive. The bound
 * settles the promise, and the abandonment releases the pipes the runner still
 * holds, so the runner can finish.
 */
function bindChildCompletion(child, { failWith, abandon }) {
  const state = childStates.get(child)
  if (state === undefined) return
  state.failWith = failWith
  state.abandon = abandon
}

/**
 * Terminates the OWNED process tree of a child and reports what survived.
 *
 * Killing the direct child alone is not cleanup: a nested build descendant
 * survives it, keeps the inherited pipes open and can keep the runner's
 * completion from ever settling. The descendants are therefore terminated
 * first, and the direct child after them.
 *
 * Only the owned tree is touched: the descendants of the owned child (found by
 * its parent links while it runs, and by the token they inherited once it has
 * exited and orphaned them) and the child itself. No process is looked up by
 * name, a descendant that dropped the token is reported but never signalled, and
 * the caller's own process and process group are never signalled.
 */
function terminateChild(child) {
  const state = childStates.get(child)
  if (state !== undefined) state.terminated = true
  armCompletionBound(child)
  const alive = child.exitCode === null && child.signalCode === null
  // A child that already exited has no parent links left to walk, so its
  // descendants are found by the token they inherited instead.
  const descendants = [
    ...new Set([
      ...(alive ? ownedDescendants(child.pid) : []),
      ...pidsCarryingOwnerToken(state?.ownerToken, child.pid),
    ]),
  ]
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  if (alive) {
    try {
      child.kill('SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  return descendants
}

/**
 * Bounds how long an owned child's completion may take once it has exited or
 * been terminated.
 *
 * The inherited pipes may be held by a descendant, so `close` is not
 * guaranteed to arrive. When the bound is reached the owned remnants that can
 * still be proven are reaped, the runner's ends of the pipes are released, and
 * the run fails with the bound instead of waiting for a pipe nobody owns.
 */
function armCompletionBound(child) {
  const state = childStates.get(child)
  if (state === undefined || state.completionTimer !== undefined) return
  state.completionTimer = setTimeout(() => {
    const remnants = pidsCarryingOwnerToken(state.ownerToken, child.pid)
    for (const pid of remnants) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The remnant is already gone.
      }
    }
    const survivors = survivingOwnedPids(remnants)
    const report =
      remnants.length === 0
        ? 'an owned descendant may still hold the inherited pipes'
        : `reaped owned descendant(s) ${remnants.join(', ')}${
            survivors.length > 0 ? `; still alive: ${survivors.join(', ')}` : ''
          }`
    // The child is abandoned: its pipes are released so the runner can settle.
    state.abandon?.()
    state.failWith?.(
      state.terminated
        ? `${state.command} did not complete within ${CHILD_COMPLETION_TIMEOUT_MS} ms after it was terminated; ${report}`
        : `${state.command} exited but did not complete within ${CHILD_COMPLETION_TIMEOUT_MS} ms; ${report}`
    )
  }, CHILD_COMPLETION_TIMEOUT_MS)
  state.completionTimer.unref?.()
}

/**
 * Terminates every tracked owned child and verifies the owned trees are gone.
 *
 * The report names the descendants that survived: the direct child's exit is
 * not proof that its tree was reaped.
 */
function terminateActiveChildren() {
  // process.kill is synchronous and releases children only on a later event-loop
  // turn, so the live set is safe to iterate here.
  const descendants = []
  for (const child of activeChildren) descendants.push(...terminateChild(child))
  // The owned trees are VERIFIED, not assumed: the direct child's exit is not
  // proof that its descendants were reaped.
  return survivingOwnedPids(descendants)
}

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    // A first signal stops the run from starting new work. Only the shared
    // cleanup passes allowInterrupted, so it can still release owned resources.
    // The check and the synchronous spawn share one event-loop turn, so no
    // child can slip in between the guard and being tracked for reaping.
    if (interruptedSignal !== null && options.allowInterrupted !== true) {
      reject(new Error(`${command} not started: integration run interrupted`))
      return
    }
    const ownerToken = randomUUID()
    const child = trackRunnerChild(
      spawn(command, arguments_, {
        cwd: options.cwd ?? process.cwd(),
        env: { ...(options.environment ?? runnerEnvironment), [OWNER_TOKEN_VARIABLE]: ownerToken },
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      }),
      command,
      ownerToken
    )
    let stdout = ''
    let stderr = ''
    if (options.capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
    }
    const timeout = options.timeout ?? (command === 'docker' ? CHILD_COMMAND_TIMEOUT_MS : undefined)
    const timer =
      timeout === undefined ? undefined : setTimeout(() => terminateChild(child), timeout)
    timer?.unref()
    let settled = false
    const settle = (complete, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      complete(value)
    }
    // The completion of a terminated child is bounded, so the runner can settle
    // even when a surviving descendant keeps the inherited pipes open.
    bindChildCompletion(child, {
      failWith: (reason) => settle(reject, new Error(reason)),
      abandon: () => abandonChildPipes(child),
    })
    child.once('error', (error) => settle(reject, error))
    child.once('close', (status) => {
      if (status === 0) {
        settle(resolve, stdout)
        return
      }
      if (options.capture && stderr) process.stderr.write(stderr)
      settle(reject, new Error(`${command} exited with status ${String(status)}`))
    })
  })
}

// Retry only the digest-pinned image pull. Container startup and health checks
// run once, so a startup failure cannot be hidden by repeating `compose up`.
async function composeUpPostgres() {
  if (interruptedSignal !== null) throw new Error('Integration startup interrupted')
  const { image } = await pullPostgresImage({
    environment: runnerEnvironment,
    // An interrupted run launches no further pull command, and the backoff wait
    // ends with the interruption instead of running it out.
    isInterrupted: () => interruptedSignal !== null,
  })
  // A rate-limited registry falls over to the same digest elsewhere; compose then has to
  // start the image that is now present locally, here and in every later compose command.
  if (image !== undefined) runnerEnvironment[postgresImageVariable] = image
  if (interruptedSignal !== null) throw new Error('Integration startup interrupted')
  await run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], {
    environment: runnerEnvironment,
  })
}

const MAX_OUTPUT_TAIL_BYTES = 16 * 1024

function appendBoundedOutputTail(current, chunk, maxBytes = MAX_OUTPUT_TAIL_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Output tail byte limit must be a non-negative safe integer')
  }
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)])
  if (combined.length <= maxBytes) return combined.toString('utf8')

  let start = combined.length - maxBytes
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) start += 1
  return combined.subarray(start).toString('utf8')
}

function runStreaming(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    if (interruptedSignal !== null && options.allowInterrupted !== true) {
      reject(new Error(`${command} not started: integration run interrupted`))
      return
    }
    const ownerToken = randomUUID()
    const child = trackRunnerChild(
      spawn(command, arguments_, {
        cwd: options.cwd ?? process.cwd(),
        env: { ...(options.environment ?? runnerEnvironment), [OWNER_TOKEN_VARIABLE]: ownerToken },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      command,
      ownerToken
    )
    let settled = false
    const settle = (complete, value) => {
      if (settled) return
      settled = true
      complete(value)
    }
    // The completion of a terminated child is bounded, so the shard can settle
    // even when a surviving descendant keeps the inherited pipes open.
    bindChildCompletion(child, {
      failWith: (reason) => settle(reject, new Error(reason)),
      abandon: () => abandonChildPipes(child),
    })
    let stdoutTail = ''
    let stderrTail = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutTail = appendBoundedOutputTail(stdoutTail, chunk)
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrTail = appendBoundedOutputTail(stderrTail, chunk)
      process.stderr.write(chunk)
    })
    child.once('error', (error) => settle(reject, error))
    child.once('close', (status, signal) =>
      settle(resolve, { status, signal, stdoutTail, stderrTail })
    )
  })
}

function formatStreamingFailure(result) {
  const tails = []
  if (result.stdoutTail)
    tails.push(`stdout tail (max ${MAX_OUTPUT_TAIL_BYTES} bytes):\n${result.stdoutTail}`)
  if (result.stderrTail)
    tails.push(`stderr tail (max ${MAX_OUTPUT_TAIL_BYTES} bytes):\n${result.stderrTail}`)
  return tails.length === 0 ? '' : `\nBounded output diagnostics:\n${tails.join('\n')}`
}

async function runIntegrationFileStreaming(testArguments, options) {
  const result = await runStreaming('bun', testArguments, options)
  if (result.status === 0) return
  throw new Error(
    `bun test exited with status ${String(result.status)}${formatStreamingFailure(result)}`
  )
}

async function runIntegrationShardStreaming(shard, integrationEnvironment, remoteDatabase) {
  const perTestTimeoutMs = remoteDatabase ? '120000' : '30000'
  for (const group of selectIntegrationShard(shard)) {
    for (const file of group.files) {
      const testArguments = integrationFileArguments(group, file, perTestTimeoutMs)
      await runIntegrationFileStreaming(testArguments, {
        cwd: group.package,
        environment: integrationEnvironment,
      })
    }
  }
}

async function runLocalIntegrationShards(integrationEnvironment) {
  const results = await Promise.allSettled(
    INTEGRATION_SHARD_IDS.map(async (shard) => {
      console.log(`Local PostgreSQL integration shard ${shard} starting.`)
      await runIntegrationShardStreaming(shard, integrationEnvironment, false)
    })
  )
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          new Error(`Local PostgreSQL integration shard ${INTEGRATION_SHARD_IDS[index]} failed`, {
            cause: result.reason,
          }),
        ]
      : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more local PostgreSQL integration shards failed')
  }
}

async function waitForPostgres(isInterrupted = () => false) {
  const deadline = Date.now() + 30_000
  const readinessCommand = [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username',
    'control_plane_admin',
    '--dbname',
    'postgres',
    '--tuples-only',
    '--no-align',
    '--command',
    'SELECT 1',
  ]

  while (Date.now() < deadline) {
    if (isInterrupted()) throw new Error('PostgreSQL readiness probe interrupted')
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const result = spawnSync('docker', readinessCommand, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      env: runnerEnvironment,
      timeout: Math.min(5000, remaining),
    })
    if (result.error) {
      // A signal delivered while spawnSync held the event loop cannot run until
      // the loop regains control; yield one macrotask so a pending interruption
      // is observed instead of surfacing as a probe timeout.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (isInterrupted()) throw new Error('PostgreSQL readiness probe interrupted')
      throw result.error
    }
    if (result.status === 0 && result.stdout.trim() === '1') {
      console.log('PostgreSQL database system is accepting SQL connections')
      return
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
    )
  }

  throw new Error('PostgreSQL did not accept SQL connections within 30 seconds')
}

// A remote target (Neon preview branch or similar) replaces the local Docker
// Postgres lane entirely: no container to boot or probe, and the
// Docker-lifecycle drills below do not apply to it. Loopback URLs still take
// the local lane: the recovery matrix drives its own Postgres on an
// ephemeral loopback port and passes those URLs down, so presence alone
// cannot distinguish remote from local.
function databaseHostname(value) {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}
function isLoopbackHostname(hostname) {
  return (
    hostname === '' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}
const remoteDatabase = [process.env.DATABASE_URL, process.env.DATABASE_MIGRATION_URL]
  .filter((value) => value !== undefined)
  .some((value) => !isLoopbackHostname(databaseHostname(value)))

// Resolve and validate the remote lane before any Docker query. Remote CI and
// developer runs must work with no local engine installed or running.
if (remoteDatabase && !process.env.DATABASE_ADMIN_URL) {
  throw new Error(
    'Remote integration requires an explicit DATABASE_ADMIN_URL for isolated test databases'
  )
}
const runnerEnvironment = { ...process.env }
let postgresWasRunning = false
let ownsComposeProject = false
let startupAttempted = false
let verificationError
let cleanupError
let interruptedSignal = null
let cleanupPromise

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143
}

// Cleanup runs at most once and is shared by the normal path and an
// interruption. It removes only what the runner started: a freshly generated
// project's containers, network and volumes, or the caller project's
// PostgreSQL service. Never a shared project, cache or unrelated resource.
async function cleanupRunnerResources() {
  if (cleanupPromise !== undefined) return cleanupPromise
  cleanupPromise = (async () => {
    if (!startupAttempted) return
    try {
      if (ownsComposeProject) {
        await run(
          'docker',
          ['compose', 'down', '--volumes', '--remove-orphans', '--timeout', '60'],
          {
            allowInterrupted: true,
          }
        )
      } else {
        await run('docker', ['compose', 'stop', '--timeout', '60', 'postgres'], {
          allowInterrupted: true,
        })
      }
    } catch (error) {
      cleanupError = error
    }
  })()
  return cleanupPromise
}

// A first SIGINT/SIGTERM reaps only runner-owned child process groups and lets
// the shared cleanup path run once before the retained status is written. A
// second signal stops immediately with the signal's status. The original
// verification failure stays observable rather than being masked by the signal.
function handleInterruption(signal) {
  if (interruptedSignal !== null) {
    terminateActiveChildren()
    process.exit(signalExitCode(signal))
  }
  interruptedSignal = signal
  console.error(`Received ${signal}; stopping runner-owned commands and cleaning up.`)
  // The owned trees are verified, not assumed: the direct child's exit is not
  // proof that its descendants were reaped, so a survivor is reported.
  const survivors = terminateActiveChildren()
  if (survivors.length > 0)
    console.error(`An owned descendant survived the termination: ${survivors.join(', ')}.`)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => handleInterruption(signal))
}

// Last-resort synchronous reap for any still-tracked child on a normal or
// first-signal exit. A SIGKILL of the runner itself bypasses this, which is why
// runner-owned children also share the runner's process group.
process.on('exit', terminateActiveChildren)

async function main() {
  try {
    if (!remoteDatabase) {
      const runningServices = (
        await run('docker', ['compose', 'ps', '--status', 'running', '--services'], {
          capture: true,
        })
      )
        .split('\n')
        .filter(Boolean)
      postgresWasRunning = runningServices.includes('postgres')
      if (!postgresWasRunning) {
        // A caller's explicit project belongs to that caller (for example the
        // recovery matrix). Only our freshly generated project permits volume
        // deletion; never sweep another project or the shared Docker cache.
        if (!runnerEnvironment.COMPOSE_PROJECT_NAME) {
          ownsComposeProject = true
          const project = `control-plane-integration-${process.pid}-${randomUUID()}`
          runnerEnvironment.COMPOSE_PROJECT_NAME = project
          console.log(`Starting isolated integration PostgreSQL in project ${project}.`)
        } else {
          console.log('Starting integration PostgreSQL in the caller-owned project.')
        }
        startupAttempted = true
        await composeUpPostgres()
      }
    }
    if (!remoteDatabase) await waitForPostgres(() => interruptedSignal !== null)
    else console.log('Using remote database target from the environment.')
    const integrationEnvironment = {
      ...runnerEnvironment,
      DATABASE_ADMIN_URL:
        process.env.DATABASE_ADMIN_URL ??
        'postgresql://control_plane_admin:local-admin-only@127.0.0.1:54329/postgres',
      DATABASE_MIGRATION_URL:
        process.env.DATABASE_MIGRATION_URL ??
        'postgresql://control_plane_migrator:local-migration-only@127.0.0.1:54329/control_plane',
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://control_plane_app:local-application-only@127.0.0.1:54329/control_plane',
      RUN_DATABASE_INTEGRATION: 'true',
      // Suites scale their explicit per-test and per-hook budgets through
      // integrationTestTimeout(); an explicit bun test() timeout argument
      // always overrides the CLI --timeout default, so the ceiling has to
      // reach them through the environment.
      INTEGRATION_TEST_TIMEOUT_MS: remoteDatabase ? '120000' : undefined,
    }
    if (integrationShard === null && remoteDatabase) {
      // Preserve the full remote command for callers that do not select explicit
      // integration shards; trusted-main provider compatibility is a separate
      // bounded workflow and does not invoke this portable suite.
      await run(
        'bun',
        ['x', '--no-install', 'vp', 'run', '--concurrency=1', 'orch:test:integration'],
        {
          environment: integrationEnvironment,
        }
      )
      // Root-level scenarios import these workspace packages through their built entry
      // points. the package integration graph builds only the upstream packages of the
      // integration packages, so build the root's own imports before those scenarios run.
      await run('bun', ['x', '--no-install', 'vp', 'run', 'orch:build:integration-roots'], {
        environment: integrationEnvironment,
      })
      // Repository-owned scenarios span composition roots; keep their fixtures
      // outside individual workspace packages.
      await run(
        'bun',
        [
          'test',
          '--timeout',
          remoteDatabase ? '120000' : '30000',
          './tests/child-progress-scanner.integration.test.mjs',
          './tests/child-progress-sqlite-feed-replay.integration.test.mjs',
          './tests/memory-process-loss.integration.test.mjs',
          './tests/acp-remote-device-postgres.integration.test.mjs',
          './tests/langgraph-retirement-inventory-pg.integration.test.mjs',
          './tests/langgraph-retirement-status-adapter.integration.test.mjs',
          './tests/runtime-node-credential-revocation.integration.test.mjs',
        ],
        {
          environment: integrationEnvironment,
        }
      )
    } else if (integrationShard === null) {
      // The local runner owns one disposable PostgreSQL service. Build package
      // entrypoints once, then run the complete disjoint partition concurrently;
      // files remain serial within each shard to avoid cross-project contention.
      await run('bun', ['run', 'build'], { environment: integrationEnvironment })
      await runLocalIntegrationShards(integrationEnvironment)
    } else {
      // Explicit local shard runs need the same built package entrypoints as the
      // default local lane. Remote callers may build their shared source first.
      if (!remoteDatabase)
        await run('bun', ['run', 'build'], { environment: integrationEnvironment })
      await runIntegrationShardStreaming(integrationShard, integrationEnvironment, remoteDatabase)
    }
    // One drill execution per verification: shard 1 owns it in sharded runs.
    if (integrationShard === null || integrationShard === 1) {
      await run('bun', ['scripts/run-cloud-remote-drill.mjs'], {
        environment: integrationEnvironment,
      })
    }
    if (remoteDatabase) {
      console.log('Skipping PostgreSQL disruption and restore drills against a remote target.')
    } else {
      if (!postgresWasRunning) {
        await run('bun', ['scripts/run-postgres-disruption-drill.mjs'], {
          environment: { ...integrationEnvironment, POSTGRES_DISRUPTION_ALLOWED: 'true' },
        })
      } else {
        console.log(
          'Skipping PostgreSQL disruption drill because the runner did not start the service.'
        )
      }
      await run('bun', ['scripts/run-postgres-restore-drill.mjs'], {
        environment: integrationEnvironment,
      })
    }
  } catch (error) {
    verificationError = error
  } finally {
    await cleanupRunnerResources()
  }
  if (verificationError && cleanupError) {
    throw new AggregateError([verificationError, cleanupError], 'Integration and cleanup failed', {
      cause: verificationError,
    })
  }
  if (cleanupError) throw cleanupError
  if (verificationError) throw verificationError
}

try {
  await main()
} catch (error) {
  if (interruptedSignal === null) throw error
  // The interruption owns the exit status, but the original failure stays
  // observable instead of being masked by the signal or by cleanup.
  console.error(error)
  console.error(`Integration run interrupted by ${interruptedSignal}.`)
}
if (interruptedSignal !== null) process.exitCode = signalExitCode(interruptedSignal)

void COMPOSE_COMMAND
