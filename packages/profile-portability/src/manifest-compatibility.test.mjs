import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableName } from 'drizzle-orm'
import { importedCredential } from '@control-plane/credential-vault'
import { SqlitePersistenceProvider, writeSqliteCredential } from '@control-plane/sqlite-persistence'
import { ProjectStateSchema } from '@control-plane/domain'
import {
  PersistencePortableStateDestination,
  applyPortableImport,
  planPortableImport,
  portableCredentialRecord,
} from './migration.ts'
import { PostgresPortableStateDestination } from './postgres.ts'
import {
  contextPackageSerializationFixtures,
  deriveContextPackage,
  assertContextPackageIntegrity,
} from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { canonicalJsonStringify } from '@control-plane/domain'
import {
  assertPortableManifest,
  matchesVerifiedPortableRecord,
  createPortableRecord,
  finalizePortableManifest,
  finalizeCanonicalPortableManifest,
  PORTABLE_CANONICAL_DIGEST_VERSION,
} from './manifest.ts'

const fixtures = ['pre-614', 'post-614'].map((epoch) =>
  JSON.parse(readFileSync(new URL(`./fixtures/manifest-${epoch}.json`, import.meta.url), 'utf8'))
)
const [before, after] = fixtures
const digest = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
const unsigned = (manifest) => {
  const { contentDigest: _digest, ...input } = structuredClone(manifest)
  return input
}
const canonicalInput = () => ({
  ...unsigned(after.manifest),
  digestVersion: PORTABLE_CANONICAL_DIGEST_VERSION,
})

function legacyDigest(value) {
  const order = new Intl.Collator('en-US').compare
  const encode = (item) =>
    Array.isArray(item)
      ? `[${item.map(encode).join(',')}]`
      : item !== null && typeof item === 'object'
        ? `{${Object.entries(item)
            .toSorted(([a], [b]) => order(a, b))
            .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
            .join(',')}}`
        : JSON.stringify(item)
  return `sha256:${createHash('sha256').update(encode(value)).digest('hex')}`
}

describe('frozen historical portability manifests', () => {
  test('fixtures pin the historical complete and per-record digests across #614', () => {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/manifest-pre-614.json', import.meta.url)))
        .digest('hex')
    ).toBe('82c29b8d72fb5143d5945af3e89fb9bfdb16a6993e81efcc3235256bffa5a964')
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/manifest-post-614.json', import.meta.url)))
        .digest('hex')
    ).toBe('dec748c1d97adad1569b992a26e68d70d07f91fc3840544a050215a9776636a8')
    expect(before.sourceCommit).toBe('bb10f8e0569834ab9d5a65551868a4e0ff9c6810')
    expect(before.manifest.contentDigest).toBe(
      'sha256:ae156956c2dfb7a2b6c8246fc4dcb0b0f1580ab0885165a1cc6e82852a6156b2'
    )
    expect(after.manifest.contentDigest).toBe(
      'sha256:bcf16f8a878f4ec47d892be34a7e958589f6b360859eb3c1068f4cb5b498c781'
    )
    expect(before.manifest.records[0].contentDigest).toBe(
      'sha256:50c0d86293a6cad4da28a28b431f2a31ee1aa072a078bc3cb4206239bf49fa8a'
    )
    expect(after.manifest.records[0].contentDigest).toBe(
      'sha256:c3229b78f426c753b1ce91c0cc7268ce92106999dc8ec3dfffb30db31c8ddd45'
    )
  })

  for (const fixture of fixtures) {
    test(`${fixture.writerEpoch} verifies without changing retained identity, digest or array order`, () => {
      const snapshot = JSON.stringify(fixture.manifest)
      const result = assertPortableManifest(fixture.manifest)
      expect(result).toEqual(fixture.manifest)
      expect(JSON.stringify(fixture.manifest)).toBe(snapshot)
      expect(result.contentDigest).toBe(fixture.manifest.contentDigest)
      expect(result.records.map((record) => record.contentDigest)).toEqual(
        fixture.manifest.records.map((record) => record.contentDigest)
      )
    })
  }

  test('the historical epoch covers records as well as the whole manifest', () => {
    const mixed = structuredClone(before.manifest)
    mixed.records[0].contentDigest = after.manifest.records[0].contentDigest
    mixed.contentDigest = legacyDigest(unsigned(mixed))
    expect(() => assertPortableManifest(mixed)).toThrow('PORTABLE_RECORD_DIGEST_INVALID')
  })

  test('tamper, truncation, reorder and epoch substitution never silently rewrite a historical digest', () => {
    for (const fixture of fixtures) {
      for (const mutate of [
        (value) => {
          value.records[0].value['a_b'] = 99
        },
        (value) => {
          value.records.pop()
        },
        (value) => {
          value.records = value.records.toReversed()
        },
        (value) => {
          value.secretReferences[0].purpose = 'changed'
        },
        (value) => {
          value.contentDigest = 'sha256:' + '0'.repeat(64)
        },
      ]) {
        const changed = structuredClone(fixture.manifest)
        mutate(changed)
        expect(() => assertPortableManifest(changed)).toThrow('PORTABLE_MANIFEST_DIGEST_INVALID')
      }
    }
  })

  test('current unversioned exports keep their existing post-#614 bytes and shape', () => {
    const result = finalizePortableManifest(unsigned(after.manifest))
    expect(result).toEqual(after.manifest)
    expect(result).not.toHaveProperty('digestVersion')
    expect(
      createPortableRecord({
        category: 'policy-configuration',
        logicalId: after.manifest.records[0].logicalId,
        revision: 1,
        value: after.manifest.records[0].value,
      })
    ).toEqual(after.manifest.records[0])
  })
})

