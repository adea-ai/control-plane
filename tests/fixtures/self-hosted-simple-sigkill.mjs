// Test-owned helper for the self-hosted simple SIGKILL proof (M17.02.2, #1025).
//
// Scope label: this proof uses the legacy LangGraph test composition
// (`graphActivitiesFactory` over `LocalControlPlaneComposition`). It is not Pi Durable host wiring.
// The parent reaps the orphaned Restate launcher and native server by recorded identity before the
// recovery composition starts. It does not adopt orphans.
//
// Runs as a child process: `node <this file> initial|recover` with configuration in
// SELF_HOSTED_SIMPLE_CONFIG. Each incarnation opens the supported LocalControlPlaneComposition
// (profile `hosted-simple`, durable execution `restate`), which launches the pinned Restate
// server through its own process provider. The parent kills the composition process only, so
// the owned Restate launcher and its native server are orphaned while they run.
//
// Process control is scoped to identities recorded by the parent: `ps -p <pid>` for one recorded
// pid, and `pgrep -P <recorded launcher pid>` for that launcher's direct children. Nothing lists
// the system process table and nothing matches by name.

import { execFile, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { LocalControlPlaneComposition } from '../../apps/local-control-plane/src/composition.ts'
import {
  LangGraphOrchestrationAdapter,
  LangGraphSqliteCheckpointSaver,
  deterministicInterruptGraph,
} from '../../packages/langgraph-adapter/src/index.ts'
import { OrchestrationGraphSegmentActivities } from '../../packages/workflow-runtime/src/index.ts'
import { CommandInboxService } from '@control-plane/domain'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import { ManagedPiAdapter, ManagedPiDriver } from '@control-plane/managed-pi-adapter'
import { CompletedManagedPiClient } from './completed-managed-pi-client.mjs'
import { createRegisteredGraphPlan, seedRegisteredGraphPlan } from './registered-graph-plan.mjs'

export const graph = {
  graphDefinitionId: 'self-hosted-simple-recovery',
  graphVersion: '1.0.0',
  contentDigest: `sha256:${'a'.repeat(64)}`,
}
export const graphInput = { objective: 'recover a self-hosted simple approval' }
export const approvalInteractionId = 'approval-1'

/** Only lines with this prefix are protocol records. Restate and framework logs never match it. */
export const PROTOCOL_PREFIX = 'SELF_HOSTED_SIMPLE_PROTOCOL '
const PROTOCOL_STAGES = new Set([
  'started',
  'awaiting_input',
  'recovered',
  'completed',
  'closed',
  'failed',
])
const MAXIMUM_STDOUT_BUFFER = 1 << 20

const execFileAsync = promisify(execFile)
const fixturePath = fileURLToPath(import.meta.url)
const require = createRequire(
  new URL('../../apps/local-control-plane/package.json', import.meta.url)
)

/** Append-only effect ledger shared by both incarnations through a file outside the data directory. */
export function effectLedger(path, incarnation) {
  return {
    record(kind, detail) {
      appendFileSync(
        path,
        `${JSON.stringify({ incarnation, pid: process.pid, kind, detail, at: new Date().toISOString() })}\n`
      )
    },
  }
}

function createDirectManagedPiAdapter() {
  return new ManagedPiAdapter({
    transport: new DirectLocalRuntimeTransport(
      new ManagedPiDriver({ client: new CompletedManagedPiClient(), adapterVersion: '1.0.0' })
    ),
  })
}

/** The supported composition, configured exactly as the existing self-hosted simple proof. */
export function openSelfHostedSimpleComposition({ dataDirectory, ports, effects, executionIdRef }) {
  const plan = createRegisteredGraphPlan(graph, graphInput)
  const registration = deterministicInterruptGraph(graph)
  let composition
  composition = new LocalControlPlaneComposition({
    profile: 'hosted-simple',
    dataDirectory,
    durableExecution: 'restate',
    runtimeTransport: createDirectManagedPiAdapter(),
    ...ports,
    graphActivitiesFactory: ({ persistence }) =>
      new OrchestrationGraphSegmentActivities(
        new LangGraphOrchestrationAdapter({
          checkpointer: new LangGraphSqliteCheckpointSaver(
            persistence,
            plan.correlation.workspaceId
          ),
          graphs: [
            {
              reference: graph,
              build(buildContext) {
                const runnable = registration.build(buildContext)
                return {
                  invoke: async (input, config) => {
                    const state = await runnable.invoke(input, config)
                    if (state.output?.decision === undefined) return state
                    const executionId = executionIdRef.current
                    const key = `graph-results/${executionId}/result.json`
                    await composition.objectStore.put({
                      key,
                      body: new TextEncoder().encode(JSON.stringify(state.output)),
                      contentType: 'application/json',
                      metadata: { execution: executionId },
                    })
                    effects.record('artifact', key)
                    return {
                      ...state,
                      output: { ...state.output, artifactRef: artifactIdOf(executionId) },
                    }
                  },
                }
              },
            },
          ],
          operations: {
            invoke: async ({ name }) => {
              effects.record('operation', name)
              return { value: name }
            },
            cancel: async () => true,
          },
          events: { publish: async () => {} },
        })
      ),
  })
  return { composition, plan }
}

export function artifactIdOf(executionId) {
  return `art_${executionId.slice(4)}`
}

export function acceptanceCommand(plan) {
  return {
    callerPrincipalId: 'svc_self-hosted-simple-recovery',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: 'self-hosted-simple-recovery-execution',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
    },
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    retentionExpiresAt: '2099-01-01T00:00:00.000Z',
  }
}

