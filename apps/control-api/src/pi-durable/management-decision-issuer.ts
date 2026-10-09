import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Canonical CP decision issuer for the Adea lead-management surface (#932).
 *
 * The Control Plane signs one immutable, short-lived `adea-management-authority/v1`
 * decision bound to the exact operation/workspace/target/input binding and to the
 * digest of the exact canonical tool-call request the host forwards to Adea. The
 * Adea verifier (`apps/web/src/server/lead-management-service-auth.ts`) requires
 * the exact claim set emitted here, including `canonicalRequestDigest`; this
 * issuer never mints grants, keys or credentials.
 */

export const managementDecisionAudience = 'adea-lead-management'
export const managementDecisionScope = 'management:execute'
export const managementDecisionSchemaVersion = 'adea-management-authority/v1'

/** Exact claims the Adea verifier accepts; adding one breaks verification. */
export const managementDecisionClaimKeys = [
  'actionDigest',
  'actorUserId',
  'approvalAudienceRef',
  'approvalExpiresAt',
  'approvalInteractionId',
  'audience',
  'audienceRef',
  'authorityRevision',
  'canonicalRequestDigest',
  'credentialId',
  'credentialKind',
  'decision',
  'decisionId',
  'expiresAt',
  'inputDigest',
  'intentId',
  'issuedAt',
  'issuer',
  'keyId',
  'leadAgentId',
  'operation',
  'planRef',
  'planRevision',
  'principalId',
  'projectIds',
  'scopes',
  'targetDigest',
  'targetId',
  'workspaceIds',
] as const

const digestPattern = /^sha256:[a-f0-9]{64}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const referencePattern = /^[A-Za-z0-9._:/-]{1,256}$/
/** Adea decodes the claims with a 6 KiB cap and the whole token with an 8 KiB cap. */
const maximumClaimsBytes = 6_000
const maximumTokenLength = 8_192
const maximumCanonicalRequestBytes = 131_072
const maximumLifetimeMs = 300_000
const defaultLifetimeMs = 120_000

export class PiDurableManagementDecisionIssuerError extends Error {
  constructor() {
    super('PI_MANAGEMENT_DECISION_INVALID')
    this.name = 'PiDurableManagementDecisionIssuerError'
  }
}

export interface PiDurableManagementDecisionSigner {
  /** Existing host key id; never discovered or generated here. */
  readonly keyId: string
  /** Ed25519 signature over the exact JWT signing input; must return 64 bytes. */
  sign(payload: Uint8Array): Promise<Uint8Array>
}

export interface PiDurableManagementDecisionIssuerOptions {
  readonly issuer: string
  /** Canonical service principal the Adea trust entry names. */
  readonly principalId: string
  readonly signer: PiDurableManagementDecisionSigner
  readonly now?: () => number
  readonly lifetimeMs?: number
}

export interface PiDurableManagementDecisionBinding {
  readonly actionDigest: `sha256:${string}`
  readonly inputDigest: `sha256:${string}`
  readonly operation: string
  readonly targetDigest: `sha256:${string}`
  readonly targetId: string | null
  readonly workspaceId: string
}

export interface PiDurableManagementDecisionRequest {
  readonly actorUserId: string
  readonly approval: Readonly<{
    audienceRef: string
    expiresAt: string
    interactionId: string
  }>
  readonly audienceRef: string
  readonly authorityRef: string
  readonly authorityRevision: number
  readonly binding: PiDurableManagementDecisionBinding
  /** Opaque exact canonical tool-call request; Adea forwards it unchanged. */
  readonly canonicalRequest: unknown
  readonly credentialId: string
  readonly decisionId: string
  readonly intentId: string
  readonly leadAgentId: string
  readonly planRef: string
  readonly planRevision: number
}

export interface PiDurableManagementDecision {
  readonly canonicalRequestDigest: `sha256:${string}`
  readonly decision: string
  readonly decisionId: string
  readonly expiresAt: string
  readonly issuedAt: string
}

const bindingSchema = z.strictObject({
  actionDigest: z.string().regex(digestPattern),
  inputDigest: z.string().regex(digestPattern),
  operation: z.string().min(1).max(128),
  targetDigest: z.string().regex(digestPattern),
  targetId: z.string().min(1).max(128).nullable(),
  workspaceId: z.string().min(1).max(128),
})

const requestSchema = z.strictObject({
  actorUserId: z.string().regex(uuidPattern),
  approval: z.strictObject({
    audienceRef: z.string().min(1).max(256),
    expiresAt: z.iso.datetime(),
    interactionId: z.string().min(1).max(256),
  }),
  audienceRef: z.string().min(1).max(256),
  authorityRef: z.string().min(1).max(256),
  authorityRevision: z.number().int().positive(),
  binding: bindingSchema,
  canonicalRequest: z.unknown(),
  credentialId: z.string().min(1).max(256),
  decisionId: z.string().min(1).max(256),
  intentId: z.string().min(1).max(256),
  leadAgentId: z.string().min(1).max(256),
  planRef: z.string().min(1).max(256),
  planRevision: z.number().int().positive(),
})

/**
 * Canonical JSON that matches Adea's `managementInputDigest` byte for byte:
 * plain records only, sorted keys, depth-limited and JSON-safe. Returns null for
 * any value that cannot be hashed without a guess.
 */
export function managementCanonicalRequest(input: unknown): string | null {
  return canonicalValue(input, 0) ?? null
}

function canonicalValue(value: unknown, depth: number): string | undefined {
  if (depth > 32) return undefined
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalValue(item, depth + 1))
    return items.some((item) => item === undefined) ? undefined : `[${items.join(',')}]`
  }
  if (isPlainRecord(value)) {
    const entries: string[] = []
    for (const key of Object.keys(value).toSorted()) {
      const encoded = canonicalValue(value[key], depth + 1)
      if (encoded === undefined) return undefined
      entries.push(`${JSON.stringify(key)}:${encoded}`)
    }
    return `{${entries.join(',')}}`
  }
  return undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function managementCanonicalRequestDigest(input: unknown): `sha256:${string}` | null {
  const canonical = managementCanonicalRequest(input)
  if (canonical === null) return null
  const bytes = Buffer.byteLength(canonical)
  if (bytes === 0 || bytes > maximumCanonicalRequestBytes) return null
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function isCanonicalBase64url(value: string, maximumBytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) return false
  return decoded.byteLength > 0 && decoded.byteLength <= maximumBytes
}