describe('explicit reader-first canonical portability digests', () => {
  test('the explicit version round-trips through JSON and includes its version in the digest', () => {
    const result = finalizeCanonicalPortableManifest(canonicalInput())
    expect(result.digestVersion).toBe('code-point-v2')
    expect(result.contentDigest).toBe(digest(unsigned(result)))
    expect(result.contentDigest).not.toBe(after.manifest.contentDigest)
    expect(assertPortableManifest(JSON.parse(JSON.stringify(result)))).toEqual(result)
  })

  test('new sorting is deterministic across permutations of records, references and object keys', () => {
    const first = canonicalInput()
    const second = structuredClone(first)
    second.records = second.records.toReversed()
    second.artifacts = second.artifacts.toReversed()
    second.secretReferences = second.secretReferences.toReversed()
    second.componentVersions = Object.fromEntries(
      Object.entries(second.componentVersions).toReversed()
    )
    second.compatibility.requiredCapabilities =
      second.compatibility.requiredCapabilities.toReversed()
    expect(finalizeCanonicalPortableManifest(second)).toEqual(
      finalizeCanonicalPortableManifest(first)
    )
    const result = finalizeCanonicalPortableManifest(first)
    expect(result.records.map((record) => record.logicalId)).toEqual(['Aa', 'a-b', 'a_b', 'ab'])
    expect(result.secretReferences.map((reference) => reference.key)).toEqual(['Aa', 'a-b', 'a_b'])
  })

  test('equal reference identity keys retain every value and have deterministic canonical tie-breaks', () => {
    const input = canonicalInput()

    input.secretReferences.push({ ...input.secretReferences[0], purpose: 'another-purpose' })
    input.artifacts.push({ ...input.artifacts[0], metadata: { alternate: 'metadata' } })
    const reversed = structuredClone(input)
    reversed.records = reversed.records.toReversed()
    reversed.secretReferences = reversed.secretReferences.toReversed()
    reversed.artifacts = reversed.artifacts.toReversed()
    expect(finalizeCanonicalPortableManifest(reversed)).toEqual(
      finalizeCanonicalPortableManifest(input)
    )
    expect(finalizeCanonicalPortableManifest(input).records).toHaveLength(input.records.length)
  })

  test('unknown, malformed and downgraded version claims cannot fall back to historical verification', () => {
    for (const version of [null, 1, {}, [], '', 'code-point-v1', 'code-point-v3']) {
      expect(() => assertPortableManifest({ ...after.manifest, digestVersion: version })).toThrow()
      expect(() =>
        finalizeCanonicalPortableManifest({ ...canonicalInput(), digestVersion: version })
      ).toThrow()
    }
    const explicit = finalizeCanonicalPortableManifest(canonicalInput())
    delete explicit.digestVersion
    expect(() => assertPortableManifest(explicit)).toThrow('PORTABLE_MANIFEST_DIGEST_INVALID')
    expect(() =>
      assertPortableManifest({
        ...after.manifest,
        digestVersion: PORTABLE_CANONICAL_DIGEST_VERSION,
      })
    ).toThrow('PORTABLE_MANIFEST_DIGEST_INVALID')
  })

  test('a new-format outer digest never authorizes legacy-epoch record digests', () => {
    const value = { ...unsigned(before.manifest), digestVersion: PORTABLE_CANONICAL_DIGEST_VERSION }
    const manifest = finalizeCanonicalPortableManifest(value)
    expect(() => assertPortableManifest(manifest)).toThrow('PORTABLE_RECORD_DIGEST_INVALID')
  })

  test('new-format record tamper fails even when the whole-manifest digest is recomputed', () => {
    const value = finalizeCanonicalPortableManifest(canonicalInput())
    value.records[0].value['a_b'] = 99
    value.contentDigest = digest(unsigned(value))
    expect(() => assertPortableManifest(value)).toThrow('PORTABLE_RECORD_DIGEST_INVALID')
  })
})

