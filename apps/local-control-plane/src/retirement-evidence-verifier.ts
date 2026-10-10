import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import type { ObjectStore } from '@control-plane/deployment'
import { z } from 'zod'
import {
  DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
  MAX_EVIDENCE_AGE_SECONDS,
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
 * digest, and its signed content must bind the actual execution (run identity,
 * timing, expected/executed/passed case counts and an output digest), the
 * attestation (attestor and time), the layer, dimension, profile and source
 * revision under test. The attester's Ed25519 signature covers every field.
 *
 * Freshness is decided here, against the verifier's own trusted clock, never
 * against a caller-declared time: a signed `attestedAt` more than the configured
 * age bound in the past, or more than a bounded skew in the future, is rejected.
 * The verified fact carries the signed attestor, time and completeness, so the
 * gate can bind a handle's declared attestation to what was actually signed.
 *
 * Attester keys are injected configuration; this module provisions nothing.
 * When no attester is configured for a composition, `createUnavailableRetirementEvidenceVerifier`
 * reports `AUTHORITY_UNAVAILABLE` for every handle. No new signature or digest
 * scheme is introduced.
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
const MAX_CASES = 100_000
/** Tolerated clock disagreement between the attester and this verifier. */
export const RETIREMENT_EVIDENCE_MAX_CLOCK_SKEW_MS = 60_000

/** Actual execution facts the attester signed for this evidence. */
export const RetirementEvidenceExecutionSchema = z
  .object({
    runId: z.string().min(1).max(128),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    casesExpected: z.number().int().positive().max(MAX_CASES),
    casesExecuted: z.number().int().nonnegative().max(MAX_CASES),
    casesPassed: z.number().int().nonnegative().max(MAX_CASES),
    outputDigest: z.string().regex(DIGEST_PATTERN),
  })
  .strict()

/** The signed content of one evidence artifact; `signature` covers every other field. */
export const RetirementEvidenceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('redundant-layer-retirement-evidence'),
    layerId: z.string().min(1).max(128),
    dimension: z.enum(['parity', 'failure']),
    profileId: z.string().min(1).max(128),
    sourceRevision: z.string().min(1).max(128),
    execution: RetirementEvidenceExecutionSchema,
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
        | 'EXECUTION_INCOMPLETE'
        | 'ATTESTER_UNTRUSTED'
        | 'SIGNATURE_INVALID'
        | 'ATTESTATION_MISMATCH'
        | 'ATTESTATION_STALE'
        | 'ATTESTATION_IN_FUTURE'
        | 'CLOCK_INVALID'
        | 'BINDING_MISMATCH'
        | 'AUTHORITY_UNAVAILABLE'
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
  /** Trusted verifier clock (server time). Defaults to the host wall clock. */
  readonly now?: () => string
  /** Maximum age of a signed attestation at verification time. */
  readonly maxEvidenceAgeSeconds?: number
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
  const clock = options.now ?? (() => new Date().toISOString())
  const maxAgeSeconds = options.maxEvidenceAgeSeconds ?? DEFAULT_MAX_EVIDENCE_AGE_SECONDS
  if (
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > MAX_EVIDENCE_AGE_SECONDS
  ) {
    throw new Error('RETIREMENT_EVIDENCE_LIMIT_INVALID')
  }
  const maxAgeMs = maxAgeSeconds * 1000

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
        attestation?: { attestedBy?: unknown; attestedAt?: unknown; complete?: unknown }
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

      // Execution must be internally consistent and precede the attestation.
      const { startedAt, completedAt, casesExpected, casesExecuted, casesPassed } =
        artifact.execution
      if (
        Date.parse(startedAt) > Date.parse(completedAt) ||
        Date.parse(completedAt) > Date.parse(artifact.attestedAt)
      ) {
        return reject('CONTENT_INVALID')
      }
      if (casesExecuted !== casesExpected || casesPassed !== casesExecuted) {
        return reject('EXECUTION_INCOMPLETE')
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

      // Every attestation and freshness field the handle declares must equal the signed value.
      if (
        declared.attestation?.attestedBy !== artifact.attestedBy ||
        declared.attestation?.attestedAt !== artifact.attestedAt ||
        declared.attestation?.complete !== true ||
        declared.profileId !== artifact.profileId ||
        declared.sourceRevision !== artifact.sourceRevision
      ) {
        return reject('ATTESTATION_MISMATCH')
      }
      // Freshness is judged by this verifier's clock against the SIGNED attestation time.
      const nowMs = Date.parse(clock())
      if (!Number.isFinite(nowMs)) return reject('CLOCK_INVALID')
      const attestedMs = Date.parse(artifact.attestedAt)
      if (
        attestedMs > nowMs + RETIREMENT_EVIDENCE_MAX_CLOCK_SKEW_MS ||
        Date.parse(artifact.execution.completedAt) > nowMs + RETIREMENT_EVIDENCE_MAX_CLOCK_SKEW_MS
      ) {
        return reject('ATTESTATION_IN_FUTURE')
      }
      if (nowMs - attestedMs > maxAgeMs) return reject('ATTESTATION_STALE')

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
          complete: true,
          execution: {
            runId: artifact.execution.runId,
            startedAt,
            completedAt,
            casesExpected,
            casesExecuted,
            casesPassed,
            outputDigest: artifact.execution.outputDigest,
          },
        }),
      }
    },
  }
}

/**
 * The composition-level verifier when no trusted attester is provisioned. Upstream
 * attester key provisioning and qualification-artifact production are not in this
 * repository, so a composition without injected keys must report every retirement
 * evidence handle as `AUTHORITY_UNAVAILABLE` rather than verify anything or raise a
 * configuration error into a request path.
 */
export function createUnavailableRetirementEvidenceVerifier(): RetirementEvidenceVerifier {
  return {
    async verify() {
      return { verified: false, code: 'AUTHORITY_UNAVAILABLE' } as const
    },
  }
}