export function runInputOf(plan, executionId) {
  return {
    executionId,
    workflowId: `wfl_${executionId.slice(4)}`,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    deadlineAt: new Date(Date.now() + 90000).toISOString(),
    graph: {
      workspaceId: plan.correlation.workspaceId,
      reference: graph,
      threadId: `graph:${executionId}`,
      input: plan.graph.input,
    },
  }
}

function emit(message, callback) {
  process.stdout.write(`${PROTOCOL_PREFIX}${JSON.stringify(message)}\n`, callback)
}

async function waitForExecution(composition, executionId, done) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const execution = await composition.executions.getExecution(executionId)
    if (done(execution)) return execution
    await delay(25)
  }
  throw new Error('SELF_HOSTED_SIMPLE_EXECUTION_TIMEOUT')
}

function summaryOf(execution) {
  return {
    state: execution.state,
    version: execution.version,
    attemptCount: execution.attemptCount,
    latestAttemptId: execution.latestAttemptId,
  }
}

async function runInitial(config) {
  const effects = effectLedger(config.evidencePath, 'initial')
  const executionIdRef = { current: undefined }
  const { composition, plan } = openSelfHostedSimpleComposition({
    dataDirectory: config.dataDirectory,
    ports: config.ports,
    effects,
    executionIdRef,
  })
  await composition.start()
  const started = await composition.workflow.health()
  emit({ stage: 'started', pid: process.pid, launcherPid: started.details?.pid })
  const seeded = await seedRegisteredGraphPlan(composition, plan, {
    reference: graph,
    input: graphInput,
  })
  const acceptedAt = new Date().toISOString()
  const accepted = await new CommandInboxService({
    repository: composition.commandRepository,
    executionIdFactory: () => `exe_${plan.executionPlanId.slice(4)}`,
    executionPlanValidator: seeded,
  }).acceptExecution({
    ...acceptanceCommand(plan),
    receivedAt: acceptedAt,
    retentionExpiresAt: new Date(Date.parse(acceptedAt) + 30 * 86400000).toISOString(),
  })
  const executionId = accepted.execution.executionId
  executionIdRef.current = executionId
  const send = await fetch(
    `http://127.0.0.1:${config.ports.restateIngressPort}/execution-lifecycle/${executionId}/run/send`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(runInputOf(plan, executionId)),
      signal: AbortSignal.timeout(15000),
    }
  )
  if (!send.ok) throw new Error('SELF_HOSTED_SIMPLE_RUN_SEND_FAILED')
  const paused = await waitForExecution(
    composition,
    executionId,
    (execution) => execution.state === 'awaiting_input'
  )
  const health = await composition.workflow.health()
  if (!Number.isSafeInteger(health.details?.pid)) throw new Error('SELF_HOSTED_SIMPLE_NO_PID')
  emit({
    stage: 'awaiting_input',
    pid: process.pid,
    executionId,
    launcherPid: health.details.pid,
    ...summaryOf(paused),
  })
  // Wait for the parent's SIGKILL. The bounded keep-alive stops a stranded composition.
  await delay(120_000)
  await composition.close()
}

