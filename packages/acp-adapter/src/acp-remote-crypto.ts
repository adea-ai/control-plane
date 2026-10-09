import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { Aes128Gcm, CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'

/** Algorithm suite bound into every sealed remote ACP envelope (HPKE base mode + Ed25519). */
export const ACP_REMOTE_SUITE = 'control-plane.acp-remote.v1' as const

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
})

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type HpkeKeyPair = Awaited<ReturnType<typeof suite.kem.generateKeyPair>>

export interface RecipientKeyPair {
  readonly keyPair: HpkeKeyPair
  /** Raw X25519 public key, base64url. Safe to place in route records and on the wire. */
  readonly publicKey: string
}

/** Fresh X25519 key pair for a recipient. Production keys are always generated this way. */
export async function generateRecipientKeyPair(): Promise<RecipientKeyPair> {
  const keyPair = await suite.kem.generateKeyPair()
  return { keyPair, publicKey: await serializeRecipientPublicKey(keyPair.publicKey) }
}

/**
 * Deterministic X25519 derivation from caller-supplied keying material. Test fixtures use this with
 * synthetic seeds; production code paths must call `generateRecipientKeyPair` instead.
 */
export async function deriveRecipientKeyPair(ikm: Uint8Array): Promise<RecipientKeyPair> {
  const keyPair = await suite.kem.deriveKeyPair(ikm)
  return { keyPair, publicKey: await serializeRecipientPublicKey(keyPair.publicKey) }
}

async function serializeRecipientPublicKey(publicKey: CryptoKey): Promise<string> {
  return encodeBase64Url(new Uint8Array(await suite.kem.serializePublicKey(publicKey)))
}

export async function hpkeSeal(input: {
  readonly recipientPublicKey: string
  readonly info: string
  readonly aad: Uint8Array
  readonly plaintext: Uint8Array
}): Promise<{ readonly encapsulatedKey: string; readonly ciphertext: string }> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(
    decodeBase64Url(input.recipientPublicKey)
  )
  const sealed = await suite.seal(
    { recipientPublicKey, info: encoder.encode(input.info) },
    input.plaintext,
    input.aad
  )
  return {
    encapsulatedKey: encodeBase64Url(new Uint8Array(sealed.enc)),
    ciphertext: encodeBase64Url(new Uint8Array(sealed.ct)),
  }
}

export async function hpkeOpen(input: {
  readonly recipientPrivateKey: CryptoKey
  readonly info: string
  readonly aad: Uint8Array
  readonly encapsulatedKey: string
  readonly ciphertext: string
}): Promise<Uint8Array> {
  const plaintext = await suite.open(
    {
      recipientKey: input.recipientPrivateKey,
      enc: decodeBase64Url(input.encapsulatedKey),
      info: encoder.encode(input.info),
    },
    decodeBase64Url(input.ciphertext),
    input.aad
  )
  return new Uint8Array(plaintext)
}

export interface SigningKeyPair {
  readonly privateKey: KeyObject
  /** Ed25519 SubjectPublicKeyInfo DER, base64url. */
  readonly publicKey: string
}

export function generateSigningKeyPair(): SigningKeyPair {
  const pair = generateKeyPairSync('ed25519')
  return { privateKey: pair.privateKey, publicKey: signingPublicKeyOf(pair.privateKey) }
}

export function signingPublicKeyOf(privateKey: KeyObject): string {
  return encodeBase64Url(
    new Uint8Array(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }))
  )
}

/** Stable JSON with lexicographically sorted object keys and no undefined members. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    )
  }
  return value
}

/** Signs canonical content under a domain-separation label so one signature cannot be replayed as another. */
export function signCanonical(domain: string, value: unknown, privateKey: KeyObject): string {
  return encodeBase64Url(new Uint8Array(sign(null, signingInput(domain, value), privateKey)))
}

export function verifyCanonical(
  domain: string,
  value: unknown,
  signature: string,
  publicKey: string
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(decodeBase64Url(publicKey)),
      format: 'der',
      type: 'spki',
    })
    return (
      key.asymmetricKeyType === 'ed25519' &&
      verify(null, signingInput(domain, value), key, decodeBase64Url(signature))
    )
  } catch {
    return false
  }
}

function signingInput(domain: string, value: unknown): Uint8Array {
  return encoder.encode(canonicalJson({ domain, value }))
}

export function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function utf8Decode(value: Uint8Array): string {
  return decoder.decode(value)
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}
