import { z } from 'zod'
import { ModelExecutionTargetSchema, type ModelReadinessReason } from './selection.js'
import type { ModelQualification } from './selection-service.js'

/** Trusted deployment evidence, never accepted from a model-selection HTTP request. */
export const ModelQualificationRecordSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  providerModel: z.string().min(1).max(256),
  authKind: z.enum(['api_key', 'provider_subscription', 'local_runtime']),
  fundingSource: z.enum(['byo_api', 'external_subscription', 'hq_managed']),
  target: ModelExecutionTargetSchema,
  workspaceId: z.string().min(1).max(64),
  accountRef: z.string().min(1).max(256),
  policyAllowed: z.boolean(),
  quotaState: z.enum(['available', 'exhausted', 'unknown']),
  validUntil: z.iso.datetime(),
})

/** Exact provider/account/workspace/target allowlist with explicit policy and quota freshness. */
export class ConfiguredModelQualification implements ModelQualification {
  readonly #records: z.output<typeof ModelQualificationRecordSchema>[]
  constructor(
    records: unknown[],
    readonly now = () => new Date().toISOString()
  ) {
    this.#records = records.map((record) => ModelQualificationRecordSchema.parse(record))
  }
  async evaluate({
    connection,
    providerModel,
    target,
  }: Parameters<ModelQualification['evaluate']>[0]): Promise<ModelReadinessReason> {
    const identity = this.#records.filter(
      (record) =>
        record.provider === connection.provider &&
        record.providerModel === providerModel &&
        record.workspaceId === connection.workspaceId &&
        record.accountRef === connection.accountRef
    )
    if (!identity.length) return 'MODEL_UNAVAILABLE'
    const auth = identity.filter(
      (record) =>
        record.authKind === connection.authKind && record.fundingSource === connection.fundingSource
    )
    if (!auth.length) return 'AUTH_MODE_UNSUPPORTED'
    const harness = auth.filter(
      (record) =>
        record.target.harness === target.harness &&
        record.target.harnessVersion === target.harnessVersion &&
        record.target.providerBinding === target.providerBinding
    )
    if (!harness.length) return 'INCOMPATIBLE_HARNESS'
    const locations = harness.filter((record) => record.target.location === target.location)
    if (!locations.length) return 'INCOMPATIBLE_LOCATION'
    // Ambiguous or stale evidence fails closed instead of choosing the next policy record.
    if (locations.length !== 1) return 'READINESS_UNAVAILABLE'
    const record = locations[0]!
    const now = Date.parse(this.now())
    if (!Number.isFinite(now) || now >= Date.parse(record.validUntil))
      return 'READINESS_UNAVAILABLE'
    if (!record.policyAllowed) return 'PROVIDER_POLICY_DENIED'
    if (record.quotaState === 'exhausted') return 'QUOTA_EXHAUSTED'
    return record.quotaState === 'available' ? 'READY' : 'READINESS_UNAVAILABLE'
  }
}