async function runRecover(config) {
  const effects = effectLedger(config.evidencePath, 'recovery')
  const executionIdRef = { current: config.executionId }
  const { composition } = openSelfHostedSimpleComposition({
    dataDirectory: config.dataDirectory,
    ports: config.ports,
    effects,
    executionIdRef,
  })
  await composition.start()
  const health = await composition.workflow.health()
  emit({ stage: 'started', pid: process.pid, launcherPid: health.details?.pid })
  const recovered = await composition.executions.getExecution(config.executionId)
  emit({
    stage: 'recovered',
    pid: process.pid,
    executionId: config.executionId,
    launcherPid: health.details?.pid,
    ...summaryOf(recovered),
  })
  const lines = createInterface({ input: process.stdin })
  const closeRequested = new Promise((resolve) => {
    lines.on('line', (line) => {
      if (line.trim() === 'close') resolve()
    })
  })
  const finished = await waitForExecution(composition, config.executionId, (execution) =>
    ['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state)
  )
  const result = await composition.objectStore.get(
    `graph-results/${config.executionId}/result.json`
  )
  emit({
    stage: 'completed',
    pid: process.pid,
    executionId: config.executionId,
    ...summaryOf(finished),
    terminalResultRef: finished.terminalResultRef,
    result: JSON.parse(new TextDecoder().decode(result.body)),
  })
  await closeRequested
  lines.close()
  await composition.close()
  // Explicit exit once the composition has released its Restate child and storage.
  emit({ stage: 'closed', pid: process.pid }, () => process.exit(0))
}

if (process.argv[1] === fixturePath) {
  const mode = process.argv[2]
  const config = JSON.parse(process.env.SELF_HOSTED_SIMPLE_CONFIG ?? '{}')
  try {
    if (mode === 'initial') await runInitial(config)
    else if (mode === 'recover') await runRecover(config)
    else throw new Error('SELF_HOSTED_SIMPLE_MODE_INVALID')
  } catch (error) {
    emit({ stage: 'failed', pid: process.pid, message: String(error?.message ?? error) })
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------------------------
// Parent-side protocol and process control.

/** Parses one stdout line. Anything that is not a protocol record yields undefined; never throws. */
export function parseProtocolLine(line) {
  if (!line.startsWith(PROTOCOL_PREFIX)) return undefined
  let record
  try {
    record = JSON.parse(line.slice(PROTOCOL_PREFIX.length))
  } catch {
    return undefined
  }
  if (
    record === null ||
    typeof record !== 'object' ||
    typeof record.stage !== 'string' ||
    !PROTOCOL_STAGES.has(record.stage)
  ) {
    return undefined
  }
  return record
}

/** Resolves with the exit or spawn-error outcome. The promise is attached before any event can fire. */
export function processExit(child) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    child.once('error', (error) => settle({ code: null, signal: null, error }))
    child.once('exit', (code, signal) => settle({ code, signal }))
  })
}

/** A child process with a protocol-only stdout reader. Every wait is bounded by a caller timeout. */
export function spawnProtocolChild({ executable, args = [], cwd, env = process.env }) {
  const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = processExit(child)
  const stages = []
  let stdoutBuffer = ''
  let stderrTail = ''
  let spawnError
  let wake = () => {}
  child.once('error', (error) => {
    spawnError = error
    wake()
  })
  child.stdout.on('data', (chunk) => {
    try {
      stdoutBuffer = `${stdoutBuffer}${chunk}`
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop()
      if (stdoutBuffer.length > MAXIMUM_STDOUT_BUFFER) stdoutBuffer = ''
      for (const line of lines) {
        const record = parseProtocolLine(line)
        if (record !== undefined) stages.push(record)
      }
      wake()
    } catch {
      // Protocol parsing never escapes the event handler; malformed lines are ignored.
    }
  })
  child.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-4096)
  })
  async function next(stage, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = stages.find((entry) => entry.stage === stage)
      if (found) return found
      const failed = stages.find((entry) => entry.stage === 'failed')
      if (failed) throw new Error(`PROTOCOL_CHILD_FAILED: ${failed.message}`)
      if (spawnError)
        throw new Error(`PROTOCOL_CHILD_SPAWN_FAILED: ${spawnError.code ?? 'UNKNOWN'}`)
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`PROTOCOL_CHILD_EXITED_BEFORE_${stage}: ${stderrTail}`)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`PROTOCOL_CHILD_TIMEOUT_${stage}: ${stderrTail}`)
      await new Promise((resolve) => {
        wake = resolve
        setTimeout(resolve, Math.min(remaining, 100))
      })
    }
  }
  return { child, exited, next, stages }
}

