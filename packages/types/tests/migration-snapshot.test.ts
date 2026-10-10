import { describe, expect, test } from 'bun:test'

import {
  isMigrationSnapshotFamily,
  MIGRATION_SNAPSHOT_FORMAT_VERSION,
  MIGRATION_SNAPSHOT_MAX_ARRAY_WIDTH,
  MIGRATION_SNAPSHOT_MAX_RECORD_BYTES,
  MIGRATION_SNAPSHOT_MAX_RECORD_PROPERTIES,
  migrationAgentLifecycleStates,
  migrationChannelVisibilities,
  migrationContentAvailabilities,
  migrationExecutionLocationKinds,
  migrationInvitationRoles,
  migrationInvitationStates,
  migrationParticipantKinds,
  migrationProjectMemberRoles,
  migrationProjectVisibilities,
  migrationSnapshotFamilies,
  migrationSnapshotFindingClasses,
  migrationSnapshotFindingDetailKeys,
  migrationSnapshotRecordIssue,
  migrationSnapshotRecordShapeIssue,
  migrationTaskLifecycleStates,
  migrationWorkspaceRoles,
  type MigrationSnapshotRecord,
} from '../src/migration-snapshot'

/** One minimal, valid record per family. */
function validRecord(family: (typeof migrationSnapshotFamilies)[number]): MigrationSnapshotRecord {
  switch (family) {
    case 'agents':
      return {
        agentId: 'agent-1',
        family: 'agents',
        lifecycleState: 'active',
        projectId: null,
        workspaceId: 'wsp-1',
      }
    case 'channelParticipants':
      return {
        channelId: 'ch-1',
        family: 'channelParticipants',
        principalId: 'user-1',
        principalKind: 'user',
        workspaceId: 'wsp-1',
      }
    case 'channels':
      return {
        channelId: 'ch-1',
        family: 'channels',
        projectId: null,
        visibility: 'workspace',
        workspaceId: 'wsp-1',
      }
    case 'contentRefs':
      return {
        availability: 'available',
        contentRefId: 'cref-1',
        digestSha256: 'a'.repeat(64),
        family: 'contentRefs',
        keyVersion: 1,
        messageId: null,
        revision: 1,
        taskId: null,
        workspaceId: 'wsp-1',
      }
    case 'events':
      return {
        eventId: 'evt-1',
        eventType: 'workspace.created',
        family: 'events',
        payloadDigest: 'b'.repeat(64),
        schemaVersion: 1,
        workspaceId: 'wsp-1',
        workspaceSequence: 1,
      }
    case 'executionAttempts':
      return {
        attempt: 1,
        family: 'executionAttempts',
        locationKind: 'local_device',
        runtimeNodeId: 'node-1',
        taskId: 'task-1',
        workspaceId: 'wsp-1',
      }
    case 'identityBindings':
      return {
        family: 'identityBindings',
        provider: 'google',
        subject: 'subject-1',
        userId: 'user-1',
      }
    case 'invitations':
      return {
        family: 'invitations',
        invitationId: 'inv-1',
        invitedByUserId: 'user-1',
        role: 'member',
        state: 'pending',
        workspaceId: 'wsp-1',
      }
    case 'memberships':
      return { family: 'memberships', role: 'member', userId: 'user-1', workspaceId: 'wsp-1' }
    case 'messages':
      return {
        channelId: 'ch-1',
        deleted: false,
        family: 'messages',
        messageId: 'msg-1',
        threadRootMessageId: null,
        workspaceId: 'wsp-1',
      }
    case 'projectMembers':
      return {
        family: 'projectMembers',
        projectId: 'prj-1',
        role: 'viewer',
        userId: 'user-1',
        workspaceId: 'wsp-1',
      }
    case 'projects':
      return {
        family: 'projects',
        projectId: 'prj-1',
        visibility: 'workspace',
        workspaceId: 'wsp-1',
      }
    case 'readState':
      return {
        channelId: 'ch-1',
        family: 'readState',
        lastReadSequence: 5,
        manuallyUnread: false,
        threadRootMessageId: null,
        userId: 'user-1',
        workspaceId: 'wsp-1',
      }
    case 'tasks':
      return {
        channelId: null,
        creatorUserId: 'user-1',
        family: 'tasks',
        lifecycleState: 'created',
        messageId: null,
        projectId: null,
        taskId: 'task-1',
        threadRootMessageId: null,
        version: 1,
        workspaceId: 'wsp-1',
      }
    case 'temporarySessions':
      return { claimed: false, family: 'temporarySessions', sessionId: 'sess-1', userId: 'user-1' }
    case 'workspaces':
      return {
        archived: false,
        controlPlaneWorkspaceId: 'wsp_01AAAAAAAAAAAAAAAAAAAAAAAA',
        family: 'workspaces',
        ownerUserId: 'user-1',
        workspaceId: 'wsp-1',
      }
    case 'artifactReferenceGrants':
      return {
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
      }
    case 'contentReplicas':
      return {
        availability: 'available',
        contentRefId: 'cref-1',
        deleted: false,
        digestSha256: 'b'.repeat(64),
        family: 'contentReplicas',
        replicaId: 'rep-1',
        replicaKind: 'cloud_safe',
        revision: 1,
        schemaVersion: 1,
        workspaceId: 'wsp-1',
      }
    case 'leadTurnRuntime':
      return {
        attemptId: 'att-1',
        cancelRequested: false,
        executionId: 'exe-1',
        family: 'leadTurnRuntime',
        intentId: 'intent-1',
        publishedMessageId: null,
        runtimeSessionId: 'sess-1',
        state: 'prepared',
      }
    case 'nativeSessions':
      return {
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
      }
    case 'runtimeNodes':
      return {
        family: 'runtimeNodes',
        kind: 'local_device',
        pairingState: 'paired',
        platform: 'darwin',
        revoked: false,
        runtimeNodeId: 'node-1',
        softwareVersion: '1.0.0',
        workspaceId: 'wsp-1',
      }
    case 'taskSubmissions':
      return {
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
      }
  }
}

