import { describe, expect, test } from 'bun:test'

import {
  compareMigrationSnapshots,
  MigrationSnapshotIdentityError,
} from '../../src/migration-snapshot-comparator'
import type {
  MigrationSnapshotComparison,
  MigrationSnapshotDocument,
  MigrationSnapshotFamily,
  MigrationSnapshotFinding,
  MigrationSnapshotRecord,
  MigrationSnapshotSections,
} from '@adea-ai/types'
import {
  migrationSnapshotFamilies,
  migrationSnapshotFindingClasses,
  migrationSnapshotFindingDetailKeys,
} from '@adea-ai/types'

// The comparator is pure: every test feeds frozen documents and asserts on the
// returned verdict, findings and inventory. No database is involved anywhere.

const BEFORE_IDENTITY = {
  formatVersion: 1,
  rehearsalId: 'rehearsal-1181',
  snapshotId: 'snapshot-before',
  source: 'unit',
} as const

function doc(
  sections: MigrationSnapshotSections,
  snapshotId = 'snapshot-after'
): MigrationSnapshotDocument {
  return Object.freeze({
    identity: Object.freeze({ ...BEFORE_IDENTITY, snapshotId }),
    sections: Object.freeze(sections),
  })
}

function section(records: MigrationSnapshotRecord[], truncated = false) {
  return Object.freeze({ records: Object.freeze(records), truncated })
}

function compare(
  beforeSections: MigrationSnapshotSections,
  afterSections: MigrationSnapshotSections
) {
  return compareMigrationSnapshots({
    before: doc(beforeSections, 'snapshot-before'),
    after: doc(afterSections),
  })
}

function findingsFor(
  comparison: MigrationSnapshotComparison,
  family: MigrationSnapshotFamily,
  findingClass?: MigrationSnapshotFinding['findingClass']
): MigrationSnapshotFinding[] {
  return comparison.findings.filter(
    (finding) =>
      finding.family === family &&
      (findingClass === undefined || finding.findingClass === findingClass)
  )
}

/** Every finding class reported for one family, sorted. */
function familyClasses(
  comparison: MigrationSnapshotComparison,
  family: MigrationSnapshotFamily
): string[] {
  return [
    ...new Set(findingsFor(comparison, family).map((finding) => finding.findingClass)),
  ].toSorted()
}

const membership = (
  userId: string,
  role: 'admin' | 'member' | 'owner' = 'member'
): MigrationSnapshotRecord => ({
  family: 'memberships',
  role,
  userId,
  workspaceId: 'wsp-1',
})

const participant = (userId: string): MigrationSnapshotRecord => ({
  channelId: 'ch-1',
  family: 'channelParticipants',
  principalId: userId,
  principalKind: 'user',
  workspaceId: 'wsp-1',
})

const readState = (
  lastReadSequence: number,
  threadRootMessageId: string | null = null
): MigrationSnapshotRecord => ({
  channelId: 'ch-1',
  family: 'readState',
  lastReadSequence,
  manuallyUnread: false,
  threadRootMessageId,
  userId: 'user-1',
  workspaceId: 'wsp-1',
})

const attempt = (runtimeNodeId: string | null, attemptNumber = 1): MigrationSnapshotRecord => ({
  attempt: attemptNumber,
  family: 'executionAttempts',
  locationKind: runtimeNodeId === null ? 'agent_hq_cloud' : 'local_device',
  runtimeNodeId,
  taskId: 'task-1',
  workspaceId: 'wsp-1',
})

const contentRef = (digest: string): MigrationSnapshotRecord => ({
  availability: 'available',
  contentRefId: 'cref-1',
  digestSha256: digest,
  family: 'contentRefs',
  keyVersion: 1,
  messageId: null,
  revision: 1,
  taskId: null,
  workspaceId: 'wsp-1',
})

const event = (
  overrides: Partial<Extract<MigrationSnapshotRecord, { family: 'events' }>> = {}
): MigrationSnapshotRecord => ({
  eventId: 'evt-1',
  eventType: 'workspace.created',
  family: 'events',
  payloadDigest: 'a'.repeat(64),
  schemaVersion: 1,
  workspaceId: 'wsp-1',
  workspaceSequence: 1,
  ...overrides,
})

const channel = (visibility: 'participants' | 'workspace'): MigrationSnapshotRecord => ({
  channelId: 'ch-1',
  family: 'channels',
  projectId: null,
  visibility,
  workspaceId: 'wsp-1',
})

const task = (version: number): MigrationSnapshotRecord => ({
  channelId: 'ch-1',
  creatorUserId: 'user-1',
  family: 'tasks',
  lifecycleState: 'created',
  messageId: 'msg-1',
  projectId: null,
  taskId: 'task-1',
  threadRootMessageId: null,
  version,
  workspaceId: 'wsp-1',
})

const projectMember = (workspaceId: string): MigrationSnapshotRecord => ({
  family: 'projectMembers',
  projectId: 'prj-1',
  role: 'viewer',
  userId: 'user-1',
  workspaceId,
})

const attemptIn = (workspaceId: string): MigrationSnapshotRecord => ({
  attempt: 1,
  family: 'executionAttempts',
  locationKind: 'local_device',
  runtimeNodeId: 'node-1',
  taskId: 'task-1',
  workspaceId,
})

/** A document with every family present; the given records fill one family. */
const documentWithFamily = (
  records: MigrationSnapshotRecord[],
  family: MigrationSnapshotFamily,
  snapshotId: string
): MigrationSnapshotDocument => {
  const sections: MigrationSnapshotSections = {}
  for (const candidate of migrationSnapshotFamilies) {
    sections[candidate] = candidate === family ? section(records) : section([])
  }
  return doc(sections, snapshotId)
}

const leadTurnRuntime = (
  overrides: Partial<Extract<MigrationSnapshotRecord, { family: 'leadTurnRuntime' }>> = {}
): MigrationSnapshotRecord => ({
  attemptId: 'att-1',
  cancelRequested: false,
  executionId: 'exe-1',
  family: 'leadTurnRuntime',
  intentId: 'intent-1',
  publishedMessageId: null,
  runtimeSessionId: null,
  state: 'prepared',
  ...overrides,
})

const runtimeNode = (
  overrides: Partial<Extract<MigrationSnapshotRecord, { family: 'runtimeNodes' }>> = {}
): MigrationSnapshotRecord => ({
  family: 'runtimeNodes',
  kind: 'remote_host',
  pairingState: 'paired',
  platform: 'darwin',
  revoked: false,
  runtimeNodeId: 'node-1',
  softwareVersion: '1.0.0',
  workspaceId: 'wsp-1',
  ...overrides,
})

const submission = (
  overrides: Partial<Extract<MigrationSnapshotRecord, { family: 'taskSubmissions' }>> = {}
): MigrationSnapshotRecord => ({
  agentId: 'agent-1',
  ciphertextPurged: false,
  family: 'taskSubmissions',
  locationKind: 'remote_host',
  profileId: 'prf-1',
  profileRevision: 1,
  profileVersion: 'pfv-1',
  runtimeNodeId: 'node-1',
  state: 'pending_delivery',
  submissionId: 'sub-1',
  taskId: 'task-1',
  taskVersion: 1,
  workspaceId: 'wsp-1',
  ...overrides,
})

const grant = (
  overrides: Partial<Extract<MigrationSnapshotRecord, { family: 'artifactReferenceGrants' }>> = {}
): MigrationSnapshotRecord => ({
  artifactId: 'art-1',
  audienceWorkspaceId: 'wsp-2',
  checksumSha256: 'a'.repeat(64),
  expiresAt: null,
  family: 'artifactReferenceGrants',
  grantId: 'grant-1',
  revision: 1,
  revoked: false,
  sourceWorkspaceId: 'wsp-1',
  version: 1,
  ...overrides,
})

