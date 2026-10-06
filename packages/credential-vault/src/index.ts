import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { EncryptedSecretReference } from './repository.js'
import type { SecretProvider } from './vault.js'

export * from './repository.js'
export * from './vault.js'
export * from './tool-broker.js'

export class InMemorySecretProvider implements SecretProvider {
  readonly #secrets = new Map<string, string>()
  readonly #revoked = new Set<string>()
  resolveCount = 0

  async store(input: { credentialId: string; revision: number; secret: string }) {
    const locator = `memory://${input.credentialId}/${input.revision}`
    this.#secrets.set(locator, input.secret)
    return {
      backend: 'memory' as const,
      locator,
      version: String(input.revision),
      keyReference: 'memory://test-kms',
      encryptionVersion: 'memory-v1' as const,
      // A digest of an opaque per-store nonce, never of the plaintext secret.
      ciphertextDigest: `sha256:${hash(`${locator}:${randomBytes(32).toString('hex')}`)}` as const,
    }
  }

  async resolve(reference: EncryptedSecretReference): Promise<string> {
    this.resolveCount += 1
    if (this.#revoked.has(reference.locator)) throw new Error('SECRET_REVOKED')
    const secret = this.#secrets.get(reference.locator)
    if (!secret) throw new Error('SECRET_MISSING')
    return secret
  }

  async revoke(reference: EncryptedSecretReference): Promise<void> {
    this.#revoked.add(reference.locator)
  }

  async references(): Promise<readonly string[]> {
    return [...this.#secrets.keys()]
  }
}

export type SecretEncryptionVersion = 'legacy-v0' | 'aad-v1'

export interface EncryptedSecretStore {
  put(input: {
    readonly locator: string
    readonly version: string
    readonly ciphertext: string
    readonly iv: string
    readonly authTag: string
    readonly keyReference: string
    readonly encryptionVersion: 'aad-v1'
  }): Promise<void>
  get(input: { readonly locator: string; readonly version: string }): Promise<
    | {
        readonly ciphertext: string
        readonly iv: string
        readonly authTag: string
        readonly keyReference: string
        readonly encryptionVersion: SecretEncryptionVersion
      }
    | undefined
  >
  delete(input: { readonly locator: string; readonly version: string }): Promise<void>
}

export class NeonEncryptedSecretProvider implements SecretProvider {
  readonly #store: EncryptedSecretStore
  readonly #key: Buffer
  readonly #keyReference: string
  readonly #secretPrefix: string

  constructor(options: {
    readonly store: EncryptedSecretStore
    readonly encryptionKey: string
    readonly keyReference: string
    readonly secretPrefix?: string
  }) {
    this.#store = options.store
    this.#key = decodeEncryptionKey(options.encryptionKey)
    this.#keyReference = options.keyReference
    this.#secretPrefix = (options.secretPrefix ?? 'neon://credential-secrets').replace(/\/$/, '')
  }

  async store(input: { credentialId: string; revision: number; secret: string }) {
    const locator = `${this.#secretPrefix}/${input.credentialId}`
    const version = String(input.revision)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    cipher.setAAD(
      secretAssociatedData({
        locator,
        version,
        keyReference: this.#keyReference,
        encryptionVersion: 'aad-v1',
      })
    )
    const ciphertext = Buffer.concat([cipher.update(input.secret, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    await this.#store.put({
      locator,
      version,
      ciphertext: ciphertext.toString('base64url'),
      iv: iv.toString('base64url'),
      authTag: authTag.toString('base64url'),
      keyReference: this.#keyReference,
      encryptionVersion: 'aad-v1',
    })
    return {
      backend: 'neon-encrypted' as const,
      locator,
      version,
      keyReference: this.#keyReference,
      encryptionVersion: 'aad-v1' as const,
      // Digest of the stored ciphertext envelope. A plaintext digest would be an offline
      // guessing oracle for low-entropy secrets wherever the reference is persisted.
      ciphertextDigest: `sha256:${createHash('sha256')
        .update(Buffer.concat([iv, ciphertext, authTag]))
        .digest('hex')}` as const,
    }
  }

  async resolve(reference: EncryptedSecretReference): Promise<string> {
    const record = await this.#store.get({ locator: reference.locator, version: reference.version })
    if (
      !record ||
      reference.keyReference !== this.#keyReference ||
      record.keyReference !== reference.keyReference
    ) {
      throw new Error('SECRET_MISSING')
    }
    if (reference.encryptionVersion !== 'aad-v1' || record.encryptionVersion !== 'aad-v1') {
      throw new Error('SECRET_LEGACY_FORMAT')
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#key,
        Buffer.from(record.iv, 'base64url')
      )
      decipher.setAAD(
        secretAssociatedData({
          locator: reference.locator,
          version: reference.version,
          keyReference: record.keyReference,
          encryptionVersion: record.encryptionVersion,
        })
      )
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new Error('SECRET_CORRUPTED')
    }
  }

  revoke(reference: EncryptedSecretReference): Promise<void> {
    return this.#store.delete({ locator: reference.locator, version: reference.version })
  }
}

function secretAssociatedData(input: {
  readonly locator: string
  readonly version: string
  readonly keyReference: string
  readonly encryptionVersion: 'aad-v1'
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      'control-plane-credential-secret',
      input.encryptionVersion,
      input.locator,
      input.version,
      input.keyReference,
    ]),
    'utf8'
  )
}

function decodeEncryptionKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64url')
  if (key.length !== 32) throw new Error('INVALID_SECRET_ENCRYPTION_KEY')
  return key
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export const packageName = 'credential-vault'
export * from './portable.js'
