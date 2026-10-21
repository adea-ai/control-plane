/**
 * Canonical inputs for the control-plane#558 decision-layer context consumer
 * conformance.
 *
 * The fixtures are the only source of objective, identity and content in the
 * conformance suite, so the same objective can be replayed against every real
 * service composition and both persistence dialects without any test
 * inventing its own scope. Nothing here is production wiring: the suite
 * composes the same repositories and the same consumer services that the
 * Local, Hosted Simple, Hosted Server and Cloud composition roots construct,
 * and `decisionContextCompositions` names those roots so the matrix can be
 * proven to track them.
 */

/** The Control Plane identity every canonical request runs under. */
export const canonicalScope = Object.freeze({
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
})

/** A second tenant: a foreign workspace, project and principal. */
export const foreignScope = Object.freeze({
  workspaceId: `wsp_01J${'W'.repeat(23)}`,
  projectId: `prj_01J${'X'.repeat(23)}`,
})

export const canonicalPrincipalId = 'svc_agent-hq'
export const foreignPrincipalId = 'svc_other-tenant'

/** The provider principal the fake alternate provider is bound to. */
export const canonicalProviderPrincipalRef = 'principal://test/user'

export const canonicalObservedAt = '2026-08-25T11:59:00.000Z'
export const canonicalCompiledAt = '2026-08-25T12:00:00.000Z'
export const canonicalObjective = 'Reconcile the release readiness report for the active project.'

/**
 * A secret that must never appear in a resolution result, a denial or a
 * serialized context package. It lives in a state item whose sensitivity the
 * authoring policy does not allow, so the conformance suite proves the
 * redaction rule holds rather than assuming it.
 */
export const canonicalSecretCanary = 'cp558-context-conformance-secret-canary-7f3a'

export const canonicalIds = Object.freeze({
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
  agentId: 'agt_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
  providerRef: 'pvr_01JABCDEF0123456789ABCDEFG',
  authorizationRef: 'authz:cp558-context-conformance',
  mappedProjectRef: 'project://cp558-context-conformance',
  stateItemPublicId: 'psi_01JABCDEF0123456789ABCDEFG',
  stateItemInternalId: 'psi_01JBBCDEF0123456789ABCDEFG',
  stateItemRestrictedId: 'psi_01JCBCDEF0123456789ABCDEFG',
  stateItemStaleId: 'psi_01JDBCDEF0123456789ABCDEFG',
})

/**
 * The identifiers the negative cases use. They are deliberately distinct
 * from the canonical ones so a negative case never mutates the records the
 * positive matrix proves to be equivalent.
 */
export const negativeIds = Object.freeze({
  profileId: `prf_01J${'D'.repeat(23)}`,
  profileVersionId: `pfv_01J${'E'.repeat(23)}`,
  skillId: `skl_01J${'F'.repeat(23)}`,
  skillVersionId: `skv_01J${'G'.repeat(23)}`,
  mismatchProfileId: `prf_01J${'R'.repeat(23)}`,
  mismatchProfileVersionId: `pfv_01J${'S'.repeat(23)}`,
  mismatchSkillId: `skl_01J${'T'.repeat(23)}`,
  mismatchSkillVersionId: `skv_01J${'V'.repeat(23)}`,
  workspaceId: `wsp_01J${'H'.repeat(23)}`,
  projectId: `prj_01J${'K'.repeat(23)}`,
})

/**
 * The distinct grants the revoked and expired reference cases use. Each one
 * needs its own provider binding, because a registration's identity includes
 * the authorization reference the authority reads the grant through.
 */
export const negativeGrants = Object.freeze({
  revoked: Object.freeze({
    authorizationRef: 'authz:cp558-revoked-grant',
    providerRef: `pvr_01J${'N'.repeat(23)}`,
    mappedProjectRef: 'project://cp558-revoked-grant',
    providerSuffix: 'REVOKED',
  }),
  expired: Object.freeze({
    authorizationRef: 'authz:cp558-expired-grant',
    providerRef: `pvr_01J${'P'.repeat(23)}`,
    mappedProjectRef: 'project://cp558-expired-grant',
    providerSuffix: 'EXPIRED',
  }),
})