describe('canonical record identity ambiguity', () => {
  const parent = contextPackageSerializationFixtures.futurePi
  const child = deriveContextPackage(parent, {
    objective: 'Different valid portable context',
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: { maximumBytes: 512, maximumTokens: 128 },
    successCriteria: ['Keep identities unambiguous'],
    returnContract: parent.returnContract,
    compiledAt: '2026-08-30T13:00:00.000Z',
  })
  const plans = [
    createExecutionPlanTestFixture({ contextPackage: parent }),
    createExecutionPlanTestFixture({ contextPackage: child }),
  ]

  for (const [category, logicalId, values, verify] of [
    [
      'context-package',
      `context-packages/${parent.contextPackageId}`,
      [parent, child],
      assertContextPackageIntegrity,
    ],
    [
      'execution-plan',
      `execution-plans/${plans[0].executionPlanId}`,
      plans,
      assertExecutionPlanIntegrity,
    ],
  ]) {
    test(`${category} duplicate logical identity is refused in either retained order`, () => {
      for (const value of values) expect(() => verify(value)).not.toThrow()
      const records = values.map((value) =>
        createPortableRecord({ category, logicalId, revision: 0, value })
      )
      expect(() => finalizeCanonicalPortableManifest({ ...canonicalInput(), records })).toThrow(
        'PORTABLE_RECORD_IDENTITY_AMBIGUOUS'
      )
      const canonical = finalizeCanonicalPortableManifest({ ...canonicalInput(), records: [] })
      canonical.records = records.toSorted((a, b) =>
        canonicalJsonStringify(a) < canonicalJsonStringify(b) ? -1 : 1
      )
      canonical.contentDigest = digest(unsigned(canonical))
      const reversed = structuredClone(canonical)
      reversed.records = reversed.records.toReversed()
      expect(digest({ ...unsigned(reversed), records: canonical.records })).toBe(
        canonical.contentDigest
      )
      for (const manifest of [canonical, reversed])
        expect(() => assertPortableManifest(manifest)).toThrow('PORTABLE_RECORD_IDENTITY_AMBIGUOUS')
    })
  }
})

