import { createHash } from 'node:crypto'
import { DeploymentProfiles, type JsonValue } from '@control-plane/deployment'
import { z } from 'zod'
import { EvalRunSchema } from '@control-plane/production-readiness'
import {
  ContextAuthoringCommandRecordSchema,
  assertContextPackageIntegrity,
  contextAuthoringCommandKey,
} from '@control-plane/context'
import {
  ExecutionValidationCommandRecordSchema,
  executionValidationCommandKey,
  assertExecutionPlanIntegrity,
  assertExecutionValidationCommandPlan,
} from '@control-plane/execution-plan'

export const PORTABLE_EXPORT_SCHEMA_VERSION = 1 as const
export const PORTABLE_CONTRACT_VERSION = 'control-plane-portable-state-v1' as const

const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:/-]+$/)
const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value) => value as `sha256:${string}`)
const ProfileSchema = z.enum([
  DeploymentProfiles.cloud,
  DeploymentProfiles.local,
  DeploymentProfiles.hostedSimple,
  DeploymentProfiles.hostedServer,
])
const JsonSchema: z.ZodType<JsonValue> = z.json()

export const PortableRecordCategorySchema = z.enum([
  'agent-profile',
  'skill',
  'project-state',
  'context-package',
  'context-authoring-command',
  'execution-plan',
  'execution-validation-command',
  'evaluation-run',
  'policy-configuration',
  'runtime-configuration',
  'tool-configuration',
  'model-configuration',
  'selected-history',
])

export const PortableRecordSchema = z
  .object({
    category: PortableRecordCategorySchema,
    logicalId: IdentifierSchema,
    revision: z.number().int().nonnegative(),
    contentDigest: DigestSchema,
    value: JsonSchema,
  })
  .strict()

export const PortableArtifactReferenceSchema = z
  .object({
    key: IdentifierSchema,
    size: z.number().int().nonnegative(),
    sha256: DigestSchema,
    contentType: z.string().min(1).max(255).optional(),
    metadata: z.record(z.string().max(64), z.string().max(4096)).default({}),
  })
  .strict()

export const PortableSecretReferenceSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    key: IdentifierSchema,
    version: IdentifierSchema.optional(),
    purpose: z.string().min(1).max(128),
  })
  .strict()

export const PortableCompatibilitySchema = z
  .object({
    minimumSchemaVersion: z.literal(PORTABLE_EXPORT_SCHEMA_VERSION),
    contractVersion: z.literal(PORTABLE_CONTRACT_VERSION),
    requiredCapabilities: z.array(IdentifierSchema).max(128),
    sourcePersistence: z.enum(['sqlite', 'postgresql']),
    sourceObjectStore: z.enum(['filesystem', 's3-compatible']),
  })
  .strict()

export const PortableExportManifestSchema = z
  .object({
    schemaVersion: z.literal(PORTABLE_EXPORT_SCHEMA_VERSION),
    contractVersion: z.literal(PORTABLE_CONTRACT_VERSION),
    exportId: IdentifierSchema,
    sourceProfile: ProfileSchema,
    createdAt: z.iso.datetime(),
    quiesced: z.literal(true),
    includesSelectedHistory: z.boolean(),
    componentVersions: z.record(IdentifierSchema, z.string().min(1).max(128)),
    compatibility: PortableCompatibilitySchema,
    records: z.array(PortableRecordSchema).max(1_000_000),
    artifacts: z.array(PortableArtifactReferenceSchema).max(1_000_000),
    secretReferences: z.array(PortableSecretReferenceSchema).max(100_000),
    unsupportedReferences: z.array(IdentifierSchema).max(100_000),
    contentDigest: DigestSchema,
  })
  .strict()

export type PortableRecord = z.output<typeof PortableRecordSchema>
export type PortableArtifactReference = z.output<typeof PortableArtifactReferenceSchema>
export type PortableSecretReference = z.output<typeof PortableSecretReferenceSchema>
export type PortableExportManifest = z.output<typeof PortableExportManifestSchema>

export function createPortableRecord(input: Omit<PortableRecord, 'contentDigest'>): PortableRecord {
  const normalized = {
    category: input.category,
    logicalId: input.logicalId,
    revision: input.revision,
    value: input.value,
  }
  return PortableRecordSchema.parse({ ...normalized, contentDigest: digestJson(normalized) })
}

