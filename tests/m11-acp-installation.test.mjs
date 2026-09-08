import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reserveInstallDirectory,
  pinnedAcpBuild,
  validateInstallDestination,
} from '../scripts/install-m11-codex-acp.mjs'

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
