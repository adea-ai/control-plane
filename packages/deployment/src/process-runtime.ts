import { spawn, type ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import process from 'node:process'
import type { ProcessHandle, ProcessLaunchRequest, ProcessRuntimeProvider } from './index.js'

/**
 * Bounded spawn policy for the managed runtime launch path (CP-RNODE-025): when a
 * constraint is set, launches that violate it are rejected before any process starts.
 * Absent constraints leave the corresponding dimension unconstrained.
 */
export interface NodeProcessSpawnPolicy {
  /** Executables allowed to launch, compared by resolved real path. */
  readonly allowedExecutables?: readonly string[]
  /** Working directories allowed for the child process, compared by resolved real path. */
  readonly allowedWorkingDirectories?: readonly string[]
  readonly maximumArguments?: number
  readonly maximumArgumentLength?: number
  readonly maximumEnvironmentVariables?: number
}

/** Launch request shape accepted by the shared spawn-policy guard. */
export interface SpawnPolicyCheckRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly environment?: Readonly<Record<string, string>>
  readonly cwd?: string
}

/**
 * Rejects launches that violate the policy before any process starts (CP-RNODE-025).
 * Executables and working directories are compared by resolved real path, so
 * symlinks cannot escape the allowlist. Bare executable names resolve against
 * the child environment's PATH (falling back to the parent process PATH) the
 * same way spawn would, so the guard and the spawn can never disagree.
 */
export async function enforceNodeProcessSpawnPolicy(
  policy: NodeProcessSpawnPolicy,
  request: SpawnPolicyCheckRequest
): Promise<void> {
  const maximumArguments = policy.maximumArguments
  if (maximumArguments !== undefined && request.args.length > maximumArguments) {
    throw new ProcessRuntimeError('PROCESS_LAUNCH_POLICY_VIOLATION')
  }
  const maximumArgumentLength = policy.maximumArgumentLength
  if (
    maximumArgumentLength !== undefined &&
    request.args.some((argument) => argument.length > maximumArgumentLength)
  ) {
    throw new ProcessRuntimeError('PROCESS_LAUNCH_POLICY_VIOLATION')
  }
  if (
    policy.maximumEnvironmentVariables !== undefined &&
    Object.keys(request.environment ?? {}).length > policy.maximumEnvironmentVariables
  ) {
    throw new ProcessRuntimeError('PROCESS_LAUNCH_POLICY_VIOLATION')
  }
  if (policy.allowedExecutables !== undefined) {
    const executableReal = await resolveExecutableReal(request).catch(() => undefined)
    const allowed = await Promise.all(
      policy.allowedExecutables.map((candidate) => realpath(candidate).catch(() => undefined))
    )
    if (executableReal === undefined || !allowed.includes(executableReal)) {
      throw new ProcessRuntimeError('PROCESS_LAUNCH_POLICY_VIOLATION')
    }
  }
  if (
    policy.allowedWorkingDirectories !== undefined &&
    (request.cwd === undefined || !isAbsolute(request.cwd))
  ) {
    throw new ProcessRuntimeError('PROCESS_LAUNCH_POLICY_VIOLATION')
  }
  if (request.cwd !== undefined && policy.allowedWorkingDirectories !== undefined) {
    const cwdReal = await realpath(request.cwd).catch(() => undefined)
    const contained = await Promise.all(
      policy.allowedWorkingDirectories.map(async (directory) => {
        const directoryReal = await realpath(directory).catch(() => undefined)
        return (
          cwdReal !== undefined &&
          directoryReal !== undefined &&
          (cwdReal === directoryReal || cwdReal.startsWith(`${directoryReal}/`))
        )
      })
    )
    if (!contained.some(Boolean)) throw new ProcessRuntimeError('PROCESS_LAUNCH_POLICY_VIOLATION')
  }
}

async function resolveExecutableReal(request: SpawnPolicyCheckRequest): Promise<string> {
  if (isAbsolute(request.executable)) return realpath(request.executable)
  const searchPath =
    request.environment?.['PATH'] ?? process.env['PATH'] ?? process.env['Path'] ?? undefined
  if (searchPath === undefined) throw new Error('PROCESS_EXECUTABLE_UNRESOLVABLE')
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, request.executable)
    if (
      await realpath(candidate)
        .then(() => true)
        .catch(() => false)
    ) {
      return realpath(candidate)
    }
  }
  throw new Error('PROCESS_EXECUTABLE_UNRESOLVABLE')
}

export interface NodeProcessRuntimeProviderOptions {
  readonly inheritedEnvironment?: readonly string[]
  readonly stopTimeoutMs?: number
  readonly spawnPolicy?: NodeProcessSpawnPolicy
}

export class NodeProcessRuntimeProvider implements ProcessRuntimeProvider {
  readonly #inheritedEnvironment: readonly string[]
  readonly #stopTimeoutMs: number
  readonly #spawnPolicy: NodeProcessSpawnPolicy | undefined

  constructor(options: NodeProcessRuntimeProviderOptions = {}) {
    this.#inheritedEnvironment = options.inheritedEnvironment ?? ['PATH', 'TMPDIR']
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 20_000
    this.#spawnPolicy = options.spawnPolicy
    const policy = this.#spawnPolicy
    if (
      policy &&
      ((policy.maximumArguments !== undefined &&
        (!Number.isSafeInteger(policy.maximumArguments) || policy.maximumArguments < 1)) ||
        (policy.maximumArgumentLength !== undefined &&
          (!Number.isSafeInteger(policy.maximumArgumentLength) ||
            policy.maximumArgumentLength < 1)) ||
        (policy.maximumEnvironmentVariables !== undefined &&
          (!Number.isSafeInteger(policy.maximumEnvironmentVariables) ||
            policy.maximumEnvironmentVariables < 1)))
    ) {
      throw new ProcessRuntimeError('PROCESS_LAUNCH_INVALID')
    }
  }

  async #enforceSpawnPolicy(request: ProcessLaunchRequest): Promise<void> {
    if (this.#spawnPolicy === undefined) return
    await enforceNodeProcessSpawnPolicy(this.#spawnPolicy, {
      executable: request.executable,
      args: request.args,
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
  }

  async launch(request: ProcessLaunchRequest): Promise<ProcessHandle> {
    if (
      request.executable.length === 0 ||
      request.args.some((argument) => argument.includes('\0'))
    ) {
      throw new ProcessRuntimeError('PROCESS_LAUNCH_INVALID')
    }
    await this.#enforceSpawnPolicy(request)
    const environment: Record<string, string> = {}
    for (const name of this.#inheritedEnvironment) {
      const value = process.env[name]
      if (value !== undefined) environment[name] = value
    }
    Object.assign(environment, request.environment)
    const child = spawn(request.executable, request.args, {
      ...(request.environment === undefined ? {} : { environment: request.environment }),
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
  | 'PROCESS_LAUNCH_POLICY_VIOLATION'
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
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const stopped = await Promise.race([
        this.wait().then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), this.#stopTimeoutMs)
        }),
      ])
      if (!stopped) throw new ProcessRuntimeError('PROCESS_STOP_TIMEOUT')
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new ProcessRuntimeError('PROCESS_LAUNCH_FAILED')))
  })
}