/**
 * One drift mutation per captured field the root review found uncompared.
 * Every case must be a determinate, non-identical finding on the exact field:
 * a captured field absent from `FAMILY_COMPARISONS` would compare identical.
 */
const FIELD_DRIFT_CASES: ReadonlyArray<{
  after: MigrationSnapshotRecord
  before: MigrationSnapshotRecord
  expectedClass: MigrationSnapshotFinding['findingClass']
  family: MigrationSnapshotFamily
  field: string
}> = [
  {
    after: leadTurnRuntime({ runtimeSessionId: 'sess-1' }),
    before: leadTurnRuntime(),
    expectedClass: 'remapped_record',
    family: 'leadTurnRuntime',
    field: 'runtimeSessionId',
  },
  {
    after: leadTurnRuntime({ publishedMessageId: 'msg-9' }),
    before: leadTurnRuntime(),
    expectedClass: 'remapped_record',
    family: 'leadTurnRuntime',
    field: 'publishedMessageId',
  },
  {
    after: submission({ profileId: 'prf-2' }),
    before: submission(),
    expectedClass: 'remapped_record',
    family: 'taskSubmissions',
    field: 'profileId',
  },
  {
    after: submission({ profileVersion: 'pfv-2' }),
    before: submission(),
    expectedClass: 'digest_drift',
    family: 'taskSubmissions',
    field: 'profileVersion',
  },
  {
    after: submission({ locationKind: 'local_device' }),
    before: submission(),
    expectedClass: 'remapped_record',
    family: 'taskSubmissions',
    field: 'locationKind',
  },
  {
    after: runtimeNode({ platform: 'linux' }),
    before: runtimeNode(),
    expectedClass: 'changed_attribute',
    family: 'runtimeNodes',
    field: 'platform',
  },
  {
    after: runtimeNode({ softwareVersion: '2.0.0' }),
    before: runtimeNode(),
    expectedClass: 'digest_drift',
    family: 'runtimeNodes',
    field: 'softwareVersion',
  },
  {
    after: grant({ expiresAt: '2026-06-01T00:00:00.000Z' }),
    before: grant(),
    expectedClass: 'changed_attribute',
    family: 'artifactReferenceGrants',
    field: 'expiresAt',
  },
  {
    after: grant(),
    before: grant({ expiresAt: '2026-06-01T00:00:00.000Z' }),
    expectedClass: 'changed_attribute',
    family: 'artifactReferenceGrants',
    field: 'expiresAt',
  },
  {
    after: grant({ expiresAt: '2027-01-01T00:00:00.000Z' }),
    before: grant({ expiresAt: '2026-06-01T00:00:00.000Z' }),
    expectedClass: 'changed_attribute',
    family: 'artifactReferenceGrants',
    field: 'expiresAt',
  },
]

const allFamilySections = (
  records: MigrationSnapshotRecord[],
  family: MigrationSnapshotFamily
) => ({
  [family]: section(records),
})

/** A document that captures every family, so a clean compare is `identical`. */
const fullDocument = (
  identityBindings: MigrationSnapshotRecord[],
  snapshotId: string
): MigrationSnapshotDocument => {
  const sections: MigrationSnapshotSections = {}
  for (const family of migrationSnapshotFamilies) {
    sections[family] = family === 'identityBindings' ? section(identityBindings) : section([])
  }
  return doc(sections, snapshotId)
}

/**
 * A document with every family present — the given records under
 * `memberships`, everything else empty — so a clean compare is `identical`.
 */
const documentWithMemberships = (
  memberships: MigrationSnapshotRecord[],
  snapshotId: string
): MigrationSnapshotDocument => {
  const sections: MigrationSnapshotSections = {}
  for (const family of migrationSnapshotFamilies) {
    sections[family] = family === 'memberships' ? section(memberships) : section([])
  }
  return doc(sections, snapshotId)
}

/** Serialized byte length of a printable-ASCII fixture (see the types suite). */
const serializedBytes = (value: unknown): number => JSON.stringify(value).length

