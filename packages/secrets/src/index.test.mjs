import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import {
  CompositeSecretsProvider,
  EnvironmentSecretsProvider,
  HostSecureHandleSecretsProvider,
  PrivateFileSecretsProvider,
} from './index.ts'

const providers = []
const temporaryRoots = []
afterEach(async () => {
  await Promise.all(providers.splice(0).map(async (provider) => provider.close()))
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })))
})

describe('Local and Hosted secrets providers', () => {
  test('resolves only explicitly mapped environment references and zeroizes leases', async () => {
    const provider = new EnvironmentSecretsProvider({
      references: { model: 'MODEL_TOKEN' },
      environment: { MODEL_TOKEN: 'secret-canary' },
    })
    providers.push(provider)
    const lease = await provider.resolve({ provider: 'env', key: 'model' }, { purpose: 'model' })
    expect(new TextDecoder().decode(lease.value)).toBe('secret-canary')
    expect(JSON.stringify(lease)).not.toContain('secret-canary')
    lease.close()
    expect(lease.value.every((value) => value === 0)).toBe(true)
    await expect(
      provider.resolve({ provider: 'env', key: 'unmapped' }, { purpose: 'model' })
    ).rejects.toMatchObject({ code: 'SECRET_REFERENCE_INVALID' })
  })

  test('accepts owner-only private files and rejects unsafe modes and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-secrets-'))
    temporaryRoots.push(root)
    await chmod(root, 0o700)
    await writeFile(join(root, 'safe'), 'private', { mode: 0o600 })
    await writeFile(join(root, 'open'), 'unsafe', { mode: 0o644 })
    await symlink(join(root, 'safe'), join(root, 'link'))
    const provider = new PrivateFileSecretsProvider({ rootDirectory: root })
    providers.push(provider)

    const secret = await provider.resolve({ provider: 'file', key: 'safe' }, { purpose: 'test' })
    expect(new TextDecoder().decode(secret.value)).toBe('private')
    secret.close()
    await expect(
      provider.resolve({ provider: 'file', key: 'open' }, { purpose: 'test' })
    ).rejects.toMatchObject({ code: 'SECRET_FILE_UNSAFE' })
    await expect(
      provider.resolve({ provider: 'file', key: 'link' }, { purpose: 'test' })
    ).rejects.toMatchObject({ code: 'SECRET_FILE_UNSAFE' })
  })

  test('accepts a secret at the byte limit and rejects an oversized file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-secrets-bounds-'))
    temporaryRoots.push(root)
    await chmod(root, 0o700)
    await writeFile(join(root, 'at-limit'), new Uint8Array(64 * 1024).fill(0x61), { mode: 0o600 })
    await writeFile(join(root, 'over-limit'), new Uint8Array(64 * 1024 + 1).fill(0x62), {
      mode: 0o600,
    })
    const provider = new PrivateFileSecretsProvider({ rootDirectory: root })
    providers.push(provider)

    const probe = await open(join(root, 'at-limit'), 'r')
    const fileHandlePrototype = Object.getPrototypeOf(probe)
    await probe.close()
    const originalRead = fileHandlePrototype.read
    const originalClose = fileHandlePrototype.close
    const readLengths = []
    let closeCalls = 0
    fileHandlePrototype.read = function (...args) {
      readLengths.push(args[2])
      return originalRead.apply(this, args)
    }
    fileHandlePrototype.close = function (...args) {
      closeCalls += 1
      return originalClose.apply(this, args)
    }
    try {
      const secret = await provider.resolve(
        { provider: 'file', key: 'at-limit' },
        { purpose: 'test' }
      )
      expect(secret.value.byteLength).toBe(64 * 1024)
      expect(secret.value.every((byte) => byte === 0x61)).toBe(true)
      expect(readLengths.length).toBeGreaterThan(0)
      expect(readLengths.every((length) => length <= 64 * 1024 + 1)).toBe(true)
      expect(closeCalls).toBe(1)
      secret.close()

      readLengths.length = 0
      closeCalls = 0
      await expect(
        provider.resolve({ provider: 'file', key: 'over-limit' }, { purpose: 'test' })
      ).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' })
      expect(readLengths).toEqual([])
      expect(closeCalls).toBe(1)
    } finally {
      fileHandlePrototype.read = originalRead
      fileHandlePrototype.close = originalClose
    }
  })

  test('rejects growth after descriptor stat without reading beyond the bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-secrets-growth-'))
    temporaryRoots.push(root)
    await chmod(root, 0o700)
    const growingPath = join(root, 'growing')
    await writeFile(growingPath, new Uint8Array(64 * 1024).fill(0x61), { mode: 0o600 })
    const provider = new PrivateFileSecretsProvider({ rootDirectory: root })
    providers.push(provider)

    const probe = await open(growingPath, 'r')
    const fileHandlePrototype = Object.getPrototypeOf(probe)
    await probe.close()
    const originalStat = fileHandlePrototype.stat
    const originalRead = fileHandlePrototype.read
    const originalClose = fileHandlePrototype.close
    let statCaptured = false
    let bytesRead = 0
    let closeCalls = 0
    fileHandlePrototype.stat = async function (...args) {
      const stats = await originalStat.apply(this, args)
      expect(stats.size).toBe(64 * 1024)
      await writeFile(growingPath, new Uint8Array([0x62]), { flag: 'a' })
      statCaptured = true
      return stats
    }
    fileHandlePrototype.read = async function (...args) {
      const result = await originalRead.apply(this, args)
      bytesRead += result.bytesRead
      return result
    }
    fileHandlePrototype.close = function (...args) {
      closeCalls += 1
      return originalClose.apply(this, args)
    }
    try {
      await expect(
        provider.resolve({ provider: 'file', key: 'growing' }, { purpose: 'test' })
      ).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' })
      expect(statCaptured).toBe(true)
      expect(bytesRead).toBe(64 * 1024 + 1)
      expect(bytesRead).toBeLessThanOrEqual(64 * 1024 + 1)
      expect(closeCalls).toBe(1)
    } finally {
      fileHandlePrototype.stat = originalStat
      fileHandlePrototype.read = originalRead
      fileHandlePrototype.close = originalClose
    }
  })

  test('delegates opaque host handles with bounded use context', async () => {
    const uses = []
    const provider = new HostSecureHandleSecretsProvider({
      resolve: async (handle, use) => {
        uses.push([handle, use])
        return new TextEncoder().encode('host-secret')
      },
      health: async () => true,
      close: () => undefined,
    })
    providers.push(provider)
    const use = { purpose: 'provider-auth', workspaceId: 'workspace-1', operation: 'invoke' }
    const secret = await provider.resolve({ provider: 'host-secure', key: 'handle-1' }, use)
    expect(uses).toEqual([['handle-1', use]])
    secret.close()
  })

  test('routes by provider without exposing unsupported references', async () => {
    const environment = new EnvironmentSecretsProvider({
      references: { key: 'KEY' },
      environment: { KEY: 'value' },
    })
    const composite = new CompositeSecretsProvider({ env: environment })
    providers.push(composite)
    expect(await composite.health()).toMatchObject({ ready: true, details: { providers: 1 } })
    await expect(
      composite.resolve({ provider: 'unknown', key: 'key' }, { purpose: 'test' })
    ).rejects.toMatchObject({ code: 'SECRET_PROVIDER_UNSUPPORTED' })
  })
})