function withField(record: MigrationSnapshotRecord, field: string, value: unknown) {
  return { ...record, [field]: value } as MigrationSnapshotRecord
}

/**
 * Serialized byte length of a printable-ASCII fixture. The canonical
 * encoding permutes object keys but never adds or removes a byte, and
 * printable ASCII carries no escapes, so this equals the length the shape
 * walk must charge — which lets boundary fixtures sit EXACTLY on the
 * documented bound.
 */
const serializedBytes = (value: unknown): number => JSON.stringify(value).length

/**
 * Length of the filler `pad` extra property that brings a record carrying
 * `host` exactly to `target` serialized bytes. The pad property contributes
 * its characters plus its own quoting and separators, so the boundary is
 * derived from the true serializer rather than hand arithmetic. Fix the pad
 * per pair and grow only the host between the at-bound and over-bound
 * fixtures — recomputing it would silently resize the record back onto the
 * bound.
 */
const padFor = (base: MigrationSnapshotRecord, host: unknown, target: number): number =>
  target - serializedBytes(withField(base, 'host', host)) - 9 // `,` + `"pad":` + two quotes

const recordWithPad = (base: MigrationSnapshotRecord, host: unknown, pad: number) =>
  withField(withField(base, 'host', host), 'pad', 'x'.repeat(pad))

function withoutField(record: MigrationSnapshotRecord, field: string) {
  const copy = { ...record } as Record<string, unknown>
  delete copy[field]
  return copy as MigrationSnapshotRecord
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value)
}

