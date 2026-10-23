import { createPublicKey } from 'node:crypto'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { decodeBase64Url } from './acp-remote-crypto.ts'

/**
 * Pure fence decisions for the secure remote ACP device route. Nothing here performs I/O: callers
 * pass the current time and transport state, and every denial names `fallback: 'none'` so no code
 * path can read it as permission to move execution to another location.
 */

export const ACP_REMOTE_CLOCK_SKEW_MS = 30_000
export const ACP_REMOTE_MAX_COMMAND_LIFETIME_MS = 3_600_000
export const ACP_REMOTE_MAX_PLAINTEXT_BYTES = 1_048_576
export const ACP_REMOTE_MAX_INVENTORY_AGE_MS = 60_000

export const ACP_REMOTE_DENIAL_REASONS = [
  'device_offline',
  'device_revoked',
  'device_stale',
  'command_expired',
  'command_not_yet_valid',
  'command_window_invalid',
  'command_conflict',
  'stale_channel_generation',
  'authentication_failed',
  'binding_mismatch',
  'decryption_failed',
  'payload_too_large',
  'replay_ledger_full',
  'executor_failed',
  'outcome_uncertain',
  'state_unavailable',
  'clock_invalid',
  'response_untrusted',
  'response_unknown',
] as const

export type AcpRemoteDenialReason = (typeof ACP_REMOTE_DENIAL_REASONS)[number]
export const AcpRemoteDenialReasonSchema = z.enum(ACP_REMOTE_DENIAL_REASONS)

type RuntimeErrorClassification = ConstructorParameters<
  typeof RuntimeAdapterError
>[0]['classification']

interface DenialProfile {
  readonly code: string
  readonly classification: RuntimeErrorClassification
  readonly retryable: boolean
}

const denialProfiles: Record<AcpRemoteDenialReason, DenialProfile> = {
  device_offline: { code: 'RUNTIME_NODE_OFFLINE', classification: 'unavailable', retryable: true },
  device_revoked: { code: 'RUNTIME_NODE_REVOKED', classification: 'unavailable', retryable: false },
  device_stale: { code: 'RUNTIME_NODE_STALE', classification: 'unavailable', retryable: true },
  command_expired: {
    code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED',
    classification: 'timeout',
    retryable: false,
  },
  command_not_yet_valid: {
    code: 'RUNTIME_NODE_COMMAND_NOT_YET_VALID',
    classification: 'validation',
    retryable: false,
  },
  command_window_invalid: {
    code: 'RUNTIME_NODE_COMMAND_WINDOW_INVALID',
    classification: 'validation',
    retryable: false,
  },
  command_conflict: {
    code: 'RUNTIME_GATEWAY_COMMAND_CONFLICT',
    classification: 'conflict',
    retryable: false,
  },
  stale_channel_generation: {
    code: 'RUNTIME_GATEWAY_STALE_CHANNEL',
    classification: 'conflict',
    retryable: false,
  },
  authentication_failed: {
    code: 'RUNTIME_NODE_AUTHENTICATION_FAILED',
    classification: 'validation',
    retryable: false,
  },
  binding_mismatch: {
    code: 'RUNTIME_NODE_BINDING_MISMATCH',
    classification: 'validation',
    retryable: false,
  },
  decryption_failed: {
    code: 'RUNTIME_NODE_DECRYPTION_FAILED',
    classification: 'validation',
    retryable: false,
  },
  payload_too_large: {
    code: 'RUNTIME_NODE_PAYLOAD_TOO_LARGE',
    classification: 'validation',
    retryable: false,
  },
  replay_ledger_full: {
    code: 'RUNTIME_NODE_REPLAY_LEDGER_FULL',
    classification: 'unavailable',
    retryable: true,
  },
  executor_failed: {
    code: 'RUNTIME_NODE_EXECUTOR_FAILED',
    classification: 'runtime',
    retryable: false,
  },
  outcome_uncertain: {
    code: 'RUNTIME_NODE_OUTCOME_UNCERTAIN',
    classification: 'unknown',
    retryable: false,
  },
  state_unavailable: {
    code: 'RUNTIME_NODE_STATE_UNAVAILABLE',
    classification: 'infrastructure',
    retryable: true,
  },
  clock_invalid: {
    code: 'RUNTIME_NODE_CLOCK_INVALID',
    classification: 'validation',
    retryable: false,
  },
  response_untrusted: {
    code: 'RUNTIME_NODE_RESPONSE_UNTRUSTED',
    classification: 'infrastructure',
    retryable: false,
  },
  response_unknown: {
    code: 'RUNTIME_NODE_RESPONSE_UNKNOWN',
    classification: 'unknown',
    retryable: true,
  },
}

export interface AcpRemoteFenceDenial {
  readonly outcome: 'denied'
  readonly reason: AcpRemoteDenialReason
  /** Always `none`: a denied remote route is never replaced by another location. */
  readonly fallback: 'none'
}

