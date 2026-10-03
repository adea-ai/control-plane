import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
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
import { and, eq, or } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { toolCalls, toolDefinitions, toolVersions } from './schema/tool-execution.js'

type ToolCallAdmissionTransaction = Parameters<
  Parameters<ControlPlaneDatabase['transaction']>[0]
>[0]
type ToolCallAdmissionFence = (
  transaction: ToolCallAdmissionTransaction,
  call: ToolCall
) => Promise<void>

/** Immutable definitions and versions scoped to the workspace supplied at construction. */
export class PostgresToolRegistryRepository implements ToolRegistryRepository {
  readonly #workspaceId: string

  constructor(
    readonly database: ControlPlaneDatabase,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
  }

  async insertDefinition(input: ToolDefinition): Promise<boolean> {
    const definition = ToolDefinitionSchema.parse(input)
    assertDefinitionScope(definition, this.#workspaceId)
    const [inserted] = await this.database
      .insert(toolDefinitions)
      .values({
        workspaceId: this.#workspaceId,
        toolDefinitionId: definition.toolDefinitionId,
        definition,
      })
      .onConflictDoNothing()
      .returning({ toolDefinitionId: toolDefinitions.toolDefinitionId })
    if (inserted !== undefined) return true

    const [existing] = await this.database
      .select()
      .from(toolDefinitions)
      .where(this.#definitionScope(definition.toolDefinitionId))
      .limit(1)
    if (existing === undefined) throw new Error('POSTGRES_TOOL_DEFINITION_CONFLICT_CORRUPT')
    parseDefinitionRow(existing)
    return false
  }

  async getDefinition(toolDefinitionIdInput: string): Promise<ToolDefinition | undefined> {
    const toolDefinitionId =
      ToolDefinitionSchema.shape.toolDefinitionId.parse(toolDefinitionIdInput)
    const [row] = await this.database
      .select()
      .from(toolDefinitions)
      .where(this.#definitionScope(toolDefinitionId))
      .limit(1)
    return row === undefined ? undefined : parseDefinitionRow(row)
  }

  async listDefinitions(): Promise<readonly ToolDefinition[]> {
    const rows = await this.database
      .select()
      .from(toolDefinitions)
      .where(eq(toolDefinitions.workspaceId, this.#workspaceId))
    return rows.map(parseDefinitionRow)
  }

  async insertVersion(input: ToolVersion): Promise<boolean> {
    const version = ToolVersionSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const [definitionRow] = await transaction
        .select()
        .from(toolDefinitions)
        .where(this.#definitionScope(version.toolDefinitionId))
        .limit(1)
      if (definitionRow === undefined) throw new Error('POSTGRES_TOOL_DEFINITION_MISSING')
      parseDefinitionRow(definitionRow)

      const [inserted] = await transaction
        .insert(toolVersions)
        .values({
          workspaceId: this.#workspaceId,
          toolVersionId: version.toolVersionId,
          toolDefinitionId: version.toolDefinitionId,
          semanticVersion: version.semanticVersion,
          version,
        })
        .onConflictDoNothing()
        .returning({ toolVersionId: toolVersions.toolVersionId })
      if (inserted !== undefined) return true

      const conflicts = await transaction
        .select()
        .from(toolVersions)
        .where(
          and(
            eq(toolVersions.workspaceId, this.#workspaceId),
            or(
              eq(toolVersions.toolVersionId, version.toolVersionId),
              and(
                eq(toolVersions.toolDefinitionId, version.toolDefinitionId),
                eq(toolVersions.semanticVersion, version.semanticVersion)
              )
            )
          )
        )
      if (conflicts.length === 0) throw new Error('POSTGRES_TOOL_VERSION_CONFLICT_CORRUPT')
      conflicts.forEach(parseVersionRow)
      return false
    })
  }

  async getVersion(toolVersionIdInput: string): Promise<ToolVersion | undefined> {
    const toolVersionId = ToolVersionSchema.shape.toolVersionId.parse(toolVersionIdInput)
    const [row] = await this.database
      .select()
      .from(toolVersions)
      .where(this.#versionScope(toolVersionId))
      .limit(1)
    return row === undefined ? undefined : parseVersionRow(row)
  }

  async listVersions(toolDefinitionIdInput: string): Promise<readonly ToolVersion[]> {
    const toolDefinitionId = ToolVersionSchema.shape.toolDefinitionId.parse(toolDefinitionIdInput)
    const rows = await this.database
      .select()
      .from(toolVersions)
      .where(
        and(
          eq(toolVersions.workspaceId, this.#workspaceId),
          eq(toolVersions.toolDefinitionId, toolDefinitionId)
        )
      )
    return rows.map(parseVersionRow)
  }

  #definitionScope(toolDefinitionId: string) {
    return and(
      eq(toolDefinitions.workspaceId, this.#workspaceId),
      eq(toolDefinitions.toolDefinitionId, toolDefinitionId)
    )
  }

  #versionScope(toolVersionId: string) {
    return and(
      eq(toolVersions.workspaceId, this.#workspaceId),
      eq(toolVersions.toolVersionId, toolVersionId)
    )
  }
}

/** Durable call receipts with a database-enforced, workspace-local idempotency fence. */
export class PostgresToolCallRepository implements ToolCallRepository {
  readonly #workspaceId: string
  readonly #admissionFence: ToolCallAdmissionFence | undefined

  constructor(
    readonly database: ControlPlaneDatabase,
    workspaceId: string,
    options: { readonly admissionFence?: ToolCallAdmissionFence } = {}
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
    this.#admissionFence = options.admissionFence
  }

  async insert(input: ToolCall): Promise<boolean> {
    const call = ToolCallSchema.parse(input)
    assertCallScope(call, this.#workspaceId)
    return this.database.transaction(async (transaction) => {
      await this.#admissionFence?.(transaction, call)
      const [inserted] = await transaction
        .insert(toolCalls)
        .values(toCallRow(this.#workspaceId, call))
        .onConflictDoNothing()
        .returning({ toolCallId: toolCalls.toolCallId })
      if (inserted !== undefined) return true

      const [sameId] = await transaction
        .select()
        .from(toolCalls)
        .where(this.#callScope(call.toolCallId))
        .limit(1)
      const [sameKey] = await transaction
        .select()
        .from(toolCalls)
        .where(this.#idempotencyScope(call.idempotencyKey))
        .limit(1)
      if (sameId === undefined && sameKey === undefined)
        throw new Error('POSTGRES_TOOL_CALL_CONFLICT_CORRUPT')

      if (sameId !== undefined) {
        const existing = parseCallRow(sameId)
        await this.#assertIdempotencyIndex(transaction, existing)
      }
      if (sameKey !== undefined) {
        const existing = parseCallRow(sameKey)
        if (existing.idempotencyKey !== call.idempotencyKey)
          throw new Error('POSTGRES_TOOL_CALL_IDEMPOTENCY_CORRUPT')
        await this.#assertIdempotencyIndex(transaction, existing)
      }
      return false
    })
  }

  async get(toolCallIdInput: string): Promise<ToolCall | undefined> {
    const toolCallId = ToolCallSchema.shape.toolCallId.parse(toolCallIdInput)
    const [row] = await this.database
      .select()
      .from(toolCalls)
      .where(this.#callScope(toolCallId))
      .limit(1)
    return row === undefined ? undefined : parseCallRow(row)
  }

  async getByIdempotencyKey(
    workspaceIdInput: string,
    idempotencyKeyInput: string
  ): Promise<ToolCall | undefined> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(workspaceIdInput)
    const idempotencyKey =
      DurableToolCallRequestSchema.shape.idempotencyKey.parse(idempotencyKeyInput)
    assertWorkspace(workspaceId, this.#workspaceId)
    const [row] = await this.database
      .select()
      .from(toolCalls)
      .where(this.#idempotencyScope(idempotencyKey))
      .limit(1)
    if (row === undefined) return undefined
    const call = parseCallRow(row)
    if (call.idempotencyKey !== idempotencyKey)
      throw new Error('POSTGRES_TOOL_CALL_IDEMPOTENCY_CORRUPT')
    return call
  }

  async compareAndSet(expectedRevision: number, input: ToolCall): Promise<boolean> {
    const next = ToolCallSchema.parse(input)
    assertCallScope(next, this.#workspaceId)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return false
    if (!Number.isSafeInteger(expectedRevision + 1) || next.revision !== expectedRevision + 1)
      return false

    return this.database.transaction(async (transaction) => {
      const scope = this.#callScope(next.toolCallId)
      const [row] = await transaction.select().from(toolCalls).where(scope).limit(1).for('update')
      if (row === undefined) return false
      const current = parseCallRow(row)
      if (
        current.revision !== expectedRevision ||
        !sameCallIdentity(current, next) ||
        !(await this.#assertIdempotencyIndex(transaction, current))
      ) {
        return false
      }

      const updated = await transaction
        .update(toolCalls)
        .set({ revision: next.revision, call: next })
        .where(and(scope, eq(toolCalls.revision, expectedRevision)))
        .returning({ toolCallId: toolCalls.toolCallId })
      return updated.length === 1
    })
  }

  async listByExecution(executionIdInput: string): Promise<readonly ToolCall[]> {
    const executionId = IdentifierSchemas.executionId.parse(executionIdInput)
    const rows = await this.database
      .select()
      .from(toolCalls)
      .where(
        and(eq(toolCalls.workspaceId, this.#workspaceId), eq(toolCalls.executionId, executionId))
      )
    return rows
      .map(parseCallRow)
      .toSorted((left, right) => compareCodePointOrder(left.requestedAt, right.requestedAt))
  }

  #callScope(toolCallId: string) {
    return and(eq(toolCalls.workspaceId, this.#workspaceId), eq(toolCalls.toolCallId, toolCallId))
  }

  #idempotencyScope(idempotencyKey: string) {
    return and(
      eq(toolCalls.workspaceId, this.#workspaceId),
      eq(toolCalls.idempotencyKey, idempotencyKey)
    )
  }

  async #assertIdempotencyIndex(
    database: Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0],
    call: ToolCall
  ): Promise<true> {
    const [indexed] = await database
      .select()
      .from(toolCalls)
      .where(this.#idempotencyScope(call.idempotencyKey))
      .limit(1)
    if (indexed === undefined) throw new Error('POSTGRES_TOOL_CALL_IDEMPOTENCY_CORRUPT')
    const indexedCall = parseCallRow(indexed)
    if (indexedCall.toolCallId !== call.toolCallId)
      throw new Error('POSTGRES_TOOL_CALL_IDEMPOTENCY_CORRUPT')
    return true
  }
}

function toCallRow(workspaceId: string, call: ToolCall) {
  return {
    workspaceId,
    toolCallId: call.toolCallId,
    idempotencyKey: call.idempotencyKey,
    executionId: call.executionId,
    revision: call.revision,
    call,
  }
}

function parseDefinitionRow(row: typeof toolDefinitions.$inferSelect): ToolDefinition {
  const definition = parseStored(
    ToolDefinitionSchema,
    row.definition,
    'POSTGRES_TOOL_DEFINITION_CORRUPT'
  )
  if (!IdentifierSchemas.workspaceId.safeParse(row.workspaceId).success) {
    throw new Error('POSTGRES_TOOL_DEFINITION_CORRUPT')
  }
  if (definition.toolDefinitionId !== row.toolDefinitionId) {
    throw new Error('POSTGRES_TOOL_DEFINITION_CORRUPT')
  }
  if (
    definition.ownership.scope === 'workspace' &&
    definition.ownership.workspaceId !== row.workspaceId
  ) {
    throw new Error('POSTGRES_TOOL_DEFINITION_CORRUPT')
  }
  return definition
}

function parseVersionRow(row: typeof toolVersions.$inferSelect): ToolVersion {
  const version = parseStored(ToolVersionSchema, row.version, 'POSTGRES_TOOL_VERSION_CORRUPT')
  if (
    !IdentifierSchemas.workspaceId.safeParse(row.workspaceId).success ||
    version.toolVersionId !== row.toolVersionId ||
    version.toolDefinitionId !== row.toolDefinitionId ||
    version.semanticVersion !== row.semanticVersion
  ) {
    throw new Error('POSTGRES_TOOL_VERSION_CORRUPT')
  }
  return version
}

function parseCallRow(row: typeof toolCalls.$inferSelect): ToolCall {
  const call = parseStored(ToolCallSchema, row.call, 'POSTGRES_TOOL_CALL_CORRUPT')
  if (
    !IdentifierSchemas.workspaceId.safeParse(row.workspaceId).success ||
    call.toolCallId !== row.toolCallId ||
    call.workspaceId !== row.workspaceId ||
    call.idempotencyKey !== row.idempotencyKey ||
    call.executionId !== row.executionId ||
    call.revision !== row.revision
  ) {
    throw new Error('POSTGRES_TOOL_CALL_CORRUPT')
  }
  return call
}

type SafeParseResult<Output> =
  | { readonly success: true; readonly data: Output }
  | { readonly success: false }

function parseStored<Output>(
  schema: { safeParse(input: unknown): SafeParseResult<Output> },
  input: unknown,
  errorCode: string
): Output {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error(errorCode)
  return parsed.data
}

function assertDefinitionScope(definition: ToolDefinition, workspaceId: string): void {
  if (
    definition.ownership.scope === 'workspace' &&
    definition.ownership.workspaceId !== workspaceId
  ) {
    throw new Error('POSTGRES_TOOL_SCOPE_MISMATCH')
  }
}

function assertCallScope(call: ToolCall, workspaceId: string): void {
  assertWorkspace(call.workspaceId, workspaceId)
}

function assertWorkspace(requestedWorkspaceId: string, repositoryWorkspaceId: string): void {
  if (requestedWorkspaceId !== repositoryWorkspaceId)
    throw new Error('POSTGRES_TOOL_SCOPE_MISMATCH')
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
