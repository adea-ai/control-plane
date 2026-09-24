import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { SqliteCatalogApprovalRepository, SqlitePersistenceProvider } from './index.ts'

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
