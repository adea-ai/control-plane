import { z } from 'zod'

const canonicalId = (prefix: string, label: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `Invalid ${label}`)
const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const CapabilitySchema = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
const DriverFamilySchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
const VersionStringSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
const forbiddenPayloadKeys = [
  'command',
  'credential',
  'cwd',
  'databaseid',
  'directory',
  'endpoint',
  'executable',
  'file',
  'host',
  'localpath',
  'password',
  'path',
  'privatekey',
  'projectid',
  'sourcescope',
  'token',
  'url',
] as const
const safePayloadKeys = new Set(['profile', 'profileid', 'profileversionid'])

export const GatewayProtocolVersionSchema = z
  .object({ major: z.number().int().positive(), minor: z.number().int().nonnegative() })
  .strict()
export type GatewayProtocolVersion = z.output<typeof GatewayProtocolVersionSchema>

export const GatewayProtocolManifest = Object.freeze({
  name: 'control-plane-runtime-gateway',
  current: { major: 1, minor: 6 },
  supported: [
    { major: 1, minor: 0 },
    { major: 1, minor: 1 },
    { major: 1, minor: 2 },
    { major: 1, minor: 3 },
    { major: 1, minor: 4 },
    { major: 1, minor: 5 },
    { major: 1, minor: 6 },
  ],
})

export const GatewayProtocolDeprecationSchema = z
  .object({
    version: GatewayProtocolVersionSchema,
    deprecatedAt: TimestampSchema,
    sunsetAt: TimestampSchema.optional(),
    replacement: GatewayProtocolVersionSchema.optional(),
  })
  .strict()
  .superRefine((deprecation, context) => {
    if (
      deprecation.sunsetAt !== undefined &&
      Date.parse(deprecation.sunsetAt) <= Date.parse(deprecation.deprecatedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sunsetAt'],
        message: 'Protocol sunset must follow deprecation',
      })
    }
  })

export function negotiateGatewayProtocolVersion(
  localValues: readonly GatewayProtocolVersion[],
  remoteValues: readonly GatewayProtocolVersion[]
): GatewayProtocolVersion | undefined {
  const local = highestMinor(localValues)
  const remote = highestMinor(remoteValues)
  const major = [...local.keys()]
    .filter((candidate) => remote.has(candidate))
    .toSorted((left, right) => right - left)[0]
  return major === undefined
    ? undefined
    : { major, minor: Math.min(local.get(major) ?? 0, remote.get(major) ?? 0) }
}

const CommonEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: GatewayProtocolVersionSchema,
    sequence: z.number().int().nonnegative().max(2_147_483_647),
    nodeId: canonicalId('rnr', 'RuntimeNode ID'),
    workspaceId: canonicalId('wsp', 'workspace ID'),
    traceId: canonicalId('trc', 'trace ID'),
    sentAt: TimestampSchema,
    channelGeneration: z.number().int().positive(),
  })
  .strict()

export const GatewayArtifactReferenceSchema = z
  .object({
    artifactId: canonicalId('art', 'Artifact ID'),
    digest: DigestSchema,
    mediaType: z.string().min(1).max(128),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
  })
  .strict()

const InlinePayloadSchema = z
  .object({
    version: z.number().int().positive(),
    parameters: z.record(z.string(), z.json()),
  })
  .strict()
  .superRefine((payload, context) => rejectPrivilegedPayload(payload.parameters, context))

const CommandPayloadSchema = z.union([
  InlinePayloadSchema,
  z
    .object({ version: z.number().int().positive(), artifact: GatewayArtifactReferenceSchema })
    .strict(),
])

export const GatewayRetainedCommandOutcomeSchema = z
  .object({
    commandId: canonicalId('cmd', 'command ID'),
    payloadHash: DigestSchema,
    status: z.enum([
      'accepted',
      'running',
      'cancelling',
      'succeeded',
      'failed',
      'cancelled',
      'unknown',
    ]),
    observedAt: TimestampSchema,
    result: z
      .union([
        z.object({ data: z.record(z.string(), z.json()) }).strict(),
        z.object({ artifact: GatewayArtifactReferenceSchema }).strict(),
      ])
      .optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.status === 'succeeded' && outcome.result === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Successful retained outcomes require a result',
      })
    }
  })

