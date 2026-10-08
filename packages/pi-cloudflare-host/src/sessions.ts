import type { Context } from '@earendil-works/chord'
import type { ConversationId, Storage } from '@earendil-works/pi-durable'
import type { RuntimeSessionOperation, RuntimeSessionResult } from '@control-plane/runtime-sdk'
import type { CloudflareCurrentAuthority } from './host.js'
import type { CloudflareOwnerPins } from './owner.js'
import {
  RuntimeSessionOperationSchema,
  RuntimeSessionResultSchema,
  RuntimeAdapterError,
} from '@control-plane/runtime-sdk'
import type { CloudflareOwnerStorage, CloudflareAcceptedTask } from './owner.js'
import { CloudflareOwnerJournal, stableJson } from './owner.js'

/** Server-resolved canonical session identity; never supplied by a public session operation. */
export interface CloudflareSessionBinding {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly nativeConversationId: number
  readonly attemptId: string
}
export interface CloudflareBoundSession {
  readonly binding: CloudflareSessionBinding
  readonly task: CloudflareAcceptedTask
}

/** Immutable aliases to existing native conversations, fenced by the current owner epoch. */
export class CloudflareSessionJournal {
  constructor(
    private readonly storage: CloudflareOwnerStorage,
    private readonly owner: CloudflareOwnerJournal
  ) {
    owner.assertOwner()
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS cp_pi_sessions (session_id TEXT PRIMARY KEY, native_conversation_id INTEGER NOT NULL UNIQUE, attempt_id TEXT NOT NULL, body TEXT NOT NULL)'
    )
  }

  bind(input: CloudflareSessionBinding): void {
    const binding = parseBinding(input)
    this.storage.transactionSync(() => {
      this.owner.get(binding.attemptId)
      const body = stableJson(binding)
      const rows = this.storage.sql
        .exec(
          'SELECT * FROM cp_pi_sessions WHERE session_id = ? OR native_conversation_id = ?',
          binding.sessionId,
          binding.nativeConversationId
        )
        .toArray()
      if (rows.length) {
        if (rows.length !== 1 || rows[0]?.['body'] !== body)
          throw sessionError('CLOUDFLARE_SESSION_BINDING_CONFLICT', 'conflict')
        this.decode(rows[0]!)
        return
      }
      this.storage.sql.exec(
        'INSERT INTO cp_pi_sessions(session_id, native_conversation_id, attempt_id, body) VALUES (?, ?, ?, ?)',
        binding.sessionId,
        binding.nativeConversationId,
        binding.attemptId,
        body
      )
    })
  }

  get(sessionId: string): CloudflareBoundSession {
    this.owner.assertOwner()
    const row = this.storage.sql
      .exec('SELECT * FROM cp_pi_sessions WHERE session_id = ?', sessionId)
      .toArray()[0]
    if (!row) throw sessionError('CLOUDFLARE_SESSION_MISSING', 'unavailable')
    return this.decode(row)
  }

  list(): readonly CloudflareBoundSession[] {
    this.owner.assertOwner()
    const rows = this.storage.sql
      .exec('SELECT * FROM cp_pi_sessions ORDER BY session_id LIMIT 65')
      .toArray()
    if (rows.length > 64) throw sessionError('CLOUDFLARE_SESSION_LIST_LIMIT', 'unavailable')
    return rows.map((row) => this.decode(row))
  }

  private decode(row: Record<string, unknown>): CloudflareBoundSession {
    const binding = parseBinding(JSON.parse(String(row['body'])))
    if (
      row['session_id'] !== binding.sessionId ||
      row['native_conversation_id'] !== binding.nativeConversationId ||
      row['attempt_id'] !== binding.attemptId
    )
      throw sessionError('CLOUDFLARE_SESSION_PIN_MISMATCH', 'conflict')
    return { binding, task: this.owner.get(binding.attemptId).task }
  }
}

export function parseBinding(input: CloudflareSessionBinding): CloudflareSessionBinding {
  if (
    input.schemaVersion !== 1 ||
    !Number.isSafeInteger(input.nativeConversationId) ||
    input.nativeConversationId < 1 ||
    Object.keys(input).toSorted().join(',') !==
      'attemptId,nativeConversationId,schemaVersion,sessionId'
  )
    throw sessionError('CLOUDFLARE_SESSION_BINDING_INVALID', 'validation')
  RuntimeSessionOperationSchema.parse({ operation: 'load', sessionId: input.sessionId })
  return Object.freeze(JSON.parse(stableJson(input)) as CloudflareSessionBinding)
}
export function sessionError(
  code: string,
  classification: 'unsupported' | 'unavailable' | 'conflict' | 'validation'
): RuntimeAdapterError {
  return new RuntimeAdapterError({ code, classification, message: code, retryable: false })
}

