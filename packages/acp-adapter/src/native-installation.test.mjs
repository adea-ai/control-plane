import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPinnedCodexNativeBinary } from './native-installation.ts'
import { pinnedCodexNativeBuild } from './pinned-codex-build.ts'

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