describe('migration snapshot contract constants', () => {
  test('the snapshot format version is pinned at 1', () => {
    expect(MIGRATION_SNAPSHOT_FORMAT_VERSION).toBe(1)
    expect(Number.isInteger(MIGRATION_SNAPSHOT_FORMAT_VERSION)).toBe(true)
  })

  test('every record family a migration must inventory is present, sorted and unique', () => {
    expect(migrationSnapshotFamilies.length).toBe(22)
    expect(isSorted([...migrationSnapshotFamilies])).toBe(true)
    expect(new Set(migrationSnapshotFamilies).size).toBe(migrationSnapshotFamilies.length)
    for (const family of [
      'agents',
      'artifactReferenceGrants',
      'channelParticipants',
      'channels',
      'contentRefs',
      'contentReplicas',
      'events',
      'executionAttempts',
      'identityBindings',
      'invitations',
      'leadTurnRuntime',
      'memberships',
      'messages',
      'projectMembers',
      'projects',
      'readState',
      'runtimeNodes',
      'taskSubmissions',
      'tasks',
      'temporarySessions',
      'workspaces',
    ]) {
      expect(isMigrationSnapshotFamily(family)).toBe(true)
    }
    expect(isMigrationSnapshotFamily('groupPolicy')).toBe(false)
    expect(isMigrationSnapshotFamily(42)).toBe(false)
  })

  test('finding classes cover every required violation plus the epistemic ones', () => {
    expect(isSorted([...migrationSnapshotFindingClasses])).toBe(true)
    for (const required of [
      'missing_record',
      'unexpected_record',
      'duplicated_record',
      'remapped_record',
      'digest_drift',
      'widened_access',
      'lost_read_state',
      'conflicting_attempt_owner',
    ]) {
      expect(migrationSnapshotFindingClasses).toContain(required)
    }
    for (const epistemic of ['unknown_domain', 'quarantined_record', 'truncated_input']) {
      expect(migrationSnapshotFindingClasses).toContain(epistemic)
    }
  })

  test('finding details may only carry the allow-listed keys', () => {
    expect([...migrationSnapshotFindingDetailKeys].toSorted()).toEqual([
      'after',
      'before',
      'count',
      'field',
      'reason',
    ])
  })

  test('every enum list is sorted and free of blank values', () => {
    const lists = [
      migrationAgentLifecycleStates,
      migrationChannelVisibilities,
      migrationContentAvailabilities,
      migrationExecutionLocationKinds,
      migrationInvitationRoles,
      migrationInvitationStates,
      migrationParticipantKinds,
      migrationProjectMemberRoles,
      migrationProjectVisibilities,
      migrationTaskLifecycleStates,
      migrationWorkspaceRoles,
    ]
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0)
      expect(isSorted([...list])).toBe(true)
      for (const value of list) expect(value.length).toBeGreaterThan(0)
    }
  })
})

