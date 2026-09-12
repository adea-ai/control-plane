import { describe, expect, test } from 'bun:test'
import { ContextCommandGrantSchema, ContextProviderRegistrationSchema } from '@control-plane/domain'
import { GrantsBackedContextAuthoringAuthority } from './authority.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherWorkspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const principalRef = 'principal://authority/user'
const otherPrincipalRef = 'principal://authority/other'
const authorizationRef = 'authz:authority-test-0001'
const providerRef = 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const scopeDigest = `sha256:${'a'.repeat(64)}`
const otherScopeDigest = `sha256:${'b'.repeat(64)}`
const artifactId = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const now = '2026-08-25T12:00:00.000Z'

const clock = () => new Date(now)

function grantFixture(overrides = {}) {
  return ContextCommandGrantSchema.parse({
    authorizationRef,
    workspaceId,
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    providerRef,
    principalRef,
    mappedProjectRef: 'fixture-project',
    scopeDigest,
    capabilities: ['boundedRetrieval', 'evidenceSearch', 'memoryRecall'],
    maximumTokens: 1024,
    includeEvidence: true,
    includeMemory: true,
    issuedAt: '2026-08-25T11:59:59.000Z',
    expiresAt: '2026-08-25T13:00:00.000Z',
    status: 'active',
    ...overrides,
  })
}

function registrationFixture(overrides = {}) {
  const connection = {
    connectionId: 'ctc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId,
    principalRef,
    scopeDigest,
    executionLocations: ['cloud', 'runtime_node'],
    reachability: 'remote',
    state: 'active',
    ...overrides.connection,
  }
  return ContextProviderRegistrationSchema.parse({
    version: 1,
    readModel: {
      definition: {
        providerId: connection.providerId,
        providerType: 'fixture-provider',
        displayName: 'Authority fixture provider',
        contractVersion: '1.0.0',
        latencyClass: 'standard',
        costClass: 'standard',
        ...overrides.definition,
        capabilities: {
          boundedRetrieval: true,
          evidenceSearch: true,
          memoryRecall: true,
          healthStatus: true,
          memoryWriteProposal: false,
          memoryWriteCommit: false,
          ...overrides.definition?.capabilities,
        },
      },
      connection,
      health: {
        status: 'healthy',
        checkedAt: '2026-08-25T11:00:00.000Z',
        ...overrides.health,
      },
    },
    providerRef,
    mappedProjectRef: 'fixture-project',
    authorizationRef,
    ...overrides.registration,
  })
}

function policyFixture(overrides = {}) {
  return {
    allowedSensitivities: ['public', 'internal'],
    allowedCapabilities: ['boundedRetrieval', 'evidenceSearch', 'memoryRecall'],
    executionLocation: 'runtime_node',
    allowedArtifactIds: [],
    permissions: ['context:read'],
    maximumBytes: 262144,
    maximumTokens: 4096,
    maximumContextTtlSeconds: 3600,
    providerPolicy: {
      mode: 'preferred',
      providerIds: [],
      connectionIds: [],
      includeEvidence: true,
      includeMemory: true,
      maximumTokens: 4096,
      maximumAgeSeconds: 3600,
      maximumProviderHealthAgeSeconds: 60,
      maximumLatencyMs: 10000,
      failureBehavior: 'continue_without',
    },
    ...overrides,
  }
}

function grantRepository(grants) {
  return {
    async get(scopeWorkspaceId, ref) {
      const grant = grants.find(
        (candidate) =>
          candidate.workspaceId === scopeWorkspaceId && candidate.authorizationRef === ref
      )
      return grant === undefined ? undefined : structuredClone(grant)
    },
  }
}

function registrationRepository(registrations) {
  return {
    async list(scope) {
      return registrations
        .filter(
          (registration) =>
            registration.readModel.connection.workspaceId === scope.workspaceId &&
            registration.readModel.connection.principalRef === scope.principalRef
        )
        .map((registration) => structuredClone(registration))
    },
  }
}

function artifactStore(objects = {}, options = {}) {
  return {
    async head(key) {
      if (options.error !== undefined) throw options.error
      const object = objects[key]
      if (object === undefined) throw { code: 'OBJECT_STORE_NOT_FOUND' }
      return {
        key,
        size: object.size,
        contentType: object.contentType,
        sha256: object.sha256,
        metadata: object.metadata ?? {},
      }
    },
  }
}

