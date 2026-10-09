import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import type { ObjectStore } from '@control-plane/deployment'
import { z } from 'zod'
import {
  registerVerifiedRetirementEvidence,
  type RetirementEvidenceDimension,
  type VerifiedRetirementEvidence,
} from './retirement-gate.js'

/**
 * Trusted verification of redundant-layer retirement evidence artifacts.
 *
 * Boundary: the evidence object is read from the existing `ObjectStore` port
 * (the same head/get, size-bounded, digest-compared pattern as the runtime
 * command artifact verifier), its bytes must match the handle's declared
 * digest, its signed content must name the actual layer, dimension, profile
 * and source revision under test, and its attestation must be an Ed25519
 * signature by a trusted attester key. No new signature or digest scheme is
 * introduced: Ed25519 verification uses `node:crypto` with the same raw-key
 * shape the control API trusts for service keys, and digests are SHA-256.
 *
 * Failures return a bounded code and never echo provider paths, bytes or keys.
 */

export const RETIREMENT_EVIDENCE_OBJECT_PREFIX = 'retirement-evidence/'
export const RETIREMENT_EVIDENCE_DEFAULT_MAX_BYTES = 262_144
const ABSOLUTE_MAX_BYTES = 4 * 1024 * 1024
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const RAW_ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/

/** The signed content of one evidence artifact; `signature` covers every other field. */
export const RetirementEvidenceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('redundant-layer-retirement-evidence'),
    layerId: z.string().min(1).max(128),
    dimension: z.enum(['parity', 'failure']),
    profileId: z.string().min(1).max(128),
    sourceRevision: z.string().min(1).max(128),
    completeness: z.literal(true),
    attestedBy: z.string().min(1).max(128),
    attestedAt: z.iso.datetime(),
    signature: z.string().regex(SIGNATURE_PATTERN),
  })
  .strict()
export type RetirementEvidenceArtifact = z.output<typeof RetirementEvidenceArtifactSchema>

export interface TrustedRetirementAttester {
  readonly keyId: string
  /** Raw Ed25519 public key, base64url without padding (43 characters). */
  readonly publicKey: string
}

export type RetirementEvidenceVerification =
  | { readonly verified: true; readonly fact: Readonly<VerifiedRetirementEvidence> }
  | {
      readonly verified: false
      readonly code:
        | 'HANDLE_INVALID'
        | 'OBJECT_UNAVAILABLE'
        | 'SIZE_INVALID'
        | 'DIGEST_MISMATCH'
        | 'CONTENT_INVALID'
        | 'ATTESTER_UNTRUSTED'
        | 'SIGNATURE_INVALID'
        | 'ATTESTATION_MISMATCH'
        | 'BINDING_MISMATCH'
    }

export interface RetirementEvidenceExpectation {
  readonly layerId: string
  readonly dimension: RetirementEvidenceDimension
  readonly targetProfileId: string
  readonly targetSourceRevision: string
  /** The raw evidence handle exactly as supplied; it is classified, never trusted. */
  readonly handle: unknown
}

const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Deterministic object key for a reference: the reference itself is never a path. */
export function retirementEvidenceObjectKey(reference: string): string {
  return `${RETIREMENT_EVIDENCE_OBJECT_PREFIX}${sha256Hex(reference)}`
}

/** The bytes covered by the attester signature: canonical JSON without `signature`. */
function signedBytes(artifact: Omit<RetirementEvidenceArtifact, 'signature'>): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(artifact))
}

/**
 * Produces the artifact bytes for a content object. Used by the attester tooling and
 * by tests; the verifier never signs anything.
 */
export function signRetirementEvidenceArtifact(
  content: Omit<RetirementEvidenceArtifact, 'signature'>,
  privateKey: KeyObject
): Uint8Array {
  const signature = sign(null, signedBytes(content), privateKey).toString('base64url')
  return new TextEncoder().encode(
    canonicalJsonStringify(RetirementEvidenceArtifactSchema.parse({ ...content, signature }))
  )
}

function trustedKeys(
  attesters: readonly TrustedRetirementAttester[]
): ReadonlyMap<string, KeyObject> {
  if (attesters.length === 0 || attesters.length > 32) {
    throw new Error('RETIREMENT_EVIDENCE_TRUST_INVALID')
  }
  return new Map(
    attesters.map((attester) => {
      if (
        !KEY_ID_PATTERN.test(attester.keyId) ||
        !RAW_ED25519_PUBLIC_KEY_PATTERN.test(attester.publicKey) ||
        Buffer.from(attester.publicKey, 'base64url').length !== 32
      ) {
        throw new Error('RETIREMENT_EVIDENCE_TRUST_INVALID')
      }
      return [
        attester.keyId,
        createPublicKey({
          key: { crv: 'Ed25519', kty: 'OKP', x: attester.publicKey },
          format: 'jwk',
        }),
      ] as const
    })
  )
}

