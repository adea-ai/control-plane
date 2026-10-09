import { createHash } from 'node:crypto'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import type { AcpGatewayExchange } from './acp-gateway-types.js'
import type { AcpRemoteDenialReason } from './acp-remote-fence.js'

/**
 * Durable device-side fence state for the secure ACP route.
 *
 * The device endpoint keeps revocation, the highest accepted channel generation, and the replay
 * ledger outside process memory so a restart cannot resurrect an already-revoked device, accept an
 * older channel generation, or re-run an effect whose outcome was already recorded. Two
 * implementations ship: an in-memory seam (explicitly not durable, for unit fixtures) and one over
 * the repository's `PersistenceProvider` transactional records, which is the persistence the Local
 * and Hosted `simple` profiles run in production.
 */

export interface AcpRemoteDeviceFenceRecord {
  readonly highestGeneration: number
  /** First applied controller revocation, persisted terminally. Absent while active. */
  readonly revokedAt?: string
}

export interface AcpRemoteDeviceDenialOutcome {
  readonly kind: 'denial'
  readonly reason: AcpRemoteDenialReason
}

export interface AcpRemoteDeviceExchangeOutcome {
  readonly kind: 'exchange'
  readonly exchange: AcpGatewayExchange
}

export type AcpRemoteDeviceOutcome = AcpRemoteDeviceDenialOutcome | AcpRemoteDeviceExchangeOutcome

export interface AcpRemoteDeviceLedgerRecord {
  readonly identity: string
  /** Absent while an effect is claimed but not finished (or after a crash before it completed). */
  readonly outcome?: AcpRemoteDeviceOutcome
}

export interface AcpRemoteDeviceClaim {
  readonly commandId: string
  readonly identity: string
  readonly channelGeneration: number
}

export interface AcpRemoteDeviceStateStore {
  loadFence(): Promise<AcpRemoteDeviceFenceRecord>
  /** Records the first applied revocation durably; a repeat application is a no-op. */
  applyRevocation(revokedAt: string): Promise<void>
  /** Number of recorded ledger entries, for fail-closed capacity checks. */
  countLedger(): Promise<number>
  readLedger(commandId: string): Promise<AcpRemoteDeviceLedgerRecord | undefined>
  /**
   * Atomically creates the ledger entry for a command (create-if-absent) and advances the highest
   * accepted channel generation in the same transaction. Returns `false` when the entry already
   * exists, so the caller must replay the recorded outcome instead of executing again.
   */
  claim(input: AcpRemoteDeviceClaim): Promise<boolean>
  /** Records the finished outcome over the claimed entry. */
  recordOutcome(commandId: string, outcome: AcpRemoteDeviceOutcome): Promise<void>
}

