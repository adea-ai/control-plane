import { createHash } from 'node:crypto'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
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
  /**
   * End of the claimed command's validity window (epoch ms). A delivery whose window has closed is
   * refused before the ledger is consulted, but a retry of the same command id with a fresh window is
   * not, so a closed-window entry is compacted (never deleted). Absent on entries that predate
   * retention: those are never compacted.
   */
  readonly expiresAtMs?: number
  /** Absent while an effect is claimed but not finished (or after a crash before it completed). */
  readonly outcome?: AcpRemoteDeviceOutcome
}

export interface AcpRemoteDeviceClaim {
  readonly commandId: string
  readonly identity: string
  readonly channelGeneration: number
  /**
   * Replay-ledger admission bound. Enforced INSIDE the claim's serialized/CAS fence
   * transaction — never by a separate pre-read — so distinct concurrent commands cannot
   * all observe spare capacity and each claim beyond the bound.
   */
  readonly capacity: number
  /** End of this command's validity window (epoch ms), retained for compaction. */
  readonly expiresAtMs: number
  /**
   * At capacity, entries whose retained window ended at or before this instant are COMPACTED inside
   * the same transaction before the bound is re-evaluated. Compaction never deletes duplicate
   * protection: a controller may retry the same command id with a fresh window at any time, and the
   * window fence alone would admit it. A compacted entry keeps its identity and its pending or
   * recorded state in a separate compact record (an exchange outcome, whose sealed output is no
   * longer retained, becomes `outcome_uncertain`), and it stops counting against `capacity`, which
   * bounds only the live entries.
   */
  readonly compactExpiredAtOrBeforeMs: number
}

/**
 * Result of one claim attempt. Only `claimed` may execute; `already_claimed`
 * replays the recorded entry (a duplicate replays even when the ledger is at
 * capacity), `replay_ledger_full` refuses a NEW identity once the capacity bound
 * is reached inside the same transaction, and the fence results deny without
 * creating any ledger entry, so a revoked or superseded delivery can never
 * become an executable claim.
 */
export type AcpRemoteDeviceClaimResult =
  | 'claimed'
  | 'already_claimed'
  | 'replay_ledger_full'
  | 'device_revoked'
  | 'stale_channel_generation'

/**
 * Authenticated identity of one device route. Every durable fence and ledger
 * key is derived from it, so two routes sharing one `PersistenceProvider`
 * store can never observe each other's revocation, generation, or recorded
 * effects — a fixed fence id or command-only ledger key would conflate them.
 */
export interface AcpRemoteDeviceStateScope {
  readonly workspaceId: string
  readonly nodeId: string
  readonly runtimeConnectionId: string
  readonly deviceKeyId: string
}

/** Builds the state scope from a parsed route record; every field must be a non-empty string. */
export function acpRemoteDeviceStateScope(route: {
  readonly workspaceId: string
  readonly nodeId: string
  readonly runtimeConnectionId: string
  readonly deviceKeyId: string
}): AcpRemoteDeviceStateScope {
  const scope: AcpRemoteDeviceStateScope = {
    workspaceId: route.workspaceId,
    nodeId: route.nodeId,
    runtimeConnectionId: route.runtimeConnectionId,
    deviceKeyId: route.deviceKeyId,
  }
  for (const value of Object.values(scope)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('ACP_REMOTE_DEVICE_STATE_SCOPE_INVALID')
    }
  }
  return scope
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
   * accepted channel generation in the same transaction, AFTER evaluating the persisted fence in
   * that same transaction: a revoked fence returns `device_revoked` and a generation below the
   * persisted fence returns `stale_channel_generation`, both without writing anything. A duplicate
   * command returns `already_claimed`, so the caller must replay the recorded outcome instead of
   * executing again — including while the ledger is at capacity. A NEW command beyond `capacity`
   * returns `replay_ledger_full` when the bounded count reaches the bound inside this same
   * transaction, so two distinct commands racing at capacity one admit exactly one effect.
   */
  claim(input: AcpRemoteDeviceClaim): Promise<AcpRemoteDeviceClaimResult>
  /** Records the finished outcome over the claimed entry. */
  recordOutcome(commandId: string, outcome: AcpRemoteDeviceOutcome): Promise<void>
  /**
   * Releases a claim whose effect provably never started (refused before dispatch for a reason
   * that is specific to this delivery, such as an expired window). Removes the entry only while it
   * has no recorded outcome and carries the same identity; anything else is left untouched, so a
   * recorded effect is never erased.
   */
  abandonClaim(commandId: string, identity: string): Promise<void>
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
    ...(record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs }),
    ...(record.outcome === undefined ? {} : { outcome: record.outcome as unknown as JsonValue }),
  }
}

