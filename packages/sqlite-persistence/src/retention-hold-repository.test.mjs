import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from './index.ts'
import {
  SqliteRetentionHoldRepository,
  countSqliteMatchingActiveRetentionHolds,
} from './retention-hold-repository.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherWorkspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherProjectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const provenance = {
  actorPrincipalRef: 'operator:os-user:sqlite-test',
  authorityRef: 'authority:sqlite:local-os',
}
const policy = {
  'context-packages': {
    owner: 'workspace-owner',
    scopes: ['class', 'workspace', 'project'],
    reasonCodes: ['legal-case'],
  },
  'evaluation-runs': {
    owner: 'release-owner',
    scopes: ['class'],
    reasonCodes: ['legal-case'],
  },
}

const makeHold = (scope, overrides = {}) => ({
  holdId: randomUUID(),
  classId: 'context-packages',
  scope,
  owner: 'workspace-owner',
  reasonCode: 'legal-case',
  createdAt: '2026-09-26T12:00:00.000Z',
  createdBy: provenance,
  revision: 0,
  ...overrides,
})

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'retention-holds-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'holds.sqlite') })
  try {
    await provider.migrate()
    await run({ directory, provider })
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('SQLite holds persist create/release history and never reactivate on create replay', async () => {
  await withProvider(async ({ directory, provider }) => {
    const repository = new SqliteRetentionHoldRepository(provider, policy)
    const hold = makeHold({ kind: 'project', workspaceId, projectId })
    expect(await repository.create(hold)).toEqual({ created: true, hold })

    const release = {
      requestId: randomUUID(),
      releasedAt: '2026-09-26T13:00:00.000Z',
      releasedBy: provenance,
    }
    expect(await repository.release({ holdId: hold.holdId, expectedRevision: 0, release })).toEqual(
      {
        released: true,
        hold: { ...hold, revision: 1, release },
      }
    )
    expect(await repository.release({ holdId: hold.holdId, expectedRevision: 0, release })).toEqual(
      {
        released: false,
        hold: { ...hold, revision: 1, release },
      }
    )

    const replayed = await repository.create(hold)
    expect(replayed.created).toBe(false)
    expect(replayed.hold).toEqual({ ...hold, revision: 1, release })
    await expect(repository.create({ ...hold, reasonCode: 'different-case' })).rejects.toThrow(
      'RETENTION_HOLD_ID_CONFLICT'
    )

    const path = join(directory, 'holds.sqlite')
    await provider.close()
    const reopened = new SqlitePersistenceProvider({ path })
    try {
      await reopened.migrate()
      expect(await new SqliteRetentionHoldRepository(reopened, policy).get(hold.holdId)).toEqual({
        ...hold,
        revision: 1,
        release,
      })
    } finally {
      await reopened.close()
    }
  })
})

test('SQLite matching counts honor nested scopes and fail closed on incomplete/malformed scope', async () => {
  await withProvider(async ({ provider }) => {
    const repository = new SqliteRetentionHoldRepository(provider, policy)
    const holds = [
      makeHold({ kind: 'class' }),
      makeHold({ kind: 'workspace', workspaceId }),
      makeHold({ kind: 'project', workspaceId, projectId }),
      makeHold({ kind: 'project', workspaceId: otherWorkspaceId, projectId: otherProjectId }),
    ]
    for (const hold of holds) await repository.create(hold)

    const count = (scope) =>
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(
          transaction,
          { classId: 'context-packages', ...(scope === undefined ? {} : { scope }) },
          policy
        )
      )
    expect(await count({ kind: 'project', workspaceId, projectId })).toBe(3)
    expect(await count({ kind: 'project', workspaceId, projectId: otherProjectId })).toBe(2)
    await expect(count({ kind: 'workspace', workspaceId })).rejects.toThrow(
      'RETENTION_HOLD_TARGET_SCOPE_MISSING'
    )
    await expect(count(undefined)).rejects.toThrow('RETENTION_HOLD_TARGET_SCOPE_MISSING')

    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'retention-holds',
        id: randomUUID(),
        value: {
          ...makeHold({ kind: 'project', workspaceId, projectId: 'prj_malformed' }),
        },
      })
    )
    await expect(count({ kind: 'project', workspaceId, projectId })).rejects.toThrow(
      'RETENTION_HOLD_STORED_RECORD_INVALID'
    )
  })
})

test('SQLite class-only configured classes reject tenant-scoped holds', async () => {
  await withProvider(async ({ provider }) => {
    const repository = new SqliteRetentionHoldRepository(provider, policy)
    await expect(
      repository.create(
        makeHold(
          { kind: 'project', workspaceId, projectId },
          { classId: 'evaluation-runs', owner: 'release-owner' }
        )
      )
    ).rejects.toThrow('RETENTION_HOLD_STORED_RECORD_INVALID')
  })
})

test('SQLite rejects inherited class-policy keys before writing a hold', async () => {
  await withProvider(async ({ provider }) => {
    const repository = new SqliteRetentionHoldRepository(provider, policy)
    const hold = makeHold({ kind: 'class' }, { classId: 'constructor' })
    await expect(repository.create(hold)).rejects.toThrow('RETENTION_HOLD_CLASS_UNCONFIGURED')
    expect(await repository.get(hold.holdId)).toBeUndefined()
    await expect(
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(transaction, { classId: 'constructor' }, policy)
      )
    ).rejects.toThrow('RETENTION_HOLD_CLASS_UNCONFIGURED')
  })
})