describe('migration snapshot record validation', () => {
  test('accepts one minimal valid record from every family', () => {
    for (const family of migrationSnapshotFamilies) {
      expect(migrationSnapshotRecordIssue(validRecord(family))).toBeNull()
    }
  })

  test('a record of an unknown family is malformed, never guessed', () => {
    const impostor = {
      ...validRecord('memberships'),
      family: 'groupPolicy',
    } as MigrationSnapshotRecord
    expect(migrationSnapshotRecordIssue(impostor)).toEqual({ field: 'family', kind: 'malformed' })
  })

  test('a missing or wrongly typed required field is malformed and names the field', () => {
    const cases: readonly [MigrationSnapshotRecord, string][] = [
      [withoutField(validRecord('workspaces'), 'ownerUserId'), 'ownerUserId'],
      [withoutField(validRecord('memberships'), 'userId'), 'userId'],
      [withField(validRecord('memberships'), 'userId', 42), 'userId'],
      [withoutField(validRecord('messages'), 'deleted'), 'deleted'],
      [withField(validRecord('messages'), 'deleted', 'no'), 'deleted'],
      [withoutField(validRecord('events'), 'payloadDigest'), 'payloadDigest'],
      [withField(validRecord('events'), 'workspaceSequence', -1), 'workspaceSequence'],
      [withField(validRecord('events'), 'workspaceSequence', 1.5), 'workspaceSequence'],
      [withField(validRecord('readState'), 'lastReadSequence', -3), 'lastReadSequence'],
      [withoutField(validRecord('tasks'), 'version'), 'version'],
      [withField(validRecord('tasks'), 'version', 0), 'version'],
      [withoutField(validRecord('identityBindings'), 'subject'), 'subject'],
      [withField(validRecord('temporarySessions'), 'claimed', null), 'claimed'],
      [withField(validRecord('contentRefs'), 'digestSha256', 'not-a-digest'), 'digestSha256'],
      [withField(validRecord('contentRefs'), 'revision', -1), 'revision'],
      [withoutField(validRecord('artifactReferenceGrants'), 'expiresAt'), 'expiresAt'],
      [withField(validRecord('artifactReferenceGrants'), 'expiresAt', 'not-a-date'), 'expiresAt'],
      [withField(validRecord('artifactReferenceGrants'), 'expiresAt', 42), 'expiresAt'],
      [withField(validRecord('agents'), 'projectId', 7), 'projectId'],
      [withField(validRecord('executionAttempts'), 'attempt', 0), 'attempt'],
      [withoutField(validRecord('invitations'), 'state'), 'state'],
      [withoutField(validRecord('projectMembers'), 'role'), 'role'],
      [withoutField(validRecord('channels'), 'visibility'), 'visibility'],
      [withoutField(validRecord('projects'), 'workspaceId'), 'workspaceId'],
      [withoutField(validRecord('channelParticipants'), 'principalId'), 'principalId'],
    ]
    for (const [record, field] of cases) {
      const issue = migrationSnapshotRecordIssue(record)
      expect(issue).not.toBeNull()
      expect(issue?.kind).toBe('malformed')
      expect(issue?.field).toBe(field)
    }
  })

  test('ambiguous audience and ownership values are quarantined as ambiguous, not malformed', () => {
    const cases: readonly [MigrationSnapshotRecord, string][] = [
      [withField(validRecord('memberships'), 'role', 'superuser'), 'role'],
      [withField(validRecord('projectMembers'), 'role', 'owner'), 'role'],
      [withField(validRecord('invitations'), 'role', 'guest'), 'role'],
      [withField(validRecord('projects'), 'visibility', 'everyone'), 'visibility'],
      [withField(validRecord('channels'), 'visibility', 'secret'), 'visibility'],
      [withField(validRecord('channelParticipants'), 'principalKind', 'ghost'), 'principalKind'],
      [withField(validRecord('agents'), 'lifecycleState', 'zombie'), 'lifecycleState'],
      [withField(validRecord('tasks'), 'lifecycleState', 'deleted'), 'lifecycleState'],
      [withField(validRecord('contentRefs'), 'availability', 'cached'), 'availability'],
      [withField(validRecord('executionAttempts'), 'locationKind', 'orbit'), 'locationKind'],
      [
        // The reserved cloud location must own no node; any other location
        // must own exactly one.
        withField(validRecord('executionAttempts'), 'runtimeNodeId', null),
        'runtimeNodeId',
      ],
      [
        withField(
          withField(validRecord('executionAttempts'), 'locationKind', 'agent_hq_cloud'),
          'runtimeNodeId',
          'node-1'
        ),
        'runtimeNodeId',
      ],
    ]
    for (const [record, field] of cases) {
      const issue = migrationSnapshotRecordIssue(record)
      expect(issue).not.toBeNull()
      expect(issue?.kind).toBe('ambiguous')
      expect(issue?.field).toBe(field)
    }
  })

  test('a quarantined issue names the field but never echoes the offending value', () => {
    const issue = migrationSnapshotRecordIssue(
      withField(validRecord('memberships'), 'role', 'SUPERUSER_SECRET_MARKER')
    )
    expect(issue).toEqual({ field: 'role', kind: 'ambiguous' })
    expect(JSON.stringify(issue)).not.toContain('SUPERUSER_SECRET_MARKER')
  })
})