function readLedgerRecord(value: JsonValue | undefined): AcpRemoteDeviceLedgerRecord | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  const record = value as { identity?: unknown; outcome?: unknown; expiresAtMs?: unknown }
  if (typeof record.identity !== 'string') {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  if (record.expiresAtMs !== undefined && !Number.isFinite(record.expiresAtMs)) {
    throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
  }
  const expires =
    record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs as number }
  if (record.outcome === undefined) return { identity: record.identity, ...expires }
  return {
    identity: record.identity,
    ...expires,
    outcome: record.outcome as unknown as AcpRemoteDeviceOutcome,
  }
}

/**
 * Compact form of a ledger record whose delivery window has closed. Identity and the pending or
 * recorded state are kept, so a same-command retry with a fresh window can never execute again; a
 * recorded exchange (the sealed output is no longer retained) becomes `outcome_uncertain`, a pending
 * claim stays pending, and a denial outcome is small enough to keep as recorded.
 */
function compactedRecord(record: AcpRemoteDeviceLedgerRecord): AcpRemoteDeviceLedgerRecord {
  const outcome: AcpRemoteDeviceOutcome | undefined =
    record.outcome?.kind === 'exchange'
      ? { kind: 'denial', reason: 'outcome_uncertain' }
      : record.outcome
  return {
    identity: record.identity,
    ...(record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs }),
    ...(outcome === undefined ? {} : { outcome }),
  }
}

/**
 * Process-memory seam. Not durable across restart; unit fixtures only, never a production claim.
 * One instance is one route: a shared production store must be the scoped PersistenceProvider
 * implementation below.
 */
export class InMemoryAcpRemoteDeviceStateStore implements AcpRemoteDeviceStateStore {
  #fence: AcpRemoteDeviceFenceRecord = { highestGeneration: 0 }
  readonly #ledger = new Map<string, AcpRemoteDeviceLedgerRecord>()
  readonly #compacted = new Map<string, AcpRemoteDeviceLedgerRecord>()

