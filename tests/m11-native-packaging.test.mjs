import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashNativeFile,
  linuxObjcopyVersion,
  packageNativeExecutable,
} from '../scripts/package-m11-codex-native.mjs'

test('Linux packaging keeps source and symbols and records the pinned transformation', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'm11-native-packaging-'))
  const source = join(destination, 'compiler-output')
  const calls = []
  const run = async (command, args) => {
    expect(command).toBe('/usr/bin/objcopy')
    calls.push(args[0])
    if (args[0] === '--version') return linuxObjcopyVersion
    expect(args[1]).toBe(source)
    await writeFile(args[2], args[0] === '--only-keep-debug' ? 'debug symbols' : 'executable')
    return ''
  }
  try {
    await writeFile(source, 'original compiler output')
    const packaging = await packageNativeExecutable({ source, destination, platform: 'linux', run })
    expect(calls).toEqual(['--version', '--only-keep-debug', '--strip-debug'])
    expect(await readFile(source, 'utf8')).toBe('original compiler output')
    expect(packaging).toEqual({
      method: 'gnu-objcopy-strip-debug',
      toolVersion: linuxObjcopyVersion,
      sourceSha256: await hashNativeFile(source),
      symbols: 'symbols/codex.debug',
      symbolsSha256: await hashNativeFile(join(destination, 'symbols/codex.debug')),
    })
    expect((await stat(join(destination, 'bin/codex'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(destination, 'symbols/codex.debug'))).mode & 0o777).toBe(0o600)
    await expect(
      packageNativeExecutable({ source, destination, platform: 'linux', run })
    ).rejects.toMatchObject({ code: 'EEXIST' })
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
})

test('packaging refuses an unpinned objcopy before creating artifacts', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'm11-native-packaging-version-'))
  try {
    await expect(
      packageNativeExecutable({
        source: join(destination, 'absent'),
        destination,
        platform: 'linux',
        run: async () => 'unreviewed tool',
      })
    ).rejects.toThrow('CODEX_NATIVE_OBJCOPY_VERSION_MISMATCH')
    await expect(stat(join(destination, 'bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
})

test('macOS packaging preserves the existing executable bytes without objcopy', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'm11-native-packaging-macos-'))
  const source = join(destination, 'compiler-output')
  try {
    await writeFile(source, 'macOS executable')
    const packaging = await packageNativeExecutable({
      source,
      destination,
      platform: 'darwin',
      run: async () => {
        throw new Error('unexpected tool')
      },
    })
    expect(packaging.method).toBe('copy')
    expect(await hashNativeFile(join(destination, 'bin/codex'))).toBe(packaging.sourceSha256)
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
})
