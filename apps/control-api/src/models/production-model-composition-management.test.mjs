import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { piDurableManagementRequestDigest } from '../pi-durable/management-governed-call.js'
import {
  createProductionGovernedManagementCall,
  createProductionPiLeadComposition,
} from './production-model-composition.ts'

const TARGET = 'prj_01JABCDEF0123456789ABCDEFG'

const baseRequest = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  audit: {
    principalRef: 'user:0f3a2e1c-0000-4000-8000-0000000000bb',
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  },
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  grant: {
    operations: ['project.update'],
    profileId: 'prf_01JABCDEF0123456789ABCDEFG',
    toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
    toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  },
  idempotencyKey: 'lead:management:project.update:1',
  input: { name: 'Renamed' },
  operation: 'project.update',
  policySnapshotRef: 'policy://fixture',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  requestedAt: '2026-10-09T12:00:00.000Z',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
}

function minimalProductionBase() {
  const fn = async () => {}
  return {
    admission: { scopeAuthority: {} },
    modelConnections: { currentAccountAuthority: { readCurrent: fn } },
    product: { readCurrent: fn },
    profiles: { resolveImmutable: fn },
    publicationAuthority: fn,
    reconcileInference: fn,
    releaseExpired: fn,
  }
}

function ingredients(counts) {
  return {
    async issue({ request }) {
      counts.issued += 1
      return {
        canonicalRequestDigest: piDurableManagementRequestDigest(request),
        decision: `decision-${counts.issued}`,
        decisionId: `decision-id-${counts.issued}`,
        expiresAt: '2026-10-09T12:02:00.000Z',
      }
    },
    async callAdea(input) {
      counts.calls += 1
      return { ok: true, value: { id: input.targetId } }
    },
    resolveTargetId: () => TARGET,
  }
}

/** Composition gates: fail closed before any directory/SQLite allocation. */
test('management call options fail closed before directory or SQLite creation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-management-call-gates-'))
  const fn = async () => {}
  try {
    // Ingredients without the management current authority.
    const noAuthority = join(parent, 'no-authority')
    await expect(
      createProductionPiLeadComposition({
        ...minimalProductionBase(),
        directory: noAuthority,
        fundingDirectory: parent,
        managementCall: { issue: fn, callAdea: fn, resolveTargetId: () => TARGET },
      })
    ).rejects.toThrow('PI_PRODUCTION_BINDING_REQUIRED')
    expect(existsSync(noAuthority)).toBe(false)

    // Both ports at once: two sources for one runtime port is ambiguous.
    const both = join(parent, 'both')
    await expect(
      createProductionPiLeadComposition({
        ...minimalProductionBase(),
        directory: both,
        fundingDirectory: parent,
        managementAuthority: { service: { execute: fn }, interactions: { get: fn } },
        managementCall: { issue: fn, callAdea: fn, resolveTargetId: () => TARGET },
        governedManagementCall: { execute: async () => ({ state: 'succeeded', value: null }) },
      })
    ).rejects.toThrow('PI_PRODUCTION_BINDING_REQUIRED')
    expect(existsSync(both)).toBe(false)

    // Malformed ingredients.
    const malformed = join(parent, 'malformed')
    await expect(
      createProductionPiLeadComposition({
        ...minimalProductionBase(),
        directory: malformed,
        fundingDirectory: parent,
        managementAuthority: { service: { execute: fn }, interactions: { get: fn } },
        managementCall: { issue: fn, resolveTargetId: () => TARGET },
      })
    ).rejects.toThrow('PI_PRODUCTION_BINDING_REQUIRED')
    expect(existsSync(malformed)).toBe(false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('retains the gate store on the runtime journal database and survives reopen without reissuing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-management-call-journal-'))
  const path = join(directory, 'authority.sqlite')
  const counts = { issued: 0, calls: 0 }
  const boundaries = []
  const authority = {
    async assertCurrent(request, boundary) {
      boundaries.push(boundary)
    },
  }
  try {
    let database = new DatabaseSync(path, { timeout: 5000 })
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    const caller = createProductionGovernedManagementCall({
      authority,
      database,
      call: ingredients(counts),
    })
    // The store colocates its retained schema on the journal instance itself.
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'pi_management_call_gates'"
      )
      .get()
    expect(tables).toBeDefined()

    expect(await caller.execute(baseRequest)).toEqual({
      state: 'succeeded',
      value: { id: TARGET },
    })
    expect(counts).toEqual({ issued: 1, calls: 1 })
    // Repeatable boundary checks: admission before the claim, effect before
    // dispatch — never consuming an approval (the request carries none).
    expect(boundaries).toEqual(['admission', 'effect'])
    const stored = database.prepare('SELECT revision, record FROM pi_management_call_gates').all()
    expect(stored).toHaveLength(1)
    const record = JSON.parse(String(stored[0]['record']))
    expect(record['revision']).toBeGreaterThanOrEqual(3)
    expect(record['requestDigest']).toBe(piDurableManagementRequestDigest(baseRequest))

    // Real reopen on the same journal file: the retained outcome answers the
    // repeat with zero new decisions and zero new physical calls.
    database.close()
    database = new DatabaseSync(path, { timeout: 5000 })
    const reopenedCounts = { issued: 0, calls: 0 }
    const reopenedBoundaries = []
    const reopened = createProductionGovernedManagementCall({
      authority: {
        async assertCurrent(request, boundary) {
          reopenedBoundaries.push(boundary)
        },
      },
      database,
      call: ingredients(reopenedCounts),
    })
    expect(await reopened.execute(baseRequest)).toEqual({
      state: 'succeeded',
      value: { id: TARGET },
    })
    expect(reopenedCounts).toEqual({ issued: 0, calls: 0 })
    database.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
