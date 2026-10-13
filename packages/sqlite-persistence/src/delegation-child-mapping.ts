import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { PersistenceTransaction } from '@control-plane/deployment'
import {
  ChildAdmissionReceiptSchema,
  ChildAdmissionRequestSchema,
  type ChildAdmissionReceipt,
  type ChildAdmissionRequest,
} from '@control-plane/orchestration'
import { json, recordId } from './record-storage.js'

export const ChildJobMappingSchema = ChildAdmissionReceiptSchema.pick({
  workspaceId: true,
  parentExecutionId: true,
  delegationId: true,
  childExecutionId: true,
  childAttemptId: true,
}).extend({
  runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
  externalSessionId: IdentifierSchemas.externalSessionId.optional(),
})

/** The CP job identity is childExecutionId; native session identity is runtime-qualified. */
export type ChildJobMapping = ReturnType<typeof ChildJobMappingSchema.parse>
export interface StoredChildAdmissionReceipt {
  readonly request: ChildAdmissionRequest
  readonly receipt: ChildAdmissionReceipt
}
export const childMappingNamespace = 'delegation-child-mappings'
export const childAdmissionNamespace = 'delegation-admission-receipts'
export const childSessionNamespace = 'delegation-native-sessions'

export async function retainChildMapping(
  tx: PersistenceTransaction,
  input: ChildJobMapping
): Promise<void> {
  const mapping = ChildJobMappingSchema.parse(input)
  const id = recordId(mapping.childAttemptId)
  const existing = await tx.get(childMappingNamespace, id)
  if (existing) {
    const prior = ChildJobMappingSchema.parse(existing.value)
    // Session assignment may complete an admitted mapping, but never rebind it.
    if (
      canonicalJsonStringify({ ...prior, externalSessionId: undefined }) !==
        canonicalJsonStringify({ ...mapping, externalSessionId: undefined }) ||
      (prior.externalSessionId !== undefined &&
        prior.externalSessionId !== mapping.externalSessionId)
    )
      throw new Error('DELEGATION_CHILD_MAPPING_CONFLICT')
  }
  if (mapping.externalSessionId) {
    const sessionId = recordId(
      canonicalJsonStringify([mapping.runtimeConnectionId, mapping.externalSessionId])
    )
    const session = await tx.get(childSessionNamespace, sessionId)
    if (session && canonicalJsonStringify(session.value) !== canonicalJsonStringify(mapping))
      throw new Error('DELEGATION_CHILD_MAPPING_CONFLICT')
    if (!session)
      await tx.put({ namespace: childSessionNamespace, id: sessionId, value: json(mapping) })
  }
  await tx.put({
    namespace: childMappingNamespace,
    id,
    ...(existing ? { expectedRevision: existing.revision } : {}),
    value: json(mapping),
  })
}

export async function retainChildAdmission(
  tx: PersistenceTransaction,
  input: StoredChildAdmissionReceipt
): Promise<void> {
  const request = ChildAdmissionRequestSchema.parse(input.request)
  const receipt = ChildAdmissionReceiptSchema.parse(input.receipt)
  await retainChildMapping(tx, {
    workspaceId: request.workspaceId,
    parentExecutionId: request.parentExecutionId,
    delegationId: request.delegationId,
    childExecutionId: request.childExecutionId,
    childAttemptId: request.childAttemptId,
    runtimeConnectionId: request.childDispatch.runtime.runtimeConnectionId,
    ...(request.childDispatch.runtime.externalSessionId
      ? { externalSessionId: request.childDispatch.runtime.externalSessionId }
      : {}),
  })
  await tx.put({
    namespace: childAdmissionNamespace,
    id: recordId(request.delegationId),
    value: json({ request, receipt }),
  })
}
