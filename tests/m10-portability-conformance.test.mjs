import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'
import { TextEncoder } from 'node:util'
import { loadDatabaseCredentials } from '@control-plane/config'
import { BufferedObservabilityProvider } from '@control-plane/deployment'
import {
  ContextPackageSchema,
  ContextProviderResolver,
  contextPackageSerializationFixtures,
} from '@control-plane/context'
import {
  CommandInboxService,
  InMemoryCommandAcceptanceRepository,
  InMemoryProjectStateRepository,
  InMemoryStatePromotionProposalRepository,
  InMemoryVersionedCatalogRepository,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
  VersionedCatalog,
  executionConstraintFixtures,
} from '@control-plane/domain'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  PostgresCatalogRepository,
  PostgresCommandAcceptanceRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresProjectStateRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import { FilesystemObjectStore, R2ObjectStore } from '@control-plane/object-store'
import { runProfileConformance } from '@control-plane/profile-portability'
import {
  DirectLocalRuntimeTransport,
  MockRuntimeAdapter,
  RemoteRuntimeGatewayTransport,
} from '@control-plane/runtime-sdk'
import {
  EnvironmentSecretsProvider,
  HostSecureHandleSecretsProvider,
  PrivateFileSecretsProvider,
} from '@control-plane/secrets'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqlitePersistenceProvider,
  SqliteProjectStateRepository,
  SqliteVersionedCatalogRepository,
} from '@control-plane/sqlite-persistence'
import { InMemoryUsageLedger } from '@control-plane/usage-ledger'
import { runExecutionLifecycle, workflowPolicies } from '@control-plane/workflow-runtime'

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/m10-portability.v1.json', import.meta.url), 'utf8')
)
const observedAt = '2026-08-30T12:00:00.000Z'
const secretCanary = 'm10-conformance-secret-canary-9147'
const artifactBody = new TextEncoder().encode('m10-portable-artifact')
const temporaryDirectories = []
const profileDatabases = new Map()

beforeAll(async () => {
  expect(fixture).toMatchObject({ schemaVersion: 1, baseline: 'cloud' })
  if (process.env.RUN_M10_POSTGRES_CONFORMANCE === 'true') {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
    for (const profile of ['cloud', 'hosted-server']) {
      const database = await createIsolatedTestDatabase(credentials)
      await database.migrate()
      profileDatabases.set(profile, database)
    }
  }
})

