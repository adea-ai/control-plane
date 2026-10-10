import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import type { AgentHqDatabase } from '../../src/connection'
import {
  collectBoundedRecords,
  captureMigrationSnapshot,
  migrationSnapshotEventPayloadDigest,
  migrationSnapshotEventPayloadDigestField,
  MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER,
  MigrationSnapshotCaptureInputError,
  MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES,
  MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG,
  PAYLOAD_CANONICAL_MAX_BYTES,
  PAYLOAD_CANONICAL_MAX_WORK,
  PAYLOAD_CANONICAL_MAX_DEPTH,
  resolveMigrationSnapshotCaptureDomains,
  type MigrationSnapshotRecord,
} from '../../src/migration-snapshot-capture'
import { migrationSnapshotFamilies } from '@adea-ai/types'

// The capture's pure surface, tested without any database: domain resolution,
// bounded pagination, payload digests, and the input validation that must run
// before a database handle is ever touched. The database-backed behavior —
// consistency, determinism against real rows, comparator findings — is proven
// in tests/integration/migration-snapshot-capture.test.ts.

const IDENTITY = {
  capturedAt: new Date('2026-01-15T00:00:00.000Z'),
  rehearsalId: 'rehearsal-unit',
  snapshotId: 'snapshot-unit',
  source: 'unit',
} as const

// ─── Domain resolution ───────────────────────────────────────────────────────

describe('resolveMigrationSnapshotCaptureDomains', () => {
  test('without a request every database-capturable family is captured and native sessions stay unsupported', () => {
    const domains = resolveMigrationSnapshotCaptureDomains(undefined)
    expect(domains.map((domain) => domain.domain)).toEqual(
      [...MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES].toSorted()
    )
    for (const domain of domains) {
      if (domain.domain === 'nativeSessions') {
        // Runtime-owned: without an injected source the domain is unknown, not
        // a captured empty section.
        expect(domain).toEqual({
          domain: 'nativeSessions',
          status: 'unknown',
          unknownReason: 'unsupported_family',
        })
        continue
      }
      expect(domain).toMatchObject({ status: 'captured', unknownReason: null })
    }
  })

  test('a name outside the snapshot contract is unrecognized, not captured', () => {
    const domains = resolveMigrationSnapshotCaptureDomains(['workspaces', 'runtimeSessions'])
    expect(domains).toEqual([
      { domain: 'runtimeSessions', status: 'unknown', unknownReason: 'unrecognized_domain' },
      { domain: 'workspaces', status: 'captured', unknownReason: null },
    ])
  })

  test('every database-capturable family resolves to captured and native sessions stay explicitly unsupported without a source', () => {
    const domains = resolveMigrationSnapshotCaptureDomains([
      ...migrationSnapshotFamilies,
      'nativeSessions',
    ])
    for (const family of MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES.filter(
      (candidate) => candidate !== 'nativeSessions'
    )) {
      expect(domains).toContainEqual({
        domain: family,
        status: 'captured',
        unknownReason: null,
      })
    }
    expect(domains).toContainEqual({
      domain: 'nativeSessions',
      status: 'unknown',
      unknownReason: 'unsupported_family',
    })
  })

  test('a wired runtime inventory source makes native sessions capturable', () => {
    const domains = resolveMigrationSnapshotCaptureDomains(['nativeSessions'], {
      nativeSessionInventory: {
        authorizedScopes: [{ accountId: 'acct-1', runtimeNodeId: 'node-1', workspaceId: 'wsp-1' }],
        listRuntimeSessions: async () => ({ items: [] }),
      },
    })
    expect(domains).toEqual([{ domain: 'nativeSessions', status: 'captured', unknownReason: null }])
  })

  test('duplicate requests collapse to one status and stay sorted', () => {
    const domains = resolveMigrationSnapshotCaptureDomains([
      'workspaces',
      'agents',
      'workspaces',
      'tasks',
    ])
    expect(domains.map((domain) => domain.domain)).toEqual(['agents', 'tasks', 'workspaces'])
  })

  test('an empty request captures nothing explicitly', () => {
    expect(resolveMigrationSnapshotCaptureDomains([])).toEqual([])
  })

  test('a non-string or empty domain name is an input error', () => {
    expect(() => resolveMigrationSnapshotCaptureDomains([''])).toThrow(
      MigrationSnapshotCaptureInputError
    )
    expect(() => resolveMigrationSnapshotCaptureDomains([42 as unknown as string])).toThrow(
      MigrationSnapshotCaptureInputError
    )
  })
})

