import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reserveInstallDirectory,
  createAcpBuildEnvironment,
  pinnedAcpBuild,
  validateInstallDestination,
} from '../scripts/install-m11-codex-acp.mjs'
import { pinnedCodexNativeBuild } from '../packages/acp-adapter/src/pinned-codex-build.ts'
import {
  nativeBuildJobCount,
  normalizeCodexReleaseLock,
} from '../scripts/install-m11-codex-native.mjs'
import { createPinnedBuildCommand } from '../scripts/pinned-build-command.mjs'

test('native Linux builds serialize compiler jobs without changing the macOS default', () => {
  expect(nativeBuildJobCount('linux')).toBe('1')
  expect(nativeBuildJobCount('darwin')).toBe('4')
  expect(() => nativeBuildJobCount('win32')).toThrow('CODEX_NATIVE_PLATFORM_UNSUPPORTED')
})

test('native installer verifies its cancellation patch and rejects unpinned source locks', async () => {
  const patch = await readFile(
    new URL('../docs/evidence/fixtures/codex-0.148.0-sse-cancellation.patch', import.meta.url)
  )
  expect(createHash('sha256').update(patch).digest('hex')).toBe(pinnedCodexNativeBuild.patchSha256)
  expect(() => normalizeCodexReleaseLock(Buffer.from('version = "0.0.0"'))).toThrow(
    'CODEX_NATIVE_LOCK_MISMATCH'
  )
})

test('pinned build commands propagate failure and stop their timed-out process group', async () => {
  const run = createPinnedBuildCommand({}, 100)
  await expect(run(process.execPath, ['-e', 'process.exit(7)'], process.cwd())).rejects.toThrow(
    'PINNED_BUILD_COMMAND_FAILED'
  )
  await expect(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd())
  ).rejects.toThrow('PINNED_BUILD_COMMAND_FAILED')
})

test('ACP installer pins the reviewed accounting patch and refuses ambiguous destinations', async () => {
  const patch = await readFile(
    new URL('../docs/evidence/fixtures/codex-acp-1.7.0-prompt-usage.patch', import.meta.url)
  )
  expect(createHash('sha256').update(patch).digest('hex')).toBe(pinnedAcpBuild.patchSha256)
  for (const path of ['', '.', '/', 'relative', '/tmp/../target', '/tmp/target/'])
    expect(() => validateInstallDestination(path)).toThrow(
      'ACP_INSTALL_ABSOLUTE_NEW_DIRECTORY_REQUIRED'
    )
  expect(validateInstallDestination('/tmp/new-acp-runtime')).toBe('/tmp/new-acp-runtime')
})

test('ACP installer never overwrites a pre-existing installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-acp-install-preserve-'))
  try {
    await writeFile(join(directory, 'owner.txt'), 'existing user data')
    await expect(reserveInstallDirectory(directory)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(directory, 'owner.txt'), 'utf8')).toBe('existing user data')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ACP build isolates both user and global npm configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-acp-build-environment-'))
  try {
    const environment = await createAcpBuildEnvironment(join(directory, 'home'))
    expect(await readFile(environment.npm_config_globalconfig, 'utf8')).toBe('')
    expect(environment.npm_config_userconfig).toBe('/dev/null')
    expect(environment.HOME).toBe(join(directory, 'home'))
    expect(Object.keys(environment).toSorted()).toEqual(
      [
        'CI',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'PATH',
        'npm_config_cache',
        'npm_config_globalconfig',
        'npm_config_registry',
        'npm_config_userconfig',
      ].toSorted()
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
