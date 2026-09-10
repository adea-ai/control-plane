import { z } from 'zod'

const ContractVersionsSchema = z
  .object({
    api: z.number().int().positive(),
    database: z.number().int().nonnegative(),
    runtimeGateway: z.number().int().positive(),
  })
  .strict()

const DeploymentManifestSchema = z
  .object({
    releaseId: z.string().min(1).max(128),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    images: z
      .record(z.string().min(1), z.string().min(1))
      .refine((images) => Object.keys(images).length > 0, 'At least one service image is required'),
    contracts: ContractVersionsSchema,
  })
  .strict()

const DeploymentAssessmentSchema = z
  .object({
    current: DeploymentManifestSchema,
    candidate: DeploymentManifestSchema,
    compatibility: z
      .object({
        api: z.array(z.number().int().positive()),
        database: z.array(z.number().int().nonnegative()),
        runtimeGateway: z.array(z.number().int().positive()),
      })
      .strict(),
    migration: z
      .object({
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
        applied: z.boolean(),
        rollbackRestoreVerified: z.boolean(),
      })
      .strict()
      .optional(),
    canary: z
      .object({
        healthy: z.boolean(),
        errorRate: z.number().finite().min(0).max(1),
        p95LatencyMs: z.number().finite().nonnegative(),
      })
      .strict(),
    budgets: z
      .object({
        maximumErrorRate: z.number().finite().min(0).max(1),
        maximumP95LatencyMs: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict()

export type DeploymentAssessment = z.input<typeof DeploymentAssessmentSchema>

export function assessDeployment(input: DeploymentAssessment): {
  readonly decision: 'block' | 'promote' | 'rollback'
  readonly reasons: readonly string[]
} {
  const assessment = DeploymentAssessmentSchema.parse(input)
  const compatibilityReasons = new Set<string>()

  if (!assessment.compatibility.api.includes(assessment.candidate.contracts.api)) {
    compatibilityReasons.add('unsupported_api_contract')
  }
  if (!assessment.compatibility.database.includes(assessment.candidate.contracts.database)) {
    compatibilityReasons.add('unsupported_database_contract')
  }
  if (
    !assessment.compatibility.runtimeGateway.includes(assessment.candidate.contracts.runtimeGateway)
  ) {
    compatibilityReasons.add('unsupported_runtime_gateway_contract')
  }
  if (
    Object.values(assessment.candidate.images).some((image) => !/@sha256:[0-9a-f]{64}$/.test(image))
  ) {
    compatibilityReasons.add('mutable_image')
  }
  if (
    JSON.stringify(Object.keys(assessment.candidate.images).toSorted()) !==
    JSON.stringify(Object.keys(assessment.current.images).toSorted())
  ) {
    compatibilityReasons.add('image_set_mismatch')
  }

  if (assessment.candidate.contracts.database !== assessment.current.contracts.database) {
    if (assessment.candidate.contracts.database < assessment.current.contracts.database) {
      compatibilityReasons.add('database_downgrade')
    }
    const migration = assessment.migration
    if (
      migration === undefined ||
      migration.from !== assessment.current.contracts.database ||
      migration.to !== assessment.candidate.contracts.database ||
      !migration.applied ||
      !migration.rollbackRestoreVerified
    ) {
      compatibilityReasons.add('database_migration_unverified')
    }
  }

  const canaryReasons = new Set<string>()
  if (!assessment.canary.healthy) canaryReasons.add('canary_unhealthy')
  if (assessment.canary.errorRate > assessment.budgets.maximumErrorRate) {
    canaryReasons.add('canary_error_rate')
  }
  if (assessment.canary.p95LatencyMs > assessment.budgets.maximumP95LatencyMs) {
    canaryReasons.add('canary_latency')
  }

  const reasons = [...compatibilityReasons, ...canaryReasons].toSorted()
  if (compatibilityReasons.size > 0) return { decision: 'block', reasons }
  if (canaryReasons.size > 0) return { decision: 'rollback', reasons }
  return { decision: 'promote', reasons }
}
