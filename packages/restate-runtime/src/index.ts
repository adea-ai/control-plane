import { execFile } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  DeploymentComponentHealth,
  ProcessHandle,
  ProcessRuntimeProvider,
  WorkflowRuntime,
} from '@control-plane/deployment'

export const RESTATE_SERVER_VERSION = '1.7.9'
const execFileAsync = promisify(execFile)

export type RestateRuntimeErrorCode =
  | 'RESTATE_BINARY_VERSION_MISMATCH'
  | 'RESTATE_ALREADY_RUNNING'
  | 'RESTATE_NOT_RUNNING'
  | 'RESTATE_READINESS_TIMEOUT'
  | 'RESTATE_PROCESS_EXITED'
  | 'RESTATE_DEPLOYMENT_REGISTRATION_FAILED'

export class RestateRuntimeError extends Error {
  constructor(readonly code: RestateRuntimeErrorCode) {
    super('Restate runtime operation failed')
    this.name = 'RestateRuntimeError'
  }
}

export interface LocalRestateRuntimeOptions {
  readonly executablePath: string
  readonly dataDirectory: string
  readonly processProvider: ProcessRuntimeProvider
  readonly profile?: 'local' | 'hosted-simple' | 'hosted-server'
  readonly adminUrl?: string
  readonly ingressUrl?: string
  readonly nodePort?: number
  readonly readinessTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly fetch?: typeof fetch
  readonly inspectVersion?: (executablePath: string) => Promise<string>
  readonly deploymentUri?: string
}

export interface RemoteRestateRuntimeOptions {
  readonly profile: 'hosted-server'
  readonly adminUrl: string
  readonly ingressUrl: string
  readonly deploymentUri: string
  readonly readinessTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly fetch?: typeof fetch
}

export class RemoteRestateRuntime implements WorkflowRuntime {
  readonly profile: 'hosted-server'
  readonly adminUrl: URL
  readonly ingressUrl: URL
  readonly #deploymentUri: URL
  readonly #readinessTimeoutMs: number
  readonly #pollIntervalMs: number
  readonly #fetch: typeof fetch
  #deploymentId: string | undefined

  constructor(options: RemoteRestateRuntimeOptions) {
    this.profile = options.profile
    this.adminUrl = privateHttpUrl(options.adminUrl)
    this.ingressUrl = privateHttpUrl(options.ingressUrl)
    this.#deploymentUri = privateHttpUrl(options.deploymentUri)
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000
    this.#pollIntervalMs = options.pollIntervalMs ?? 250
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async start(): Promise<void> {
    if (this.#deploymentId !== undefined) {
      throw new RestateRuntimeError('RESTATE_ALREADY_RUNNING')
    }
    await waitForRestate(this.adminUrl, this.#fetch, this.#readinessTimeoutMs, this.#pollIntervalMs)
    this.#deploymentId = await registerDeployment(this.adminUrl, this.#deploymentUri, this.#fetch)
  }

  async health(): Promise<DeploymentComponentHealth> {
    try {
      const response = await this.#fetch(new URL('/health', this.adminUrl), {
        signal: AbortSignal.timeout(2_000),
      })
      return {
        ready: response.ok && this.#deploymentId !== undefined,
        component: 'restate',
        version: RESTATE_SERVER_VERSION,
        details: {
          profile: this.profile,
          ...(this.#deploymentId === undefined ? {} : { deploymentId: this.#deploymentId }),
        },
      }
    } catch {
      return {
        ready: false,
        component: 'restate',
        version: RESTATE_SERVER_VERSION,
        details: { profile: this.profile },
      }
    }
  }

  stop(): Promise<void> {
    this.#deploymentId = undefined
    return Promise.resolve()
  }
}

export class LocalRestateRuntime implements WorkflowRuntime {
  readonly #nodePort: number
  readonly profile: 'local' | 'hosted-simple' | 'hosted-server'
  readonly adminUrl: URL
  readonly ingressUrl: URL
  readonly #executablePath: string
  readonly #dataDirectory: string
  readonly #processProvider: ProcessRuntimeProvider
  readonly #readinessTimeoutMs: number
  readonly #pollIntervalMs: number
  readonly #fetch: typeof fetch
  readonly #inspectVersion: (executablePath: string) => Promise<string>
  readonly #deploymentUri: URL | undefined
  #process: ProcessHandle | undefined
  #deploymentId: string | undefined

  constructor(options: LocalRestateRuntimeOptions) {
    this.#executablePath = resolve(options.executablePath)
    this.#dataDirectory = resolve(options.dataDirectory)
    this.#processProvider = options.processProvider
    this.profile = options.profile ?? 'local'
    this.adminUrl = loopbackUrl(options.adminUrl ?? 'http://127.0.0.1:9070')
    this.#nodePort = options.nodePort ?? 5122
    this.ingressUrl = loopbackUrl(options.ingressUrl ?? 'http://127.0.0.1:8080')
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000
    this.#pollIntervalMs = options.pollIntervalMs ?? 250
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#inspectVersion = options.inspectVersion ?? inspectRestateVersion
    this.#deploymentUri =
      options.deploymentUri === undefined ? undefined : loopbackUrl(options.deploymentUri)
  }

