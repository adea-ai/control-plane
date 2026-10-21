import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  ContextPackageAuthoringService,
  ContextProviderResolver,
  GrantsBackedContextAuthoringAuthority,
  createFakeContextProvider,
} from '@control-plane/context'
import {
  InMemoryStatePromotionProposalRepository,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
  VersionedCatalog,
  executionConstraintFixtures,
} from '@control-plane/domain'
import {
  PostgresCatalogApprovalRepository,
  PostgresCatalogRepository,
  PostgresContextAuthoringCommandRepository,
  PostgresContextCommandGrantRepository,
  PostgresContextPackageRepository,
  PostgresContextProviderRegistrationRepository,
  PostgresExecutionValidationCommandRepository,
  PostgresProjectStateRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import {
  SqliteCatalogApprovalRepository,
  SqliteContextAuthoringCommandRepository,
  SqliteContextCommandGrantRepository,
  SqliteContextPackageRepository,
  SqliteContextProviderRegistrationRepository,
  SqliteExecutionValidationCommandRepository,
  SqlitePersistenceProvider,
  SqliteProjectStateRepository,
  SqliteVersionedCatalogRepository,
} from '@control-plane/sqlite-persistence'
import { DurableExecutionValidationService } from './executions/execution-validation.service.ts'
import { RepositoryContextPackageResolutionService } from './queries/context-package-resolution.service.ts'
import { RepositoryProfileResolutionService } from './queries/profile-resolution.service.ts'
import {
  alternateProviderContextAuthoringPolicy,
  canonicalAgentProfile,
  canonicalAlternateConnectionId,
  canonicalAlternateProviderId,
  canonicalAlternateProviderSuffix,
  canonicalApprovalDecision,
  canonicalCatalogApprovalPolicy,
  canonicalCompiledAt,
  canonicalContextAuthoringInputs,
  canonicalContextAuthoringPolicy,
  canonicalContextCommandGrant,
  canonicalContextPackageResolutionRequest,
  canonicalDeapprovalDecision,
  canonicalDigest,
  canonicalExecutionValidationRequest,
  canonicalIds,
  canonicalObjective,
  canonicalObservedAt,
  canonicalPrincipalId,
  canonicalProfileDefinition,
  canonicalProfileResolutionRequest,
  canonicalProviderPrincipalRef,
  canonicalScope,
  canonicalScopeDigest,
  canonicalSecretCanary,
  canonicalSkill,
  canonicalSkillDraft,
  canonicalStateItems,
  createOwnedResourceRegistry,
  decisionContextCompositions,
  foreignPrincipalId,
  foreignScope,
  negativeGrants,
  negativeIds,
  tieProfileVersionIds,
} from './decision-context-consumer-conformance.fixtures.mjs'

/**
 * Decision-layer context consumer conformance (control-plane#558).
 *
 * The decision layer selects what runs; the Control Plane consumers resolve
 * it. This suite proves that the existing production-reachable consumers —
 * `POST /v1/executions/validate` through the durable execution validation
 * service and the context authoring service, and `POST /v1/profiles/resolve`
 * through the repository profile resolution service — resolve the same
 * objective identically in the real Local, Hosted Simple, Hosted Server and
 * Cloud service compositions, over SQLite and PostgreSQL, and that they keep
 * the current authorization on replay.
 *
 * It deliberately does not re-implement the decision layer: selection stays
 * pure in `resolveDecisionLayer`, and this suite only exercises what the
 * consumers do with a selected context.
 */

const REPOSITORY_ROOT = new URL('../../../', import.meta.url)
const POSTGRES_REQUIRED = process.env.RUN_M10_POSTGRES_CONFORMANCE === 'true'

const postgresCredentials = (() => {
  try {
    return {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
  } catch {
    return undefined
  }
})()

const harnesses = []
const stores = new Map()
const owned = createOwnedResourceRegistry()

afterAll(async () => {
  // Every owned disposer is attempted, even when an earlier one fails, and
  // the failures are aggregated with the original error objects preserved: a
  // cleanup failure never replaces the error that caused it.
  const failures = []
  for (const harness of harnesses.splice(0)) {
    try {
      await harness.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const store of stores.values()) {
    try {
      await store.close()
    } catch (error) {
      failures.push(error)
    }
  }
  stores.clear()
  try {
    await owned.releaseAll()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `CP558_CLEANUP_FAILED:${failures.length}`, {
      cause: failures[0],
    })
  }
})

describe('decision-layer context consumer conformance (#558)', () => {
  test('models the real Local, Hosted Simple, Hosted Server and Cloud composition wiring', async () => {
    for (const composition of decisionContextCompositions) {
      const root = await readFile(new URL(composition.compositionRoot, REPOSITORY_ROOT), 'utf8')
      for (const repository of composition.repositories) {
        expect(root, `${composition.profile} ${repository}`).toContain(`new ${repository}(`)
      }
      const authorityRoot = await readFile(
        new URL(composition.authorityRoot, REPOSITORY_ROOT),
        'utf8'
      )
      if (composition.contextAuthority === 'grants-backed') {
        expect(authorityRoot, composition.profile).toContain(
          'new GrantsBackedContextAuthoringAuthority('
        )
        for (const repository of composition.authorityRepositories) {
          expect(authorityRoot, `${composition.profile} ${repository}`).toContain(
            `new ${repository}(`
          )
        }
      } else {
        // The Cloud composition ships no default authority: context authoring
        // is only configured when an operator supplies one.
        expect(authorityRoot, composition.profile).not.toContain(
          'new GrantsBackedContextAuthoringAuthority('
        )
      }
    }
  })

  test('resolves the same objective identically in every composition and dialect', async () => {
    const projections = new Map()
    for (const composition of decisionContextCompositions) {
      if (composition.dialect === 'postgresql' && postgresCredentials === undefined) {
        expect(POSTGRES_REQUIRED).toBe(false)
        continue
      }
      const harness = await createHarness(composition.profile)
      projections.set(composition.profile, await resolveCanonicalObjective(harness))
    }
    expect(projections.size).toBe(availableProfiles().length)
    expect([...projections.keys()]).toEqual(availableProfiles())
    const [baseline, ...rest] = [...projections.values()]
    for (const projection of rest) expect(projection).toEqual(baseline)
    // The assembled context is content addressed, so the same objective in
    // the same scope assembles byte-identical context in every composition.
    expect(baseline.context.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(baseline.context.stateItemKeys).toEqual(['release.channel', 'release.readiness'])
    expect(JSON.stringify(baseline)).not.toContain(canonicalSecretCanary)
  }, 300_000)

  test('keeps semantic resolution stable while the runtime selection differs', async () => {
    const harness = await createHarness('local', { label: 'runtime-selection' })
    const canonical = await resolveCanonicalObjective(harness)
    const otherRuntime = await resolveCanonicalObjective(harness, {
      idempotencyKey: 'cp558-alternate-runtime-validation',
      runtimeRequirements: ['stream.output', 'tool.call'],
    })
    // A distinct runtime selection is a distinct plan; the objective, the
    // assembled context and the resolved pins are unchanged.
    expect(otherRuntime.executionPlan.executionPlanId).not.toBe(
      canonical.executionPlan.executionPlanId
    )
    expect(otherRuntime.context).toEqual(canonical.context)
    expect(otherRuntime.profile).toEqual(canonical.profile)
  }, 120_000)

  test('replays deterministically and re-checks the current catalog authorization', async () => {
    for (const profile of availableProfiles()) {
      // Each composition replays on its own store, so a revocation in one
      // composition never reaches the records another composition resolves.
      const harness = await createHarness(profile, { isolated: true, label: `replay-${profile}` })
      const first = await resolveCanonicalObjective(harness)
      const replay = await resolveCanonicalObjective(harness)
      expect(replay).toEqual(first)

      // The profile version the plan consumes is revoked after the plan was
      // certified. The replay must not resolve a revoked version again, even
      // though the recorded result is unchanged.
      await harness.revokeProfileVersion()
      await expect(
        harness.validationService.validate(harness.validationRequest, canonicalPrincipalId)
      ).rejects.toMatchObject({ response: { code: 'EXECUTION_VALIDATION_REJECTED' } })
    }
  }, 300_000)

  test('refuses a replay whose catalog approval no longer holds', async () => {
    for (const profile of availableProfiles()) {
      const harness = await createHarness(profile, {
        label: `approval-gate-${profile}`,
        approvalGate: true,
        enableProviderComposition: true,
      })
      const first = await resolveCanonicalObjective(harness)
      // The provider composed the context once, when the context was
      // assembled.
      expect(harness.providerInvocations).toBe(1)
      expect(harness.committedPlans).toHaveLength(1)

      // An unchanged approval keeps the replay idempotent: the same recorded
      // plan, no second commit, and no second provider read.
      const replay = await resolveCanonicalObjective(harness)
      expect(replay.executionPlan).toEqual(first.executionPlan)
      expect(harness.committedPlans).toHaveLength(1)
      expect(harness.providerInvocations).toBe(1)

      // The pinned profile is de-approved: a newer decision for the same
      // version no longer binds to it, so the version has no current approval.
      await harness.deapproveProfileVersion()
      await expect(
        harness.validationService.validate(harness.validationRequest, canonicalPrincipalId)
      ).rejects.toMatchObject({ response: { code: 'PROFILE_APPROVAL_MISSING' } })
      await expect(
        harness.profileResolutionService.resolve(
          canonicalProfileResolutionRequest,
          canonicalPrincipalId
        )
      ).rejects.toMatchObject({ response: { code: 'PROFILE_APPROVAL_MISSING' } })

      // The refused replay read no provider and rewrote no plan.
      expect(harness.providerInvocations).toBe(1)
      expect(harness.committedPlans).toHaveLength(1)
      expect(harness.committedPlans[0].contentDigest).toBe(first.executionPlan.contentDigest)
    }
  }, 300_000)

  test('honors an explicit pin over the current default', async () => {
    const harness = await createHarness('local', { label: 'pin-precedence' })
    // A newer published version of the same profile exists. The explicit pin
    // still wins over it, and the default selection still moves to it.
    await insertTiedProfileVersions(harness, tieProfileVersionIds)
    const pinned = await harness.profileResolutionService.resolve(
      {
        ...canonicalProfileResolutionRequest,
        parameters: {
          profileId: canonicalIds.profileId,
          profileVersionId: canonicalIds.profileVersionId,
        },
      },
      canonicalPrincipalId
    )
    expect(pinned.data.profile.profileVersionId).toBe(canonicalIds.profileVersionId)
    const defaulted = await harness.profileResolutionService.resolve(
      canonicalProfileResolutionRequest,
      canonicalPrincipalId
    )
    expect(defaulted.data.profile.profileVersionId).not.toBe(canonicalIds.profileVersionId)

    // The pinned context package is the one the plan consumes; the consumer
    // does not substitute a freshly assembled one.
    const resolved = await resolveCanonicalObjective(harness)
    expect(harness.committedPlans).toHaveLength(1)
    expect(harness.committedPlans[0].contextPackage.contextPackageId).toBe(
      resolved.context.contextPackageId
    )
    expect(harness.committedPlans[0].contextPackage.contentDigest).toBe(
      resolved.context.contentDigest
    )
  }, 120_000)

  test('releases an allocated resource when its migration fails', async () => {
    const registry = createOwnedResourceRegistry()
    const failure = new Error('CP558_INJECTED_MIGRATION_FAILURE')
    let released = 0
    await expect(
      registry.allocate({
        label: 'injected-store',
        allocate: async () => ({ id: 'injected' }),
        prepare: async () => {
          throw failure
        },
        release: async () => {
          released += 1
        },
      })
    ).rejects.toBe(failure)
    // The disposer was registered before the migration ran, so the failed
    // migration still released the allocation.
    expect(released).toBe(1)
    expect(registry.size).toBe(1)
  })

  test('releases an isolated allocation when the work that follows it fails', async () => {
    const registry = createOwnedResourceRegistry()
    const failure = new Error('CP558_INJECTED_SEED_FAILURE')
    let released = 0
    const entry = registry.register('injected-isolated-store', async () => {
      released += 1
    })
    await expect(
      registry.guard(entry, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(released).toBe(1)
  })

  test('releases an isolated harness whose seeding fails', async () => {
    const failure = new Error('CP558_INJECTED_HARNESS_SEED_FAILURE')
    await expect(
      createHarness('local', {
        isolated: true,
        label: 'harness-seed-failure',
        seedFailure: failure,
      })
    ).rejects.toBe(failure)
    // The harness was never registered, and the store it had already
    // allocated was released with it.
    const entry = owned.entries.find(
      (candidate) => candidate.label === 'isolated-store:local:harness-seed-failure'
    )
    expect(entry).toBeDefined()
    expect(entry.released).toBe(true)
  })

  test('attempts every owned disposer and aggregates the cleanup failures', async () => {
    const registry = createOwnedResourceRegistry()
    const first = new Error('CP558_INJECTED_FIRST_CLEANUP_FAILURE')
    const second = new Error('CP558_INJECTED_SECOND_CLEANUP_FAILURE')
    const released = []
    registry.register('failing-first', async () => {
      released.push('first')
      throw first
    })
    registry.register('succeeding-second', async () => {
      released.push('second')
    })
    registry.register('failing-third', async () => {
      released.push('third')
      throw second
    })
    let aggregate
    try {
      await registry.releaseAll()
    } catch (error) {
      aggregate = error
    }
    // Every disposer ran, including the ones after the first failure.
    expect(released).toEqual(['first', 'second', 'third'])
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect(aggregate.errors).toEqual([first, second])
    // The original error objects are preserved, and the first one stays the
    // primary cause.
    expect(aggregate.cause).toBe(first)
  })

  test('selects the same default profile version regardless of the store order', async () => {
    const [first, second] = await Promise.all([
      createHarness('local', { isolated: true, label: 'tie-first' }),
      createHarness('hosted-simple', { isolated: true, label: 'tie-second' }),
    ])
    // Two published versions of the same profile share a version number and a
    // revision. The stores hold them in opposite orders; the resolution must
    // not.
    await insertTiedProfileVersions(first, tieProfileVersionIds)
    await insertTiedProfileVersions(second, tieProfileVersionIds.toReversed())
    const resolvedFirst = await first.profileResolutionService.resolve(
      canonicalProfileResolutionRequest,
      canonicalPrincipalId
    )
    const resolvedSecond = await second.profileResolutionService.resolve(
      canonicalProfileResolutionRequest,
      canonicalPrincipalId
    )
    expect(resolvedFirst.data.profile.profileVersionId).toBe(
      resolvedSecond.data.profile.profileVersionId
    )
    expect(tieProfileVersionIds).toContain(resolvedFirst.data.profile.profileVersionId)
    // The tie is broken by the version identifier, so the winner is the same
    // version in every composition and not merely an equal one. The two
    // stores above are only *asked* for opposite orders: a real store decides
    // its own order, and the SQLite store lists by `updated_at, id`, so the
    // order the two harnesses actually see depends on the millisecond the two
    // versions were written in. The case below pins the winner instead of
    // leaving it to the store.
    expect(resolvedFirst.data.profile.profileVersionId).toBe(tieProfileVersionIds[0])
    expect(resolvedSecond.data.profile.profileVersionId).toBe(tieProfileVersionIds[0])
  }, 120_000)

  /**
   * The store-order contract, proven deterministically and independently of
   * how a store happens to order its rows.
   *
   * The case above composes two real stores and asks each of them for the two
   * tied versions in opposite orders, but a store decides its own order: the
   * SQLite store lists by `updated_at, id`, so the two harnesses only see
   * genuinely opposite orders when the two versions were written in different
   * milliseconds. Against an implementation that resolves the default version
   * by version and revision alone, that case therefore detects the defect
   * only sometimes.
   *
   * Here the catalog is wrapped so it returns the tied versions in a chosen
   * order, and the consumer is resolved twice with the two orders. The
   * selection must be the same version both times, and it must be the version
   * the identifier tie-break names, whatever order the store used.
   */
  test('selects the same default profile version whatever order the store returns versions in', async () => {
    const harness = await createHarness('local', { isolated: true, label: 'store-order' })
    await insertTiedProfileVersions(harness, tieProfileVersionIds)
    const resolveWithStoreOrder = async (profileVersionIds) => {
      const catalog = harness.store.catalog
      const service = new RepositoryProfileResolutionService({
        getAgentProfile: (profileId) => catalog.getAgentProfile(profileId),
        getAgentProfileVersion: (profileVersionId) =>
          catalog.getAgentProfileVersion(profileVersionId),
        listAgentProfileVersions: async (profileId) => {
          const versions = await catalog.listAgentProfileVersions(profileId)
          const byId = new Map(versions.map((version) => [version.profileVersionId, version]))
          return profileVersionIds
            .map((profileVersionId) => byId.get(profileVersionId))
            .filter((version) => version !== undefined)
        },
        getSkill: (skillId) => catalog.getSkill(skillId),
        getSkillVersion: (skillVersionId) => catalog.getSkillVersion(skillVersionId),
      })
      return service.resolve(canonicalProfileResolutionRequest, canonicalPrincipalId)
    }
    const forward = await resolveWithStoreOrder(tieProfileVersionIds)
    const reversed = await resolveWithStoreOrder(tieProfileVersionIds.toReversed())
    expect(forward.data.profile.profileVersionId).toBe(reversed.data.profile.profileVersionId)
    expect(forward.data.profile.profileVersionId).toBe(tieProfileVersionIds[0])
    expect(reversed.data.profile.profileVersionId).toBe(tieProfileVersionIds[0])
  }, 120_000)

  test('assembles context with no provider and with a fake alternate provider', async () => {
    const withoutProvider = await createHarness('local', { label: 'no-provider' })
    const noProviderReference = await withoutProvider.author()
    const noProviderPackage = await withoutProvider.contextPackages.get(noProviderReference)
    expect(noProviderPackage?.providerComposition).toBeUndefined()

    const withProvider = await createHarness('local', {
      label: 'alternate-provider',
      enableProviderComposition: true,
    })
    const providerReference = await withProvider.author()
    const providerPackage = await withProvider.contextPackages.get(providerReference)
    expect(providerPackage?.providerComposition?.resolution?.status).toBe('included')
    expect(providerPackage?.providerComposition?.contributions).toHaveLength(1)
    expect(providerPackage?.providerComposition?.contributions[0]?.providerId).toBe(
      canonicalAlternateProviderId
    )
    expect(providerPackage?.providerComposition?.contributions[0]?.connectionId).toBe(
      canonicalAlternateConnectionId
    )
  }, 120_000)

  test('denies denied scope, foreign identity, revoked and expired references', async () => {
    for (const profile of availableProfiles()) {
      const harness = await createHarness(profile, { label: 'negative' })
      const resolved = await resolveCanonicalObjective(harness)

      // Denied scope: the context package belongs to another project.
      await expect(
        harness.contextPackageResolutionService.resolve({
          ...canonicalContextPackageResolutionRequest,
          workspaceId: foreignScope.workspaceId,
          projectId: foreignScope.projectId,
          parameters: { contextPackageId: resolved.context.contextPackageId },
        })
      ).rejects.toMatchObject({ response: { code: 'CONTEXT_PACKAGE_SCOPE_MISMATCH' } })

      // Foreign identity: a principal that does not own the catalog records.
      await expect(
        harness.profileResolutionService.resolve(
          {
            ...canonicalProfileResolutionRequest,
            parameters: { profileId: negativeIds.profileId },
          },
          foreignPrincipalId
        )
      ).rejects.toMatchObject({ response: { code: 'PROFILE_VERSION_NOT_FOUND' } })

      // Foreign identity: the asserted caller is not the authenticated caller.
      await expect(
        harness.validationService.validate(harness.validationRequest, foreignPrincipalId)
      ).rejects.toMatchObject({ response: { code: 'EXECUTION_VALIDATION_CALLER_MISMATCH' } })

      // Revoked reference: the context command grant is revoked.
      const revoked = await createHarness(profile, {
        scope: negativeScope(),
        label: 'revoked-grant',
        grantBinding: negativeGrants.revoked,
        providerSuffix: negativeGrants.revoked.providerSuffix,
      })
      await revoked.revokeGrant()
      await expect(revoked.author()).rejects.toMatchObject({ code: 'UNAUTHORIZED_CONTEXT' })

      // Expired reference: the context command grant has expired.
      const expired = await createHarness(profile, {
        scope: negativeScope(),
        label: 'expired-grant',
        grantBinding: negativeGrants.expired,
        providerSuffix: negativeGrants.expired.providerSuffix,
        grantExpiry: '2026-08-25T11:59:00.000Z',
      })
      await expect(expired.author()).rejects.toMatchObject({ code: 'UNAUTHORIZED_CONTEXT' })
    }
  }, 300_000)

  test('denies a profile whose pinned skill reference no longer holds', async () => {
    const harness = await createHarness('local', { label: 'skill-reference' })
    // The published skill version no longer carries the content digest the
    // profile pinned.
    await expect(
      harness.profileResolutionService.resolve(
        {
          ...canonicalProfileResolutionRequest,
          parameters: { profileId: negativeIds.mismatchProfileId },
        },
        canonicalPrincipalId
      )
    ).rejects.toMatchObject({ response: { code: 'PROFILE_VERSION_NOT_FOUND' } })

    // A revoked skill version is not executable and never resolves.
    const revoked = await createHarness('local', { label: 'revoked-skill' })
    await revoked.revokeSkillVersion()
    await expect(
      revoked.profileResolutionService.resolve(
        {
          ...canonicalProfileResolutionRequest,
          parameters: { profileId: revoked.negativeProfileId },
        },
        canonicalPrincipalId
      )
    ).rejects.toMatchObject({ response: { code: 'PROFILE_VERSION_NOT_FOUND' } })
  }, 120_000)

  test('denies incompatible explicit pins, unsupported context and bounds', async () => {
    const harness = await createHarness('local', { label: 'incompatible-pin' })
    await resolveCanonicalObjective(harness)

    // Incompatible explicit pin: the pinned context was compiled by another
    // compiler version.
    await expect(
      harness.validationService.validate(
        {
          ...harness.validationRequest,
          idempotencyKey: 'cp558-incompatible-pin-validation',
          payload: {
            ...harness.validationRequest.payload,
            contextPackage: {
              ...harness.validationRequest.payload.contextPackage,
              compilerVersion: '9.9.9',
            },
          },
        },
        canonicalPrincipalId
      )
    ).rejects.toMatchObject({ response: { code: 'EXECUTION_VALIDATION_REJECTED' } })

    // Unsupported context: workspace execution scope is not a project scope.
    await expect(
      harness.authoring.createForCommand(
        canonicalProviderPrincipalRef,
        'cp558-workspace-scope-context',
        {
          ...canonicalContextAuthoringInputs,
          executionScope: { schemaVersion: 1, kind: 'workspace' },
          workspaceId: canonicalScope.workspaceId,
          projectId: canonicalScope.projectId,
          projectStateRevision: 1,
        }
      )
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_UNSUPPORTED' })

    // Bounds: the required context does not fit the requested budget.
    await expect(
      harness.authoring.createForCommand(canonicalProviderPrincipalRef, 'cp558-bounded-context', {
        ...canonicalContextAuthoringInputs,
        budgets: { maximumBytes: 16, maximumTokens: 4 },
        workspaceId: canonicalScope.workspaceId,
        projectId: canonicalScope.projectId,
        projectStateRevision: 1,
      })
    ).rejects.toMatchObject({ code: 'REQUIRED_CONTEXT_EXCEEDS_BUDGET' })
  }, 120_000)

  test('redacts unauthorized context and never leaks it', async () => {
    const harness = await createHarness('local', { label: 'redaction' })
    const resolved = await resolveCanonicalObjective(harness)

    // A state item whose sensitivity the policy does not allow is never
    // assembled, and the secret it carries never leaves the store.
    await expect(
      harness.authoring.createForCommand(
        canonicalProviderPrincipalRef,
        'cp558-restricted-context',
        {
          ...canonicalContextAuthoringInputs,
          candidates: [
            ...canonicalContextAuthoringInputs.candidates,
            {
              itemId: canonicalIds.stateItemRestrictedId,
              itemRevision: 1,
              required: true,
              priority: 1,
            },
          ],
          workspaceId: canonicalScope.workspaceId,
          projectId: canonicalScope.projectId,
          projectStateRevision: 1,
        }
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_CONTEXT' })

    // A stale required reference is never assembled either.
    await expect(
      harness.authoring.createForCommand(canonicalProviderPrincipalRef, 'cp558-stale-context', {
        ...canonicalContextAuthoringInputs,
        candidates: [
          ...canonicalContextAuthoringInputs.candidates,
          { itemId: canonicalIds.stateItemStaleId, itemRevision: 1, required: true, priority: 1 },
        ],
        workspaceId: canonicalScope.workspaceId,
        projectId: canonicalScope.projectId,
        projectStateRevision: 1,
      })
    ).rejects.toMatchObject({ code: 'STALE_REQUIRED_CONTEXT' })

    const serialized = JSON.stringify({
      resolved,
      packages: await harness.contextPackages.get(resolved.context.reference),
    })
    expect(serialized).not.toContain(canonicalSecretCanary)
  }, 120_000)

  test('refuses to publish a context reference whose content does not verify', async () => {
    const harness = await createHarness('local', { label: 'integrity' })
    const resolved = await resolveCanonicalObjective(harness)
    const stored = await harness.contextPackages.get(resolved.context.reference)
    expect(stored).toBeDefined()
    const tampered = { ...stored, objective: `${canonicalObjective} (tampered)` }
    const resolver = new RepositoryContextPackageResolutionService({
      async getById() {
        return tampered
      },
    })
    await expect(
      resolver.resolve({
        ...canonicalContextPackageResolutionRequest,
        parameters: { contextPackageId: resolved.context.contextPackageId },
      })
    ).rejects.toMatchObject({ response: { code: 'CONTEXT_PACKAGE_NOT_FOUND' } })
  }, 120_000)

  test('refuses a revoked skill version on a first pass and on a replay', async () => {
    // An isolated store: the revocation must not reach the records another
    // composition resolves.
    const harness = await createHarness('local', {
      isolated: true,
      label: 'revoked-skill-validation',
    })
    const resolved = await resolveCanonicalObjective(harness)
    // The skill version the plan consumes is revoked after the plan was
    // certified. A revoked version is not executable, so neither a new request
    // nor the replay of the recorded one may resolve it again.
    const skillVersion = await harness.store.catalog.getSkillVersion(canonicalIds.skillVersionId)
    expect(skillVersion).toBeDefined()
    await harness.catalog.revokeSkillVersion(
      canonicalIds.skillVersionId,
      skillVersion.revision,
      canonicalCompiledAt,
      'conformance revocation'
    )
    const request = canonicalExecutionValidationRequest(
      resolved.context.reference,
      'cp558-revoked-skill-validation'
    )
    await expect(
      harness.validationService.validate(request, canonicalPrincipalId)
    ).rejects.toMatchObject({ response: { code: 'EXECUTION_VALIDATION_REJECTED' } })
    // The replay re-reads the catalog authorization and re-checks the version
    // lifecycle; it never re-reads the durable evidence, so this refusal is the
    // consumer's own.
    await expect(
      harness.validationService.validate(harness.validationRequest, canonicalPrincipalId)
    ).rejects.toMatchObject({ response: { code: 'EXECUTION_VALIDATION_REJECTED' } })
  }, 120_000)

  test('refuses to compile a plan from a context package whose content does not verify', async () => {
    const harness = await createHarness('local', { label: 'plan-integrity' })
    const resolved = await resolveCanonicalObjective(harness)
    const stored = await harness.contextPackages.get(resolved.context.reference)
    expect(stored).toBeDefined()
    // The stored package's content no longer matches the digest it is published
    // under: the object was damaged after it was written. The consumer that
    // resolves a package by reference binds it by that digest, so a package
    // whose content does not verify is not the package the plan may consume —
    // the same rule the resolution endpoint applies.
    const tampered = { ...stored, objective: `${canonicalObjective} (tampered)` }
    const damaged = new DurableExecutionValidationService({
      compilerVersion: '1.0.0',
      contextPackages: {
        async get() {
          return tampered
        },
      },
      commands: harness.store.validationCommands,
      contextAuthoring: harness.authoring,
      now: () => canonicalCompiledAt,
      profiles: harness.store.catalog,
      projectStates: harness.store.projectStates,
      skills: harness.store.catalog,
    })
    // A first pass under its own idempotency key: a replay returns the recorded
    // result and deliberately re-reads no durable evidence, so it never
    // resolves the package again.
    const request = canonicalExecutionValidationRequest(
      resolved.context.reference,
      'cp558-damaged-package-validation'
    )
    await expect(damaged.validate(request, canonicalPrincipalId)).rejects.toMatchObject({
      response: { code: 'EXECUTION_VALIDATION_REJECTED' },
    })
  }, 120_000)
})

/**
 * Resolves the canonical objective through the existing consumers and
 * projects the semantic result. The cross-composition comparison is over the
 * projection, not over one opaque digest.
 */
async function resolveCanonicalObjective(harness, options = {}) {
  const reference = await harness.author()
  const package_ = await harness.contextPackages.get(reference)
  expect(package_).toBeDefined()
  const publicReference = {
    contextPackageId: package_.contextPackageId,
    contentDigest: package_.contentDigest,
    schemaVersion: package_.schemaVersion,
    compilerVersion: package_.compiler.version,
  }
  const contextResolution = await harness.contextPackageResolutionService.resolve({
    ...canonicalContextPackageResolutionRequest,
    parameters: { contextPackageId: publicReference.contextPackageId },
  })
  const profileResolution = await harness.profileResolutionService.resolve(
    canonicalProfileResolutionRequest,
    canonicalPrincipalId
  )
  const base = canonicalExecutionValidationRequest(
    publicReference,
    harness.validationIdempotencyKey
  )
  const validationRequest = {
    ...base,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.runtimeRequirements === undefined
      ? {}
      : { payload: { ...base.payload, runtimeRequirements: options.runtimeRequirements } }),
  }
  harness.validationRequest = validationRequest
  const validation = await harness.validationService.validate(
    validationRequest,
    canonicalPrincipalId
  )
  return {
    profile: {
      profileVersionId: profileResolution.data.profile.profileVersionId,
      version: profileResolution.data.profile.version,
      revision: profileResolution.data.profile.revision,
      lifecycle: profileResolution.data.profile.lifecycle,
      skillVersionIds: profileResolution.data.skillVersionIds,
    },
    context: {
      contextPackageId: contextResolution.data.contextPackage.contextPackageId,
      contentDigest: contextResolution.data.contextPackage.contentDigest,
      schemaVersion: contextResolution.data.contextPackage.schemaVersion,
      compilerVersion: contextResolution.data.contextPackage.compilerVersion,
      stateItemKeys: package_.stateItems.map((item) => item.key).toSorted(),
      stateItemIds: package_.stateItems.map((item) => item.itemId).toSorted(),
      sensitivities: package_.stateItems.map((item) => item.sensitivity).toSorted(),
      usage: package_.usage,
      truncated: package_.truncation.truncated,
      providerStatus: package_.providerComposition?.resolution?.status ?? 'none',
      reference: publicReference,
    },
    executionPlan: validation.data.executionPlan,
  }
}

/** The scope a negative case uses, so it never disturbs the canonical records. */
function negativeScope() {
  return { workspaceId: negativeIds.workspaceId, projectId: negativeIds.projectId }
}

/**
 * The compositions this run can exercise. PostgreSQL legs need a configured
 * database; a job that intends to qualify them sets
 * `RUN_M10_POSTGRES_CONFORMANCE=true`, and a missing database then fails the
 * run instead of silently skipping it.
 */
function availableProfiles() {
  return decisionContextCompositions
    .filter((composition) => composition.dialect === 'sqlite' || postgresCredentials !== undefined)
    .map((composition) => composition.profile)
}

/**
 * One store per composition. Every case in a composition shares it, exactly
 * as the real composition shares one database, so the suite exercises the
 * real persistence instead of a per-case sandbox.
 */
async function sharedStore(profile) {
  const existing = stores.get(profile)
  if (existing !== undefined) return existing
  const composition = decisionContextCompositions.find((entry) => entry.profile === profile)
  if (composition === undefined) throw new Error(`CP558_COMPOSITION_UNKNOWN:${profile}`)
  const store = await createStore(composition)
  stores.set(profile, store)
  return store
}

async function createStore(composition) {
  if (composition.dialect === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), `cp558-${composition.profile}-`))
    owned.register(`sqlite-directory:${composition.profile}`, () =>
      rm(directory, { recursive: true, force: true })
    )
    // The provider is closed before the migration is awaited, so a failed
    // migration still releases it.
    const { resource: persistence, entry } = await owned.allocate({
      label: `sqlite-provider:${composition.profile}`,
      allocate: async () =>
        new SqlitePersistenceProvider({
          path: join(directory, 'state.sqlite'),
          profile: composition.profile,
        }),
      prepare: async (provider) => {
        await provider.migrate()
      },
      release: (provider) => {
        provider.close()
      },
    })
    return {
      composition,
      catalog: new SqliteVersionedCatalogRepository(persistence),
      projectStates: new SqliteProjectStateRepository(persistence),
      contextPackages: new SqliteContextPackageRepository(persistence),
      authoringCommands: new SqliteContextAuthoringCommandRepository(persistence),
      validationCommands: new SqliteExecutionValidationCommandRepository(persistence),
      approvals: new SqliteCatalogApprovalRepository(persistence),
      grants: new SqliteContextCommandGrantRepository(persistence),
      registrations: new SqliteContextProviderRegistrationRepository(persistence),
      close: () => entry.release(),
    }
  }
  if (postgresCredentials === undefined) {
    throw new Error('CP558_POSTGRES_UNAVAILABLE')
  }
  // The isolated database is disposed before the migration is awaited, so a
  // failed migration still releases it.
  const { resource: database, entry } = await owned.allocate({
    label: `postgres-database:${composition.profile}`,
    allocate: async () => createIsolatedTestDatabase(postgresCredentials),
    prepare: async (isolated) => {
      await isolated.migrate()
    },
    release: (isolated) => isolated.dispose(),
  })
  return {
    composition,
    catalog: new PostgresCatalogRepository(database.application),
    projectStates: new PostgresProjectStateRepository(database.application),
    contextPackages: new PostgresContextPackageRepository(database.application),
    authoringCommands: new PostgresContextAuthoringCommandRepository(database.application),
    validationCommands: new PostgresExecutionValidationCommandRepository(database.application),
    approvals: new PostgresCatalogApprovalRepository(database.application),
    grants: new PostgresContextCommandGrantRepository(database.application),
    registrations: new PostgresContextProviderRegistrationRepository(database.application),
    close: () => entry.release(),
  }
}

/**
 * Composes one canonical objective against a real composition: the same
 * repositories the composition root constructs, the same consumer services,
 * and the same context authority.
 */
async function createHarness(profile, options = {}) {
  const composition = decisionContextCompositions.find((entry) => entry.profile === profile)
  if (composition === undefined) throw new Error(`CP558_COMPOSITION_UNKNOWN:${profile}`)
  const store =
    options.isolated === true ? await createStore(composition) : await sharedStore(profile)
  const scope = options.scope ?? canonicalScope
  const label = options.label ?? 'canonical'
  // An isolated store is owned by this harness. When the work that follows
  // its allocation fails, the store is released before the error leaves and
  // the original error is kept. A shared store stays owned by the suite.
  const ownedStore =
    options.isolated === true
      ? owned.register(`isolated-store:${profile}:${label}`, () => store.close())
      : undefined
  const harness = await owned.guard(ownedStore, async () => {
    const catalog = new VersionedCatalog(store.catalog, store.catalog)
    const seeded = await seedCatalog(store)
    await seedProjectState(store, scope, options.seedFailure)

    const grant = {
      ...canonicalContextCommandGrant,
      ...(options.grantBinding === undefined
        ? {}
        : {
            providerRef: options.grantBinding.providerRef,
            authorizationRef: options.grantBinding.authorizationRef,
            mappedProjectRef: options.grantBinding.mappedProjectRef,
          }),
      ...(scope === canonicalScope ? {} : { workspaceId: scope.workspaceId }),
      ...(options.grantExpiry === undefined ? {} : { expiresAt: options.grantExpiry }),
    }
    try {
      await store.grants.create(grant)
    } catch {
      // The grant already exists in this store; the case mutates it below.
    }

    const provider = createFakeContextProvider({
      suffix: options.providerSuffix ?? canonicalAlternateProviderSuffix,
      workspaceId: scope.workspaceId,
      scopeDigest: canonicalScopeDigest,
      state: 'active',
      health: 'healthy',
      capabilities: { boundedRetrieval: true },
      kind: 'context',
      tokenCount: 8,
    })
    // The provider registration is the binding the authority reads the grant
    // through; without it there is no eligible provider binding at all.
    await store.registrations.save(0, {
      version: 1,
      readModel: provider.readModel,
      providerRef: grant.providerRef,
      mappedProjectRef: grant.mappedProjectRef,
      authorizationRef: grant.authorizationRef,
    })

    const authority = new GrantsBackedContextAuthoringAuthority({
      grants: store.grants,
      registrations: store.registrations,
      policy:
        options.enableProviderComposition === true
          ? alternateProviderContextAuthoringPolicy
          : canonicalContextAuthoringPolicy,
      now: () => new Date(canonicalCompiledAt),
    })
    let providerInvocations = 0
    const providerResolver = new ContextProviderResolver([provider])
    const authoring = new ContextPackageAuthoringService({
      compilerVersion: '1.0.0',
      packages: store.contextPackages,
      projectStates: store.projectStates,
      commands: store.authoringCommands,
      authority,
      ...(options.enableProviderComposition === true
        ? {
            providerResolver: {
              resolve: async (input) => {
                providerInvocations += 1
                return providerResolver.resolve(input)
              },
            },
          }
        : {}),
      now: () => new Date(canonicalCompiledAt),
    })
    const committedPlans = []
    const validationCommands = {
      get: (commandScope) => store.validationCommands.get(commandScope),
      commit: (record, plan) => {
        committedPlans.push(plan)
        return store.validationCommands.commit(record, plan)
      },
    }
    const approvalGate =
      options.approvalGate === true
        ? { approvals: store.approvals, policy: canonicalCatalogApprovalPolicy }
        : undefined
    if (approvalGate !== undefined) await seedApprovals(store)
    const validationService = new DurableExecutionValidationService({
      compilerVersion: '1.0.0',
      contextPackages: store.contextPackages,
      commands: validationCommands,
      contextAuthoring: authoring,
      now: () => canonicalCompiledAt,
      profiles: store.catalog,
      projectStates: store.projectStates,
      skills: store.catalog,
      ...(approvalGate === undefined ? {} : { approvalGate }),
    })
    const profileResolutionService = new RepositoryProfileResolutionService(
      store.catalog,
      approvalGate === undefined ? undefined : { ...approvalGate, skills: store.catalog }
    )
    const contextPackageResolutionService = new RepositoryContextPackageResolutionService(
      store.contextPackages
    )

    return {
      store,
      scope,
      catalog,
      seeded,
      contextPackages: store.contextPackages,
      grants: store.grants,
      authoring,
      validationService,
      profileResolutionService,
      contextPackageResolutionService,
      negativeProfileId: seeded.negativeProfileId,
      validationRequest: undefined,
      validationIdempotencyKey: `cp558-validate-${profile}-${label}`,
      get providerInvocations() {
        return providerInvocations
      },
      committedPlans,
      async author() {
        return authoring.createForCommand(
          canonicalProviderPrincipalRef,
          `cp558-author-${profile}-${label}`,
          {
            ...canonicalContextAuthoringInputs,
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            projectStateRevision: 1,
          }
        )
      },
      async revokeGrant() {
        await store.grants.revoke(scope.workspaceId, grant.authorizationRef)
      },
      async deapproveProfileVersion() {
        const profileVersion = await store.catalog.getAgentProfileVersion(
          canonicalIds.profileVersionId
        )
        if (profileVersion === undefined) throw new Error('CP558_APPROVAL_TARGET_MISSING')
        await store.approvals.insert(
          canonicalDeapprovalDecision('agent_profile', {
            versionId: canonicalIds.profileVersionId,
            revision: profileVersion.revision,
            contentDigest: profileVersion.contentDigest,
          })
        )
      },
      async revokeProfileVersion() {
        await catalog.revokeAgentProfileVersion(
          canonicalIds.profileVersionId,
          seeded.profileVersion.revision,
          canonicalCompiledAt,
          'conformance revocation'
        )
      },
      async revokeSkillVersion() {
        await catalog.revokeSkillVersion(
          seeded.negativeSkillVersion.skillVersionId,
          seeded.negativeSkillVersion.revision,
          canonicalCompiledAt,
          'conformance revocation'
        )
      },
      async dispose() {
        if (ownedStore !== undefined) await ownedStore.release()
      },
    }
  })
  harnesses.push(harness)
  return harness
}

/**
 * Records the approval decisions the pinned profile and skill versions need
 * before a gated consumer may resolve them.
 */
async function seedApprovals(store) {
  const profileVersion = await store.catalog.getAgentProfileVersion(canonicalIds.profileVersionId)
  const skillVersion = await store.catalog.getSkillVersion(canonicalIds.skillVersionId)
  if (profileVersion === undefined || skillVersion === undefined) {
    throw new Error('CP558_APPROVAL_TARGET_MISSING')
  }
  await store.approvals.insert(
    canonicalApprovalDecision('agent_profile', {
      versionId: canonicalIds.profileVersionId,
      revision: profileVersion.revision,
      contentDigest: profileVersion.contentDigest,
    })
  )
  await store.approvals.insert(
    canonicalApprovalDecision('skill', {
      versionId: canonicalIds.skillVersionId,
      revision: skillVersion.revision,
      contentDigest: skillVersion.manifest.contentDigest,
    })
  )
}

/**
 * Seeds the catalog records the canonical objective resolves against, plus two
 * negative pairs: a profile whose pinned skill digest no longer matches the
 * published skill, and a profile that pins a skill version exactly.
 */
async function seedCatalog(store) {
  const catalog = new VersionedCatalog(store.catalog, store.catalog)
  const existing = await store.catalog.getAgentProfileVersion(canonicalIds.profileVersionId)
  if (existing !== undefined) {
    return {
      profileVersion: existing,
      negativeProfileId: negativeIds.profileId,
      negativeSkillVersion: await store.catalog.getSkillVersion(negativeIds.skillVersionId),
    }
  }
  await catalog.createAgentProfile(canonicalAgentProfile)
  await catalog.createSkill(canonicalSkill)
  const skill = await catalog.createSkillDraft(canonicalSkillDraft)
  await catalog.publishSkillVersion({
    skillVersionId: canonicalSkillDraft.skillVersionId,
    expectedRevision: skill.revision,
    publishedAt: canonicalObservedAt,
  })
  const profileVersion = await catalog.createAgentProfileDraft({
    profileId: canonicalIds.profileId,
    profileVersionId: canonicalIds.profileVersionId,
    version: 3,
    definition: {
      ...canonicalProfileDefinition(skill.manifest.contentDigest),
      executionConstraints: structuredClone(executionConstraintFixtures.write),
    },
    createdAt: canonicalObservedAt,
  })
  await catalog.publishAgentProfileVersion({
    profileVersionId: canonicalIds.profileVersionId,
    expectedRevision: profileVersion.revision,
    publishedAt: canonicalObservedAt,
  })

  // The negative pair: a profile that pins a skill version exactly, so it can
  // be denied when that version is revoked.
  await catalog.createAgentProfile({
    profileId: negativeIds.profileId,
    displayName: 'Conformance profile',
    ownership: { scope: 'private', principalRef: canonicalPrincipalId },
    createdAt: canonicalObservedAt,
  })
  await catalog.createSkill({
    skillId: negativeIds.skillId,
    displayName: 'Conformance checklist',
    ownership: { scope: 'system' },
    createdAt: canonicalObservedAt,
  })
  const negativeSkill = await catalog.createSkillDraft({
    skillId: negativeIds.skillId,
    skillVersionId: negativeIds.skillVersionId,
    manifest: { ...canonicalSkillDraft.manifest },
    content: { instructions: 'Conformance checklist.', artifactRefs: [] },
    createdAt: canonicalObservedAt,
  })
  await catalog.publishSkillVersion({
    skillVersionId: negativeIds.skillVersionId,
    expectedRevision: negativeSkill.revision,
    publishedAt: canonicalObservedAt,
  })
  const negativeProfile = await catalog.createAgentProfileDraft({
    profileId: negativeIds.profileId,
    profileVersionId: negativeIds.profileVersionId,
    version: 1,
    definition: {
      ...canonicalProfileDefinition(negativeSkill.manifest.contentDigest),
      executionConstraints: structuredClone(executionConstraintFixtures.write),
    },
    createdAt: canonicalObservedAt,
  })
  await catalog.publishAgentProfileVersion({
    profileVersionId: negativeIds.profileVersionId,
    expectedRevision: negativeProfile.revision,
    publishedAt: canonicalObservedAt,
  })

  // The mismatched pair: a profile that pins a skill version by a content
  // digest the published skill does not carry.
  await catalog.createAgentProfile({
    profileId: negativeIds.mismatchProfileId,
    displayName: 'Mismatched profile',
    ownership: { scope: 'system' },
    createdAt: canonicalObservedAt,
  })
  await catalog.createSkill({
    skillId: negativeIds.mismatchSkillId,
    displayName: 'Mismatched checklist',
    ownership: { scope: 'system' },
    createdAt: canonicalObservedAt,
  })
  const mismatchSkill = await catalog.createSkillDraft({
    skillId: negativeIds.mismatchSkillId,
    skillVersionId: negativeIds.mismatchSkillVersionId,
    manifest: { ...canonicalSkillDraft.manifest },
    content: { instructions: 'Mismatched checklist.', artifactRefs: [] },
    createdAt: canonicalObservedAt,
  })
  await catalog.publishSkillVersion({
    skillVersionId: negativeIds.mismatchSkillVersionId,
    expectedRevision: mismatchSkill.revision,
    publishedAt: canonicalObservedAt,
  })
  const mismatchProfile = await catalog.createAgentProfileDraft({
    profileId: negativeIds.mismatchProfileId,
    profileVersionId: negativeIds.mismatchProfileVersionId,
    version: 1,
    definition: {
      ...canonicalProfileDefinition(canonicalDigest('9')),
      skills: [
        {
          skillId: negativeIds.mismatchSkillId,
          skillVersionId: negativeIds.mismatchSkillVersionId,
          contentDigest: canonicalDigest('9'),
        },
      ],
      executionConstraints: structuredClone(executionConstraintFixtures.write),
    },
    createdAt: canonicalObservedAt,
  })
  await catalog.publishAgentProfileVersion({
    profileVersionId: negativeIds.mismatchProfileVersionId,
    expectedRevision: mismatchProfile.revision,
    publishedAt: canonicalObservedAt,
  })
  return {
    profileVersion: await store.catalog.getAgentProfileVersion(canonicalIds.profileVersionId),
    negativeProfileId: negativeIds.profileId,
    negativeSkillVersion: await store.catalog.getSkillVersion(negativeIds.skillVersionId),
  }
}

/**
 * Inserts published profile versions that share a version number and a
 * revision, in the given order.
 */
async function insertTiedProfileVersions(harness, profileVersionIds) {
  const skill = await harness.store.catalog.getSkillVersion(canonicalIds.skillVersionId)
  if (skill === undefined) throw new Error('CP558_TIE_SKILL_MISSING')
  for (const profileVersionId of profileVersionIds) {
    await harness.store.catalog.insertAgentProfileVersion({
      profileVersionId,
      profileId: canonicalIds.profileId,
      version: 4,
      revision: 2,
      lifecycle: 'published',
      contentDigest: canonicalDigest('7'),
      definition: {
        ...canonicalProfileDefinition(skill.manifest.contentDigest),
        executionConstraints: structuredClone(executionConstraintFixtures.write),
      },
      createdAt: canonicalObservedAt,
      lifecycleMetadata: { publishedAt: canonicalObservedAt },
    })
  }
}

async function seedProjectState(store, scope, injectedFailure) {
  const projectStates = new ProjectStateService(
    store.projectStates,
    new InMemoryStatePromotionProposalRepository(),
    new RecordingProjectStateEventPublisher()
  )
  try {
    await projectStates.initialize({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      at: canonicalObservedAt,
    })
  } catch {
    // The state already exists in this store; the mutation below is idempotent.
  }
  if (injectedFailure !== undefined) throw injectedFailure
  await projectStates.applyMutation({
    mutationId: 'stm_01JABCDEF0123456789ABCDEFG',
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    expectedRevision: 0,
    actorPrincipalRef: 'principal://operator',
    operations: canonicalStateItems.map((item) => ({
      kind: 'append',
      item: {
        itemId: item.itemId,
        key: item.key,
        value: item.value,
        sensitivity: item.sensitivity,
        freshness: item.freshness,
        provenance: item.provenance,
      },
    })),
    at: canonicalCompiledAt,
  })
}