describe('migration snapshot bounds and record structure', () => {
  test('digest fields must be well-formed sha-256 digests, never free text', () => {
    // A nominal digest that is not a 64-character hex string is malformed:
    // arbitrary text must never pass as a digest and later surface verbatim
    // in comparator findings.
    expect(
      migrationSnapshotRecordIssue(
        withField(validRecord('events'), 'payloadDigest', 'SECRET-NOMINAL-DIGEST-TEXT')
      )
    ).toEqual({ field: 'payloadDigest', kind: 'malformed' })
    expect(
      migrationSnapshotRecordIssue(
        withField(validRecord('contentRefs'), 'digestSha256', 'SECRET-NOMINAL-DIGEST-TEXT')
      )
    ).toEqual({ field: 'digestSha256', kind: 'malformed' })
  })

  test('identifier fields are length-bounded with a typed limit issue', () => {
    expect(
      migrationSnapshotRecordIssue(
        withField(validRecord('memberships'), 'workspaceId', 'x'.repeat(513))
      )
    ).toEqual({ field: 'workspaceId', kind: 'limit' })
    expect(
      migrationSnapshotRecordIssue(withField(validRecord('memberships'), 'workspaceId', ' padded'))
    ).toEqual({ field: 'workspaceId', kind: 'limit' })
    expect(
      migrationSnapshotRecordIssue(
        withField(validRecord('memberships'), 'workspaceId', 'x'.repeat(512))
      )
    ).toBeNull()
  })

  test('a null or non-object record is rejected structurally instead of dereferenced', () => {
    expect(migrationSnapshotRecordIssue(null as unknown as MigrationSnapshotRecord)).toEqual({
      field: 'record',
      kind: 'malformed',
    })
    expect(migrationSnapshotRecordIssue(42 as unknown as MigrationSnapshotRecord)).toEqual({
      field: 'record',
      kind: 'malformed',
    })
  })
})