const createdAt = '2026-10-06T12:00:00.000Z'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const state = ProjectStateSchema.parse({
  schemaVersion: 1,
  workspaceId,
  projectId,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  items: [
    {
      itemId: 'psi_01JABCDEF0123456789ABCDEFG',
      key: 'compatibility',
      value: { a_b: 1, 'a-b': 2, Aa: 3, ab: 4 },
      sensitivity: 'internal',
      itemRevision: 1,
      createdAt,
      updatedAt: createdAt,
      freshness: { observedAt: createdAt },
      provenance: { sourceKind: 'system', artifactRefs: [], capturedAt: createdAt },
    },
  ],
})
const stateRecord = {
  category: 'project-state',
  logicalId: `project-states/${workspaceId}:${projectId}`,
  revision: 1,
  value: state,
}
const credential = {
  credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
  workspaceId,
  connectorRef: 'connector:github',
  provider: 'github',
  revision: 1,
  createdAt,
}
function historicalManifest(records) {
  const input = {
    ...unsigned(before.manifest),
    exportId: 'historical-adapter-replay',
    records: records.map((record) => ({ ...record, contentDigest: legacyDigest(record) })),
    compatibility: { ...before.manifest.compatibility, requiredCapabilities: [] },
    artifacts: [],
    secretReferences: [],
    unsupportedReferences: [],
  }
  return { ...input, contentDigest: legacyDigest(input) }
}
const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})
async function sqliteDestination() {
  const directory = await mkdtemp(join(tmpdir(), 'portable-historical-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'state.sqlite'),
    profile: 'local',
  })
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))
  cleanups.push(async () => persistence.close())
  await persistence.migrate()
  return {
    persistence,
    destination: new PersistencePortableStateDestination({
      persistence,
      capabilities: [],
      secretProviders: [],
    }),
  }
}
// Real PostgreSQL adapter, scripted query boundary only; no live database claim.
function postgresDestination(stateValue = state) {
  const rows = {
    project_states: [{ workspaceId, projectId, revision: stateValue.revision, state: stateValue }],
  }
  const provenance = []
  const database = {
    select: () => ({
      from(table) {
        const values = rows[getTableName(table)] ?? []
        return Object.assign(Promise.resolve(values), {
          where: () => ({ limit: async () => provenance }),
        })
      },
    }),
    insert: () => ({
      values: async (value) => {
        provenance.push(value)
      },
    }),
    transaction: async (operation, options) => {
      expect(options.isolationLevel).toBe('serializable')
      return operation(database)
    },
  }
  return {
    provenance,
    destination: new PostgresPortableStateDestination({
      database,
      profile: 'cloud',
      capabilities: [],
      secretProviders: [],
    }),
  }
}