describe('migration snapshot comparator review repairs', () => {
  test('a workspace-only change on a channel participant is a typed remap, never identical', () => {
    const comparison = compare(
      { channelParticipants: section([{ ...participant('user-1'), workspaceId: 'wsp-1' }]) },
      { channelParticipants: section([{ ...participant('user-1'), workspaceId: 'wsp-2' }]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'channelParticipants', 'remapped_record')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail.field).toBe('workspaceId')
    expect(findings[0]?.detail.before).toBe('wsp-1')
    expect(findings[0]?.detail.after).toBe('wsp-2')
  })

  test('a workspace-only change on a project member is a typed remap, never identical', () => {
    const comparison = compare(
      { projectMembers: section([projectMember('wsp-1')]) },
      { projectMembers: section([projectMember('wsp-2')]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'projectMembers', 'remapped_record')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail.field).toBe('workspaceId')
  })

  test('a workspace-only change on the active execution attempt is a conflicting owner, never identical', () => {
    const comparison = compare(
      { executionAttempts: section([attemptIn('wsp-1')]) },
      { executionAttempts: section([attemptIn('wsp-2')]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'executionAttempts', 'conflicting_attempt_owner')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail.field).toBe('workspaceId')
  })

  test('a record filed under the wrong family section is quarantined before comparison, never compared', () => {
    // Two membership rows sit in the events section and disagree on role.
    // The mismatch must be caught before comparison: the role drift may
    // never be compared under the events family (which would mask it).
    const comparison = compare(
      { events: section([membership('user-1', 'member')]) },
      { events: section([membership('user-1', 'admin')]) }
    )
    const quarantined = findingsFor(comparison, 'events', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    expect(quarantined.map((finding) => finding.side).toSorted()).toEqual(['after', 'before'])
    for (const finding of quarantined) {
      expect(finding.detail.field).toBe('family')
      expect(finding.detail.reason).toBe('family_mismatch')
    }
    // No comparison finding may be derived from the misfiled rows.
    expect(familyClasses(comparison, 'events')).toEqual(['quarantined_record'])
    expect(findingsFor(comparison, 'events', 'remapped_record')).toHaveLength(0)
    expect(findingsFor(comparison, 'events', 'widened_access')).toHaveLength(0)
    expect(findingsFor(comparison, 'events', 'changed_attribute')).toHaveLength(0)
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('a section without truncation evidence is rejected, never read as complete', () => {
    const noEvidence = {
      memberships: { records: [membership('user-1')] },
    } as MigrationSnapshotSections
    for (const broken of [
      noEvidence,
      {
        memberships: { records: [membership('user-1')], truncated: 'yes' },
      } as MigrationSnapshotSections,
    ]) {
      let thrown: unknown
      try {
        compareMigrationSnapshots({
          before: doc(noEvidence, 'snapshot-before'),
          after: doc(broken),
        })
      } catch (error) {
        thrown = error
      }
      expect((thrown as Error | undefined)?.name).toBe('MigrationSnapshotStructureError')
      expect((thrown as Error | undefined)?.message).toMatch(/truncation evidence/)
    }
  })

  test('a null record is quarantined and the comparison can never be identical', () => {
    const comparison = compare(
      {
        memberships: section([membership('user-1'), null as unknown as MigrationSnapshotRecord]),
      },
      { memberships: section([membership('user-1')]) }
    )
    const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.detail.reason).toBe('malformed')
    expect(quarantined[0]?.detail.field).toBe('record')
    expect(findingsFor(comparison, 'memberships', 'missing_record')).toHaveLength(0)
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('a section over its declared limit or the record cap is a typed limit violation', () => {
    let thrown: unknown
    try {
      compareMigrationSnapshots({
        before: doc({ memberships: section([membership('user-1')]) }, 'snapshot-before'),
        after: doc({
          memberships: Object.freeze({
            records: Object.freeze([membership('user-1'), membership('user-2')]),
            truncated: false,
            limit: 1,
          }) as MigrationSnapshotSections['memberships'],
        }),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error | undefined)?.name).toBe('MigrationSnapshotStructureError')
    expect((thrown as Error | undefined)?.message).toMatch(/declared limit/)

    const overCap = Array.from({ length: 10_001 }, (_, index) => membership(`user-${index}`))
    thrown = undefined
    try {
      compareMigrationSnapshots({
        before: doc({ memberships: section([membership('user-1')]) }, 'snapshot-before'),
        after: doc({ memberships: section(overCap) }),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error | undefined)?.name).toBe('MigrationSnapshotStructureError')
    expect((thrown as Error | undefined)?.message).toMatch(/maximum/)
  })

  test('an output beyond the findings bound is rejected with a typed limit violation', () => {
    const many = Array.from({ length: 4_200 }, (_, index) => membership(`user-${index}`))
    let thrown: unknown
    try {
      compareMigrationSnapshots({
        before: doc({ memberships: section(many) }, 'snapshot-before'),
        after: doc({ memberships: section(many.slice(1)) }),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error | undefined)?.name).toBe('MigrationSnapshotStructureError')
    expect((thrown as Error | undefined)?.message).toMatch(/findings/)
  })

  test('arbitrary text in a digest field never surfaces; only the opaque reference is emitted', () => {
    const comparison = compare(
      { events: section([event({ payloadDigest: 'SECRET-NOMINAL-DIGEST-TEXT' })]) },
      { events: section([event()]) }
    )
    // The unreadable row is quarantined, never compared, so no digest drift
    // may be reported from it; the counterpart still reports as unexpected.
    const quarantined = findingsFor(comparison, 'events', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.detail.field).toBe('payloadDigest')
    expect(quarantined[0]?.detail.reason).toBe('malformed')
    expect(quarantined[0]?.stableId).toMatch(/^unverifiable:[0-9a-f]{64}$/)
    expect(findingsFor(comparison, 'events', 'digest_drift')).toHaveLength(0)
    expect(comparison.verdict).toBe('divergent')
    const serialized = JSON.stringify(comparison)
    expect(serialized.includes('SECRET-NOMINAL-DIGEST-TEXT')).toBe(false)
    expect(serialized.includes('SECRET')).toBe(false)
  })

  test('an ill-formed identifier drift is reported through opaque references only', () => {
    const comparison = compare(
      { events: section([event({ eventType: 'workspace.created; DROP TABLE events' })]) },
      { events: section([event({ eventType: 'workspace.created\0evil' })]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'events', 'remapped_record')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail.field).toBe('eventType')
    expect(findings[0]?.detail.before).toMatch(/^opaque:string:[0-9a-f]{16}$/)
    expect(findings[0]?.detail.after).toMatch(/^opaque:string:[0-9a-f]{16}$/)
    const serialized = JSON.stringify(comparison)
    expect(serialized.includes('DROP TABLE')).toBe(false)
    expect(serialized.includes('evil')).toBe(false)
  })

  test('malformed-record fingerprints are canonical: object key order cannot change the outcome', () => {
    const malformed = {
      role: 'member',
      workspaceId: 'wsp-1',
      host: 'HOSTILE-EXTRA-VALUE',
      family: 'memberships',
    } as MigrationSnapshotRecord
    const reordered = {
      family: 'memberships',
      workspaceId: 'wsp-1',
      host: 'HOSTILE-EXTRA-VALUE',
      role: 'member',
    } as MigrationSnapshotRecord
    const forward = compare(
      { memberships: section([membership('user-1'), malformed]) },
      { memberships: section([membership('user-1')]) }
    )
    const reversed = compare(
      { memberships: section([membership('user-1'), reordered]) },
      { memberships: section([membership('user-1')]) }
    )
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward))
    const quarantined = findingsFor(forward, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.detail.field).toBe('userId')
    expect(quarantined[0]?.stableId).toMatch(/^unverifiable:[0-9a-f]{64}$/)
    expect(JSON.stringify(forward).includes('HOSTILE-EXTRA-VALUE')).toBe(false)
    expect(forward.verdict).toBe('inconclusive')
  })

  test('conflicting duplicate records are quarantined deterministically regardless of input order', () => {
    const afterCopies = (reverse: boolean): MigrationSnapshotRecord[] => {
      const copies = [
        event({ payloadDigest: 'a'.repeat(64) }),
        event({ payloadDigest: 'b'.repeat(64) }),
      ]
      return reverse ? copies.toReversed() : copies
    }
    const forward = compare(
      { events: section([event({ payloadDigest: 'a'.repeat(64) })]) },
      { events: section(afterCopies(false)) }
    )
    const reversed = compare(
      { events: section([event({ payloadDigest: 'a'.repeat(64) })]) },
      { events: section(afterCopies(true)) }
    )
    // The outcome must not depend on which conflicting copy came first.
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward))
    expect(findingsFor(forward, 'events', 'duplicated_record')).toHaveLength(1)
    const quarantined = findingsFor(forward, 'events', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.detail.reason).toBe('conflicting_duplicate')
    expect(quarantined[0]?.stableId).toBe('evt-1')
    // The conflicting row is excluded from matching: no digest drift may be
    // derived from either unreadable copy.
    expect(findingsFor(forward, 'events', 'digest_drift')).toHaveLength(0)
    expect(familyClasses(forward, 'events').toSorted()).toEqual([
      'duplicated_record',
      'missing_record',
      'quarantined_record',
    ])
    expect(forward.verdict).toBe('divergent')
  })
})

describe('migration snapshot comparator', () => {
  test('identical snapshots of every known domain yield an identical verdict with zero findings', () => {
    const sections: MigrationSnapshotSections = {
      agents: section([]),
      channelParticipants: section([participant('user-1')]),
      channels: section([
        {
          channelId: 'ch-1',
          family: 'channels',
          projectId: null,
          visibility: 'workspace',
          workspaceId: 'wsp-1',
        },
      ]),
      contentRefs: section([contentRef('a'.repeat(64))]),
      events: section([event()]),
      executionAttempts: section([attempt('node-1')]),
      identityBindings: section([
        { family: 'identityBindings', provider: 'google', subject: 'subject-1', userId: 'user-1' },
      ]),
      invitations: section([
        {
          family: 'invitations',
          invitationId: 'inv-1',
          invitedByUserId: 'user-1',
          role: 'member',
          state: 'pending',
          workspaceId: 'wsp-1',
        },
      ]),
      memberships: section([membership('user-1')]),
      messages: section([
        {
          channelId: 'ch-1',
          deleted: false,
          family: 'messages',
          messageId: 'msg-1',
          threadRootMessageId: null,
          workspaceId: 'wsp-1',
        },
      ]),
      projectMembers: section([]),
      projects: section([
        { family: 'projects', projectId: 'prj-1', visibility: 'workspace', workspaceId: 'wsp-1' },
      ]),
      readState: section([readState(5), readState(3, 'msg-root')]),
      tasks: section([
        {
          channelId: 'ch-1',
          creatorUserId: 'user-1',
          family: 'tasks',
          lifecycleState: 'in_progress',
          messageId: 'msg-1',
          projectId: null,
          taskId: 'task-1',
          threadRootMessageId: null,
          version: 2,
          workspaceId: 'wsp-1',
        },
      ]),
      temporarySessions: section([
        { claimed: false, family: 'temporarySessions', sessionId: 'sess-1', userId: 'user-1' },
      ]),
      workspaces: section([
        {
          archived: false,
          controlPlaneWorkspaceId: 'wsp_01AAAAAAAAAAAAAAAAAAAAAAAA',
          family: 'workspaces',
          ownerUserId: 'user-1',
          workspaceId: 'wsp-1',
        },
      ]),
      artifactReferenceGrants: section([
        {
          artifactId: 'art-1',
          audienceWorkspaceId: 'wsp-2',
          checksumSha256: 'a'.repeat(64),
          expiresAt: null,
          family: 'artifactReferenceGrants',
          grantId: 'grant-1',
          revoked: false,
          revision: 1,
          sourceWorkspaceId: 'wsp-1',
          version: 1,
        },
      ]),
      contentReplicas: section([
        {
          availability: 'available',
          contentRefId: 'ref-1',
          deleted: false,
          digestSha256: 'b'.repeat(64),
          family: 'contentReplicas',
          replicaId: 'rep-1',
          replicaKind: 'cloud_safe',
          revision: 1,
          schemaVersion: 1,
          workspaceId: 'wsp-1',
        },
      ]),
      leadTurnRuntime: section([
        {
          attemptId: 'att-1',
          cancelRequested: false,
          executionId: 'exe-1',
          family: 'leadTurnRuntime',
          intentId: 'intent-1',
          publishedMessageId: null,
          runtimeSessionId: 'sess-1',
          state: 'prepared',
        },
      ]),
      nativeSessions: section([
        {
          accountId: 'acct-1',
          activeHarnessRunId: null,
          agentProfileId: 'prf-1',
          agentProfileVersion: 1,
          archived: false,
          family: 'nativeSessions',
          generation: 1,
          harnessInstallationId: null,
          lifecycle: 'ready',
          projectId: 'prj-1',
          runtimeNodeId: 'node-1',
          sessionRef: 'session-1',
          version: 1,
          workspaceId: 'wsp-1',
          worktreeId: 'wt-1',
        },
      ]),
      runtimeNodes: section([
        {
          family: 'runtimeNodes',
          kind: 'local_device',
          pairingState: 'paired',
          platform: 'darwin',
          revoked: false,
          runtimeNodeId: 'node-1',
          softwareVersion: '1.0.0',
          workspaceId: 'wsp-1',
        },
      ]),
      taskSubmissions: section([
        {
          agentId: 'agent-1',
          ciphertextPurged: false,
          family: 'taskSubmissions',
          locationKind: 'local_device',
          profileId: 'prf-1',
          profileRevision: 1,
          profileVersion: 'pfv-1',
          runtimeNodeId: 'node-1',
          state: 'prepared',
          submissionId: 'sub-1',
          taskId: 'task-1',
          taskVersion: 1,
          workspaceId: 'wsp-1',
        },
      ]),
    }
    const comparison = compare(sections, sections)

    expect(comparison.verdict).toBe('identical')
    expect(comparison.findings).toEqual([])
    expect(comparison.counts.byClass).toEqual({})
    expect(comparison.counts.byFamily).toEqual({})
    // The inventory reports real counts for every captured family — an
    // unknown appears only for a family neither side captured.
    for (const entry of comparison.inventory) {
      expect(entry.before).not.toBeNull()
      expect(entry.after).not.toBeNull()
    }
    expect(comparison.inventory.find((entry) => entry.family === 'readState')?.before).toBe(2)
  })

  test('a declared-empty section is a proven fact, not an unknown domain', () => {
    const comparison = compare({ events: section([]) }, { events: section([]) })
    // `events` was captured empty on both sides: proven, so no unknown-domain
    // finding names it and the inventory says zero, not null.
    expect(findingsFor(comparison, 'events')).toEqual([])
    const inventory = comparison.inventory.find((entry) => entry.family === 'events')
    expect(inventory?.before).toBe(0)
    expect(inventory?.after).toBe(0)
    // The families that were NOT captured stay unknown, so equality overall
    // is still not proven.
    expect(findingOfEveryUnknownFamily(comparison)).not.toContain('events')
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('a record present before and absent after is a missing record', () => {
    const comparison = compare(
      allFamilySections([membership('user-1'), membership('user-2')], 'memberships'),
      allFamilySections([membership('user-1')], 'memberships')
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'memberships', 'missing_record')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.side).toBe('after')
    expect(findings[0]?.stableId).toBe('wsp-1:user-2')
    expect(familyClasses(comparison, 'memberships')).toEqual(['missing_record'])
  })

  test('a non-grant record only present after is unexpected; a new grant row is widened access', () => {
    const comparison = compare(
      {
        events: section([event()]),
        memberships: section([membership('user-1')]),
      },
      {
        events: section([event(), event({ eventId: 'evt-2', workspaceSequence: 2 })]),
        memberships: section([membership('user-1'), membership('user-2')]),
      }
    )
    expect(comparison.verdict).toBe('divergent')
    expect(familyClasses(comparison, 'events')).toEqual(['unexpected_record'])
    expect(familyClasses(comparison, 'memberships')).toEqual(['widened_access'])
    const widened = findingsFor(comparison, 'memberships', 'widened_access')
    expect(widened[0]?.stableId).toBe('wsp-1:user-2')
    expect(widened[0]?.side).toBe('after')
    const unexpected = findingsFor(comparison, 'events', 'unexpected_record')
    expect(unexpected[0]?.stableId).toBe('evt-2')
  })

  test('the same stable id twice within one section is a duplicated record on that side', () => {
    const comparison = compare(
      allFamilySections([event()], 'events'),
      allFamilySections([event(), event()], 'events')
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'events', 'duplicated_record')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.side).toBe('after')
    expect(findings[0]?.detail.count).toBe('2')
    // The comparison still proceeds on the deduplicated record.
    expect(findingsFor(comparison, 'events', 'missing_record')).toHaveLength(0)
    expect(findingsFor(comparison, 'events', 'unexpected_record')).toHaveLength(0)
  })

  test('an auth identity resolving to a different user is a remapped record', () => {
    const binding = {
      family: 'identityBindings' as const,
      provider: 'google',
      subject: 'subject-1',
    }
    const comparison = compare(
      { identityBindings: section([{ ...binding, userId: 'user-1' }]) },
      { identityBindings: section([{ ...binding, userId: 'user-9' }]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'identityBindings', 'remapped_record')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail.field).toBe('userId')
    expect(findings[0]?.detail.before).toBe('user-1')
    expect(findings[0]?.detail.after).toBe('user-9')
  })

  test('digest drift is reported for content refs and event history independently', () => {
    const comparison = compare(
      {
        contentRefs: section([contentRef('a'.repeat(64))]),
        events: section([event()]),
      },
      {
        contentRefs: section([
          { ...contentRef('a'.repeat(64)), revision: 2 } as MigrationSnapshotRecord,
        ]),
        events: section([event({ payloadDigest: 'b'.repeat(64) })]),
      }
    )
    expect(comparison.verdict).toBe('divergent')
    expect(
      findingsFor(comparison, 'contentRefs', 'digest_drift').map((finding) => finding.detail.field)
    ).toEqual(['revision'])
    expect(
      findingsFor(comparison, 'events', 'digest_drift').map((finding) => finding.detail.field)
    ).toEqual(['payloadDigest'])
    // No other determinate class fires for these families.
    expect(familyClasses(comparison, 'contentRefs')).toEqual(['digest_drift'])
    expect(familyClasses(comparison, 'events')).toEqual(['digest_drift'])
  })

  test('access growth is widened access; access narrowing is an attribute change, never widened', () => {
    const grew = compare(
      {
        channelParticipants: section([]),
        memberships: section([membership('user-1', 'member')]),
        projects: section([
          { family: 'projects', projectId: 'prj-1', visibility: 'members', workspaceId: 'wsp-1' },
        ]),
      },
      {
        // A denied user gains channel access; a member is promoted; a
        // members-only project becomes workspace-visible.
        channelParticipants: section([participant('user-2')]),
        memberships: section([membership('user-1', 'admin')]),
        projects: section([
          { family: 'projects', projectId: 'prj-1', visibility: 'workspace', workspaceId: 'wsp-1' },
        ]),
      }
    )
    expect(grew.counts.byClass.widened_access).toBe(3)
    expect(familyClasses(grew, 'channelParticipants')).toEqual(['widened_access'])
    expect(familyClasses(grew, 'memberships')).toEqual(['widened_access'])
    expect(familyClasses(grew, 'projects')).toEqual(['widened_access'])

    const narrowed = compare(
      { memberships: section([membership('user-1', 'admin')]) },
      { memberships: section([membership('user-1', 'member')]) }
    )
    expect(familyClasses(narrowed, 'memberships')).toEqual(['changed_attribute'])
    expect(findingsFor(narrowed, 'memberships', 'changed_attribute')[0]?.detail.field).toBe('role')
  })

  test('a channel widened from participants to workspace visibility is widened access', () => {
    const comparison = compare(
      { channels: section([channel('participants')]) },
      { channels: section([channel('workspace')]) }
    )
    expect(familyClasses(comparison, 'channels')).toEqual(['widened_access'])
  })

  test('a regressed read frontier is lost read state, per channel and per thread', () => {
    const comparison = compare(
      { readState: section([readState(10), readState(7, 'msg-root')]) },
      { readState: section([readState(4), readState(7, 'msg-root')]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'readState', 'lost_read_state')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.stableId).toBe('wsp-1:user-1:ch-1:0:')
    expect(findings[0]?.detail.before).toBe('10')
    expect(findings[0]?.detail.after).toBe('4')
    // The untouched thread frontier produces nothing.
    expect(familyClasses(comparison, 'readState')).toEqual(['lost_read_state'])
  })

  test('a read frontier that only advanced is an attribute change, not lost state', () => {
    const comparison = compare(
      { readState: section([readState(4)]) },
      { readState: section([readState(10)]) }
    )
    expect(familyClasses(comparison, 'readState')).toEqual(['changed_attribute'])
    expect(findingsFor(comparison, 'readState', 'lost_read_state')).toHaveLength(0)
  })

  test('the active execution attempt bound to another owner is a conflicting attempt owner', () => {
    const comparison = compare(
      { executionAttempts: section([attempt('node-1')]) },
      { executionAttempts: section([attempt('node-2')]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const findings = findingsFor(comparison, 'executionAttempts', 'conflicting_attempt_owner')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.stableId).toBe('task-1:1')
    expect(findings[0]?.detail.field).toBe('runtimeNodeId')
    expect(findings[0]?.detail.before).toBe('node-1')
    expect(findings[0]?.detail.after).toBe('node-2')
  })

  test('owner drift on a superseded attempt is an attribute change, and a new active attempt is unexpected', () => {
    const superseded = compare(
      { executionAttempts: section([attempt('node-1'), attempt('node-1', 2)]) },
      { executionAttempts: section([attempt('node-9'), attempt('node-1', 2)]) }
    )
    // Attempt 2 is the active attempt on both sides and did not move; the
    // superseded row's owner drift is an attribute change.
    expect(familyClasses(superseded, 'executionAttempts')).toEqual(['changed_attribute'])
    expect(findingsFor(superseded, 'executionAttempts', 'changed_attribute')[0]?.stableId).toBe(
      'task-1:1'
    )

    const advanced = compare(
      { executionAttempts: section([attempt('node-1')]) },
      { executionAttempts: section([attempt('node-1'), attempt('node-2', 2)]) }
    )
    // The active attempt itself is a new record in the after snapshot.
    expect(familyClasses(advanced, 'executionAttempts')).toEqual(['unexpected_record'])
  })

  test('other determinate drift on a matched record is a changed attribute', () => {
    const comparison = compare({ tasks: section([task(2)]) }, { tasks: section([task(3)]) })
    expect(familyClasses(comparison, 'tasks')).toEqual(['changed_attribute'])
    expect(findingsFor(comparison, 'tasks', 'changed_attribute')[0]?.detail.field).toBe('version')
  })

  test('reordered equivalent records produce byte-identical results', () => {
    const afterSections = (): MigrationSnapshotSections => ({
      channelParticipants: section([participant('user-2'), participant('user-1')]),
      events: section([
        event({ eventId: 'evt-2', payloadDigest: 'c'.repeat(64), workspaceSequence: 2 }),
        event(),
      ]),
      identityBindings: section([
        { family: 'identityBindings', provider: 'google', subject: 'subject-1', userId: 'user-9' },
      ]),
      memberships: section([membership('user-2', 'admin'), membership('user-1')]),
      readState: section([readState(8, 'msg-root'), readState(1)]),
    })
    const forward = compare({ events: section([event()]) }, afterSections())
    const reversed = compare(
      { events: section([event()]) },
      {
        ...afterSections(),
        channelParticipants: section([participant('user-1'), participant('user-2')]),
        events: section([
          event(),
          event({ eventId: 'evt-2', payloadDigest: 'c'.repeat(64), workspaceSequence: 2 }),
        ]),
        memberships: section([membership('user-1'), membership('user-2', 'admin')]),
        readState: section([readState(1), readState(8, 'msg-root')]),
      }
    )
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward))
    expect(findingsFor(forward, 'events').length).toBeGreaterThan(0)
    const ids = forward.findings.map((finding) => finding.id)
    expect([...ids].toSorted()).toEqual(ids)
  })

  test('repeated runs over the same input are byte-stable and carry no timestamps', () => {
    const before = doc(
      { memberships: section([membership('user-1'), membership('user-2')]) },
      'snapshot-before'
    )
    const after = doc({ memberships: section([membership('user-1')]) })
    const first = JSON.stringify(compareMigrationSnapshots({ before, after }))
    const second = JSON.stringify(compareMigrationSnapshots({ before, after }))
    expect(first).toBe(second)
    expect(first?.includes('2026')).toBe(false)
  })

  test('mismatched snapshot identity is a typed error, not a diff', () => {
    const sections: MigrationSnapshotSections = { memberships: section([membership('user-1')]) }
    const before = doc(sections, 'snapshot-before')
    for (const drift of [
      { rehearsalId: 'rehearsal-other' },
      { formatVersion: 2 },
      { source: 'other-system' },
    ]) {
      const after = doc(sections)
      const broken = Object.freeze({
        identity: Object.freeze({ ...after.identity, ...drift }),
        sections: after.sections,
      }) satisfies MigrationSnapshotDocument
      expect(() => compareMigrationSnapshots({ before, after: broken })).toThrow(
        MigrationSnapshotIdentityError
      )
    }
  })

  test('malformed snapshot identity is a typed error', () => {
    const sections: MigrationSnapshotSections = { memberships: section([membership('user-1')]) }
    for (const identity of [
      { formatVersion: 0, rehearsalId: 'r', snapshotId: 's', source: 'x' },
      { formatVersion: 1, rehearsalId: '', snapshotId: 's', source: 'x' },
      { formatVersion: 1, rehearsalId: 'r', snapshotId: 's' },
    ]) {
      const broken = Object.freeze({
        identity: Object.freeze(identity) as MigrationSnapshotDocument['identity'],
        sections: Object.freeze(sections),
      }) satisfies MigrationSnapshotDocument
      expect(() =>
        compareMigrationSnapshots({ before: doc(sections, 'snapshot-before'), after: broken })
      ).toThrow(MigrationSnapshotIdentityError)
    }
  })

  test('a truncated section is flagged on each side and can never read as a clean scan', () => {
    const truncated = { records: Object.freeze([membership('user-1')]), truncated: true }
    const comparison = compare({ memberships: truncated }, { memberships: truncated })
    const findings = findingsFor(comparison, 'memberships', 'truncated_input')
    expect(findings).toHaveLength(2)
    expect(findings.map((finding) => finding.side).toSorted()).toEqual(['after', 'before'])
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('a missing family section is an unknown domain, never zero and never per-record missing', () => {
    const comparison = compare(
      { events: section([event(), event({ eventId: 'evt-2', workspaceSequence: 2 })]) },
      {}
    )
    const unknown = findingsFor(comparison, 'events', 'unknown_domain')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.side).toBe('after')
    // The two events before must not be reported missing one by one: the
    // domain is unknown, not empty.
    expect(findingsFor(comparison, 'events', 'missing_record')).toHaveLength(0)
    expect(comparison.verdict).toBe('inconclusive')
    const inventory = comparison.inventory.find((entry) => entry.family === 'events')
    expect(inventory?.before).toBe(2)
    expect(inventory?.after).toBeNull()
  })

  test('a family section absent from both sides is one unknown-domain finding for both', () => {
    const comparison = compare(
      { memberships: section([membership('user-1')]) },
      { memberships: section([membership('user-1')]) }
    )
    const unknown = findingsFor(comparison, 'events', 'unknown_domain')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.side).toBe('both')
    // The captured family itself stays clean.
    expect(findingsFor(comparison, 'memberships')).toEqual([])
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('ambiguous audience records are quarantined, excluded from matching, and never a success', () => {
    const ambiguous = {
      ...participant('user-1'),
      principalKind: 'ghost',
    } as MigrationSnapshotRecord
    // The valid records match on both sides; the extra unreadable record on
    // the before side leaves the family unproven but produces no determinate
    // finding.
    const quarantinedOnly = compare(
      { channelParticipants: section([participant('user-1'), ambiguous]) },
      { channelParticipants: section([participant('user-1')]) }
    )
    const quarantined = findingsFor(quarantinedOnly, 'channelParticipants', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.side).toBe('before')
    expect(quarantined[0]?.detail.reason).toBe('ambiguous')
    expect(quarantined[0]?.detail.field).toBe('principalKind')
    expect(findingsFor(quarantinedOnly, 'channelParticipants', 'missing_record')).toHaveLength(0)
    expect(findingsFor(quarantinedOnly, 'channelParticipants', 'widened_access')).toHaveLength(0)
    expect(quarantinedOnly.verdict).toBe('inconclusive')
    // The raw inventory still counts what was captured.
    const inventory = quarantinedOnly.inventory.find(
      (entry) => entry.family === 'channelParticipants'
    )
    expect(inventory?.before).toBe(2)

    // A valid after-side grant with no matchable before-side record is still
    // reported: quarantine excludes the unreadable row, it does not excuse a
    // provably new grant.
    const withGrowth = compare(
      { channelParticipants: section([ambiguous]) },
      { channelParticipants: section([participant('user-1')]) }
    )
    expect(familyClasses(withGrowth, 'channelParticipants')).toEqual([
      'quarantined_record',
      'widened_access',
    ])
    expect(withGrowth.verdict).toBe('divergent')
  })

  test('a malformed record is quarantined as malformed with the offending field named', () => {
    const broken = {
      family: 'memberships',
      role: 'member',
      workspaceId: 'wsp-1',
    } as MigrationSnapshotRecord
    const comparison = compare(
      { memberships: section([membership('user-1'), broken]) },
      { memberships: section([membership('user-1')]) }
    )
    const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.detail.reason).toBe('malformed')
    expect(quarantined[0]?.detail.field).toBe('userId')
    expect(findingsFor(comparison, 'memberships', 'missing_record')).toHaveLength(0)
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('determinate findings dominate the verdict even when the input is also incomplete', () => {
    const comparison = compare(
      {
        memberships: section([membership('user-1'), membership('user-2')]),
        events: section([event()]),
      },
      { memberships: section([membership('user-1')]) }
    )
    expect(familyClasses(comparison, 'memberships')).toEqual(['missing_record'])
    expect(familyClasses(comparison, 'events')).toEqual(['unknown_domain'])
    expect(comparison.verdict).toBe('divergent')
  })

  test('output is sanitized: allow-listed detail keys only, and input extras never surface', () => {
    const tainted = {
      ...membership('user-1'),
      body: 'SECRET MESSAGE BODY',
      bodyText: 'SECRET BODY TEXT',
      credential: 'SECRET-CREDENTIAL',
      email: 'secret@example.com',
      tokenDigest: 'SECRET-TOKEN-DIGEST',
    } as MigrationSnapshotRecord
    const taintedEvent = {
      ...event(),
      payload: { body: 'SECRET' },
      prompt: 'SECRET PROMPT',
    } as MigrationSnapshotRecord
    const comparison = compare(
      { events: section([taintedEvent]), memberships: section([tainted]) },
      { memberships: section([membership('user-1')]) }
    )
    const serialized = JSON.stringify(comparison)
    for (const marker of [
      'SECRET MESSAGE BODY',
      'SECRET BODY TEXT',
      'SECRET-CREDENTIAL',
      'secret@example.com',
      'SECRET-TOKEN-DIGEST',
      'SECRET PROMPT',
      'SECRET',
    ]) {
      expect(serialized.includes(marker)).toBe(false)
    }
    for (const finding of comparison.findings) {
      for (const key of Object.keys(finding.detail)) {
        expect(migrationSnapshotFindingDetailKeys).toContain(key)
      }
    }
    for (const findingClass of Object.keys(comparison.counts.byClass)) {
      expect(migrationSnapshotFindingClasses).toContain(findingClass)
    }
    for (const family of Object.keys(comparison.counts.byFamily)) {
      expect(migrationSnapshotFamilies).toContain(family)
    }
  })
})

describe('migration snapshot composite-key and input-bound repairs', () => {
  test('provider/subject tuples whose colon join collides are distinct identities, never identical', () => {
    // Record A (provider `a`, subject `b:c`) and record B (provider `a:b`,
    // subject `c`) under the SAME user: naive colon joining gives both the
    // stable id `a:b:c`, so the pair used to compare as identical.
    const before = fullDocument(
      [{ family: 'identityBindings', provider: 'a', subject: 'b:c', userId: 'user-1' }],
      'snapshot-before'
    )
    const after = fullDocument(
      [{ family: 'identityBindings', provider: 'a:b', subject: 'c', userId: 'user-1' }],
      'snapshot-after'
    )
    const comparison = compareMigrationSnapshots({ after, before })
    expect(comparison.verdict).toBe('divergent')
    expect(findingsFor(comparison, 'identityBindings', 'missing_record')).toHaveLength(1)
    expect(findingsFor(comparison, 'identityBindings', 'unexpected_record')).toHaveLength(1)
    // Distinct identities, not a remap of one identity.
    expect(findingsFor(comparison, 'identityBindings', 'remapped_record')).toHaveLength(0)
    // Colon-bearing identities are not well-formed references: they surface
    // only as distinct opaque references.
    const stableIds = [
      ...new Set(findingsFor(comparison, 'identityBindings').map((finding) => finding.stableId)),
    ]
    expect(stableIds).toHaveLength(2)
    for (const stableId of stableIds) {
      expect(stableId).toMatch(/^opaque:string:[0-9a-f]{16}$/)
    }
  })

  test('the tuple encoding is general: colliding project-member joins are distinct identities', () => {
    // A different family and different field names, same collision shape:
    // (`p`, `m:1`) and (`p:m`, `1`) both colon-join to `p:m:1`.
    const comparison = compare(
      {
        projectMembers: section([
          {
            family: 'projectMembers',
            projectId: 'p',
            role: 'viewer',
            userId: 'm:1',
            workspaceId: 'wsp-1',
          },
        ]),
      },
      {
        projectMembers: section([
          {
            family: 'projectMembers',
            projectId: 'p:m',
            role: 'viewer',
            userId: '1',
            workspaceId: 'wsp-1',
          },
        ]),
      }
    )
    expect(comparison.verdict).toBe('divergent')
    expect(findingsFor(comparison, 'projectMembers', 'missing_record')).toHaveLength(1)
    // projectMembers is a grant family: the after-side identity the encoding
    // now distinguishes is a new grant row, hence widened access.
    expect(findingsFor(comparison, 'projectMembers', 'widened_access')).toHaveLength(1)
  })

  test('a null thread root and a dash thread root are distinct read-state identities', () => {
    // The old `-` placeholder collided with a literal dash thread root; the
    // tuple encoding distinguishes an absent part from any string part.
    const comparison = compare(
      { readState: section([readState(5)]) },
      { readState: section([readState(5, '-')]) }
    )
    expect(comparison.verdict).toBe('divergent')
    const missing = findingsFor(comparison, 'readState', 'missing_record')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.stableId).toBe('wsp-1:user-1:ch-1:0:')
    expect(findingsFor(comparison, 'readState', 'unexpected_record')).toHaveLength(1)
  })

  test('a record whose complete serialization sits exactly on the byte bound compares normally', () => {
    // Structural bytes are part of the bound: a record sized — quotes,
    // delimiters, separators included — to exactly 8,192 serialized bytes is
    // AT the bound, so it is a valid row that matches, never a quarantine.
    // This pins the comparator against over-charging the structural bytes.
    const base = membership('user-1') as unknown as Record<string, unknown>
    // The pad is fixed from the 8,000-character host so growing that host by
    // one byte moves the record over the bound instead of resizing onto it.
    const pad = 8_192 - serializedBytes({ ...base, host: 'x'.repeat(8_000) }) - 9 // `,` + `"pad":` + quotes
    const sized = (extra: string): MigrationSnapshotRecord =>
      ({ ...base, host: extra, pad: 'x'.repeat(pad) }) as MigrationSnapshotRecord
    const atBound = sized('x'.repeat(8_000))
    expect(serializedBytes(atBound)).toBe(8_192)
    const comparison = compareMigrationSnapshots({
      before: documentWithMemberships([atBound], 'snapshot-before'),
      after: documentWithMemberships([atBound], 'snapshot-after'),
    })
    expect(comparison.verdict).toBe('identical')
    expect(findingsFor(comparison, 'memberships', 'quarantined_record')).toHaveLength(0)
    // One more byte in the same slot crosses the bound and is quarantined.
    const overBound = sized(`${'x'.repeat(8_000)}x`)
    expect(serializedBytes(overBound)).toBe(8_193)
    const divergent = compareMigrationSnapshots({
      before: documentWithMemberships([overBound], 'snapshot-before'),
      after: documentWithMemberships([overBound], 'snapshot-after'),
    })
    const quarantined = findingsFor(divergent, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    for (const finding of quarantined) expect(finding.detail.reason).toBe('limit')
  })

  test('an oversized record is quarantined by limit before canonicalization and never echoed', () => {
    const marker = 'SECRET-OVERSIZED-BYTES-MARKER'
    const oversized = (first: 'family' | 'host'): MigrationSnapshotRecord =>
      first === 'family'
        ? ({
            family: 'memberships',
            host: marker.repeat(400),
            role: 'member',
            userId: 'user-2',
            workspaceId: 'wsp-1',
          } as MigrationSnapshotRecord)
        : ({
            host: marker.repeat(400),
            workspaceId: 'wsp-1',
            userId: 'user-2',
            role: 'member',
            family: 'memberships',
          } as MigrationSnapshotRecord)
    const forward = compare(
      { memberships: section([membership('user-1'), oversized('family')]) },
      { memberships: section([membership('user-1'), oversized('family')]) }
    )
    const reversed = compare(
      { memberships: section([membership('user-1'), oversized('host')]) },
      { memberships: section([membership('user-1'), oversized('host')]) }
    )
    // Key insertion order cannot change the outcome: the oversized record is
    // never canonicalized, so its fingerprint is over bounded material only.
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward))
    const quarantined = findingsFor(forward, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    expect(quarantined.map((finding) => finding.side).toSorted()).toEqual(['after', 'before'])
    for (const finding of quarantined) {
      expect(finding.detail.reason).toBe('limit')
      expect(finding.detail.field).toBe('record')
      expect(finding.stableId).toMatch(/^unverifiable:[0-9a-f]{64}$/)
    }
    // The valid rows still match; nothing is reported missing or remapped.
    expect(findingsFor(forward, 'memberships', 'missing_record')).toHaveLength(0)
    expect(findingsFor(forward, 'memberships', 'remapped_record')).toHaveLength(0)
    expect(findingsFor(forward, 'memberships', 'widened_access')).toHaveLength(0)
    expect(JSON.stringify(forward).includes(marker)).toBe(false)
    expect(forward.verdict).toBe('inconclusive')
  })

  test('an oversized property count is quarantined by limit and never echoed', () => {
    const marker = 'SECRET-PROPERTY-MARKER'
    const bloated = (): MigrationSnapshotRecord => {
      const record: Record<string, unknown> = {
        family: 'memberships',
        role: 'member',
        userId: 'user-3',
        workspaceId: 'wsp-1',
      }
      for (let index = 0; index < 100; index++) record[`host-${index}`] = marker
      return record as MigrationSnapshotRecord
    }
    const comparison = compare(
      { memberships: section([membership('user-1'), bloated()]) },
      { memberships: section([membership('user-1'), bloated()]) }
    )
    const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    for (const finding of quarantined) {
      expect(finding.detail.reason).toBe('limit')
      expect(finding.detail.field).toBe('record')
    }
    expect(JSON.stringify(comparison).includes(marker)).toBe(false)
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('an oversized array width is quarantined by limit and never echoed', () => {
    const marker = 'SECRET-ARRAY-ITEM-MARKER'
    const wide = (): MigrationSnapshotRecord =>
      ({
        family: 'memberships',
        host: Array.from({ length: 65 }, () => marker),
        role: 'member',
        userId: 'user-4',
        workspaceId: 'wsp-1',
      }) as MigrationSnapshotRecord
    const comparison = compare(
      { memberships: section([membership('user-1'), wide()]) },
      { memberships: section([membership('user-1'), wide()]) }
    )
    const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    for (const finding of quarantined) {
      expect(finding.detail.reason).toBe('limit')
      expect(finding.detail.field).toBe('record')
    }
    expect(JSON.stringify(comparison).includes(marker)).toBe(false)
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('oversized content among ignored extra properties is bounded before the ignore decision', () => {
    const marker = 'SECRET-NESTED-EXTRA-MARKER'
    const nested = (): MigrationSnapshotRecord =>
      ({
        family: 'memberships',
        host: { deep: { deeper: marker.repeat(500) } },
        role: 'member',
        userId: 'user-5',
        workspaceId: 'wsp-1',
      }) as MigrationSnapshotRecord
    const comparison = compare(
      { memberships: section([membership('user-1'), nested()]) },
      { memberships: section([membership('user-1'), nested()]) }
    )
    const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    for (const finding of quarantined) {
      expect(finding.detail.reason).toBe('limit')
      expect(finding.detail.field).toBe('record')
    }
    expect(JSON.stringify(comparison).includes(marker)).toBe(false)
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('oversized content on a quarantine-bound record is bounded and echoes only opaque references', () => {
    const marker = 'SECRET-MISFILED-OVERSIZED-MARKER'
    const misfiledOversized = {
      family: 'not-a-family',
      host: marker.repeat(1_000),
      role: 'member',
      userId: 'user-6',
      workspaceId: 'wsp-1',
    } as unknown as MigrationSnapshotRecord
    const comparison = compare(
      { events: section([event(), misfiledOversized]) },
      { events: section([event()]) }
    )
    const quarantined = findingsFor(comparison, 'events', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    // The size bound fires before the family-mismatch quarantine, so the
    // oversized record is never canonicalized for its fingerprint.
    expect(quarantined[0]?.detail.reason).toBe('limit')
    expect(quarantined[0]?.detail.field).toBe('record')
    expect(quarantined[0]?.stableId).toMatch(/^unverifiable:[0-9a-f]{64}$/)
    const serialized = JSON.stringify(comparison)
    expect(serialized.includes(marker)).toBe(false)
    expect(serialized.includes('not-a-family')).toBe(false)
  })
})

/**
 * The quarantine identity every over-bound record must share: the
 * bound-descriptor fingerprint, proven here via an oversized object (the
 * already-bounded path). Any oversized input whose quarantine id differs
 * from this one has been content-hashed, which is the bug.
 */
function oversizedObjectQuarantineStableId(): string {
  const bloated = {
    family: 'memberships',
    host: 'x'.repeat(9_000),
    role: 'member',
    userId: 'user-object',
    workspaceId: 'wsp-1',
  } as unknown as MigrationSnapshotRecord
  const comparison = compare(
    { memberships: section([bloated]) },
    { memberships: section([bloated]) }
  )
  const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
  expect(quarantined).toHaveLength(2)
  return quarantined[0]?.stableId ?? ''
}

describe('migration snapshot primitive and top-level array intake bounds', () => {
  test('an oversized top-level string record is quarantined by limit, bound-derived only, never echoed', () => {
    const marker = 'SECRET-TOP-LEVEL-STRING-MARKER'
    const boundDerived = oversizedObjectQuarantineStableId()
    const forward = compare(
      {
        memberships: section([
          membership('user-1'),
          marker.repeat(4_096) as unknown as MigrationSnapshotRecord,
        ]),
      },
      {
        memberships: section([
          membership('user-1'),
          marker.repeat(4_096) as unknown as MigrationSnapshotRecord,
        ]),
      }
    )
    // Supplied content cannot influence the quarantine identity: a different
    // huge string must produce byte-identical output.
    const otherMarker = 'SECRET-DIFFERENT-HUGE-CONTENT-MARKER'
    const other = compare(
      {
        memberships: section([
          membership('user-1'),
          otherMarker.repeat(4_096) as unknown as MigrationSnapshotRecord,
        ]),
      },
      {
        memberships: section([
          membership('user-1'),
          otherMarker.repeat(4_096) as unknown as MigrationSnapshotRecord,
        ]),
      }
    )
    expect(JSON.stringify(other)).toBe(JSON.stringify(forward))
    const quarantined = findingsFor(forward, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    expect(quarantined.map((finding) => finding.side).toSorted()).toEqual(['after', 'before'])
    for (const finding of quarantined) {
      expect(finding.detail.reason).toBe('limit')
      expect(finding.detail.field).toBe('record')
      // Bound-derived only: the same id every oversized record shares, never
      // a hash over the supplied string.
      expect(finding.stableId).toBe(boundDerived)
    }
    // The valid row still matches; nothing is reported missing or remapped.
    expect(findingsFor(forward, 'memberships', 'missing_record')).toHaveLength(0)
    expect(findingsFor(forward, 'memberships', 'remapped_record')).toHaveLength(0)
    // The marker text is absent from the entire serialized output, and the
    // output stays bounded no matter how large the supplied string was.
    const serialized = JSON.stringify(forward)
    expect(serialized.includes(marker)).toBe(false)
    expect(serialized.length).toBeLessThan(8_192)
    expect(forward.verdict).toBe('inconclusive')
  })

  test('an oversized primitive on one side only is quarantined there and never compared', () => {
    const marker = 'SECRET-ONE-SIDED-STRING-MARKER'
    const comparison = compare(
      { memberships: section([membership('user-1')]) },
      { memberships: section([marker.repeat(4_096) as unknown as MigrationSnapshotRecord]) }
    )
    const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.side).toBe('after')
    expect(quarantined[0]?.detail.reason).toBe('limit')
    expect(quarantined[0]?.detail.field).toBe('record')
    // The valid before-side row is genuinely missing after: a determinate
    // diff, not a silent pass.
    expect(findingsFor(comparison, 'memberships', 'missing_record')).toHaveLength(1)
    const serialized = JSON.stringify(comparison)
    expect(serialized.includes(marker)).toBe(false)
    expect(serialized.length).toBeLessThan(8_192)
    expect(comparison.verdict).toBe('divergent')
  })

  test('oversized top-level array records get the same bounded treatment', () => {
    const marker = 'SECRET-TOP-LEVEL-ARRAY-MARKER'
    const boundDerived = oversizedObjectQuarantineStableId()
    const cases: MigrationSnapshotRecord[] = [
      // Over the array-width bound.
      Array.from({ length: 65 }, () => marker) as unknown as MigrationSnapshotRecord,
      // Within the width bound but over the byte bound.
      Array.from({ length: 64 }, () => marker.repeat(8)) as unknown as MigrationSnapshotRecord,
    ]
    for (const oversizedArray of cases) {
      const comparison = compare(
        { memberships: section([membership('user-1'), oversizedArray]) },
        { memberships: section([membership('user-1'), oversizedArray]) }
      )
      const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
      expect(quarantined).toHaveLength(2)
      for (const finding of quarantined) {
        expect(finding.detail.reason).toBe('limit')
        expect(finding.detail.field).toBe('record')
        expect(finding.stableId).toBe(boundDerived)
      }
      expect(findingsFor(comparison, 'memberships', 'missing_record')).toHaveLength(0)
      const serialized = JSON.stringify(comparison)
      expect(serialized.includes(marker)).toBe(false)
      expect(serialized.length).toBeLessThan(8_192)
      expect(comparison.verdict).toBe('inconclusive')
    }
  })

  test('an oversized bigint record is over-bound outright and never content-hashed', () => {
    // A bigint's serialization length is unbounded, so its digits are the
    // content that must never be canonicalized or hashed.
    const digits = '9'.repeat(10_000)
    const huge = BigInt(digits) as unknown as MigrationSnapshotRecord
    const comparison = compare(
      { memberships: section([membership('user-1'), huge]) },
      { memberships: section([membership('user-1'), huge]) }
    )
    const quarantined = findingsFor(comparison, 'memberships', 'quarantined_record')
    expect(quarantined).toHaveLength(2)
    for (const finding of quarantined) {
      expect(finding.detail.reason).toBe('limit')
      expect(finding.detail.field).toBe('record')
      expect(finding.stableId).toBe(oversizedObjectQuarantineStableId())
    }
    const serialized = JSON.stringify(comparison)
    expect(serialized.includes('9'.repeat(200))).toBe(false)
    expect(serialized.length).toBeLessThan(8_192)
    expect(comparison.verdict).toBe('inconclusive')
  })

  test.each(FIELD_DRIFT_CASES)('$family.$field drift is never identical', (drift) => {
    const comparison = compareMigrationSnapshots({
      after: documentWithFamily([drift.after], drift.family, 'snapshot-after'),
      before: documentWithFamily([drift.before], drift.family, 'snapshot-before'),
    })
    expect(comparison.verdict).not.toBe('identical')
    expect(comparison.findings).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({ field: drift.field }),
        family: drift.family,
        findingClass: drift.expectedClass,
      })
    )
  })
})

function findingOfEveryUnknownFamily(comparison: MigrationSnapshotComparison): string[] {
  return comparison.findings
    .filter((finding) => finding.findingClass === 'unknown_domain')
    .map((finding) => finding.family)
}
