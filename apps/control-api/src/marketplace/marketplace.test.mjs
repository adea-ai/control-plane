import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { TextEncoder } from 'node:util'
import { createControlApiApplication } from '../application.ts'
import { createInternalServicePrincipal } from '../auth/service-authentication.ts'
import { GithubReleaseVerifier } from './github-release-verifier.ts'
import {
  InMemoryMarketplaceInstallationRepository,
  MarketplaceInstallationService,
} from './installation.ts'
import { MarketplaceRegistryService, bytesDigest, digest, verifyArtifacts } from './registry.ts'

const ids = {
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
}

function pluginFixture() {
  const release = {
    canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
    contentResolution: 'complete',
    fileIndex: [],
    pluginId: 'plugin:openai-official:gmail',
    pluginSubdirectory: 'plugins/gmail',
    releaseId: `release:${'c'.repeat(64)}`,
    requiredConnectors: [],
    requiredCredentials: [],
    resolvedCommitSha: 'a'.repeat(40),
    resolvedRepositoryUrl: 'https://github.com/openai/plugins',
  }
  return {
    availableReleases: [release],
    currentReleaseId: release.releaseId,
    harnessCompatibility: { codex: { status: 'portable' } },
    pluginId: release.pluginId,
    provenance: {},
    securityClassification: { level: 'low' },
    sourceId: 'openai-official',
    ...release,
  }
}

function snapshotFixture() {
  const plugin = pluginFixture()
  const body = {
    generatedAt: '2026-08-31T00:00:00.000Z',
    plugins: [plugin],
    schemaVersion: 1,
    sources: [{ sourceId: 'openai-official' }],
  }
  const catalogId = `catalog:${digest(body).slice('sha256:'.length)}`
  const catalog = { ...body, catalogId }
  const catalogText = JSON.stringify(catalog)
  const summaryText = JSON.stringify({ catalogId, pluginCount: 1, schemaVersion: 1 })
  const categoriesText = JSON.stringify({ categories: [], catalogId, schemaVersion: 1 })
  const compatibilityText = JSON.stringify({ catalogId, plugins: [], schemaVersion: 1 })
  const lockText = JSON.stringify({ catalogId, schemaVersion: 1, sources: [] })
  const files = {
    'catalog.v1.json': catalogText,
    'catalog-summary.v1.json': summaryText,
    'categories.v1.json': categoriesText,
    'compatibility.v1.json': compatibilityText,
    'sources.lock.json': lockText,
  }
  const integrity = Object.fromEntries(
    Object.entries(files).map(([name, value]) => [name, digest(value)])
  )
  const artifacts = {
    ...files,
    'catalog-latest.v1.json': catalogText,
    'integrity.json': JSON.stringify({ catalogId, files: integrity, schemaVersion: 1 }),
  }
  return {
    artifacts,
    catalog,
    snapshot: { artifacts, catalog, catalogId, releaseId: catalogId, state: 'ready' },
  }
}

const serviceAuthenticator = {
  authenticate: async () =>
    createInternalServicePrincipal({
      principalId: 'svc_agent-hq',
      scopes: ['marketplace:read', 'marketplace:install'],
      workspaceIds: [ids.workspaceId],
    }),
}

const applicationDefaults = {
  health: () => ({ metadata: {}, status: 'ok' }),
  logger: { write: () => undefined },
  metadata: {
    serviceName: 'control-api',
    version: 'test',
    commitSha: 'test',
    environment: 'test',
    instanceId: 'test',
  },
  readiness: () => ({ metadata: {}, status: 'ready' }),
  serviceAuthenticator,
}

