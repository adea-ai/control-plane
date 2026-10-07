import { spawn } from 'node:child_process'
import { compareCodePointOrder } from '@control-plane/domain'
import { createHash } from 'node:crypto'
import { chmod, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  RuntimeAdapterError,
  RuntimeExecutionHandleSchema,
  RuntimeInputRequestSchema,
  RuntimeUsageSchema,
  RuntimeAttemptBudgetAuthoritySchema,
  type RuntimeExecutionHandle,
  type RuntimeUsage,
  type RuntimeAttemptBudgetAuthority,
} from '@control-plane/runtime-sdk'
import {
  enforceNodeProcessSpawnPolicy,
  ProcessRpcDecodeError,
  ProcessRpcLink,
  type NodeProcessSpawnPolicy,
  type ProcessRpcFrameCodec,
} from '@control-plane/deployment'
import {
  ManagedPiConfigurationSchema,
  ManagedPiInspectionSchema,
  type ManagedPiClient,
  type ManagedPiEvent,
} from './index.js'
import {
  persistTerminalRecord,
  readTerminalRecord,
  readTerminalEvents,
  recoverTerminalHandle,
} from './terminal-record.js'

const DRIVER_VERSION = '1.1.0'
const PROTOCOL_VERSION = '1.0.0'
const MAX_OUTPUT_BYTES = 1_000_000
const MAX_RPC_FRAME_BYTES = 1_048_576
const MAX_VERSION_OUTPUT_BYTES = 16_384
const CANCEL_STATS_WAIT_MS = 500
const VERSION_PROBE_TIMEOUT_MS = 15_000

export interface ManagedPiProcessInvocation {
  readonly systemPrompt: string
  readonly prompt: string
  readonly provider: string
  readonly model: string
}

export interface ManagedPiProcessInputResolver {
  /** Read trusted immutable repository scope without resolving native model inputs. */
  resolveWorkspace?(
    configuration: ReturnType<typeof ManagedPiConfigurationSchema.parse>
  ): Promise<string>
  resolve(
    configuration: ReturnType<typeof ManagedPiConfigurationSchema.parse>,
    context: ManagedPiProcessInvocationContext
  ): Promise<ManagedPiProcessInvocation>
}

/** Pinned allocation context; this data does not authorize a provider request by itself. */
export interface ManagedPiProcessInvocationContext {
  readonly attemptId: string
  readonly executionId?: string
  readonly attemptBudget?: RuntimeAttemptBudgetAuthority
}

export interface ManagedPiProcessClientOptions {
  readonly executablePath: string
  readonly dataDirectory: string
  readonly inputResolver: ManagedPiProcessInputResolver
  readonly environment?: Readonly<Record<string, string>>
  /**
   * Bounded spawn policy (CP-RNODE-025): when set, process launches that
   * violate it are rejected before any process starts.
   */
  readonly spawnPolicy?: NodeProcessSpawnPolicy
  readonly now?: () => Date
  readonly rpcTimeoutMs?: number
}

interface ProcessExecution {
  readonly handle: RuntimeExecutionHandle
  readonly rpc: PiRpcProcess
  readonly directory: string
  readonly startedAtMs: number
  readonly events: ManagedPiEvent[]
  readonly waiters: Set<() => void>
  state: 'running' | 'succeeded' | 'errored' | 'cancelled' | 'timed_out'
  deadlineTimer?: ReturnType<typeof setTimeout>
  output: string
  finalUsage?: RuntimeUsage
  statsSnapshot?: Promise<RuntimeUsage | undefined>
  terminalFinalization?: Promise<void>
  error?: Error
  persistence?: Promise<void>
}

export class ManagedPiProcessClient implements ManagedPiClient {
  readonly #dataDirectory: string
  readonly #environment: Readonly<Record<string, string>>
  readonly #executablePath: string
  readonly #executions = new Map<string, ProcessExecution>()
  readonly #admissions = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<RuntimeExecutionHandle> }
  >()
  readonly #inputResolver: ManagedPiProcessInputResolver
  readonly #now: () => Date
  readonly #rpcTimeoutMs: number
  readonly #spawnPolicy: NodeProcessSpawnPolicy | undefined