  async start(): Promise<void> {
    if (this.#process !== undefined) throw new RestateRuntimeError('RESTATE_ALREADY_RUNNING')
    const version = await this.#inspectVersion(this.#executablePath)
    if (version !== RESTATE_SERVER_VERSION) {
      throw new RestateRuntimeError('RESTATE_BINARY_VERSION_MISMATCH')
    }
    await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.#dataDirectory, 0o700)
    const process = await this.#processProvider.launch({
      executable: this.#executablePath,
      args: [],
      cwd: dirname(this.#dataDirectory),
      environment: {
        RESTATE_BASE_DIR: this.#dataDirectory,
        RESTATE_CLUSTER_NAME: `control-plane-${this.profile}`,
        RESTATE_NODE_NAME: `control-plane-${this.profile}-1`,
        RESTATE_AUTO_PROVISION: 'true',
        RESTATE_DISABLE_TELEMETRY: 'true',
        RESTATE_LISTEN_MODE: 'tcp',
        RESTATE_BIND_IP: '127.0.0.1',
        RESTATE_BIND_PORT: String(this.#nodePort),
        RESTATE_ADMIN__BIND_ADDRESS: hostPort(this.adminUrl),
        RESTATE_INGRESS__BIND_ADDRESS: hostPort(this.ingressUrl),
        RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: '256 MiB',
        RESTATE_ADMIN__QUERY_ENGINE__MEMORY_SIZE: '64 MiB',
        RESTATE_SHUTDOWN_TIMEOUT: '20s',
      },
    })
    this.#process = process
    const clearExitedProcess = () => {
      if (this.#process === process) this.#process = undefined
    }
    void process.wait().then(clearExitedProcess, clearExitedProcess)
    try {
      await this.#waitUntilReady()
      if (this.#process !== process) throw new RestateRuntimeError('RESTATE_PROCESS_EXITED')
      if (this.#deploymentUri !== undefined) await this.#registerDeployment(this.#deploymentUri)
    } catch (error) {
      await process.stop().catch(() => undefined)
      if (this.#process === process) this.#process = undefined
      throw error
    }
  }

  async health(): Promise<DeploymentComponentHealth> {
    const process = this.#process
    if (process === undefined) {
      return { ready: false, component: 'restate', version: RESTATE_SERVER_VERSION }
    }
    try {
      const response = await this.#fetch(new URL('/health', this.adminUrl), {
        signal: AbortSignal.timeout(2_000),
      })
      return {
        ready: response.ok && this.#process === process,
        component: 'restate',
        version: RESTATE_SERVER_VERSION,
        details: {
          profile: this.profile,
          pid: process.pid,
          ...(this.#deploymentId === undefined ? {} : { deploymentId: this.#deploymentId }),
        },
      }
    } catch {
      return {
        ready: false,
        component: 'restate',
        version: RESTATE_SERVER_VERSION,
        details: { profile: this.profile, pid: process.pid },
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#process === undefined) return
    const process = this.#process
    this.#process = undefined
    this.#deploymentId = undefined
    await process.stop('SIGTERM')
  }

  async #registerDeployment(uri: URL): Promise<void> {
    this.#deploymentId = await registerDeployment(this.adminUrl, uri, this.#fetch)
  }

  async #waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.#readinessTimeoutMs
    while (Date.now() <= deadline) {
      if (this.#process === undefined) throw new RestateRuntimeError('RESTATE_PROCESS_EXITED')
      if ((await this.health()).ready) return
      if (this.#process === undefined) throw new RestateRuntimeError('RESTATE_PROCESS_EXITED')
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.#pollIntervalMs))
    }
    throw new RestateRuntimeError('RESTATE_READINESS_TIMEOUT')
  }
}

async function registerDeployment(
  adminUrl: URL,
  deploymentUri: URL,
  fetchImplementation: typeof fetch
): Promise<string> {
  const response = await fetchImplementation(new URL('/deployments', adminUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: deploymentUri.toString(), force: false, use_http_11: true }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new RestateRuntimeError('RESTATE_DEPLOYMENT_REGISTRATION_FAILED')
  const body: unknown = await response.json()
  if (!isRegisteredWorkflowDeployment(body)) {
    throw new RestateRuntimeError('RESTATE_DEPLOYMENT_REGISTRATION_FAILED')
  }
  return body.id
}

async function waitForRestate(
  adminUrl: URL,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      const response = await fetchImplementation(new URL('/health', adminUrl), {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
    } catch {
      // Dependency ordering is advisory; tolerate Restate startup races until the deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs))
  }
  throw new RestateRuntimeError('RESTATE_READINESS_TIMEOUT')
}

async function inspectRestateVersion(executablePath: string): Promise<string> {
  const { stdout } = await execFileAsync(executablePath, ['--version'], {
    timeout: 5_000,
    maxBuffer: 4_096,
  })
  const match = stdout.match(/(?:restate-server\s+)?(\d+\.\d+\.\d+)/)
  if (match?.[1] === undefined) throw new RestateRuntimeError('RESTATE_BINARY_VERSION_MISMATCH')
  return match[1]
}

function loopbackUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new RestateRuntimeError('RESTATE_NOT_RUNNING')
  }
  return url
}

function privateHttpUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  ) {
    throw new RestateRuntimeError('RESTATE_NOT_RUNNING')
  }
  return url
}

function hostPort(url: URL): string {
  return `${url.hostname}:${url.port}`
}

function isRegisteredWorkflowDeployment(
  value: unknown
): value is { readonly id: string; readonly services: readonly { readonly name: string }[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { readonly id?: unknown; readonly services?: unknown }
  return (
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.services) &&
    candidate.services.some(
      (service) =>
        typeof service === 'object' &&
        service !== null &&
        (service as { readonly name?: unknown }).name === 'execution-lifecycle'
    )
  )
}