export interface RetirementEvidenceVerifierOptions {
  readonly objectStore: ObjectStore
  readonly trustedAttesters: readonly TrustedRetirementAttester[]
  readonly maxArtifactBytes?: number
}

export interface RetirementEvidenceVerifier {
  verify(input: RetirementEvidenceExpectation): Promise<RetirementEvidenceVerification>
}

export function createRetirementEvidenceVerifier(
  options: RetirementEvidenceVerifierOptions
): RetirementEvidenceVerifier {
  const maxBytes = options.maxArtifactBytes ?? RETIREMENT_EVIDENCE_DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > ABSOLUTE_MAX_BYTES) {
    throw new Error('RETIREMENT_EVIDENCE_LIMIT_INVALID')
  }
  const keys = trustedKeys(options.trustedAttesters)
  const objectStore = options.objectStore

  return {
    async verify(input) {
      const reject = (code: Extract<RetirementEvidenceVerification, { verified: false }>['code']) =>
        ({ verified: false, code }) as const
      const handle = input.handle
      if (
        typeof handle !== 'object' ||
        handle === null ||
        Array.isArray(handle) ||
        typeof (handle as { reference?: unknown }).reference !== 'string' ||
        (handle as { reference: string }).reference.length === 0 ||
        (handle as { reference: string }).reference.length > 256 ||
        typeof (handle as { digest?: unknown }).digest !== 'string' ||
        !DIGEST_PATTERN.test((handle as { digest: string }).digest)
      ) {
        return reject('HANDLE_INVALID')
      }
      const declared = handle as {
        reference: string
        digest: string
        profileId?: unknown
        sourceRevision?: unknown
        attestation?: { attestedBy?: unknown; attestedAt?: unknown }
      }
      const key = retirementEvidenceObjectKey(declared.reference)

      let descriptor
      try {
        descriptor = await objectStore.head(key)
      } catch {
        return reject('OBJECT_UNAVAILABLE')
      }
      if (descriptor.key !== key) return reject('OBJECT_UNAVAILABLE')
      if (
        !Number.isSafeInteger(descriptor.size) ||
        descriptor.size <= 0 ||
        descriptor.size > maxBytes
      ) {
        return reject('SIZE_INVALID')
      }
      if (descriptor.sha256 !== declared.digest) return reject('DIGEST_MISMATCH')

      let body: Uint8Array
      try {
        const stored = await objectStore.get(key)
        if (stored.key !== key || !(stored.body instanceof Uint8Array)) {
          return reject('OBJECT_UNAVAILABLE')
        }
        body = stored.body
      } catch {
        return reject('OBJECT_UNAVAILABLE')
      }
      if (body.byteLength !== descriptor.size) return reject('SIZE_INVALID')
      if (`sha256:${sha256Hex(body)}` !== declared.digest) return reject('DIGEST_MISMATCH')

      let artifact: RetirementEvidenceArtifact
      try {
        const parsed = RetirementEvidenceArtifactSchema.safeParse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
        )
        if (!parsed.success) return reject('CONTENT_INVALID')
        artifact = parsed.data
      } catch {
        return reject('CONTENT_INVALID')
      }

      const attesterKey = keys.get(artifact.attestedBy)
      if (attesterKey === undefined) return reject('ATTESTER_UNTRUSTED')
      const { signature, ...unsigned } = artifact
      const valid = verify(
        null,
        signedBytes(unsigned),
        attesterKey,
        Buffer.from(signature, 'base64url')
      )
      if (!valid) return reject('SIGNATURE_INVALID')

      if (
        declared.attestation?.attestedBy !== artifact.attestedBy ||
        declared.attestation?.attestedAt !== artifact.attestedAt ||
        declared.profileId !== artifact.profileId ||
        declared.sourceRevision !== artifact.sourceRevision
      ) {
        return reject('ATTESTATION_MISMATCH')
      }
      if (
        artifact.layerId !== input.layerId ||
        artifact.dimension !== input.dimension ||
        artifact.profileId !== input.targetProfileId ||
        artifact.sourceRevision !== input.targetSourceRevision
      ) {
        return reject('BINDING_MISMATCH')
      }

      return {
        verified: true,
        fact: registerVerifiedRetirementEvidence({
          layerId: artifact.layerId,
          dimension: artifact.dimension,
          profileId: artifact.profileId,
          sourceRevision: artifact.sourceRevision,
          reference: declared.reference,
          digest: declared.digest,
          attestedBy: artifact.attestedBy,
          attestedAt: artifact.attestedAt,
        }),
      }
    },
  }
}
