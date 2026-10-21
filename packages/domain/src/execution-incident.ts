import { IdentifierSchemas } from '@control-plane/contracts'
import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * A terminal-state disagreement is an incident, not only a metric.
 *
 * The Control Plane execution record is authoritative: a runtime terminal claim that
 * the Control Plane has not recorded is never adopted, and the disagreement is
 * recorded in the Control Plane's favour. Before this type existed the only trace
 * of such a disagreement was a manual-intervention metric and an operator runbook,
 * so the finding had no first-class identity, no severity and no owner.
 *
 * The record is deliberately bounded: it carries identifiers, the reconciliation
 * reason and the same bounded diagnostic facts the checkpoint already carries. It
 * never carries a runtime payload, a result body, a credential or any other
 * sensitive content.
 */
export const ExecutionIncidentKindSchema = z.literal('terminal_state_disagreement')
export const ExecutionIncidentSeveritySchema = z.literal('high')
export const ExecutionIncidentOwnerSchema = z.literal('durable-execution')
/** The approved resolution: the authoritative Control Plane execution result wins. */
export const ExecutionIncidentAuthoritativeResolutionSchema = z.literal('control_plane_execution')
/**
 * No administrative override path exists yet. The value is stated rather than
 * omitted so that a consumer can never read the absence of an override as an
 * available override.
 */
export const ExecutionIncidentAdministrativeOverrideSchema = z.literal('unavailable')

export const ExecutionIncidentSchema = z
  .object({
    schemaVersion: z.literal('execution-incident/v1'),
    incidentId: z.string().regex(/^inc_[a-f0-9]{32}$/),
    kind: ExecutionIncidentKindSchema,
    severity: ExecutionIncidentSeveritySchema,
    owner: ExecutionIncidentOwnerSchema,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId.optional(),
    reason: z.literal('runtime_terminal_unrecorded'),
    detectedAt: z.iso.datetime(),
    evidence: z.array(z.string().max(512)).max(16),
    authoritativeResolution: ExecutionIncidentAuthoritativeResolutionSchema,
    administrativeOverride: ExecutionIncidentAdministrativeOverrideSchema,
  })
  .strict()

export type ExecutionIncident = z.output<typeof ExecutionIncidentSchema>

/**
 * The identity is derived from the disagreement itself, not from the observation
 * instant, so the same disagreement keeps one incident identity across replays and
 * across processes. Two different attempts of one execution are two incidents.
 */
export function executionIncidentId(input: {
  readonly executionId: string
  readonly attemptId?: string | undefined
  readonly kind: z.output<typeof ExecutionIncidentKindSchema>
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.executionId, input.attemptId ?? null, input.kind]))
    .digest('hex')
  return `inc_${digest.slice(0, 32)}`
}

/**
 * Builds the first-class record for a terminal-state disagreement. The caller
 * supplies only bounded diagnostic facts; nothing here interprets runtime payloads.
 */
export function createTerminalStateDisagreementIncident(input: {
  readonly executionId: string
  readonly attemptId?: string | undefined
  readonly detectedAt: string
  readonly evidence: readonly string[]
}): ExecutionIncident {
  return ExecutionIncidentSchema.parse({
    schemaVersion: 'execution-incident/v1',
    incidentId: executionIncidentId({
      executionId: input.executionId,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      kind: 'terminal_state_disagreement',
    }),
    kind: 'terminal_state_disagreement',
    severity: 'high',
    owner: 'durable-execution',
    executionId: input.executionId,
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    reason: 'runtime_terminal_unrecorded',
    detectedAt: input.detectedAt,
    evidence: [...input.evidence],
    authoritativeResolution: 'control_plane_execution',
    administrativeOverride: 'unavailable',
  })
}
