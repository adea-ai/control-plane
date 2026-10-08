import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
import {
  DelegationToolAdmissionSchema,
  type DelegationToolAdmission,
  type DelegationToolAdmissionRepository,
} from '@control-plane/orchestration'
import { ExecutionSchema, ExecutionAttemptSchema } from '@control-plane/domain'
import { assertSqliteStoredPlanReference } from './repositories.js'
import { json, recordId } from './record-storage.js'

/** Immutable full request and compiler receipt, separately from effect outcomes. */
export class SqliteDelegationToolAdmissionRepository implements DelegationToolAdmissionRepository {
  readonly #workspaceId: string
  readonly #namespace: string
  readonly #sources: string
  readonly #calls: string

  constructor(
    readonly provider: Pick<PersistenceProvider, 'transaction'>,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
    this.#namespace = `delegation-tool-admissions-${this.#workspaceId.toLowerCase()}`
    this.#sources = `delegation-tool-sources-${this.#workspaceId.toLowerCase()}`
    this.#calls = `delegation-tool-call-admissions-${this.#workspaceId.toLowerCase()}`
  }

  async retain(input: DelegationToolAdmission) {
    const admission = DelegationToolAdmissionSchema.parse(input)
    if (admission.request.workspaceId !== this.#workspaceId)
      throw new Error('DELEGATION_TOOL_ADMISSION_SCOPE_DENIED')
    const id = recordId(admission.request.requestId)
    return this.provider.transaction(async (tx) => {
      const existing = await tx.get(this.#namespace, id)
      if (existing) {
        const stored = DelegationToolAdmissionSchema.parse(existing.value)
        if (canonicalJsonStringify(stored) !== canonicalJsonStringify(admission))
          throw new Error('DELEGATION_TOOL_ADMISSION_CONFLICT')
        await this.#assertIndexes(tx, stored)
        return { admission: stored, replayed: true }
      }
      const parentPlan = admission.command.delegation.parentPlan
      await assertSqliteStoredPlanReference(tx, {
        executionPlanId: parentPlan.executionPlanId,
        contentDigest: parentPlan.contentDigest,
        schemaVersion: parentPlan.schemaVersion,
      })
      const execution = ExecutionSchema.parse(
        (await tx.get('executions', recordId(admission.request.executionId)))?.value
      )
      const attempt = ExecutionAttemptSchema.parse(
        (await tx.get('execution-attempts', recordId(admission.request.attemptId)))?.value
      )
      if (
        execution.executionId !== admission.request.executionId ||
        attempt.attemptId !== admission.request.attemptId ||
        execution.executionPlan?.executionPlanId !== parentPlan.executionPlanId ||
        execution.executionPlan.contentDigest !== parentPlan.contentDigest ||
        execution.executionPlan.schemaVersion !== parentPlan.schemaVersion ||
        canonicalJsonStringify(execution.correlation) !==
          canonicalJsonStringify(parentPlan.correlation) ||
        execution.correlation.workspaceId !== this.#workspaceId ||
        attempt.executionId !== execution.executionId
      )
        throw new Error('DELEGATION_TOOL_ADMISSION_SCOPE_DENIED')
      const sourceId = admission.sourceKey.slice('pi-tool:'.length)
      const callId = recordId(admission.request.toolCallId)
      if ((await tx.get(this.#sources, sourceId)) || (await tx.get(this.#calls, callId)))
        throw new Error('DELEGATION_TOOL_ADMISSION_CONFLICT')
      await tx.put({ namespace: this.#namespace, id, value: json(admission) })
      await tx.put({
        namespace: this.#sources,
        id: sourceId,
        value: { requestId: admission.request.requestId },
      })
      await tx.put({
        namespace: this.#calls,
        id: callId,
        value: { requestId: admission.request.requestId },
      })
      return { admission, replayed: false }
    })
  }

  async getByRequestId(input: string): Promise<DelegationToolAdmission | undefined> {
    const requestId = IdentifierSchemas.requestId.parse(input)
    return this.provider.transaction(async (tx) => {
      const row = await tx.get(this.#namespace, recordId(requestId))
      if (!row) return undefined
      const admission = DelegationToolAdmissionSchema.parse(row.value)
      if (
        admission.request.requestId !== requestId ||
        admission.request.workspaceId !== this.#workspaceId
      )
        throw new Error('DELEGATION_TOOL_ADMISSION_SCOPE_DENIED')
      await this.#assertIndexes(tx, admission)
      return admission
    })
  }

  async #assertIndexes(tx: PersistenceTransaction, admission: DelegationToolAdmission) {
    for (const [namespace, id] of [
      [this.#sources, admission.sourceKey.slice('pi-tool:'.length)],
      [this.#calls, recordId(admission.request.toolCallId)],
    ] as const) {
      const index = await tx.get(namespace, id)
      if (
        !index ||
        (index.value as { requestId?: unknown }).requestId !== admission.request.requestId
      )
        throw new Error('DELEGATION_TOOL_ADMISSION_CONFLICT')
    }
  }
}
