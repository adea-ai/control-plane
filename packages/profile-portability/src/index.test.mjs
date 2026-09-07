import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextEncoder } from 'node:util'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { executionValidationCommandKey } from '@control-plane/execution-plan'
import {
  contextPackageSerializationFixtures,
  contextAuthoringCommandKey,
} from '@control-plane/context'
import {
  SqlitePersistenceProvider,
  SqliteProjectStateRepository,
  SqliteVersionedCatalogRepository,
} from '@control-plane/sqlite-persistence'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  PortableMigrationError,
  applyPortableImport,
  assertPortableManifest,
  exportPortableState,
  finalizePortableManifest,
  planPortableImport,
  runProfileConformance,
} from './index.ts'

const createdAt = '2026-08-30T12:00:00.000Z'
const secretCanary = 'portable-secret-canary-7834'
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true }))
  )
})

function source(overrides = {}) {
  return {
    profile: 'local',
    persistence: 'sqlite',
    objectStore: 'filesystem',
    componentVersions: { workflow: 'execution-lifecycle-v1', contracts: '1.0.0' },
    snapshot: async () => ({
      records: [
        {
          category: 'project-state',
          logicalId: 'prj_01JABCDEF0123456789ABCDEFG',
          revision: 2,
          value: { objective: 'ship-portability', provenance: 'principal://operator' },
        },
        {
          category: 'agent-profile',
          logicalId: 'apv_01JABCDEF0123456789ABCDEFG',
          revision: 1,
          value: { semanticVersion: '1.0.0', lifecycle: 'published' },
        },
        {
          category: 'selected-history',
          logicalId: 'exe_01JABCDEF0123456789ABCDEFG',
          revision: 1,
          value: { state: 'completed' },
        },
      ],
      artifacts: [artifact('artifacts/result.json', 'portable-artifact')],
      secretReferences: [{ provider: 'host-secure', key: 'model-key', purpose: 'model' }],
      ...overrides,
    }),
  }
}

class MemoryDestination {
  constructor(profile = 'hosted-server', options = {}) {
    this.profile = profile
    this.capabilities = new Set(options.capabilities ?? ['execution', 'artifacts'])
    this.secretProviders = new Set(options.secretProviders ?? ['host-secure'])
    this.records = new Map(options.records ?? [])
    this.provenance = []
    this.rollbacks = 0
    this.failAfter = options.failAfter
  }

  async inspect(records) {
    return records.map((record) => {
      const existing = this.records.get(recordKey(record))
      return {
        record,
        state:
          existing === undefined
            ? 'missing'
            : existing.contentDigest === record.contentDigest
              ? 'equivalent'
              : 'conflict',
      }
    })
  }

  async begin() {
    const staged = new Map()
    let stagedProvenance
    return {
      put: async (record) => {
        if (this.failAfter !== undefined && staged.size >= this.failAfter) {
          throw new Error('SIMULATED_IMPORT_INTERRUPTION')
        }
        staged.set(recordKey(record), clone(record))
      },
      recordProvenance: async (value) => {
        stagedProvenance = clone(value)
      },
      commit: async () => {
        for (const [key, value] of staged) this.records.set(key, value)
        if (stagedProvenance !== undefined) this.provenance.push(stagedProvenance)
      },
      rollback: async () => {
        this.rollbacks += 1
        staged.clear()
      },
    }
  }
}

class MemoryObjectStore {
  constructor(entries = []) {
    this.objects = new Map(entries.map(([key, value]) => [key, new Uint8Array(value)]))
  }

  async put(input) {
    this.objects.set(input.key, new Uint8Array(input.body))
    return descriptor(input.key, input.body, input.contentType, input.metadata)
  }

  async get(key) {
    const body = this.objects.get(key)
    if (body === undefined) throw objectNotFound()
    return { ...descriptor(key, body), body: new Uint8Array(body) }
  }

  async head(key) {
    const body = this.objects.get(key)
    if (body === undefined) throw objectNotFound()
    return descriptor(key, body)
  }

  async delete(key) {
    this.objects.delete(key)
  }

  close() {}
}

