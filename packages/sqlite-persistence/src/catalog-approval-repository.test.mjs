import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { executionConstraintFixtures } from '@control-plane/domain'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  SqliteCatalogApprovalRepository,
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
} from './index.ts'

const digest = (character) => `sha256:${character.repeat(64)}`

const decision = (overrides = {}) => ({
  versionKind: 'agent_profile',
  versionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  revision: 1,
  contentDigest: digest('a'),
  decision: 'approved',
  actorPrincipalRef: 'principal://agent-hq/user/42',
  decidedAt: '2026-09-24T12:00:00.000Z',
  ...overrides,
})

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function openProvider() {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-approvals-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'control-plane.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  return { path, provider }
}

describe('SQLite catalog approval persistence', () => {
  test('stores one decision per revision, filters by version, and survives reopen', async () => {
    const { path, provider } = await openProvider()
    const approvals = new SqliteCatalogApprovalRepository(provider)

    expect(await approvals.insert(decision())).toBe(true)
    expect(await approvals.insert(decision())).toBe(false)
    expect(await approvals.insert(decision({ revision: 2, contentDigest: digest('b') }))).toBe(true)
    expect(
      await approvals.insert(
        decision({ versionId: 'pfv_01JABCDEF0123456789ABCDEFH', decision: 'rejected' })
      )
    ).toBe(true)

    expect(await approvals.list('agent_profile', decision().versionId)).toHaveLength(2)
    expect(await approvals.list('agent_profile', 'pfv_01JABCDEF0123456789ABCDEFH')).toMatchObject([
      { decision: 'rejected' },
    ])
    await provider.close()

    const reopened = new SqlitePersistenceProvider({ path })
    await reopened.migrate()
    const durable = new SqliteCatalogApprovalRepository(reopened)
    expect(await durable.list('agent_profile', decision().versionId)).toHaveLength(2)
    expect(await durable.insert(decision())).toBe(false)
    await reopened.close()
  })
})

const profileVersion = {
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  version: 3,
  revision: 2,
  lifecycle: 'published',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  definition: {
    schemaVersion: 1,
    roleInstructions: 'Complete the assigned task safely.',
    skills: [],
    capabilityRequirements: [],
    executionConstraints: globalThis.structuredClone(executionConstraintFixtures.write),
    outputContractRefs: [],
  },
  createdAt: '2026-08-22T12:00:00.000Z',
  lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
}

describe('catalog approval operator CLI', () => {
  test('records, replays, shows, and refuses divergent or stale decisions', async () => {
    const { path, provider } = await openProvider()
    const catalog = new SqliteVersionedCatalogRepository(provider)
    await catalog.insertAgentProfile({
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      displayName: 'Managed Pi',
      ownership: { scope: 'system' },
      createdAt: '2026-08-22T12:00:00.000Z',
    })
    await catalog.insertAgentProfileVersion(profileVersion)
    provider.close()

    const directory = temporaryDirectories.at(-1)
    const input = join(directory, 'approval.json')
    const script = fileURLToPath(
      new URL('../../../scripts/catalog-approval-admin.mjs', import.meta.url)
    )
    const run = () =>
      spawnSync(
        process.execPath,
        [script, '--backend', 'sqlite', '--database', path, '--input', input],
        {
          encoding: 'utf8',
          timeout: 15000,
        }
      )
    const record = {
      operation: 'approvals.record',
      decision: {
        versionKind: 'agent_profile',
        versionId: profileVersion.profileVersionId,
        revision: profileVersion.revision,
        contentDigest: profileVersion.contentDigest,
        decision: 'approved',
        actorPrincipalRef: 'principal://agent-hq/user/42',
        decidedAt: '2026-09-24T12:00:00.000Z',
      },
    }

    await writeFile(input, JSON.stringify(record), { mode: 0o600 })
    const applied = run()
    expect(applied.status).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: 'applied',
      operation: 'approvals.record',
      replayed: false,
    })

    const replay = run()
    expect(JSON.parse(replay.stdout)).toMatchObject({ replayed: true })

    await writeFile(
      input,
      JSON.stringify({
        operation: 'approvals.show',
        versionKind: 'agent_profile',
        versionId: profileVersion.profileVersionId,
      }),
      { mode: 0o600 }
    )
    const shown = run()
    expect(JSON.parse(shown.stdout)).toMatchObject({
      status: 'applied',
      decision: { revision: 2, decision: 'approved' },
    })

    await writeFile(
      input,
      JSON.stringify({ ...record, decision: { ...record.decision, revision: 1 } }),
      { mode: 0o600 }
    )
    const stale = run()
    expect(stale.status).toBe(1)
    expect(stale.stderr).toBe('CATALOG_APPROVAL_ADMIN_FAILED\n')

    const wrongTarget = spawnSync(
      process.execPath,
      [script, '--backend', 'sqlite', '--database', 'relative.sqlite', '--input', input],
      { encoding: 'utf8', timeout: 15000 }
    )
    expect(wrongTarget.status).toBe(1)
    expect(wrongTarget.stderr).toBe('CATALOG_APPROVAL_ADMIN_FAILED\n')
  })
})
