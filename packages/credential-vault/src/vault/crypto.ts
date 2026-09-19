import { Context, Effect } from 'effect'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { EncryptedSecretReference, EncryptedSecretStore, SecretEncryptionVersion } from '../index.js'
import { hash } from './util.js'

/**
 * AES-256-GCM secret encryption for the Neon-backed provider, expressed with
 * Effect. The `EncryptedSecretStore` port (a public, unchanged type) becomes a
 * Layer service; AAD construction, key references, and record serialization are
 * behavior-identical to the pre-Effect implementation (cross-proven in
 * compat.test.mjs). Provider-level failures keep the original raw-escape
 * semantics: store/get/delete errors reject untouched.
 */

export class SecretStorePort
  extends Context.Tag('credential-vault/SecretStorePort')<SecretStorePort, EncryptedSecretStore>()
{}

type Deps = SecretStorePort

export interface StoredSecretRecord {
  readonly ciphertext: string
  readonly iv: string
  readonly authTag: string
  readonly keyReference: string
  readonly encryptionVersion: SecretEncryptionVersion
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

export const storeEncryptedSecret = (input: {
  readonly credentialId: string
  readonly revision: number
  readonly secret: string
  readonly key: Buffer
  readonly keyReference: string
  readonly secretPrefix: string
}) =>
  Effect.gen(function* () {
    const store = yield* SecretStorePort
    const locator = `${input.secretPrefix}/${input.credentialId}`
    const version = String(input.revision)
    const iv = yield* Effect.sync(() => randomBytes(12))
    // No catch here, like the original: cipher failures escape raw.
    const encrypted = yield* Effect.sync(() => {
      const cipher = createCipheriv('aes-256-gcm', input.key, iv)
      cipher.setAAD(
        secretAssociatedData({
          locator,
          version,
          keyReference: input.keyReference,
          encryptionVersion: 'aad-v1',
        })
      )
      const ciphertext = Buffer.concat([cipher.update(input.secret, 'utf8'), cipher.final()])
      return {
        ciphertext: ciphertext.toString('base64url'),
        iv: iv.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      }
    })
    yield* Effect.promise(() =>
      store.put({
        locator,
        version,
        ...encrypted,
        keyReference: input.keyReference,
        encryptionVersion: 'aad-v1',
      })
    )
    return {
      backend: 'neon-encrypted' as const,
      locator,
      version,
      keyReference: input.keyReference,
      encryptionVersion: 'aad-v1' as const,
      ciphertextDigest: `sha256:${hash(input.secret)}` as const,
    }
  }) satisfies Effect.Effect<
    {
      backend: 'neon-encrypted'
      locator: string
      version: string
      keyReference: string
      encryptionVersion: 'aad-v1'
      ciphertextDigest: `sha256:${string}`
    },
    never,
    Deps
  >

export const resolveEncryptedSecret = (input: {
  readonly reference: EncryptedSecretReference
  readonly key: Buffer
  readonly keyReference: string
}) =>
  Effect.gen(function* () {
    const store = yield* SecretStorePort
    const record = yield* Effect.promise(() =>
      store.get({ locator: input.reference.locator, version: input.reference.version })
    )
    if (
      !record ||
      input.reference.keyReference !== input.keyReference ||
      record.keyReference !== input.reference.keyReference
    ) {
      return yield* Effect.die(new Error('SECRET_MISSING'))
    }
    const recordEncryptionVersion = record.encryptionVersion
    if (input.reference.encryptionVersion !== 'aad-v1' || recordEncryptionVersion !== 'aad-v1') {
      return yield* Effect.die(new Error('SECRET_LEGACY_FORMAT'))
    }
    return yield* Effect.try({
      try: () => {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          input.key,
          Buffer.from(record.iv, 'base64url')
        )
        decipher.setAAD(
          secretAssociatedData({
            locator: input.reference.locator,
            version: input.reference.version,
            keyReference: record.keyReference,
            encryptionVersion: recordEncryptionVersion,
          })
        )
        decipher.setAuthTag(Buffer.from(record.authTag, 'base64url'))
        return Buffer.concat([
          decipher.update(Buffer.from(record.ciphertext, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      },
      catch: () => new Error('SECRET_CORRUPTED'),
    })
  }) satisfies Effect.Effect<string, Error, Deps>

export const revokeEncryptedSecret = (reference: EncryptedSecretReference) =>
  Effect.flatMap(SecretStorePort, (store) =>
    Effect.promise(() => store.delete({ locator: reference.locator, version: reference.version }))
  ) satisfies Effect.Effect<void, never, Deps>