// ─── Bounded pagination ──────────────────────────────────────────────────────

function workspaceRecord(id: string): MigrationSnapshotRecord {
  return {
    archived: false,
    controlPlaneWorkspaceId: id,
    family: 'workspaces',
    ownerUserId: 'owner',
    workspaceId: id,
  }
}

/** A SQL-shaped page source: ordered rows, limit, offset. */
function pagedRows(rows: readonly string[]) {
  return async (offset: number, rowsBound: number) => rows.slice(offset, offset + rowsBound)
}

describe('collectBoundedRecords', () => {
  test('an exhausted domain is complete, never truncated', async () => {
    const rows = ['wsp-1', 'wsp-2', 'wsp-3']
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(false)
    expect(records.map((record) => record.family === 'workspaces' && record.workspaceId)).toEqual(
      rows
    )
  })

  test('stopping at the bound with rows left over is truncated', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => `wsp-${String(index).padStart(3, '0')}`)
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(true)
    expect(records).toHaveLength(10)
  })

  test('exactly filling the bound is not truncated', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => `wsp-${String(index).padStart(3, '0')}`)
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(false)
    expect(records).toHaveLength(10)
  })

  test('a domain spanning several pages reports truncation only when rows remain', async () => {
    const twoThousand = Array.from(
      { length: 2000 },
      (_, index) => `wsp-${String(index).padStart(4, '0')}`
    )
    const exhausted = await collectBoundedRecords({
      fetchPage: pagedRows(twoThousand.slice(0, 1200)),
      limit: 1200,
      toRecord: workspaceRecord,
    })
    expect(exhausted.truncated).toBe(false)
    expect(exhausted.records).toHaveLength(1200)

    const truncated = await collectBoundedRecords({
      fetchPage: pagedRows(twoThousand),
      limit: 1200,
      toRecord: workspaceRecord,
    })
    expect(truncated.truncated).toBe(true)
    expect(truncated.records).toHaveLength(1200)
  })

  test('records come back ordered by the comparator-style stable id, not page order', async () => {
    const rows = ['wsp-c', 'wsp-a', 'wsp-b']
    const { records } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(records.map((record) => record.family === 'workspaces' && record.workspaceId)).toEqual([
      'wsp-a',
      'wsp-b',
      'wsp-c',
    ])
  })

  test('an empty domain is a proven empty section, not truncation', async () => {
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows([]),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(false)
    expect(records).toEqual([])
  })

  test('an out-of-range bound is an input error', async () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        collectBoundedRecords({
          fetchPage: pagedRows([]),
          limit,
          toRecord: workspaceRecord,
        })
      ).rejects.toThrow(MigrationSnapshotCaptureInputError)
    }
  })
})

// ─── Event payload digests ───────────────────────────────────────────────────

/**
 * Unwrap a completed digest, failing the test when the fold came back
 * inconclusive — most tests exercise payloads that must produce a digest.
 */
const digestOf = (payload: unknown): string => {
  const result = migrationSnapshotEventPayloadDigest(payload)
  expect(result.ok).toBe(true)
  return result.ok ? result.digest : ''
}

describe('migrationSnapshotEventPayloadDigest', () => {
  test('is key-order independent and value sensitive', () => {
    const left = digestOf({ actorUserId: 'u-1', channelId: 'c-1' })
    const right = digestOf({ channelId: 'c-1', actorUserId: 'u-1' })
    expect(left).toBe(right)
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(digestOf({ actorUserId: 'u-2', channelId: 'c-1' })).not.toBe(left)
  })

  test('covers nested structure deterministically', () => {
    const digest = digestOf({
      nested: { b: 1, a: ['x', { y: null }] },
    })
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).toBe(
      digestOf({
        nested: { a: ['x', { y: null }], b: 1 },
      })
    )
  })
})

// ─── Deep payload digests (past the canonical depth cap) ─────────────────────

/**
 * Nest `leaf` under `levels` single-key objects, so everything above the leaf
 * sits at the same depth in every payload built with the same count.
 */
