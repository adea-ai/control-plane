import type { ToolRateLimiter } from '@control-plane/tool-execution/execution'
import { and, eq, gt, lte, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { toolRateLimitEvents } from './schema/tool-rate-limit-events.js'
import type { DomainTransaction } from './transaction.js'

/**
 * Serializes each workspace/principal/tool/operation window and records only admitted
 * calls. Denied attempts do not consume a later window slot.
 */
export class PostgresToolRateLimiter implements ToolRateLimiter {
  constructor(readonly database: ControlPlaneDatabase) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
    atInput: string,
    toolCallId: string
  ): Promise<boolean> {
    validateRateLimitInput(key, limit, windowMs, atInput, toolCallId)
    return this.database.transaction((transaction) =>
      this.consumeInTransaction(transaction, key, limit, windowMs, atInput, toolCallId)
    )
  }

  async consumeInTransaction(
    transaction: DomainTransaction,
    key: string,
    limit: number,
    windowMs: number,
    atInput: string,
    toolCallId: string
  ): Promise<boolean> {
    const parsedKey = validateRateLimitInput(key, limit, windowMs, atInput, toolCallId)
    const { workspaceId, principalRef, toolDefinitionId, operation } = parsedKey
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
    const [databaseClock] = await transaction.execute(
      sql`select extract(epoch from clock_timestamp()) * 1000 as at_ms`
    )
    const admittedAtMs = Number(databaseClock?.['at_ms'])
    if (!Number.isFinite(admittedAtMs) || admittedAtMs <= 0) {
      throw new Error('POSTGRES_TOOL_RATE_LIMIT_STATE_INVALID')
    }
    const admittedAt = new Date(admittedAtMs)
    const windowStart = new Date(admittedAt.getTime() - windowMs)
    const [existing] = await transaction
      .select()
      .from(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.toolCallId, toolCallId)
        )
      )
      .limit(1)
    if (existing !== undefined) {
      if (
        existing.principalRef !== principalRef ||
        existing.toolDefinitionId !== toolDefinitionId ||
        existing.operation !== operation
      ) {
        throw new Error('POSTGRES_TOOL_RATE_LIMIT_RECEIPT_CONFLICT')
      }
      return true
    }

    await transaction
      .delete(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.principalRef, principalRef),
          eq(toolRateLimitEvents.toolDefinitionId, toolDefinitionId),
          eq(toolRateLimitEvents.operation, operation),
          lte(toolRateLimitEvents.consumedAt, windowStart)
        )
      )
    const [countRow] = await transaction
      .select({ count: sql<number>`count(*)::integer` })
      .from(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.principalRef, principalRef),
          eq(toolRateLimitEvents.toolDefinitionId, toolDefinitionId),
          eq(toolRateLimitEvents.operation, operation),
          gt(toolRateLimitEvents.consumedAt, windowStart)
        )
      )
    const count = Number(countRow?.count ?? Number.NaN)
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('POSTGRES_TOOL_RATE_LIMIT_STATE_INVALID')
    }
    if (count >= limit) return false
    await transaction.insert(toolRateLimitEvents).values({
      workspaceId,
      principalRef,
      toolDefinitionId,
      operation,
      toolCallId,
      consumedAt: admittedAt,
    })
    return true
  }

  async release(key: string, toolCallId: string): Promise<boolean> {
    if (parseRateLimitKey(key) === undefined || !toolCallId) {
      throw new Error('POSTGRES_TOOL_RATE_LIMIT_INPUT_INVALID')
    }
    return this.database.transaction((transaction) =>
      this.releaseInTransaction(transaction, key, toolCallId)
    )
  }

  async releaseInTransaction(
    transaction: DomainTransaction,
    key: string,
    toolCallId: string
  ): Promise<boolean> {
    const parsedKey = parseRateLimitKey(key)
    if (parsedKey === undefined || !toolCallId) {
      throw new Error('POSTGRES_TOOL_RATE_LIMIT_INPUT_INVALID')
    }
    const { workspaceId, principalRef, toolDefinitionId, operation } = parsedKey
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
    const [existing] = await transaction
      .select()
      .from(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.toolCallId, toolCallId)
        )
      )
      .limit(1)
    if (existing === undefined) return false
    if (
      existing.principalRef !== principalRef ||
      existing.toolDefinitionId !== toolDefinitionId ||
      existing.operation !== operation
    ) {
      throw new Error('POSTGRES_TOOL_RATE_LIMIT_RECEIPT_CONFLICT')
    }
    const deleted = await transaction
      .delete(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.toolCallId, toolCallId),
          eq(toolRateLimitEvents.principalRef, principalRef),
          eq(toolRateLimitEvents.toolDefinitionId, toolDefinitionId),
          eq(toolRateLimitEvents.operation, operation)
        )
      )
      .returning({ toolCallId: toolRateLimitEvents.toolCallId })
    return deleted.length === 1
  }
}

function validateRateLimitInput(
  key: string,
  limit: number,
  windowMs: number,
  atInput: string,
  toolCallId: string | undefined
) {
  const parsedKey = parseRateLimitKey(key)
  const requestedAt = Date.parse(atInput)
  if (
    parsedKey === undefined ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    !Number.isFinite(requestedAt) ||
    !toolCallId
  ) {
    throw new Error('POSTGRES_TOOL_RATE_LIMIT_INPUT_INVALID')
  }
  return parsedKey
}

function parseRateLimitKey(key: string):
  | {
      readonly workspaceId: string
      readonly principalRef: string
      readonly toolDefinitionId: string
      readonly operation: string
    }
  | undefined {
  const firstSeparator = key.indexOf(':')
  const operationSeparator = key.lastIndexOf(':')
  const toolSeparator = key.lastIndexOf(':', operationSeparator - 1)
  if (
    firstSeparator < 1 ||
    toolSeparator <= firstSeparator ||
    operationSeparator <= toolSeparator
  ) {
    return undefined
  }
  const workspaceId = key.slice(0, firstSeparator)
  const principalRef = key.slice(firstSeparator + 1, toolSeparator)
  const toolDefinitionId = key.slice(toolSeparator + 1, operationSeparator)
  const operation = key.slice(operationSeparator + 1)
  if (
    !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(workspaceId) ||
    principalRef.length > 256 ||
    !/^tld_[0-9A-HJKMNP-TV-Z]{26}$/.test(toolDefinitionId) ||
    !/^[a-z][a-z0-9.-]{0,127}$/.test(operation)
  ) {
    return undefined
  }
  return { workspaceId, principalRef, toolDefinitionId, operation }
}
