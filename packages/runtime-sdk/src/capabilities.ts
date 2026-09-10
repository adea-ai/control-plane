import { z } from 'zod'

export const RuntimeCapabilityNameSchema = z.enum([
  'stream.output',
  'stream.events',
  'tool.call',
  'tool.parallel',
  'output.structured',
  'filesystem.read',
  'filesystem.write',
  'project.read',
  'project.write',
  'execution.cancel',
  'interaction.user-input',
  'interaction.approval',
  'session.create',
  'session.list',
  'session.resume',
  'session.close',
  'session.history',
  'session.load',
  'model.select',
  'execution.child',
])

export type RuntimeCapabilityName = z.infer<typeof RuntimeCapabilityNameSchema>

export const RuntimeCapabilitySchema = z.object({
  name: RuntimeCapabilityNameSchema,
  support: z.enum(['supported', 'degraded', 'unsupported']),
  limitations: z.array(z.string().min(1).max(512)).max(32).optional(),
})

export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>

export const CapabilityRequirementSchema = z.object({
  capability: RuntimeCapabilityNameSchema,
  necessity: z.enum(['required', 'optional']),
  minimumSupport: z.enum(['supported', 'degraded']).default('supported'),
})

export type CapabilityRequirement = z.input<typeof CapabilityRequirementSchema>

export const CapabilityRequirementSetSchema = z
  .array(CapabilityRequirementSchema)
  .max(64)
  .refine(
    (requirements) =>
      new Set(requirements.map((requirement) => requirement.capability)).size ===
      requirements.length,
    'Capability requirements must be unique'
  )

export interface CapabilityEvaluation {
  readonly eligible: boolean
  readonly mode: 'full' | 'degraded' | 'ineligible'
  readonly missingRequired: readonly RuntimeCapabilityName[]
  readonly insufficientRequired: readonly RuntimeCapabilityName[]
  readonly missingOptional: readonly RuntimeCapabilityName[]
  readonly degradedOptional: readonly RuntimeCapabilityName[]
}

export function evaluateCapabilities(
  capabilitiesInput: readonly RuntimeCapability[],
  requirementsInput: readonly CapabilityRequirement[]
): CapabilityEvaluation {
  const capabilities = new Map(
    capabilitiesInput.map((capability) => {
      const parsed = RuntimeCapabilitySchema.parse(capability)
      return [parsed.name, parsed] as const
    })
  )
  const requirements = CapabilityRequirementSetSchema.parse(requirementsInput)
  const missingRequired: RuntimeCapabilityName[] = []
  const insufficientRequired: RuntimeCapabilityName[] = []
  const missingOptional: RuntimeCapabilityName[] = []
  const degradedOptional: RuntimeCapabilityName[] = []

  for (const requirement of requirements) {
    const capability = capabilities.get(requirement.capability)
    const absent = capability === undefined || capability.support === 'unsupported'
    if (requirement.necessity === 'required') {
      if (absent) missingRequired.push(requirement.capability)
      else if (requirement.minimumSupport === 'supported' && capability.support === 'degraded') {
        insufficientRequired.push(requirement.capability)
      }
    } else if (absent) {
      missingOptional.push(requirement.capability)
    } else if (capability.support === 'degraded') {
      degradedOptional.push(requirement.capability)
    }
  }

  const sort = (values: RuntimeCapabilityName[]) => values.toSorted()
  const eligible = missingRequired.length === 0 && insufficientRequired.length === 0
  const degraded = missingOptional.length > 0 || degradedOptional.length > 0
  return {
    eligible,
    mode: eligible ? (degraded ? 'degraded' : 'full') : 'ineligible',
    missingRequired: sort(missingRequired),
    insufficientRequired: sort(insufficientRequired),
    missingOptional: sort(missingOptional),
    degradedOptional: sort(degradedOptional),
  }
}

export function runtimeCapabilitiesEqual(
  left: readonly RuntimeCapability[],
  right: readonly RuntimeCapability[]
): boolean {
  return capabilityFingerprint(left) === capabilityFingerprint(right)
}

export function capabilityFingerprint(capabilities: readonly RuntimeCapability[]): string {
  return JSON.stringify(
    capabilities
      .map((capability) => RuntimeCapabilitySchema.parse(capability))
      .toSorted((left, right) => left.name.localeCompare(right.name))
  )
}
