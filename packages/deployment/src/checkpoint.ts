import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const MANIFEST_NAME = '.control-plane-checkpoint.json'

export type FilesystemCheckpointProfile = 'local' | 'hosted-simple'

export interface FilesystemCheckpointEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly mode: number
  readonly size?: number
  readonly sha256?: `sha256:${string}`
}

export interface FilesystemCheckpointManifest {
  readonly schemaVersion: 1
  readonly profile: FilesystemCheckpointProfile
  readonly entries: readonly FilesystemCheckpointEntry[]
  readonly contentDigest: `sha256:${string}`
}

export class FilesystemCheckpointError extends Error {
  constructor(readonly code: string) {
    super('Control Plane filesystem checkpoint failed')
    this.name = 'FilesystemCheckpointError'
  }
}

export async function createFilesystemCheckpoint(options: {
  readonly sourceDirectory: string
  readonly destinationDirectory: string
  readonly profile: FilesystemCheckpointProfile
}): Promise<FilesystemCheckpointManifest> {
  const source = resolve(options.sourceDirectory)
  const destination = resolve(options.destinationDirectory)
  assertSeparatePaths(source, destination)
  if (!(await stat(source).catch(() => undefined))?.isDirectory()) {
    throw new FilesystemCheckpointError('CHECKPOINT_SOURCE_INVALID')
  }
  if (await exists(destination))
    throw new FilesystemCheckpointError('CHECKPOINT_DESTINATION_EXISTS')
  const entries = await inventory(source)
  const manifest = finalizeManifest(options.profile, entries)
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await mkdir(temporary, { mode: 0o700 })
    await copyEntries(source, temporary, entries)
    await writeFile(join(temporary, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    await verifyFilesystemCheckpoint(temporary)
    await rename(temporary, destination)
    return manifest
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function verifyFilesystemCheckpoint(
  checkpointDirectory: string
): Promise<FilesystemCheckpointManifest> {
  const checkpoint = resolve(checkpointDirectory)
  const manifest = parseManifest(await readFile(join(checkpoint, MANIFEST_NAME), 'utf8'))
  const entries = await inventory(checkpoint, new Set([MANIFEST_NAME]))
  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)) {
    throw new FilesystemCheckpointError('CHECKPOINT_CONTENT_MISMATCH')
  }
  const expected = finalizeManifest(manifest.profile, entries)
  if (expected.contentDigest !== manifest.contentDigest) {
    throw new FilesystemCheckpointError('CHECKPOINT_DIGEST_MISMATCH')
  }
  return manifest
}

export async function restoreFilesystemCheckpoint(options: {
  readonly checkpointDirectory: string
  readonly destinationDirectory: string
}): Promise<FilesystemCheckpointManifest> {
  const checkpoint = resolve(options.checkpointDirectory)
  const destination = resolve(options.destinationDirectory)
  assertSeparatePaths(checkpoint, destination)
  if (await exists(destination))
    throw new FilesystemCheckpointError('CHECKPOINT_DESTINATION_EXISTS')
  const manifest = await verifyFilesystemCheckpoint(checkpoint)
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await mkdir(temporary, { mode: 0o700 })
    await copyEntries(checkpoint, temporary, manifest.entries)
    await assertInventoryMatches(temporary, manifest.entries)
    await rename(temporary, destination)
    return manifest
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function inventory(
  root: string,
  excluded: ReadonlySet<string> = new Set()
): Promise<FilesystemCheckpointEntry[]> {
  const entries: FilesystemCheckpointEntry[] = []
  async function visit(directory: string): Promise<void> {
    const children = (await readdir(directory)).toSorted()
    for (const name of children) {
      const path = join(directory, name)
      const logicalPath = relative(root, path)
      if (excluded.has(logicalPath)) continue
      const metadata = await lstat(path)
      const mode = metadata.mode & 0o777
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new FilesystemCheckpointError('CHECKPOINT_UNSUPPORTED_ENTRY')
      }
      if (metadata.isDirectory()) {
        entries.push({ path: logicalPath, kind: 'directory', mode })
        await visit(path)
      } else {
        entries.push({
          path: logicalPath,
          kind: 'file',
          mode,
          size: metadata.size,
          sha256: digest(await readFile(path)),
        })
      }
    }
  }
  await visit(root)
  return entries
}

async function copyEntries(
  source: string,
  destination: string,
  entries: readonly FilesystemCheckpointEntry[]
): Promise<void> {
  for (const entry of entries) {
    const sourcePath = join(source, entry.path)
    const destinationPath = join(destination, entry.path)
    if (entry.kind === 'directory') {
      await mkdir(destinationPath, { recursive: true, mode: entry.mode })
      await chmod(destinationPath, entry.mode)
    } else {
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })
      await copyFile(sourcePath, destinationPath)
      await chmod(destinationPath, entry.mode)
    }
  }
}

async function assertInventoryMatches(
  root: string,
  expected: readonly FilesystemCheckpointEntry[]
): Promise<void> {
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(expected)) {
    throw new FilesystemCheckpointError('CHECKPOINT_CONTENT_MISMATCH')
  }
}

function finalizeManifest(
  profile: FilesystemCheckpointProfile,
  entries: readonly FilesystemCheckpointEntry[]
): FilesystemCheckpointManifest {
  const canonical = JSON.stringify({ schemaVersion: 1, profile, entries })
  return { schemaVersion: 1, profile, entries, contentDigest: digest(canonical) }
}

function parseManifest(value: string): FilesystemCheckpointManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new FilesystemCheckpointError('CHECKPOINT_MANIFEST_INVALID')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new FilesystemCheckpointError('CHECKPOINT_MANIFEST_INVALID')
  }
  const candidate = parsed as Partial<FilesystemCheckpointManifest>
  if (
    candidate.schemaVersion !== 1 ||
    (candidate.profile !== 'local' && candidate.profile !== 'hosted-simple') ||
    !Array.isArray(candidate.entries) ||
    typeof candidate.contentDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(candidate.contentDigest)
  ) {
    throw new FilesystemCheckpointError('CHECKPOINT_MANIFEST_INVALID')
  }
  return candidate as FilesystemCheckpointManifest
}

function assertSeparatePaths(source: string, destination: string): void {
  if (
    source === destination ||
    destination.startsWith(`${source}${sep}`) ||
    source.startsWith(`${destination}${sep}`)
  ) {
    throw new FilesystemCheckpointError('CHECKPOINT_PATH_OVERLAP')
  }
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
