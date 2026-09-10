import { createHash, timingSafeEqual } from 'node:crypto'
import {
  ObjectStoreError,
  type ObjectStore,
  type StoredObject,
  type StoredObjectDescriptor,
} from '@control-plane/object-store'
import type { WorkflowRuntimeActivityPort } from './cloud-execution-activities.js'

const CONTENT_TYPE = 'application/json'
export const CLOUD_CERTIFICATION_OUTPUT_CONTRACT =
  'contract://control-plane/m9-cloud-certification/v1'

export class CloudCertificationRuntime implements WorkflowRuntimeActivityPort {
  constructor(readonly objectStore: ObjectStore) {}

  async dispatch(
    input: Parameters<WorkflowRuntimeActivityPort['dispatch']>[0]
  ): ReturnType<WorkflowRuntimeActivityPort['dispatch']> {
    const artifactId = artifactIdFromExecutionId(input.executionId)
    assertIdentity(input.executionId, input.attemptId, input.effectKey)
    if (input.executionPlan.outputContract.contractRef !== CLOUD_CERTIFICATION_OUTPUT_CONTRACT) {
      throw new Error('CLOUD_CERTIFICATION_PLAN_NOT_AUTHORIZED')
    }
    const key = objectKey(input.executionId, input.executionPlan.contentDigest)
    const metadata = {
      'execution-id': input.executionId,
      'attempt-id': input.attemptId,
    }
    const body = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'cloud-certification-result',
        artifactId,
        executionId: input.executionId,
        attemptId: input.attemptId,
        executionPlan: {
          executionPlanId: input.executionPlan.executionPlanId,
          contentDigest: input.executionPlan.contentDigest,
          schemaVersion: input.executionPlan.schemaVersion,
        },
        effectKey: input.effectKey,
      })
    )
    if (!(await this.#verifyRetained(key, body, metadata))) {
      await this.objectStore.put({
        key,
        body,
        contentType: CONTENT_TYPE,
        metadata,
      })
      if (!(await this.#verifyRetained(key, body, metadata))) {
        throw new Error('CLOUD_CERTIFICATION_ARTIFACT_MISSING_AFTER_WRITE')
      }
    }
    return { outcome: 'completed', resultReference: artifactId }
  }

  async applyInteraction(): ReturnType<WorkflowRuntimeActivityPort['applyInteraction']> {
    return {
      outcome: 'failed',
      failureCode: 'CLOUD_CERTIFICATION_INTERACTION_UNSUPPORTED',
      retryable: false,
    }
  }

  async cancel(): Promise<void> {}

  async cleanup(): Promise<void> {}

  async #verifyRetained(
    key: string,
    expectedBody: Uint8Array,
    expectedMetadata: Readonly<Record<string, string>>
  ): Promise<boolean> {
    let retained: StoredObject
    try {
      retained = await this.objectStore.get(key)
    } catch (error) {
      if (error instanceof ObjectStoreError && error.code === 'OBJECT_STORE_NOT_FOUND') return false
      throw error
    }
    const headed = await this.objectStore.head(key)
    assertDescriptor(key, retained, expectedBody, expectedMetadata)
    assertDescriptor(key, headed, expectedBody, expectedMetadata)
    if (
      retained.body.byteLength !== expectedBody.byteLength ||
      !timingSafeEqual(retained.body, expectedBody)
    ) {
      throw new Error('CLOUD_CERTIFICATION_ARTIFACT_CONFLICT')
    }
    return true
  }
}

function assertIdentity(executionId: string, attemptId: string, effectKey: string): void {
  const suffix = executionId.slice(4)
  if (
    attemptId !== `att_${suffix}` ||
    effectKey !== `wfl_${suffix}:execution-lifecycle-v1:dispatch`
  ) {
    throw new Error('CLOUD_CERTIFICATION_IDENTITY_MISMATCH')
  }
}

function objectKey(executionId: string, contentDigest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(contentDigest)) {
    throw new Error('CLOUD_CERTIFICATION_PLAN_DIGEST_INVALID')
  }
  return `m9/certification/executions/${executionId}/${contentDigest.slice(7)}.json`
}

function artifactIdFromExecutionId(executionId: string): string {
  if (!/^exe_[0-9A-HJKMNP-TV-Z]{26}$/.test(executionId)) {
    throw new Error('CLOUD_CERTIFICATION_EXECUTION_ID_INVALID')
  }
  return `art_${executionId.slice(4)}`
}

function assertDescriptor(
  key: string,
  descriptor: StoredObjectDescriptor,
  expectedBody: Uint8Array,
  expectedMetadata: Readonly<Record<string, string>>
): void {
  const expectedDigest = `sha256:${createHash('sha256').update(expectedBody).digest('hex')}`
  if (
    descriptor.key !== key ||
    descriptor.size !== expectedBody.byteLength ||
    descriptor.sha256 !== expectedDigest ||
    descriptor.contentType !== CONTENT_TYPE ||
    !sameRecord(descriptor.metadata, expectedMetadata)
  ) {
    throw new Error('CLOUD_CERTIFICATION_ARTIFACT_CONFLICT')
  }
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftEntries = Object.entries(left).toSorted(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).toSorted(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}
