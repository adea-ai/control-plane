import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  sqliteOperatorSession,
  writeOperatorPolicyFixture,
} from './fixtures/retention-hold-operator-fixtures.mjs'

const directories = []
const projectScope = {
  kind: 'project',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

async function fixture(options) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-hold-operator-'))
  directories.push(directory)
  const database = join(directory, 'state.sqlite')
  await writeFile(database, '')
  return { directory, database, ...(await writeOperatorPolicyFixture(database, options)) }
}

afterEach(async () => {
  const owned = directories.splice(0)
  await Promise.all(owned.map((directory) => rm(directory, { recursive: true, force: true })))
})

async function load(policyFixture) {
  const { loadRetentionHoldOperatorPolicy } = await import('../scripts/retention-hold-operator.mjs')
  return loadRetentionHoldOperatorPolicy({ path: policyFixture.path, target: policyFixture.target })
}

describe('retention hold operator authorization (#194)', () => {
  test('grants require exact verified principal, authority, owner, class and action', async () => {
    const policyFixture = await fixture()
    const configured = await load(policyFixture)
    const request = {
      action: 'create',
      session: sqliteOperatorSession,
      owner: 'platform-operator',
      classId: 'command-inbox',
      scope: projectScope,
    }
    expect(await configured.authorizeOwner(request)).toBe(true)
    for (const changed of [
      { session: { ...sqliteOperatorSession, actorPrincipalRef: 'operator:untrusted' } },
      { session: { ...sqliteOperatorSession, authorityRef: 'authority:postgres:role:untrusted' } },
      { owner: 'workspace-owner' },
      { classId: 'executions' },
    ])
      expect(await configured.authorizeOwner({ ...request, ...changed })).toBe(false)
    expect(
      await configured.authorizeClassAction({
        session: sqliteOperatorSession,
        classId: 'command-inbox',
        action: 'sweep',
      })
    ).toBe(true)
  })

  test('project grants cannot elevate to class, another project or unscoped deletion', async () => {
    const policyFixture = await fixture({
      grants: [
        {
          ...sqliteOperatorSession,
          classId: 'command-inbox',
          scope: projectScope,
          actions: ['create', 'release', 'sweep', 'assess'],
        },
      ],
    })
    const configured = await load(policyFixture)
    const request = {
      action: 'create',
      session: sqliteOperatorSession,
      owner: 'platform-operator',
      classId: 'command-inbox',
      scope: projectScope,
    }
    expect(await configured.authorizeOwner(request)).toBe(true)
    expect(await configured.authorizeOwner({ ...request, scope: { kind: 'class' } })).toBe(false)
    expect(
      await configured.authorizeOwner({
        ...request,
        scope: { ...projectScope, projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      })
    ).toBe(false)
    expect(
      await configured.authorizeOwner({
        ...request,
        scope: { ...projectScope, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      })
    ).toBe(false)
    for (const action of ['sweep', 'assess'])
      expect(
        await configured.authorizeClassAction({
          session: sqliteOperatorSession,
          classId: 'command-inbox',
          action,
        })
      ).toBe(false)
  })

  test('create-only grants do not authorize release or sweep', async () => {
    const configured = await load(await fixture({ actions: ['create'] }))
    const request = {
      action: 'release',
      session: sqliteOperatorSession,
      owner: 'platform-operator',
      classId: 'command-inbox',
      scope: projectScope,
    }
    expect(await configured.authorizeOwner(request)).toBe(false)
    expect(
      await configured.authorizeClassAction({
        session: sqliteOperatorSession,
        classId: 'command-inbox',
        action: 'sweep',
      })
    ).toBe(false)
  })

  test('any matching explicit grant can authorize without shadowing other scopes', async () => {
    const policyFixture = await fixture({
      grants: [
        {
          ...sqliteOperatorSession,
          classId: 'command-inbox',
          scope: { ...projectScope, projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
          actions: ['create', 'sweep'],
        },
        {
          ...sqliteOperatorSession,
          classId: 'command-inbox',
          scope: projectScope,
          actions: ['create'],
        },
        {
          ...sqliteOperatorSession,
          classId: 'command-inbox',
          scope: { kind: 'class' },
          actions: ['sweep'],
        },
      ],
    })
    const configured = await load(policyFixture)
    expect(
      await configured.authorizeOwner({
        action: 'create',
        session: sqliteOperatorSession,
        owner: 'platform-operator',
        classId: 'command-inbox',
        scope: projectScope,
      })
    ).toBe(true)
    expect(
      await configured.authorizeClassAction({
        session: sqliteOperatorSession,
        classId: 'command-inbox',
        action: 'sweep',
      })
    ).toBe(true)
  })

  test('grant classes must be configured own keys, not inherited object properties', async () => {
    const policyFixture = await fixture()
    expect((await load(policyFixture)).policy).toEqual(policyFixture.document.policy)
    policyFixture.document.grants[0].classId = '__proto__'
    await writeFile(policyFixture.path, JSON.stringify(policyFixture.document))
    await expect(load(policyFixture)).rejects.toThrow()
  })

  test('protected configuration rejects a different target and writable files', async () => {
    const policyFixture = await fixture()
    expect((await load(policyFixture)).policy).toEqual(policyFixture.document.policy)
    await expect(
      load({
        ...policyFixture,
        target: { ...policyFixture.target, database: `${policyFixture.target.database}.other` },
      })
    ).rejects.toThrow()
    await chmod(policyFixture.path, 0o666)
    await expect(load(policyFixture)).rejects.toThrow()
  })

  test('configuration refuses symlinks, excess input and invented class owners', async () => {
    const policyFixture = await fixture()
    expect((await load(policyFixture)).policy).toEqual(policyFixture.document.policy)
    const link = join(policyFixture.directory, 'policy-link.json')
    await symlink(policyFixture.path, link)
    await expect(load({ ...policyFixture, path: link })).rejects.toThrow()
    await writeFile(policyFixture.path, 'x'.repeat(262145))
    await expect(load(policyFixture)).rejects.toThrow()
    policyFixture.document.policy['command-inbox'].owner = 'workspace-owner'
    await writeFile(policyFixture.path, JSON.stringify(policyFixture.document))
    await expect(load(policyFixture)).rejects.toThrow()
  })

  test('the actual SQLite administration adapter rejects spoofing and persists only authorized create/release', async () => {
    const policyFixture = await fixture()
    const { SqlitePersistenceProvider, SqliteRetentionHoldRepository } =
      await import('../packages/sqlite-persistence/src/index.ts')
    const provider = new SqlitePersistenceProvider({ path: policyFixture.database })
    await provider.migrate()
    provider.close()
    const { retentionHoldAdmin } = await import('../scripts/retention-hold-admin.mjs')
    const input = join(policyFixture.directory, 'request.json')
    const run = async (request, policyPath = policyFixture.path) => {
      await writeFile(input, JSON.stringify(request), { mode: 0o600 })
      let stdout = '',
        stderr = ''
      const status = await retentionHoldAdmin({
        argv: [
          '--backend',
          'sqlite',
          '--database',
          policyFixture.database,
          '--hold-policy',
          policyPath,
          '--input',
          input,
        ],
        writeOut: (value) => {
          stdout += value
        },
        writeErr: (value) => {
          stderr += value
        },
      })
      return { status, stdout, stderr }
    }
    const holdId = randomUUID()
    const create = {
      operation: 'create',
      holdId,
      classId: 'command-inbox',
      scope: projectScope,
      reasonCode: 'legal-case',
      ...sqliteOperatorSession,
    }
    const refused = await run({ ...create, actorPrincipalRef: 'operator:untrusted' })
    expect(refused).toEqual({ status: 1, stdout: '', stderr: 'RETENTION_HOLD_ADMIN_FAILED\n' })
    const applied = await run(create)
    expect(applied.status).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: 'applied',
      operation: 'create',
      holdId,
      revision: 0,
    })
    expect(JSON.parse((await run(create)).stdout).status).toBe('replayed')
    const reopened = new SqlitePersistenceProvider({ path: policyFixture.database })
    try {
      await reopened.migrate()
      const repository = new SqliteRetentionHoldRepository(reopened, policyFixture.document.policy)
      const held = await repository.get(holdId)
      expect(held.createdBy).toEqual(sqliteOperatorSession)
      expect(held.release).toBeUndefined()
      const release = {
        operation: 'release',
        holdId,
        requestId: randomUUID(),
        expectedRevision: 0,
        ...sqliteOperatorSession,
      }
      const releaseRefused = await run({ ...release, authorityRef: 'authority:untrusted' })
      expect(releaseRefused.status).toBe(1)
      expect((await repository.get(holdId)).release).toBeUndefined()
      const released = await run(release)
      expect(released.status).toBe(0)
      expect(JSON.parse(released.stdout)).toMatchObject({
        status: 'applied',
        operation: 'release',
        holdId,
        revision: 1,
      })
      expect((await repository.get(holdId)).release.releasedBy).toEqual(sqliteOperatorSession)
      expect(await readFile(policyFixture.path, 'utf8')).not.toContain('operator:untrusted')
    } finally {
      reopened.close()
    }
  }, 60000)
})
