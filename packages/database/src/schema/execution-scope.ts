import type { ExecutionScope } from '@control-plane/domain'
import { sql } from 'drizzle-orm'
import { check, jsonb, type AnyPgColumn } from 'drizzle-orm/pg-core'

/** Null preserves the original project-only wire representation. */
export const executionScopeColumn = () => jsonb('execution_scope').$type<ExecutionScope>()

/** Scope is explicit for workspace rows and must agree with a real project column. */
export function executionScopeCheck(
  name: string,
  table: { readonly projectId: AnyPgColumn; readonly executionScope: AnyPgColumn }
) {
  return check(
    name,
    sql`((${table.executionScope} is null and ${table.projectId} is not null) or (${table.projectId} is null and ${table.executionScope} = '{"schemaVersion":1,"kind":"workspace"}'::jsonb) or (${table.projectId} is not null and ${table.executionScope} = jsonb_build_object('schemaVersion', 1, 'kind', 'project', 'projectId', ${table.projectId}))) is true`
  )
}
