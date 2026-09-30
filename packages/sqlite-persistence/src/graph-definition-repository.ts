import { IdentifierSchemas, canonicalJsonStringify } from '@control-plane/contracts'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  GraphReferenceSchema,
  PublishedGraphDefinitionSchema,
  graphDefinitionUpdateIsValid,
  type GraphDefinitionRepository,
  type PublishedGraphDefinition,
} from '@control-plane/orchestration'
import { json, recordId } from './record-storage.js'

const namespace = 'graph-definitions'

interface StoredGraphDefinition {
  readonly workspaceId: string
  readonly graphDefinitionId: string
  readonly graphVersion: string
  readonly version: unknown
}

export class SqliteGraphDefinitionRepository implements GraphDefinitionRepository {
  readonly #workspaceId: string

  constructor(
    readonly provider: PersistenceProvider,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
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