/** One self-hosted simple composition incarnation, spawned from this helper. */
export function spawnSelfHostedSimpleComposition(mode, config) {
  return spawnProtocolChild({
    executable: process.execPath,
    args: [fixturePath, mode],
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, SELF_HOSTED_SIMPLE_CONFIG: JSON.stringify(config) },
  })
}

/** Rejects if a promise has not settled within the bound. Used for every exit wait. */
export function boundedWait(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`BOUNDED_WAIT_TIMEOUT:${label}`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Ends one child this test spawned: SIGKILL if still running, then await its exit (bounded). */
export async function stopChild(entry, { label, timeoutMs = 10_000 }) {
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill('SIGKILL')
  }
  return boundedWait(entry.exited, timeoutMs, label)
}

/** The launcher the composition spawns, and the native server the launcher spawns. Both are
 *  resolved the way the launcher resolves its own binary, so the paths compare equal. */
export function pinnedRestateCommands() {
  const restatePackage = require.resolve('@restatedev/restate-server/package.json')
  const launcherRequire = createRequire(restatePackage)
  return {
    launcher: join(dirname(restatePackage), 'lib', 'index.js'),
    native: launcherRequire.resolve(
      `@restatedev/restate-server-${process.platform}-${process.arch}/bin/restate-server`
    ),
  }
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

/** Identity of one recorded pid, read with `ps -p <pid>`. Undefined when the pid no longer exists. */
export async function identityOfPid(pid) {
  let stdout
  try {
    ;({ stdout } = await execFileAsync('ps', [
      '-p',
      String(pid),
      '-o',
      'pid=,ppid=,lstart=,command=',
    ]))
  } catch (error) {
    if (error.code === 1) return undefined
    throw error
  }
  const match = PS_ROW.exec(stdout.trim())
  if (match === null) throw new Error('OWNED_PROCESS_PS_OUTPUT_INVALID')
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    started: match[3].replace(/\s+/g, ' '),
    command: match[4],
  }
}

/** Returns the live row for a recorded identity, or undefined when that identity is gone. */
export async function liveIdentity(identity) {
  const row = await identityOfPid(identity.pid)
  if (row === undefined || row.started !== identity.started || row.command !== identity.command) {
    return undefined
  }
  return row
}

/** Direct children of one recorded launcher, via `pgrep -P`. Never a system-wide listing. */
export async function childrenOfRecorded(parentPid) {
  let stdout
  try {
    ;({ stdout } = await execFileAsync('pgrep', ['-P', String(parentPid)]))
  } catch (error) {
    if (error.code === 1) return []
    if (error.code === 'ENOENT') {
      throw new Error('NATIVE_CHILD_RECORDING_UNAVAILABLE', { cause: error })
    }
    throw error
  }
  const rows = []
  for (const line of stdout.split('\n')) {
    const pid = Number(line.trim())
    if (!Number.isSafeInteger(pid) || pid < 1) continue
    const row = await identityOfPid(pid)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

/** Finds the native server owned by a recorded launcher, by its direct parent and pinned path. */
export async function ownedNativeServer(launcherPid, nativePath, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const matches = (await childrenOfRecorded(launcherPid)).filter((row) =>
      row.command.includes(nativePath)
    )
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error('SELF_HOSTED_SIMPLE_NATIVE_AMBIGUOUS')
    await delay(100)
  }
  throw new Error('SELF_HOSTED_SIMPLE_NATIVE_NOT_FOUND')
}

/** Ends one recorded identity: SIGTERM first, SIGKILL only if it outlives the grace period. */
export async function reapIdentity(identity, { graceMs = 30_000, forceMs = 10_000 } = {}) {
  for (const [signal, budget] of [
    ['SIGTERM', graceMs],
    ['SIGKILL', forceMs],
  ]) {
    if (!(await liveIdentity(identity))) return true
    // Re-verify immediately before signalling, so a reused pid is never signalled.
    if (!(await liveIdentity(identity))) return true
    try {
      process.kill(identity.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      if (!(await liveIdentity(identity))) return true
      await delay(100)
    }
  }
  return !(await liveIdentity(identity))
}

export { fixturePath }
