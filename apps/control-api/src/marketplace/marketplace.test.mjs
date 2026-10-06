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
import {
  MarketplaceCatalogResponseSchema,
  MarketplaceInstallationGetResponseSchema,
  MarketplaceInstallationUninstallResponseSchema,
} from '@control-plane/contracts'
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
    expect(Object.keys(fixture.snapshot.artifacts).toSorted()).toEqual(
      [...marketplaceArtifactNames].toSorted()
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

  test('revalidates the verified latest catalog with ETag without downloading a 304 body', async () => {
    const fixture = snapshotFixture()
    const requests = []
    let latestReads = 0
    const registry = new MarketplaceRegistryService({
      fetchImpl: async (input, options) => {
        const name = String(input).split('/').at(-1)
        const conditional = new Headers(options?.headers).get('If-None-Match')
        requests.push({ name, conditional })
        if (name === 'catalog-latest.v1.json' && ++latestReads > 1) {
          expect(conditional).toBe('"verified-catalog"')
          return new Response(null, { status: 304 })
        }
        return new Response(fixture.artifacts[name], {
          headers: { ETag: '"verified-catalog"' },
        })
      },
      latestUrl: 'https://registry.example/catalog-latest.v1.json',
      refreshIntervalMs: 0,
    })
    expect((await registry.getCatalog()).state).toBe('ready')
    requests.length = 0
    await registry.getCatalog()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests).toEqual([
      { name: 'catalog-latest.v1.json', conditional: '"verified-catalog"' },
    ])
    expect((await registry.getCatalog()).state).toBe('ready')
  })

  test('does not accept an unsolicited 304 before a catalog is verified', async () => {
    const registry = new MarketplaceRegistryService({
      fetchImpl: async () => new Response(null, { status: 304 }),
    })
    await expect(registry.getCatalog()).rejects.toThrow()
  })

  test('never binds an ETag to mutated latest bytes claiming the held catalog identity', async () => {
    const fixture = snapshotFixture()
    const requests = []
    let mutate = false
    const registry = new MarketplaceRegistryService({
      fetchImpl: async (input, options) => {
        const name = String(input).split('/').at(-1)
        requests.push(new Headers(options?.headers).get('If-None-Match'))
        return new Response(
          mutate && name === 'catalog-latest.v1.json'
            ? JSON.stringify({ ...fixture.catalog, generatedAt: '2026-10-03T00:00:00.000Z' })
            : fixture.artifacts[name],
          { headers: { ETag: mutate ? '"unverified"' : '"verified"' } }
        )
      },
      refreshIntervalMs: 0,
    })
    await registry.getCatalog()
    mutate = true
    requests.length = 0
    await registry.getCatalog()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await registry.getCatalog()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests).toEqual(['"verified"', '"verified"'])
    expect((await registry.getCatalog()).state).toBe('stale')
  })

  test('does not send a validator from a catalog that failed full verification', async () => {
    const fixture = snapshotFixture()
    let corrupt = true
    const validators = []
    const registry = new MarketplaceRegistryService({
      fetchImpl: async (input, options) => {
        const name = String(input).split('/').at(-1)
        if (name === 'catalog-latest.v1.json')
          validators.push(new Headers(options?.headers).get('If-None-Match'))
        return new Response(corrupt && name === 'integrity.json' ? '{}' : fixture.artifacts[name], {
          headers: { ETag: '"candidate"' },
        })
      },
    })
    await expect(registry.getCatalog()).rejects.toThrow()
    corrupt = false
    expect((await registry.getCatalog()).state).toBe('ready')
    expect(validators).toEqual([null, null])
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

describe('marketplace installation lifecycle', () => {
  const workspaceB = 'wsp_01JABCDEF0123456789ABCDEFH'
  const release = {
    canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
    pluginId: 'plugin:openai-official:gmail',
    releaseId: `release:${'c'.repeat(64)}`,
  }

  function lifecycleService(overrides = {}) {
    const fixture = snapshotFixture()
    const events = []
    let tick = 0
    const repository = overrides.repository ?? new InMemoryMarketplaceInstallationRepository()
    const service = new MarketplaceInstallationService({
      registry: { getCatalog: async () => fixture.snapshot, verifyRelease: async () => true },
      repository,
      logger: { write: (entry) => events.push(entry) },
      now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)).toISOString(),
    })
    return { events, repository, service }
  }

  function installEnvelope(
    idempotencyKey,
    identity = { userId: 'user-1', workspaceId: ids.workspaceId }
  ) {
    return {
      idempotencyKey,
      payload: { ...release, requestedHarness: 'codex', workspaceIdentity: identity },
      workspaceId: identity.workspaceId,
    }
  }

  function uninstallEnvelope(
    installationId,
    idempotencyKey,
    identity = { userId: 'user-2', workspaceId: ids.workspaceId }
  ) {
    return {
      idempotencyKey,
      payload: { installationId, workspaceIdentity: identity },
      workspaceId: identity.workspaceId,
    }
  }

  function getEnvelope(
    installationId,
    identity = { userId: 'user-1', workspaceId: ids.workspaceId }
  ) {
    return {
      parameters: { installationId, workspaceIdentity: identity },
      workspaceId: identity.workspaceId,
    }
  }

  test('gets, uninstalls once, and replays the terminal state idempotently', async () => {
    const { events, service } = lifecycleService()
    const installed = await service.install(installEnvelope('lifecycle-install-0001'))
    expect(installed.state).toBe('installed')

    const read = await service.get(getEnvelope(installed.installationId))
    expect(read).toEqual({
      ...release,
      catalogId: installed.catalogId,
      installationId: installed.installationId,
      installedAt: installed.createdAt,
      installedBy: 'user-1',
      requestedHarness: 'codex',
      state: 'installed',
      updatedAt: installed.updatedAt,
    })
    for (const key of ['idempotencyKey', 'requestDigest', 'workspaceId', 'userId'])
      expect(Object.keys(read)).not.toContain(key)

    const first = await service.uninstall(
      uninstallEnvelope(installed.installationId, 'lifecycle-uninstall-0001')
    )
    expect(first.replayed).toBe(false)
    expect(first.installation).toMatchObject({
      installedBy: 'user-1',
      state: 'uninstalled',
      uninstalledBy: 'user-2',
    })
    expect(first.installation.uninstalledAt).toBe(first.installation.updatedAt)
    expect(Date.parse(first.installation.uninstalledAt)).toBeGreaterThan(
      Date.parse(installed.createdAt)
    )

    // The same command replays its original result.
    const replay = await service.uninstall(
      uninstallEnvelope(installed.installationId, 'lifecycle-uninstall-0001')
    )
    expect(replay).toEqual({ installation: first.installation, replayed: true })
    // Another command on the terminal state changes nothing, including who/when.
    const again = await service.uninstall(
      uninstallEnvelope(installed.installationId, 'lifecycle-uninstall-0002', {
        userId: 'user-3',
        workspaceId: ids.workspaceId,
      })
    )
    expect(again).toEqual({ installation: first.installation, replayed: true })
    expect(await service.get(getEnvelope(installed.installationId))).toEqual(first.installation)

    expect(events.map(({ event, details }) => [event, details.actorUserId, details.state])).toEqual(
      [
        ['marketplace.installation.recorded', 'user-1', 'installed'],
        ['marketplace.installation.uninstalled', 'user-2', 'uninstalled'],
      ]
    )
    expect(JSON.stringify(events)).not.toContain('lifecycle-uninstall-0001')
  })

  test('rejects reuse of an uninstall key for a different request', async () => {
    const { service } = lifecycleService()
    const one = await service.install(installEnvelope('lifecycle-install-0101'))
    const two = await service.install(installEnvelope('lifecycle-install-0102'))
    await service.uninstall(uninstallEnvelope(one.installationId, 'lifecycle-uninstall-0101'))
    await expect(
      service.uninstall(uninstallEnvelope(two.installationId, 'lifecycle-uninstall-0101'))
    ).rejects.toMatchObject({
      response: { code: 'MARKETPLACE_IDEMPOTENCY_CONFLICT' },
    })
    await expect(
      service.uninstall(
        uninstallEnvelope(one.installationId, 'lifecycle-uninstall-0101', {
          userId: 'someone-else',
          workspaceId: ids.workspaceId,
        })
      )
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_IDEMPOTENCY_CONFLICT' } })
    expect((await service.get(getEnvelope(two.installationId))).state).toBe('installed')
  })

  test('removes uninstalled installations from the active list and allows a reinstall', async () => {
    const { service } = lifecycleService()
    const original = await service.install(installEnvelope('lifecycle-install-0201'))
    const other = await service.install(
      installEnvelope('lifecycle-install-0202', { userId: 'user-9', workspaceId: ids.workspaceId })
    )
    expect((await service.list(ids.workspaceId)).map((record) => record.installationId)).toEqual([
      original.installationId,
      other.installationId,
    ])
    await service.uninstall(uninstallEnvelope(original.installationId, 'lifecycle-uninstall-0201'))
    expect((await service.list(ids.workspaceId)).map((record) => record.installationId)).toEqual([
      other.installationId,
    ])

    // Replaying the original install key must not report an installation that
    // no longer exists; a reinstall uses a new key and a new installation.
    await expect(service.install(installEnvelope('lifecycle-install-0201'))).rejects.toMatchObject({
      response: { code: 'MARKETPLACE_INSTALLATION_UNINSTALLED' },
    })
    const reinstalled = await service.install(installEnvelope('lifecycle-install-0203'))
    expect(reinstalled.installationId).not.toBe(original.installationId)
    expect(reinstalled.state).toBe('installed')
    expect((await service.get(getEnvelope(original.installationId))).state).toBe('uninstalled')
    expect(
      (await service.list(ids.workspaceId)).map((record) => record.installationId).toSorted()
    ).toEqual([other.installationId, reinstalled.installationId].toSorted())
  })

  test('filters the active list by installer only when asked', async () => {
    const { service } = lifecycleService()
    const mine = await service.install(installEnvelope('lifecycle-install-0301'))
    const theirs = await service.install(
      installEnvelope('lifecycle-install-0302', { userId: 'user-9', workspaceId: ids.workspaceId })
    )
    expect((await service.list(ids.workspaceId)).length).toBe(2)
    expect((await service.list(ids.workspaceId, {})).length).toBe(2)
    expect(
      (await service.list(ids.workspaceId, { installedBy: 'user-1' })).map(
        (record) => record.installationId
      )
    ).toEqual([mine.installationId])
    expect(
      (await service.list(ids.workspaceId, { installedBy: 'user-9' })).map(
        (record) => record.installationId
      )
    ).toEqual([theirs.installationId])
    expect(await service.list(ids.workspaceId, { installedBy: 'nobody' })).toEqual([])
    expect(await service.list(workspaceB, { installedBy: 'user-1' })).toEqual([])
  })

  test('keeps another workspace installation invisible and unchanged', async () => {
    const { service } = lifecycleService()
    const installed = await service.install(installEnvelope('lifecycle-install-0401'))
    const identityB = { userId: 'user-1', workspaceId: workspaceB }
    await expect(
      service.get(getEnvelope(installed.installationId, identityB))
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_INSTALLATION_NOT_FOUND' } })
    await expect(
      service.uninstall(
        uninstallEnvelope(installed.installationId, 'lifecycle-uninstall-0401', identityB)
      )
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_INSTALLATION_NOT_FOUND' } })
    // The B-scoped key was not consumed and A's installation is untouched.
    expect((await service.get(getEnvelope(installed.installationId))).state).toBe('installed')
    await expect(service.get(getEnvelope('ins_00000000000000000000000000'))).rejects.toMatchObject({
      response: { code: 'MARKETPLACE_INSTALLATION_NOT_FOUND' },
    })
    // A nested identity that differs from the envelope scope is invalid.
    await expect(
      service.get({
        ...getEnvelope(installed.installationId, identityB),
        workspaceId: ids.workspaceId,
      })
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_REQUEST_INVALID' } })
    await expect(
      service.uninstall({
        ...uninstallEnvelope(installed.installationId, 'lifecycle-uninstall-0402'),
        idempotencyKey: '',
      })
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_REQUEST_INVALID' } })
  })

  test('records one actor when uninstalls race', async () => {
    const { repository, service } = lifecycleService()
    const installed = await service.install(installEnvelope('lifecycle-install-0501'))
    // Simulate a competing command winning between the read and the transition.
    const markUninstalled = repository.markUninstalled.bind(repository)
    repository.markUninstalled = async (transition) => {
      await markUninstalled({
        ...transition,
        idempotencyKey: 'lifecycle-uninstall-winner',
        uninstalledBy: 'winner',
      })
      return markUninstalled(transition)
    }
    const result = await service.uninstall(
      uninstallEnvelope(installed.installationId, 'lifecycle-uninstall-0501')
    )
    expect(result.replayed).toBe(true)
    expect(result.installation.uninstalledBy).toBe('winner')
  })

  function scopedApplication({ scopes, workspaceIds = [ids.workspaceId], service }) {
    const claims = {
      audience: 'control-plane',
      credentialId: 'marketplace-lifecycle-probe',
      credentialKind: 'service',
      expiresAt: '2026-08-31T01:00:00.000Z',
      issuedAt: '2026-08-31T00:00:00.000Z',
      issuer: 'https://agent-hq.example',
      keyId: 'marketplace-test-key',
      principalId: 'svc_agent-hq',
      projectIds: [],
      scopes,
      workspaceIds,
    }
    return createControlApiApplication({
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
      marketplaceRegistryService: { getCatalog: async () => snapshotFixture().snapshot },
      ...(service === undefined ? {} : { marketplaceInstallationService: service }),
    })
  }

  function httpGet(installationId, workspaceId = ids.workspaceId) {
    return {
      method: 'POST',
      url: '/v1/marketplace/installations/get',
      headers: { authorization: 'Bearer scoped-test-credential' },
      payload: {
        caller: { servicePrincipalId: 'svc_agent-hq' },
        contractVersion: { major: 3, minor: 0 },
        correlation: { traceId: ids.traceId },
        operation: 'marketplace.installation.get',
        parameters: { installationId, workspaceIdentity: { userId: 'user-1', workspaceId } },
        requestId: ids.requestId,
        requestedAt: '2026-08-31T00:00:00.000Z',
        workspaceId,
      },
    }
  }

  function httpUninstall(installationId, idempotencyKey, workspaceId = ids.workspaceId) {
    return {
      method: 'POST',
      url: '/v1/marketplace/installations/uninstall',
      headers: { authorization: 'Bearer scoped-test-credential' },
      payload: {
        caller: { servicePrincipalId: 'svc_agent-hq' },
        commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
        contractVersion: { major: 3, minor: 0 },
        correlation: { traceId: ids.traceId },
        idempotencyKey,
        issuedAt: '2026-08-31T00:00:00.000Z',
        operation: 'marketplace.installation.uninstall',
        payload: { installationId, workspaceIdentity: { userId: 'user-2', workspaceId } },
        payloadHash: 'a'.repeat(64),
        requestId: 'req_01JABCDEF1123456789ABCDEFG',
        workspaceId,
      },
    }
  }

  test('requires marketplace:uninstall and marketplace:read before any access', async () => {
    let calls = 0
    const service = {
      list: async () => [],
      install: async () => ({}),
      get: async () => {
        calls++
        return {}
      },
      uninstall: async () => {
        calls++
        return {}
      },
    }
    const installOnly = await scopedApplication({
      scopes: ['marketplace:read', 'marketplace:install'],
      service,
    })
    try {
      const response = await installOnly.inject(
        httpUninstall('ins_0123456789abcdef0123456789', 'lifecycle-http-0001')
      )
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    } finally {
      await installOnly.close()
    }
    const uninstallOnly = await scopedApplication({ scopes: ['marketplace:uninstall'], service })
    try {
      const response = await uninstallOnly.inject(httpGet('ins_0123456789abcdef0123456789'))
      expect(response.statusCode).toBe(403)
      // A credential for workspace A cannot address workspace B at all.
      const foreign = await uninstallOnly.inject(
        httpUninstall('ins_0123456789abcdef0123456789', 'lifecycle-http-0002', workspaceB)
      )
      expect(foreign.statusCode).toBe(403)
    } finally {
      await uninstallOnly.close()
    }
    expect(calls).toBe(0)
  })

  test('serves get and uninstall over HTTP with workspace isolation', async () => {
    const { service } = lifecycleService()
    const installed = await service.install(installEnvelope('lifecycle-install-0601'))
    const contractResponse = (body) => ({
      contractVersion: { major: 3, minor: 0 },
      correlation: { traceId: ids.traceId },
      data: body.data,
      requestId: ids.requestId,
    })
    const applicationA = await scopedApplication({
      scopes: ['marketplace:read', 'marketplace:uninstall'],
      service,
    })
    try {
      const read = await applicationA.inject(httpGet(installed.installationId))
      expect(read.statusCode).toBe(200)
      expect(read.json().data.installation.state).toBe('installed')
      const parsedRead = MarketplaceInstallationGetResponseSchema.safeParse(
        contractResponse(read.json())
      )
      expect(parsedRead.success ? [] : parsedRead.error.issues).toEqual([])

      const mismatched = httpGet(installed.installationId)
      mismatched.payload.parameters.workspaceIdentity.workspaceId = workspaceB
      expect((await applicationA.inject(mismatched)).statusCode).toBe(400)

      const removed = await applicationA.inject(
        httpUninstall(installed.installationId, 'lifecycle-http-0601')
      )
      expect(removed.statusCode).toBe(200)
      expect(removed.json().data).toMatchObject({
        installation: { state: 'uninstalled', uninstalledBy: 'user-2' },
        replayed: false,
      })
      const parsedRemoval = MarketplaceInstallationUninstallResponseSchema.safeParse(
        contractResponse(removed.json())
      )
      expect(parsedRemoval.success ? [] : parsedRemoval.error.issues).toEqual([])
      const replay = await applicationA.inject(
        httpUninstall(installed.installationId, 'lifecycle-http-0601')
      )
      expect(replay.json().data).toEqual({ ...removed.json().data, replayed: true })
    } finally {
      await applicationA.close()
    }

    const applicationB = await scopedApplication({
      scopes: ['marketplace:read', 'marketplace:uninstall'],
      workspaceIds: [workspaceB],
      service,
    })
    try {
      const read = await applicationB.inject(httpGet(installed.installationId, workspaceB))
      expect(read.statusCode).toBe(404)
      expect(read.json().error.code).toBe('MARKETPLACE_INSTALLATION_NOT_FOUND')
      const removal = await applicationB.inject(
        httpUninstall(installed.installationId, 'lifecycle-http-0602', workspaceB)
      )
      expect(removal.statusCode).toBe(404)
    } finally {
      await applicationB.close()
    }
  })

  test('filters catalog installations by installer and hides uninstalled ones', async () => {
    const { service } = lifecycleService()
    const mine = await service.install(installEnvelope('lifecycle-install-0701'))
    await service.install(
      installEnvelope('lifecycle-install-0702', { userId: 'user-9', workspaceId: ids.workspaceId })
    )
    const application = await scopedApplication({ scopes: ['marketplace:read'], service })
    const catalog = (parameters) => ({
      method: 'POST',
      url: '/v1/marketplace/catalog',
      headers: { authorization: 'Bearer scoped-test-credential' },
      payload: {
        caller: { servicePrincipalId: 'svc_agent-hq' },
        contractVersion: { major: 3, minor: 0 },
        correlation: { traceId: ids.traceId },
        operation: 'marketplace.catalog.read',
        parameters: {
          workspaceIdentity: { userId: 'user-1', workspaceId: ids.workspaceId },
          ...parameters,
        },
        requestId: ids.requestId,
        requestedAt: '2026-08-31T00:00:00.000Z',
        workspaceId: ids.workspaceId,
      },
    })
    try {
      const all = await application.inject(catalog({}))
      expect(all.json().data.installations.length).toBe(2)
      const filtered = await application.inject(catalog({ installedBy: 'user-1' }))
      expect(filtered.json().data.installations.map((entry) => entry.installationId)).toEqual([
        mine.installationId,
      ])
      expect((await application.inject(catalog({ installedBy: '' }))).statusCode).toBe(400)
      await service.uninstall(uninstallEnvelope(mine.installationId, 'lifecycle-uninstall-0701'))
      const after = await application.inject(catalog({ installedBy: 'user-1' }))
      expect(after.json().data.installations).toEqual([])
      expect((await application.inject(catalog({}))).json().data.installations.length).toBe(1)
    } finally {
      await application.close()
    }
  })

  test('fails closed when installation management is not configured', async () => {
    const application = await scopedApplication({
      scopes: ['marketplace:read', 'marketplace:uninstall'],
    })
    try {
      const read = await application.inject(httpGet('ins_0123456789abcdef0123456789'))
      expect(read.statusCode).toBe(503)
      expect(read.json().error.code).toBe('MARKETPLACE_INSTALLATION_NOT_CONFIGURED')
      const removal = await application.inject(
        httpUninstall('ins_0123456789abcdef0123456789', 'lifecycle-http-0801')
      )
      expect(removal.statusCode).toBe(503)
    } finally {
      await application.close()
    }
    const legacy = await scopedApplication({
      scopes: ['marketplace:read', 'marketplace:uninstall'],
      service: { list: async () => [], install: async () => ({}) },
    })
    try {
      expect((await legacy.inject(httpGet('ins_0123456789abcdef0123456789'))).statusCode).toBe(503)
    } finally {
      await legacy.close()
    }
  })
})
