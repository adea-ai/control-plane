import { eq, sql, type SQL } from 'drizzle-orm'
import { AdmissionRolloutError } from '@control-plane/domain'
import type { ControlPlaneDatabase } from './connection.js'
import { admissionRolloutGate } from './schema/admission-rollout.js'

const ADMISSION_ROLLOUT_GATE_KEY = 'intake'
const ADMISSION_ROLLOUT_ADVISORY_LOCK_ID = 724_193_560_984_241

export { AdmissionRolloutError, type AdmissionRolloutErrorCode } from '@control-plane/domain'

interface AdvisoryLockTransaction {
  execute(query: SQL): Promise<unknown>
}

export interface AdmissionRolloutStatus {
  readonly state: 'open' | 'paused'
  readonly revision: number
  readonly updatedAt: Date
  readonly updatedBy: string
}

/** Shared lock used by every new-owner writer before it takes domain locks. */
export async function acquireAdmissionRolloutSharedLock(
  transaction: AdvisoryLockTransaction
): Promise<void> {
  try {
    await transaction.execute(
      sql`select pg_advisory_xact_lock_shared(${ADMISSION_ROLLOUT_ADVISORY_LOCK_ID})`
    )
  } catch {
    throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
  }
}

/** Fail closed for a missing, malformed, or paused gate row. */
export async function assertAdmissionRolloutOpen(
  transaction: AdvisoryLockTransaction
): Promise<void> {
  try {
    const result = await transaction.execute(
      sql`select gate_key, state, schema_version, revision, updated_at, updated_by from admission_rollout_gate where gate_key = ${ADMISSION_ROLLOUT_GATE_KEY}`
    )
    const row = resultRows(result)[0]
    const status = statusFromUnknownRow(row)
    if (status.state !== 'open') throw new AdmissionRolloutError('ADMISSION_ROLLOUT_PAUSED')
  } catch (error) {
    if (error instanceof AdmissionRolloutError) throw error
    throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
  }
}

/** Durable intake pause. Audit/resume support is intentionally implemented separately. */
export class PostgresAdmissionRolloutService {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async getStatus(): Promise<AdmissionRolloutStatus> {
    try {
      const [row] = await this.database
        .select()
        .from(admissionRolloutGate)
        .where(eq(admissionRolloutGate.gateKey, ADMISSION_ROLLOUT_GATE_KEY))
        .limit(1)
      if (!row) throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
      return statusFromRow(row)
    } catch (error) {
      if (error instanceof AdmissionRolloutError) throw error
      throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
    }
  }

  async pause(): Promise<AdmissionRolloutStatus> {
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${ADMISSION_ROLLOUT_ADVISORY_LOCK_ID})`
        )
        const authority = await transaction.execute(
          sql`select current_user as operator_role, has_table_privilege(current_user, 'public.admission_rollout_gate', 'UPDATE') as may_update`
        )
        const authorityRow = resultRows(authority)[0]
        if (!isRecord(authorityRow) || authorityRow['may_update'] !== true)
          throw new AdmissionRolloutError('ADMISSION_ROLLOUT_AUTHORITY_DENIED')
        if (
          typeof authorityRow['operator_role'] !== 'string' ||
          authorityRow['operator_role'].length === 0
        )
          throw new AdmissionRolloutError('ADMISSION_ROLLOUT_AUTHORITY_DENIED')

        const [row] = await transaction
          .select()
          .from(admissionRolloutGate)
          .where(eq(admissionRolloutGate.gateKey, ADMISSION_ROLLOUT_GATE_KEY))
          .limit(1)
          .for('update')
        if (!row) throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
        const status = statusFromRow(row)
        if (status.state === 'open') {
          if (status.revision === Number.MAX_SAFE_INTEGER)
            throw new AdmissionRolloutError('ADMISSION_ROLLOUT_STATE_INVALID')
          const [updated] = await transaction
            .update(admissionRolloutGate)
            .set({
              state: 'paused',
              revision: status.revision + 1,
              updatedAt: new Date(),
              updatedBy: authorityRow['operator_role'],
            })
            .where(eq(admissionRolloutGate.gateKey, ADMISSION_ROLLOUT_GATE_KEY))
            .returning()
          if (!updated) throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
          return statusFromRow(updated)
        }
        return status
      })
    } catch (error) {
      if (error instanceof AdmissionRolloutError) throw error
      throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
    }
  }
}

function statusFromRow(row: typeof admissionRolloutGate.$inferSelect): AdmissionRolloutStatus {
  return statusFromValues(
    row.gateKey,
    row.state,
    row.schemaVersion,
    row.revision,
    row.updatedAt,
    row.updatedBy
  )
}

function statusFromUnknownRow(value: unknown): AdmissionRolloutStatus {
  if (!isRecord(value)) throw new AdmissionRolloutError('ADMISSION_ROLLOUT_GATE_UNAVAILABLE')
  return statusFromValues(
    value['gate_key'],
    value['state'],
    value['schema_version'],
    value['revision'],
    value['updated_at'],
    value['updated_by']
  )
}

function statusFromValues(
  gateKey: unknown,
  state: unknown,
  schemaVersion: unknown,
  revision: unknown,
  updatedAt: unknown,
  updatedBy: unknown
): AdmissionRolloutStatus {
  if (gateKey !== ADMISSION_ROLLOUT_GATE_KEY || schemaVersion !== 1)
    throw new AdmissionRolloutError('ADMISSION_ROLLOUT_STATE_INVALID')
  if (state !== 'open' && state !== 'paused')
    throw new AdmissionRolloutError('ADMISSION_ROLLOUT_STATE_INVALID')
  const parsedRevision =
    typeof revision === 'number'
      ? revision
      : typeof revision === 'string' && /^\d+$/.test(revision)
        ? Number(revision)
        : Number.NaN
  if (!Number.isSafeInteger(parsedRevision) || parsedRevision < 0)
    throw new AdmissionRolloutError('ADMISSION_ROLLOUT_STATE_INVALID')
  const parsedUpdatedAt =
    updatedAt instanceof Date
      ? updatedAt
      : typeof updatedAt === 'string'
        ? new Date(updatedAt)
        : new Date(Number.NaN)
  if (Number.isNaN(parsedUpdatedAt.getTime()))
    throw new AdmissionRolloutError('ADMISSION_ROLLOUT_STATE_INVALID')
  if (typeof updatedBy !== 'string' || updatedBy.length === 0 || updatedBy.length > 64)
    throw new AdmissionRolloutError('ADMISSION_ROLLOUT_STATE_INVALID')
  return { state, revision: parsedRevision, updatedAt: parsedUpdatedAt, updatedBy }
}

function resultRows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
