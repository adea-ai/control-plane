import { and, asc, eq, sql } from 'drizzle-orm'
import {
  ModelConnectionSchema,
  RuntimeProviderSelectionSchema,
  WorkspaceModelDefaultsSchema,
  validConnectionUpdate,
  type ModelConnection,
  type ModelSelectionRepository,
  type RuntimeProviderSelection,
  type WorkspaceModelDefaults,
} from '@control-plane/model-gateway'
import type { ControlPlaneDatabase } from './connection.js'
import { modelSelectionRecords as table } from './schema/model-selections.js'

type Kind = typeof table.$inferSelect.kind
type Transaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]
const predicate = (workspaceId: string, kind: Kind, ref: string) =>
  and(eq(table.workspaceId, workspaceId), eq(table.kind, kind), eq(table.ref, ref))

export class PostgresModelSelectionRepository implements ModelSelectionRepository {
  constructor(readonly database: ControlPlaneDatabase) {}
  async getConnection(workspaceId: string, ref: string) {
    const row = await this.#get(workspaceId, 'connection', ref)
    if (!row) return undefined
    const value = ModelConnectionSchema.parse(row.record)
    if (value.workspaceId !== workspaceId || value.connectionRef !== ref)
      throw new Error('MODEL_STORE_SCOPE_MISMATCH')
    return value
  }
  async listConnections(workspaceId: string) {
    const rows = await this.database
      .select()
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.kind, 'connection')))
      .orderBy(asc(table.ref))
      .limit(129)
    if (rows.length > 128) throw new Error('MODEL_STORE_LIMIT_EXCEEDED')
    return rows.map((row) => {
      const value = ModelConnectionSchema.parse(row.record)
      if (value.workspaceId !== workspaceId || value.connectionRef !== row.ref)
        throw new Error('MODEL_STORE_SCOPE_MISMATCH')
      return value
    })
  }
  async saveConnection(expectedRevision: number, input: ModelConnection) {
    const next = ModelConnectionSchema.parse(input)
    return this.database.transaction(async (tx) => {
      await lock(tx, next.workspaceId, 'connection')
      const [row] = await tx
        .select()
        .from(table)
        .where(predicate(next.workspaceId, 'connection', next.connectionRef))
        .limit(1)
      if (
        !validConnectionUpdate(
          row ? ModelConnectionSchema.parse(row.record) : undefined,
          expectedRevision,
          next
        )
      )
        return false
      if (
        !row &&
        (
          await tx
            .select({ ref: table.ref })
            .from(table)
            .where(and(eq(table.workspaceId, next.workspaceId), eq(table.kind, 'connection')))
            .limit(128)
        ).length >= 128
      )
        return false
      if (row)
        await tx
          .update(table)
          .set({ record: next })
          .where(predicate(next.workspaceId, 'connection', next.connectionRef))
      else
        await tx.insert(table).values({
          workspaceId: next.workspaceId,
          kind: 'connection',
          ref: next.connectionRef,
          record: next,
        })
      return true
    })
  }
  async getDefaults(workspaceId: string) {
    const row = await this.#get(workspaceId, 'defaults', 'defaults')
    if (!row) return undefined
    const value = WorkspaceModelDefaultsSchema.parse(row.record)
    if (value.workspaceId !== workspaceId) throw new Error('MODEL_STORE_SCOPE_MISMATCH')
    return value
  }
  async saveDefaults(expectedRevision: number, input: WorkspaceModelDefaults) {
    const next = WorkspaceModelDefaultsSchema.parse(input)
    return this.database.transaction(async (tx) => {
      await lock(tx, next.workspaceId, 'defaults')
      const [row] = await tx
        .select()
        .from(table)
        .where(predicate(next.workspaceId, 'defaults', 'defaults'))
        .limit(1)
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        (row ? WorkspaceModelDefaultsSchema.parse(row.record).revision : 0) !== expectedRevision ||
        next.revision !== expectedRevision + 1
      )
        return false
      if (row)
        await tx
          .update(table)
          .set({ record: next })
          .where(predicate(next.workspaceId, 'defaults', 'defaults'))
      else
        await tx.insert(table).values({
          workspaceId: next.workspaceId,
          kind: 'defaults',
          ref: 'defaults',
          record: next,
        })
      return true
    })
  }
  async insertSelection(input: RuntimeProviderSelection) {
    const next = RuntimeProviderSelectionSchema.parse(input)
    const inserted = await this.database
      .insert(table)
      .values({
        workspaceId: next.workspaceId,
        kind: 'selection',
        ref: next.selectionRef,
        record: next,
      })
      .onConflictDoNothing()
      .returning({ ref: table.ref })
    return inserted.length === 1
  }
  async getSelection(workspaceId: string, ref: string) {
    const row = await this.#get(workspaceId, 'selection', ref)
    if (!row) return undefined
    const value = RuntimeProviderSelectionSchema.parse(row.record)
    if (value.workspaceId !== workspaceId || value.selectionRef !== ref)
      throw new Error('MODEL_STORE_SCOPE_MISMATCH')
    return value
  }
  async #get(workspaceId: string, kind: Kind, ref: string) {
    const [row] = await this.database
      .select()
      .from(table)
      .where(predicate(workspaceId, kind, ref))
      .limit(1)
    return row
  }
}
async function lock(tx: Transaction, workspaceId: string, kind: Kind) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['model-selections', workspaceId, kind])}, 0))`
  )
}