describe('Control Plane marketplace contract', () => {
  test('verifies an immutable artifact set and preserves raw artifacts', () => {
    const fixture = snapshotFixture()
    const verified = verifyArtifacts(fixture.artifacts)
    expect(verified.catalogId).toBe(fixture.catalog.catalogId)
    expect(verified.artifacts['catalog-latest.v1.json']).toBe(verified.artifacts['catalog.v1.json'])
  })

  test('keeps the last-known-good registry snapshot after a failed refresh', async () => {
    const fixture = snapshotFixture()
    let fail = false
    const registry = new MarketplaceRegistryService({
      fetchImpl: async (input) => {
        if (fail) return new globalThis.Response('not json', { status: 500 })
        const url = String(input)
        const name = url.split('/').at(-1)
        return new globalThis.Response(fixture.artifacts[name] ?? '', { status: 200 })
      },
      latestUrl: 'https://registry.example/releases/latest/download/catalog-latest.v1.json',
      immutableReleaseBaseUrl: 'https://registry.example/releases/{catalogId}',
    })
    expect((await registry.getCatalog()).catalogId).toBe(fixture.catalog.catalogId)
    fail = true
    expect((await registry.getCatalog()).state).toBe('stale')
  })

  test('rejects the apollo-skills symlink escape and traversal paths', async () => {
    const plugin = pluginFixture()
    const release = {
      ...plugin.availableReleases[0],
      fileIndex: ['CLAUDE.md'],
      pluginSubdirectory: 'plugins/apollo-skills',
      resolvedCommitSha: 'd'.repeat(40),
    }
    const verifier = new GithubReleaseVerifier({
      fetchImpl: async () =>
        globalThis.Response.json({
          tree: [
            {
              mode: '120000',
              path: 'plugins/apollo-skills/.github/skills/skill-creator',
              sha: 'e'.repeat(40),
              type: 'blob',
            },
          ],
        }),
    })
    expect(await verifier.verify({ plugin, release })).toBe(false)

    const traversalVerifier = new GithubReleaseVerifier({
      fetchImpl: async () =>
        globalThis.Response.json({
          tree: [
            {
              mode: '100644',
              path: 'plugins/apollo-skills/../../CLAUDE.md',
              sha: 'e'.repeat(40),
              type: 'blob',
            },
          ],
        }),
    })
    expect(await traversalVerifier.verify({ plugin, release })).toBe(false)
  })

  test('verifies root and nested plugin trees while ignoring directory entries', async () => {
    const content = new TextEncoder().encode('hello marketplace')
    const canonicalContentDigest = bytesDigest(new Map([['README.md', content]]))
    const plugin = pluginFixture()
    const release = {
      ...plugin.availableReleases[0],
      canonicalContentDigest,
      fileIndex: ['README.md'],
      pluginSubdirectory: '.',
      resolvedCommitSha: 'f'.repeat(40),
    }
    const verifier = new GithubReleaseVerifier({
      fetchImpl: async (input) => {
        if (String(input).includes('/git/trees/'))
          return globalThis.Response.json({
            tree: [
              { path: 'plugins', type: 'tree' },
              { mode: '100644', path: 'README.md', sha: 'a'.repeat(40), type: 'blob' },
            ],
          })
        return globalThis.Response.json({
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64',
        })
      },
    })
    expect(await verifier.verify({ plugin, release })).toBe(true)

    const nestedRelease = {
      ...release,
      pluginSubdirectory: 'plugins/example',
      resolvedCommitSha: '1'.repeat(40),
    }
    const nestedVerifier = new GithubReleaseVerifier({
      fetchImpl: async (input) => {
        if (String(input).includes('/git/trees/'))
          return globalThis.Response.json({
            tree: [
              { path: 'plugins', type: 'tree' },
              { path: 'plugins/example', type: 'tree' },
              {
                mode: '100644',
                path: 'plugins/example/README.md',
                sha: 'a'.repeat(40),
                type: 'blob',
              },
            ],
          })
        return globalThis.Response.json({
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64',
        })
      },
    })
    expect(await nestedVerifier.verify({ plugin, release: nestedRelease })).toBe(true)
  })

  test('exposes authenticated discovery and idempotent install contracts without content', async () => {
    const fixture = snapshotFixture()
    const records = []
    const application = await createControlApiApplication({
      ...applicationDefaults,
      marketplaceRegistryService: { getCatalog: async () => fixture.snapshot },
      marketplaceInstallationService: {
        list: async () => records,
        install: async (envelope) => {
          records.push({
            canonicalContentDigest: envelope.payload.canonicalContentDigest,
            pluginId: envelope.payload.pluginId,
            releaseId: envelope.payload.releaseId,
            state: 'pending-authorization',
          })
          return records.at(-1)
        },
      },
    })
    try {
      const catalog = await application.inject({
        method: 'POST',
        url: '/v1/marketplace/catalog',
        payload: {
          caller: { servicePrincipalId: 'svc_agent-hq' },
          contractVersion: { major: 2, minor: 0 },
          correlation: { traceId: ids.traceId },
          operation: 'marketplace.catalog.read',
          parameters: {
            workspaceIdentity: {
              userId: 'user-1',
              workspaceId: '550e8400-e29b-41d4-a716-446655440000',
            },
          },
          requestId: ids.requestId,
          requestedAt: '2026-08-31T00:00:00.000Z',
          workspaceId: ids.workspaceId,
        },
      })
      expect(catalog.statusCode).toBe(200)
      expect(catalog.json().data.artifacts['catalog.v1.json']).toBe(
        catalog.json().data.artifacts['catalog-latest.v1.json']
      )
      expect(JSON.stringify(catalog.json())).not.toContain('SKILL.md')

      const install = await application.inject({
        method: 'POST',
        url: '/v1/marketplace/install',
        payload: {
          caller: { servicePrincipalId: 'svc_agent-hq' },
          commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
          contractVersion: { major: 2, minor: 0 },
          correlation: { traceId: ids.traceId },
          idempotencyKey: 'marketplace-install-1',
          issuedAt: '2026-08-31T00:00:00.000Z',
          operation: 'marketplace.install.request',
          payload: {
            canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
            pluginId: 'plugin:openai-official:gmail',
            releaseId: `release:${'c'.repeat(64)}`,
            requestedHarness: 'codex',
            workspaceIdentity: { userId: 'user-1', workspaceId: ids.workspaceId },
          },
          payloadHash: 'a'.repeat(64),
          requestId: 'req_01JABCDEF1123456789ABCDEFG',
          workspaceId: ids.workspaceId,
        },
      })
      expect(install.statusCode).toBe(202)
      expect(install.json().data).toMatchObject({
        canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
        pluginId: 'plugin:openai-official:gmail',
        releaseId: `release:${'c'.repeat(64)}`,
      })
    } finally {
      await application.close()
    }
  })

  test('persists exact pins, checks compatibility, and replays idempotent requests', async () => {
    const fixture = snapshotFixture()
    const repository = new InMemoryMarketplaceInstallationRepository()
    const service = new MarketplaceInstallationService({
      registry: {
        getCatalog: async () => fixture.snapshot,
        verifyRelease: async () => true,
      },
      repository,
    })
    const envelope = {
      idempotencyKey: 'marketplace-install-2',
      payload: {
        canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
        pluginId: 'plugin:openai-official:gmail',
        releaseId: `release:${'c'.repeat(64)}`,
        requestedHarness: 'codex',
        installationInstanceId: 'workspace-user-gmail',
        workspaceIdentity: { userId: 'user-1', workspaceId: ids.workspaceId },
      },
      workspaceId: ids.workspaceId,
    }
    const first = await service.install(envelope)
    const replay = await service.install(envelope)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
      installationInstanceId: 'workspace-user-gmail',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'c'.repeat(64)}`,
      state: 'installed',
    })
    await expect(service.install({ ...envelope, workspaceId: '' })).rejects.toThrow(
      'Marketplace installation request is invalid'
    )
  })

  test('fails closed for stale snapshots and sensitive plugins without policy authority', async () => {
    const fixture = snapshotFixture()
    const repository = new InMemoryMarketplaceInstallationRepository()
    const service = new MarketplaceInstallationService({
      registry: {
        getCatalog: async () => ({ ...fixture.snapshot, state: 'stale' }),
        verifyRelease: async () => true,
      },
      repository,
    })
    const envelope = {
      idempotencyKey: 'marketplace-install-3',
      payload: {
        canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
        pluginId: 'plugin:openai-official:gmail',
        releaseId: `release:${'c'.repeat(64)}`,
        requestedHarness: 'codex',
        workspaceIdentity: { userId: 'user-1', workspaceId: ids.workspaceId },
      },
      workspaceId: ids.workspaceId,
    }
    await expect(service.install(envelope)).resolves.toMatchObject({ state: 'unavailable' })

    const sensitivePlugin = {
      ...fixture.snapshot.catalog.plugins[0],
      securityClassification: { level: 'sensitive' },
    }
    const sensitiveService = new MarketplaceInstallationService({
      registry: {
        getCatalog: async () => ({
          ...fixture.snapshot,
          catalog: { ...fixture.snapshot.catalog, plugins: [sensitivePlugin] },
        }),
        verifyRelease: async () => true,
      },
      repository: new InMemoryMarketplaceInstallationRepository(),
    })
    await expect(
      sensitiveService.install({ ...envelope, idempotencyKey: 'marketplace-install-4' })
    ).resolves.toMatchObject({ state: 'rejected-by-policy' })
  })
})