/**
 * Creates the production issuer from a host-supplied existing signer. Every
 * malformed, stale or unbounded request throws before any signature is produced.
 */
export function createPiDurableManagementDecisionIssuer(
  options: PiDurableManagementDecisionIssuerOptions
) {
  const now = options.now ?? Date.now
  const lifetimeMs = options.lifetimeMs ?? defaultLifetimeMs
  if (
    typeof options.issuer !== 'string' ||
    !/^https?:\/\/[^\s]+$/.test(options.issuer) ||
    options.issuer.length > 512 ||
    !referencePattern.test(options.principalId) ||
    typeof options.signer?.sign !== 'function' ||
    !referencePattern.test(options.signer?.keyId ?? '') ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1_000 ||
    lifetimeMs > maximumLifetimeMs
  )
    throw new PiDurableManagementDecisionIssuerError()

  async function issue(input: PiDurableManagementDecisionRequest) {
    try {
      const parsed = requestSchema.parse(input)
      const canonicalRequestDigest = managementCanonicalRequestDigest(parsed.canonicalRequest)
      if (!canonicalRequestDigest) throw new PiDurableManagementDecisionIssuerError()
      const currentTime = now()
      if (!Number.isFinite(currentTime)) throw new PiDurableManagementDecisionIssuerError()
      const approvalExpiresAt = Date.parse(parsed.approval.expiresAt)
      if (!Number.isFinite(approvalExpiresAt) || approvalExpiresAt <= currentTime)
        throw new PiDurableManagementDecisionIssuerError()
      const issuedAt = currentTime
      const expiresAt = currentTime + lifetimeMs
      if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt)
        throw new PiDurableManagementDecisionIssuerError()
      const claims = {
        actionDigest: parsed.binding.actionDigest,
        actorUserId: parsed.actorUserId,
        approvalAudienceRef: parsed.approval.audienceRef,
        approvalExpiresAt: parsed.approval.expiresAt,
        approvalInteractionId: parsed.approval.interactionId,
        audience: managementDecisionAudience,
        audienceRef: parsed.audienceRef,
        authorityRevision: parsed.authorityRevision,
        canonicalRequestDigest,
        credentialId: parsed.credentialId,
        credentialKind: 'service',
        decision: 'allowed',
        decisionId: parsed.decisionId,
        expiresAt: new Date(expiresAt).toISOString(),
        inputDigest: parsed.binding.inputDigest,
        intentId: parsed.intentId,
        issuedAt: new Date(issuedAt).toISOString(),
        issuer: options.issuer,
        keyId: options.signer.keyId,
        leadAgentId: parsed.leadAgentId,
        operation: parsed.binding.operation,
        planRef: parsed.planRef,
        planRevision: parsed.planRevision,
        principalId: options.principalId,
        projectIds: [] as string[],
        scopes: [managementDecisionScope],
        targetDigest: parsed.binding.targetDigest,
        targetId: parsed.binding.targetId,
        workspaceIds: [parsed.binding.workspaceId],
      }
      const claimKeys = Object.keys(claims)
      if (
        claimKeys.length !== managementDecisionClaimKeys.length ||
        !managementDecisionClaimKeys.every((key) => claimKeys.includes(key))
      )
        throw new PiDurableManagementDecisionIssuerError()
      const encodedClaims = base64url(JSON.stringify(claims))
      const encodedHeader = base64url(
        JSON.stringify({ alg: 'EdDSA', kid: options.signer.keyId, typ: 'JWT' })
      )
      const claimsBytes = Buffer.byteLength(JSON.stringify(claims))
      if (claimsBytes > maximumClaimsBytes) throw new PiDurableManagementDecisionIssuerError()
      const signingInput = `${encodedHeader}.${encodedClaims}`
      const signature = await options.signer.sign(new TextEncoder().encode(signingInput))
      if (!(signature instanceof Uint8Array) || signature.byteLength !== 64)
        throw new PiDurableManagementDecisionIssuerError()
      const decision = `${signingInput}.${base64url(signature)}`
      if (
        !isCanonicalBase64url(encodedHeader, 1_024) ||
        !isCanonicalBase64url(encodedClaims, maximumClaimsBytes) ||
        decision.length > maximumTokenLength
      )
        throw new PiDurableManagementDecisionIssuerError()
      return Object.freeze({
        canonicalRequestDigest,
        decision,
        decisionId: parsed.decisionId,
        expiresAt: claims.expiresAt,
        issuedAt: claims.issuedAt,
      }) satisfies PiDurableManagementDecision
    } catch (error) {
      if (error instanceof PiDurableManagementDecisionIssuerError) throw error
      throw new PiDurableManagementDecisionIssuerError()
    }
  }

  return { issue } as const
}
