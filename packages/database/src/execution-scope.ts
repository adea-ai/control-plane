import {
  executionScopeOf,
  executionRetentionScope,
  RetentionHoldScopeSchema,
  type ExecutionScope,
} from '@control-plane/domain'

/** Reconstruct scope without adding versioned fields to legacy project objects. */
export function executionScopeFieldsFromRow(row: {
  readonly workspaceId: string
  readonly projectId: string | null
  readonly executionScope?: ExecutionScope | null
}) {
  const fields = {
    ...(row.projectId === null ? {} : { projectId: row.projectId }),
    ...(row.executionScope == null ? {} : { executionScope: row.executionScope }),
  }
  executionScopeOf({ workspaceId: row.workspaceId, ...fields })
  return fields
}

export function executionRetentionScopeFromRow(row: {
  readonly workspaceId: string
  readonly projectId: string | null
  readonly executionScope?: ExecutionScope | null
}) {
  const target = executionRetentionScope({
    workspaceId: row.workspaceId,
    ...executionScopeFieldsFromRow(row),
  })
  const { executionScope: _executionScope, ...owner } = target
  return {
    ...RetentionHoldScopeSchema.parse(owner),
    ...(target.kind === 'workspace' ? { executionScope: target.executionScope } : {}),
  }
}