export type AcpRemoteFenceDecision = { readonly outcome: 'allowed' } | AcpRemoteFenceDenial

export function denyRemote(reason: AcpRemoteDenialReason): AcpRemoteFenceDenial {
  return { outcome: 'denied', reason, fallback: 'none' }
}

/** Typed, machine-readable runtime error for a fenced remote route. Details carry the explicit no-fallback outcome. */
export function remoteDenialError(denial: AcpRemoteFenceDenial): RuntimeAdapterError {
  const profile = denialProfiles[denial.reason]
  return new RuntimeAdapterError({
    code: profile.code,
    classification: profile.classification,
    message: profile.code,
    retryable: profile.retryable,
    details: { reason: denial.reason, fallback: denial.fallback },
  })
}

const scopedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`))
const KeyIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/)
const X25519PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

function isEd25519PublicKey(value: string): boolean {
  try {
    return (
      createPublicKey({
        key: Buffer.from(decodeBase64Url(value)),
        format: 'der',
        type: 'spki',
      }).asymmetricKeyType === 'ed25519'
    )
  } catch {
    return false
  }
}

const Ed25519PublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{59}$/)
  .refine(isEd25519PublicKey, 'Expected an Ed25519 SubjectPublicKeyInfo')

/**
 * Public trust record for one native executor route. It carries public keys and fence state only;
 * strict parsing rejects any credential, private-key, or cloud-location field, so the shared record
 * cannot import local secret material into a hosted service.
 */
export const AcpRemoteDeviceRouteSchema = z
  .strictObject({
    workspaceId: scopedId('wsp'),
    nodeId: scopedId('rnr'),
    runtimeConnectionId: scopedId('rtc'),
    location: z.enum(['local_device', 'remote_host']),
    deviceKeyId: KeyIdSchema,
    deviceSigningPublicKey: Ed25519PublicKeySchema,
    deviceEncryptionKeyId: KeyIdSchema,
    deviceEncryptionPublicKey: X25519PublicKeySchema,
    controllerKeyId: KeyIdSchema,
    controllerSigningPublicKey: Ed25519PublicKeySchema,
    status: z.enum(['active', 'revoked']),
    revokedAt: z.iso.datetime().optional(),
    validUntil: z.iso.datetime(),
  })
  .superRefine((route, context) => {
    if ((route.status === 'revoked') !== (route.revokedAt !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'Revoked routes require revokedAt; active routes must not carry it',
      })
    }
  })

export type AcpRemoteDeviceRoute = z.output<typeof AcpRemoteDeviceRouteSchema>

/**
 * Route-level fence, evaluated before any effect. A non-finite clock or trust deadline fails closed
 * first: NaN comparisons would otherwise let every later check fall open. Revocation is terminal and
 * wins next; an expired trust record is stale; only then is an unreachable transport reported offline.
 */
export function evaluateRouteFence(input: {
  readonly route: AcpRemoteDeviceRoute
  readonly now: Date
  readonly transport: 'online' | 'offline'
  readonly revokedAt?: string | undefined
}): AcpRemoteFenceDecision {
  const nowMs = input.now.getTime()
  const validUntilMs = Date.parse(input.route.validUntil)
  if (!Number.isFinite(nowMs) || !Number.isFinite(validUntilMs)) return denyRemote('clock_invalid')
  if (input.revokedAt !== undefined && !Number.isFinite(Date.parse(input.revokedAt))) {
    return denyRemote('clock_invalid')
  }
  if (input.route.status === 'revoked' || input.revokedAt !== undefined) {
    return denyRemote('device_revoked')
  }
  if (nowMs >= validUntilMs) return denyRemote('device_stale')
  if (input.transport === 'offline') return denyRemote('device_offline')
  return { outcome: 'allowed' }
}

/** Command validity window, evaluated before send at the controller and again before effects at the device. */
export function evaluateCommandWindow(input: {
  readonly issuedAt: string
  readonly expiresAt: string
  readonly now: Date
  readonly clockSkewMs: number
  readonly maxLifetimeMs: number
}): AcpRemoteFenceDecision {
  // Every timestamp and bound must be finite: NaN comparisons fail open (all comparisons false),
  // which would treat a broken clock or malformed window as an allowed command.
  const now = input.now.getTime()
  if (!Number.isFinite(now)) return denyRemote('clock_invalid')
  const issued = Date.parse(input.issuedAt)
  const expires = Date.parse(input.expiresAt)
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(input.clockSkewMs) ||
    input.clockSkewMs < 0 ||
    !Number.isFinite(input.maxLifetimeMs) ||
    input.maxLifetimeMs < 1
  ) {
    return denyRemote('command_window_invalid')
  }
  if (!(expires > issued) || expires - issued > input.maxLifetimeMs) {
    return denyRemote('command_window_invalid')
  }
  if (issued > now + input.clockSkewMs) return denyRemote('command_not_yet_valid')
  if (now >= expires) return denyRemote('command_expired')
  return { outcome: 'allowed' }
}
