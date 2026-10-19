import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPinnedCodexNativeBinary } from './native-installation.ts'
import { pinnedCodexNativeBuild } from './pinned-codex-build.ts'

function manifestFor(contents) {
  return {
    ...pinnedCodexNativeBuild,
    schemaVersion: 1,
    status: 'built',
    profile: 'release',
    platform: process.platform,
    arch: process.arch,
    executableSha256: createHash('sha256').update(contents).digest('hex'),
  }
}

// A broken blocking open must not strand the test runner or a libuv worker.
// spawnSync kills and reaps only this owned child when its deadline expires.
function verifyInBoundedChild(executable, manifest, directory) {
  const verifier = new URL('./native-installation.ts', import.meta.url).href
  const child = spawnSync(
    process.execPath,
    [
      '--eval',
      `import { verifyPinnedCodexNativeBinary } from ${JSON.stringify(verifier)};
       try {
         await verifyPinnedCodexNativeBinary(${JSON.stringify(executable)}, ${JSON.stringify(manifest)});
         console.log('accepted');
       } catch (error) { console.log(error.message); }`,
    ],
    {
      cwd: directory,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 2000,
      killSignal: 'SIGKILL',
    }
  )
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status).toBe(0)
  expect(child.stdout.trim()).toBe('CODEX_NATIVE_EXECUTABLE_INVALID')
}

test('native verification rejects directories, empty and oversized files before hashing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-invalid-'))
  const executable = join(directory, 'codex')
  const manifest = manifestFor('fixture')
  try {
    await mkdir(executable)
    await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toThrow(
      'CODEX_NATIVE_EXECUTABLE_INVALID'
    )
    await rm(executable, { recursive: true })
    await writeFile(executable, '')
    await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toThrow(
      'CODEX_NATIVE_EXECUTABLE_INVALID'
    )
    await truncate(executable, 512 * 1024 * 1024 + 1)
    await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toThrow(
      'CODEX_NATIVE_EXECUTABLE_INVALID'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native verification preserves missing-path error codes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-missing-'))
  try {
    await expect(
      verifyPinnedCodexNativeBinary(join(directory, 'absent'), manifestFor('fixture'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Windows symlink creation can require privileges and POSIX FIFOs do not exist there.
test.skipIf(process.platform === 'win32')(
  'native verification follows symlinks and hashes the regular-file target',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-symlink-'))
    const target = join(directory, 'target')
    const executable = join(directory, 'codex')
    const contents = Buffer.alloc(128 * 1024, 0x61)
    const manifest = manifestFor(contents)
    try {
      await writeFile(target, contents)
      await symlink(target, executable)
      await expect(verifyPinnedCodexNativeBinary(executable, manifest)).resolves.toBeUndefined()
      await writeFile(target, 'replacement')
      await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toThrow(
        'CODEX_NATIVE_EXECUTABLE_MISMATCH'
      )
      await rm(target)
      await mkdir(target)
      await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toThrow(
        'CODEX_NATIVE_EXECUTABLE_INVALID'
      )
      await rm(target, { recursive: true })
      await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test.skipIf(process.platform === 'win32')(
  'native verification rejects FIFOs and symlinks to FIFOs without a writer',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-fifo-'))
    const fifo = join(directory, 'fifo')
    const executable = join(directory, 'codex')
    try {
      const creation = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
      expect(creation.error).toBeUndefined()
      expect(creation.status).toBe(0)
      const manifest = manifestFor('fixture')
      verifyInBoundedChild(fifo, manifest, directory)
      await symlink(fifo, executable)
      verifyInBoundedChild(executable, manifest, directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  10000
)

test('native launch verification rejects stale provenance and changed binary bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-native-artifact-'))
  const executable = join(directory, 'codex')
  const contents = Buffer.from('non-executable verification fixture')
  const manifest = {
    ...pinnedCodexNativeBuild,
    schemaVersion: 1,
    status: 'built',
    profile: 'release',
    platform: process.platform,
    arch: process.arch,
    executableSha256: createHash('sha256').update(contents).digest('hex'),
  }
  try {
    await writeFile(executable, contents)
    await expect(verifyPinnedCodexNativeBinary(executable, manifest)).resolves.toBeUndefined()
    for (const changed of [
      { ...manifest, commit: 'wrong' },
      { ...manifest, patchSha256: 'wrong' },
      { ...manifest, arch: 'wrong' },
      { ...manifest, profile: 'debug' },
      { ...manifest, status: 'pending' },
      { ...manifest, executableSha256: 'wrong' },
      null,
    ]) {
      await expect(verifyPinnedCodexNativeBinary(executable, changed)).rejects.toThrow(
        'CODEX_NATIVE_MANIFEST_MISMATCH'
      )
    }
    await writeFile(executable, 'changed')
    await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toThrow(
      'CODEX_NATIVE_EXECUTABLE_MISMATCH'
    )
    await writeFile(executable, '')
    await expect(verifyPinnedCodexNativeBinary(executable, manifest)).rejects.toThrow(
      'CODEX_NATIVE_EXECUTABLE_INVALID'
    )
    await expect(verifyPinnedCodexNativeBinary('relative', manifest)).rejects.toThrow(
      'CODEX_NATIVE_ABSOLUTE_PATH_REQUIRED'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