/** Must verify current canonical active session/native identity, original actor, separate caller,
 * owner workspace/conversation/Agent, audience/grants/expiry and exact admitted plan/budget.
 * List authority must check the entire batch under one current canonical snapshot, including empty lists.
 * Server-only port; no caller-returned claim or public binding registration endpoint. */
export interface CloudflareSessionAuthority {
  assertCurrent(
    sessions: readonly CloudflareBoundSession[],
    owner: CloudflareOwnerPins,
    operation: 'bind' | 'load' | 'list'
  ): Promise<void>
}

/** Read existing native records through Storage only; never opens Harness or enables scheduling. */
export class CloudflareReadOnlySessions {
  private readonly pins: CloudflareOwnerPins
  private tail: Promise<void> = Promise.resolve()
  constructor(
    private readonly journal: CloudflareOwnerJournal,
    private readonly sessions: CloudflareSessionJournal,
    pins: CloudflareOwnerPins,
    private readonly current: CloudflareCurrentAuthority,
    private readonly authority: CloudflareSessionAuthority,
    private readonly openStorage: () => Promise<Pick<Storage, 'conversation' | 'close'>>,
    private readonly context: Context,
    private readonly now: () => number
  ) {
    journal.assertPins(pins)
    this.pins = Object.freeze(JSON.parse(stableJson(pins)) as CloudflareOwnerPins)
  }

  bind(input: CloudflareSessionBinding): Promise<void> {
    const binding = parseBinding(input)
    return this.serial(() => this.bindPinned(binding))
  }

  private async bindPinned(binding: CloudflareSessionBinding): Promise<void> {
    const entry = { binding, task: this.journal.get(binding.attemptId).task }
    await this.assertCurrent([entry], 'bind', false)
    await this.readNative([entry], 'bind', false)
    this.sessions.bind(binding)
  }

  operation(input: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    const operation = RuntimeSessionOperationSchema.parse(input)
    return this.serial(() => this.operationPinned(operation))
  }

  private async operationPinned(operation: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    if (operation.operation !== 'load' && operation.operation !== 'list')
      throw sessionError('CLOUDFLARE_SESSION_OPERATION_UNSUPPORTED', 'unsupported')
    // Authorize the caller's current owner scope before revealing alias existence or counts.
    this.journal.assertOwner()
    await this.authority.assertCurrent([], this.pins, operation.operation)
    this.journal.assertOwner()
    const entries =
      operation.operation === 'list'
        ? this.sessions.list()
        : [this.sessions.get(operation.sessionId)]
    await this.assertCurrent(entries, operation.operation, true)
    await this.readNative(entries, operation.operation, true)
    const observedAt = new Date(this.now()).toISOString()
    const sessions = entries.map((entry) => ({
      sessionId: entry.binding.sessionId,
      state: 'active' as const,
      observedAt,
    }))
    return RuntimeSessionResultSchema.parse(
      operation.operation === 'list'
        ? { operation: 'list', sessions }
        : { operation: 'load', session: sessions[0] }
    )
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async readNative(
    entries: readonly CloudflareBoundSession[],
    operation: 'bind' | 'load' | 'list',
    retained: boolean
  ): Promise<void> {
    const storage = await this.openStorage()
    try {
      await this.assertCurrent(entries, operation, retained)
      for (const entry of entries) {
        const native = await storage.conversation(
          entry.binding.nativeConversationId as ConversationId,
          this.context
        )
        await this.assertCurrent(entries, operation, retained)
        if (native?.id !== entry.binding.nativeConversationId)
          throw sessionError('CLOUDFLARE_NATIVE_CONVERSATION_MISSING', 'unavailable')
      }
      await this.assertCurrent(entries, operation, retained)
    } finally {
      await storage.close(this.context)
    }
    await this.assertCurrent(entries, operation, retained)
  }

  private async assertCurrent(
    entries: readonly CloudflareBoundSession[],
    operation: 'bind' | 'load' | 'list',
    retained: boolean
  ): Promise<void> {
    this.journal.assertPins(this.pins)
    for (const entry of entries) {
      this.assertEntry(entry, retained)
      await this.current.assertCurrent(
        JSON.parse(stableJson(entry.task)) as CloudflareAcceptedTask,
        this.pins,
        'read'
      )
      this.journal.assertOwner()
    }
    await this.authority.assertCurrent(
      JSON.parse(stableJson(entries)) as CloudflareBoundSession[],
      this.pins,
      operation
    )
    this.journal.assertOwner()
    for (const entry of entries) this.assertEntry(entry, retained)
  }

  private assertEntry(entry: CloudflareBoundSession, retained: boolean): void {
    const current = this.journal.get(entry.binding.attemptId)
    if (
      stableJson(current.task) !== stableJson(entry.task) ||
      (retained &&
        stableJson(this.sessions.get(entry.binding.sessionId).binding) !==
          stableJson(entry.binding))
    )
      throw sessionError('CLOUDFLARE_SESSION_PIN_MISMATCH', 'conflict')
  }
}
