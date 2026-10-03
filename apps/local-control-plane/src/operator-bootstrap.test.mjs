import { expect, test } from 'bun:test'
import { appendFile, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { canonicalJson } from '@control-plane/domain'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
  SqliteProjectStateRepository,
} from '@control-plane/sqlite-persistence'
import { bootstrapLocalOperator } from './operator-bootstrap.ts'

async function runCli(directory, inputPath, timeoutMs = 10000) {
  const ledger = process.env['CONTROL_PLANE_LOCAL_RESOURCE_LEDGER']
  if (ledger)
    await appendFile(
      ledger,
      `operator-bootstrap test child planned; owner=root/bootstrap-tests; data=${directory}; no ports\n`
    )
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../dist/operator-bootstrap-cli.js', import.meta.url)),
      '--data-dir',
      directory,
      '--input',
      inputPath,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (ledger)
    await appendFile(
      ledger,
      `operator-bootstrap test child PID=${child.pid}; owner=root/bootstrap-tests\n`
    )
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    if (ledger)
      await appendFile(
        ledger,
        `operator-bootstrap test child PID=${child.pid} settled; exit=${child.exitCode}\n`
      )
  }
}

function bootstrapInput() {
  const inputs = createExecutionPlanTestFixtureInputs()
  const { profile, skills, correlation } = inputs
  profile.definition.skills = skills.map((skill) => ({
    skillId: skill.skillId,
    skillVersionId: skill.skillVersionId,
    contentDigest: `sha256:${createHash('sha256').update(canonicalJson(skill.content)).digest('hex')}`,
  }))
  return {
    schemaVersion: 1,
    workspaceId: correlation.workspaceId,
    projectId: correlation.projectId,
    at: inputs.compiledAt,
    profile: {
      profileId: profile.profileId,
      profileVersionId: profile.profileVersionId,
      displayName: 'Operator profile',
      version: profile.version,
      definition: profile.definition,
    },
    skills: skills.map((skill) => {
      const { contentDigest: _storedDigest, ...manifest } = skill.manifest
      return {
        skillId: skill.skillId,
        skillVersionId: skill.skillVersionId,
        displayName: 'Operator skill',
        manifest,
        content: skill.content,
      }
    }),
  }
}