describe('migration snapshot record input bounds', () => {
  test('the byte, property-count and array-width bounds are documented constants', () => {
    expect(MIGRATION_SNAPSHOT_MAX_RECORD_BYTES).toBe(8_192)
    expect(MIGRATION_SNAPSHOT_MAX_RECORD_PROPERTIES).toBe(64)
    expect(MIGRATION_SNAPSHOT_MAX_ARRAY_WIDTH).toBe(64)
  })

  test('an oversized record byte size is a typed limit issue, decided before canonicalization', () => {
    const marker = 'SECRET-BYTES-MARKER'
    const issue = migrationSnapshotRecordIssue(
      withField(validRecord('memberships'), 'host', marker.repeat(1_000))
    )
    expect(issue).toEqual({ field: 'record', kind: 'limit' })
    // The issue names no supplied content.
    expect(JSON.stringify(issue)).not.toContain(marker)
    // Well within the bound, an extra property stays ignored as before.
    expect(
      migrationSnapshotRecordIssue(withField(validRecord('memberships'), 'host', 'small value'))
    ).toBeNull()
  })

  test('an oversized property count is a typed limit issue, decided before canonicalization', () => {
    const bloated: Record<string, unknown> = { ...validRecord('memberships') }
    for (let index = 0; index < 100; index++) bloated[`host-${index}`] = 'x'
    expect(migrationSnapshotRecordIssue(bloated as MigrationSnapshotRecord)).toEqual({
      field: 'record',
      kind: 'limit',
    })
  })

  test('an oversized array width inside a record is a typed limit issue', () => {
    const over = withField(
      validRecord('memberships'),
      'host',
      Array.from({ length: 65 }, () => 'x')
    )
    expect(migrationSnapshotRecordIssue(over)).toEqual({ field: 'record', kind: 'limit' })
    // At the documented bound the array is just an ignored extra property.
    // 4 contract fields + the host key + 59 elements = exactly 64 slots.
    const atBound = withField(
      validRecord('memberships'),
      'host',
      Array.from({ length: 59 }, () => 'x')
    )
    expect(migrationSnapshotRecordIssue(atBound)).toBeNull()
  })

  test('oversized content nested under an ignored extra property is still bounded', () => {
    const marker = 'SECRET-NESTED-MARKER'
    const nested = {
      ...validRecord('memberships'),
      host: { deep: { deeper: marker.repeat(500) } },
    } as MigrationSnapshotRecord
    const issue = migrationSnapshotRecordIssue(nested)
    expect(issue).toEqual({ field: 'record', kind: 'limit' })
    expect(JSON.stringify(issue)).not.toContain(marker)
  })

  test('an oversized top-level string is a typed limit issue, decided before canonicalization', () => {
    const marker = 'SECRET-TOP-STRING-MARKER'
    const issue = migrationSnapshotRecordShapeIssue(marker.repeat(4_096))
    expect(issue).toEqual({ field: 'record', kind: 'limit' })
    // The issue names no supplied content.
    expect(JSON.stringify(issue)).not.toContain(marker)
    // A string well within the byte bound is not a size issue.
    expect(migrationSnapshotRecordShapeIssue('x'.repeat(64))).toBeNull()
  })

  test('escape expansion counts against the byte bound: quotes, backslashes and control characters', () => {
    // The bound measures the SERIALIZED record. JSON escapes the quote and
    // the backslash to two bytes, so 4,100 of them serialize to 8,200 bytes —
    // over the 8,192-byte bound even though the raw characters count 4,100.
    expect(migrationSnapshotRecordShapeIssue('"'.repeat(4_100))).toEqual({
      field: 'record',
      kind: 'limit',
    })
    expect(migrationSnapshotRecordShapeIssue('\\'.repeat(4_100))).toEqual({
      field: 'record',
      kind: 'limit',
    })
    // Control characters serialize through their six-byte \u00XX escape.
    expect(migrationSnapshotRecordShapeIssue('\u0001'.repeat(1_370))).toEqual({
      field: 'record',
      kind: 'limit',
    })
    // The same characters inside the bound are not flagged: 4,000 quotes
    // serialize to exactly 8,000 bytes, and 1,365 control characters to
    // 8,190 — both within the 8,192-byte bound.
    expect(migrationSnapshotRecordShapeIssue('"'.repeat(4_000))).toBeNull()
    expect(migrationSnapshotRecordShapeIssue('\u0001'.repeat(1_365))).toBeNull()
    // Plain ASCII of the same magnitude keeps its one byte per character.
    expect(migrationSnapshotRecordShapeIssue('x'.repeat(8_000))).toBeNull()
  })

  test('the byte bound covers the complete serialized form: string quotes included', () => {
    // The reported hole: an 8,192-character ASCII string is 8,194 bytes as
    // JSON once its two quotes are counted, yet it passed the shape gate.
    expect(migrationSnapshotRecordShapeIssue('x'.repeat(8_192))).toEqual({
      field: 'record',
      kind: 'limit',
    })
    // 8,190 characters serialize to exactly 8,192 bytes with their quotes —
    // at the bound, not over it, so still admitted.
    expect(migrationSnapshotRecordShapeIssue('x'.repeat(8_190))).toBeNull()
    // The same accounting applies to a string value inside a record: sized
    // so the record's complete serialization sits exactly on the bound, it
    // stays a valid record; one more character crosses it.
    const base = validRecord('memberships')
    const pad = padFor(base, 'x'.repeat(8_000), 8_192)
    const atBound = recordWithPad(base, 'x'.repeat(8_000), pad)
    expect(serializedBytes(atBound)).toBe(8_192)
    expect(migrationSnapshotRecordIssue(atBound)).toBeNull()
    const overBound = recordWithPad(base, 'x'.repeat(8_001), pad)
    expect(serializedBytes(overBound)).toBe(8_193)
    expect(migrationSnapshotRecordIssue(overBound)).toEqual({ field: 'record', kind: 'limit' })
  })

  test('the byte bound covers the complete serialized form: quoted keys and colons included', () => {
    const base = validRecord('memberships')
    // A key serializes as `"…key…":` — its quotes and its colon are charged
    // exactly like the key's characters are.
    const withKeyOfLength = (keyLength: number): MigrationSnapshotRecord => {
      const record: Record<string, unknown> = { ...base }
      record['k'.repeat(keyLength)] = 'v'
      return record as MigrationSnapshotRecord
    }
    // An empty extra key already serializes with its quotes and colon, so a
    // key of length n adds exactly n bytes over that baseline.
    const keyPad = 8_192 - serializedBytes(withKeyOfLength(0))
    expect(serializedBytes(withKeyOfLength(keyPad))).toBe(8_192)
    expect(migrationSnapshotRecordIssue(withKeyOfLength(keyPad))).toBeNull()
    expect(serializedBytes(withKeyOfLength(keyPad + 1))).toBe(8_193)
    expect(migrationSnapshotRecordIssue(withKeyOfLength(keyPad + 1))).toEqual({
      field: 'record',
      kind: 'limit',
    })
  })

  test('the byte bound covers the complete serialized form: container delimiters and separators included', () => {
    const base = validRecord('memberships')
    // An array pays its brackets and the comma between its items; a nested
    // object pays its braces, quoted keys and colons at every depth.
    const arrayValue = ['x'.repeat(100), 'x'.repeat(100)]
    const nestedValue = { deep: { deeper: 'x'.repeat(50) } }
    for (const host of [arrayValue, nestedValue]) {
      const pad = padFor(base, host, 8_192)
      const atBound = recordWithPad(base, host, pad)
      expect(serializedBytes(atBound)).toBe(8_192)
      expect(migrationSnapshotRecordIssue(atBound)).toBeNull()
      // One more element (4 bytes: comma plus its quotes) or one more inner
      // character, pad unchanged, crosses the bound.
      const grown = Array.isArray(host)
        ? [...host, 'x']
        : { deep: { deeper: `${host.deep.deeper}x` } }
      const overBound = recordWithPad(base, grown, pad)
      expect(serializedBytes(overBound)).toBeGreaterThan(8_192)
      expect(migrationSnapshotRecordIssue(overBound)).toEqual({ field: 'record', kind: 'limit' })
    }
  })

  test('an oversized top-level array is a typed limit issue, by width or by bytes', () => {
    const marker = 'SECRET-TOP-ARRAY-MARKER'
    // Over the array-width bound.
    expect(migrationSnapshotRecordShapeIssue(Array.from({ length: 65 }, () => 'x'))).toEqual({
      field: 'record',
      kind: 'limit',
    })
    // Within the width bound but over the byte bound.
    const wide = Array.from({ length: 64 }, () => marker.repeat(8))
    expect(migrationSnapshotRecordShapeIssue(wide)).toEqual({ field: 'record', kind: 'limit' })
    expect(JSON.stringify(migrationSnapshotRecordShapeIssue(wide))).not.toContain(marker)
  })

  test('a bigint is over-bound outright and bounded primitive shapes fit the byte bound', () => {
    // A bigint's serialization length is unbounded: rejected without scanning.
    expect(migrationSnapshotRecordShapeIssue(BigInt('9'.repeat(10_000)))).toEqual({
      field: 'record',
      kind: 'limit',
    })
    // Fixed-cost primitives and null fit the byte bound: the walk reports no
    // size issue for them (malformed-shape handling belongs to the record
    // validation and the comparator's intake, not to the size walk).
    expect(migrationSnapshotRecordShapeIssue(42)).toBeNull()
    expect(migrationSnapshotRecordShapeIssue(true)).toBeNull()
    expect(migrationSnapshotRecordShapeIssue(null)).toBeNull()
    expect(migrationSnapshotRecordShapeIssue(undefined)).toBeNull()
  })
})
