import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type {
  DeploymentComponentHealth,
  SecretLease,
  SecretReference,
  SecretsProvider,
  SecretUse,
} from '@control-plane/deployment'

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/
const MAX_SECRET_BYTES = 64 * 1024

export type SecretsProviderErrorCode =
  | 'SECRET_PROVIDER_UNSUPPORTED'
  | 'SECRET_REFERENCE_INVALID'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_FILE_UNSAFE'
  | 'SECRET_VALUE_INVALID'
  | 'SECRET_PROVIDER_CLOSED'

export class SecretsProviderError extends Error {
  constructor(readonly code: SecretsProviderErrorCode) {
    super('Secret resolution failed')
    this.name = 'SecretsProviderError'
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { name: this.name, message: this.message, code: this.code }
  }
}

export class CompositeSecretsProvider implements SecretsProvider {
  readonly #providers: ReadonlyMap<string, SecretsProvider>
  #closed = false

  constructor(providers: Readonly<Record<string, SecretsProvider>>) {
    this.#providers = new Map(Object.entries(providers))
  }

  async resolve(reference: SecretReference, use: SecretUse): Promise<SecretLease> {
    this.#assertOpen()
    const provider = this.#providers.get(reference.provider)
    if (provider === undefined) throw new SecretsProviderError('SECRET_PROVIDER_UNSUPPORTED')
    return provider.resolve(reference, use)
  }