/**
 * Two published versions of the same profile that share a version number and
 * a revision. A store may hold both; the resolution must not depend on the
 * order the store returns them in.
 */
export const tieProfileVersionIds = Object.freeze([
  `pfv_01J${'Y'.repeat(23)}`,
  `pfv_01J${'Z'.repeat(23)}`,
])

/**
 * The approval policy the conformance suite configures on the catalog
 * consumers. It requires an explicit decision for every consumed version and
 * grants no grandfathering window.
 */
export const canonicalCatalogApprovalPolicy = Object.freeze({ required: true })

/** An approval decision bound to the version's current revision and digest. */
export const canonicalApprovalDecision = (kind, version) => ({
  versionKind: kind,
  versionId: version.versionId,
  revision: version.revision,
  contentDigest: version.contentDigest,
  decision: 'approved',
  actorPrincipalRef: 'principal://operator',
  decidedAt: canonicalObservedAt,
})

/**
 * A newer decision for the same version that no longer binds to it. The
 * shipped approval gate treats evidence bound to another revision as no
 * approval, so the version's current verdict becomes missing and the version
 * is no longer consumable.
 */
export const canonicalDeapprovalDecision = (kind, version) => ({
  versionKind: kind,
  versionId: version.versionId,
  revision: version.revision + 1,
  contentDigest: version.contentDigest,
  decision: 'rejected',
  actorPrincipalRef: 'principal://operator',
  decidedAt: canonicalCompiledAt,
})

export const canonicalDigest = (character) => `sha256:${character.repeat(64)}`

/**
 * Releases a resource after a failure and keeps the original error. A
 * release failure is aggregated with the original error, never in place of
 * it: the error that caused the failure stays the primary cause.
 */
async function releaseAfterFailure(entry, error) {
  try {
    await entry.release()
  } catch (releaseError) {
    return new AggregateError([error, releaseError], 'CP558_OWNED_RELEASE_FAILED', { cause: error })
  }
  return error
}

/**
 * The registry of resources the conformance suite allocates.
 *
 * A resource is registered before any awaited work follows its allocation, so
 * a migration or seeding failure still releases it. Every release is
 * attempted, and the failures are aggregated with the original error objects
 * intact, so a cleanup failure never hides the error that caused it.
 */
export function createOwnedResourceRegistry() {
  const entries = []
  const register = (label, dispose) => {
    let released = false
    const entry = {
      label,
      released: false,
      async release() {
        if (released) return
        released = true
        entry.released = true
        await dispose()
      },
    }
    entries.push(entry)
    return entry
  }
  return {
    register,
    /** The registered entries, so a case can observe what was released. */
    get entries() {
      return [...entries]
    },
    /**
     * Allocates a resource, registers its disposer before the preparation
     * runs, and prepares it. A preparation failure releases the resource and
     * keeps the original error.
     */
    async allocate({ label, allocate, prepare, release }) {
      const resource = await allocate()
      const entry = register(label, () => release(resource))
      try {
        if (prepare !== undefined) await prepare(resource)
      } catch (error) {
        throw await releaseAfterFailure(entry, error)
      }
      return { resource, entry }
    },
    /**
     * Runs owned work that follows an allocation. A failure releases the
     * allocation when one is owned here and keeps the original error.
     */
    async guard(entry, work) {
      try {
        return await work()
      } catch (error) {
        if (entry === undefined) throw error
        throw await releaseAfterFailure(entry, error)
      }
    },
    /**
     * Releases every registered resource. Every disposer is attempted even
     * when an earlier one fails, and the failures are aggregated with the
     * original error objects preserved.
     */
    async releaseAll() {
      const failures = []
      for (const entry of entries) {
        try {
          await entry.release()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `CP558_OWNED_RELEASE_FAILED:${failures.length}`, {
          cause: failures[0],
        })
      }
      return failures
    },
    get size() {
      return entries.length
    },
  }
}

/**
 * The project state the canonical objective is resolved against. The
 * restricted item carries the secret canary and is never part of the
 * canonical candidate scope.
 */
