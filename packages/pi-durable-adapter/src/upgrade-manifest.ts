import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PiDurableVersion } from './contracts.js'

const StorePathSchema = z.union([
  z.string().regex(/^authority\.sqlite(?:-(?:wal|shm))?$/),
  z.string().regex(/^sessions\/[a-f0-9]{64}\.sqlite(?:-(?:wal|shm))?$/),
])
const ManifestSchema = z.strictObject({
  schemaVersion: z.literal('pi-local-upgrade-manifest/v1'),
  version: z.strictObject({
    runtime: z.literal(PiDurableVersion.runtime),
    journal: z.literal(PiDurableVersion.journal),
    adapter: z.literal(PiDurableVersion.adapter),
  }),
  files: z
    .array(
      z.strictObject({
        path: StorePathSchema,
        bytes: z.number().int().nonnegative().safe(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
    )
    .min(1),
})

export type PiDurableLocalUpgradeManifest = z.infer<typeof ManifestSchema>

/** Read only after the composition's fenced close has finished. Not restore-generation evidence. */
export async function createPiDurableLocalUpgradeManifest(
  directory: string
): Promise<PiDurableLocalUpgradeManifest> {
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('PI_UPGRADE_STORE_PATH_INVALID')
  const rootEntries = await readdir(directory)
  const paths = rootEntries.filter((name) => name.startsWith('authority.sqlite'))
  if (
    !paths.includes('authority.sqlite') ||
    paths.some((name) => !/^authority\.sqlite(?:-(?:wal|shm))?$/.test(name))
  )
    throw new Error('PI_UPGRADE_STORE_PATH_INVALID')
  if (rootEntries.includes('sessions')) {
    const sessionDirectory = join(directory, 'sessions')
    if (!(await lstat(sessionDirectory)).isDirectory())
      throw new Error('PI_UPGRADE_STORE_PATH_INVALID')
    const names = await readdir(sessionDirectory)
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.sqlite(?:-(?:wal|shm))?$/.test(name))
        throw new Error('PI_UPGRADE_STORE_PATH_INVALID')
      paths.push(`sessions/${name}`)
    }
  }
  const files = []
  for (const path of paths.toSorted()) {
    const absolute = join(directory, path)
    const stat = await lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PI_UPGRADE_STORE_PATH_INVALID')
    const bytes = await readFile(absolute)
    files.push({
      path,
      bytes: bytes.byteLength,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    })
  }
  return ManifestSchema.parse({
    schemaVersion: 'pi-local-upgrade-manifest/v1',
    version: PiDurableVersion,
    files,
  })
}

/** Byte-identical same-version local reopen check; it grants no execution or restore authority. */
export async function verifyPiDurableLocalUpgradeManifest(
  directory: string,
  expected: PiDurableLocalUpgradeManifest
): Promise<void> {
  const parsed = ManifestSchema.parse(expected)
  const actual = await createPiDurableLocalUpgradeManifest(directory)
  if (JSON.stringify(actual) !== JSON.stringify(parsed))
    throw new Error('PI_UPGRADE_STORE_MANIFEST_MISMATCH')
}