function authority({
  grants = [grantFixture()],
  registrations = [registrationFixture()],
  policy,
  artifacts,
  now: at = clock,
} = {}) {
  return new GrantsBackedContextAuthoringAuthority({
    grants: grantRepository(grants),
    registrations: registrationRepository(registrations),
    policy: policyFixture(policy),
    ...(artifacts === undefined ? {} : { artifacts }),
    now: at,
  })
}

function authoringRequest(overrides = {}) {
  return {
    objective: 'Assemble fixture context',
    candidates: [
      {
        itemId: 'psi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        itemRevision: 1,
        required: true,
        priority: 10,
      },
    ],
    successCriteria: ['Fixture criteria satisfied'],
    returnContract: { contractRef: 'fixture:return-contract' },
    budgets: { maximumBytes: 131072, maximumTokens: 2048 },
    workspaceId,
    projectId,
    projectStateRevision: 3,
    ...overrides,
  }
}

describe('grants-backed context authoring authority', () => {
  test('denies when no current grant matches the principal and workspace', async () => {
    const unregistered = authority({ registrations: [] })
    expect(await unregistered.authorize(principalRef, authoringRequest())).toBeUndefined()
    expect(await authority().authorize(otherPrincipalRef, authoringRequest())).toBeUndefined()
    expect(
      await authority({
        grants: [grantFixture({ workspaceId: otherWorkspaceId })],
        registrations: [registrationFixture({ connection: { workspaceId: otherWorkspaceId } })],
      }).authorize(principalRef, authoringRequest())
    ).toBeUndefined()
    expect(await authority().authorize('', authoringRequest())).toBeUndefined()
  })

  test('denies revoked, expired and not-yet-issued grants', async () => {
    expect(
      await authority({ grants: [grantFixture({ status: 'revoked' })] }).authorize(
        principalRef,
        authoringRequest()
      )
    ).toBeUndefined()
    expect(
      await authority({
        grants: [grantFixture({ expiresAt: '2026-08-25T11:59:59.500Z' })],
      }).authorize(principalRef, authoringRequest())
    ).toBeUndefined()
    expect(
      await authority({
        grants: [grantFixture({ issuedAt: '2026-08-25T12:00:00.500Z' })],
      }).authorize(principalRef, authoringRequest())
    ).toBeUndefined()
  })

  test('denies malformed requests instead of guessing a decision', async () => {
    expect(await authority().authorize(principalRef, {})).toBeUndefined()
    expect(
      await authority().authorize(
        principalRef,
        authoringRequest({ workspaceId: 'not-a-workspace' })
      )
    ).toBeUndefined()
    expect(
      await authority().authorize(principalRef, authoringRequest({ candidates: [] }))
    ).toBeDefined()
  })

  test('authorizes the requested candidate scope with policy-owned constraints and ceilings', async () => {
    const decision = await authority().authorize(principalRef, authoringRequest())
    expect(decision).toMatchObject({
      workspaceId,
      projectId,
      principalRef,
      expiresAt: '2026-08-25T13:00:00.000Z',
      constraints: {
        allowedSensitivities: ['public', 'internal'],
        allowedStateItemIds: ['psi_01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        allowedArtifactIds: [],
      },
      permissions: ['context:read'],
      budgets: { maximumBytes: 262144, maximumTokens: 4096 },
    })
    const twoCandidates = await authority().authorize(
      principalRef,
      authoringRequest({
        candidates: [
          authoringRequest().candidates[0],
          {
            itemId: 'psi_01ARZ3NDEKTSV4RRFFQ69G5FAW',
            itemRevision: 2,
            required: false,
            priority: 1,
          },
        ],
      })
    )
    expect(twoCandidates.constraints.allowedStateItemIds).toEqual([
      'psi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'psi_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    ])
  })

  test('caps policy expiry at the configured context TTL ceiling', async () => {
    const decision = await authority({
      policy: { maximumContextTtlSeconds: 60 },
    }).authorize(principalRef, authoringRequest())
    expect(decision.expiresAt).toBe('2026-08-25T12:01:00.000Z')
    const grantBound = await authority({
      grants: [grantFixture({ expiresAt: '2026-08-25T12:00:30.000Z' })],
      policy: { maximumContextTtlSeconds: 3600 },
    }).authorize(principalRef, authoringRequest())
    expect(grantBound.expiresAt).toBe('2026-08-25T12:00:30.000Z')
  })

  test('derives the provider request solely from the grant, registration and policy', async () => {
    const decision = await authority().authorize(principalRef, authoringRequest())
    expect(decision.providerRequest).toEqual({
      scopeDigest,
      executionLocation: 'runtime_node',
      capability: 'boundedRetrieval',
      policy: {
        mode: 'preferred',
        providerIds: [],
        connectionIds: [],
        includeEvidence: true,
        includeMemory: true,
        maximumTokens: 1024,
        maximumAgeSeconds: 3600,
        maximumProviderHealthAgeSeconds: 60,
        maximumLatencyMs: 10000,
        failureBehavior: 'continue_without',
      },
    })
  })

  test('selects the first capability granted by the grant and advertised by the provider', async () => {
    const decision = await authority({
      policy: { allowedCapabilities: ['evidenceSearch', 'memoryRecall'] },
    }).authorize(principalRef, authoringRequest())
    expect(decision.providerRequest.capability).toBe('evidenceSearch')
    const fallback = await authority({
      grants: [grantFixture({ capabilities: ['memoryRecall'] })],
      registrations: [
        registrationFixture({
          definition: { capabilities: { evidenceSearch: false, boundedRetrieval: false } },
        }),
      ],
      policy: { allowedCapabilities: ['evidenceSearch', 'memoryRecall'] },
    }).authorize(principalRef, authoringRequest())
    expect(fallback.providerRequest.capability).toBe('memoryRecall')
  })

  test('degrades to the no-provider path when the provider policy is disabled', async () => {
    const decision = await authority({
      policy: {
        providerPolicy: { ...policyFixture().providerPolicy, mode: 'disabled' },
      },
    }).authorize(principalRef, authoringRequest())
    expect(decision.providerRequest).toBeUndefined()
    expect(decision.workspaceId).toBe(workspaceId)
    expect(decision.constraints.allowedStateItemIds).toHaveLength(1)
  })

  test('omits the provider request for retired registrations, scope drift and unsupported locations', async () => {
    const retired = await authority({
      registrations: [registrationFixture({ connection: { state: 'revoked' } })],
    }).authorize(principalRef, authoringRequest())
    expect(retired).toBeUndefined()

    const scopeDrift = await authority({
      registrations: [registrationFixture({ connection: { scopeDigest: otherScopeDigest } })],
    }).authorize(principalRef, authoringRequest())
    expect(scopeDrift).toBeDefined()
    expect(scopeDrift.providerRequest).toBeUndefined()

    const unsupportedLocation = await authority({
      registrations: [registrationFixture({ connection: { executionLocations: ['cloud'] } })],
    }).authorize(principalRef, authoringRequest())
    expect(unsupportedLocation.providerRequest).toBeUndefined()

    const unadvertised = await authority({
      registrations: [
        registrationFixture({
          definition: {
            capabilities: { boundedRetrieval: false, evidenceSearch: false, memoryRecall: false },
          },
        }),
      ],
    }).authorize(principalRef, authoringRequest())
    expect(unadvertised.providerRequest).toBeUndefined()

    const ungranted = await authority({
      grants: [grantFixture({ capabilities: ['memoryRecall'] })],
      policy: { allowedCapabilities: ['boundedRetrieval'] },
    }).authorize(principalRef, authoringRequest())
    expect(ungranted.providerRequest).toBeUndefined()
  })

  test('never derives provider fields from request payload values', async () => {
    const decision = await authority().authorize(
      principalRef,
      authoringRequest({
        candidates: [
          {
            itemId: 'psi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            itemRevision: 1,
            required: true,
            priority: 10,
          },
        ],
      })
    )
    expect(decision.providerRequest.scopeDigest).toBe(scopeDigest)
    expect(JSON.stringify(decision)).not.toContain('fixture-project')
    expect(JSON.stringify(decision.providerRequest)).not.toContain('Assemble fixture context')
  })

  test('rejects an invalid policy at construction', () => {
    expect(() => authority({ policy: { maximumBytes: 0 } })).toThrow()
    expect(() => authority({ policy: { allowedSensitivities: [] } })).toThrow()
    expect(() =>
      authority({
        policy: { providerPolicy: { ...policyFixture().providerPolicy, mode: 'whenever' } },
      })
    ).toThrow()
  })

  test('maps available artifacts from the composition-owned store', async () => {
    const instance = authority({
      policy: { allowedArtifactIds: [artifactId] },
      artifacts: artifactStore({
        [artifactId]: {
          size: 32,
          contentType: 'application/json',
          sha256: `sha256:${'c'.repeat(64)}`,
          metadata: {
            sensitivity: 'internal',
            'workspace-id': workspaceId,
            'project-id': projectId,
          },
        },
      }),
    })
    const artifact = await instance.resolveArtifact({
      principalRef,
      workspaceId,
      projectId,
      artifactId,
    })
    expect(artifact).toMatchObject({
      artifactId,
      contentDigest: `sha256:${'c'.repeat(64)}`,
      mediaType: 'application/json',
      sizeBytes: 32,
      sensitivity: 'internal',
      workspaceId,
      projectId,
      authorized: true,
      state: 'available',
    })
    expect(
      await instance.resolveArtifact({
        principalRef,
        workspaceId,
        projectId,
        artifactId: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      })
    ).toBeUndefined()
  })

  test('maps unverifiable, quarantined and revoked artifact evidence to unavailable states', async () => {
    const store = artifactStore({
      [artifactId]: {
        size: 32,
        contentType: 'application/json',
        sha256: `sha256:${'c'.repeat(64)}`,
        metadata: { sensitivity: 'top-secret' },
      },
      ['art_01ARZ3NDEKTSV4RRFFQ69G5FAW']: {
        size: 32,
        contentType: 'application/json',
        sha256: `sha256:${'c'.repeat(64)}`,
        metadata: { sensitivity: 'internal', 'artifact-state': 'quarantined' },
      },
      ['art_01ARZ3NDEKTSV4RRFFQ69G5FAX']: {
        size: 32,
        contentType: 'application/json',
        sha256: `sha256:${'c'.repeat(64)}`,
        metadata: { sensitivity: 'internal', 'artifact-state': 'revoked' },
      },
      ['art_01ARZ3NDEKTSV4RRFFQ69G5FAY']: {
        size: 32,
        contentType: 'application/json',
        sha256: `sha256:${'c'.repeat(64)}`,
        metadata: { sensitivity: 'internal', 'artifact-state': 'scanned-by-nobody' },
      },
      ['art_01ARZ3NDEKTSV4RRFFQ69G5FAZ']: {
        size: 32,
        sha256: `sha256:${'c'.repeat(64)}`,
        metadata: { sensitivity: 'internal' },
      },
    })
    const instance = authority({ artifacts: store })
    const resolve = (id) =>
      instance.resolveArtifact({ principalRef, workspaceId, projectId, artifactId: id })
    expect((await resolve(artifactId)).state).toBe('unverified')
    expect((await resolve('art_01ARZ3NDEKTSV4RRFFQ69G5FAW')).state).toBe('quarantined')
    expect((await resolve('art_01ARZ3NDEKTSV4RRFFQ69G5FAX')).state).toBe('revoked')
    expect((await resolve('art_01ARZ3NDEKTSV4RRFFQ69G5FAY')).state).toBe('unverified')
    expect((await resolve('art_01ARZ3NDEKTSV4RRFFQ69G5FAZ')).state).toBe('unverified')
  })

  test('marks artifacts unauthorized without a current grant or declared scope match', async () => {
    const store = artifactStore({
      [artifactId]: {
        size: 32,
        contentType: 'application/json',
        sha256: `sha256:${'c'.repeat(64)}`,
        metadata: { sensitivity: 'internal', 'workspace-id': otherWorkspaceId },
      },
    })
    expect(
      (
        await authority({ artifacts: store }).resolveArtifact({
          principalRef,
          workspaceId,
          projectId,
          artifactId,
        })
      ).authorized
    ).toBe(false)
    expect(
      (
        await authority({
          registrations: [],
          artifacts: store,
        }).resolveArtifact({ principalRef, workspaceId, projectId, artifactId })
      ).authorized
    ).toBe(false)
  })

  test('treats an unconfigured artifact repository and store failures as missing evidence', async () => {
    expect(
      await authority().resolveArtifact({ principalRef, workspaceId, projectId, artifactId })
    ).toBeUndefined()
    expect(
      authority({
        artifacts: artifactStore({}, { error: new Error('OBJECT_STORE_PROVIDER_FAILURE') }),
      }).resolveArtifact({ principalRef, workspaceId, projectId, artifactId })
    ).rejects.toThrow('OBJECT_STORE_PROVIDER_FAILURE')
  })
})