test('packaged operator command applies explicit private input and prints only references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-operator-bootstrap-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
  })
  try {
    await persistence.migrate()
    persistence.close()
    const input = bootstrapInput()
    const inputPath = join(directory, 'input.json')
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 })
    const { code, stdout, stderr } = await runCli(directory, inputPath)
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout)).toMatchObject({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectStateRevision: 0,
    })
    expect(stdout).not.toContain(input.profile.definition.roleInstructions)
  } finally {
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

for (const failure of [
  'input-symlink',
  'input-fifo',
  'public-input',
  'oversized-input',
  'malformed-input',
  'public-data',
]) {
  test(`operator command rejects ${failure} without leaking input or creating catalog records`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-operator-bootstrap-'))
    const persistence = new SqlitePersistenceProvider({
      path: join(directory, 'control-plane.sqlite'),
    })
    try {
      await persistence.migrate()
      persistence.close()
      const input = bootstrapInput()
      input.profile.definition.roleInstructions = 'bootstrap-secret-canary'
      let inputPath = join(directory, 'input.json')
      await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 })
      if (failure === 'input-symlink') {
        const link = join(directory, 'linked.json')
        await symlink(inputPath, link)
        inputPath = link
      } else if (failure === 'input-fifo') {
        inputPath = join(directory, 'input.fifo')
        const ledger = process.env['CONTROL_PLANE_LOCAL_RESOURCE_LEDGER']
        if (ledger)
          await appendFile(
            ledger,
            `operator-bootstrap synchronous mkfifo child planned; owner=root/bootstrap-tests; path=${inputPath}; no ports\n`
          )
        const created = Bun.spawnSync(['mkfifo', '-m', '600', inputPath], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (ledger)
          await appendFile(
            ledger,
            `operator-bootstrap synchronous mkfifo child settled; exit=${created.exitCode}\n`
          )
        expect(created.exitCode).toBe(0)
      } else if (failure === 'public-input') await chmod(inputPath, 0o644)
      else if (failure === 'oversized-input') await writeFile(inputPath, 'x'.repeat(262145))
      else if (failure === 'malformed-input')
        await writeFile(inputPath, '{"bootstrap-secret-canary":')
      else if (failure === 'public-data') await chmod(directory, 0o755)
      expect(await runCli(directory, inputPath, failure === 'input-fifo' ? 2000 : 10000)).toEqual({
        code: 1,
        stdout: '',
        stderr: 'LOCAL_OPERATOR_BOOTSTRAP_FAILED\n',
      })
      await chmod(directory, 0o700)
      const reopened = new SqlitePersistenceProvider({
        path: join(directory, 'control-plane.sqlite'),
      })
      try {
        await reopened.migrate()
        expect(
          await new SqliteVersionedCatalogRepository(reopened).getAgentProfile(
            input.profile.profileId
          )
        ).toBeUndefined()
      } finally {
        reopened.close()
      }
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('operator bootstrap publishes scoped immutable inputs and persists initial ProjectState across reopen and replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-operator-bootstrap-'))
  const path = join(directory, 'control-plane.sqlite')
  let persistence = new SqlitePersistenceProvider({ path })
  try {
    await persistence.migrate()
    const input = bootstrapInput()
    const result = await bootstrapLocalOperator(persistence, input)
    expect(result).toMatchObject({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectStateRevision: 0,
    })
    const catalog = new SqliteVersionedCatalogRepository(persistence)
    expect(await catalog.getAgentProfile(input.profile.profileId)).toMatchObject({
      ownership: { scope: 'workspace', workspaceId: input.workspaceId },
    })
    expect(await catalog.getSkill(input.skills[0].skillId)).toMatchObject({
      ownership: { scope: 'workspace', workspaceId: input.workspaceId },
      provenance: {
        source: 'workspace-authorized',
        ownerRef: input.workspaceId,
        trust: 'authorized',
      },
    })
    expect(await catalog.getAgentProfileVersion(input.profile.profileVersionId)).toMatchObject({
      lifecycle: 'published',
      revision: 2,
    })
    expect(await catalog.getSkillVersion(input.skills[0].skillVersionId)).toMatchObject({
      lifecycle: 'published',
      revision: 2,
    })
    expect(
      await new SqliteProjectStateRepository(persistence).get(input.workspaceId, input.projectId)
    ).toMatchObject({ revision: 0, items: [] })
    persistence.close()
    persistence = new SqlitePersistenceProvider({ path })
    await persistence.migrate()
    expect(await bootstrapLocalOperator(persistence, input)).toEqual(result)
  } finally {
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('operator bootstrap rolls back new records when a later immutable skill conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-operator-bootstrap-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
  })
  try {
    await persistence.migrate()
    const input = bootstrapInput()
    await bootstrapLocalOperator(persistence, input)
    const changed = structuredClone(input)
    changed.profile.profileId = changed.profile.profileId.slice(0, -1) + 'H'
    changed.profile.profileVersionId = changed.profile.profileVersionId.slice(0, -1) + 'H'
    changed.skills[0].displayName = 'Conflicting existing skill'
    await expect(bootstrapLocalOperator(persistence, changed)).rejects.toThrow(
      'LOCAL_OPERATOR_BOOTSTRAP_CONFLICT'
    )
    const catalog = new SqliteVersionedCatalogRepository(persistence)
    expect(await catalog.getAgentProfile(changed.profile.profileId)).toBeUndefined()
    expect(await catalog.getAgentProfileVersion(changed.profile.profileVersionId)).toBeUndefined()
    expect(await catalog.getSkill(input.skills[0].skillId)).toMatchObject({
      displayName: 'Operator skill',
    })
  } finally {
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('operator bootstrap rejects a reused published version number under a different immutable ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-operator-bootstrap-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
  })
  try {
    await persistence.migrate()
    const input = bootstrapInput()
    await bootstrapLocalOperator(persistence, input)
    const changed = structuredClone(input)
    changed.profile.profileVersionId = changed.profile.profileVersionId.slice(0, -1) + 'H'
    await expect(bootstrapLocalOperator(persistence, changed)).rejects.toThrow(
      'VERSION_NUMBER_CONFLICT'
    )
    const catalog = new SqliteVersionedCatalogRepository(persistence)
    expect(await catalog.getAgentProfileVersion(changed.profile.profileVersionId)).toBeUndefined()
    expect(await catalog.listAgentProfileVersions(input.profile.profileId)).toHaveLength(1)
  } finally {
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

for (const [name, change] of [
  [
    'ownership override',
    (input) => {
      input.profile.ownership = { scope: 'system' }
    },
  ],
  [
    'mismatched skill pin',
    (input) => {
      input.profile.definition.skills[0].contentDigest = `sha256:${'0'.repeat(64)}`
    },
  ],
  [
    'duplicate skill identity',
    (input) => {
      input.skills.push(structuredClone(input.skills[0]))
    },
  ],
]) {
  test(`operator bootstrap rejects ${name} before persisting input`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-operator-bootstrap-'))
    const persistence = new SqlitePersistenceProvider({
      path: join(directory, 'control-plane.sqlite'),
    })
    try {
      await persistence.migrate()
      const input = bootstrapInput()
      change(input)
      await expect(bootstrapLocalOperator(persistence, input)).rejects.toThrow()
      expect(
        await new SqliteVersionedCatalogRepository(persistence).getAgentProfile(
          input.profile.profileId
        )
      ).toBeUndefined()
      expect(
        await new SqliteProjectStateRepository(persistence).get(input.workspaceId, input.projectId)
      ).toBeUndefined()
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
