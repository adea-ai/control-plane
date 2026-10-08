import { z } from 'zod'
import { IdentifierSchemas } from './identifiers.js'

/** Scope describes a target. It is never evidence of permission to execute. */
export const ExecutionScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('workspace') }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('project'),
    projectId: IdentifierSchemas.projectId,
  }),
])
export type ExecutionScope = z.output<typeof ExecutionScopeSchema>

export const executionScopeFields = {
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId.optional(),
  executionScope: ExecutionScopeSchema.optional(),
}

export interface ExecutionScopeFields {
  readonly workspaceId: string
  readonly projectId?: string | undefined
  readonly executionScope?: ExecutionScope | undefined
}

export function validateExecutionScopeFields(
  input: ExecutionScopeFields,
  context: z.RefinementCtx
): void {
  const scope = input.executionScope
  if (
    scope === undefined
      ? input.projectId === undefined
      : scope.kind === 'workspace'
        ? input.projectId !== undefined
        : input.projectId !== scope.projectId
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Execution scope must be explicit or a real legacy project',
      path: ['executionScope'],
    })
  }
}

export const ExecutionScopeFieldsSchema = z
  .object(executionScopeFields)
  .superRefine(validateExecutionScopeFields)

/** Normalize for comparisons only. Never spread this result into historical objects. */
export function executionScopeOf(input: ExecutionScopeFields): ExecutionScope {
  const parsed = ExecutionScopeFieldsSchema.parse(input)
  return (
    parsed.executionScope ?? { schemaVersion: 1, kind: 'project', projectId: parsed.projectId! }
  )
}

export function executionScopesEqual(
  left: ExecutionScopeFields,
  right: ExecutionScopeFields
): boolean {
  if (
    !ExecutionScopeFieldsSchema.safeParse(left).success ||
    !ExecutionScopeFieldsSchema.safeParse(right).success
  )
    return false
  const a = executionScopeOf(left)
  const b = executionScopeOf(right)
  return (
    left.workspaceId === right.workspaceId &&
    a.kind === b.kind &&
    (a.kind === 'workspace' || (b.kind === 'project' && a.projectId === b.projectId))
  )
}

/** Structural narrowing only; current authority and real-project membership must be verified separately. */
export function executionScopeCanNarrow(
  parent: ExecutionScopeFields,
  child: ExecutionScopeFields
): boolean {
  if (
    !ExecutionScopeFieldsSchema.safeParse(parent).success ||
    !ExecutionScopeFieldsSchema.safeParse(child).success
  )
    return false
  return (
    parent.workspaceId === child.workspaceId &&
    (executionScopeOf(parent).kind === 'workspace' || executionScopesEqual(parent, child))
  )
}

export function executionRetentionScope(input: ExecutionScopeFields) {
  const parsed = ExecutionScopeFieldsSchema.parse(input)
  const scope = executionScopeOf(parsed)
  return scope.kind === 'workspace'
    ? { kind: 'workspace' as const, workspaceId: parsed.workspaceId, executionScope: scope }
    : { kind: 'project' as const, workspaceId: parsed.workspaceId, projectId: scope.projectId }
}
