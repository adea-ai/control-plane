import { z } from 'zod'
import type { RuntimeAdapterInspection } from './adapter.js'

/**
 * Capability evidence reported by a tested runtime adapter. A harness name is
 * intentionally not enough to claim Agent Plugins support.
 */
export const AgentPluginsCapabilityReportSchema = z
  .object({
    versions: z.array(z.string().min(1).max(32)).max(16),
    skills: z.boolean(),
    mcpTransports: z.array(z.enum(['stdio', 'streamable-http', 'sse'])).max(3),
  })
  .strict()

export type AgentPluginsCapabilityReport = z.output<typeof AgentPluginsCapabilityReportSchema>

export const ComponentCapabilityReportSchema = z
  .object({
    skillDirectories: z.boolean(),
    mcpTransports: z.array(z.enum(['stdio', 'streamable-http', 'sse'])).max(3),
  })
  .strict()

export type ComponentCapabilityReport = z.output<typeof ComponentCapabilityReportSchema>

export const HarnessProfileSchema = z
  .object({
    profileVersion: z.literal(1),
    harness: z.string().min(1).max(128),
    runtimeVersion: z.string().min(1).max(128),
    adapterVersion: z.string().min(1).max(128),
    agentPlugins: AgentPluginsCapabilityReportSchema,
    components: ComponentCapabilityReportSchema,
  })
  .strict()

export type HarnessProfile = z.output<typeof HarnessProfileSchema>

export function harnessProfileFromInspection(
  input: Readonly<{
    inspection: RuntimeAdapterInspection
    harness: string
    components: ComponentCapabilityReport
  }>
): HarnessProfile {
  const agentPlugins = input.inspection.agentPlugins
  if (!agentPlugins) throw new Error('AGENT_PLUGINS_CAPABILITY_EVIDENCE_MISSING')
  return createHarnessProfile({
    adapterVersion: input.inspection.metadata.adapterVersion,
    agentPlugins,
    components: input.components,
    harness: input.harness,
    runtimeVersion: input.inspection.metadata.harnessVersion,
  })
}

export function createHarnessProfile(
  input: Readonly<{
    harness: string
    runtimeVersion: string
    adapterVersion: string
    agentPlugins: AgentPluginsCapabilityReport
    components: ComponentCapabilityReport
  }>
): HarnessProfile {
  return HarnessProfileSchema.parse({ profileVersion: 1, ...input })
}
