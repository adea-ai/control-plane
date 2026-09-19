import { z } from 'zod'
import {
  RuntimeArtifactReferenceSchema,
  RuntimeCapabilitySchema,
  RuntimeUsageSchema,
} from '@control-plane/runtime-sdk'
export const SemanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const TimestampSchema = z.iso.datetime()
export const NativeSessionIdSchema = z.string().min(1).max(512)
export const MaximumObservationRepairs = 1_024
export const MaximumObservationRepairAttempts = 8
export const MaximumPendingPublications = 1_024
export const MaximumExternalSessionOperations = 1_024
export const MaximumTransportOperations = 896
export const MaximumCleanupTransportOperations = 128
export const CleanupOperationsPerCreate = 2
export const AcpInfoSchema = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().min(1).max(256).optional(),
    version: SemanticVersionSchema,
  })
  .strict()
export const AcpSessionCapabilitiesSchema = z
  .object({
    prompt: z
      .object({
        image: z.object({}).strict().optional(),
        audio: z.object({}).strict().optional(),
        embeddedContext: z.object({}).strict().optional(),
      })
      .passthrough()
      .optional(),
    mcp: z
      .object({
        stdio: z.object({}).strict().optional(),
        http: z.object({}).strict().optional(),
      })
      .passthrough()
      .optional(),
    delete: z.object({}).strict().optional(),
    additionalDirectories: z.object({}).strict().optional(),
  })
  .passthrough()
const AcpControlPlaneMetadataSchema = z
  .object({
    capabilities: z.array(RuntimeCapabilitySchema.shape.name).max(64),
    driverVersion: SemanticVersionSchema,
  })
  .strict()
export const AcpInitializeResultSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    capabilities: z
      .object({
        session: AcpSessionCapabilitiesSchema.optional(),
        auth: z.record(z.string(), z.json()).optional(),
        _meta: z
          .object({ controlPlane: AcpControlPlaneMetadataSchema.optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    info: AcpInfoSchema,
    authMethods: z.array(z.record(z.string(), z.json())).max(32).optional(),
  })
  .passthrough()
const AcpV1InitializeResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    agentInfo: AcpInfoSchema,
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        sessionCapabilities: z
          .object({
            list: z.object({}).passthrough().nullish(),
            resume: z.object({}).passthrough().nullish(),
            close: z.object({}).passthrough().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough(),
  })
  .passthrough()

export function normalizeV1Initialization(
  input: unknown
): z.output<typeof AcpInitializeResultSchema> {
  const result = AcpV1InitializeResultSchema.parse(input)
  const sessions = result.agentCapabilities.sessionCapabilities
  return AcpInitializeResultSchema.parse({
    protocolVersion: result.protocolVersion,
    info: result.agentInfo,
    capabilities: {
      session: {},
      _meta: {
        controlPlane: {
          driverVersion: '1.0.0',
          capabilities: [
            'execution.cancel',
            'interaction.approval',
            'session.create',
            'stream.events',
            'stream.output',
            'tool.call',
            'session.history',
            ...(sessions?.list != null ? ['session.list'] : []),
            ...(sessions?.resume != null ? ['session.resume'] : []),
            ...(sessions?.close != null ? ['session.close'] : []),
            ...(result.agentCapabilities.loadSession ? ['session.load'] : []),
          ],
        },
      },
    },
  })
}
export const AcpErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    classification: z.enum([
      'validation',
      'unsupported',
      'unavailable',
      'conflict',
      'timeout',
      'cancelled',
      'runtime',
      'infrastructure',
      'unknown',
    ]),
    message: z.string().min(1).max(4096),
    retryable: z.boolean(),
  })
  .strict()

export const AcpUpdateSchema = z.union([
  z.object({ sessionUpdate: z.literal('state_update'), state: z.literal('running') }).strict(),
  z
    .object({
      sessionUpdate: z.literal('state_update'),
      state: z.literal('idle'),
      stopReason: z.enum(['end_turn', 'cancelled', 'refusal', 'max_tokens', 'unknown']),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.enum(['agent_message', 'agent_message_chunk']),
      messageId: z.string().min(1).max(512),
      text: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('request_permission'),
      requestId: z.number().int().nonnegative(),
      toolCallId: z.string().min(1).max(512),
      title: z.string().min(1).max(1024),
      options: z
        .array(
          z
            .object({
              optionId: z.string().min(1).max(128),
              kind: z.enum(['allow_once', 'reject']),
            })
            .strict()
        )
        .min(1)
        .max(32),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('elicitation'),
      requestId: z.number().int().nonnegative(),
      prompt: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('usage_update'),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('artifact'),
      artifact: RuntimeArtifactReferenceSchema,
    })
    .strict(),
])

export const AcpSnapshotSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.enum(['starting', 'running', 'awaiting_input']),
      observedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('completed'),
      observedAt: TimestampSchema,
      output: z.json().optional(),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          durationMs: z.number().int().nonnegative(),
        })
        .strict(),
      artifacts: z.array(RuntimeArtifactReferenceSchema).max(1024),
    })
    .strict(),
  z
    .object({
      state: z.literal('cancelled'),
      observedAt: TimestampSchema,
      usage: RuntimeUsageSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.enum(['failed', 'timed_out']),
      observedAt: TimestampSchema,
      error: AcpErrorSchema,
    })
    .strict(),
])

export type AcpUpdate = z.output<typeof AcpUpdateSchema>
export type AcpSnapshot = z.output<typeof AcpSnapshotSchema>
