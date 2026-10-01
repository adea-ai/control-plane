import { IdentifierSchemas, canonicalJsonStringify } from '@control-plane/contracts'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  GraphReferenceSchema,
  PublishedGraphDefinitionSchema,
  graphDefinitionUpdateIsValid,
  GraphCatalogError,
  GraphDefinitionCommandSchema,
  GraphDefinitionCommandReceiptSchema,
  type GraphDefinitionCommand,
  type GraphDefinitionCommandRepository,
  type GraphDefinitionRepository,
  type PublishedGraphDefinition,
} from '@control-plane/orchestration'
import { json, recordId } from './record-storage.js'

const namespace = 'graph-definitions'
const commandNamespace = 'graph-definition-commands'

interface StoredGraphDefinition {
  readonly workspaceId: string
  readonly graphDefinitionId: string
  readonly graphVersion: string
  readonly version: unknown
}

export class SqliteGraphDefinitionRepository implements GraphDefinitionCommandRepository {
  readonly #workspaceId: string

  constructor(
    readonly provider: Pick<PersistenceProvider, 'transaction'>,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
  }

  executeCommand(
    input: GraphDefinitionCommand,
    action: (repository: GraphDefinitionRepository) => Promise<PublishedGraphDefinition>
  ): Promise<PublishedGraphDefinition> {
    const command = GraphDefinitionCommandSchema.parse(input)
    const id = recordId(
      canonicalJsonStringify([
        this.#workspaceId,
        command.callerId,
        command.operation,
        command.idempotencyKey,
      ])
    )
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(commandNamespace, id)
      if (existing !== undefined) {
        const parsed = GraphDefinitionCommandReceiptSchema.safeParse(existing.value)
        if (
          !parsed.success ||
          parsed.data.workspaceId !== this.#workspaceId ||
          parsed.data.command.callerId !== command.callerId ||
          parsed.data.command.operation !== command.operation ||
          parsed.data.command.idempotencyKey !== command.idempotencyKey
        ) {
          throw new Error('SQLITE_GRAPH_COMMAND_RECEIPT_CORRUPT')
        }
        if (parsed.data.command.payloadHash !== command.payloadHash) {
          throw new GraphCatalogError('GRAPH_COMMAND_CONFLICT')
        }
        return parsed.data.result
      }
      // The catalog uses the already-owned transaction, never a nested provider transaction.
      const repository = new SqliteGraphDefinitionRepository(
        {
          transaction: async (operation) => operation(transaction),
        },
        this.#workspaceId
      )
      const result = PublishedGraphDefinitionSchema.parse(await action(repository))
      await transaction.put({
        namespace: commandNamespace,
        id,
        value: json(
          GraphDefinitionCommandReceiptSchema.parse({
            workspaceId: this.#workspaceId,
            command,
            result,
          })
        ),
      })
      return result
    })
  }

  insert(input: PublishedGraphDefinition): Promise<boolean> {
    const version = PublishedGraphDefinitionSchema.parse(input)
    const { graphDefinitionId, graphVersion } = version.reference
    const id = graphDefinitionRecordId(this.#workspaceId, graphDefinitionId, graphVersion)

    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(namespace, id)
      if (existing !== undefined) {
        readStoredGraphDefinition(
          existing.value,
          this.#workspaceId,
          graphDefinitionId,
          graphVersion
        )
        return false
      }

      await transaction.put({
        namespace,
        id,
        value: json(storedGraphDefinition(this.#workspaceId, version)),
      })
      return true
    })
  }

  async get(
    graphDefinitionId: string,
    graphVersion: string
  ): Promise<PublishedGraphDefinition | undefined> {
    GraphReferenceSchema.shape.graphDefinitionId.parse(graphDefinitionId)
    GraphReferenceSchema.shape.graphVersion.parse(graphVersion)
    const id = graphDefinitionRecordId(this.#workspaceId, graphDefinitionId, graphVersion)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespace, id)
      return record === undefined
        ? undefined
        : readStoredGraphDefinition(
            record.value,
            this.#workspaceId,
            graphDefinitionId,
            graphVersion
          )
    })
  }

  async compareAndSet(expectedRevision: number, input: PublishedGraphDefinition): Promise<boolean> {
    const parsed = PublishedGraphDefinitionSchema.safeParse(input)
    if (!parsed.success) return false
    const next = parsed.data
    const { graphDefinitionId, graphVersion } = next.reference
    const id = graphDefinitionRecordId(this.#workspaceId, graphDefinitionId, graphVersion)

    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespace, id)
      if (record === undefined) return false

      const current = readStoredGraphDefinition(
        record.value,
        this.#workspaceId,
        graphDefinitionId,
        graphVersion
      )
      if (!graphDefinitionUpdateIsValid(current, next, expectedRevision)) return false

      await transaction.put({
        namespace,
        id,
        expectedRevision: record.revision,
        value: json(storedGraphDefinition(this.#workspaceId, next)),
      })
      return true
    })
  }
}

function graphDefinitionRecordId(
  workspaceId: string,
  graphDefinitionId: string,
  graphVersion: string
): string {
  return recordId(canonicalJsonStringify([workspaceId, graphDefinitionId, graphVersion]))
}

function storedGraphDefinition(
  workspaceId: string,
  version: PublishedGraphDefinition
): StoredGraphDefinition {
  return {
    workspaceId,
    graphDefinitionId: version.reference.graphDefinitionId,
    graphVersion: version.reference.graphVersion,
    version,
  }
}

function readStoredGraphDefinition(
  value: unknown,
  workspaceId: string,
  graphDefinitionId: string,
  graphVersion: string
): PublishedGraphDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SQLITE_GRAPH_DEFINITION_CORRUPT')
  }

  const row = value as Record<string, unknown>
  if (
    Object.keys(row).length !== 4 ||
    row['workspaceId'] !== workspaceId ||
    row['graphDefinitionId'] !== graphDefinitionId ||
    row['graphVersion'] !== graphVersion
  ) {
    throw new Error('SQLITE_GRAPH_DEFINITION_CORRUPT')
  }

  let version: PublishedGraphDefinition
  try {
    version = PublishedGraphDefinitionSchema.parse(row['version'])
  } catch {
    throw new Error('SQLITE_GRAPH_DEFINITION_CORRUPT')
  }

  if (
    version.reference.graphDefinitionId !== graphDefinitionId ||
    version.reference.graphVersion !== graphVersion
  ) {
    throw new Error('SQLITE_GRAPH_DEFINITION_CORRUPT')
  }

  return version
}