  async loadFence(): Promise<AcpRemoteDeviceFenceRecord> {
    return { ...this.#fence }
  }

  async applyRevocation(revokedAt: string): Promise<void> {
    if (this.#fence.revokedAt !== undefined) return
    this.#fence = { ...this.#fence, revokedAt }
  }

  /** Live (non-compacted) entries: the quantity `capacity` bounds. */
  async countLedger(): Promise<number> {
    return this.#ledger.size
  }

  async readLedger(commandId: string): Promise<AcpRemoteDeviceLedgerRecord | undefined> {
    const record = this.#ledger.get(commandId) ?? this.#compacted.get(commandId)
    return record === undefined ? undefined : { ...record }
  }

  async claim(input: AcpRemoteDeviceClaim): Promise<AcpRemoteDeviceClaimResult> {
    // Same atomic ordering as the durable store: the fence decides before any write.
    if (this.#fence.revokedAt !== undefined) return 'device_revoked'
    if (input.channelGeneration < this.#fence.highestGeneration) return 'stale_channel_generation'
    if (this.#ledger.has(input.commandId) || this.#compacted.has(input.commandId)) {
      return 'already_claimed'
    }
    // Capacity admission in the same synchronous claim step as the write (duplicates above
    // already replayed), so racing distinct commands admit exactly one at the bound.
    if (this.#ledger.size >= input.capacity) {
      for (const [commandId, record] of this.#ledger) {
        if (
          record.expiresAtMs !== undefined &&
          record.expiresAtMs <= input.compactExpiredAtOrBeforeMs
        ) {
          this.#compacted.set(commandId, compactedRecord(record))
          this.#ledger.delete(commandId)
        }
      }
      if (this.#ledger.size >= input.capacity) return 'replay_ledger_full'
    }
    this.#ledger.set(input.commandId, {
      identity: input.identity,
      expiresAtMs: input.expiresAtMs,
    })
    this.#fence = {
      ...this.#fence,
      highestGeneration: Math.max(this.#fence.highestGeneration, input.channelGeneration),
    }
    return 'claimed'
  }

  async recordOutcome(commandId: string, outcome: AcpRemoteDeviceOutcome): Promise<void> {
    const live = this.#ledger.get(commandId)
    const compacted = this.#compacted.get(commandId)
    const record = live ?? compacted
    if (record === undefined) throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
    const next = {
      identity: record.identity,
      ...(record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs }),
      outcome,
    }
    if (live !== undefined) this.#ledger.set(commandId, next)
    else this.#compacted.set(commandId, compactedRecord(next))
  }

  async abandonClaim(commandId: string, identity: string): Promise<void> {
    for (const ledger of [this.#ledger, this.#compacted]) {
      const record = ledger.get(commandId)
      if (record !== undefined && record.identity === identity && record.outcome === undefined) {
        ledger.delete(commandId)
      }
    }
  }
}

const FENCE_NAMESPACE = 'acp-remote-device-fence'
const LEDGER_NAMESPACE = 'acp-remote-device-ledger'
/** Compact records of closed-window commands: duplicate protection is kept, capacity is not spent. */
const COMPACTED_NAMESPACE = 'acp-remote-device-ledger-compacted'
/** Matched by `#withConflictRetry`, like the providers' own revision conflicts. */
const REVISION_CONFLICT = 'ACP_REMOTE_DEVICE_STATE_REVISION_CONFLICT'

/** Fixed-scope digest helpers: keys are derived from the authenticated route identity. */
function scopeDigest(scope: AcpRemoteDeviceStateScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.workspaceId,
        scope.nodeId,
        scope.runtimeConnectionId,
        scope.deviceKeyId,
      ])
    )
    .digest('hex')
}

/**
 * Durable device state over the repository's `PersistenceProvider` records: one fenced
 * create-if-absent claim per command and one monotonic fence record, both inside provider
 * transactions, so SQLite/Local restarts preserve revocation, generation, and replay outcomes.
 * Fence and ledger keys are derived from the authenticated route scope, so one shared store never
 * conflates two routes, and the claim evaluates the persisted fence (revocation, generation) inside
 * the same transaction that would create the ledger entry — atomic durable fence enforcement for
 * endpoints that loaded their in-process mirror once.
 */
export class PersistenceProviderAcpRemoteDeviceStateStore implements AcpRemoteDeviceStateStore {
  readonly #provider: PersistenceProvider
  readonly #fenceId: string
  readonly #scope: string

  constructor(provider: PersistenceProvider, scope: AcpRemoteDeviceStateScope) {
    this.#provider = provider
    // Validate through the same helper the public factory uses.
    this.#scope = scopeDigest(acpRemoteDeviceStateScope(scope))
    this.#fenceId = `f-${this.#scope}`
  }

