import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  RuntimeAdapterError,
  RuntimeExecutionHandleSchema,
  RuntimeInputRequestSchema,
  type RuntimeExecutionHandle,
} from '@control-plane/runtime-sdk'
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

export interface ManagedPiProcessInvocation {
  readonly systemPrompt: string
  readonly prompt: string
  readonly provider: string
  readonly model: string
}

export interface ManagedPiProcessInputResolver {
  resolve(
    configuration: ReturnType<typeof ManagedPiConfigurationSchema.parse>
  ): Promise<ManagedPiProcessInvocation>
}

export interface ManagedPiProcessClientOptions {
  readonly executablePath: string
  readonly dataDirectory: string
  readonly inputResolver: ManagedPiProcessInputResolver
  readonly environment?: Readonly<Record<string, string>>
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
  state: 'running' | 'succeeded' | 'errored' | 'cancelled'
  output: string
  inputTokens: number
  outputTokens: number
  durationMs: number
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

  constructor(options: ManagedPiProcessClientOptions) {
    this.#executablePath = options.executablePath
    this.#dataDirectory = resolve(options.dataDirectory)
    this.#inputResolver = options.inputResolver
    this.#environment = options.environment ?? {}
    this.#now = options.now ?? (() => new Date())
    this.#rpcTimeoutMs = options.rpcTimeoutMs ?? 15_000
  }