export function finalizePortableManifest(
  input: Omit<PortableExportManifest, 'contentDigest'>
): PortableExportManifest {
  const normalized = normalizeManifestInput(input)
  return PortableExportManifestSchema.parse({
    ...normalized,
    contentDigest: digestJson(normalized),
  })
}

export function assertPortableManifest(input: unknown): PortableExportManifest {
  const manifest = PortableExportManifestSchema.parse(input)
  const { contentDigest, ...unsigned } = manifest
  const normalized = normalizeManifestInput(unsigned)
  if (digestJson(normalized) !== contentDigest) throw new Error('PORTABLE_MANIFEST_DIGEST_INVALID')
  for (const record of manifest.records) {
    const { contentDigest: recordDigest, ...recordUnsigned } = record
    if (digestJson(recordUnsigned) !== recordDigest) {
      throw new Error('PORTABLE_RECORD_DIGEST_INVALID')
    }
    if (record.category === 'evaluation-run') {
      const run = EvalRunSchema.parse(record.value)
      if (
        record.logicalId !== `evaluation-runs/${portableEvaluationRunKey(run.evalRunId)}` ||
        record.revision !== 0
      )
        throw new Error('PORTABLE_EVALUATION_IDENTITY_INVALID')
    }
  }
  const packages = new Map(
    manifest.records
      .filter((record) => record.category === 'context-package')
      .map((record) => [record.logicalId, record.value])
  )
  for (const record of manifest.records.filter(
    (record) => record.category === 'context-authoring-command'
  )) {
    const command = ContextAuthoringCommandRecordSchema.parse(record.value)
    if (
      record.logicalId !== `context-authoring-commands/${contextAuthoringCommandKey(command.scope)}`
    )
      throw new Error('PORTABLE_AUTHORING_IDENTITY_INVALID')
    const package_ = assertContextPackageIntegrity(
      packages.get(`context-packages/${command.contextPackage.contextPackageId}`)
    )
    if (
      package_.contextPackageId !== command.contextPackage.contextPackageId ||
      package_.contentDigest !== command.contextPackage.contentDigest ||
      package_.projectState.workspaceId !== command.scope.workspaceId ||
      package_.projectState.projectId !== command.scope.projectId
    )
      throw new Error('PORTABLE_AUTHORING_PACKAGE_INVALID')
  }
  const plans = new Map(
    manifest.records
      .filter((record) => record.category === 'execution-plan')
      .map((record) => [record.logicalId, record.value])
  )
  for (const record of manifest.records.filter(
    (record) => record.category === 'execution-validation-command'
  )) {
    const command = ExecutionValidationCommandRecordSchema.parse(record.value)
    if (
      record.logicalId !==
      `execution-validation-commands/${executionValidationCommandKey(command.scope)}`
    ) {
      throw new Error('PORTABLE_VALIDATION_IDENTITY_INVALID')
    }
    const plan = assertExecutionPlanIntegrity(
      plans.get(`execution-plans/${command.executionPlan.executionPlanId}`)
    )
    assertExecutionValidationCommandPlan(command, plan)
  }
  return manifest
}

export function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

export function portableEvaluationRunKey(evalRunId: string): string {
  return createHash('sha256').update(EvalRunSchema.shape.evalRunId.parse(evalRunId)).digest('hex')
}

function normalizeManifestInput(
  input: Omit<PortableExportManifest, 'contentDigest'>
): Omit<PortableExportManifest, 'contentDigest'> {
  return {
    ...input,
    componentVersions: Object.fromEntries(
      Object.entries(input.componentVersions).sort(([left], [right]) => left.localeCompare(right))
    ),
    compatibility: {
      ...input.compatibility,
      requiredCapabilities: [...new Set(input.compatibility.requiredCapabilities)].sort(),
    },
    records: [...input.records].sort(compareRecord),
    artifacts: [...input.artifacts].sort((left, right) => left.key.localeCompare(right.key)),
    secretReferences: [...input.secretReferences].sort((left, right) =>
      `${left.provider}:${left.key}:${left.version ?? ''}`.localeCompare(
        `${right.provider}:${right.key}:${right.version ?? ''}`
      )
    ),
    unsupportedReferences: [...new Set(input.unsupportedReferences)].sort(),
  }
}

function compareRecord(left: PortableRecord, right: PortableRecord): number {
  return `${left.category}:${left.logicalId}:${left.revision}`.localeCompare(
    `${right.category}:${right.logicalId}:${right.revision}`
  )
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('PORTABLE_VALUE_INVALID')
  return encoded
}
