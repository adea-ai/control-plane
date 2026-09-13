import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContextPackageAuthoringService,
  ContextCompilationError,
  GrantsBackedContextAuthoringAuthority,
} from '@control-plane/context'
import {
  ContextCommandGrantSchema,
  ContextProviderAdministration,
  ContextProviderRegistrationSchema,
} from '@control-plane/domain'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextProviderRegistrationRepository,
  SqliteProjectStateRepository,
} from '@control-plane/sqlite-persistence'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/src/index.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const nodeId = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const providerRef = 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const itemId = 'psi_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const principalRef = 'principal://authoring/operator-user'
const otherPrincipalRef = 'principal://authoring/unauthorized-user'
const authorizationRef = 'authz:authoring-composition-test'
const scopeDigest = `sha256:${'a'.repeat(64)}`
const sourcePrincipalRef = principalRef
const issuedAt = new Date(Date.now() - 60_000).toISOString()
const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
const capturedAt = new Date(Date.now() - 120_000).toISOString()

function grantFixture() {
  return ContextCommandGrantSchema.parse({
    authorizationRef,
    workspaceId,
    nodeId,
    providerRef,
    principalRef,
    mappedProjectRef: 'fixture-project',
    scopeDigest,
    capabilities: ['boundedRetrieval', 'evidenceSearch', 'memoryRecall'],
    maximumTokens: 4096,
    includeEvidence: true,
    includeMemory: true,
    issuedAt,
    expiresAt,
    status: 'active',
  })
}

function registrationFixture(grant) {
  return ContextProviderRegistrationSchema.parse({
    version: 1,
    readModel: {
      definition: {
        providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        providerType: 'fixture-provider',
        displayName: 'Authoring composition fixture provider',
        contractVersion: '1.0.0',
        latencyClass: 'standard',
        costClass: 'standard',
        capabilities: {
          boundedRetrieval: true,
          evidenceSearch: true,
          memoryRecall: true,
          healthStatus: true,
          memoryWriteProposal: false,
          memoryWriteCommit: false,
        },
      },
      connection: {
        connectionId: 'ctc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        workspaceId: grant.workspaceId,
        principalRef: grant.principalRef,
        scopeDigest: grant.scopeDigest,
        executionLocations: ['cloud', 'runtime_node'],
        reachability: 'remote',
        state: 'active',
      },
      health: { status: 'healthy', checkedAt: issuedAt },
    },
    providerRef: grant.providerRef,
    mappedProjectRef: grant.mappedProjectRef,
    authorizationRef: grant.authorizationRef,
  })
}

function projectStateFixture() {
  return {
    schemaVersion: 1,
    workspaceId,
    projectId,
    revision: 1,
    items: [
      {
        itemId,
        itemRevision: 1,
        key: 'fixture.notes',
        value: { summary: 'provisioned through administration' },
        sensitivity: 'internal',
        freshness: { observedAt: capturedAt },
        provenance: {
          sourceKind: 'principal',
          sourcePrincipalRef,
          artifactRefs: [],
          capturedAt,
        },
        createdAt: capturedAt,
        updatedAt: capturedAt,
      },
    ],
    createdAt: capturedAt,
    updatedAt: capturedAt,
  }
}

function authoringInput() {
  return {
    objective: 'Assemble context from administration-provisioned grants',
    candidates: [{ itemId, itemRevision: 1, required: true, priority: 10 }],
    successCriteria: ['Fixture criteria satisfied'],
    returnContract: { contractRef: 'fixture:return-contract' },
    budgets: { maximumBytes: 65536, maximumTokens: 1024 },
    workspaceId,
    projectId,
    projectStateRevision: 1,
  }
}

/**
 * Composes a Local control plane whose only authoring grants and provider registrations are
 * provisioned strictly through ContextProviderAdministration — the same service the operator
 * CLI drives — over the single SQLite store the composition itself owns.
 */
async function composedComposition(directory) {
  const composition = new LocalControlPlaneComposition({
    dataDirectory: directory,
    runtimeTransport: { transportKind: 'direct-local' },
    workflowRuntime: {
      profile: 'local',
      start: async () => undefined,
      health: async () => ({ ready: true, component: 'restate', version: '1.7.9' }),
      stop: async () => undefined,
    },
    endpointFactory: {
      create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
    },
  })
  await composition.persistence.migrate()
  const administration = new ContextProviderAdministration(
    new SqliteContextCommandGrantRepository(composition.persistence),
    new SqliteContextProviderRegistrationRepository(composition.persistence)
  )
  const grant = grantFixture()
  await administration.apply({ operation: 'grant', grant })
  await administration.apply({
    operation: 'register',
    expectedVersion: 0,
    registration: registrationFixture(grant),
  })
  return { composition, administration }
}

test('local composition wires a grants-backed authority from administration-provisioned stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-authoring-'))
  let composition
  let administration
  try {
    ;({ composition, administration } = await composedComposition(directory))
    const authoring = composition.executionValidationService.options.contextAuthoring

    // The supported default is the grants-backed authority over the composition's stores.
    expect(authoring).toBeInstanceOf(ContextPackageAuthoringService)
    expect(authoring.options.authority).toBeInstanceOf(GrantsBackedContextAuthoringAuthority)
    // ProjectState content is a repository fixture (it has no administration port); only
    // the grant and registration provisioning must go through ContextProviderAdministration.
    expect(
      await new SqliteProjectStateRepository(composition.persistence).create(projectStateFixture())
    ).toBe(true)

    // The granted principal authors context through the composed default authority; the
    // disabled local provider policy degrades authoring to the no-provider path.
    const reference = await authoring.create(principalRef, authoringInput())
    const package_ = await composition.contextPackages.getById(reference.contextPackageId)
    expect(package_).toMatchObject({
      projectState: { workspaceId, projectId, revision: 1 },
      stateItems: [{ itemId }],
    })
    expect(package_.constraints.allowedStateItemIds).toEqual([itemId])
    expect(package_.providerComposition).toBeUndefined()

    // A principal without a current grant is denied before any compilation.
    await expect(authoring.create(otherPrincipalRef, authoringInput())).rejects.toThrow(
      new ContextCompilationError('UNAUTHORIZED_CONTEXT').message
    )

    // Revoking the grant through the operator administration denies the same principal.
    await administration.apply({ operation: 'revoke', workspaceId, authorizationRef })
    await expect(
      authoring.options.authority.authorize(principalRef, authoringInput())
    ).resolves.toBeUndefined()
    await expect(authoring.create(principalRef, authoringInput())).rejects.toThrow(
      new ContextCompilationError('UNAUTHORIZED_CONTEXT').message
    )
  } finally {
    if (composition !== undefined) {
      await composition.close()
      composition.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}, 30000)
