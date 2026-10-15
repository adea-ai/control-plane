import { describe, expect, test } from 'bun:test'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFilesystemCheckpoint,
  restoreFilesystemCheckpoint,
  verifyFilesystemCheckpoint,
} from './checkpoint.ts'

describe('filesystem checkpoints', () => {
  test('verifies and restores the historical schema-v1 checkpoint fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-checkpoint-v1-'))
    const checkpoint = join(root, 'checkpoint')
    const restored = join(root, 'restored')
    try {
      await mkdir(checkpoint, { mode: 0o700 })
      await copyFile(
        new URL('../fixtures/checkpoint-v1/state.db', import.meta.url),
        join(checkpoint, 'state.db')
      )
      await chmod(join(checkpoint, 'state.db'), 0o600)
      await copyFile(
        new URL('../fixtures/checkpoint-v1/.control-plane-checkpoint.json', import.meta.url),
        join(checkpoint, '.control-plane-checkpoint.json')
      )

      const verified = await verifyFilesystemCheckpoint(checkpoint)
      expect(verified).toMatchObject({
        schemaVersion: 1,
        profile: 'local',
        contentDigest: 'sha256:8807a8a38d8d52550b6435cf13d08879ce472f303d6ad14773c3bd057913b2dd',
      })
      await restoreFilesystemCheckpoint({
        checkpointDirectory: checkpoint,
        destinationDirectory: restored,
      })
      expect(await readFile(join(restored, 'state.db'), 'utf8')).toBe('checkpoint-v1\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps checkpoint v1 key-order and malformed-version behavior explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-checkpoint-v1-order-'))
    const checkpoint = join(root, 'checkpoint')
    const manifestPath = join(checkpoint, '.control-plane-checkpoint.json')
    try {
      await mkdir(checkpoint, { mode: 0o700 })
      await copyFile(
        new URL('../fixtures/checkpoint-v1/state.db', import.meta.url),
        join(checkpoint, 'state.db')
      )
      await chmod(join(checkpoint, 'state.db'), 0o600)
      const fixtureBytes = await readFile(
        new URL('../fixtures/checkpoint-v1/.control-plane-checkpoint.json', import.meta.url),
        'utf8'
      )
      const fixtureManifest = JSON.parse(fixtureBytes)

      const reorderedTopLevel = {
        contentDigest: fixtureManifest.contentDigest,
        entries: fixtureManifest.entries,
        profile: fixtureManifest.profile,
        schemaVersion: fixtureManifest.schemaVersion,
      }
      await writeFile(manifestPath, `${JSON.stringify(reorderedTopLevel, null, 2)}\n`)
      await expect(verifyFilesystemCheckpoint(checkpoint)).resolves.toMatchObject({
        contentDigest: 'sha256:8807a8a38d8d52550b6435cf13d08879ce472f303d6ad14773c3bd057913b2dd',
      })

      const [entry] = fixtureManifest.entries
      fixtureManifest.entries = [
        {
          sha256: entry.sha256,
          size: entry.size,
          mode: entry.mode,
          kind: entry.kind,
          path: entry.path,
        },
      ]
      await writeFile(manifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`)
      await expect(verifyFilesystemCheckpoint(checkpoint)).rejects.toMatchObject({
        code: 'CHECKPOINT_CONTENT_MISMATCH',
      })

      fixtureManifest.schemaVersion = 2
      fixtureManifest.entries = JSON.parse(fixtureBytes).entries
      await writeFile(manifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`)
      await expect(verifyFilesystemCheckpoint(checkpoint)).rejects.toMatchObject({
        code: 'CHECKPOINT_MANIFEST_INVALID',
      })

      await writeFile(manifestPath, '{"schemaVersion":')
      await expect(verifyFilesystemCheckpoint(checkpoint)).rejects.toMatchObject({
        code: 'CHECKPOINT_MANIFEST_INVALID',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('creates, verifies, and restores an owner-controlled Local checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-checkpoint-'))
    const source = join(root, 'source')
    const checkpoint = join(root, 'checkpoint')
    const restored = join(root, 'restored')
    try {
      await mkdir(join(source, 'artifacts'), { recursive: true, mode: 0o700 })
      await writeFile(join(source, 'control-plane.sqlite'), 'sqlite-state', { mode: 0o600 })
      await writeFile(join(source, 'artifacts', 'result.bin'), 'artifact', { mode: 0o600 })
      const created = await createFilesystemCheckpoint({
        sourceDirectory: source,
        destinationDirectory: checkpoint,
        profile: 'local',
      })
      expect(created).toMatchObject({ schemaVersion: 1, profile: 'local' })
      expect(await verifyFilesystemCheckpoint(checkpoint)).toEqual(created)
      expect(
        await restoreFilesystemCheckpoint({
          checkpointDirectory: checkpoint,
          destinationDirectory: restored,
        })
      ).toEqual(created)
      expect(await readFile(join(restored, 'control-plane.sqlite'), 'utf8')).toBe('sqlite-state')
      expect(await readFile(join(restored, 'artifacts', 'result.bin'), 'utf8')).toBe('artifact')
      await expect(readFile(join(restored, '.control-plane-checkpoint.json'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects tampering, symlinks, and overlapping destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-checkpoint-reject-'))
    const source = join(root, 'source')
    const checkpoint = join(root, 'checkpoint')
    try {
      await mkdir(source, { mode: 0o700 })
      await writeFile(join(source, 'control-plane.sqlite'), 'sqlite-state', { mode: 0o600 })
      await expect(
        createFilesystemCheckpoint({
          sourceDirectory: source,
          destinationDirectory: join(source, 'nested'),
          profile: 'local',
        })
      ).rejects.toMatchObject({ code: 'CHECKPOINT_PATH_OVERLAP' })
      await symlink(join(source, 'control-plane.sqlite'), join(source, 'state-link'))
      await expect(
        createFilesystemCheckpoint({
          sourceDirectory: source,
          destinationDirectory: checkpoint,
          profile: 'local',
        })
      ).rejects.toMatchObject({ code: 'CHECKPOINT_UNSUPPORTED_ENTRY' })
      await rm(join(source, 'state-link'))
      await createFilesystemCheckpoint({
        sourceDirectory: source,
        destinationDirectory: checkpoint,
        profile: 'local',
      })
      await chmod(join(checkpoint, 'control-plane.sqlite'), 0o600)
      await writeFile(join(checkpoint, 'control-plane.sqlite'), 'tampered')
      await expect(verifyFilesystemCheckpoint(checkpoint)).rejects.toMatchObject({
        code: 'CHECKPOINT_CONTENT_MISMATCH',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