  async health(): Promise<DeploymentComponentHealth> {
    this.#assertOpen()
    const health = await Promise.all(
      [...this.#providers.values()].map((provider) => provider.health())
    )
    return {
      ready: health.every((component) => component.ready),
      component: 'secrets',
      version: '1',
      details: { providers: health.length },
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await Promise.all([...this.#providers.values()].map(async (provider) => provider.close()))
  }

  #assertOpen(): void {
    if (this.#closed) throw new SecretsProviderError('SECRET_PROVIDER_CLOSED')
  }
}

export interface EnvironmentSecretsProviderOptions {
  readonly references: Readonly<Record<string, string>>
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export class EnvironmentSecretsProvider implements SecretsProvider {
  readonly #references: Readonly<Record<string, string>>
  readonly #environment: Readonly<Record<string, string | undefined>>
  #closed = false

  constructor(options: EnvironmentSecretsProviderOptions) {
    this.#references = { ...options.references }
    this.#environment = options.environment ?? process.env
  }

  async resolve(reference: SecretReference): Promise<SecretLease> {
    this.#assertReference(reference, 'env')
    const variable = this.#references[reference.key]
    if (variable === undefined) throw new SecretsProviderError('SECRET_REFERENCE_INVALID')
    const value = this.#environment[variable]
    if (value === undefined) throw new SecretsProviderError('SECRET_NOT_FOUND')
    return lease(reference, new TextEncoder().encode(value))
  }

  health(): Promise<DeploymentComponentHealth> {
    return Promise.resolve({
      ready: !this.#closed,
      component: 'environment-secrets',
      version: '1',
    })
  }

  close(): void {
    this.#closed = true
  }

  #assertReference(reference: SecretReference, provider: string): void {
    if (this.#closed) throw new SecretsProviderError('SECRET_PROVIDER_CLOSED')
    validReference(reference, provider)
  }
}

export interface PrivateFileSecretsProviderOptions {
  readonly rootDirectory: string
  readonly provider?: 'file' | 'docker-secret'
}

export class PrivateFileSecretsProvider implements SecretsProvider {
  readonly #rootDirectory: string
  readonly #provider: 'file' | 'docker-secret'
  #closed = false

  constructor(options: PrivateFileSecretsProviderOptions) {
    this.#rootDirectory = resolve(options.rootDirectory)
    this.#provider = options.provider ?? 'file'
  }

  async resolve(reference: SecretReference): Promise<SecretLease> {
    if (this.#closed) throw new SecretsProviderError('SECRET_PROVIDER_CLOSED')
    validReference(reference, this.#provider)
    const path = resolve(this.#rootDirectory, ...reference.key.split('/'))
    if (path !== this.#rootDirectory && !path.startsWith(`${this.#rootDirectory}${sep}`)) {
      throw new SecretsProviderError('SECRET_REFERENCE_INVALID')
    }
    let file: FileHandle | undefined
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new SecretsProviderError('SECRET_FILE_UNSAFE')
      }
      const canonicalRoot = await realpath(this.#rootDirectory)
      const canonicalPath = await realpath(path)
      if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
        throw new SecretsProviderError('SECRET_FILE_UNSAFE')
      }
      file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const openedInfo = await file.stat()
      if (
        !openedInfo.isFile() ||
        (openedInfo.mode & 0o077) !== 0 ||
        openedInfo.dev !== info.dev ||
        openedInfo.ino !== info.ino
      ) {
        throw new SecretsProviderError('SECRET_FILE_UNSAFE')
      }
      if (openedInfo.size > MAX_SECRET_BYTES) {
        throw new SecretsProviderError('SECRET_VALUE_INVALID')
      }

      // Read at most one byte over the contract limit, even if the file grows
      // after stat. The extra byte distinguishes a valid max-sized value from
      // an oversized one without materializing the whole file.
      const bounded = new Uint8Array(MAX_SECRET_BYTES + 1)
      try {
        let length = 0
        while (length < bounded.byteLength) {
          const { bytesRead } = await file.read(bounded, length, bounded.byteLength - length, null)
          if (bytesRead === 0) break
          length += bytesRead
        }
        if (length > MAX_SECRET_BYTES) {
          throw new SecretsProviderError('SECRET_VALUE_INVALID')
        }
        return lease(reference, bounded.subarray(0, length))
      } finally {
        bounded.fill(0)
      }
    } catch (error) {
      if (error instanceof SecretsProviderError) throw error
      throw new SecretsProviderError('SECRET_NOT_FOUND')
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  health(): Promise<DeploymentComponentHealth> {
    return Promise.resolve({
      ready: !this.#closed,
      component: `${this.#provider}-secrets`,
      version: '1',
    })
  }

  close(): void {
    this.#closed = true
  }
}

export interface HostSecureSecretResolver {
  resolve(handle: string, use: SecretUse): Promise<Uint8Array>
  health(): Promise<boolean>
  close(): void | Promise<void>
}

export class HostSecureHandleSecretsProvider implements SecretsProvider {
  readonly #resolver: HostSecureSecretResolver
  #closed = false

  constructor(resolver: HostSecureSecretResolver) {
    this.#resolver = resolver
  }

  async resolve(reference: SecretReference, use: SecretUse): Promise<SecretLease> {
    if (this.#closed) throw new SecretsProviderError('SECRET_PROVIDER_CLOSED')
    validReference(reference, 'host-secure')
    return lease(reference, await this.#resolver.resolve(reference.key, use))
  }

  async health(): Promise<DeploymentComponentHealth> {
    return {
      ready: !this.#closed && (await this.#resolver.health()),
      component: 'host-secure-secrets',
      version: '1',
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#resolver.close()
  }
}

function validReference(reference: SecretReference, provider: string): void {
  if (
    reference.provider !== provider ||
    !SAFE_KEY.test(reference.key) ||
    reference.key.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new SecretsProviderError('SECRET_REFERENCE_INVALID')
  }
}

function lease(reference: SecretReference, input: Uint8Array): SecretLease {
  if (input.byteLength === 0 || input.byteLength > MAX_SECRET_BYTES) {
    input.fill(0)
    throw new SecretsProviderError('SECRET_VALUE_INVALID')
  }
  const value = new Uint8Array(input)
  input.fill(0)
  let closed = false
  return {
    reference: { ...reference },
    value,
    close: () => {
      if (closed) return
      closed = true
      value.fill(0)
    },
  }
}
