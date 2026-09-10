import { createHash } from 'node:crypto'
import { z } from 'zod'

const OperationalPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    retry: z.object({
      initialDelayMs: z.number().int().positive().max(60_000),
      factor: z.number().min(1).max(8),
      maximumDelayMs: z.number().int().positive().max(60_000),
      maximumAttempts: z.number().int().positive().max(100),
      jitter: z.literal('full'),
    }),
    heartbeat: z.object({
      intervalMs: z.number().int().positive().max(60_000),
      degradedAfterMisses: z.number().int().positive().max(10),
      offlineAfterMisses: z.number().int().positive().max(10),
    }),
    freshness: z.object({ inventoryMaximumAgeMs: z.number().int().positive().max(86_400_000) }),
    retention: z.object({
      commandInboxMs: z.number().int().positive(),
      terminalCommandLedgerMs: z.number().int().positive(),
      executionEventsMs: z.number().int().positive(),
      maximumCommandLifetimeMs: z.number().int().positive(),
    }),
    payload: z.object({
      remoteMetadataBytes: z.number().int().positive(),
      encryptedContentBytes: z.number().int().positive(),
      gatewayFrameBytes: z.number().int().positive(),
      publicRequestDeadlineMs: z.number().int().positive(),
    }),
    shutdown: z.object({ drainTimeoutMs: z.number().int().positive().max(300_000) }),
  })
  .superRefine((policy, context) => {
    if (policy.heartbeat.offlineAfterMisses <= policy.heartbeat.degradedAfterMisses) {
      context.addIssue({
        code: 'custom',
        path: ['heartbeat', 'offlineAfterMisses'],
        message: 'Offline threshold must exceed degraded threshold',
      })
    }
    if (policy.retention.commandInboxMs < 30 * 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: 'custom',
        path: ['retention', 'commandInboxMs'],
        message: 'CommandInbox retention cannot be below 30 days',
      })
    }
    if (policy.retention.terminalCommandLedgerMs < 7 * 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: 'custom',
        path: ['retention', 'terminalCommandLedgerMs'],
        message: 'Terminal ledger retention cannot be below 7 days',
      })
    }
  })

export type OperationalPolicyConfig = z.output<typeof OperationalPolicySchema>

export const managedCloudOperationalPolicy: OperationalPolicyConfig = OperationalPolicySchema.parse(
  {
    schemaVersion: 1,
    retry: {
      initialDelayMs: 1_000,
      factor: 2,
      maximumDelayMs: 60_000,
      maximumAttempts: 5,
      jitter: 'full',
    },
    heartbeat: { intervalMs: 15_000, degradedAfterMisses: 2, offlineAfterMisses: 3 },
    freshness: { inventoryMaximumAgeMs: 60_000 },
    retention: {
      commandInboxMs: 30 * 24 * 60 * 60 * 1_000,
      terminalCommandLedgerMs: 7 * 24 * 60 * 60 * 1_000,
      executionEventsMs: 30 * 24 * 60 * 60 * 1_000,
      maximumCommandLifetimeMs: 24 * 60 * 60 * 1_000,
    },
    payload: {
      remoteMetadataBytes: 256 * 1024,
      encryptedContentBytes: 1024 * 1024,
      gatewayFrameBytes: 1024 * 1024,
      publicRequestDeadlineMs: 30_000,
    },
    shutdown: { drainTimeoutMs: 30_000 },
  }
)

export function loadOperationalPolicy(
  input: unknown = managedCloudOperationalPolicy
): OperationalPolicyConfig {
  return OperationalPolicySchema.parse(input)
}

export function retryDelayMs(
  policy: OperationalPolicyConfig,
  attempt: number,
  random = Math.random
): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('INVALID_RETRY_ATTEMPT')
  const ceiling = Math.min(
    policy.retry.maximumDelayMs,
    policy.retry.initialDelayMs * policy.retry.factor ** (attempt - 1)
  )
  return Math.min(ceiling, Math.floor(random() * (ceiling + 1)))
}

export function operationalPolicyDigest(policy: OperationalPolicyConfig): `sha256:${string}` {
  const canonical = JSON.stringify(policy, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
        )
      : value
  )
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}
