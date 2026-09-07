import { z } from 'zod'

export const ContractVersionSchema = z
  .object({
    major: z.number().int().positive(),
    minor: z.number().int().nonnegative(),
  })
  .strict()

export type ContractVersion = z.infer<typeof ContractVersionSchema>

export const PublicContractManifest = Object.freeze({
  name: 'agent-hq-control-plane',
  current: { major: 3, minor: 0 },
  supported: [
    { major: 1, minor: 0 },
    { major: 2, minor: 0 },
    { major: 3, minor: 0 },
  ],
})

export type CompatibilityDirection =
  | 'exact'
  | 'backward-compatible'
  | 'forward-compatible'
  | 'breaking'

export interface ContractCompatibility {
  readonly compatible: boolean
  readonly direction: CompatibilityDirection
}

export function assessContractCompatibility(input: {
  readonly consumer: ContractVersion
  readonly producer: ContractVersion
}): ContractCompatibility {
  const consumer = ContractVersionSchema.parse(input.consumer)
  const producer = ContractVersionSchema.parse(input.producer)

  if (consumer.major !== producer.major) return { compatible: false, direction: 'breaking' }
  if (consumer.minor === producer.minor) return { compatible: true, direction: 'exact' }
  return producer.minor > consumer.minor
    ? { compatible: true, direction: 'backward-compatible' }
    : { compatible: true, direction: 'forward-compatible' }
}

function highestMinorByMajor(versions: readonly ContractVersion[]): Map<number, number> {
  const result = new Map<number, number>()
  for (const candidate of versions) {
    const version = ContractVersionSchema.parse(candidate)
    result.set(version.major, Math.max(result.get(version.major) ?? -1, version.minor))
  }
  return result
}

export function negotiateContractVersion(
  localVersions: readonly ContractVersion[],
  remoteVersions: readonly ContractVersion[]
): ContractVersion | undefined {
  const local = highestMinorByMajor(localVersions)
  const remote = highestMinorByMajor(remoteVersions)
  const commonMajor = [...local.keys()]
    .filter((major) => remote.has(major))
    .sort((left, right) => right - left)[0]

  if (commonMajor === undefined) return undefined
  return {
    major: commonMajor,
    minor: Math.min(local.get(commonMajor) ?? 0, remote.get(commonMajor) ?? 0),
  }
}

export const ContractDeprecationSchema = z
  .object({
    deprecatedAt: z.iso.datetime(),
    sunsetAt: z.iso.datetime().optional(),
    replacement: ContractVersionSchema.optional(),
    documentationUrl: z.url().optional(),
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
        message: 'sunsetAt must be later than deprecatedAt',
      })
    }
  })

export type ContractDeprecation = z.infer<typeof ContractDeprecationSchema>
