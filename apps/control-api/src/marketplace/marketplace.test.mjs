import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { TextEncoder } from 'node:util'
import { createControlApiApplication } from '../application.ts'
import {
  PolicyServiceAuthenticator,
  createInternalServicePrincipal,
} from '../auth/service-authentication.ts'
import { GithubReleaseVerifier } from './github-release-verifier.ts'
import {
  InMemoryMarketplaceInstallationRepository,
  MarketplaceInstallationService,
} from './installation.ts'
import { MarketplaceCatalogResponseSchema } from '@control-plane/contracts'
import {
  MarketplaceRegistryService,
  bytesDigest,
  digest,
  verifyArtifacts,
  marketplaceArtifactNames,
} from './registry.ts'

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

function snapshotFixture(overrides = {}) {
  const plugin = pluginFixture()
  const body = {
    generatedAt: '2026-08-31T00:00:00.000Z',
    plugins: [plugin],
    schemaVersion: 1,
    sources: [{ sourceId: 'openai-official' }],
    ...overrides,
  }
  const catalogId = `catalog:${digest(body).slice('sha256:'.length)}`
  const catalog = { ...body, catalogId }
  const catalogText = JSON.stringify(catalog)
  const summaryText = JSON.stringify({ catalogId, pluginCount: 1, schemaVersion: 1 })
  const categoriesText = JSON.stringify({ categories: [], catalogId, schemaVersion: 1 })
  const compatibilityText = JSON.stringify({ catalogId, plugins: [], schemaVersion: 1 })
  const lockText = JSON.stringify({ catalogId, schemaVersion: 1, sources: [] })
  const indexText = JSON.stringify({ catalogId, products: {}, schemaVersion: 1 })
  const files = {
    'catalog.v1.json': catalogText,
    'catalog-index.v1.json': indexText,
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
  test('the SDK response contract accepts exactly the artifact set the registry serves', () => {
    // Drift guard. `marketplaceArtifactNames` is what the registry fetches,
    // verifies and returns; MarketplaceArtifactsSchema is `.strict()` and is
    // what every control-sdk client parses that response with. Adding an
    // artifact to one and not the other breaks the marketplace read path for
    // clients only — the server still answers 200 — so nothing else caught it.
    const fixture = snapshotFixture()
    expect(Object.keys(fixture.snapshot.artifacts).sort()).toEqual(
      [...marketplaceArtifactNames].sort()
    )
    const parsed = MarketplaceCatalogResponseSchema.safeParse({
      contractVersion: { major: 1, minor: 0 },
      requestId: ids.requestId,
      correlation: { traceId: ids.traceId },
      data: { ...fixture.snapshot, installations: [] },
    })
    expect(parsed.success ? [] : parsed.error.issues).toEqual([])

    // A release published before the browsing index existed is a supported
    // response shape, not just a tolerated one: the contract must accept the
    // artifact set with the key absent as well.
    const withoutIndex = { ...fixture.snapshot }
    delete withoutIndex.artifacts['catalog-index.v1.json']
    const parsedLegacy = MarketplaceCatalogResponseSchema.safeParse({
      contractVersion: { major: 1, minor: 0 },
      requestId: ids.requestId,
      correlation: { traceId: ids.traceId },
      data: { ...withoutIndex, installations: [] },
    })
    expect(parsedLegacy.success ? [] : parsedLegacy.error.issues).toEqual([])
  })

  test('verifies a release published before the browsing index existed', () => {
    // #709 added the index. A release that predates it carries no such
    // artifact, and the registry must serve it rather than fail the read.
    const fixture = snapshotFixture()
    const integrity = JSON.parse(fixture.artifacts['integrity.json'])
    const files = { ...integrity.files }
    delete files['catalog-index.v1.json']
    const artifacts = { ...fixture.artifacts }
    delete artifacts['catalog-index.v1.json']
    const verified = verifyArtifacts({
      ...artifacts,
      'integrity.json': JSON.stringify({ ...integrity, files }),
    })
    expect(verified.catalogId).toBe(fixture.catalog.catalogId)
    expect(verified.artifacts['catalog-index.v1.json']).toBeUndefined()
  })

  test('still rejects a browsing index that is present but undeclared or mismatched', () => {
    // Optionality is about the artifact being absent, never about relaxing the
    // checks on one that is present. A release that ships the index and gets it
    // wrong is a defect and must fail closed.
    const fixture = snapshotFixture()
    const integrity = JSON.parse(fixture.artifacts['integrity.json'])
    const undeclared = { ...integrity.files }
    delete undeclared['catalog-index.v1.json']
    expect(() =>
      verifyArtifacts({
        ...fixture.artifacts,
        'integrity.json': JSON.stringify({ ...integrity, files: undeclared }),
      })
    ).toThrow(/not declared: catalog-index/)

    const files = { ...integrity.files }
    expect(() =>
      verifyArtifacts({
        ...fixture.artifacts,
        'integrity.json': JSON.stringify({
          ...integrity,
          files: { ...files, 'catalog-index.v1.json': digest('tampered') },
        }),
      })
    ).toThrow(/digest mismatch/)
  })

  test('treats only a 404 as an absent index and never an outage', async () => {
    // The tolerance is scoped to "this release is older". A 5xx, a transport
    // failure or a timeout must fail the refresh instead of silently dropping
    // the index, or a registry outage would look like a legacy catalog.
    const fixture = snapshotFixture()
    const bodies = new Map(Object.entries(fixture.artifacts).map(([name, body]) => [name, body]))
    const serve = (statusForIndex) => async (url) => {
      const name = new URL(url).pathname.split('/').pop()
      if (name === 'catalog-index.v1.json') {
        if (statusForIndex === 404) return new Response('missing', { status: 404 })
        if (statusForIndex === 500) return new Response('boom', { status: 500 })
        return new Response('unreachable', { status: 503 })
      }
      return new Response(bodies.get(name) ?? 'not found', { status: bodies.has(name) ? 200 : 404 })
    }
    const service = (fetchImpl) =>
      new MarketplaceRegistryService({
        fetchImpl,
        latestUrl: 'https://registry.example.com/catalog-assets/catalog-latest.v1.json',
        token: 't',
      })

    const legacy = await service(serve(404)).getCatalog()
    expect(legacy.state).toBe('ready')
    expect(legacy.artifacts['catalog-index.v1.json']).toBeUndefined()

    for (const status of [500, 503]) {
      const failing = service(serve(status))
      // No cache yet, so an outage with nothing to fall back on is a 503.
      await expect(failing.getCatalog()).rejects.toThrow()
    }
  })

  test('verifies an immutable artifact set and preserves raw artifacts', () => {
    const fixture = snapshotFixture()
    const verified = verifyArtifacts(fixture.artifacts)
    expect(verified.catalogId).toBe(fixture.catalog.catalogId)
    expect(verified.artifacts['catalog-latest.v1.json']).toBe(verified.artifacts['catalog.v1.json'])
  })

  test('accepts a release whose manifest declares artifacts this service does not proxy', () => {
    const fixture = snapshotFixture()
    // A catalog release also publishes consumer shards and mirrored brand marks.
    const extended = {
      ...fixture.artifacts,
      'categories.v1.json': JSON.stringify({
        categories: [],
        catalogId: fixture.catalog.catalogId,
        schemaVersion: 1,
        topCount: 6,
      }),
      'catalog-index.v1.json': JSON.stringify({
        catalogId: fixture.catalog.catalogId,
        products: {},
        schemaVersion: 1,
      }),
      'icon-0123456789abcdef0123456789abcdef.png': 'binary',
    }
    // Digests are declared over the bytes actually published, including the
    // shard-shaped categories artifact this fixture substitutes.
    const files = Object.fromEntries(
      Object.entries(extended)
        .filter(([name]) => name !== 'integrity.json' && name !== 'catalog-latest.v1.json')
        .map(([name, value]) => [name, digest(value)])
    )
    const verified = verifyArtifacts({
      ...extended,
      'integrity.json': JSON.stringify({
        assets: [],
        catalogId: fixture.catalog.catalogId,
        files,
        schemaVersion: 1,
      }),
    })
    expect(verified.catalogId).toBe(fixture.catalog.catalogId)
  })

  test('rejects a browsing index that does not belong to the catalog', () => {
    const fixture = snapshotFixture()
    const integrity = JSON.parse(fixture.artifacts['integrity.json'])
    const index = JSON.parse(fixture.artifacts['catalog-index.v1.json'])
    const mismatched = JSON.stringify({
      ...index,
      catalogId: `catalog:${'0'.repeat(64)}`,
    })
    expect(() =>
      verifyArtifacts({
        ...fixture.artifacts,
        'catalog-index.v1.json': mismatched,
        'integrity.json': JSON.stringify({
          ...integrity,
          files: { ...integrity.files, 'catalog-index.v1.json': digest(mismatched) },
        }),
      })
    ).toThrow(/browsing index/)
  })

  test('rejects a manifest that omits a required artifact', () => {
    const fixture = snapshotFixture()
    const files = Object.fromEntries(
      Object.entries(fixture.artifacts)
        .filter(([name]) => name !== 'integrity.json' && name !== 'catalog-latest.v1.json')
        .map(([name, value]) => [name, digest(value)])
    )
    delete files['categories.v1.json']
    expect(() =>
      verifyArtifacts({
        ...fixture.artifacts,
        'integrity.json': JSON.stringify({
          catalogId: fixture.catalog.catalogId,
          files,
          schemaVersion: 1,
        }),
      })
    ).toThrow(/not declared/)
  })

  test('rejects an artifact the manifest does not declare', () => {
    const fixture = snapshotFixture()
    const files = Object.fromEntries(
      Object.entries(fixture.artifacts)
        .filter(([name]) => name !== 'integrity.json' && name !== 'catalog-latest.v1.json')
        .map(([name, value]) => [name, digest(value)])
    )
    delete files['compatibility.v1.json']
    files['compatibility.v1.json'] = digest('substituted')
    expect(() =>
      verifyArtifacts({
        ...fixture.artifacts,
        'integrity.json': JSON.stringify({
          catalogId: fixture.catalog.catalogId,
          files,
          schemaVersion: 1,
        }),
      })
    ).toThrow(/digest mismatch/)
  })

  test('never requests the latest pointer from a snapshot directory', async () => {
    // The pointer is what names the catalog identity, so it lives at the
    // publication root and is re-pointed on every publication; it is not part
    // of any snapshot. Requesting it from `catalogs/<catalogId>/` is a 404 by
    // construction, and a live fetch against the real publication failed the
    // whole refresh on exactly that.
    const fixture = snapshotFixture()
    const bodies = new Map(Object.entries(fixture.artifacts).map(([name, body]) => [name, body]))
    const requested = []
    const service = new MarketplaceRegistryService({
      fetchImpl: async (input) => {
        const url = String(input)
        requested.push(url)
        const name = new URL(url).pathname.split('/').pop()
        if (name === 'catalog-latest.v1.json' && url.includes('/catalogs/'))
          return new Response('not found', { status: 404 })
        return new Response(bodies.get(name) ?? 'not found', {
          status: bodies.has(name) ? 200 : 404,
        })
      },
      latestUrl: 'https://registry.example/catalog-assets/catalog-latest.v1.json',
      immutableArtifactBaseUrl: 'https://registry.example/catalog-assets/catalogs/{catalogId}',
    })

    const snapshot = await service.getCatalog()
    expect(snapshot.state).toBe('ready')
    expect(
      requested.filter(
        (url) => url.includes('/catalogs/') && url.endsWith('catalog-latest.v1.json')
      )
    ).toEqual([])
    // The bytes already read to learn the catalogId are the pointer's own, so
    // verification still sees the pointer and the catalog it names agree.
    expect(snapshot.artifacts['catalog-latest.v1.json']).toBe(snapshot.artifacts['catalog.v1.json'])
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
      latestUrl: 'https://registry.example/catalog-assets/catalog-latest.v1.json',
      immutableArtifactBaseUrl: 'https://registry.example/catalogs/{catalogId}',
      refreshIntervalMs: 0,
    })
    expect((await registry.getCatalog()).catalogId).toBe(fixture.catalog.catalogId)
    fail = true
    // The snapshot is served immediately while the registry refreshes in the
    // background; once the failed refresh settles the snapshot reads stale.
    const served = await registry.getCatalog()
    expect(served.catalogId).toBe(fixture.catalog.catalogId)
    // Let the background refresh settle before asserting the stale marker.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await registry.getCatalog()).state).toBe('stale')
  })

  test('skips the immutable artifact download while the pointer names the held catalog', async () => {
    // Steady-state polling must cost one small pointer request, not a full
    // ~50 MB re-download: artifacts are content-addressed by the catalog
    // identity, so a matching pointer proves the held snapshot is current.
    const fixture = snapshotFixture()
    const bodies = new Map(Object.entries(fixture.artifacts).map(([name, body]) => [name, body]))
    const requested = []
    const registry = new MarketplaceRegistryService({
      fetchImpl: async (input) => {
        const url = String(input)
        requested.push(url.split('/').at(-1))
        const name = requested.at(-1)
        return new Response(bodies.get(name) ?? 'not found', {
          status: bodies.has(name) ? 200 : 404,
        })
      },
      latestUrl: 'https://registry.example/catalog-assets/catalog-latest.v1.json',
      immutableArtifactBaseUrl: 'https://registry.example/catalogs/{catalogId}',
      refreshIntervalMs: 0,
    })
    expect((await registry.getCatalog()).state).toBe('ready')
    expect(requested.length).toBeGreaterThan(1)

    requested.length = 0
    expect((await registry.getCatalog()).catalogId).toBe(fixture.catalog.catalogId)
    // Let the background refresh settle before asserting what it fetched.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(requested).toEqual(['catalog-latest.v1.json'])
  })

  test('downloads the full catalog again once the pointer names a new one', async () => {
    const fixture = snapshotFixture()
    const next = snapshotFixture({ generatedAt: '2026-09-30T00:00:00.000Z' })
    const bodies = new Map(Object.entries(fixture.artifacts).map(([name, body]) => [name, body]))
    const requested = []
    const registry = new MarketplaceRegistryService({
      fetchImpl: async (input) => {
        const url = String(input)
        const name = url.split('/').at(-1)
        requested.push(name)
        return new Response(bodies.get(name) ?? 'not found', {
          status: bodies.has(name) ? 200 : 404,
        })
      },
      latestUrl: 'https://registry.example/catalog-assets/catalog-latest.v1.json',
      immutableArtifactBaseUrl: 'https://registry.example/catalogs/{catalogId}',
      refreshIntervalMs: 0,
    })
    expect((await registry.getCatalog()).catalogId).toBe(fixture.catalog.catalogId)

    requested.length = 0
    for (const [name, body] of Object.entries(next.artifacts)) bodies.set(name, body)
    // The cached snapshot is served while the background refresh downloads
    // the new catalog; wait for it to settle before asserting the swap.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await registry.getCatalog()).catalogId === next.catalog.catalogId) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect((await registry.getCatalog()).catalogId).toBe(next.catalog.catalogId)
    expect(requested).toContain('catalog.v1.json')
    expect(requested.filter((name) => name === 'catalog-latest.v1.json').length).toBeGreaterThan(0)
  })

  test('a pointer failure turns the snapshot stale and a pointer-only refresh clears it', async () => {
    // Only the pointer can make an unchanged catalog stale: artifacts are
    // identity-addressed and are not re-fetched while the pointer matches.
    const fixture = snapshotFixture()
    let failPointer = false
    const requested = []
    const registry = new MarketplaceRegistryService({
      fetchImpl: async (input) => {
        const url = String(input)
        const name = url.split('/').at(-1)
        requested.push(name)
        if (failPointer && name === 'catalog-latest.v1.json')
          return new Response('boom', { status: 500 })
        return new Response(fixture.artifacts[name] ?? 'not found', {
          status: fixture.artifacts[name] === undefined ? 404 : 200,
        })
      },
      latestUrl: 'https://registry.example/catalog-assets/catalog-latest.v1.json',
      immutableArtifactBaseUrl: 'https://registry.example/catalogs/{catalogId}',
      refreshIntervalMs: 0,
    })
    expect((await registry.getCatalog()).state).toBe('ready')

    failPointer = true
    await registry.getCatalog()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await registry.getCatalog()).state).toBe('stale')

    // Healing the pointer resolves the stale state with one small request:
    // the held catalog still verifies for the named identity.
    failPointer = false
    requested.length = 0
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await registry.getCatalog()).state === 'ready') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect((await registry.getCatalog()).state).toBe('ready')
    expect(requested.every((name) => name === 'catalog-latest.v1.json')).toBe(true)
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
              workspaceId: ids.workspaceId,
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

  test('rejects marketplace identities outside the authenticated workspace before access', async () => {
    const fixture = snapshotFixture()
    let catalogListCalls = 0
    let installCalls = 0
    const claims = {
      audience: 'control-plane',
      credentialId: 'marketplace-scope-probe',
      credentialKind: 'service',
      expiresAt: '2026-08-31T01:00:00.000Z',
      issuedAt: '2026-08-31T00:00:00.000Z',
      issuer: 'https://agent-hq.example',
      keyId: 'marketplace-test-key',
      principalId: 'svc_agent-hq',
      projectIds: [],
      scopes: ['marketplace:read', 'marketplace:install'],
      workspaceIds: [ids.workspaceId],
    }
    const application = await createControlApiApplication({
      ...applicationDefaults,
      serviceAuthenticator: new PolicyServiceAuthenticator({
        audience: 'control-plane',
        clockSkewMs: 30_000,
        issuer: claims.issuer,
        logger: { write: () => undefined },
        now: () => new Date('2026-08-31T00:05:00.000Z'),
        revocationChecker: { isRevoked: async () => false },
        verifier: { verify: async () => claims },
      }),
      marketplaceRegistryService: { getCatalog: async () => fixture.snapshot },
      marketplaceInstallationService: {
        list: async () => {
          catalogListCalls++
          return []
        },
        install: async () => {
          installCalls++
          return { state: 'pending-authorization' }
        },
      },
    })
    try {
      const catalog = await application.inject({
        method: 'POST',
        url: '/v1/marketplace/catalog',
        headers: { authorization: 'Bearer scoped-test-credential' },
        payload: {
          caller: { servicePrincipalId: 'svc_agent-hq' },
          contractVersion: { major: 2, minor: 0 },
          correlation: { traceId: ids.traceId },
          operation: 'marketplace.catalog.read',
          parameters: {
            workspaceIdentity: { userId: 'user-1', workspaceId: 'wsp_unauthorized' },
          },
          requestId: ids.requestId,
          requestedAt: '2026-08-31T00:00:00.000Z',
          workspaceId: ids.workspaceId,
        },
      })
      expect(catalog.statusCode).toBe(400)
      expect(catalogListCalls).toBe(0)

      const install = await application.inject({
        method: 'POST',
        url: '/v1/marketplace/install',
        headers: { authorization: 'Bearer scoped-test-credential' },
        payload: {
          caller: { servicePrincipalId: 'svc_agent-hq' },
          commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
          contractVersion: { major: 2, minor: 0 },
          correlation: { traceId: ids.traceId },
          idempotencyKey: 'marketplace-install-cross-workspace',
          issuedAt: '2026-08-31T00:00:00.000Z',
          operation: 'marketplace.install.request',
          payload: {
            canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
            pluginId: 'plugin:openai-official:gmail',
            releaseId: `release:${'c'.repeat(64)}`,
            requestedHarness: 'codex',
            workspaceIdentity: { userId: 'user-1', workspaceId: 'wsp_unauthorized' },
          },
          payloadHash: 'a'.repeat(64),
          requestId: 'req_01JABCDEF1123456789ABCDEFG',
          workspaceId: ids.workspaceId,
        },
      })
      expect(install.statusCode).toBe(400)
      expect(installCalls).toBe(0)
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
    await expect(
      service.install({
        ...envelope,
        payload: {
          ...envelope.payload,
          workspaceIdentity: { userId: 'user-1', workspaceId: 'wsp_unauthorized' },
        },
      })
    ).rejects.toThrow('Marketplace installation request is invalid')
    expect(await repository.listByWorkspace('wsp_unauthorized')).toEqual([])
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

test('aborts artifact downloads that exceed the size cap mid-stream', async () => {
  const registry = new MarketplaceRegistryService({
    fetchImpl: async () => new globalThis.Response('x'.repeat(64), { status: 200 }),
    latestUrl: 'https://registry.example/catalog-assets/catalog-latest.v1.json',
    immutableArtifactBaseUrl: 'https://registry.example/catalogs/{catalogId}',
    refreshIntervalMs: 0,
    maxArtifactBytes: 16,
  })
  // Cold start with an over-cap artifact: the download aborts in flight and
  // the registry reports unavailable instead of buffering the full payload.
  await expect(registry.getCatalog()).rejects.toThrow(/marketplace registry is unavailable/)
})