export const GatewayHelloEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('hello'),
  supportedVersions: z.array(GatewayProtocolVersionSchema).min(1).max(16),
  lastAcknowledgedSequence: z.number().int().nonnegative(),
  retainedCommandOutcomes: z.array(GatewayRetainedCommandOutcomeSchema).max(256).optional(),
})
  .strict()
  .superRefine((hello, context) => {
    const outcomes = hello.retainedCommandOutcomes ?? []
    if (new Set(outcomes.map(({ commandId }) => commandId)).size !== outcomes.length) {
      context.addIssue({
        code: 'custom',
        path: ['retainedCommandOutcomes'],
        message: 'Retained command outcomes must be unique',
      })
    }
    if (outcomes.length > 0 && hello.protocolVersion.minor < 3) {
      context.addIssue({
        code: 'custom',
        path: ['retainedCommandOutcomes'],
        message: 'Retained outcomes require protocol v1.3',
      })
    }
  })

const GatewayCommandBaseSchema = CommonEnvelopeSchema.extend({
  type: z.literal('command'),
  commandId: canonicalId('cmd', 'command ID'),
  idempotencyKey: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  payloadHash: DigestSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  family: z.enum(['runtime', 'context_provider']),
  operation: z.enum([
    'runtime.execute',
    'runtime.cancel',
    'runtime.input',
    'runtime.approval',
    'runtime.status',
    'runtime.session',
    'context.status',
    'context.read',
    'context.write',
  ]),
  driver: z.object({ family: DriverFamilySchema, version: VersionStringSchema }).strict(),
  runtimeConnectionId: canonicalId('rtc', 'runtime connection ID').optional(),
  executionId: canonicalId('exe', 'execution ID').optional(),
  attemptId: canonicalId('att', 'attempt ID').optional(),
  providerRef: canonicalId('pvr', 'context provider reference').optional(),
  authorizationRef: z
    .string()
    .min(16)
    .max(128)
    .regex(/^authz:[A-Za-z0-9._:-]+$/)
    .optional(),
  requiredCapabilities: z.array(CapabilitySchema).min(1).max(64),
  payload: CommandPayloadSchema,
})

