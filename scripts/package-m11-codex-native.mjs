import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const linuxObjcopyVersion = 'GNU objcopy (GNU Binutils for Debian) 2.40'

export async function hashNativeFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Package a freshly built artifact; never modify the compiler output. */
export async function packageNativeExecutable({ source, destination, platform, run }) {
  if (!['linux', 'darwin'].includes(platform)) throw new Error('CODEX_NATIVE_PLATFORM_UNSUPPORTED')
  if (platform === 'linux') {
    const version = (await run('/usr/bin/objcopy', ['--version'], destination)).split('\n')[0]
    if (version !== linuxObjcopyVersion) throw new Error('CODEX_NATIVE_OBJCOPY_VERSION_MISMATCH')
  }
  await mkdir(join(destination, 'bin'), { mode: 0o700 })
  const executable = join(destination, 'bin/codex')
  if (platform === 'darwin') {
    await copyFile(source, executable)
    await chmod(executable, 0o700)
    return { method: 'copy', sourceSha256: await hashNativeFile(source) }
  }
  await mkdir(join(destination, 'symbols'), { mode: 0o700 })
  const symbols = join(destination, 'symbols/codex.debug')
  await run('/usr/bin/objcopy', ['--only-keep-debug', source, symbols], destination)
  await chmod(symbols, 0o600)
  await run('/usr/bin/objcopy', ['--strip-debug', source, executable], destination)
  await chmod(executable, 0o700)
  return {
    method: 'gnu-objcopy-strip-debug',
    toolVersion: linuxObjcopyVersion,
    sourceSha256: await hashNativeFile(source),
    symbols: 'symbols/codex.debug',
    symbolsSha256: await hashNativeFile(symbols),
  }
}