  async inspect() {
    try {
      const runtimeVersion = await inspectVersion(
        this.#executablePath,
        this.#environment,
        this.#rpcTimeoutMs
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
    const configuration = ManagedPiConfigurationSchema.parse(commandInput.configuration)
    const handle = RuntimeExecutionHandleSchema.parse({
      handleId: `managed-pi:${commandInput.attemptId}`,
      attemptId: commandInput.attemptId,
      startedAt: this.#now().toISOString(),
    })
    if (
      typeof commandInput.idempotencyKey !== 'string' ||
      commandInput.idempotencyKey.length < 1 ||
      commandInput.idempotencyKey.length > 256
    )
      throw new Error('PI_START_INVALID_IDEMPOTENCY_KEY')
    const fingerprint = JSON.stringify(
      { idempotencyKey: commandInput.idempotencyKey, configuration },
      (_key, value: unknown) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(
            Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
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
    const result = this.#startProcess(handle, configuration, fingerprint)
    // Retain rejected admissions as well: failure does not establish absence of native effects.
    this.#admissions.set(handle.handleId, { fingerprint, result })
    return structuredClone(await result)
  }

  async #startProcess(
    handle: RuntimeExecutionHandle,
    configuration: ReturnType<typeof ManagedPiConfigurationSchema.parse>,
    fingerprint: string
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
    const invocation = await this.#inputResolver.resolve(configuration)
    const directory = join(this.#dataDirectory, handle.attemptId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const systemPromptPath = join(directory, 'system-prompt.md')
    await writeFile(systemPromptPath, invocation.systemPrompt, { encoding: 'utf8', mode: 0o600 })
    await chmod(systemPromptPath, 0o600)

    const rpc = new PiRpcProcess({
      executablePath: this.#executablePath,
      cwd: directory,
      environment: this.#environment,
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
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    }
    this.#executions.set(handle.handleId, execution)
    appendEvent(execution, { kind: 'status', state: 'running' }, this.#now())
    rpc.onEvent((event) => this.#observe(execution, event))
    rpc.onExit((error) => this.#fail(execution, error))
    try {
      await rpc.start()
      await rpc.request({ type: 'get_state' }, this.#rpcTimeoutMs)
      await rpc.request({ type: 'prompt', message: invocation.prompt }, this.#rpcTimeoutMs)
    } catch (error) {
      this.#fail(execution, asError(error))
      await rpc.stop().catch(() => undefined)
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
      if (execution.persistence) await execution.persistence
      for (const event of execution.events) {
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
      await execution.rpc.request({ type: 'abort' }, this.#rpcTimeoutMs)
      if (execution.state !== 'running') return this.#status(execution)
      execution.state = 'cancelled'
      execution.durationMs = Math.max(0, this.#now().getTime() - execution.startedAtMs)
      appendEvent(execution, { kind: 'status', state: 'cancelled' }, this.#now())
      this.#persist(execution)
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
    await execution.rpc.stop()
    try {
      if (execution.persistence) await execution.persistence
    } finally {
      await rm(execution.directory, { recursive: true, force: true })
      this.#executions.delete(execution.handle.handleId)
    }
  }

  #observe(execution: ProcessExecution, event: Record<string, unknown>): void {
    if (execution.state !== 'running') return
    if (event['type'] === 'message_update') {
      const update = asRecord(event['assistantMessageEvent'])
      const usage = asRecord(event['usage'])
      execution.inputTokens = nonnegativeInteger(usage?.['input'])
      execution.outputTokens = nonnegativeInteger(usage?.['output'])
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
    try {
      const [textResponse, statsResponse] = await Promise.all([
        execution.rpc.request({ type: 'get_last_assistant_text' }, this.#rpcTimeoutMs),
        execution.rpc.request({ type: 'get_session_stats' }, this.#rpcTimeoutMs),
      ])
      if (execution.state !== 'running') return
      const textData = asRecord(textResponse['data'])
      const statsData = asRecord(statsResponse['data'])
      const tokens = asRecord(statsData?.['tokens'])
      const output = typeof textData?.['text'] === 'string' ? textData['text'] : execution.output
      execution.output = truncateUtf8(output, MAX_OUTPUT_BYTES)
      execution.inputTokens = nonnegativeInteger(tokens?.['input'])
      execution.outputTokens = nonnegativeInteger(tokens?.['output'])
      execution.durationMs = Math.max(0, this.#now().getTime() - execution.startedAtMs)
      if (execution.error !== undefined) {
        execution.state = 'errored'
        appendEvent(execution, { kind: 'status', state: 'errored' }, this.#now())
      } else {
        execution.state = 'succeeded'
        appendEvent(
          execution,
          {
            kind: 'usage',
            inputTokens: execution.inputTokens,
            outputTokens: execution.outputTokens,
            durationMs: execution.durationMs,
          },
          this.#now()
        )
        appendEvent(execution, { kind: 'status', state: 'succeeded' }, this.#now())
      }
      this.#persist(execution)
    } catch (error) {
      this.#fail(execution, asError(error))
    }
  }

  #fail(execution: ProcessExecution, error: Error): void {
    if (execution.state !== 'running') return
    execution.error = error
    execution.state = 'errored'
    execution.durationMs = Math.max(0, this.#now().getTime() - execution.startedAtMs)
    appendEvent(execution, { kind: 'status', state: 'errored' }, this.#now())
    this.#persist(execution)
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
    if (execution.persistence) await execution.persistence
    return this.#snapshot(execution)
  }

  #snapshot(execution: ProcessExecution) {
    const observedAt = this.#now().toISOString()
    if (execution.state === 'succeeded') {
      return {
        state: 'succeeded' as const,
        observedAt,
        result: {
          output: { text: execution.output },
          usage: {
            inputTokens: execution.inputTokens,
            outputTokens: execution.outputTokens,
            durationMs: execution.durationMs,
          },
          artifacts: [],
        },
      }
    }
    if (execution.state === 'errored') {
      return {
        state: 'errored' as const,
        observedAt,
        error: {
          code: 'PI_RUNTIME_ERROR',
          classification: 'runtime' as const,
          message: 'Managed Pi runtime failed',
          retryable: false,
        },
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

class PiRpcProcess {
  readonly #args: readonly string[]
  readonly #cwd: string
  readonly #environment: Readonly<Record<string, string>>
  readonly #executablePath: string
  readonly #listeners = new Set<(event: Record<string, unknown>) => void>()
  readonly #exitListeners = new Set<(error: Error) => void>()
  readonly #pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >()
  #child: ChildProcessWithoutNullStreams | undefined
  #counter = 0
  #stdout = ''

  constructor(options: {
    executablePath: string
    args: readonly string[]
    cwd: string
    environment: Readonly<Record<string, string>>
  }) {
    this.#executablePath = options.executablePath
    this.#args = options.args
    this.#cwd = options.cwd
    this.#environment = options.environment
  }

  onEvent(listener: (event: Record<string, unknown>) => void): void {
    this.#listeners.add(listener)
  }

  onExit(listener: (error: Error) => void): void {
    this.#exitListeners.add(listener)
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error('PI_RPC_ALREADY_STARTED')
    const child = spawn(this.#executablePath, [...this.#args], {
      cwd: this.#cwd,
      env: { ...this.#environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.#read(chunk))
    child.stderr.resume()
    child.once('error', (error) => this.#exited(error))
    child.once('exit', (code, signal) => {
      this.#child = undefined
      this.#exited(
        new Error(`PI_RPC_EXITED:${code === null ? 'signal' : String(code)}:${signal ?? 'none'}`)
      )
    })
  }

  request(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const child = this.#child
    if (child === undefined) return Promise.reject(new Error('PI_RPC_NOT_RUNNING'))
    const id = `control-plane-${++this.#counter}`
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        rejectPromise(new Error(`PI_RPC_TIMEOUT:${String(command['type'])}`))
      }, timeoutMs)
      timeout.unref()
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolvePromise(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          rejectPromise(error)
        },
      })
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error === null || error === undefined) return
        this.#pending.delete(id)
        clearTimeout(timeout)
        rejectPromise(error)
      })
    })
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (child === undefined) return
    this.#child = undefined
    child.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise()
      }, 2_000)
      timeout.unref()
      child.once('exit', () => {
        clearTimeout(timeout)
        resolvePromise()
      })
    })
  }

  #read(chunk: string): void {
    this.#stdout += chunk
    let newline = this.#stdout.indexOf('\n')
    while (newline >= 0) {
      const line = this.#stdout.slice(0, newline).replace(/\r$/, '')
      this.#stdout = this.#stdout.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_RPC_FRAME_BYTES) {
        this.#protocolFailure(new Error('PI_RPC_FRAME_TOO_LARGE'))
        return
      }
      if (line.length > 0) this.#line(line)
      newline = this.#stdout.indexOf('\n')
    }
    if (Buffer.byteLength(this.#stdout) > MAX_RPC_FRAME_BYTES) {
      this.#protocolFailure(new Error('PI_RPC_FRAME_TOO_LARGE'))
    }
  }

  #line(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.#rejectAll(new Error('PI_RPC_INVALID_JSON'))
      return
    }
    const record = asRecord(value)
    if (record === undefined) return
    if (record['type'] === 'response' && typeof record['id'] === 'string') {
      const pending = this.#pending.get(record['id'])
      if (pending === undefined) return
      this.#pending.delete(record['id'])
      if (record['success'] === true) pending.resolve(record)
      else pending.reject(new Error('PI_RPC_REJECTED'))
      return
    }
    for (const listener of this.#listeners) listener(record)
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #exited(error: Error): void {
    this.#rejectAll(error)
    for (const listener of this.#exitListeners) listener(error)
  }

  #protocolFailure(error: Error): void {
    this.#stdout = ''
    this.#exited(error)
    this.#child?.kill('SIGKILL')
  }
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

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
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
