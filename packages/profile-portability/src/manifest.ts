import { createHash } from 'node:crypto'
import { canonicalJsonStringify, compareCodePointOrder } from '@control-plane/domain'
import { DeploymentProfiles, type JsonValue } from '@control-plane/deployment'
import { z } from 'zod'
import { EvalRunSchema } from '@control-plane/production-readiness'
import { PortableCredentialMetadataSchema } from '@control-plane/credential-vault'
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

/** Reader-first opt-in: existing export callers keep their unversioned writer. */
export const PORTABLE_CANONICAL_DIGEST_VERSION = 'code-point-v2' as const
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
  'credential-metadata',
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
    digestVersion: z.literal(PORTABLE_CANONICAL_DIGEST_VERSION).optional(),
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
  const canonical = manifest.digestVersion === PORTABLE_CANONICAL_DIGEST_VERSION
  // Historical arrays are already in the writer's normalized order. Preserve
  // that order and the retained digest, rather than normalizing them with the
  // reader's host locale. The pre-#614 epoch also used en-US object-key sorting;
  // the later unversioned epoch uses code-point object keys with locale arrays.
  const order = canonical ? compareCodePointOrder : historicalManifestOrder(unsigned, contentDigest)
  const expected = canonical
    ? canonicalDigest(normalizeCanonicalManifestInput(unsigned))
    : digestWithOrder(unsigned, order)
  if (expected !== contentDigest) throw new Error('PORTABLE_MANIFEST_DIGEST_INVALID')
  for (const record of manifest.records) {
    const { contentDigest: recordDigest, ...recordUnsigned } = record
    const expectedRecord = canonical
      ? canonicalDigest(recordUnsigned)
      : digestWithOrder(recordUnsigned, order)
    if (expectedRecord !== recordDigest) {
      throw new Error('PORTABLE_RECORD_DIGEST_INVALID')
    }
    if (record.category === 'context-package' || record.category === 'execution-plan') {
      // Preserve the historical import-time integrity checks for v1 payloads.
      const version = z
        .object({ schemaVersion: z.number().int().positive() })
        .safeParse(record.value)
      if (version.success && version.data.schemaVersion !== 1)
        throw new Error('PORTABLE_WORKSPACE_SCOPE_UNSUPPORTED')
    }
    if (record.category === 'credential-metadata') {
      // Strict parsing rejects any secret value, secret reference or status in the manifest.
      const credential = PortableCredentialMetadataSchema.parse(record.value)
      if (
        record.logicalId !== `credentials/${credential.credentialId}` ||
        record.revision !== credential.revision
      )
        throw new Error('PORTABLE_CREDENTIAL_IDENTITY_INVALID')
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
    (candidateRecord) => candidateRecord.category === 'context-authoring-command'
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
    (candidateRecord) => candidateRecord.category === 'execution-validation-command'
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

// CANONICAL-JSON: unversioned record/writer bytes remain unchanged during the
// #612 reader-first deployment. New canonical manifest digests opt in through
// PORTABLE_CANONICAL_DIGEST_VERSION; legacy verification never rewrites data.
export function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}

type PortableKeyOrder = (left: string, right: string) => number

function digestWithOrder(value: unknown, order: PortableKeyOrder): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(historicalStableJson(value, order)).digest('hex')}`
}

function historicalManifestOrder(
  unsigned: Omit<PortableExportManifest, 'contentDigest'>,
  digest: string
): PortableKeyOrder {
  if (digestWithOrder(unsigned, compareCodePointOrder) === digest) return compareCodePointOrder
  // Explicit historical profile, never the reader's ambient locale. Other
  // undocumented historical collations fail verification; no hash is replaced.
  const legacyOrder = new Intl.Collator('en-US').compare
  if (digestWithOrder(unsigned, legacyOrder) === digest) return legacyOrder
  throw new Error('PORTABLE_MANIFEST_DIGEST_INVALID')
}

export function portableEvaluationRunKey(evalRunId: string): string {
  return createHash('sha256').update(EvalRunSchema.shape.evalRunId.parse(evalRunId)).digest('hex')
}

function normalizeManifestInput(
  input: Omit<PortableExportManifest, 'contentDigest'>
): Omit<PortableExportManifest, 'contentDigest'> {
  if (Object.hasOwn(input, 'digestVersion'))
    throw new Error('PORTABLE_DIGEST_WRITER_VERSION_UNSUPPORTED')
  return {
    ...input,
    componentVersions: Object.fromEntries(
      Object.entries(input.componentVersions).toSorted(([left], [right]) =>
        compareCodePointOrder(left, right)
      )
    ),
    compatibility: {
      ...input.compatibility,
      requiredCapabilities: [...new Set(input.compatibility.requiredCapabilities)].toSorted(),
    },
    records: [...input.records].toSorted(compareRecord),
    artifacts: [...input.artifacts].toSorted((left, right) =>
      compareCodePointOrder(left.key, right.key)
    ),
    secretReferences: [...input.secretReferences].toSorted((left, right) =>
      `${left.provider}:${left.key}:${left.version ?? ''}`.localeCompare(
        `${right.provider}:${right.key}:${right.version ?? ''}`
      )
    ),
    unsupportedReferences: [...new Set(input.unsupportedReferences)].toSorted(),
  }
}

function compareRecord(left: PortableRecord, right: PortableRecord): number {
  return `${left.category}:${left.logicalId}:${left.revision}`.localeCompare(
    `${right.category}:${right.logicalId}:${right.revision}`
  )
}

function canonicalTieBreak(
  left: unknown,
  right: unknown,
  version: PortableExportManifest['digestVersion']
): number {
  return version === PORTABLE_CANONICAL_DIGEST_VERSION
    ? compareCodePointOrder(canonicalJsonStringify(left), canonicalJsonStringify(right))
    : 0
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => compareCodePointOrder(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('PORTABLE_VALUE_INVALID')
  return encoded
}

/** Explicit opt-in writer. Deploy compatible readers before using this format. */
export function finalizeCanonicalPortableManifest(
  input: Omit<PortableExportManifest, 'contentDigest'>
): PortableExportManifest {
  z.literal(PORTABLE_CANONICAL_DIGEST_VERSION).parse(input.digestVersion)
  const normalized = normalizeCanonicalManifestInput(input)
  return PortableExportManifestSchema.parse({
    ...normalized,
    contentDigest: canonicalDigest(normalized),
  })
}

function normalizeCanonicalManifestInput(
  input: Omit<PortableExportManifest, 'contentDigest'>
): Omit<PortableExportManifest, 'contentDigest'> {
  return {
    ...input,
    componentVersions: Object.fromEntries(
      Object.entries(input.componentVersions).toSorted(([left], [right]) =>
        compareCodePointOrder(left, right)
      )
    ),
    compatibility: {
      ...input.compatibility,
      requiredCapabilities: [...new Set(input.compatibility.requiredCapabilities)].toSorted(),
    },
    records: [...input.records].toSorted(
      (left, right) =>
        compareCodePointOrder(
          `${left.category}:${left.logicalId}:${left.revision}`,
          `${right.category}:${right.logicalId}:${right.revision}`
        ) || canonicalTieBreak(left, right, input.digestVersion)
    ),
    artifacts: [...input.artifacts].toSorted(
      (left, right) =>
        compareCodePointOrder(left.key, right.key) ||
        canonicalTieBreak(left, right, input.digestVersion)
    ),
    secretReferences: [...input.secretReferences].toSorted(
      (left, right) =>
        compareCodePointOrder(
          `${left.provider}:${left.key}:${left.version ?? ''}`,
          `${right.provider}:${right.key}:${right.version ?? ''}`
        ) || canonicalTieBreak(left, right, input.digestVersion)
    ),
    unsupportedReferences: [...new Set(input.unsupportedReferences)].toSorted(),
  }
}

function historicalStableJson(value: unknown, order: PortableKeyOrder): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => historicalStableJson(entry, order)).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => order(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${historicalStableJson(child, order)}`)
      .join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('PORTABLE_VALUE_INVALID')
  return encoded
}