export const GatewayCommandEnvelopeSchema = GatewayCommandBaseSchema.strict().superRefine(
  (command, context) => {
    if (Date.parse(command.expiresAt) <= Date.parse(command.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Command expiry must follow issue time',
      })
    }
    if (command.family === 'runtime') {
      for (const field of ['runtimeConnectionId', 'executionId', 'attemptId'] as const) {
        if (command[field] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is required for runtime commands`,
          })
        }
      }
      if (!command.operation.startsWith('runtime.')) {
        context.addIssue({
          code: 'custom',
          path: ['operation'],
          message: 'Runtime command operation mismatch',
        })
      }
      const controlCapability =
        command.operation === 'runtime.cancel'
          ? 'execution.cancel'
          : command.operation === 'runtime.input'
            ? 'interaction.user-input'
            : command.operation === 'runtime.approval'
              ? 'interaction.approval'
              : command.operation === 'runtime.status'
                ? 'stream.events'
                : undefined
      if (controlCapability && !command.requiredCapabilities.includes(controlCapability)) {
        context.addIssue({
          code: 'custom',
          path: ['requiredCapabilities'],
          message: 'Runtime control command requires its operation capability',
        })
      }
      if (command.operation === 'runtime.session') {
        if (command.protocolVersion.minor < 5) {
          context.addIssue({
            code: 'custom',
            path: ['protocolVersion'],
            message: 'Runtime session commands require protocol v1.5',
          })
        }
        if (!command.requiredCapabilities.some((capability) => capability.startsWith('session.'))) {
          context.addIssue({
            code: 'custom',
            path: ['requiredCapabilities'],
            message: 'Runtime session commands require a session capability',
          })
        }
      }
    } else {
      if (command.providerRef === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['providerRef'],
          message: 'providerRef is required',
        })
      }
      if (!command.operation.startsWith('context.')) {
        context.addIssue({
          code: 'custom',
          path: ['operation'],
          message: 'Provider command operation mismatch',
        })
      }
      if (command.operation === 'context.write' && command.authorizationRef === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['authorizationRef'],
          message: 'Writes require separate authorization',
        })
      }
    }
  }
)

export const GatewayAcknowledgementEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('ack'),
  commandId: canonicalId('cmd', 'command ID'),
  payloadHash: DigestSchema,
  disposition: z.enum(['accepted', 'replayed', 'rejected', 'expired']),
}).strict()

export const GatewayProgressEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('progress'),
  commandId: canonicalId('cmd', 'command ID'),
  payloadHash: DigestSchema,
  eventSequence: z.number().int().positive().max(2_147_483_647),
  event: z.object({ kind: CapabilitySchema, data: z.record(z.string(), z.json()) }).strict(),
}).strict()

export const GatewayResultEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('result'),
  commandId: canonicalId('cmd', 'command ID'),
  payloadHash: DigestSchema,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  completedAt: TimestampSchema,
  result: z.union([
    z.object({ data: z.record(z.string(), z.json()) }).strict(),
    z.object({ artifact: GatewayArtifactReferenceSchema }).strict(),
  ]),
}).strict()

export const GatewayCancellationEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('cancel'),
  commandId: canonicalId('cmd', 'command ID'),
  payloadHash: DigestSchema,
  requestedAt: TimestampSchema,
  reason: z.enum(['user_requested', 'policy_revoked', 'deadline_exceeded', 'shutdown']),
}).strict()

export const GatewayHeartbeatEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('heartbeat'),
  observedAt: TimestampSchema,
  status: z.enum(['online', 'degraded', 'draining']),
}).strict()

const DriverInventorySchema = z
  .object({
    opaqueRef: z.string().regex(/^(?:nref|pvr)_[0-9A-HJKMNP-TV-Z]{26}$/),
    driverFamily: DriverFamilySchema,
    adapterVersion: VersionStringSchema.optional(),
    driverVersion: VersionStringSchema,
    harnessVersion: VersionStringSchema.optional(),
    capabilityTtlMs: z.number().int().positive().max(60_000).optional(),
    protocolVersion: GatewayProtocolVersionSchema,
    health: z.enum(['healthy', 'degraded', 'unavailable']),
    capabilities: z.array(CapabilitySchema).max(128),
    limitations: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(64),
  })
  .strict()

export const GatewayInventoryEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('inventory'),
  mode: z.enum(['snapshot', 'delta']).optional(),
  snapshotVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  baseSnapshotVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  observedAt: TimestampSchema,
  runtimeDrivers: z.array(DriverInventorySchema).max(128),
  contextProviders: z.array(DriverInventorySchema).max(32),
  removedRuntimeRefs: z
    .array(z.string().regex(/^nref_[0-9A-HJKMNP-TV-Z]{26}$/))
    .max(128)
    .optional(),
})
  .strict()
  .superRefine((inventory, context) => {
    for (const family of ['runtimeDrivers', 'contextProviders'] as const) {
      inventory[family].forEach((driver, index) => {
        if (driver.capabilityTtlMs !== undefined && inventory.protocolVersion.minor < 6) {
          context.addIssue({
            code: 'custom',
            path: [family, index, 'capabilityTtlMs'],
            message: 'Advertised capability TTL requires protocol v1.6',
          })
        }
      })
    }
    const mode = inventory.mode ?? 'snapshot'
    if (mode === 'delta' && inventory.protocolVersion.minor < 2) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Inventory deltas require protocol v1.2',
      })
    }
    if (mode === 'delta' && inventory.baseSnapshotVersion === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['baseSnapshotVersion'],
        message: 'Inventory deltas require a base snapshot version',
      })
    }
    if (mode === 'snapshot' && inventory.baseSnapshotVersion !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['baseSnapshotVersion'],
        message: 'Inventory snapshots cannot declare a base version',
      })
    }
    const runtimeRefs = inventory.runtimeDrivers.map(({ opaqueRef }) => opaqueRef)
    const removedRefs = inventory.removedRuntimeRefs ?? []
    if (
      new Set(runtimeRefs).size !== runtimeRefs.length ||
      new Set(removedRefs).size !== removedRefs.length
    ) {
      context.addIssue({ code: 'custom', message: 'Inventory runtime references must be unique' })
    }
    if (runtimeRefs.some((runtimeRef) => removedRefs.includes(runtimeRef))) {
      context.addIssue({
        code: 'custom',
        message: 'Inventory cannot update and remove the same runtime',
      })
    }
    if (inventory.protocolVersion.minor >= 2) {
      inventory.runtimeDrivers.forEach((driver, index) => {
        if (driver.adapterVersion === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['runtimeDrivers', index, 'adapterVersion'],
            message: 'Protocol v1.2 runtime inventory requires an adapter version',
          })
        }
        if (driver.harnessVersion === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['runtimeDrivers', index, 'harnessVersion'],
            message: 'Protocol v1.2 runtime inventory requires a harness version',
          })
        }
      })
    }
  })

export const GatewayErrorEnvelopeSchema = CommonEnvelopeSchema.extend({
  type: z.literal('error'),
  commandId: canonicalId('cmd', 'command ID').optional(),
  payloadHash: DigestSchema.optional(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .max(96),
  retryable: z.boolean(),
}).strict()

export const GatewayEnvelopeSchema = z.discriminatedUnion('type', [
  GatewayHelloEnvelopeSchema,
  GatewayCommandEnvelopeSchema,
  GatewayAcknowledgementEnvelopeSchema,
  GatewayProgressEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  GatewayCancellationEnvelopeSchema,
  GatewayHeartbeatEnvelopeSchema,
  GatewayInventoryEnvelopeSchema,
  GatewayErrorEnvelopeSchema,
])
export type GatewayEnvelope = z.output<typeof GatewayEnvelopeSchema>
export type GatewayCommandEnvelope = z.output<typeof GatewayCommandEnvelopeSchema>
export type GatewayAcknowledgementEnvelope = z.output<typeof GatewayAcknowledgementEnvelopeSchema>
export type GatewayResultEnvelope = z.output<typeof GatewayResultEnvelopeSchema>
export type GatewayProgressEnvelope = z.output<typeof GatewayProgressEnvelopeSchema>
export type GatewayErrorEnvelope = z.output<typeof GatewayErrorEnvelopeSchema>
export type GatewayInventoryEnvelope = z.output<typeof GatewayInventoryEnvelopeSchema>
export type GatewayHelloEnvelope = z.output<typeof GatewayHelloEnvelopeSchema>
export type GatewayRetainedCommandOutcome = z.output<typeof GatewayRetainedCommandOutcomeSchema>

function highestMinor(values: readonly GatewayProtocolVersion[]): Map<number, number> {
  const result = new Map<number, number>()
  for (const value of values) {
    const version = GatewayProtocolVersionSchema.parse(value)
    result.set(version.major, Math.max(result.get(version.major) ?? -1, version.minor))
  }
  return result
}

function rejectPrivilegedPayload(
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[] = []
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPrivilegedPayload(entry, context, [...path, index]))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
    if (
      !safePayloadKeys.has(normalizedKey) &&
      forbiddenPayloadKeys.some((forbidden) => forbiddenKeyMatches(normalizedKey, forbidden))
    ) {
      context.addIssue({
        code: 'custom',
        path: [...path, key],
        message: 'Privileged local selector is prohibited',
      })
    }
    rejectPrivilegedPayload(entry, context, [...path, key])
  }
}

function forbiddenKeyMatches(
  normalizedKey: string,
  forbidden: (typeof forbiddenPayloadKeys)[number]
): boolean {
  if (forbidden !== 'token') return normalizedKey.includes(forbidden)
  return (
    normalizedKey === 'token' ||
    [
      'accesstoken',
      'apitoken',
      'authtoken',
      'bearertoken',
      'idtoken',
      'refreshtoken',
      'sessiontoken',
    ].includes(normalizedKey)
  )
}
