import { z } from 'zod'
import {
  RuntimeCapabilitySchema,
  type RuntimeCapability,
  type RuntimeCapabilityName,
  type RuntimeExecutionHandle,
  type RuntimeExecutionPlanSnapshot,
} from '@control-plane/runtime-sdk'
import { RuntimeExecutionStatusSchema } from '@control-plane/runtime-sdk'
import { AcpInitializeResultSchema, AcpSnapshotSchema } from './acp-schemas.js'
import type { AcpSnapshot, AcpUpdate } from './acp-schemas.js'

/**
 * Advertise exactly the capabilities the route may claim.
 *
 * The declared surface below is the ACP baseline, not an authorization. When
 * a native route gate supplies an allow-list (M13.03.1), only names the
 * qualified evidence allow-lists are advertised — so `session.resume` and
 * `execution.cancel` stay disabled unless the evidence lists them.
 */
export function mapAcpCapabilities(
  initialize: z.output<typeof AcpInitializeResultSchema>,
  supportsReplay: boolean,
  allowed?: readonly RuntimeCapabilityName[]
) {
  if (!initialize.capabilities.session) return []
  const reported = initialize.capabilities._meta?.controlPlane?.capabilities
  return RuntimeCapabilitySchema.array().parse(
    [
      'execution.cancel',
      'interaction.approval',
      'session.close',
      'session.create',
      'session.list',
      'session.resume',
      ...(supportsReplay ? ['session.history', 'session.load'] : []),
      'stream.events',
      'stream.output',
      'tool.call',
    ]
      .filter(
        (name) => reported === undefined || reported.includes(name as RuntimeCapability['name'])
      )
      .filter((name) => allowed === undefined || allowed.includes(name as RuntimeCapabilityName))
      .map((name) => ({ name, support: 'supported' as const }))
  )
}

export function safeNativeDisplayName(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('://') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return undefined
  }
  return value.slice(0, 128)
}

export function normalizeHistory(
  updates: readonly AcpUpdate[],
  now: () => Date,
  afterSequence = 0
): Array<{ sequence: number; occurredAt: string; data: Record<string, z.util.JSONType> }> {
  return updates.flatMap((update, index) => {
    if (
      update.sessionUpdate !== 'agent_message' &&
      update.sessionUpdate !== 'agent_message_chunk'
    ) {
      return []
    }
    return [
      {
        sequence: afterSequence + index + 1,
        occurredAt: now().toISOString(),
        data: { type: 'output', text: update.text, messageId: update.messageId },
      },
    ]
  })
}

export function acpPrompt(attemptId: string, plan: RuntimeExecutionPlanSnapshot): string {
  const contextPackage = z
    .object({ contextPackageId: z.string().min(1).max(512) })
    .passthrough()
    .safeParse(plan['contextPackage'])
  return [
    `Execute Control Plane plan ${plan.executionPlanId}.`,
    `Attempt reference: ${attemptId}.`,
    `Plan digest: ${plan.contentDigest}.`,
    ...(contextPackage.success
      ? [`Authorized context package: ${contextPackage.data.contextPackageId}.`]
      : []),
    'Preserve all native harness-owned behavior, instructions, plugins, tools, and session ownership.',
  ].join(' ')
}

/**
 * Normalize a native snapshot into a runtime execution status.
 *
 * Usage is an opt-in claim (M13.03.1): when `usageReporting` is false the
 * observed terminal usage is dropped rather than forwarded, so an unauthorized
 * route never claims usage. `result.usage` is a mandatory part of the
 * completed execution result contract and is therefore not a route claim; an
 * unauthorized route cannot reach a completed result at all because the
 * capability gate leaves it with no executable capabilities.
 */
export function normalizeSnapshot(
  handle: RuntimeExecutionHandle,
  snapshotInput: AcpSnapshot,
  usageReporting = true
) {
  const snapshot = AcpSnapshotSchema.parse(snapshotInput)
  if (snapshot.state === 'cancelled') {
    return RuntimeExecutionStatusSchema.parse({
      handle,
      state: 'cancelled',
      observedAt: snapshot.observedAt,
      ...(!usageReporting || snapshot.usage === undefined ? {} : { terminalUsage: snapshot.usage }),
    })
  }
  if (snapshot.state === 'completed') {
    return RuntimeExecutionStatusSchema.parse({
      handle,
      state: 'completed',
      observedAt: snapshot.observedAt,
      result: {
        outcome: 'completed',
        ...(snapshot.output === undefined ? {} : { output: snapshot.output }),
        usage: snapshot.usage,
        artifacts: snapshot.artifacts,
      },
    })
  }
  if (snapshot.state === 'failed' || snapshot.state === 'timed_out') {
    return RuntimeExecutionStatusSchema.parse({
      handle,
      state: snapshot.state,
      observedAt: snapshot.observedAt,
      error: snapshot.error,
    })
  }
  return RuntimeExecutionStatusSchema.parse({
    handle,
    state: snapshot.state,
    observedAt: snapshot.observedAt,
  })
}