export const canonicalStateItems = Object.freeze([
  Object.freeze({
    itemId: canonicalIds.stateItemPublicId,
    itemRevision: 1,
    key: 'release.channel',
    value: { channel: 'stable' },
    sensitivity: 'public',
    freshness: { observedAt: canonicalObservedAt },
    provenance: {
      sourceKind: 'principal',
      sourcePrincipalRef: 'principal://operator',
      artifactRefs: [],
      capturedAt: canonicalObservedAt,
    },
  }),
  Object.freeze({
    itemId: canonicalIds.stateItemInternalId,
    itemRevision: 1,
    key: 'release.readiness',
    value: { gatesPassed: 12, gatesTotal: 12 },
    sensitivity: 'internal',
    freshness: { observedAt: canonicalObservedAt },
    provenance: {
      sourceKind: 'principal',
      sourcePrincipalRef: 'principal://operator',
      artifactRefs: [],
      capturedAt: canonicalObservedAt,
    },
  }),
  Object.freeze({
    itemId: canonicalIds.stateItemRestrictedId,
    itemRevision: 1,
    key: 'release.restricted',
    value: { note: canonicalSecretCanary },
    sensitivity: 'restricted',
    freshness: { observedAt: canonicalObservedAt },
    provenance: {
      sourceKind: 'principal',
      sourcePrincipalRef: 'principal://operator',
      artifactRefs: [],
      capturedAt: canonicalObservedAt,
    },
  }),
  Object.freeze({
    itemId: canonicalIds.stateItemStaleId,
    itemRevision: 1,
    key: 'release.stale',
    value: { gatesPassed: 3, gatesTotal: 12 },
    sensitivity: 'internal',
    freshness: { observedAt: canonicalObservedAt, expiresAt: '2026-08-25T11:59:30.000Z' },
    provenance: {
      sourceKind: 'principal',
      sourcePrincipalRef: 'principal://operator',
      artifactRefs: [],
      capturedAt: canonicalObservedAt,
    },
  }),
])

/** The catalog records the canonical profile and its pinned skill resolve to. */
export const canonicalAgentProfile = Object.freeze({
  profileId: canonicalIds.profileId,
  displayName: 'Release readiness agent',
  ownership: { scope: 'system' },
  createdAt: canonicalObservedAt,
})

export const canonicalSkill = Object.freeze({
  skillId: canonicalIds.skillId,
  displayName: 'Release checklist',
  ownership: { scope: 'system' },
  createdAt: canonicalObservedAt,
})

export const canonicalSkillDraft = Object.freeze({
  skillId: canonicalIds.skillId,
  skillVersionId: canonicalIds.skillVersionId,
  manifest: {
    schemaVersion: 1,
    semanticVersion: '1.0.0',
    requiredCapabilities: [],
    requiredTools: [],
    dependencies: [],
    conflicts: [],
    supersedes: [],
    compatibleProfileSchemaVersions: [1],
    compatibleContractMajorVersions: [1],
    evalRefs: [],
  },
  content: { instructions: 'Check the release checklist.', artifactRefs: [] },
  createdAt: canonicalObservedAt,
})

/**
 * The profile definition, pinned to the exact skill content the catalog
 * publishes. The digest is supplied because the catalog computes it.
 */
export const canonicalProfileDefinition = (skillContentDigest) => ({
  schemaVersion: 1,
  roleInstructions: 'Complete the assigned task safely.',
  skills: [
    {
      skillId: canonicalIds.skillId,
      skillVersionId: canonicalIds.skillVersionId,
      contentDigest: skillContentDigest,
    },
  ],
  capabilityRequirements: ['filesystem.read'],
  outputContractRefs: ['contract://execution-result/v1'],
})

/** The policy the Local and Hosted Server compositions configure today. */
export const canonicalContextAuthoringPolicy = Object.freeze({
  allowedSensitivities: ['public', 'internal'],
  allowedCapabilities: ['boundedRetrieval', 'evidenceSearch', 'memoryRecall'],
  executionLocation: 'runtime_node',
  allowedArtifactIds: [],
  permissions: [],
  maximumBytes: 1_048_576,
  maximumTokens: 32_768,
  maximumContextTtlSeconds: 3_600,
  providerPolicy: {
    mode: 'disabled',
    providerIds: [],
    connectionIds: [],
    includeEvidence: false,
    includeMemory: false,
    maximumTokens: 0,
    maximumAgeSeconds: 3_600,
    maximumProviderHealthAgeSeconds: 60,
    maximumLatencyMs: 10_000,
    failureBehavior: 'continue_without',
  },
})

