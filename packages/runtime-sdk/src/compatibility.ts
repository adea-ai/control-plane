import { z } from 'zod'
import { RuntimeCapabilityNameSchema, RuntimeCapabilitySchema } from './capabilities.js'
import {
  RuntimeConnectionLocationSchema,
  RuntimeConnectionSchema,
  RuntimeConnectionTypeSchema,
  RuntimeDiagnosticCodeSchema,
  RuntimeSemanticVersionSchema,
  RuntimeTimestampSchema,
  type RuntimeConnection,
} from './models.js'

const RuntimeFamilySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)
const unique = <Value>(values: Value[]) => new Set(values).size === values.length

export const RuntimeCertificationClassificationSchema = z.enum([
  'supported',
  'preview',
  'degraded',
  'incompatible',
  'revoked',
  'untested',
])

export const RuntimeCertificationSchema = z
  .object({
    certificationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9-]*$/),
    runtimeFamily: RuntimeFamilySchema,
    connectionType: RuntimeConnectionTypeSchema,
    classification: RuntimeCertificationClassificationSchema,
    versions: z
      .object({
        adapter: RuntimeSemanticVersionSchema,
        driver: RuntimeSemanticVersionSchema,
        harness: RuntimeSemanticVersionSchema,
        protocol: RuntimeSemanticVersionSchema,
      })
      .strict(),
    verifiedCapabilities: z
      .array(RuntimeCapabilityNameSchema)
      .min(1)
      .max(64)
      .refine(unique, 'Certified capabilities must be unique'),
    limitations: z.array(RuntimeDiagnosticCodeSchema).max(64).refine(unique),
    testedPlatform: z
      .object({
        operatingSystem: z.enum(['linux', 'macos', 'windows', 'portable']),
        architecture: z.enum(['x64', 'arm64', 'portable']),
        location: RuntimeConnectionLocationSchema,
        environment: z.string().min(1).max(128),
      })
      .strict(),
    certifiedAt: RuntimeTimestampSchema,
    evidence: z
      .array(
        z
          .object({
            suite: z.enum([
              'runtime-adapter-conformance',
              'direct-local-transport-integration',
              'runtime-gateway-integration',
              'hosted-runtime-integration',
            ]),
            source: z
              .string()
              .min(1)
              .max(256)
              .regex(/^(apps|packages|tests)\/[A-Za-z0-9_./-]+$/)
              .refine(
                (source) => !source.split('/').includes('..'),
                'Evidence source cannot traverse directories'
              ),
            command: z.string().min(1).max(512),
          })
          .strict()
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((certification, context) => {
    if (
      certification.classification === 'supported' &&
      (!certification.evidence.some((entry) => entry.suite === 'runtime-adapter-conformance') ||
        !certification.evidence.some(
          (entry) =>
            ['direct-local-transport-integration', 'runtime-gateway-integration'].includes(
              entry.suite
            ) || entry.suite === 'hosted-runtime-integration'
        ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Supported certification requires conformance and transport evidence',
      })
    }
  })

const classifications = RuntimeCertificationClassificationSchema.options

export const RuntimeCompatibilityMatrixSchema = z
  .object({
    schemaVersion: z.literal(1),
    matrixVersion: RuntimeSemanticVersionSchema,
    updatedAt: RuntimeTimestampSchema,
    classifications: z.tuple(
      classifications.map((classification) => z.literal(classification)) as [
        z.ZodLiteral<'supported'>,
        z.ZodLiteral<'preview'>,
        z.ZodLiteral<'degraded'>,
        z.ZodLiteral<'incompatible'>,
        z.ZodLiteral<'revoked'>,
        z.ZodLiteral<'untested'>,
      ]
    ),
    minimumSupportedVersions: z
      .array(
        z
          .object({
            runtimeFamily: RuntimeFamilySchema,
            adapter: RuntimeSemanticVersionSchema,
            driver: RuntimeSemanticVersionSchema,
            harness: RuntimeSemanticVersionSchema,
            protocol: RuntimeSemanticVersionSchema,
          })
          .strict()
      )
      .min(1)
      .max(64),
    certifications: z.array(RuntimeCertificationSchema).min(1).max(256),
  })
  .strict()
  .superRefine((matrix, context) => {
    const certificationIds = matrix.certifications.map(({ certificationId }) => certificationId)
    if (!unique(certificationIds)) {
      context.addIssue({
        code: 'custom',
        path: ['certifications'],
        message: 'Certification IDs must be unique',
      })
    }
    const identities = matrix.certifications.map(certificationIdentity)
    if (!unique(identities)) {
      context.addIssue({
        code: 'custom',
        path: ['certifications'],
        message: 'Certification version and platform identities must be unique',
      })
    }
    if (!unique(matrix.minimumSupportedVersions.map(({ runtimeFamily }) => runtimeFamily))) {
      context.addIssue({
        code: 'custom',
        path: ['minimumSupportedVersions'],
        message: 'Minimum version policies must be unique by runtime family',
      })
    }
  })

export type RuntimeCompatibilityMatrix = z.output<typeof RuntimeCompatibilityMatrixSchema>
export type RuntimeCertification = z.output<typeof RuntimeCertificationSchema>

export interface RuntimeCompatibilityCertificationInput {
  readonly matrix: unknown
  readonly runtimeFamily: string
  readonly connection: unknown
}

export function applyRuntimeCompatibilityCertification(
  input: RuntimeCompatibilityCertificationInput
): RuntimeConnection {
  const matrix = RuntimeCompatibilityMatrixSchema.parse(input.matrix)
  const runtimeFamily = RuntimeFamilySchema.parse(input.runtimeFamily)
  const connection = RuntimeConnectionSchema.parse(input.connection)
  const certification = matrix.certifications.find(
    (entry) =>
      entry.runtimeFamily === runtimeFamily &&
      entry.connectionType === connection.connectionType &&
      entry.testedPlatform.location === connection.location &&
      entry.versions.adapter === connection.adapterVersion &&
      entry.versions.driver === connection.driverVersion &&
      entry.versions.harness === connection.harnessVersion &&
      entry.versions.protocol === connection.protocolVersion
  )
  if (!certification) {
    return RuntimeConnectionSchema.parse(
      degradeConnection(connection, 'untested', ['COMPATIBILITY_UNTESTED'])
    )
  }

  if (certification.classification === 'revoked') {
    return RuntimeConnectionSchema.parse({
      ...connection,
      status: 'revoked',
      health: 'unavailable',
      compatibilityState: 'revoked',
      availabilityState: 'revoked',
      limitations: limitations(connection, certification, ['CERTIFICATION_REVOKED']),
    })
  }
  if (certification.classification === 'incompatible') {
    return RuntimeConnectionSchema.parse({
      ...connection,
      status: 'unavailable',
      health: 'unavailable',
      compatibilityState: 'incompatible',
      availabilityState: 'incompatible',
      limitations: limitations(connection, certification, ['CERTIFICATION_INCOMPATIBLE']),
    })
  }

  const certifiedCapabilities = new Set(certification.verifiedCapabilities)
  const reportedCapabilities = new Map(
    connection.capabilities.map((capability) => [capability.name, capability])
  )
  const missingCertified = certification.verifiedCapabilities.some((name) => {
    const capability = reportedCapabilities.get(name)
    return capability === undefined || capability.support === 'unsupported'
  })
  if (missingCertified) {
    return RuntimeConnectionSchema.parse({
      ...connection,
      status: 'unavailable',
      health: 'unavailable',
      compatibilityState: 'capability_missing',
      availabilityState: 'incompatible',
      limitations: limitations(connection, certification, ['CERTIFIED_CAPABILITY_MISSING']),
    })
  }

  const capabilities = RuntimeCapabilitySchema.array().parse(
    connection.capabilities.map((capability) =>
      certifiedCapabilities.has(capability.name)
        ? capability
        : {
            name: capability.name,
            support: 'unsupported',
            limitations: ['UNCERTIFIED_CAPABILITY'],
          }
    )
  )
  const unverifiedClaim = capabilities.some((capability) =>
    capability.limitations?.includes('UNCERTIFIED_CAPABILITY')
  )
  if (unverifiedClaim) {
    return RuntimeConnectionSchema.parse({
      ...degradeConnection(connection, 'degraded', ['UNCERTIFIED_CAPABILITY']),
      capabilities,
      limitations: limitations(connection, certification, ['UNCERTIFIED_CAPABILITY']),
    })
  }

  if (certification.classification === 'supported') {
    return RuntimeConnectionSchema.parse({
      ...connection,
      compatibilityState: 'compatible',
      limitations: limitations(connection, certification),
    })
  }
  if (certification.classification === 'untested') {
    return RuntimeConnectionSchema.parse({
      ...degradeConnection(connection, 'untested', ['COMPATIBILITY_UNTESTED']),
      limitations: limitations(connection, certification, ['COMPATIBILITY_UNTESTED']),
    })
  }
  const code =
    certification.classification === 'preview' ? 'CERTIFICATION_PREVIEW' : 'CERTIFICATION_DEGRADED'
  return RuntimeConnectionSchema.parse({
    ...degradeConnection(connection, 'degraded', [code]),
    limitations: limitations(connection, certification, [code]),
  })
}

function degradeConnection(
  connection: RuntimeConnection,
  compatibilityState: 'degraded' | 'untested',
  addedLimitations: readonly string[]
): RuntimeConnection {
  const available = connection.status === 'connected' || connection.status === 'degraded'
  return {
    ...connection,
    ...(available
      ? {
          status: 'degraded' as const,
          health: 'degraded' as const,
          availabilityState: 'degraded' as const,
        }
      : {}),
    compatibilityState,
    limitations: [...new Set([...connection.limitations, ...addedLimitations])].toSorted(),
  }
}

function limitations(
  connection: RuntimeConnection,
  certification: RuntimeCertification,
  additional: readonly string[] = []
): string[] {
  return [
    ...new Set([...connection.limitations, ...certification.limitations, ...additional]),
  ].toSorted()
}

function certificationIdentity(certification: RuntimeCertification): string {
  return JSON.stringify({
    runtimeFamily: certification.runtimeFamily,
    connectionType: certification.connectionType,
    versions: certification.versions,
    platform: certification.testedPlatform,
  })
}
