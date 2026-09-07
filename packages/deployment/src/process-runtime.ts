import { spawn, type ChildProcess } from 'node:child_process'
import type { ProcessHandle, ProcessLaunchRequest, ProcessRuntimeProvider } from './index.js'

export interface NodeProcessRuntimeProviderOptions {
  readonly inheritedEnvironment?: readonly string[]
  readonly stopTimeoutMs?: number
}

export class NodeProcessRuntimeProvider implements ProcessRuntimeProvider {
  readonly #inheritedEnvironment: readonly string[]
  readonly #stopTimeoutMs: number

  constructor(options: NodeProcessRuntimeProviderOptions = {}) {
    this.#inheritedEnvironment = options.inheritedEnvironment ?? ['PATH', 'TMPDIR']
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 20_000
  }

  async launch(request: ProcessLaunchRequest): Promise<ProcessHandle> {
    if (
      request.executable.length === 0 ||
      request.args.some((argument) => argument.includes('\0'))
    ) {
      throw new ProcessRuntimeError('PROCESS_LAUNCH_INVALID')
    }
    const environment: Record<string, string> = {}
    for (const name of this.#inheritedEnvironment) {
      const value = process.env[name]
      if (value !== undefined) environment[name] = value
    }
    Object.assign(environment, request.environment)
    const child = spawn(request.executable, request.args, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: environment,
      shell: false,
      stdio: 'ignore',
    })
    await waitForSpawn(child)
    return new NodeProcessHandle(child, this.#stopTimeoutMs)
  }
}

export type ProcessRuntimeErrorCode =
  | 'PROCESS_LAUNCH_INVALID'
  | 'PROCESS_LAUNCH_FAILED'
  | 'PROCESS_STOP_TIMEOUT'

export class ProcessRuntimeError extends Error {
  constructor(readonly code: ProcessRuntimeErrorCode) {
    super('Managed process operation failed')
    this.name = 'ProcessRuntimeError'
  }
}

class NodeProcessHandle implements ProcessHandle {
  readonly pid: number
  readonly startedAt = new Date().toISOString()
  readonly #child: ChildProcess
  readonly #stopTimeoutMs: number
  readonly #exit: Promise<number>

  constructor(child: ChildProcess, stopTimeoutMs: number) {
    if (child.pid === undefined) throw new ProcessRuntimeError('PROCESS_LAUNCH_FAILED')
    this.pid = child.pid
    this.#child = child
    this.#stopTimeoutMs = stopTimeoutMs
    this.#exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)))
    })
  }

  wait(): Promise<number> {
    if (this.#child.exitCode !== null) return Promise.resolve(this.#child.exitCode)
    return this.#exit
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.#child.exitCode !== null) return
    this.#child.kill(signal)
    const stopped = await Promise.race([
      this.wait().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), this.#stopTimeoutMs)),
    ])
    if (!stopped) throw new ProcessRuntimeError('PROCESS_STOP_TIMEOUT')
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new ProcessRuntimeError('PROCESS_LAUNCH_FAILED')))
  })
}