function readFenceRecord(value: JsonValue | undefined): AcpRemoteDeviceFenceRecord {
  if (value === undefined) return { highestGeneration: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  const record = value as { highestGeneration?: unknown; revokedAt?: unknown }
  if (!Number.isSafeInteger(record.highestGeneration) || (record.highestGeneration as number) < 0) {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  if (record.revokedAt !== undefined && typeof record.revokedAt !== 'string') {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  return {
    highestGeneration: record.highestGeneration as number,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt as string }),
  }
}

function fenceValue(fence: AcpRemoteDeviceFenceRecord): JsonValue {
  return {
    highestGeneration: fence.highestGeneration,
    ...(fence.revokedAt === undefined ? {} : { revokedAt: fence.revokedAt }),
  }
}

function ledgerValue(record: AcpRemoteDeviceLedgerRecord): JsonValue {
  return {
    identity: record.identity,
    ...(record.outcome === undefined ? {} : { outcome: record.outcome as unknown as JsonValue }),
  }
}

function readLedgerRecord(value: JsonValue | undefined): AcpRemoteDeviceLedgerRecord | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  const record = value as { identity?: unknown; outcome?: unknown }
  if (typeof record.identity !== 'string') {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  if (record.outcome === undefined) return { identity: record.identity }
  return {
    identity: record.identity,
    outcome: record.outcome as unknown as AcpRemoteDeviceOutcome,
  }
}

/** Process-memory seam. Not durable across restart; unit fixtures only, never a production claim. */
export class InMemoryAcpRemoteDeviceStateStore implements AcpRemoteDeviceStateStore {
  #fence: AcpRemoteDeviceFenceRecord = { highestGeneration: 0 }
  readonly #ledger = new Map<string, AcpRemoteDeviceLedgerRecord>()

  async loadFence(): Promise<AcpRemoteDeviceFenceRecord> {
    return { ...this.#fence }
  }

  async applyRevocation(revokedAt: string): Promise<void> {
    if (this.#fence.revokedAt !== undefined) return
    this.#fence = { ...this.#fence, revokedAt }
  }

  async countLedger(): Promise<number> {
    return this.#ledger.size
  }

  async readLedger(commandId: string): Promise<AcpRemoteDeviceLedgerRecord | undefined> {
    const record = this.#ledger.get(commandId)
    return record === undefined ? undefined : { ...record }
  }

  async claim(input: AcpRemoteDeviceClaim): Promise<boolean> {
    if (this.#ledger.has(input.commandId)) return false
    this.#ledger.set(input.commandId, { identity: input.identity })
    this.#fence = {
      ...this.#fence,
      highestGeneration: Math.max(this.#fence.highestGeneration, input.channelGeneration),
    }
    return true
  }

  async recordOutcome(commandId: string, outcome: AcpRemoteDeviceOutcome): Promise<void> {
    const record = this.#ledger.get(commandId)
    if (record === undefined) throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
    this.#ledger.set(commandId, { identity: record.identity, outcome })
  }
}

const FENCE_NAMESPACE = 'acp-remote-device-fence'
const LEDGER_NAMESPACE = 'acp-remote-device-ledger'
const FENCE_ID = 'fence'

function ledgerId(commandId: string): string {
  return `c-${createHash('sha256').update(commandId).digest('hex')}`
}

/**
 * Durable device state over the repository's `PersistenceProvider` records: one fenced
 * create-if-absent claim per command and one monotonic fence record, both inside provider
 * transactions, so SQLite/Local restarts preserve revocation, generation, and replay outcomes.
 */
export class PersistenceProviderAcpRemoteDeviceStateStore implements AcpRemoteDeviceStateStore {
  readonly #provider: PersistenceProvider

  constructor(provider: PersistenceProvider) {
    this.#provider = provider
  }

  async loadFence(): Promise<AcpRemoteDeviceFenceRecord> {
    return this.#provider.transaction(async (transaction) =>
      readFenceRecord((await transaction.get(FENCE_NAMESPACE, FENCE_ID))?.value)
    )
  }

  async applyRevocation(revokedAt: string): Promise<void> {
    await this.#withConflictRetry(async () =>
      this.#provider.transaction(async (transaction) => {
        const stored = await transaction.get(FENCE_NAMESPACE, FENCE_ID)
        const fence = readFenceRecord(stored?.value)
        if (fence.revokedAt !== undefined) return
        await transaction.put({
          namespace: FENCE_NAMESPACE,
          id: FENCE_ID,
          ...(stored === undefined ? {} : { expectedRevision: stored.revision }),
          value: fenceValue({ ...fence, revokedAt }),
        })
      })
    )
  }

  async countLedger(): Promise<number> {
    return this.#provider.transaction(
      async (transaction) => (await transaction.list(LEDGER_NAMESPACE)).length
    )
  }

  async readLedger(commandId: string): Promise<AcpRemoteDeviceLedgerRecord | undefined> {
    return this.#provider.transaction(async (transaction) =>
      readLedgerRecord((await transaction.get(LEDGER_NAMESPACE, ledgerId(commandId)))?.value)
    )
  }

  async claim(input: AcpRemoteDeviceClaim): Promise<boolean> {
    return this.#withConflictRetry(() =>
      this.#provider.transaction(async (transaction) => {
        const existing = await transaction.get(LEDGER_NAMESPACE, ledgerId(input.commandId))
        if (existing !== undefined) return false
        const stored = await transaction.get(FENCE_NAMESPACE, FENCE_ID)
        const fence = readFenceRecord(stored?.value)
        // Create-if-absent: the provider rejects an unconditional put over an existing record, so a
        // concurrent claimer for the same command fails instead of overwriting the recorded effect.
        await transaction.put({
          namespace: LEDGER_NAMESPACE,
          id: ledgerId(input.commandId),
          value: ledgerValue({ identity: input.identity }),
        })
        const highestGeneration = Math.max(fence.highestGeneration, input.channelGeneration)
        if (stored === undefined || highestGeneration !== fence.highestGeneration) {
          await transaction.put({
            namespace: FENCE_NAMESPACE,
            id: FENCE_ID,
            ...(stored === undefined ? {} : { expectedRevision: stored.revision }),
            value: fenceValue({ ...fence, highestGeneration }),
          })
        }
        return true
      })
    )
  }

  async recordOutcome(commandId: string, outcome: AcpRemoteDeviceOutcome): Promise<void> {
    await this.#withConflictRetry(async () =>
      this.#provider.transaction(async (transaction) => {
        const id = ledgerId(commandId)
        const stored = await transaction.get(LEDGER_NAMESPACE, id)
        const record = readLedgerRecord(stored?.value)
        if (record === undefined) throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
        await transaction.put({
          namespace: LEDGER_NAMESPACE,
          id,
          ...(stored === undefined ? {} : { expectedRevision: stored.revision }),
          value: ledgerValue({ identity: record.identity, outcome }),
        })
      })
    )
  }

  /** Optimistic records conflict under concurrent writers; one reload-and-retry absorbs it. */
  async #withConflictRetry<Result>(operation: () => Promise<Result>): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (attempt >= 1) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('REVISION_CONFLICT')) throw error
      }
    }
  }
}