const wrapAtDepth = (leaf: unknown, levels = PAYLOAD_CANONICAL_MAX_DEPTH + 8): unknown => {
  let value = leaf
  for (let depth = 0; depth < levels; depth += 1) value = { layer: value }
  return value
}

/** Nest `leaf` in `levels` single-element arrays: depth without width. */
const nestArraysAtDepth = (leaf: string, levels: number): unknown => {
  let value: unknown = leaf
  for (let depth = 0; depth < levels; depth += 1) value = [value]
  return value
}

/** A payload whose folded subtree is exactly `subtree` (the fold's input). */
const foldedSubtreePayload = (subtree: unknown): unknown =>
  wrapAtDepth(subtree, PAYLOAD_CANONICAL_MAX_DEPTH + 1)

/**
 * A no-cap materializing canonical encoding, written independently of the
 * production walker: the streaming fold must hash exactly these bytes.
 */
const referenceCanonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(referenceCanonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${referenceCanonicalJson(source[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

describe('migrationSnapshotEventPayloadDigest past the depth cap', () => {
  test('payloads identical above the cap but different below it digest differently', () => {
    const left = digestOf(wrapAtDepth({ leaf: 'left' }))
    const right = digestOf(wrapAtDepth({ leaf: 'right' }))
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(right).toMatch(/^[0-9a-f]{64}$/)
    expect(left).not.toBe(right)
  })

  test('a difference exactly one level past the cap still digests differently', () => {
    const levels = PAYLOAD_CANONICAL_MAX_DEPTH + 1
    const left = digestOf(wrapAtDepth({ leaf: 'left' }, levels))
    const right = digestOf(wrapAtDepth({ leaf: 'right' }, levels))
    expect(left).not.toBe(right)
  })

  test('deep digests stay deterministic and key-order independent', () => {
    const reference = digestOf(wrapAtDepth({ b: [1, { y: null }], a: 'x' }))
    expect(reference).toBe(digestOf(wrapAtDepth({ a: 'x', b: [1, { y: null }] })))
    expect(reference).toBe(digestOf(wrapAtDepth({ b: [1, { y: null }], a: 'x' })))
  })

  test('deep content changes the digest even when the shallow skeleton repeats', () => {
    const variants = [
      digestOf(wrapAtDepth('same')),
      digestOf(wrapAtDepth('other')),
      digestOf(wrapAtDepth({ same: 1 })),
    ]
    expect(new Set(variants).size).toBe(variants.length)
    // A skeleton cut off exactly at the cap is walked in full, with nothing
    // folded — its digest matches none of the deep variants above.
    const atCap = digestOf(wrapAtDepth('same', PAYLOAD_CANONICAL_MAX_DEPTH))
    expect(variants).not.toContain(atCap)
  })

  test('nesting far past the cap cannot overflow the walk and still digests', () => {
    // 100 000 levels: the recursive walk stops at the cap, and the deep fold
    // streams the rest through the explicit-stack walker, so depth never
    // grows the call stack and the emitted bytes stay inside the fold budget.
    const left = digestOf(nestArraysAtDepth('left', 100_000))
    const right = digestOf(nestArraysAtDepth('right', 100_000))
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(left).toBe(digestOf(nestArraysAtDepth('left', 100_000)))
    expect(left).not.toBe(right)
  })
})

describe('migrationSnapshotEventPayloadDigest deep-fold bounds', () => {
  // A folded leaf string of two million chars: the fold's emitted bytes alone
  // blow past any sane per-fold budget.
  const overBudget = wrapAtDepth('x'.repeat(2_000_000))

  test('an oversized deep payload is typed inconclusive, never a digest', () => {
    const result = migrationSnapshotEventPayloadDigest(overBudget)
    expect(result).toEqual({
      marker: MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER,
      ok: false,
      reason: 'payload_too_large_to_digest',
    })
  })

  test('a fold within the byte budget digests exactly like the canonical encoding', () => {
    // Strings chosen to exercise the streaming escaper against
    // JSON.stringify: quotes, backslashes, control characters, non-ASCII,
    // an astral surrogate pair and a lone surrogate.
    const subtree = {
      a: 'x',
      b: [1, { y: null }, 'quote " and \\ back', 'control\t\r\n', 'ünïcödé 🐉', '\uD800', ''],
    }
    const result = migrationSnapshotEventPayloadDigest(foldedSubtreePayload(subtree))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
    // The streamed fold must hash exactly the canonical bytes of the subtree,
    // folded into the parent as the bounded `"~deep:len:hex"` marker inside
    // the 65-wrapper skeleton.
    const canonical = referenceCanonicalJson(subtree)
    const foldHex = createHash('sha256').update(canonical, 'utf8').digest('hex')
    let whole = `"~deep:${Buffer.byteLength(canonical, 'utf8')}:${foldHex}"`
    for (let depth = 0; depth < PAYLOAD_CANONICAL_MAX_DEPTH + 1; depth += 1) {
      whole = `{"layer":${whole}}`
    }
    expect(result.digest).toBe(createHash('sha256').update(whole, 'utf8').digest('hex'))
    // Deterministic across calls.
    const again = migrationSnapshotEventPayloadDigest(foldedSubtreePayload(subtree))
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.digest).toBe(result.digest)
  })

  test('every valid non-surrogate BMP code unit encodes exactly like JSON.stringify, shallow and deep', () => {
    // The classes JSON.stringify distinguishes, swept where the escaper can
    // go wrong: U+E000–U+FFFF must be RAW (never their \uXXXX spelling),
    // controls and lone surrogates must escape, pairs must survive. Each
    // probe digests a folded subtree whose reference bytes are computed with
    // plain JSON.stringify semantics.
    const leaves = [
      'private use \uE000 here',
      '\uE000\uF8FF\uFFFD\uFFFF ends',
      'plane marks \u2028\u2029 kept raw',
      'c1 \u0080\u009F and DEL \u007F raw',
      'lone \uD800 and \uDFFF surrogates',
      'pair \uD83D\uDE00 and quote " backslash \\ control \u0001\t',
    ]
    for (const leaf of leaves) {
      const result = migrationSnapshotEventPayloadDigest(foldedSubtreePayload({ hidden: leaf }))
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      const canonical = referenceCanonicalJson({ hidden: leaf })
      const foldHex = createHash('sha256').update(canonical, 'utf8').digest('hex')
      let whole = `"~deep:${Buffer.byteLength(canonical, 'utf8')}:${foldHex}"`
      for (let depth = 0; depth < PAYLOAD_CANONICAL_MAX_DEPTH + 1; depth += 1) {
        whole = `{"layer":${whole}}`
      }
      expect(result.digest).toBe(createHash('sha256').update(whole, 'utf8').digest('hex'))
      // The same leaf in the SHALLOW path (no fold) must agree with plain
      // JSON.stringify bytes too.
      const shallow = migrationSnapshotEventPayloadDigest({ hidden: leaf })
      expect(shallow.ok).toBe(true)
      if (!shallow.ok) continue
      expect(shallow.digest).toBe(
        createHash('sha256')
          .update(JSON.stringify({ hidden: leaf }), 'utf8')
          .digest('hex')
      )
    }
  })

  test('the total byte budget is exact: one byte under digests, one byte over trips', () => {
    // The budget covers the WHOLE encoding, shallow included: a bare string
    // pays only its two quotes.
    const fits = PAYLOAD_CANONICAL_MAX_BYTES - 2
    const within = migrationSnapshotEventPayloadDigest('u'.repeat(fits))
    expect(within.ok).toBe(true)
    const over = migrationSnapshotEventPayloadDigest('u'.repeat(fits + 1))
    expect(over).toEqual({
      marker: MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER,
      ok: false,
      reason: 'payload_too_large_to_digest',
    })
  })

  test('deep folds draw from the same total budget as shallow values', () => {
    // One fold comfortably inside the budget still digests…
    const single = migrationSnapshotEventPayloadDigest(
      foldedSubtreePayload({ hidden: 'x'.repeat(PAYLOAD_CANONICAL_MAX_BYTES - 4_096) })
    )
    expect(single.ok).toBe(true)
    // …but two branches that fit individually overspend the shared budget.
    const branch = { deep: foldedSubtreePayload({ hidden: 'x'.repeat(600_000) }) }
    const both = migrationSnapshotEventPayloadDigest({ a: branch, b: branch })
    expect(both).toEqual({
      marker: MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER,
      ok: false,
      reason: 'payload_too_large_to_digest',
    })
  })

  test('a wide shallow object overspends the total work budget and is refused', () => {
    const wide: Record<string, number> = {}
    for (let index = 0; index < PAYLOAD_CANONICAL_MAX_WORK + 1; index += 1) wide[`k${index}`] = 1
    const result = migrationSnapshotEventPayloadDigest(wide)
    expect(result).toEqual({
      marker: MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER,
      ok: false,
      reason: 'payload_too_large_to_digest',
    })
  })

  test('two different oversized payloads share only the explicit inconclusive identity', () => {
    const left = migrationSnapshotEventPayloadDigest(
      foldedSubtreePayload({ hidden: 'l'.repeat(PAYLOAD_CANONICAL_MAX_BYTES) })
    )
    const right = migrationSnapshotEventPayloadDigest(
      foldedSubtreePayload({ hidden: 'r'.repeat(PAYLOAD_CANONICAL_MAX_BYTES) })
    )
    // Deterministic: the same input always yields the same typed outcome, and
    // over-limit payloads yield the one explicitly-inconclusive outcome.
    expect(left).toEqual(right)
    if (!left.ok) {
      // …and that outcome can never pass for any payload's digest.
      expect(left.marker).toMatch(/^~inconclusive:/)
      expect(left.marker).not.toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('a subtree nested past the deep work bound trips the typed limit, fast', () => {
    const result = migrationSnapshotEventPayloadDigest(
      nestArraysAtDepth('leaf', PAYLOAD_CANONICAL_MAX_WORK * 2)
    )
    expect(result).toEqual({
      marker: MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER,
      ok: false,
      reason: 'payload_too_large_to_digest',
    })
  })
})

describe('migrationSnapshotEventPayloadDigestField', () => {
  test('a digestible payload yields the 64-hex digest', () => {
    expect(migrationSnapshotEventPayloadDigestField({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  test('an oversized payload yields the inconclusive marker, never a digest', () => {
    const field = migrationSnapshotEventPayloadDigestField(
      foldedSubtreePayload('x'.repeat(PAYLOAD_CANONICAL_MAX_BYTES + 1))
    )
    expect(field).toBe(MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER)
    expect(field).not.toMatch(/^[0-9a-f]{64}$/)
  })
})

// ─── Input validation before any database work ───────────────────────────────

function rejectingDatabase(): AgentHqDatabase {
  return {
    transaction: () => {
      throw new Error('database must not be touched for invalid input')
    },
  } as unknown as AgentHqDatabase
}

describe('captureMigrationSnapshot input validation', () => {
  test('blank identity fields are rejected before the database is touched', async () => {
    for (const identity of [
      { ...IDENTITY, rehearsalId: '' },
      { ...IDENTITY, snapshotId: '' },
      { ...IDENTITY, source: '' },
      { ...IDENTITY, capturedAt: new Date(Number.NaN) },
      { ...IDENTITY, capturedAt: 'not-a-date' as unknown as Date },
    ]) {
      await expect(captureMigrationSnapshot(rejectingDatabase(), { identity })).rejects.toThrow(
        MigrationSnapshotCaptureInputError
      )
    }
  })

  test('an out-of-range per-family bound is rejected', async () => {
    for (const limitPerFamily of [0, -3, 10_001, 1.5]) {
      await expect(
        captureMigrationSnapshot(rejectingDatabase(), { identity: IDENTITY, limitPerFamily })
      ).rejects.toThrow(MigrationSnapshotCaptureInputError)
    }
  })

  test('a valid request opens exactly one read-only repeatable-read transaction', async () => {
    const seen: { config?: unknown } = {}
    const database = {
      transaction: (_operation: unknown, config: unknown) => {
        seen.config = config
        throw new Error('stop-inside-transaction')
      },
    } as unknown as AgentHqDatabase
    await expect(captureMigrationSnapshot(database, { identity: IDENTITY })).rejects.toThrow(
      'stop-inside-transaction'
    )
    expect(seen.config).toEqual(MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG)
    expect(seen.config).toEqual({ accessMode: 'read only', isolationLevel: 'repeatable read' })
  })
})
