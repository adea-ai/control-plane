import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
import type { ToolCallRepository } from '@control-plane/tool-execution/execution'
import type { ToolRegistryRepository } from '@control-plane/tool-execution/registry'
import {
  DurableToolCallRequestSchema,
  ToolCallSchema,
  ToolDefinitionSchema,
  ToolVersionSchema,
  type ToolCall,
  type ToolDefinition,
  type ToolVersion,
} from '@control-plane/tool-sdk'
import { json, recordId } from './record-storage.js'

const namespaces = Object.freeze({
  definitions: 'tool-definitions',
  versions: 'tool-versions',
  calls: 'tool-calls',
  callIdempotency: 'tool-call-idempotency',
})

interface StoredToolDefinition {
  readonly workspaceId: string
  readonly toolDefinitionId: string
  readonly definition: unknown
}

interface StoredToolVersion {
  readonly workspaceId: string
  readonly toolVersionId: string
  readonly toolDefinitionId: string
  readonly semanticVersion: string
  readonly version: unknown
}

interface StoredToolCall {
  readonly workspaceId: string
  readonly toolCallId: string
  readonly call: unknown
}

interface StoredToolCallIdempotency {
  readonly workspaceId: string
  readonly idempotencyKey: string
  readonly toolCallId: string
}

/** Workspace-bound, immutable SQLite tool definitions and published versions. */
export class SqliteToolRegistryRepository implements ToolRegistryRepository {
  readonly #workspaceId: string
  readonly #definitionsNamespace: string
  readonly #versionsNamespace: string

  constructor(
    readonly provider: Pick<PersistenceProvider, 'transaction'>,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
    this.#definitionsNamespace = scopedNamespace(namespaces.definitions, this.#workspaceId)
    this.#versionsNamespace = scopedNamespace(namespaces.versions, this.#workspaceId)
  }

