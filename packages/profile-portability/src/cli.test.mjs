import { afterEach, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { runPortabilityCli } from './cli.ts'
import { exportPortableState } from './index.ts'

const directories = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('profile portability CLI', () => {
  test('exports, verifies, dry-runs, applies, and idempotently replays a Local to Hosted Simple move', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portability-cli-'))
    directories.push(directory)
    const sourcePath = join(directory, 'source.sqlite')
    const destinationPath = join(directory, 'destination.sqlite')
    const manifestPath = join(directory, 'manifest.json')
    const source = new SqlitePersistenceProvider({ path: sourcePath, profile: 'local' })
    await source.migrate()
    await source.transaction((transaction) =>
      transaction.put({
        namespace: 'agent-profiles',
        id: 'profile-cli',
        value: { profileId: 'profile-cli', revision: 1, label: 'CLI portable' },
      })
    )
    source.close()

    const output = []
    const io = { stdout: (value) => output.push(value), stderr: (value) => output.push(value) }
    expect(
      await runPortabilityCli(
        [
          'export',
          '--database',
          sourcePath,
          '--profile',
          'local',
          '--output',
          manifestPath,
          '--export-id',
          'cli-export',
        ],
        io
      )
    ).toBe(0)
    expect((await readFile(manifestPath, 'utf8')).includes('CLI portable')).toBe(true)
    expect(await runPortabilityCli(['verify', '--manifest', manifestPath], io)).toBe(0)
    expect(
      await runPortabilityCli(
        [
          'plan',
          '--database',
          destinationPath,
          '--profile',
          'hosted-simple',
          '--manifest',
          manifestPath,
        ],
        io
      )
    ).toBe(0)
    expect(
      await runPortabilityCli(
        [
          'import',
          '--database',
          destinationPath,
          '--profile',
          'hosted-simple',
          '--manifest',
          manifestPath,
        ],
        io
      )
    ).toBe(0)
    expect(
      await runPortabilityCli(
        [
          'import',
          '--database',
          destinationPath,
          '--profile',
          'hosted-simple',
          '--manifest',
          manifestPath,
          '--apply',
        ],
        io
      )
    ).toBe(0)
    expect(
      await runPortabilityCli(
        [
          'import',
          '--database',
          destinationPath,
          '--profile',
          'hosted-simple',
          '--manifest',
          manifestPath,
          '--apply',
        ],
        io
      )
    ).toBe(0)
    expect(output.join('\n')).toContain('replayed')
  })

  test('blocks export while a local execution is active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portability-cli-active-'))
    directories.push(directory)
    const databasePath = join(directory, 'active.sqlite')
    const provider = new SqlitePersistenceProvider({ path: databasePath, profile: 'local' })
    await provider.migrate()
    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'executions',
        id: 'active-1',
        value: {
          state: 'running',
          correlation: { workspaceId: 'wsp_portability', projectId: 'prj_portability' },
        },
      })
    )
    provider.close()
    const errors = []
    expect(
      await runPortabilityCli(
        ['export', '--database', databasePath, '--output', join(directory, 'blocked.json')],
        { stdout: () => undefined, stderr: (value) => errors.push(value) }
      )
    ).toBe(1)
    expect(errors.join('\n')).toContain('PORTABLE_ACTIVE_WORK')
  })

  test('loads export canaries from a file without putting secret values in arguments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portability-cli-canary-'))
    directories.push(directory)
    const databasePath = join(directory, 'source.sqlite')
    const manifestPath = join(directory, 'blocked.json')
    const canaryPath = join(directory, 'canaries.json')
    const canary = 'portable-cli-secret-canary-4917'
    const provider = new SqlitePersistenceProvider({ path: databasePath, profile: 'local' })
    await provider.migrate()
    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'agent-profiles',
        id: 'profile-canary',
        value: { profileId: 'profile-canary', revision: 1, note: canary },
      })
    )
    provider.close()
    await writeFile(canaryPath, `${JSON.stringify([canary])}\n`, { mode: 0o600 })
    const errors = []

    expect(
      await runPortabilityCli(
        [
          'export',
          '--database',
          databasePath,
          '--output',
          manifestPath,
          '--sensitive-values-file',
          canaryPath,
        ],
        { stdout: () => undefined, stderr: (value) => errors.push(value) }
      )
    ).toBe(1)
    expect(errors.join('\n')).toContain('PORTABLE_SENSITIVE_VALUE')
    await expect(access(manifestPath)).rejects.toBeDefined()
  })

  test('rejects an oversized sensitive-values file before export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portability-cli-canary-limit-'))
    directories.push(directory)
    const databasePath = join(directory, 'source.sqlite')
    const manifestPath = join(directory, 'blocked.json')
    const canaryPath = join(directory, 'canaries.json')
    await writeFile(canaryPath, `${' '.repeat(4_194_305)}[]`, { mode: 0o600 })
    const errors = []

    expect(
      await runPortabilityCli(
        [
          'export',
          '--database',
          databasePath,
          '--output',
          manifestPath,
          '--sensitive-values-file',
          canaryPath,
        ],
        { stdout: () => undefined, stderr: (value) => errors.push(value) }
      )
    ).toBe(1)
    expect(errors.join('\n')).toContain('PORTABILITY_CLI_ERROR')
    await expect(access(manifestPath)).rejects.toBeDefined()
  })

  test('redacts artifact metadata and reference identifiers from plan output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portability-cli-plan-redaction-'))
    directories.push(directory)
    const manifestPath = join(directory, 'manifest.json')
    const databasePath = join(directory, 'destination.sqlite')
    const hiddenMetadata = 'internal-artifact-label-7913'
    const hiddenSecretKey = 'provider-secret-key-4281'
    const hiddenUnsupportedReference = 'unsupported-internal-reference-6752'
    const body = 'portable-artifact'
    const manifest = await exportPortableState(
      {
        profile: 'local',
        persistence: 'sqlite',
        objectStore: 'filesystem',
        componentVersions: { portability: '1.0.0' },
        snapshot: async () => ({
          records: [],
          artifacts: [
            {
              key: 'artifacts/result.json',
              size: Buffer.byteLength(body),
              sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
              metadata: { label: hiddenMetadata },
            },
          ],
          secretReferences: [{ provider: 'host-secure', key: hiddenSecretKey, purpose: 'model' }],
          unsupportedReferences: [hiddenUnsupportedReference],
        }),
      },
      { exportId: 'plan-redaction', createdAt: '2026-08-31T12:00:00.000Z' }
    )
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    const output = []

    expect(
      await runPortabilityCli(['plan', '--database', databasePath, '--manifest', manifestPath], {
        stdout: (value) => output.push(value),
        stderr: (value) => output.push(value),
      })
    ).toBe(2)
    const rendered = output.join('\n')
    expect(rendered).toContain('unsupportedReferenceCount')
    expect(rendered).not.toContain(hiddenMetadata)
    expect(rendered).not.toContain(hiddenSecretKey)
    expect(rendered).not.toContain(hiddenUnsupportedReference)
  })
})