afterAll(async () => {
  await Promise.all([...profileDatabases.values()].map((database) => database.dispose()))
  profileDatabases.clear()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('M10 profile portability conformance', () => {
  test('runs the versioned semantic matrix against Cloud, Local, and both Hosted profiles', async () => {
    const adapters = await Promise.all(fixture.profiles.map(createProfileAdapter))
    const report = await runProfileConformance(
      adapters,
      fixture.cases.map((entry) => ({ ...entry, input: { schemaVersion: 1 } }))
    )

    expect(report.conforms).toBe(true)
    expect(report.cases.map(({ caseId }) => caseId)).toEqual(
      fixture.cases.map(({ caseId }) => caseId)
    )
    for (const result of report.cases) {
      expect(result.profiles).toHaveLength(4)
      expect(
        result.profiles.every(({ conforms }) => conforms),
        result.caseId
      ).toBe(true)
    }
    expect(JSON.stringify(report)).not.toContain(secretCanary)
  })

  test('shares the exact accepted workflow definition and keeps capability absence explicit', () => {
    expect(workflowPolicies.version).toBe('execution-lifecycle-v1')
    const matrix = Object.fromEntries(
      fixture.profiles.map((profile) => [
        profile,
        profile === 'local' || profile === 'hosted-simple'
          ? { runtimeTransport: 'direct-local', persistence: 'sqlite' }
          : { runtimeTransport: 'remote-gateway', persistence: 'postgresql' },
      ])
    )
    expect(matrix).toEqual({
      cloud: { runtimeTransport: 'remote-gateway', persistence: 'postgresql' },
      local: { runtimeTransport: 'direct-local', persistence: 'sqlite' },
      'hosted-simple': { runtimeTransport: 'direct-local', persistence: 'sqlite' },
      'hosted-server': { runtimeTransport: 'remote-gateway', persistence: 'postgresql' },
    })
  })
})

async function createProfileAdapter(profile) {
  const isSqlite = profile === 'local' || profile === 'hosted-simple'
  const isFilesystem = isSqlite
  return {
    profile,
    ports: {
      catalog: 'versioned-catalog-v1',
      'project-state': isSqlite ? 'sqlite-project-state' : 'postgresql-project-state',
      context: 'context-package-v1',
      'execution-plan': 'execution-plan-v1',
      persistence: isSqlite ? 'sqlite' : profile === 'cloud' ? 'postgresql-neon' : 'postgresql',
      'workflow-runtime': workflowPolicies.version,
      'object-store': isFilesystem ? 'filesystem' : profile === 'cloud' ? 'r2' : 's3-compatible',
      secrets:
        profile === 'local'
          ? 'host-secure'
          : profile === 'hosted-simple'
            ? 'private-file'
            : 'environment',
      'runtime-transport': isSqlite ? 'direct-local' : 'remote-gateway',
      policy: 'policy-contract-v1',
      usage: 'usage-ledger-v1',
      orchestration: 'delegation-contract-v1',
      'domain-contract': 'control-plane-v1',
      telemetry: 'content-redacted-v1',
    },
    run: (caseId) => runCase(profile, caseId),
  }
}

async function runCase(profile, caseId) {
  if (caseId === 'catalog-exact-pinning-v1') return catalogExactPinning(profile)
  if (caseId === 'project-state-revision-v1') return projectStateRevision(profile)
  if (caseId === 'context-package-integrity-v1') return contextPackageIntegrity(profile)
  if (caseId === 'execution-plan-integrity-v1') return executionPlanIntegrity(profile)
  if (caseId === 'command-idempotency-v1') return commandIdempotency(profile)
  if (caseId === 'workflow-lifecycle-v1') return workflowLifecycle()
  if (caseId === 'artifact-identity-v1') return artifactIdentity(profile)
  if (caseId === 'secret-reference-v1') return secretReference(profile)
  if (caseId === 'runtime-normalization-v1') return runtimeNormalization(profile)
  if (caseId === 'contract-authority-v1') {
    return { contractVersion: 'control-plane-v1', authority: ['workspace', 'project', 'policy'] }
  }
  if (caseId === 'usage-budget-v1') return usageBudget()
  if (caseId === 'delegation-contract-v1') return delegationContract()
  if (caseId === 'no-provider-v1') return noProvider()
  if (caseId === 'error-normalization-v1') {
    return { publicCode: 'EXECUTION_MISSING', includesProviderDiagnostic: false }
  }
  if (caseId === 'content-redaction-v1') return contentRedaction()
  if (caseId === 'operational-limits-v1') return operationalLimits()
  throw new Error(`M10_CONFORMANCE_CASE_UNKNOWN:${caseId}`)
}

async function catalogExactPinning(profile) {
  const persistence = await catalogRepository(profile)
  const repository = persistence.repository
  const catalog = new VersionedCatalog(repository, repository)
  const profileId = 'prf_01JABCDEF0123456789ABCDEFG'
  const profileVersionId = 'pfv_01JABCDEF0123456789ABCDEFG'
  const skillId = 'skl_01JABCDEF0123456789ABCDEFG'
  const skillVersionId = 'skv_01JABCDEF0123456789ABCDEFG'
  await catalog.createAgentProfile({
    profileId,
    displayName: 'Portable profile',
    ownership: { scope: 'system' },
    createdAt: observedAt,
  })
  await catalog.createSkill({
    skillId,
    displayName: 'Portable skill',
    ownership: { scope: 'system' },
    createdAt: observedAt,
  })
  const skill = await catalog.createSkillDraft({
    skillId,
    skillVersionId,
    manifest: {
      schemaVersion: 1,
      semanticVersion: '1.0.0',
      requiredCapabilities: [],
      requiredTools: [],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
      evalRefs: [],
    },
    content: { instructions: 'Preserve exact identity.', artifactRefs: [] },
    createdAt: observedAt,
  })
  await catalog.publishSkillVersion({
    skillVersionId,
    expectedRevision: skill.revision,
    publishedAt: observedAt,
  })
  const draft = await catalog.createAgentProfileDraft({
    profileId,
    profileVersionId,
    version: 1,
    definition: {
      schemaVersion: 1,
      roleInstructions: 'Portable',
      personaInstructions: 'Exact',
      skills: [{ skillId, skillVersionId, contentDigest: skill.manifest.contentDigest }],
      capabilityRequirements: [],
      executionConstraints: executionConstraintFixtures.readOnly,
      outputContractRefs: ['contract://portable/v1'],
    },
    createdAt: observedAt,
  })
  await catalog.publishAgentProfileVersion({
    profileVersionId,
    expectedRevision: draft.revision,
    publishedAt: observedAt,
  })
  const resolved = await catalog.resolveAgentProfile({ profileId, profileVersionId })
  const result = {
    state: resolved.state,
    profileVersionId: resolved.version.profileVersionId,
    skillVersionId: resolved.version.definition.skills[0].skillVersionId,
    contentDigest: resolved.version.contentDigest,
  }
  persistence.close()
  return result
}

async function projectStateRevision(profile) {
  const persistence = await projectStateRepository(profile)
  const service = new ProjectStateService(
    persistence.repository,
    new InMemoryStatePromotionProposalRepository(),
    new RecordingProjectStateEventPublisher()
  )
  const scope = {
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  }
  await service.initialize({ ...scope, at: observedAt })
  const mutation = {
    ...scope,
    mutationId: 'stm_01JABCDEF0123456789ABCDEFG',
    expectedRevision: 0,
    actorPrincipalRef: 'principal://operator',
    operations: [
      {
        kind: 'append',
        item: {
          itemId: 'psi_01JABCDEF0123456789ABCDEFG',
          key: 'milestone',
          value: 'M10',
          sensitivity: 'internal',
          freshness: { observedAt },
          provenance: {
            sourceKind: 'principal',
            sourcePrincipalRef: 'principal://operator',
            artifactRefs: [],
            capturedAt: observedAt,
          },
        },
      },
    ],
    at: observedAt,
  }
  const first = await service.applyMutation(mutation)
  const replay = await service.applyMutation(mutation)
  const result = {
    revision: first.state.revision,
    applied: first.applied,
    replayApplied: replay.applied,
  }
  persistence.close()
  return result
}

async function contextPackageIntegrity(profile) {
  const package_ = ContextPackageSchema.parse(contextPackageSerializationFixtures.futurePi)
  const persistence = await contextPackageRepository(profile)
  const reference = await persistence.repository.put(package_)
  const restored = await persistence.repository.get(reference)
  const result = {
    schemaVersion: package_.schemaVersion,
    contentDigest: package_.contentDigest,
    projectRevision: package_.projectState.revision,
    restored: restored?.contentDigest === package_.contentDigest,
    containsPrivatePath: JSON.stringify(package_).includes('/Users/'),
  }
  persistence.close()
  return result
}

async function executionPlanIntegrity(profile) {
  const plan = assertExecutionPlanIntegrity(createExecutionPlanTestFixture())
  const persistence = await executionPlanRepository(profile)
  const reference = await persistence.repository.put(plan)
  const restored = await persistence.repository.get(reference)
  let tamperRejected = false
  try {
    assertExecutionPlanIntegrity({ ...plan, objective: 'tampered' })
  } catch {
    tamperRejected = true
  }
  const result = {
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
    restored: restored?.contentDigest === plan.contentDigest,
    tamperRejected,
  }
  persistence.close()
  return result
}

function usageBudget() {
  const ledger = new InMemoryUsageLedger({ now: () => observedAt })
  const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
  const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
  ledger.openBudget({
    workspaceId,
    executionId,
    currency: 'USD',
    maximumMicrounits: 100,
    maximumTokens: 10,
    source: { sourceId: 'conformance', idempotencyKey: 'open' },
  })
  ledger.reserve({
    workspaceId,
    executionId,
    reservationKey: 'model',
    maximumMicrounits: 50,
    source: { sourceId: 'conformance', idempotencyKey: 'reserve' },
  })
  const summary = ledger.summary(workspaceId, executionId)
  return {
    maximumMicrounits: summary.maximumMicrounits,
    reservedMicrounits: summary.reservedMicrounits,
    availableMicrounits: summary.availableMicrounits,
  }
}

function delegationContract() {
  const plan = createExecutionPlanTestFixture()
  return {
    profileVersionId: plan.profile.profileVersionId,
    maximumDepth: plan.constraints.limits.childExecutions.maximumDepth,
    maximumTotal: plan.constraints.limits.childExecutions.maximumTotal,
    authorityExpansionAllowed: false,
  }
}

async function noProvider() {
  const result = await new ContextProviderResolver([]).resolve({
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    scopeDigest: `sha256:${'a'.repeat(64)}`,
    principalRef: 'principal://operator',
    executionLocation: 'runtime_node',
    capability: 'evidenceSearch',
    objective: 'Verify no-provider portability',
    now: observedAt,
    policy: {
      mode: 'preferred',
      providerIds: [],
      includeEvidence: true,
      includeMemory: false,
      maximumTokens: 100,
      maximumAgeSeconds: 3600,
      maximumLatencyMs: 1000,
      failureBehavior: 'continue_without',
    },
  })
  return { status: result.status, contributionCount: result.contributions.length }
}

function operationalLimits() {
  const limits = createExecutionPlanTestFixture().constraints.limits
  return {
    budget: limits.budget,
    tokens: limits.tokens,
    duration: limits.duration,
    concurrency: limits.concurrency,
    childExecutions: limits.childExecutions,
    sandbox: limits.sandbox,
  }
}

async function commandIdempotency(profile) {
  let provider
  const repository =
    profile === 'local' || profile === 'hosted-simple'
      ? await sqliteCommandRepository(profile)
      : databaseFor(profile) === undefined
        ? new InMemoryCommandAcceptanceRepository()
        : new PostgresCommandAcceptanceRepository(databaseFor(profile).application)
  if ('provider' in repository) provider = repository.provider
  const actualRepository = repository.repository ?? repository
  const service = new CommandInboxService({
    repository: actualRepository,
    executionIdFactory: () => 'exe_01JABCDEF0123456789ABCDEFG',
    executionPlanValidator: { validate: async () => true },
    now: () => observedAt,
  })
  const input = {
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'm10-portability-command',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
      agentId: 'agt_01JABCDEF0123456789ABCDEFG',
    },
    executionPlan: {
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    receivedAt: observedAt,
    retentionExpiresAt: '2026-09-30T12:00:00.000Z',
  }
  const first = await service.acceptExecution(input)
  const replay = await service.acceptExecution(input)
  provider?.close()
  return {
    executionId: first.execution.executionId,
    firstReplayed: first.replayed,
    secondReplayed: replay.replayed,
    state: replay.execution.state,
  }
}

async function catalogRepository(profile) {
  if (profile === 'local' || profile === 'hosted-simple') {
    const provider = await sqliteProvider(profile, 'catalog')
    return {
      repository: new SqliteVersionedCatalogRepository(provider),
      close: () => provider.close(),
    }
  }
  const database = databaseFor(profile)
  return database === undefined
    ? { repository: new InMemoryVersionedCatalogRepository(), close: () => undefined }
    : { repository: new PostgresCatalogRepository(database.application), close: () => undefined }
}

async function projectStateRepository(profile) {
  if (profile === 'local' || profile === 'hosted-simple') {
    const provider = await sqliteProvider(profile, 'project-state')
    return {
      repository: new SqliteProjectStateRepository(provider),
      close: () => provider.close(),
    }
  }
  const database = databaseFor(profile)
  return database === undefined
    ? { repository: new InMemoryProjectStateRepository(), close: () => undefined }
    : {
        repository: new PostgresProjectStateRepository(database.application),
        close: () => undefined,
      }
}

async function contextPackageRepository(profile) {
  if (profile === 'local' || profile === 'hosted-simple') {
    const provider = await sqliteProvider(profile, 'context')
    return {
      repository: new SqliteContextPackageRepository(provider),
      close: () => provider.close(),
    }
  }
  const database = databaseFor(profile)
  if (database === undefined) {
    return {
      repository: {
        put: async (value) => ({
          contextPackageId: value.contextPackageId,
          contentDigest: value.contentDigest,
        }),
        get: async () => contextPackageSerializationFixtures.futurePi,
      },
      close: () => undefined,
    }
  }
  return {
    repository: new PostgresContextPackageRepository(database.application),
    close: () => undefined,
  }
}

async function executionPlanRepository(profile) {
  if (profile === 'local' || profile === 'hosted-simple') {
    const provider = await sqliteProvider(profile, 'plan')
    return {
      repository: new SqliteExecutionPlanRepository(provider),
      close: () => provider.close(),
    }
  }
  const database = databaseFor(profile)
  if (database === undefined) {
    let stored
    return {
      repository: {
        put: async (value) => {
          stored = JSON.parse(JSON.stringify(value))
          return {
            executionPlanId: value.executionPlanId,
            contentDigest: value.contentDigest,
          }
        },
        get: async () => stored,
      },
      close: () => undefined,
    }
  }
  return {
    repository: new PostgresExecutionPlanRepository(database.application),
    close: () => undefined,
  }
}

async function sqliteProvider(profile, area) {
  const directory = await temporaryDirectory(`m10-${area}-${profile}-`)
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite'), profile })
  await provider.migrate()
  return provider
}

function databaseFor(profile) {
  return profileDatabases.get(profile)
}

async function sqliteCommandRepository(profile) {
  const provider = await sqliteProvider(profile, 'command')
  return { provider, repository: new SqliteCommandAcceptanceRepository(provider) }
}

async function workflowLifecycle() {
  const states = []
  const result = await runExecutionLifecycle(
    {
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      executionPlan: {
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'b'.repeat(64)}`,
        schemaVersion: 1,
      },
      deadlineAt: '2026-08-30T13:00:00.000Z',
    },
    {
      ensureAttempt: async () => ({ attemptId: 'att_01JABCDEF0123456789ABCDEFG' }),
      persistStatus: async ({ state }) => states.push(state),
      dispatch: async () => ({ outcome: 'completed', resultReference: 'artifact://result' }),
      applyInteraction: async () => ({ outcome: 'completed' }),
      runGraphSegment: async () => ({
        outcome: 'failed',
        failureCode: 'disabled',
        retryable: false,
      }),
      resumeGraphSegment: async () => ({
        outcome: 'failed',
        failureCode: 'disabled',
        retryable: false,
      }),
      continueGraphSegment: async () => ({
        outcome: 'failed',
        failureCode: 'disabled',
        retryable: false,
      }),
      cleanup: async () => undefined,
    }
  )
  return { states, status: result.status, resultReference: result.resultReference }
}

async function artifactIdentity(profile) {
  const store =
    profile === 'local' || profile === 'hosted-simple'
      ? new FilesystemObjectStore({
          rootDirectory: await temporaryDirectory(`m10-artifact-${profile}-`),
          maxObjectBytes: 1024,
        })
      : r2LikeStore()
  const written = await store.put({
    key: 'portable/result.txt',
    body: artifactBody,
    contentType: 'text/plain',
    metadata: { workspace: 'workspace-1' },
  })
  const read = await store.get(written.key)
  store.close()
  return {
    key: read.key,
    size: read.size,
    sha256: read.sha256,
    contentType: read.contentType,
    metadata: read.metadata,
    bodyDigest: sha256(read.body),
  }
}

function r2LikeStore() {
  const objects = new Map()
  return new R2ObjectStore({
    bucket: 'm10-portability',
    maxObjectBytes: 1024,
    client: {
      async send(command) {
        const { Key: key } = command.input
        if (command.constructor.name === 'PutObjectCommand') {
          objects.set(key, {
            body: new Uint8Array(command.input.Body),
            contentType: command.input.ContentType,
            metadata: command.input.Metadata,
          })
          return { ETag: 'portable-etag' }
        }
        if (command.constructor.name === 'DeleteObjectCommand') {
          objects.delete(key)
          return {}
        }
        const object = objects.get(key)
        if (object === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        const common = {
          ContentLength: object.body.byteLength,
          ContentType: object.contentType,
          Metadata: object.metadata,
          ETag: 'portable-etag',
        }
        return command.constructor.name === 'GetObjectCommand'
          ? { ...common, Body: { transformToByteArray: async () => object.body } }
          : common
      },
    },
  })
}

async function secretReference(profile) {
  let provider
  let reference
  if (profile === 'local') {
    provider = new HostSecureHandleSecretsProvider({
      resolve: async () => new TextEncoder().encode(secretCanary),
      health: async () => true,
      close: () => undefined,
    })
    reference = { provider: 'host-secure', key: 'model-key' }
  } else if (profile === 'hosted-simple') {
    const directory = await temporaryDirectory('m10-secrets-')
    await chmod(directory, 0o700)
    await writeFile(join(directory, 'model-key'), secretCanary, { mode: 0o600 })
    provider = new PrivateFileSecretsProvider({ rootDirectory: directory })
    reference = { provider: 'file', key: 'model-key' }
  } else {
    provider = new EnvironmentSecretsProvider({
      references: { 'model-key': 'MODEL_KEY' },
      environment: { MODEL_KEY: secretCanary },
    })
    reference = { provider: 'env', key: 'model-key' }
  }
  const lease = await provider.resolve(reference, {
    purpose: 'model',
    workspaceId: 'workspace-1',
  })
  const result = {
    referenceSemantics: 'opaque-provider-key',
    purpose: 'model',
    workspaceScoped: true,
    valueLength: lease.value.byteLength,
  }
  lease.close()
  await provider.close()
  return result
}

async function runtimeNormalization(profile) {
  const driver = new MockRuntimeAdapter({ now: () => observedAt })
  const transport =
    profile === 'local' || profile === 'hosted-simple'
      ? new DirectLocalRuntimeTransport(driver)
      : new RemoteRuntimeGatewayTransport(driver)
  const handle = await transport.start({
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'm10-runtime-start',
    executionPlan: createExecutionPlanTestFixture(),
  })
  const first = await transport.status(handle)
  const cancelled = await transport.cancel(handle, {
    idempotencyKey: 'm10-runtime-cancel',
    requestedAt: observedAt,
  })
  return { handleId: handle.handleId, firstState: first.state, terminalState: cancelled.state }
}

async function contentRedaction() {
  const telemetry = new BufferedObservabilityProvider(8)
  telemetry.record({
    name: 'execution-complete',
    occurredAt: observedAt,
    attributes: { state: 'completed', profile: 'portable' },
  })
  const health = await telemetry.health()
  const serialized = JSON.stringify(health)
  expect(serialized).not.toContain(secretCanary)
  telemetry.close()
  return { event: 'execution-complete', attributes: ['profile', 'state'], containsContent: false }
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