describe('verified historical destination equivalence', () => {
  test('complete verified identity and payload match; unverified legacy hashes and mutated records do not', () => {
    const raw = historicalManifest([stateRecord])
    const [verified] = assertPortableManifest(raw).records
    expect(verified.contentDigest).not.toBe(createPortableRecord(stateRecord).contentDigest)
    expect(matchesVerifiedPortableRecord(verified, stateRecord)).toBe(true)
    expect(matchesVerifiedPortableRecord(structuredClone(verified), stateRecord)).toBe(false)
    for (const candidate of [
      { ...stateRecord, category: 'selected-history' },
      { ...stateRecord, logicalId: stateRecord.logicalId + ':other' },
      { ...stateRecord, revision: 2 },
      { ...stateRecord, value: { ...state, revision: 2 } },
    ])
      expect(matchesVerifiedPortableRecord(verified, candidate)).toBe(false)
    verified.value.items[0].value['a_b'] = 99
    expect(matchesVerifiedPortableRecord(verified, stateRecord)).toBe(false)
    verified.contentDigest = legacyDigest({ ...stateRecord, value: verified.value })
    expect(matchesVerifiedPortableRecord(verified, { ...stateRecord, value: verified.value })).toBe(
      false
    )
  })

  test('SQLite imports then replays historical ordinary records without rewriting retained digests or provenance', async () => {
    const { persistence, destination } = await sqliteDestination()
    const manifest = historicalManifest([stateRecord])
    const original = JSON.stringify(manifest)
    const plan = await planPortableImport(manifest, destination)
    expect(plan.records[0].state).toBe('missing')
    const first = await applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    expect(first.outcome).toBe('applied')
    const replayPlan = await planPortableImport(manifest, destination)
    expect(replayPlan.records[0].state).toBe('equivalent')
    expect(replayPlan.records[0].record.contentDigest).toBe(manifest.records[0].contentDigest)
    const replay = await applyPortableImport(manifest, replayPlan, destination, {}, () => createdAt)
    expect(replay.outcome).toBe('replayed')
    expect(replay.provenance.manifestDigest).toBe(manifest.contentDigest)
    expect(
      await persistence.transaction((tx) => tx.get('profile-migrations', manifest.exportId))
    ).toMatchObject({ value: first.provenance })
    expect(JSON.stringify(manifest)).toBe(original)
    const changed = structuredClone(stateRecord)
    changed.value.items[0].value['a_b'] = 99
    const conflict = await planPortableImport(historicalManifest([changed]), destination)
    expect(conflict.applicable).toBe(false)
    expect(conflict.records[0].state).toBe('conflict')
    expect((await destination.inspect(manifest.records))[0].state).toBe('conflict')
  })

  test('SQLite credential equality compares only strict portable metadata and refuses changed metadata', async () => {
    const { persistence, destination } = await sqliteDestination()
    await persistence.transaction((tx) => writeSqliteCredential(tx, importedCredential(credential)))
    const manifest = historicalManifest([portableCredentialRecord(credential)])
    const plan = await planPortableImport(manifest, destination)
    expect(plan.records[0].state).toBe('equivalent')
    expect(plan.records[0].record.value).toEqual(credential)
    expect(JSON.stringify(plan.records)).not.toContain('secret_required')
    expect(JSON.stringify(plan.records)).not.toContain('secretRevisions')
    expect(
      (await applyPortableImport(manifest, plan, destination, {}, () => createdAt)).outcome
    ).toBe('replayed')
    const changed = historicalManifest([
      portableCredentialRecord({ ...credential, provider: 'other' }),
    ])
    expect((await planPortableImport(changed, destination)).records[0].state).toBe('conflict')
  })

  test('PostgreSQL compares the verified historical record and replays its retained provenance', async () => {
    const { destination, provenance } = postgresDestination()
    const manifest = historicalManifest([stateRecord])
    const plan = await planPortableImport(manifest, destination)
    expect(plan.records[0].state).toBe('equivalent')
    expect(plan.records[0].record.contentDigest).toBe(manifest.records[0].contentDigest)
    expect(
      (await applyPortableImport(manifest, plan, destination, {}, () => createdAt)).outcome
    ).toBe('replayed')
    expect(
      (await applyPortableImport(manifest, plan, destination, {}, () => createdAt)).outcome
    ).toBe('replayed')
    expect(provenance).toHaveLength(1)
    expect(provenance[0].manifestDigest).toBe(manifest.contentDigest)
    expect(provenance[0].provenance.manifestDigest).toBe(manifest.contentDigest)
    expect((await destination.inspect(manifest.records))[0].state).toBe('conflict')
    const changed = structuredClone(state)
    changed.items[0].value['a_b'] = 99
    const changedDestination = postgresDestination(changed).destination
    expect((await planPortableImport(manifest, changedDestination)).records[0].state).toBe(
      'conflict'
    )
    const revision = { ...state, revision: 2 }
    expect(
      (await planPortableImport(manifest, postgresDestination(revision).destination)).records[0]
        .state
    ).toBe('conflict')
  })

  test('PostgreSQL staging validates the retained digest rather than replacing malformed identity', async () => {
    const { destination } = postgresDestination()
    const transaction = await destination.begin()
    await expect(transaction.put({ ...stateRecord, contentDigest: 'invalid' })).rejects.toThrow()
    await transaction.put(historicalManifest([stateRecord]).records[0])
    await transaction.rollback()
  })
})

test('historical duplicate logical identities also fail closed across revisions and categories', () => {
  for (const other of [
    stateRecord,
    { ...stateRecord, revision: 2 },
    { ...stateRecord, category: 'selected-history' },
  ]) {
    expect(() => assertPortableManifest(historicalManifest([stateRecord, other]))).toThrow(
      'PORTABLE_RECORD_IDENTITY_AMBIGUOUS'
    )
  }
})
