import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  ContextAuthoringCommandRecordSchema,
  ContextAuthoringCommandScopeSchema,
  assertContextPackageIntegrity,
  type ContextAuthoringCommandRecord,
  type ContextAuthoringCommandRepository,
  type ContextAuthoringCommandScope,
  type ContextPackage,
} from '@control-plane/context'
import { eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { PostgresContextPackageRepository } from './context-package-repository.js'
import { contextAuthoringCommands } from './schema/context-authoring-commands.js'

export class PostgresContextAuthoringCommandRepository implements ContextAuthoringCommandRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  get(input: ContextAuthoringCommandScope): Promise<ContextAuthoringCommandRecord | undefined> {
    return read(this.database, ContextAuthoringCommandScopeSchema.parse(input))
  }

  commit(
    input: ContextAuthoringCommandRecord,
    packageInput: ContextPackage
  ): Promise<ContextAuthoringCommandRecord> {
    const record = ContextAuthoringCommandRecordSchema.parse(input)
    const package_ = assertContextPackageIntegrity(packageInput)
    if (
      record.scope.workspaceId !== package_.projectState.workspaceId ||
      record.scope.projectId !== package_.projectState.projectId ||
      record.contextPackage.contextPackageId !== package_.contextPackageId ||
      record.contextPackage.contentDigest !== package_.contentDigest
    )
      throw new Error('CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH')
    return this.database.transaction(async (transaction) => {
      // Transaction-scoped lock avoids persisting losing candidate packages.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${commandKey(record.scope)}, 0))`
      )
      const existing = await read(transaction, record.scope)
      if (existing) {
        if (existing.payloadHash !== record.payloadHash)
          throw new Error('CONTEXT_AUTHORING_COMMAND_CONFLICT')
        return existing
      }
      await new PostgresContextPackageRepository(transaction).put(package_)
      await transaction.insert(contextAuthoringCommands).values({
        commandKey: commandKey(record.scope),
        workspaceId: record.scope.workspaceId,
        projectId: record.scope.projectId,
        contextPackageId: package_.contextPackageId,
        record,
      })
      return record
    })
  }
}

async function read(
  database: Pick<ControlPlaneDatabase, 'select' | 'insert'>,
  scope: ContextAuthoringCommandScope
): Promise<ContextAuthoringCommandRecord | undefined> {
  const [row] = await database
    .select()
    .from(contextAuthoringCommands)
    .where(eq(contextAuthoringCommands.commandKey, commandKey(scope)))
    .limit(1)
  if (!row) return undefined
  const record = ContextAuthoringCommandRecordSchema.parse(row.record)
  if (
    !isDeepStrictEqual(record.scope, scope) ||
    row.workspaceId !== scope.workspaceId ||
    row.projectId !== scope.projectId ||
    row.contextPackageId !== record.contextPackage.contextPackageId
  )
    throw new Error('CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH')
  const package_ = await new PostgresContextPackageRepository(database).get(record.contextPackage)
  if (!package_) throw new Error('CONTEXT_AUTHORING_COMMAND_PACKAGE_MISSING')
  if (
    package_.projectState.workspaceId !== scope.workspaceId ||
    package_.projectState.projectId !== scope.projectId
  )
    throw new Error('CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH')
  return record
}

function commandKey(scope: ContextAuthoringCommandScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.principalRef,
        scope.workspaceId,
        scope.projectId,
        scope.operation,
        scope.idempotencyKey,
      ])
    )
    .digest('hex')
}
