import { IdentifierSchemas } from '@control-plane/contracts'
import {
  GraphReferenceSchema,
  PublishedGraphDefinitionSchema,
  graphDefinitionUpdateIsValid,
  type GraphDefinitionRepository,
  type PublishedGraphDefinition,
} from '@control-plane/orchestration'
import { and, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { graphDefinitionVersions } from './schema/graph-definitions.js'

/** Scope is fixed by composition, never inferred from caller-owned graph content. */
export class PostgresGraphDefinitionRepository implements GraphDefinitionRepository {
  readonly #workspaceId: string

  constructor(
    readonly database: ControlPlaneDatabase,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
  }

  async insert(input: PublishedGraphDefinition): Promise<boolean> {
    const definition = PublishedGraphDefinitionSchema.parse(input)
    const inserted = await this.database
      .insert(graphDefinitionVersions)
      .values({
        workspaceId: this.#workspaceId,
        graphDefinitionId: definition.reference.graphDefinitionId,
        graphVersion: definition.reference.graphVersion,
        revision: definition.revision,
        definition,
      })
      .onConflictDoNothing()
      .returning({ graphDefinitionId: graphDefinitionVersions.graphDefinitionId })
    if (inserted.length === 1) return true
    // A duplicate must not hide an inconsistent persisted pin.
    await this.get(definition.reference.graphDefinitionId, definition.reference.graphVersion)
    return false
  }

  async get(
    graphDefinitionId: string,
    graphVersion: string
  ): Promise<PublishedGraphDefinition | undefined> {
    const [row] = await this.database
      .select()
      .from(graphDefinitionVersions)
      .where(this.#scope(graphDefinitionId, graphVersion))
      .limit(1)
    return row === undefined ? undefined : this.#parse(row)
  }

  async compareAndSet(expectedRevision: number, input: PublishedGraphDefinition): Promise<boolean> {
    const parsed = PublishedGraphDefinitionSchema.safeParse(input)
    if (!parsed.success) return false
    const next = parsed.data
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return false
    return this.database.transaction(async (transaction) => {
      const scope = this.#scope(next.reference.graphDefinitionId, next.reference.graphVersion)
      const [row] = await transaction
        .select()
        .from(graphDefinitionVersions)
        .where(scope)
        .limit(1)
        .for('update')
      if (row === undefined) return false
      const current = this.#parse(row)
      if (!graphDefinitionUpdateIsValid(current, next, expectedRevision)) return false
      const changed = await transaction
        .update(graphDefinitionVersions)
        .set({ revision: next.revision, definition: next })
        .where(and(scope, eq(graphDefinitionVersions.revision, expectedRevision)))
        .returning({ graphDefinitionId: graphDefinitionVersions.graphDefinitionId })
      return changed.length === 1
    })
  }

  #scope(graphDefinitionId: string, graphVersion: string) {
    GraphReferenceSchema.shape.graphDefinitionId.parse(graphDefinitionId)
    GraphReferenceSchema.shape.graphVersion.parse(graphVersion)
    return and(
      eq(graphDefinitionVersions.workspaceId, this.#workspaceId),
      eq(graphDefinitionVersions.graphDefinitionId, graphDefinitionId),
      eq(graphDefinitionVersions.graphVersion, graphVersion)
    )
  }

  #parse(row: typeof graphDefinitionVersions.$inferSelect): PublishedGraphDefinition {
    const definition = PublishedGraphDefinitionSchema.parse(row.definition)
    if (
      row.workspaceId !== this.#workspaceId ||
      row.graphDefinitionId !== definition.reference.graphDefinitionId ||
      row.graphVersion !== definition.reference.graphVersion ||
      row.revision !== definition.revision
    )
      throw new Error('GRAPH_DEFINITION_ROW_INCONSISTENT')
    return definition
  }
}