describe('portable profile export and import', () => {
  test('requires validation replay records to retain exact scoped plans and logical identities', async () => {
    const plan = createExecutionPlanTestFixture()
    const command = {
      scope: {
        callerPrincipalId: 'svc_portable',
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        operation: 'execution.validate',
        idempotencyKey: 'portable-validation-0001',
      },
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: plan.correlation.requestId,
      recordedAt: createdAt,
      payloadHash: `sha256:${'a'.repeat(64)}`,
      executionPlan: { executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest },
    }
    const planRecord = {
      category: 'execution-plan',
      logicalId: `execution-plans/${plan.executionPlanId}`,
      revision: 0,
      value: plan,
    }
    const commandRecord = {
      category: 'execution-validation-command',
      logicalId: `execution-validation-commands/${executionValidationCommandKey(command.scope)}`,
      revision: 0,
      value: command,
    }
    const manifestFor = async (records) =>
      assertPortableManifest(
        await exportPortableState(source({ records }), {
          exportId: 'validation-fixture',
          createdAt,
        })
      )
    expect(
      assertPortableManifest(await manifestFor([planRecord, commandRecord])).records
    ).toHaveLength(2)
    const otherScope = { ...command.scope, workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' }
    const aliasId = 'pln_01JBBCDEF0123456789ABCDEFG'
    for (const records of [
      [commandRecord],
      [
        planRecord,
        { ...commandRecord, logicalId: `execution-validation-commands/${'0'.repeat(64)}` },
      ],
      [
        planRecord,
        {
          ...commandRecord,
          logicalId: `execution-validation-commands/${executionValidationCommandKey(otherScope)}`,
          value: { ...command, scope: otherScope },
        },
      ],
      [
        planRecord,
        {
          ...commandRecord,
          value: {
            ...command,
            executionPlan: { ...command.executionPlan, contentDigest: `sha256:${'0'.repeat(64)}` },
          },
        },
      ],
      [
        planRecord,
        { ...commandRecord, value: { ...command, requestId: 'req_01JBBCDEF0123456789ABCDEFG' } },
      ],
      [
        { ...planRecord, logicalId: `execution-plans/${aliasId}` },
        {
          ...commandRecord,
          value: {
            ...command,
            executionPlan: { ...command.executionPlan, executionPlanId: aliasId },
          },
        },
      ],
    ])
      await expect(manifestFor(records)).rejects.toThrow()
  })

  test('requires authoring replay identities to retain their exact scoped package', async () => {
    const package_ = contextPackageSerializationFixtures.futurePi
    const command = {
      scope: {
        principalRef: 'service:portable',
        workspaceId: package_.projectState.workspaceId,
        projectId: package_.projectState.projectId,
        operation: 'context.author',
        idempotencyKey: 'portable-authoring-0001',
      },
      payloadHash: `sha256:${'a'.repeat(64)}`,
      contextPackage: {
        contextPackageId: package_.contextPackageId,
        contentDigest: package_.contentDigest,
      },
    }
    const packageRecord = {
      category: 'context-package',
      logicalId: `context-packages/${package_.contextPackageId}`,
      revision: 0,
      value: package_,
    }
    const commandRecord = {
      category: 'context-authoring-command',
      logicalId: `context-authoring-commands/${contextAuthoringCommandKey(command.scope)}`,
      revision: 0,
      value: command,
    }
    const manifestFor = (records) =>
      exportPortableState(source({ records }), { exportId: 'authoring-fixture', createdAt })
    expect(
      assertPortableManifest(await manifestFor([packageRecord, commandRecord])).records
    ).toHaveLength(2)
    const otherScope = { ...command.scope, workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' }
    const aliasId = 'ctx_01JBBCDEF0123456789ABCDEFG'
    for (const records of [
      [commandRecord],
      [
        packageRecord,
        {
          ...commandRecord,
          logicalId: `context-authoring-commands/${contextAuthoringCommandKey(otherScope)}`,
          value: { ...command, scope: otherScope },
        },
      ],
      [
        { ...packageRecord, logicalId: `context-packages/${aliasId}` },
        {
          ...commandRecord,
          value: {
            ...command,
            contextPackage: { ...command.contextPackage, contextPackageId: aliasId },
          },
        },
      ],
      [
        packageRecord,
        { ...commandRecord, logicalId: `context-authoring-commands/${'0'.repeat(64)}` },
      ],
      [
        packageRecord,
        {
          ...commandRecord,
          value: {
            ...command,
            contextPackage: {
              ...command.contextPackage,
              contentDigest: `sha256:${'0'.repeat(64)}`,
            },
          },
        },
      ],
    ]) {
      await expect(
        (async () => assertPortableManifest(await manifestFor(records)))()
      ).rejects.toThrow()
    }
  })
  test('creates a deterministic, versioned, digest-verified manifest without history by default', async () => {
    const first = await exportPortableState(source(), {
      exportId: 'export-1',
      createdAt,
      requiredCapabilities: ['artifacts', 'execution', 'execution'],
      sensitiveValues: [secretCanary],
    })
    const second = await exportPortableState(source(), {
      exportId: 'export-1',
      createdAt,
      requiredCapabilities: ['execution', 'artifacts'],
      sensitiveValues: [secretCanary],
    })

    expect(first).toEqual(second)
    expect(first.records.map(({ category }) => category)).toEqual([
      'agent-profile',
      'project-state',
    ])
    expect(first.compatibility.requiredCapabilities).toEqual(['artifacts', 'execution'])
    expect(JSON.stringify(first)).not.toContain(secretCanary)
    expect(assertPortableManifest(first)).toEqual(first)
    expect(() =>
      assertPortableManifest({
        ...first,
        records: [{ ...first.records[0], revision: 99 }, ...first.records.slice(1)],
      })
    ).toThrow()
  })

  test('blocks active work, secret canaries, credential fields, and private absolute paths', async () => {
    await expect(
      exportPortableState(source({ activeWorkIds: ['exe_active'] }), {
        exportId: 'export-active',
        createdAt,
      })
    ).rejects.toMatchObject({ code: 'PORTABLE_ACTIVE_WORK', details: ['exe_active'] })
    await expect(
      exportPortableState(
        source({
          records: [
            {
              category: 'policy-configuration',
              logicalId: 'policy-1',
              revision: 1,
              value: { note: secretCanary },
            },
          ],
        }),
        { exportId: 'export-secret', createdAt, sensitiveValues: [secretCanary] }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_SENSITIVE_VALUE' })
    for (const value of [{ accessToken: 'opaque' }, { repositoryPath: '/Users/operator/code' }]) {
      await expect(
        exportPortableState(
          source({
            records: [
              {
                category: 'runtime-configuration',
                logicalId: 'runtime-1',
                revision: 1,
                value,
              },
            ],
          }),
          { exportId: 'export-unsafe', createdAt }
        )
      ).rejects.toBeInstanceOf(PortableMigrationError)
    }
  })

  test('inspects the complete manifest payload before export and import planning', async () => {
    const unsafeArtifact = artifact('artifacts/unsafe.json', 'unsafe')
    await expect(
      exportPortableState(
        source({ artifacts: [{ ...unsafeArtifact, metadata: { accessToken: 'opaque' } }] }),
        { exportId: 'export-artifact-token', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_SENSITIVE_VALUE', details: ['accessToken'] })
    await expect(
      exportPortableState(
        source({
          artifacts: [
            { ...unsafeArtifact, metadata: { sourceLocation: '/Users/operator/private.json' } },
          ],
        }),
        { exportId: 'export-artifact-path', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_PRIVATE_PATH' })
    await expect(
      exportPortableState(
        source({
          secretReferences: [
            { provider: 'host-secure', key: '/Users/operator/.secrets/model', purpose: 'model' },
          ],
        }),
        { exportId: 'export-secret-path', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_PRIVATE_PATH' })
    for (const metadata of [
      { clientSecret: 'opaque' },
      { apiKey: 'opaque' },
      { credentials: 'opaque' },
      { sourceLocation: '/etc/shadow' },
      { sourceLocation: 'C:/Users/operator/secret.json' },
      { sourceLocation: '\\\\server\\share\\secret.json' },
    ]) {
      await expect(
        exportPortableState(source({ artifacts: [{ ...unsafeArtifact, metadata }] }), {
          exportId: 'export-artifact-unsafe',
          createdAt,
        })
      ).rejects.toBeInstanceOf(PortableMigrationError)
    }
    await expect(
      exportPortableState(source({ unsupportedReferences: [secretCanary] }), {
        exportId: 'export-unsupported-canary',
        createdAt,
        sensitiveValues: [secretCanary],
      })
    ).rejects.toMatchObject({ code: 'PORTABLE_SENSITIVE_VALUE' })
    await expect(
      exportPortableState(source({ unsupportedReferences: ['/Users/operator/private.json'] }), {
        exportId: 'export-unsupported-path',
        createdAt,
      })
    ).rejects.toMatchObject({ code: 'PORTABLE_PRIVATE_PATH' })

    const safeManifest = await exportPortableState(source(), {
      exportId: 'export-import-safety',
      createdAt,
    })
    const unsigned = { ...safeManifest }
    Reflect.deleteProperty(unsigned, 'contentDigest')
    const unsafeManifest = finalizePortableManifest({
      ...unsigned,
      artifacts: [{ ...unsafeArtifact, metadata: { clientSecret: secretCanary } }],
    })
    await expect(planPortableImport(unsafeManifest, new MemoryDestination())).rejects.toMatchObject(
      { code: 'PORTABLE_SENSITIVE_VALUE' }
    )
  })

  test('plans, applies, and idempotently replays Local to Hosted and Hosted to Local', async () => {
    const manifest = await exportPortableState(source(), {
      exportId: 'export-roundtrip',
      createdAt,
      requiredCapabilities: ['execution'],
    })
    const hosted = new MemoryDestination('hosted-server')
    const plan = await planPortableImport(manifest, hosted)
    expect(plan).toMatchObject({ applicable: true, conflicts: [] })
    expect(plan.artifactActions[0].action).toBe('preserve-reference')
    const applied = await applyPortableImport(manifest, plan, hosted, {}, () => createdAt)
    expect(applied).toMatchObject({ outcome: 'applied', provenance: { recordCount: 2 } })

    const replayPlan = await planPortableImport(manifest, hosted)
    const replay = await applyPortableImport(manifest, replayPlan, hosted, {}, () => createdAt)
    expect(replay.outcome).toBe('replayed')
    expect(hosted.records.size).toBe(2)

    const hostedSource = source()
    hostedSource.profile = 'hosted-server'
    hostedSource.persistence = 'postgresql'
    hostedSource.objectStore = 's3-compatible'
    const reverseManifest = await exportPortableState(hostedSource, {
      exportId: 'export-reverse',
      createdAt,
    })
    const local = new MemoryDestination('local')
    const reversePlan = await planPortableImport(reverseManifest, local)
    await expect(applyPortableImport(reverseManifest, reversePlan, local)).resolves.toMatchObject({
      outcome: 'applied',
    })
  })

  test('reports destination conflicts and unresolved capability or secret references before mutation', async () => {
    const manifest = await exportPortableState(source(), {
      exportId: 'export-conflict',
      createdAt,
      requiredCapabilities: ['execution'],
    })
    const conflictRecord = { ...manifest.records[0], contentDigest: `sha256:${'f'.repeat(64)}` }
    const conflict = new MemoryDestination('hosted-server', {
      records: [[recordKey(conflictRecord), conflictRecord]],
    })
    const conflictPlan = await planPortableImport(manifest, conflict)
    expect(conflictPlan.applicable).toBe(false)
    await expect(applyPortableImport(manifest, conflictPlan, conflict)).rejects.toMatchObject({
      code: 'PORTABLE_DESTINATION_CONFLICT',
    })
    expect(conflict.records.size).toBe(1)

    await expect(
      planPortableImport(
        manifest,
        new MemoryDestination('hosted-server', { capabilities: ['artifacts'] })
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_CAPABILITY_MISSING' })
    const unresolved = await planPortableImport(
      manifest,
      new MemoryDestination('hosted-server', { secretProviders: ['env'] })
    )
    expect(unresolved).toMatchObject({ applicable: false })
    expect(unresolved.unresolvedSecretReferences).toEqual(manifest.secretReferences)
  })

  test('copies Artifact bytes only when explicit and rolls back state plus copied bytes on interruption', async () => {
    const body = new TextEncoder().encode('portable-artifact')
    const manifest = await exportPortableState(source(), {
      exportId: 'export-artifact',
      createdAt,
    })
    const sourceStore = new MemoryObjectStore([['artifacts/result.json', body]])
    const destinationStore = new MemoryObjectStore()
    const destination = new MemoryDestination('hosted-server', { failAfter: 1 })
    const options = {
      copyArtifacts: true,
      sourceObjectStore: sourceStore,
      destinationObjectStore: destinationStore,
    }
    const plan = await planPortableImport(manifest, destination, options)
    expect(plan.artifactActions[0].action).toBe('copy')
    await expect(applyPortableImport(manifest, plan, destination, options)).rejects.toThrow(
      'SIMULATED_IMPORT_INTERRUPTION'
    )
    expect(destination.records.size).toBe(0)
    expect(destination.rollbacks).toBe(1)
    expect(destinationStore.objects.size).toBe(0)
  })

  test('moves the supported record subset through real Local and Hosted Simple persistence ports', async () => {
    const sourceProvider = await sqliteProvider('local')
    await sourceProvider.transaction((transaction) =>
      transaction.put({
        namespace: 'agent-profiles',
        id: 'r-b202a70b1574c2ed7a487e52d4a554504890da05469df5542ff883893bce1caf',
        value: {
          profileId: 'prf_01JABCDEF0123456789ABCDEFG',
          displayName: 'Portable profile',
          ownership: { scope: 'system' },
          createdAt,
        },
      })
    )
    const projectState = {
      schemaVersion: 1,
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      revision: 0,
      items: [],
      createdAt,
      updatedAt: createdAt,
    }
    await new SqliteProjectStateRepository(sourceProvider).create(projectState)
    const manifest = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: sourceProvider,
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'export-provider-ports', createdAt }
    )

    const destinationProvider = await sqliteProvider('hosted-simple')
    const destination = new PersistencePortableStateDestination({
      persistence: destinationProvider,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(manifest, destination)
    await expect(
      applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })
    expect(
      await new SqliteVersionedCatalogRepository(destinationProvider).getAgentProfile(
        'prf_01JABCDEF0123456789ABCDEFG'
      )
    ).toMatchObject({
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      displayName: 'Portable profile',
    })
    expect(
      await new SqliteProjectStateRepository(destinationProvider).getAtRevision(
        projectState.workspaceId,
        projectState.projectId,
        0
      )
    ).toEqual(projectState)
    await expect(planPortableImport(manifest, destination)).resolves.toMatchObject({
      applicable: true,
      records: [{ state: 'equivalent' }, { state: 'equivalent' }],
    })
    const replayPlan = await planPortableImport(manifest, destination)
    await expect(
      applyPortableImport(manifest, replayPlan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'replayed' })
    sourceProvider.close()
    destinationProvider.close()
  })
})

describe('deployment profile conformance reporting', () => {
  const ports = (persistence, objectStore, runtimeTransport) => ({
    persistence,
    'workflow-runtime': 'execution-lifecycle-v1',
    'object-store': objectStore,
    secrets: 'SecretsProvider-v1',
    'runtime-transport': runtimeTransport,
    'domain-contract': 'control-plane-v1',
    telemetry: 'content-redacted-v1',
  })

  test('compares every required profile and attributes divergence to the exact port', async () => {
    const output = { logicalState: 'completed', executionId: 'exe_1' }
    const adapters = [
      ['cloud', ports('postgresql-neon', 'r2', 'remote-gateway')],
      ['local', ports('sqlite', 'filesystem', 'direct-local')],
      ['hosted-simple', ports('sqlite', 'filesystem', 'direct-local')],
      ['hosted-server', ports('postgresql', 's3-compatible', 'remote-gateway')],
    ].map(([profile, adapterPorts]) => ({
      profile,
      ports: adapterPorts,
      run: async () => output,
    }))
    const report = await runProfileConformance(adapters, [
      { caseId: 'command-idempotency-v1', owner: 'persistence', input: { commandId: 'cmd_1' } },
      { caseId: 'runtime-normalization-v1', owner: 'runtime-transport', input: {} },
    ])
    expect(report.conforms).toBe(true)
    expect(report.cases[0].profiles.map(({ adapter }) => adapter)).toEqual([
      'postgresql-neon',
      'sqlite',
      'sqlite',
      'postgresql',
    ])

    adapters[3].run = async () => ({ ...output, logicalState: 'failed' })
    const divergence = await runProfileConformance(adapters, [
      { caseId: 'runtime-normalization-v1', owner: 'runtime-transport', input: {} },
    ])
    expect(divergence).toMatchObject({ conforms: false })
    expect(divergence.cases[0].profiles[3]).toMatchObject({
      profile: 'hosted-server',
      adapter: 'remote-gateway',
      conforms: false,
    })
  })
})

function recordKey(record) {
  return `${record.category}:${record.logicalId}:${record.revision}`
}

function artifact(key, text) {
  const body = new TextEncoder().encode(text)
  return descriptor(key, body)
}

function descriptor(key, body, contentType, metadata = {}) {
  return {
    key,
    size: body.byteLength,
    sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    ...(contentType === undefined ? {} : { contentType }),
    metadata,
  }
}

function objectNotFound() {
  return Object.assign(new Error('not found'), { code: 'OBJECT_STORE_NOT_FOUND' })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function sqliteProvider(profile) {
  const directory = await mkdtemp(join(tmpdir(), `profile-portability-${profile}-`))
  temporaryDirectories.push(directory)
  const provider = new SqlitePersistenceProvider({
    path: join(directory, 'state.sqlite'),
    profile,
  })
  await provider.migrate()
  return provider
}
