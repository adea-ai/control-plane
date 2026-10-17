import { createHash } from 'node:crypto'
import { describe, expect, spyOn, test } from 'bun:test'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  GraphCatalogError,
  GraphCheckpointRecordSchema,
  GraphDefinitionCatalog,
  GraphDefinitionExecutionAuthority,
  InMemoryGraphDefinitionRepository,
  PublishedGraphDefinitionSchema,
  checkpointExpiresAt,
  graphDefinitionUpdateIsValid,
} from './graph-catalog.ts'

const publishedAt = '2026-08-25T13:00:00.000Z'
const environment = {
  capabilities: ['runtime.invoke', 'model.invoke', 'tool.invoke'],
  contractMajorVersion: 1,
  compilerVersion: '1.0.0',
  adapterVersion: '1.4.12',
}
const definition = (version, suffix = '') => ({
  graphDefinitionId: 'manager-graph',
  graphVersion: version,
  schemaVersion: 1,
  nodes: [
    { node: 'plan', operation: { kind: 'model', name: `plan${suffix}` } },
    { node: 'execute', operation: { kind: 'runtime', name: 'execute' } },
  ],
  edges: [
    { from: '__start__', to: 'plan' },
    { from: 'plan', to: 'execute' },
    { from: 'execute', to: '__end__' },
  ],
  schemas: {
    input: 'schema://manager/input/v1',
    state: 'schema://manager/state/v1',
    output: 'schema://manager/output/v1',
  },
  requiredCapabilities: environment.capabilities,
  compatibility: {
    contractMajorVersions: [1],
    compilerVersions: ['1.0.0'],
    adapterVersions: ['1.4.12'],
  },
})

const digest = (serialized) => `sha256:${createHash('sha256').update(serialized).digest('hex')}`

const localeCanonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(localeCanonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, entry]) => `${JSON.stringify(key)}:${localeCanonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const graphVersionRecord = (content, contentDigest, digestVersion) => ({
  reference: {
    graphDefinitionId: content.graphDefinitionId,
    graphVersion: content.graphVersion,
    contentDigest,
  },
  revision: 1,
  lifecycle: 'published',
  content,
  publishedAt,
  changedAt: publishedAt,
  ...(digestVersion === undefined ? {} : { digestVersion }),
})

describe('versioned graph definitions', () => {
  test('publishes a versioned canonical digest for new graph records', async () => {
    const content = definition('1.0.0')
    const originalVersion = await new GraphDefinitionCatalog(
      new InMemoryGraphDefinitionRepository()
    ).publish({ definition: content, publishedAt })
    const reorderedContent = {
      compatibility: {
        adapterVersions: ['1.4.12'],
        compilerVersions: ['1.0.0'],
        contractMajorVersions: [1],
      },
      requiredCapabilities: [...environment.capabilities],
      schemas: {
        output: 'schema://manager/output/v1',
        state: 'schema://manager/state/v1',
        input: 'schema://manager/input/v1',
      },
      edges: content.edges.map(({ from, to }) => ({ to, from })),
      nodes: content.nodes.map(({ node, operation }) => ({
        operation: { name: operation.name, kind: operation.kind },
        node,
      })),
      schemaVersion: 1,
      graphVersion: '1.0.0',
      graphDefinitionId: 'manager-graph',
    }
    const localeCompareSpy = spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('new graph digests must not use localeCompare')
    })
    let reorderedVersion
    try {
      reorderedVersion = await new GraphDefinitionCatalog(
        new InMemoryGraphDefinitionRepository()
      ).publish({ definition: reorderedContent, publishedAt })
    } finally {
      localeCompareSpy.mockRestore()
    }

    expect(originalVersion.digestVersion).toBe('canonical-json-v1')
    expect(reorderedVersion.digestVersion).toBe('canonical-json-v1')
    expect(reorderedVersion.reference.contentDigest).toBe(originalVersion.reference.contentDigest)
    expect(originalVersion.reference.contentDigest).toBe(digest(canonicalJsonStringify(content)))
    expect(PublishedGraphDefinitionSchema.parse(reorderedVersion)).toEqual(reorderedVersion)
  })

  test('verifies pre-#618 locale digests and unversioned #618 canonical digests', async () => {
    const historicalContent = definition('1.0.0')
    const historicalSerialized = localeCanonicalJson(historicalContent)
    expect(historicalSerialized).not.toBe(canonicalJsonStringify(historicalContent))
    expect(historicalSerialized).toBe(
      '{"compatibility":{"adapterVersions":["1.4.12"],"compilerVersions":["1.0.0"],"contractMajorVersions":[1]},"edges":[{"from":"__start__","to":"plan"},{"from":"plan","to":"execute"},{"from":"execute","to":"__end__"}],"graphDefinitionId":"manager-graph","graphVersion":"1.0.0","nodes":[{"node":"plan","operation":{"kind":"model","name":"plan"}},{"node":"execute","operation":{"kind":"runtime","name":"execute"}}],"requiredCapabilities":["runtime.invoke","model.invoke","tool.invoke"],"schemas":{"input":"schema://manager/input/v1","output":"schema://manager/output/v1","state":"schema://manager/state/v1"},"schemaVersion":1}'
    )
    const historicalDigest =
      'sha256:4883c61e729a23e139f99b8d55d59ff62d9723d82e8f4f8ab96701749d88681b'
    expect(digest(historicalSerialized)).toBe(historicalDigest)

    const historical = graphVersionRecord(historicalContent, historicalDigest)
    const historicalRepository = new InMemoryGraphDefinitionRepository()
    expect(await historicalRepository.insert(historical)).toBe(true)
    expect(
      await new GraphDefinitionCatalog(historicalRepository).getPinned(historical.reference)
    ).toEqual(historical)

    const canonicalContent = definition('2.0.0')
    const canonical = graphVersionRecord(
      canonicalContent,
      digest(canonicalJsonStringify(canonicalContent))
    )
    const canonicalRepository = new InMemoryGraphDefinitionRepository()
    expect(await canonicalRepository.insert(canonical)).toBe(true)
    expect(
      await new GraphDefinitionCatalog(canonicalRepository).getPinned(canonical.reference)
    ).toEqual(canonical)
  })

  test('dispatches explicit digest versions strictly and rejects malformed or mismatched records', () => {
    const content = definition('1.0.0')
    const canonical = graphVersionRecord(
      content,
      digest(canonicalJsonStringify(content)),
      'canonical-json-v1'
    )
    expect(PublishedGraphDefinitionSchema.parse(canonical)).toEqual(canonical)

    const historical = graphVersionRecord(content, digest(localeCanonicalJson(content)))
    expect(
      PublishedGraphDefinitionSchema.safeParse({
        ...historical,
        digestVersion: 'canonical-json-v1',
      }).success
    ).toBe(false)

    for (const digestVersion of [null, 1, '', 'canonical-json-v2']) {
      expect(
        PublishedGraphDefinitionSchema.safeParse({ ...canonical, digestVersion }).success
      ).toBe(false)
    }

    expect(
      PublishedGraphDefinitionSchema.safeParse({
        ...canonical,
        reference: { ...canonical.reference, contentDigest: `sha256:${'f'.repeat(64)}` },
      }).success
    ).toBe(false)
  })

  test('getPinned rejects malformed records returned by a repository', async () => {
    const content = definition('1.0.0')
    const canonical = graphVersionRecord(
      content,
      digest(canonicalJsonStringify(content)),
      'canonical-json-v999'
    )
    const catalog = new GraphDefinitionCatalog({ get: async () => canonical })

    await expect(catalog.getPinned(canonical.reference)).rejects.toMatchObject({
      code: 'GRAPH_DIGEST_MISMATCH',
    })
  })

  test('getPinned rejects a valid record returned under a different graph identity', async () => {
    const content = definition('1.0.0')
    const returned = graphVersionRecord(
      content,
      digest(canonicalJsonStringify(content)),
      'canonical-json-v1'
    )
    const requested = {
      ...returned.reference,
      graphDefinitionId: 'other-graph',
      graphVersion: '2.0.0',
    }
    const catalog = new GraphDefinitionCatalog({ get: async () => returned })

    await expect(catalog.getPinned(requested)).rejects.toMatchObject({
      code: 'GRAPH_DIGEST_MISMATCH',
    })
  })

  test('lifecycle compare-and-set preserves the explicit digest version and digest', async () => {
    const version = await new GraphDefinitionCatalog(
      new InMemoryGraphDefinitionRepository()
    ).publish({ definition: definition('1.0.0'), publishedAt })
    const deprecated = {
      ...version,
      revision: 2,
      lifecycle: 'deprecated',
      changedAt: '2026-08-25T14:00:00.000Z',
      reason: 'replaced',
    }
    const withoutVersion = { ...deprecated }
    delete withoutVersion.digestVersion

    expect(graphDefinitionUpdateIsValid(version, deprecated, 1)).toBe(true)
    expect(graphDefinitionUpdateIsValid(version, withoutVersion, 1)).toBe(false)
  })

  test('authorizes workspace pins while checking lifecycle, compiler and input only for new admission', async () => {
    const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
    const repository = new InMemoryGraphDefinitionRepository()
    const other = new InMemoryGraphDefinitionRepository()
    const catalog = new GraphDefinitionCatalog(repository)
    const version = await catalog.publish({ definition: definition('1.0.0'), publishedAt })
    const checks = []
    const authority = new GraphDefinitionExecutionAuthority({
      repository: (scope) => (scope === workspaceId ? repository : other),
      environment,
      validateDefinitionAndInput: async (record, input) => {
        checks.push({ record, input })
        return input.objective === 'review'
      },
    })
    const selection = { reference: version.reference, input: { objective: 'review' } }
    expect(await authority.validate(workspaceId, selection)).toBe(true)
    expect(checks[0]).toEqual({ record: version, input: selection.input })
    expect(
      await authority.validate(workspaceId, { ...selection, input: { objective: 'bad schema' } })
    ).toBe(false)
    expect(await authority.authorize('wsp_01JABCDEF0123456789ABCDEFH', version.reference)).toBe(
      false
    )
    await catalog.deprecate({
      reference: version.reference,
      expectedRevision: 1,
      changedAt: '2026-08-25T14:00:00.000Z',
      reason: 'replaced',
    })
    expect(await authority.validate(workspaceId, selection)).toBe(false)
    expect(await authority.authorize(workspaceId, version.reference)).toBe(true)
    expect(
      await authority.authorize(workspaceId, {
        ...version.reference,
        contentDigest: `sha256:${'f'.repeat(64)}`,
      })
    ).toBe(false)
  })

  test('does not hide graph storage outages as policy denials', async () => {
    const failure = new Error('store unavailable')
    const authority = new GraphDefinitionExecutionAuthority({
      repository: () => ({
        get: async () => {
          throw failure
        },
      }),
      environment,
      validateDefinitionAndInput: () => true,
    })
    const reference = {
      graphDefinitionId: 'manager-graph',
      graphVersion: '1.0.0',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }
    await expect(authority.authorize('wsp_01JABCDEF0123456789ABCDEFG', reference)).rejects.toBe(
      failure
    )
  })
  test('pins immutable published content while later graph versions are added', async () => {
    const catalog = new GraphDefinitionCatalog(new InMemoryGraphDefinitionRepository())
    const first = await catalog.publish({ definition: definition('1.0.0'), publishedAt })
    const pinned = await catalog.resolveForNewExecution(first.reference, environment)
    await catalog.publish({ definition: definition('2.0.0', '-v2'), publishedAt })
    expect((await catalog.getPinned(pinned.reference)).content.nodes[0].operation.name).toBe('plan')
    await expect(
      catalog.publish({ definition: definition('1.0.0', '-mutated'), publishedAt })
    ).rejects.toMatchObject({ code: 'GRAPH_VERSION_CONFLICT' })
  })

  test('blocks deprecated, revoked, and incompatible new executions without rewriting history', async () => {
    const catalog = new GraphDefinitionCatalog(new InMemoryGraphDefinitionRepository())
    const published = await catalog.publish({ definition: definition('1.0.0'), publishedAt })
    await expect(
      catalog.resolveForNewExecution(published.reference, {
        ...environment,
        adapterVersion: '2.0.0',
      })
    ).rejects.toMatchObject({ code: 'GRAPH_INCOMPATIBLE' })
    const deprecated = await catalog.deprecate({
      reference: published.reference,
      expectedRevision: 1,
      changedAt: '2026-08-25T14:00:00.000Z',
      reason: 'replacement published',
    })
    await expect(
      catalog.resolveForNewExecution(published.reference, environment)
    ).rejects.toMatchObject({ code: 'GRAPH_DEPRECATED' })
    const revoked = await catalog.revoke({
      reference: published.reference,
      expectedRevision: deprecated.revision,
      changedAt: '2026-08-25T15:00:00.000Z',
      reason: 'unsafe topology',
    })
    expect((await catalog.getPinned(revoked.reference)).reference).toEqual(published.reference)
    await expect(
      catalog.resolveForNewExecution(published.reference, environment)
    ).rejects.toBeInstanceOf(GraphCatalogError)
  })

  test('keeps checkpoint lineage execution-scoped and separate from ProjectState', () => {
    const checkpoint = GraphCheckpointRecordSchema.parse({
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      threadId: 'thread-manager-1',
      checkpointId: 'checkpoint-2',
      parentCheckpointId: 'checkpoint-1',
      graph: {
        graphDefinitionId: 'manager-graph',
        graphVersion: '1.0.0',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      },
      compilerVersion: '1.0.0',
      adapterVersion: '1.4.12',
      state: 'active',
      createdAt: publishedAt,
      expiresAt: '2026-09-25T13:00:00.000Z',
    })
    expect(checkpoint).not.toHaveProperty('projectState')
    expect(checkpoint.parentCheckpointId).toBe('checkpoint-1')
    const policy = { activeDays: 90, completedDays: 30, failedDays: 60 }
    expect(checkpointExpiresAt('active', publishedAt, policy)).toBe('2026-11-23T13:00:00.000Z')
    expect(checkpointExpiresAt('completed', publishedAt, policy)).toBe('2026-09-24T13:00:00.000Z')
  })
})
