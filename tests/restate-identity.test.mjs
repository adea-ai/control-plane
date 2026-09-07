import { test, expect } from 'bun:test'
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionRestateIdentity } from '../scripts/provision-restate-identity.mjs'

test('Restate provisioning preserves an existing private identity and rejects unsafe files', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'restate-identity-test-')))
  const path = join(directory, 'request-identity-private.pem')
  try {
    const publicKey = await provisionRestateIdentity(directory)
    const original = await readFile(path)
    expect(publicKey).toMatch(/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await provisionRestateIdentity(directory)).toBe(publicKey)
    expect(await readFile(path)).toEqual(original)
    await chmod(path, 0o644)
    await expect(provisionRestateIdentity(directory)).rejects.toThrow('FILE_MUST_BE_PRIVATE')
    await rm(path)
    await symlink('/nonexistent-restate-key', path)
    await expect(provisionRestateIdentity(directory)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
