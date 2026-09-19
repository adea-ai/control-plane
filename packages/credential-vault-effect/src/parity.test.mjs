/**
 * M14 #407 — ciphertext parity between the current TypeScript implementation
 * (`@control-plane/credential-vault` NeonEncryptedSecretProvider) and the Effect PoC
 * codec. AES-256-GCM ciphertext is a deterministic function of key+IV+plaintext+AAD, so
 * byte-parity is proven by pinning the IV: the current provider's random IV is captured
 * from its stored record and replayed into the Effect codec's SecretCipherRandom service.
 */
import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import { NeonEncryptedSecretProvider } from '@control-plane/credential-vault'
import {
  NeonSecretCodec,
  SecretCipherRandom,
  neonSecretCodecLayer,
  runEgress,
} from './index.ts'

const KEY = 'a'.repeat(64)
const KEY_REF = 'control-plane-secret-key-v1'
const SECRET = 'parity-probe-secret-9f4a'
const CRED = 'cred_01JABCDEF0123456789ABCDEFG'

function memoryStore() {
  const records = new Map()
  return {
    records,
    async put(input) {
      records.set(`${input.locator}:${input.version}`, { ...input })
    },
    async get(input) {
      const record = records.get(`${input.locator}:${input.version}`)
      return record === undefined ? undefined : { ...record }
    },
    async delete(input) {
      records.delete(`${input.locator}:${input.version}`)
    },
  }
}

const fixedIvLayer = (iv) =>
  Layer.succeed(SecretCipherRandom, { randomIv: Effect.sync(() => iv) })

const codecWithIv = async (iv, store) =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* NeonSecretCodec
    }).pipe(
      Effect.provide(
        neonSecretCodecLayer({
          store,
          encryptionKey: KEY,
          keyReference: KEY_REF,
          random: fixedIvLayer(iv),
        })
      )
    )
  )

const input = { credentialId: CRED, revision: 1, secret: SECRET }

describe('ciphertext byte-parity (aad-v1 format lock)', () => {
  test('same key + plaintext + IV produce byte-identical ciphertext, IV, and auth tag', async () => {
    const store = memoryStore()
    const currentProvider = new NeonEncryptedSecretProvider({
      store,
      encryptionKey: KEY,
      keyReference: KEY_REF,
    })
    await currentProvider.store(input)
    const stored = [...store.records.values()][0]
    const iv = Buffer.from(stored.iv, 'base64url')
    expect(iv).toHaveLength(12)

    const effectCodec = await codecWithIv(iv, store)
    await runEgress(effectCodec.store(input))
    const effectRecord = [...store.records.values()].at(-1)

    expect(Buffer.from(effectRecord.ciphertext, 'base64url').equals(Buffer.from(stored.ciphertext, 'base64url'))).toBeTrue()
    expect(Buffer.from(effectRecord.authTag, 'base64url').equals(Buffer.from(stored.authTag, 'base64url'))).toBeTrue()
    expect(effectRecord.iv).toBe(stored.iv)
    expect(effectRecord.encryptionVersion).toBe(stored.encryptionVersion)
    expect(effectRecord.keyReference).toBe(stored.keyReference)
    expect(effectRecord.locator).toBe(stored.locator)
    expect(effectRecord.version).toBe(stored.version)
  })

  test('implementations decrypt each other\u2019s ciphertext (AAD/tag/encoding identity)', async () => {
    const store = memoryStore()
    const iv = Buffer.alloc(12, 0x2a)
    const current = new NeonEncryptedSecretProvider({ store, encryptionKey: KEY, keyReference: KEY_REF })
    const effectCodec = await codecWithIv(iv, store)

    // current encrypts -> Effect decrypts
    await current.store(input)
    expect(await runEgress(effectCodec.resolve({
      backend: 'neon-encrypted',
      locator: `neon://credential-secrets/${CRED}`,
      version: '1',
      keyReference: KEY_REF,
      encryptionVersion: 'aad-v1',
      ciphertextDigest: `sha256:${'0'.repeat(64)}`,
    }))).toBe(SECRET)

    // Effect encrypts -> current decrypts
    store.records.clear()
    await runEgress(effectCodec.store(input))
    const effectStored = [...store.records.values()].find((r) => r.version === '1')
    expect(effectStored.ciphertext).not.toContain(SECRET)
    expect(await current.resolve({
      backend: 'neon-encrypted',
      locator: effectStored.locator,
      version: effectStored.version,
      keyReference: effectStored.keyReference,
      encryptionVersion: effectStored.encryptionVersion,
      ciphertextDigest: `sha256:${'0'.repeat(64)}`,
    })).toBe(SECRET)
  })

  test('Effect codec is deterministic under a fixed IV (no new nondeterminism)', async () => {
    const iv = Buffer.alloc(12, 0x77)
    const storeA = memoryStore()
    const storeB = memoryStore()
    const codecA = await codecWithIv(iv, storeA)
    const codecB = await codecWithIv(iv, storeB)
    await runEgress(codecA.store(input))
    await runEgress(codecB.store(input))
    const a = [...storeA.records.values()][0]
    const b = [...storeB.records.values()][0]
    expect(a.ciphertext).toBe(b.ciphertext)
    expect(a.authTag).toBe(b.authTag)
    expect(a.iv).toBe(b.iv)
  })
})