/** The scope digest the alternate provider registration and grant share. */
export const canonicalScopeDigest = canonicalDigest('5')

/** The current context command grant that authorizes the canonical scope. */
export const canonicalContextCommandGrant = Object.freeze({
  authorizationRef: canonicalIds.authorizationRef,
  workspaceId: canonicalScope.workspaceId,
  nodeId: canonicalIds.runtimeNodeRefId,
  providerRef: canonicalIds.providerRef,
  principalRef: canonicalProviderPrincipalRef,
  mappedProjectRef: canonicalIds.mappedProjectRef,
  scopeDigest: canonicalScopeDigest,
  capabilities: ['boundedRetrieval'],
  maximumTokens: 1_024,
  includeEvidence: false,
  includeMemory: false,
  issuedAt: '2026-08-25T11:00:00.000Z',
  expiresAt: '2026-08-25T13:00:00.000Z',
  status: 'active',
})

/** The alternate provider the fake provider driver impersonates. */
export const canonicalAlternateProviderSuffix = 'FAKE'
export const canonicalAlternateProviderId = `ctp_${'F'.repeat(26)}`
export const canonicalAlternateConnectionId = `ctc_${'F'.repeat(26)}`

/** The canonical authoring scope: the two state items the policy allows. */
export const canonicalContextAuthoringInputs = Object.freeze({
  objective: canonicalObjective,
  candidates: [
    {
      itemId: canonicalIds.stateItemPublicId,
      itemRevision: 1,
      required: true,
      priority: 10,
    },
    {
      itemId: canonicalIds.stateItemInternalId,
      itemRevision: 1,
      required: true,
      priority: 5,
    },
  ],
  budgets: { maximumBytes: 65_536, maximumTokens: 16_384 },
  successCriteria: ['Return the normalized readiness summary'],
  returnContract: { contractRef: 'contract://execution-result/v1' },
})

/** The request bodies the three existing consumers accept. */
export const canonicalProfileResolutionRequest = Object.freeze({
  operation: 'profile.resolve',
  requestedAt: canonicalCompiledAt,
  contractVersion: { major: 3, minor: 0 },
  requestId: canonicalIds.requestId,
  workspaceId: canonicalScope.workspaceId,
  projectId: canonicalScope.projectId,
  correlation: { traceId: canonicalIds.traceId },
  caller: { servicePrincipalId: canonicalPrincipalId },
  parameters: { profileId: canonicalIds.profileId },
})