  constructor(options: ManagedPiProcessClientOptions) {
    this.#executablePath = options.executablePath
    this.#dataDirectory = resolve(options.dataDirectory)
    this.#inputResolver = options.inputResolver
    this.#environment = options.environment ?? {}
    this.#now = options.now ?? (() => new Date())
    this.#rpcTimeoutMs = options.rpcTimeoutMs ?? 15_000
    this.#spawnPolicy = options.spawnPolicy
  }

  async inspect() {
    if (this.#spawnPolicy !== undefined) {
      await enforceNodeProcessSpawnPolicy(this.#spawnPolicy, {
        executable: this.#executablePath,
        args: ['--version'],
        environment: this.#environment,
      })
    }
    try {
      const runtimeVersion = await inspectVersion(
        this.#executablePath,
        this.#environment,
        VERSION_PROBE_TIMEOUT_MS
      )
      return ManagedPiInspectionSchema.parse({
        driverVersion: DRIVER_VERSION,
        runtimeVersion,
        protocolVersion: PROTOCOL_VERSION,
        health: 'healthy' as const,
        capabilities: [
          { name: 'stream.output', support: 'supported' as const },
          { name: 'execution.cancel', support: 'supported' as const },
          { name: 'interaction.user-input', support: 'degraded' as const },
        ],
        limitations: [
          'PI_NATIVE_TOOLS_DISABLED',
          'PI_AMBIENT_CONTEXT_DISABLED',
          'PI_APPROVAL_INTERACTION_UNSUPPORTED',
          'PI_INFLIGHT_RESTART_RECONCILIATION_UNSUPPORTED',
        ],
        observedAt: this.#now().toISOString(),
      })
    } catch (error) {
      return ManagedPiInspectionSchema.parse({
        driverVersion: DRIVER_VERSION,
        runtimeVersion: '0.0.0',
        protocolVersion: PROTOCOL_VERSION,
        health: 'unavailable' as const,
        capabilities: [],
        limitations: [`PI_RUNTIME_UNAVAILABLE:${errorCode(error)}`],
        observedAt: this.#now().toISOString(),
      })
    }
  }

  async start(commandInput: Parameters<ManagedPiClient['start']>[0]) {
    const idempotencyKey = commandInput.idempotencyKey
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 256
    )
      throw new Error('PI_START_INVALID_IDEMPOTENCY_KEY')
    const configuration = ManagedPiConfigurationSchema.parse(commandInput.configuration)
    const handle = RuntimeExecutionHandleSchema.parse({
      handleId: `managed-pi:${commandInput.attemptId}`,
      attemptId: commandInput.attemptId,
      startedAt: this.#now().toISOString(),
    })
    const context = invocationContext(commandInput, configuration)
    if (context.attemptBudget !== undefined) {
      if (this.#inputResolver.resolveWorkspace === undefined) {
        throw new Error('PI_ATTEMPT_ALLOCATION_SCOPE_UNAVAILABLE')
      }
      const workspaceId = await this.#inputResolver.resolveWorkspace(
        ManagedPiConfigurationSchema.parse(configuration)
      )
      if (context.attemptBudget.workspaceId !== workspaceId) {
        throw new Error('PI_ATTEMPT_ALLOCATION_MISMATCH')
      }
    }
    const fingerprint = JSON.stringify(
      {
        idempotencyKey,
        configuration,
        ...(context.executionId === undefined ? {} : { executionId: context.executionId }),
        ...(context.attemptBudget === undefined ? {} : { attemptBudget: context.attemptBudget }),
      },
      (_key, value: unknown) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(
            Object.entries(value).toSorted(([left], [right]) => compareCodePointOrder(left, right))
          )
        }
        return value
      }
    )
    const admitted = this.#admissions.get(handle.handleId)
    if (admitted) {
      if (admitted.fingerprint !== fingerprint) throw new Error('PI_START_IDEMPOTENCY_CONFLICT')
      return structuredClone(await admitted.result)
    }
    const result = this.#startProcess(handle, configuration, fingerprint, context)
    // Retain rejected admissions as well: failure does not establish absence of native effects.
    this.#admissions.set(handle.handleId, { fingerprint, result })
    return structuredClone(await result)
  }

  async #startProcess(
    handle: RuntimeExecutionHandle,
    configuration: ReturnType<typeof ManagedPiConfigurationSchema.parse>,
    fingerprint: string,
    context: ManagedPiProcessInvocationContext
  ): Promise<RuntimeExecutionHandle> {
    try {
      await this.#reserveAdmission(handle, fingerprint)
    } catch (error) {
      if (
        !(error instanceof RuntimeAdapterError) ||
        error.code !== 'PI_START_RECONCILIATION_REQUIRED'
      )
        throw error
      try {
        return await recoverTerminalHandle(
          this.#dataDirectory,
          handle.attemptId,
          createHash('sha256').update(fingerprint).digest('hex')
        )
      } catch (recoveryError) {
        if (
          recoveryError instanceof RuntimeAdapterError &&
          recoveryError.code === 'PI_START_IDEMPOTENCY_CONFLICT'
        )
          throw recoveryError
        throw error
      }
    }
    const invocation = await this.#inputResolver.resolve(configuration, context)
    const directory = join(this.#dataDirectory, handle.attemptId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const systemPromptPath = join(directory, 'system-prompt.md')
    await writeFile(systemPromptPath, invocation.systemPrompt, { encoding: 'utf8', mode: 0o600 })
    await chmod(systemPromptPath, 0o600)

    const rpc = new PiRpcProcess({
      executablePath: this.#executablePath,
      cwd: directory,
      environment: this.#environment,
      ...(this.#spawnPolicy === undefined ? {} : { spawnPolicy: this.#spawnPolicy }),
      args: [
        '--mode',
        'rpc',
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--no-approve',
        '--system-prompt',
        systemPromptPath,
        '--provider',
        invocation.provider,
        '--model',
        invocation.model,
      ],
    })
    const execution: ProcessExecution = {
      handle,
      rpc,
      directory,
      startedAtMs: this.#now().getTime(),
      events: [],
      waiters: new Set(),
      state: 'running',
      output: '',
    }
    this.#executions.set(handle.handleId, execution)
    appendEvent(execution, { kind: 'status', state: 'running' }, this.#now())
    rpc.onEvent((event) => this.#observe(execution, event))
    rpc.onExit((error) => this.#fail(execution, error))
    try {
      await rpc.start()
      this.#armDeadline(execution, configuration.limits.duration.maximumMs)
      await rpc.request({ type: 'get_state' }, this.#rpcTimeoutMs)
      await rpc.request({ type: 'prompt', message: invocation.prompt }, this.#rpcTimeoutMs)
    } catch (error) {
      this.#fail(execution, asError(error))
      if (execution.terminalFinalization) await execution.terminalFinalization
      await rpc.stop()
      await rm(directory, { recursive: true, force: true })
      this.#executions.delete(handle.handleId)
      throw error
    }
    return structuredClone(handle)
  }

  async #reserveAdmission(handle: RuntimeExecutionHandle, fingerprint: string): Promise<void> {
    const directory = join(this.#dataDirectory, 'admissions')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = await open(join(directory, `${handle.attemptId}.json`), 'wx', 0o600).catch(
      (error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        ) {
          throw new RuntimeAdapterError({
            code: 'PI_START_RECONCILIATION_REQUIRED',
            classification: 'unknown',
            message: 'PI_START_RECONCILIATION_REQUIRED',
            retryable: false,
          })
        }
        throw error
      }
    )
    try {
      await file.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          commandDigest: createHash('sha256').update(fingerprint).digest('hex'),
        }),
        'utf8'
      )
      await file.sync()
    } finally {
      await file.close()
    }
    const parent = await open(directory, 'r')
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  }

  async *progress(handleInput: RuntimeExecutionHandle, afterSequence = 0, signal?: AbortSignal) {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    if (!this.#executions.has(handle.handleId)) {
      if (signal?.aborted) return
      for (const event of await readTerminalEvents(this.#dataDirectory, handle)) {
        if (signal?.aborted) return
        if (event.sequence > afterSequence) yield event
      }
      return
    }
    const execution = this.#require(handleInput)
    let cursor = afterSequence
    while (true) {
      if (execution.terminalFinalization) await execution.terminalFinalization
      if (execution.persistence) await execution.persistence
      for (const event of execution.events) {
        if (execution.terminalFinalization) await execution.terminalFinalization
        if (execution.persistence) await execution.persistence
        if (event.sequence <= cursor) continue
        cursor = event.sequence
        yield event
      }
      if (execution.state !== 'running') return
      await waitForEvent(execution, signal)
    }
  }

  async submitInput(handleInput: RuntimeExecutionHandle, requestInput: unknown) {
    const execution = this.#require(handleInput)
    const request = RuntimeInputRequestSchema.parse(requestInput)
    if (execution.state !== 'running') return this.#status(execution)
    await execution.rpc.request({ type: 'steer', message: request.text }, this.#rpcTimeoutMs)
    return this.#status(execution)
  }

  async submitApproval(): Promise<never> {
    throw new Error('PI_APPROVAL_INTERACTION_UNSUPPORTED')
  }

  async cancel(handleInput: RuntimeExecutionHandle) {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    if (!this.#executions.has(handle.handleId)) {
      return readTerminalRecord(this.#dataDirectory, handle)
    }
    const execution = this.#require(handle)
    if (execution.state === 'running') {
      // A missing abort acknowledgement must not prevent bounded child stopping.
      await execution.rpc
        .request({ type: 'abort' }, Math.max(1, Math.min(this.#rpcTimeoutMs, CANCEL_STATS_WAIT_MS)))
        .catch(() => undefined)
      if (execution.state !== 'running') return this.#status(execution)
      execution.state = 'cancelled'
      appendEvent(execution, { kind: 'status', state: 'cancelled' }, this.#now())
      this.#beginTerminalFinalization(execution, { captureUsage: true })
      await execution.terminalFinalization
    }
    return this.#status(execution)
  }

  async status(handleInput: RuntimeExecutionHandle) {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const execution = this.#executions.get(handle.handleId)
    if (!execution) return readTerminalRecord(this.#dataDirectory, handle)
    return this.#status(this.#require(handle))
  }

  async reconcile(handleInput: RuntimeExecutionHandle) {
    return this.status(handleInput)
  }

  async session(): Promise<never> {
    throw new Error('PI_SESSION_OPERATION_UNSUPPORTED')
  }

  async cleanup(handleInput: RuntimeExecutionHandle): Promise<void> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    if (!this.#executions.has(handle.handleId)) {
      await readTerminalRecord(this.#dataDirectory, handle)
      return
    }
    const execution = this.#require(handleInput)
    if (execution.terminalFinalization) await execution.terminalFinalization
    await execution.rpc.stop()
    // Stopping a still-running process can create its failure receipt.
    if (execution.terminalFinalization) await execution.terminalFinalization
    if (execution.persistence) await execution.persistence
    await rm(execution.directory, { recursive: true, force: true })
    this.#executions.delete(execution.handle.handleId)
  }

  #observe(execution: ProcessExecution, event: Record<string, unknown>): void {
    if (execution.state !== 'running') return
    if (event['type'] === 'message_update') {
      const update = asRecord(event['assistantMessageEvent'])
      if (update?.['type'] === 'text_delta' && typeof update['delta'] === 'string') {
        const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(execution.output)
        if (remaining > 0) {
          const delta = truncateUtf8(update['delta'], remaining)
          execution.output += delta
          if (delta.length > 0) appendEvent(execution, { kind: 'output', text: delta }, this.#now())
        }
      }
      return
    }
    if (event['type'] === 'agent_end') {
      const messages = Array.isArray(event['messages']) ? event['messages'] : []
      const failed = messages.find((message) => {
        const value = asRecord(message)
        return value?.['role'] === 'assistant' && value['stopReason'] === 'error'
      })
      if (failed !== undefined) {
        const value = asRecord(failed)
        execution.error = new Error(
          typeof value?.['errorMessage'] === 'string' ? value['errorMessage'] : 'PI_RUNTIME_ERROR'
        )
      }
      return
    }
    if (event['type'] === 'agent_settled' && execution.state === 'running') {
      void this.#settle(execution)
    }
  }

  async #settle(execution: ProcessExecution): Promise<void> {
    const [textResult, statsResult] = await Promise.allSettled([
      execution.rpc.request({ type: 'get_last_assistant_text' }, this.#rpcTimeoutMs),
      this.#requestFinalUsage(execution, this.#rpcTimeoutMs),
    ])
    if (execution.state !== 'running') return

    if (textResult.status === 'fulfilled') {
      const textData = asRecord(textResult.value['data'])
      const output = typeof textData?.['text'] === 'string' ? textData['text'] : execution.output
      execution.output = truncateUtf8(output, MAX_OUTPUT_BYTES)
    } else if (execution.error === undefined) {
      execution.error = asError(textResult.reason)
    }

    const finalUsage = statsResult.status === 'fulfilled' ? statsResult.value : undefined
    if (finalUsage !== undefined) execution.finalUsage = finalUsage
    else if (execution.error === undefined) execution.error = new Error('PI_SESSION_STATS_INVALID')

    if (execution.error !== undefined) {
      execution.state = 'errored'
      appendEvent(execution, { kind: 'status', state: 'errored' }, this.#now())
    } else {
      // A successful result is impossible without a validated final stats snapshot.
      if (execution.finalUsage === undefined) {
        execution.state = 'errored'
        execution.error = new Error('PI_SESSION_STATS_INVALID')
        appendEvent(execution, { kind: 'status', state: 'errored' }, this.#now())
        this.#beginTerminalFinalization(execution)
        return
      }
      execution.state = 'succeeded'
      appendEvent(
        execution,
        {
          kind: 'usage',
          inputTokens: execution.finalUsage.inputTokens,
          outputTokens: execution.finalUsage.outputTokens,
          durationMs: execution.finalUsage.durationMs,
        },
        this.#now()
      )
      appendEvent(execution, { kind: 'status', state: 'succeeded' }, this.#now())
    }
    this.#beginTerminalFinalization(execution)
  }

  #requestFinalUsage(
    execution: ProcessExecution,
    timeoutMs: number
  ): Promise<RuntimeUsage | undefined> {
    if (execution.finalUsage !== undefined) return Promise.resolve(execution.finalUsage)
    if (execution.statsSnapshot !== undefined) return execution.statsSnapshot

    const request = execution.rpc
      .request({ type: 'get_session_stats' }, timeoutMs)
      .then((response) => {
        const usage = parseFinalUsage(response, execution.startedAtMs, this.#now().getTime())
        // Retain a validated observation only while the execution is still mutable.
        // Cancellation applies its own bounded snapshot before publishing the terminal record.
        if (usage !== undefined && execution.state === 'running') execution.finalUsage = usage
        return usage
      })
      .catch(() => undefined)
    execution.statsSnapshot = request
    return request
  }

  #armDeadline(execution: ProcessExecution, maximumMs: number): void {
    const expiresAt = performance.now() + maximumMs
    const check = () => {
      if (execution.state !== 'running') return
      const remaining = expiresAt - performance.now()
      if (remaining > 0) {
        // Node timers overflow above this value; long limits use bounded chunks.
        execution.deadlineTimer = setTimeout(check, Math.min(remaining, 2_147_483_647))
        return
      }
      execution.state = 'timed_out'
      appendEvent(execution, { kind: 'status', state: 'timed_out' }, this.#now())
      this.#beginTerminalFinalization(execution, { captureUsage: true, abort: true })
    }
    check()
  }

  #beginTerminalFinalization(
    execution: ProcessExecution,
    options: { captureUsage?: boolean; abort?: boolean } = {}
  ): void {
    if (execution.deadlineTimer !== undefined) clearTimeout(execution.deadlineTimer)
    delete execution.deadlineTimer
    execution.terminalFinalization = this.#finalizeTerminal(execution, options)
    // The same rejection is surfaced by status/progress/cleanup consumers.
    void execution.terminalFinalization.catch(() => undefined)
  }

  async #finalizeTerminal(
    execution: ProcessExecution,
    options: { captureUsage?: boolean; abort?: boolean }
  ): Promise<void> {
    const waitMs = Math.max(1, Math.min(this.#rpcTimeoutMs, CANCEL_STATS_WAIT_MS))
    if (options.abort) {
      await execution.rpc.request({ type: 'abort' }, waitMs).catch(() => undefined)
    }
    if (options.captureUsage) {
      const finalUsage = await waitWithin(this.#requestFinalUsage(execution, waitMs), waitMs)
      if (finalUsage !== undefined) execution.finalUsage = finalUsage
    }
    // Publish the durable terminal receipt only after the owned child is reaped.
    // Unconfirmed stopping retains admission and working state for reconciliation.
    await execution.rpc.stop()
    this.#persist(execution)
    if (execution.persistence) await execution.persistence
  }

  #fail(execution: ProcessExecution, error: Error): void {
    if (execution.state !== 'running') return
    execution.error = error
    execution.state = 'errored'
    appendEvent(execution, { kind: 'status', state: 'errored' }, this.#now())
    this.#beginTerminalFinalization(execution)
  }

  #persist(execution: ProcessExecution): void {
    execution.persistence = persistTerminalRecord(
      this.#dataDirectory,
      execution.handle,
      this.#snapshot(execution),
      execution.events
    )
    // Consumers await this same rejection; avoid an unhandled rejection before they poll.
    void execution.persistence.catch(() => undefined)
  }

  async #status(execution: ProcessExecution) {
    if (execution.terminalFinalization) await execution.terminalFinalization
    if (execution.persistence) await execution.persistence
    return this.#snapshot(execution)
  }

  #snapshot(execution: ProcessExecution) {
    const observedAt = this.#now().toISOString()
    if (execution.state === 'succeeded') {
      if (execution.finalUsage === undefined) throw new Error('PI_SESSION_STATS_INVALID')
      return {
        state: 'succeeded' as const,
        observedAt,
        result: {
          output: { text: execution.output },
          usage: execution.finalUsage,
          artifacts: [],
        },
      }
    }
    if (execution.state === 'errored' || execution.state === 'timed_out') {
      const timedOut = execution.state === 'timed_out'
      return {
        state: execution.state,
        observedAt,
        error: {
          code: timedOut ? 'PI_EXECUTION_TIMED_OUT' : 'PI_RUNTIME_ERROR',
          classification: timedOut ? ('timeout' as const) : ('runtime' as const),
          message: timedOut
            ? 'Managed Pi execution duration exceeded'
            : 'Managed Pi runtime failed',
          retryable: false,
        },
        ...(execution.finalUsage === undefined ? {} : { terminalUsage: execution.finalUsage }),
      }
    }
    if (execution.state === 'cancelled') {
      return {
        state: execution.state,
        observedAt,
        ...(execution.finalUsage === undefined ? {} : { terminalUsage: execution.finalUsage }),
      }
    }
    return { state: execution.state, observedAt }
  }

  #require(handleInput: RuntimeExecutionHandle): ProcessExecution {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const execution = this.#executions.get(handle.handleId)
    if (execution === undefined || execution.handle.attemptId !== handle.attemptId) {
      throw new Error('MANAGED_PI_EXECUTION_MISSING')
    }
    return execution
  }
}

/**
 * Pi RPC framing for the shared process link: simple `{ type, id, success }`
 * records. Non-JSON output tolerantly rejects outstanding requests, and every
 * non-response record is an execution event.
 */
const PiRpcCodec: ProcessRpcFrameCodec<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
> = {
  encode: (command, id) => JSON.stringify({ ...command, id }),
  decode: (line) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      // Stray non-JSON output rejects outstanding requests without killing the runtime.
      throw new ProcessRpcDecodeError('PI_RPC_INVALID_JSON', false)
    }
    const record = asRecord(value)
    if (record === undefined) return null
    if (record['type'] === 'response' && typeof record['id'] === 'string') {
      if (record['success'] === true) {
        return { kind: 'response', id: record['id'], result: record }
      }
      return { kind: 'response', id: record['id'], error: new Error('PI_RPC_REJECTED') }
    }
    return { kind: 'unmatched', message: record }
  },
}

class PiRpcProcess {
  readonly #args: readonly string[]
  readonly #cwd: string
  readonly #environment: Readonly<Record<string, string>>
  readonly #executablePath: string
  readonly #spawnPolicy: NodeProcessSpawnPolicy | undefined
  readonly #listeners = new Set<(event: Record<string, unknown>) => void>()
  readonly #exitListeners = new Set<(error: Error) => void>()
  #link:
    | ProcessRpcLink<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
    | undefined
  #counter = 0

  constructor(options: {
    executablePath: string
    args: readonly string[]
    cwd: string
    environment: Readonly<Record<string, string>>
    spawnPolicy?: NodeProcessSpawnPolicy
  }) {
    this.#executablePath = options.executablePath
    this.#args = options.args
    this.#cwd = options.cwd
    this.#environment = options.environment
    this.#spawnPolicy = options.spawnPolicy
  }

  onEvent(listener: (event: Record<string, unknown>) => void): void {
    this.#listeners.add(listener)
  }

  onExit(listener: (error: Error) => void): void {
    this.#exitListeners.add(listener)
  }

  async start(): Promise<void> {
    if (this.#link !== undefined) throw new Error('PI_RPC_ALREADY_STARTED')
    if (this.#spawnPolicy !== undefined) {
      await enforceNodeProcessSpawnPolicy(this.#spawnPolicy, {
        executable: this.#executablePath,
        args: this.#args,
        environment: this.#environment,
        cwd: this.#cwd,
      })
    }
    const child = spawn(this.#executablePath, [...this.#args], {
      cwd: this.#cwd,
      env: { ...this.#environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#link = new ProcessRpcLink({
      child,
      codec: PiRpcCodec,
      maxFrameBytes: MAX_RPC_FRAME_BYTES,
      formatFrameError: () => new Error('PI_RPC_FRAME_TOO_LARGE'),
      formatExitError: ({ code, signal }) =>
        new Error(`PI_RPC_EXITED:${code === null ? 'signal' : String(code)}:${signal ?? 'none'}`),
      formatTimeoutError: (command) => new Error(`PI_RPC_TIMEOUT:${String(command['type'])}`),
      notRunningError: () => new Error('PI_RPC_NOT_RUNNING'),
      onLine: (event) => {
        for (const listener of this.#listeners) listener(event)
      },
      onExit: (error) => {
        for (const listener of this.#exitListeners) listener(error)
      },
      signalStrategy: 'child',
      protocolFailureSignal: 'SIGKILL',
      strictUtf8: false,
      stripCarriageReturn: true,
      skipEmptyLines: true,
      exitIsPermanentFailure: false,
      writeFailureRejectsPending: true,
    })
  }

  request(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const link = this.#link
    if (link === undefined) return Promise.reject(new Error('PI_RPC_NOT_RUNNING'))
    const id = `control-plane-${++this.#counter}`
    return link.request(command, { id, timeoutMs })
  }

  async stop(): Promise<void> {
    const stopped = await this.#link?.stop({ graceMs: 2_000, finalWaitMs: 1_000 })
    if (stopped === false) throw new Error('PI_PROCESS_STOP_UNCONFIRMED')
  }
}

function invocationContext(
  command: Parameters<ManagedPiClient['start']>[0],
  configuration: ReturnType<typeof ManagedPiConfigurationSchema.parse>
): ManagedPiProcessInvocationContext {
  const parsed =
    command.attemptBudget === undefined
      ? undefined
      : RuntimeAttemptBudgetAuthoritySchema.safeParse(command.attemptBudget)
  if (parsed !== undefined && !parsed.success) {
    throw new Error('PI_ATTEMPT_ALLOCATION_MISMATCH')
  }
  const budget = parsed?.data
  if (
    budget !== undefined &&
    (budget.executionId !== command.executionId ||
      budget.attemptId !== command.attemptId ||
      budget.executionPlanId !== configuration.executionPlanId ||
      budget.executionPlanDigest !== configuration.executionPlanDigest ||
      budget.reservationKey !== `runtime-attempt:${command.attemptId}` ||
      budget.currency !== configuration.limits.budget.currency ||
      budget.maximumMicrounits > configuration.limits.budget.maximumMicrounits ||
      budget.maximumTokens > configuration.limits.tokens.maximumTotal)
  ) {
    throw new Error('PI_ATTEMPT_ALLOCATION_MISMATCH')
  }
  return Object.freeze({
    attemptId: command.attemptId,
    ...(command.executionId === undefined ? {} : { executionId: command.executionId }),
    ...(budget === undefined ? {} : { attemptBudget: budget }),
  })
}

async function inspectVersion(
  executablePath: string,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number
): Promise<string> {
  const child = spawn(executablePath, ['--version'], {
    env: { ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  let outputExceeded = false
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (Buffer.byteLength(stdout) > MAX_VERSION_OUTPUT_BYTES) {
      outputExceeded = true
      child.kill('SIGKILL')
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (Buffer.byteLength(stderr) > MAX_VERSION_OUTPUT_BYTES) {
      outputExceeded = true
      child.kill('SIGKILL')
    }
  })
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        rejectPromise(new Error('PI_VERSION_TIMEOUT'))
      }, timeoutMs)
      timeout.unref()
      child.once('error', rejectPromise)
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        resolvePromise({ code, signal })
      })
    }
  )
  if (outputExceeded) throw new Error('PI_VERSION_OUTPUT_TOO_LARGE')
  if (exit.code !== 0) throw new Error(`PI_VERSION_FAILED:${boundedValue(stderr)}`)
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(stdout.trim())
  if (match?.[1] === undefined) throw new Error('PI_VERSION_INVALID')
  return match[1]
}

function appendEvent(execution: ProcessExecution, input: EventInput, now: Date): void {
  execution.events.push({
    sequence: execution.events.length + 1,
    occurredAt: now.toISOString(),
    ...input,
  })
  for (const waiter of execution.waiters) waiter()
  execution.waiters.clear()
}

type EventInput = ManagedPiEvent extends infer Event
  ? Event extends ManagedPiEvent
    ? Omit<Event, 'sequence' | 'occurredAt'>
    : never
  : never

function waitForEvent(execution: ProcessExecution, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  return new Promise((resolvePromise, rejectPromise) => {
    const ready = () => {
      signal?.removeEventListener('abort', aborted)
      resolvePromise()
    }
    const aborted = () => {
      execution.waiters.delete(ready)
      rejectPromise(signal?.reason)
    }
    execution.waiters.add(ready)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseFinalUsage(
  response: Record<string, unknown>,
  startedAtMs: number,
  observedAtMs: number
): RuntimeUsage | undefined {
  if (
    response['type'] !== 'response' ||
    response['command'] !== 'get_session_stats' ||
    response['success'] !== true
  )
    return undefined
  const data = asRecord(response['data'])
  const tokens = asRecord(data?.['tokens'])
  const inputTokens = tokens?.['input']
  const outputTokens = tokens?.['output']
  const durationMs = observedAtMs - startedAtMs
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0
  )
    return undefined
  const parsed = RuntimeUsageSchema.safeParse({ inputTokens, outputTokens, durationMs })
  return parsed.success ? parsed.data : undefined
}

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function boundedValue(value: unknown): string {
  return truncateUtf8(typeof value === 'string' ? value : JSON.stringify(value), 1_024)
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.length <= maximumBytes) return value
  return bytes
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '')
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function errorCode(value: unknown): string {
  const message = asError(value).message
  return /^[A-Z][A-Z0-9_]*$/.test(message) ? message : 'PROCESS_ERROR'
}