  async insertDefinition(input: ToolDefinition): Promise<boolean> {
    const definition = ToolDefinitionSchema.parse(input)
    assertDefinitionScope(definition, this.#workspaceId)
    const id = definitionId(this.#workspaceId, definition.toolDefinitionId)

    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(this.#definitionsNamespace, id)
      if (existing !== undefined) {
        readStoredDefinition(
          existing.value,
          existing.id,
          this.#workspaceId,
          definition.toolDefinitionId
        )
        return false
      }
      await transaction.put({
        namespace: this.#definitionsNamespace,
        id,
        value: json(storedDefinition(this.#workspaceId, definition)),
      })
      return true
    })
  }

  async getDefinition(toolDefinitionIdInput: string): Promise<ToolDefinition | undefined> {
    const toolDefinitionId =
      ToolDefinitionSchema.shape.toolDefinitionId.parse(toolDefinitionIdInput)
    const id = definitionId(this.#workspaceId, toolDefinitionId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(this.#definitionsNamespace, id)
      return record === undefined
        ? undefined
        : readStoredDefinition(record.value, record.id, this.#workspaceId, toolDefinitionId)
    })
  }

  async listDefinitions(): Promise<readonly ToolDefinition[]> {
    return this.provider.transaction(async (transaction) => {
      const records = await transaction.list(this.#definitionsNamespace)
      const definitions = records.map((record) => readAnyStoredDefinition(record.value, record.id))
      if (definitions.some(({ workspaceId }) => workspaceId !== this.#workspaceId))
        throw new Error('SQLITE_TOOL_DEFINITION_CORRUPT')
      return definitions.map(({ definition }) => definition)
    })
  }

  async insertVersion(input: ToolVersion): Promise<boolean> {
    const version = ToolVersionSchema.parse(input)
    const id = versionId(this.#workspaceId, version.toolVersionId)

    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(this.#versionsNamespace, id)
      if (existing !== undefined) {
        readStoredVersion(existing.value, existing.id, this.#workspaceId, version.toolVersionId)
        return false
      }

      const definitionRecord = await transaction.get(
        this.#definitionsNamespace,
        definitionId(this.#workspaceId, version.toolDefinitionId)
      )
      if (definitionRecord === undefined) throw new Error('SQLITE_TOOL_DEFINITION_MISSING')
      readStoredDefinition(
        definitionRecord.value,
        definitionRecord.id,
        this.#workspaceId,
        version.toolDefinitionId
      )

      for (const record of await transaction.list(this.#versionsNamespace)) {
        const stored = readAnyStoredVersion(record.value, record.id)
        if (stored.workspaceId !== this.#workspaceId) throw new Error('SQLITE_TOOL_VERSION_CORRUPT')
        if (
          stored.version.toolDefinitionId === version.toolDefinitionId &&
          stored.version.semanticVersion === version.semanticVersion
        ) {
          return false
        }
      }

      await transaction.put({
        namespace: this.#versionsNamespace,
        id,
        value: json(storedVersion(this.#workspaceId, version)),
      })
      return true
    })
  }

  async getVersion(toolVersionIdInput: string): Promise<ToolVersion | undefined> {
    const toolVersionId = ToolVersionSchema.shape.toolVersionId.parse(toolVersionIdInput)
    const id = versionId(this.#workspaceId, toolVersionId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(this.#versionsNamespace, id)
      return record === undefined
        ? undefined
        : readStoredVersion(record.value, record.id, this.#workspaceId, toolVersionId)
    })
  }

  async listVersions(toolDefinitionIdInput: string): Promise<readonly ToolVersion[]> {
    const toolDefinitionId =
      ToolDefinitionSchema.shape.toolDefinitionId.parse(toolDefinitionIdInput)
    return this.provider.transaction(async (transaction) => {
      const versions = (await transaction.list(this.#versionsNamespace)).map((record) =>
        readAnyStoredVersion(record.value, record.id)
      )
      if (versions.some(({ workspaceId }) => workspaceId !== this.#workspaceId))
        throw new Error('SQLITE_TOOL_VERSION_CORRUPT')
      return versions
        .filter(({ version }) => version.toolDefinitionId === toolDefinitionId)
        .map(({ version }) => version)
    })
  }
}

/** Durable tool-call receipts, idempotency index, and revision-checked transitions. */
export class SqliteToolCallRepository implements ToolCallRepository {
  readonly #workspaceId: string
  readonly #callsNamespace: string
  readonly #idempotencyNamespace: string

  constructor(
    readonly provider: Pick<PersistenceProvider, 'transaction'>,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
    this.#callsNamespace = scopedNamespace(namespaces.calls, this.#workspaceId)
    this.#idempotencyNamespace = scopedNamespace(namespaces.callIdempotency, this.#workspaceId)
  }

  async insert(input: ToolCall): Promise<boolean> {
    const call = ToolCallSchema.parse(input)
    assertCallScope(call, this.#workspaceId)
    const callId = callRecordId(this.#workspaceId, call.toolCallId)
    const idempotencyId = callIdempotencyRecordId(this.#workspaceId, call.idempotencyKey)

    return this.provider.transaction(async (transaction) => {
      const existingCall = await transaction.get(this.#callsNamespace, callId)
      if (existingCall !== undefined) {
        readStoredCall(existingCall.value, existingCall.id, this.#workspaceId, call.toolCallId)
        return false
      }

      const existingIndex = await transaction.get(this.#idempotencyNamespace, idempotencyId)
      if (existingIndex !== undefined) {
        const indexed = readStoredIdempotency(
          existingIndex.value,
          existingIndex.id,
          this.#workspaceId,
          call.idempotencyKey
        )
        const indexedCallRecord = await transaction.get(
          this.#callsNamespace,
          callRecordId(this.#workspaceId, indexed.toolCallId)
        )
        if (indexedCallRecord === undefined) throw new Error('SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT')
        readStoredCall(
          indexedCallRecord.value,
          indexedCallRecord.id,
          this.#workspaceId,
          indexed.toolCallId
        )
        return false
      }

      await transaction.put({
        namespace: this.#callsNamespace,
        id: callId,
        value: json(storedCall(this.#workspaceId, call)),
      })
      await transaction.put({
        namespace: this.#idempotencyNamespace,
        id: idempotencyId,
        value: json(storedIdempotency(this.#workspaceId, call.idempotencyKey, call.toolCallId)),
      })
      return true
    })
  }

  async get(toolCallIdInput: string): Promise<ToolCall | undefined> {
    const toolCallId = ToolCallSchema.shape.toolCallId.parse(toolCallIdInput)
    const id = callRecordId(this.#workspaceId, toolCallId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(this.#callsNamespace, id)
      return record === undefined
        ? undefined
        : readStoredCall(record.value, record.id, this.#workspaceId, toolCallId)
    })
  }

  async getByIdempotencyKey(
    workspaceIdInput: string,
    idempotencyKeyInput: string
  ): Promise<ToolCall | undefined> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(workspaceIdInput)
    const idempotencyKey =
      DurableToolCallRequestSchema.shape.idempotencyKey.parse(idempotencyKeyInput)
    assertWorkspace(workspaceId, this.#workspaceId)
    const id = callIdempotencyRecordId(this.#workspaceId, idempotencyKey)

    return this.provider.transaction(async (transaction) => {
      const index = await transaction.get(this.#idempotencyNamespace, id)
      if (index === undefined) return undefined
      const stored = readStoredIdempotency(index.value, index.id, this.#workspaceId, idempotencyKey)
      const callRecord = await transaction.get(
        this.#callsNamespace,
        callRecordId(this.#workspaceId, stored.toolCallId)
      )
      if (callRecord === undefined) throw new Error('SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT')
      const call = readStoredCall(
        callRecord.value,
        callRecord.id,
        this.#workspaceId,
        stored.toolCallId
      )
      if (call.idempotencyKey !== idempotencyKey)
        throw new Error('SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT')
      return call
    })
  }

  async compareAndSet(expectedRevision: number, input: ToolCall): Promise<boolean> {
    const next = ToolCallSchema.parse(input)
    assertCallScope(next, this.#workspaceId)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return false
    if (!Number.isSafeInteger(expectedRevision + 1) || next.revision !== expectedRevision + 1)
      return false
    const id = callRecordId(this.#workspaceId, next.toolCallId)

    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(this.#callsNamespace, id)
      if (record === undefined) return false
      const current = readStoredCall(record.value, record.id, this.#workspaceId, next.toolCallId)
      if (
        current.revision !== expectedRevision ||
        !sameCallIdentity(current, next) ||
        !(await this.#hasIdempotencyIndex(transaction, current))
      ) {
        return false
      }

      await transaction.put({
        namespace: this.#callsNamespace,
        id,
        expectedRevision: record.revision,
        value: json(storedCall(this.#workspaceId, next)),
      })
      return true
    })
  }

  async listByExecution(executionIdInput: string): Promise<readonly ToolCall[]> {
    const executionId = IdentifierSchemas.executionId.parse(executionIdInput)
    return this.provider.transaction(async (transaction) => {
      const calls = (await transaction.list(this.#callsNamespace)).map((record) =>
        readAnyStoredCall(record.value, record.id)
      )
      if (calls.some(({ workspaceId }) => workspaceId !== this.#workspaceId))
        throw new Error('SQLITE_TOOL_CALL_CORRUPT')
      return calls
        .filter(({ call }) => call.executionId === executionId)
        .map(({ call }) => call)
        .toSorted((left, right) => compareCodePointOrder(left.requestedAt, right.requestedAt))
    })
  }

  async #hasIdempotencyIndex(
    transaction: PersistenceTransaction,
    call: ToolCall
  ): Promise<boolean> {
    const id = callIdempotencyRecordId(this.#workspaceId, call.idempotencyKey)
    const index = await transaction.get(this.#idempotencyNamespace, id)
    if (index === undefined) throw new Error('SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT')
    const stored = readStoredIdempotency(
      index.value,
      index.id,
      this.#workspaceId,
      call.idempotencyKey
    )
    if (stored.toolCallId !== call.toolCallId)
      throw new Error('SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT')
    return true
  }
}

function definitionId(workspaceId: string, toolDefinitionId: string): string {
  return recordId(canonicalJsonStringify([workspaceId, toolDefinitionId]) ?? 'null')
}

function scopedNamespace(namespace: string, workspaceId: string): string {
  return `${namespace}-${recordId(workspaceId)}`
}

function versionId(workspaceId: string, toolVersionId: string): string {
  return recordId(canonicalJsonStringify([workspaceId, toolVersionId]) ?? 'null')
}

function callRecordId(workspaceId: string, toolCallId: string): string {
  return recordId(canonicalJsonStringify([workspaceId, toolCallId]) ?? 'null')
}

function callIdempotencyRecordId(workspaceId: string, idempotencyKey: string): string {
  return recordId(canonicalJsonStringify([workspaceId, idempotencyKey]) ?? 'null')
}

function storedDefinition(workspaceId: string, definition: ToolDefinition): StoredToolDefinition {
  return { workspaceId, toolDefinitionId: definition.toolDefinitionId, definition }
}

function storedVersion(workspaceId: string, version: ToolVersion): StoredToolVersion {
  return {
    workspaceId,
    toolVersionId: version.toolVersionId,
    toolDefinitionId: version.toolDefinitionId,
    semanticVersion: version.semanticVersion,
    version,
  }
}

function storedCall(workspaceId: string, call: ToolCall): StoredToolCall {
  return { workspaceId, toolCallId: call.toolCallId, call }
}

function storedIdempotency(
  workspaceId: string,
  idempotencyKey: string,
  toolCallId: string
): StoredToolCallIdempotency {
  return { workspaceId, idempotencyKey, toolCallId }
}

function readStoredDefinition(
  value: unknown,
  recordKey: string,
  workspaceId: string,
  toolDefinitionId: string
): ToolDefinition {
  const stored = parseDefinitionRow(value, recordKey)
  if (stored.workspaceId !== workspaceId || stored.definition.toolDefinitionId !== toolDefinitionId)
    throw new Error('SQLITE_TOOL_DEFINITION_CORRUPT')
  return stored.definition
}

function readAnyStoredDefinition(
  value: unknown,
  recordKey: string
): { readonly workspaceId: string; readonly definition: ToolDefinition } {
  const stored = parseDefinitionRow(value, recordKey)
  return { workspaceId: stored.workspaceId, definition: stored.definition }
}

function parseDefinitionRow(
  value: unknown,
  recordKey: string
): StoredToolDefinition & { readonly definition: ToolDefinition } {
  const row = objectRecord(value, 'SQLITE_TOOL_DEFINITION_CORRUPT')
  if (
    Object.keys(row).length !== 3 ||
    typeof row['workspaceId'] !== 'string' ||
    typeof row['toolDefinitionId'] !== 'string'
  ) {
    throw new Error('SQLITE_TOOL_DEFINITION_CORRUPT')
  }
  const workspaceId = parseStoredIdentifier(
    IdentifierSchemas.workspaceId,
    row['workspaceId'],
    'SQLITE_TOOL_DEFINITION_CORRUPT'
  )
  const toolDefinitionId = parseStoredIdentifier(
    ToolDefinitionSchema.shape.toolDefinitionId,
    row['toolDefinitionId'],
    'SQLITE_TOOL_DEFINITION_CORRUPT'
  )
  if (recordKey !== definitionId(workspaceId, toolDefinitionId))
    throw new Error('SQLITE_TOOL_DEFINITION_CORRUPT')

  let definition: ToolDefinition
  try {
    definition = ToolDefinitionSchema.parse(row['definition'])
  } catch {
    throw new Error('SQLITE_TOOL_DEFINITION_CORRUPT')
  }
  if (definition.toolDefinitionId !== toolDefinitionId)
    throw new Error('SQLITE_TOOL_DEFINITION_CORRUPT')
  assertDefinitionScope(definition, workspaceId)
  return { workspaceId, toolDefinitionId, definition }
}

function readStoredVersion(
  value: unknown,
  recordKey: string,
  workspaceId: string,
  toolVersionId: string
): ToolVersion {
  const stored = parseVersionRow(value, recordKey)
  if (stored.workspaceId !== workspaceId || stored.version.toolVersionId !== toolVersionId)
    throw new Error('SQLITE_TOOL_VERSION_CORRUPT')
  return stored.version
}

function readAnyStoredVersion(
  value: unknown,
  recordKey: string
): { readonly workspaceId: string; readonly version: ToolVersion } {
  const stored = parseVersionRow(value, recordKey)
  return { workspaceId: stored.workspaceId, version: stored.version }
}

function parseVersionRow(
  value: unknown,
  recordKey: string
): StoredToolVersion & { readonly version: ToolVersion } {
  const row = objectRecord(value, 'SQLITE_TOOL_VERSION_CORRUPT')
  if (
    Object.keys(row).length !== 5 ||
    typeof row['workspaceId'] !== 'string' ||
    typeof row['toolVersionId'] !== 'string' ||
    typeof row['toolDefinitionId'] !== 'string' ||
    typeof row['semanticVersion'] !== 'string'
  ) {
    throw new Error('SQLITE_TOOL_VERSION_CORRUPT')
  }
  const workspaceId = parseStoredIdentifier(
    IdentifierSchemas.workspaceId,
    row['workspaceId'],
    'SQLITE_TOOL_VERSION_CORRUPT'
  )
  const toolVersionId = parseStoredIdentifier(
    ToolVersionSchema.shape.toolVersionId,
    row['toolVersionId'],
    'SQLITE_TOOL_VERSION_CORRUPT'
  )
  const toolDefinitionId = parseStoredIdentifier(
    ToolVersionSchema.shape.toolDefinitionId,
    row['toolDefinitionId'],
    'SQLITE_TOOL_VERSION_CORRUPT'
  )
  if (recordKey !== versionId(workspaceId, toolVersionId))
    throw new Error('SQLITE_TOOL_VERSION_CORRUPT')

  let version: ToolVersion
  try {
    version = ToolVersionSchema.parse(row['version'])
  } catch {
    throw new Error('SQLITE_TOOL_VERSION_CORRUPT')
  }
  if (
    version.toolVersionId !== toolVersionId ||
    version.toolDefinitionId !== toolDefinitionId ||
    version.semanticVersion !== row['semanticVersion']
  ) {
    throw new Error('SQLITE_TOOL_VERSION_CORRUPT')
  }
  return {
    workspaceId,
    toolVersionId,
    toolDefinitionId,
    semanticVersion: version.semanticVersion,
    version,
  }
}

function readStoredCall(
  value: unknown,
  recordKey: string,
  workspaceId: string,
  toolCallId: string
): ToolCall {
  const stored = parseCallRow(value, recordKey)
  if (stored.workspaceId !== workspaceId || stored.call.toolCallId !== toolCallId)
    throw new Error('SQLITE_TOOL_CALL_CORRUPT')
  return stored.call
}

function readAnyStoredCall(
  value: unknown,
  recordKey: string
): { readonly workspaceId: string; readonly call: ToolCall } {
  const stored = parseCallRow(value, recordKey)
  return { workspaceId: stored.workspaceId, call: stored.call }
}

function parseCallRow(
  value: unknown,
  recordKey: string
): StoredToolCall & { readonly call: ToolCall } {
  const row = objectRecord(value, 'SQLITE_TOOL_CALL_CORRUPT')
  if (
    Object.keys(row).length !== 3 ||
    typeof row['workspaceId'] !== 'string' ||
    typeof row['toolCallId'] !== 'string'
  ) {
    throw new Error('SQLITE_TOOL_CALL_CORRUPT')
  }
  const workspaceId = parseStoredIdentifier(
    IdentifierSchemas.workspaceId,
    row['workspaceId'],
    'SQLITE_TOOL_CALL_CORRUPT'
  )
  const toolCallId = parseStoredIdentifier(
    ToolCallSchema.shape.toolCallId,
    row['toolCallId'],
    'SQLITE_TOOL_CALL_CORRUPT'
  )
  if (recordKey !== callRecordId(workspaceId, toolCallId))
    throw new Error('SQLITE_TOOL_CALL_CORRUPT')

  let call: ToolCall
  try {
    call = ToolCallSchema.parse(row['call'])
  } catch {
    throw new Error('SQLITE_TOOL_CALL_CORRUPT')
  }
  if (call.toolCallId !== toolCallId || call.workspaceId !== workspaceId)
    throw new Error('SQLITE_TOOL_CALL_CORRUPT')
  return { workspaceId, toolCallId, call }
}

function readStoredIdempotency(
  value: unknown,
  recordKey: string,
  workspaceId: string,
  idempotencyKey: string
): StoredToolCallIdempotency {
  const row = objectRecord(value, 'SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT')
  if (
    Object.keys(row).length !== 3 ||
    row['workspaceId'] !== workspaceId ||
    row['idempotencyKey'] !== idempotencyKey ||
    typeof row['toolCallId'] !== 'string' ||
    recordKey !== callIdempotencyRecordId(workspaceId, idempotencyKey)
  ) {
    throw new Error('SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT')
  }
  const toolCallId = parseStoredIdentifier(
    ToolCallSchema.shape.toolCallId,
    row['toolCallId'],
    'SQLITE_TOOL_CALL_IDEMPOTENCY_CORRUPT'
  )
  return { workspaceId, idempotencyKey, toolCallId }
}

function sameCallIdentity(current: ToolCall, next: ToolCall): boolean {
  return (
    canonicalJsonStringify(callIdentity(current)) === canonicalJsonStringify(callIdentity(next))
  )
}

function callIdentity(call: ToolCall): unknown {
  return {
    toolCallId: call.toolCallId,
    requestDigest: call.requestDigest,
    executionId: call.executionId,
    attemptId: call.attemptId,
    workspaceId: call.workspaceId,
    profileId: call.profileId,
    principalRef: call.principalRef,
    toolDefinitionId: call.toolDefinitionId,
    toolVersionId: call.toolVersionId,
    operation: call.operation,
    inputDigest: call.inputDigest,
    policySnapshotRef: call.policySnapshotRef,
    executor: call.executor,
    idempotencyKey: call.idempotencyKey,
    requestedAt: call.requestedAt,
  }
}

function assertDefinitionScope(definition: ToolDefinition, workspaceId: string): void {
  if (
    definition.ownership.scope === 'workspace' &&
    definition.ownership.workspaceId !== workspaceId
  ) {
    throw new Error('SQLITE_TOOL_SCOPE_MISMATCH')
  }
}

function assertCallScope(call: ToolCall, workspaceId: string): void {
  assertWorkspace(call.workspaceId, workspaceId)
}

function assertWorkspace(requestedWorkspaceId: string, repositoryWorkspaceId: string): void {
  if (requestedWorkspaceId !== repositoryWorkspaceId) throw new Error('SQLITE_TOOL_SCOPE_MISMATCH')
}

function parseStoredIdentifier<Schema extends { parse(input: unknown): string }>(
  schema: Schema,
  value: unknown,
  errorCode: string
): string {
  try {
    return schema.parse(value)
  } catch {
    throw new Error(errorCode)
  }
}

function objectRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(errorCode)
  return value as Record<string, unknown>
}