export const canonicalContextPackageResolutionRequest = Object.freeze({
  operation: 'context-package.resolve',
  requestedAt: canonicalCompiledAt,
  contractVersion: { major: 3, minor: 0 },
  requestId: canonicalIds.requestId,
  workspaceId: canonicalScope.workspaceId,
  projectId: canonicalScope.projectId,
  correlation: { traceId: canonicalIds.traceId },
  caller: { servicePrincipalId: canonicalPrincipalId },
  parameters: { contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG' },
})

/**
 * The execution-validation command the conformance suite replays. The context
 * reference is filled in with the package the run actually assembled.
 */
export const canonicalExecutionValidationRequest = (
  contextPackageReference,
  idempotencyKey = 'cp558-context-conformance-validation'
) => ({
  operation: 'execution.validate',
  issuedAt: canonicalCompiledAt,
  contractVersion: { major: 3, minor: 0 },
  requestId: canonicalIds.requestId,
  commandId: canonicalIds.commandId,
  idempotencyKey,
  payloadHash: 'c'.repeat(64),
  workspaceId: canonicalScope.workspaceId,
  projectId: canonicalScope.projectId,
  correlation: { traceId: canonicalIds.traceId },
  caller: { servicePrincipalId: canonicalPrincipalId },
  payload: {
    taskId: canonicalIds.taskId,
    agentId: canonicalIds.agentId,
    profileVersionId: canonicalIds.profileVersionId,
    skillVersionIds: [canonicalIds.skillVersionId],
    projectState: {
      workspaceId: canonicalScope.workspaceId,
      projectId: canonicalScope.projectId,
      revision: 1,
    },
    policySnapshot: {
      policySnapshotId: 'workspace-standard',
      revision: 3,
      contentDigest: canonicalDigest('a'),
    },
    runtimeRequirements: ['stream.output'],
    outputContractRef: 'contract://execution-result/v1',
    contextPackage: contextPackageReference,
  },
})

/**
 * The authoring policy that lets the Control Plane compose the alternate
 * provider. The Local and Hosted Server compositions ship with provider
 * composition disabled, so this policy is what the fake alternate provider
 * leg switches to.
 */
export const alternateProviderContextAuthoringPolicy = Object.freeze({
  ...canonicalContextAuthoringPolicy,
  providerPolicy: {
    mode: 'preferred',
    providerIds: [canonicalAlternateProviderId],
    connectionIds: [canonicalAlternateConnectionId],
    includeEvidence: false,
    includeMemory: false,
    maximumTokens: 1_024,
    maximumAgeSeconds: 3_600,
    maximumProviderHealthAgeSeconds: 60,
    maximumLatencyMs: 10_000,
    failureBehavior: 'continue_without',
  },
})

/**
 * The four real service compositions this conformance covers, with the
 * repositories each composition root actually constructs. The matrix is
 * asserted against those roots so it cannot drift away from them.
 */ export const decisionContextCompositions = Object.freeze([
  Object.freeze({
    profile: 'local',
    dialect: 'sqlite',
    compositionRoot: 'apps/local-control-plane/src/local-api-composition.ts',
    authorityRoot: 'apps/local-control-plane/src/composition.ts',
    contextAuthority: 'grants-backed',
    repositories: Object.freeze([
      'SqliteContextPackageRepository',
      'SqliteContextAuthoringCommandRepository',
      'SqliteExecutionValidationCommandRepository',
      'SqliteVersionedCatalogRepository',
      'SqliteProjectStateRepository',
    ]),
    authorityRepositories: Object.freeze([
      'SqliteContextCommandGrantRepository',
      'SqliteContextProviderRegistrationRepository',
    ]),
  }),
  Object.freeze({
    profile: 'hosted-simple',
    dialect: 'sqlite',
    compositionRoot: 'apps/local-control-plane/src/local-api-composition.ts',
    authorityRoot: 'apps/local-control-plane/src/composition.ts',
    contextAuthority: 'grants-backed',
    repositories: Object.freeze([
      'SqliteContextPackageRepository',
      'SqliteContextAuthoringCommandRepository',
      'SqliteExecutionValidationCommandRepository',
      'SqliteVersionedCatalogRepository',
      'SqliteProjectStateRepository',
    ]),
    authorityRepositories: Object.freeze([
      'SqliteContextCommandGrantRepository',
      'SqliteContextProviderRegistrationRepository',
    ]),
  }),
  Object.freeze({
    profile: 'hosted-server',
    dialect: 'postgresql',
    compositionRoot: 'apps/hosted-control-plane/src/composition.ts',
    authorityRoot: 'apps/hosted-control-plane/src/composition.ts',
    contextAuthority: 'grants-backed',
    repositories: Object.freeze([
      'PostgresContextPackageRepository',
      'PostgresContextAuthoringCommandRepository',
      'PostgresExecutionValidationCommandRepository',
      'PostgresCatalogRepository',
      'PostgresProjectStateRepository',
    ]),
    authorityRepositories: Object.freeze([
      'PostgresContextCommandGrantRepository',
      'PostgresContextProviderRegistrationRepository',
    ]),
  }),
  Object.freeze({
    profile: 'cloud',
    dialect: 'postgresql',
    compositionRoot: 'apps/control-api/src/cloud-composition.ts',
    authorityRoot: 'apps/control-api/src/cloud-composition.ts',
    // The Cloud composition ships no default context authority: the operator
    // must supply one, so context authoring is not configured by default.
    contextAuthority: 'operator-supplied',
    repositories: Object.freeze([
      'PostgresContextPackageRepository',
      'PostgresContextAuthoringCommandRepository',
      'PostgresExecutionValidationCommandRepository',
      'PostgresCatalogRepository',
      'PostgresProjectStateRepository',
    ]),
    authorityRepositories: Object.freeze([]),
  }),
])
