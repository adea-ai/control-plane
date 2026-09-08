import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pinnedCodexNativeBuild } from './pinned-codex-build.ts'

const maximumNativeBytes = 512 * 1024 * 1024

/** Verify an owner-protected build receipt and detect native artifact replacement. */
export async function verifyPinnedCodexNativeBinary(
  executable: string,
  manifestInput: unknown
): Promise<void> {
  if (!isAbsolute(executable)) throw new Error('CODEX_NATIVE_ABSOLUTE_PATH_REQUIRED')
  if (!manifestInput || typeof manifestInput !== 'object' || Array.isArray(manifestInput))
    throw new Error('CODEX_NATIVE_MANIFEST_MISMATCH')
  const manifest = manifestInput as Record<string, unknown>
  if (
    manifest['schemaVersion'] !== 1 ||
    manifest['status'] !== 'built' ||
    manifest['profile'] !== 'release' ||
    manifest['platform'] !== process.platform ||
    manifest['arch'] !== process.arch ||
    typeof manifest['executableSha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest['executableSha256'])
  )
    throw new Error('CODEX_NATIVE_MANIFEST_MISMATCH')
  for (const [key, value] of Object.entries(pinnedCodexNativeBuild)) {
    if (manifest[key] !== value) throw new Error('CODEX_NATIVE_MANIFEST_MISMATCH')
  }
  const file = await open(executable, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumNativeBytes)
      throw new Error('CODEX_NATIVE_EXECUTABLE_INVALID')
    const hash = createHash('sha256')
    let bytes = 0
    // Read and hash the same opened file; an expanding file cannot create unbounded work.
    for await (const chunk of file.createReadStream({
      start: 0,
      end: maximumNativeBytes,
      autoClose: false,
    })) {
      bytes += chunk.length
      if (bytes > maximumNativeBytes) throw new Error('CODEX_NATIVE_EXECUTABLE_INVALID')
      hash.update(chunk)
    }
    if (bytes !== metadata.size || hash.digest('hex') !== manifest['executableSha256'])
      throw new Error('CODEX_NATIVE_EXECUTABLE_MISMATCH')
  } finally {
    await file.close()
  }
}
