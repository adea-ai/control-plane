import { IdentifierSchemas } from '@control-plane/contracts'
import {
  GraphCatalogError,
  GraphDefinitionCommandReceiptSchema,
  GraphDefinitionCommandSchema,
  GraphReferenceSchema,
  PublishedGraphDefinitionSchema,
  graphDefinitionUpdateIsValid,
  type GraphDefinitionCommand,
  type GraphDefinitionCommandRepository,
  type GraphDefinitionRepository,
  type PublishedGraphDefinition,
} from '@control-plane/orchestration'
import { and, eq, isNull } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { graphDefinitionCommands, graphDefinitionVersions } from './schema/graph-definitions.js'

type GraphDefinitionTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]
type GraphDefinitionDatabase = ControlPlaneDatabase | GraphDefinitionTransaction

/** Scope is fixed by composition, never inferred from caller-owned graph content. */
export class PostgresGraphDefinitionRepository<
  Database extends GraphDefinitionDatabase = ControlPlaneDatabase,
> implements GraphDefinitionCommandRepository {
  readonly #workspaceId: string

  constructor(
    readonly database: Database,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
  }

  async executeCommand(
    input: GraphDefinitionCommand,
    action: (repository: GraphDefinitionRepository) => Promise<PublishedGraphDefinition>
  ): Promise<PublishedGraphDefinition> {
    const command = GraphDefinitionCommandSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const [claim] = await transaction
        .insert(graphDefinitionCommands)
        .values({
          workspaceId: this.#workspaceId,
          callerId: command.callerId,
          operation: command.operation,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.payloadHash,
          receipt: null,
        })
        .onConflictDoNothing()
        .returning({ idempotencyKey: graphDefinitionCommands.idempotencyKey })

      if (claim === undefined) {
        const [existing] = await transaction
          .select()
          .from(graphDefinitionCommands)
          .where(this.#commandScope(command))
          .limit(1)
          .for('update')
        if (existing === undefined) throw new Error('POSTGRES_GRAPH_COMMAND_RECEIPT_CORRUPT')
        const receipt = parseGraphDefinitionCommandReceipt(existing)
        if (receipt.command.payloadHash !== command.payloadHash) {
          throw new GraphCatalogError('GRAPH_COMMAND_CONFLICT')
        }
        return receipt.result
      }

      const scopedRepository = new PostgresGraphDefinitionRepository(transaction, this.#workspaceId)
      const result = PublishedGraphDefinitionSchema.parse(await action(scopedRepository))
      const receipt = GraphDefinitionCommandReceiptSchema.parse({
        workspaceId: this.#workspaceId,
        command,
        result,
      })
      const [completed] = await transaction
        .update(graphDefinitionCommands)
        .set({ receipt })
        .where(and(this.#commandScope(command), isNull(graphDefinitionCommands.receipt)))
        .returning({ idempotencyKey: graphDefinitionCommands.idempotencyKey })
      if (completed === undefined) throw new Error('POSTGRES_GRAPH_COMMAND_CLAIM_LOST')
      return receipt.result
    })
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

  #commandScope(command: GraphDefinitionCommand) {
    return and(
      eq(graphDefinitionCommands.workspaceId, this.#workspaceId),
      eq(graphDefinitionCommands.callerId, command.callerId),
      eq(graphDefinitionCommands.operation, command.operation),
      eq(graphDefinitionCommands.idempotencyKey, command.idempotencyKey)
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

function parseGraphDefinitionCommandReceipt(row: typeof graphDefinitionCommands.$inferSelect) {
  const parsed = GraphDefinitionCommandReceiptSchema.safeParse(row.receipt)
  if (
    !parsed.success ||
    parsed.data.workspaceId !== row.workspaceId ||
    parsed.data.command.callerId !== row.callerId ||
    parsed.data.command.operation !== row.operation ||
    parsed.data.command.idempotencyKey !== row.idempotencyKey ||
    parsed.data.command.payloadHash !== row.payloadHash
  ) {
    throw new Error('POSTGRES_GRAPH_COMMAND_RECEIPT_CORRUPT')
  }
  return parsed.data
}