  #ledgerId(commandId: string): string {
    // Full scope digest as a literal prefix so countLedger can filter per route.
    return `c-${this.#scope}-${createHash('sha256').update(commandId).digest('hex')}`
  }

  async loadFence(): Promise<AcpRemoteDeviceFenceRecord> {
    return this.#provider.transaction(async (transaction) =>
      readFenceRecord((await transaction.get(FENCE_NAMESPACE, this.#fenceId))?.value)
    )
  }

  async applyRevocation(revokedAt: string): Promise<void> {
    await this.#withConflictRetry(async () =>
      this.#provider.transaction(async (transaction) => {
        const stored = await transaction.get(FENCE_NAMESPACE, this.#fenceId)
        const fence = readFenceRecord(stored?.value)
        if (fence.revokedAt !== undefined) return
        await transaction.put({
          namespace: FENCE_NAMESPACE,
          id: this.#fenceId,
          ...(stored === undefined ? {} : { expectedRevision: stored.revision }),
          value: fenceValue({ ...fence, revokedAt }),
        })
      })
    )
  }

  async countLedger(): Promise<number> {
    // Bounded keyset scan over THIS route's authenticated scope prefix: pages stop at the
    // prefix end (or namespace end), so a shared store never lists other routes' records.
    return this.#provider.transaction((transaction) => this.#countPrefix(transaction, undefined))
  }

  /**
   * Counts this route's ledger entries with the provider's exclusive-id cursor scan, stopping
   * at `bound` (capacity admission), at the end of the authenticated scope prefix, or at the
   * end of the namespace — never listing records outside the scope.
   */
  async #countPrefix(
    transaction: PersistenceTransaction,
    bound: number | undefined
  ): Promise<number> {
    const prefix = `c-${this.#scope}-`
    // Exclusive cursor immediately before this route's contiguous block: ledger ids embed the
    // scope digest, so every id of the route sorts between `c-<scope>` and `c-<scope>-\uFFFF...`.
    let afterId = `c-${this.#scope}`
    let counted = 0
    for (;;) {
      const page = await transaction.scan(LEDGER_NAMESPACE, { afterId, limit: 128 })
      if (page.length === 0) return counted
      for (const record of page) {
        if (!record.id.startsWith(prefix)) return counted
        counted += 1
        if (bound !== undefined && counted >= bound) return counted
      }
      if (page.length < 128) return counted
      const last = page[page.length - 1]
      if (last === undefined) return counted
      afterId = last.id
    }
  }

  async readLedger(commandId: string): Promise<AcpRemoteDeviceLedgerRecord | undefined> {
    return this.#provider.transaction(async (transaction) => {
      const id = this.#ledgerId(commandId)
      return readLedgerRecord(
        (
          (await transaction.get(LEDGER_NAMESPACE, id)) ??
          (await transaction.get(COMPACTED_NAMESPACE, id))
        )?.value
      )
    })
  }

  async claim(input: AcpRemoteDeviceClaim): Promise<AcpRemoteDeviceClaimResult> {
    return this.#withConflictRetry(() =>
      this.#provider.transaction(async (transaction) => {
        // Atomic durable fence: revocation and the persisted generation decide before any write.
        const storedFence = await transaction.get(FENCE_NAMESPACE, this.#fenceId)
        const fence = readFenceRecord(storedFence?.value)
        if (fence.revokedAt !== undefined) return 'device_revoked' as const
        if (input.channelGeneration < fence.highestGeneration) {
          return 'stale_channel_generation' as const
        }
        const ledgerId = this.#ledgerId(input.commandId)
        // A compacted record is still a claim: a retry with a fresh window must never run again.
        const existing =
          (await transaction.get(LEDGER_NAMESPACE, ledgerId)) ??
          (await transaction.get(COMPACTED_NAMESPACE, ledgerId))
        if (existing !== undefined) return 'already_claimed' as const
        // Capacity admission in the SAME transaction as the fence write and ledger insert:
        // every admitting claim rewrites the fence row under its read revision, so a racing
        // claimer that counted spare capacity conflicts, retries, and re-counts against the
        // committed entry — at most `capacity` distinct commands ever become executable.
        // Duplicates returned above replay regardless of capacity; nothing is evicted here.
        if ((await this.#countPrefix(transaction, input.capacity)) >= input.capacity) {
          // At the bound: compact entries whose window has closed (their duplicate protection is
          // kept in the compacted namespace, only their capacity is released), then re-evaluate in
          // this same transaction.
          await this.#compactExpired(transaction, input.compactExpiredAtOrBeforeMs)
          if ((await this.#countPrefix(transaction, input.capacity)) >= input.capacity) {
            return 'replay_ledger_full' as const
          }
        }
        // Create-if-absent: the provider rejects an unconditional put over an existing record, so a
        // concurrent claimer for the same command fails instead of overwriting the recorded effect.
        await transaction.put({
          namespace: LEDGER_NAMESPACE,
          id: ledgerId,
          value: ledgerValue({ identity: input.identity, expiresAtMs: input.expiresAtMs }),
        })
        // Unconditional revision-checked fence participation: every claim writes the fence row it
        // read, so a revocation or a higher-generation claim committing after this transaction's
        // fence read collides on the row, aborts the whole claim (the ledger insert rolls back with
        // it), and the bounded conflict retry re-reads the fresh fence and denies — leaving no
        // executable ledger reservation. Skipping this write when the generation is unchanged
        // opened a lost-update window under default isolation.
        const highestGeneration = Math.max(fence.highestGeneration, input.channelGeneration)
        await transaction.put({
          namespace: FENCE_NAMESPACE,
          id: this.#fenceId,
          ...(storedFence === undefined ? {} : { expectedRevision: storedFence.revision }),
          value: fenceValue({ ...fence, highestGeneration }),
        })
        return 'claimed' as const
      })
    )
  }

  async recordOutcome(commandId: string, outcome: AcpRemoteDeviceOutcome): Promise<void> {
    await this.#withConflictRetry(async () =>
      this.#provider.transaction(async (transaction) => {
        const id = this.#ledgerId(commandId)
        const live = await transaction.get(LEDGER_NAMESPACE, id)
        const stored = live ?? (await transaction.get(COMPACTED_NAMESPACE, id))
        const record = readLedgerRecord(stored?.value)
        if (stored === undefined || record === undefined) {
          throw new Error('ACP_REMOTE_DEVICE_STATE_CORRUPT')
        }
        const next = {
          identity: record.identity,
          ...(record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs }),
          outcome,
        }
        await transaction.put({
          namespace: live === undefined ? COMPACTED_NAMESPACE : LEDGER_NAMESPACE,
          id,
          expectedRevision: stored.revision,
          value: ledgerValue(live === undefined ? compactedRecord(next) : next),
        })
      })
    )
  }

  async abandonClaim(commandId: string, identity: string): Promise<void> {
    await this.#withConflictRetry(async () =>
      this.#provider.transaction(async (transaction) => {
        const id = this.#ledgerId(commandId)
        for (const namespace of [LEDGER_NAMESPACE, COMPACTED_NAMESPACE]) {
          const stored = await transaction.get(namespace, id)
          const record = readLedgerRecord(stored?.value)
          if (stored === undefined || record === undefined) continue
          if (record.identity !== identity || record.outcome !== undefined) continue
          // Already removed by a concurrent connection (or moved by compaction): re-read, never skip.
          if (!(await transaction.delete(namespace, id, stored.revision))) {
            throw new Error(REVISION_CONFLICT)
          }
        }
      })
    )
  }

  /**
   * Moves this route's live entries whose retained window ended at or before `atOrBeforeMs` into the
   * compacted namespace in the same transaction. Nothing is deleted outright, so a same-command
   * retry with a fresh window still finds its claim.
   */
  async #compactExpired(transaction: PersistenceTransaction, atOrBeforeMs: number): Promise<void> {
    const prefix = `c-${this.#scope}-`
    let afterId = `c-${this.#scope}`
    const expired: {
      readonly id: string
      readonly revision: number
      readonly record: AcpRemoteDeviceLedgerRecord
    }[] = []
    for (;;) {
      const page = await transaction.scan(LEDGER_NAMESPACE, { afterId, limit: 128 })
      if (page.length === 0) break
      let ended = false
      for (const record of page) {
        if (!record.id.startsWith(prefix)) {
          ended = true
          break
        }
        const entry = readLedgerRecord(record.value)
        if (entry?.expiresAtMs !== undefined && entry.expiresAtMs <= atOrBeforeMs) {
          expired.push({ id: record.id, revision: record.revision, record: entry })
        }
      }
      if (ended || page.length < 128) break
      const last = page[page.length - 1]
      if (last === undefined) break
      afterId = last.id
    }
    for (const entry of expired) {
      // Remove the live record first. A concurrent connection may have released the claim (a
      // never-executed command) or recorded its outcome since the scan: `delete` then reports that
      // nothing was removed, and recreating the record as a compact pending claim would leave that
      // command stuck at `outcome_uncertain`. A lost revision-checked delete is a transaction
      // conflict, so this whole claim rolls back and retries against the fresh state.
      if (!(await transaction.delete(LEDGER_NAMESPACE, entry.id, entry.revision))) {
        throw new Error(REVISION_CONFLICT)
      }
      await transaction.put({
        namespace: COMPACTED_NAMESPACE,
        id: entry.id,
        value: ledgerValue(compactedRecord(entry.record)),
      })
    }
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
