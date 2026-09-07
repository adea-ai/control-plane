import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ControlApiFixtures } from '@control-plane/contracts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { VersionedCatalog, executionConstraintFixtures } from '@control-plane/domain'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { LocalControlApiComposition } from './local-api-composition.ts'

test('local composition replays validation after a SQLite reopen without compilation inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-validation-replay-'))
  const path = join(directory, 'state.sqlite')
  let persistence = new SqlitePersistenceProvider({ path })
  const now = '2026-09-07T12:00:00.000Z'
  try {
    await persistence.migrate()
    const composition = new LocalControlApiComposition(persistence, 'http://127.0.0.1:9')
    const catalog = new VersionedCatalog(composition.catalog, composition.catalog)
    const profileId = 'prf_01JABCDEF0123456789ABCDEFG'
    const profileVersionId = 'pfv_01JABCDEF0123456789ABCDEFG'
    const constraints = executionConstraintFixtures.write
    await catalog.createAgentProfile({
      profileId,
      displayName: 'Replay fixture',
      ownership: { scope: 'system' },
      createdAt: now,
    })
    const draft = await catalog.createAgentProfileDraft({
      profileId,
      profileVersionId,
      version: 1,
      createdAt: now,
      definition: {
        schemaVersion: 1,
        roleInstructions: 'Complete the fixture.',
        skills: [],
        capabilityRequirements: [],
        executionConstraints: constraints,
        outputContractRefs: ['contract://execution-result/v1'],
      },
    })
    await catalog.publishAgentProfileVersion({
      profileVersionId,
      expectedRevision: draft.revision,
      publishedAt: now,
    })
    const package_ = contextPackageSerializationFixtures.futurePi
    await composition.contextPackages.put(package_)
    await composition.projectStates.create({
      schemaVersion: 1,
      ...package_.projectState,
      items: [],
      createdAt: now,
      updatedAt: now,
    })
    const base = ControlApiFixtures.executionValidation.request
    const request = {
      ...base,
      workspaceId: package_.projectState.workspaceId,
      projectId: package_.projectState.projectId,
      payload: {
        ...base.payload,
        profileVersionId,
        skillVersionIds: [],
        projectState: package_.projectState,
        contextPackage: {
          contextPackageId: package_.contextPackageId,
          contentDigest: package_.contentDigest,
          schemaVersion: package_.schemaVersion,
          compilerVersion: package_.compiler.version,
        },
        policySnapshot: {
          policySnapshotId: constraints.policySnapshot.policyId,
          revision: constraints.policySnapshot.version,
          contentDigest: constraints.policySnapshot.digest,
        },
        runtimeRequirements: ['stream.output'],
        outputContractRef: 'contract://execution-result/v1',
      },
    }
    let ticks = 0
    composition.executionValidationService.options.now = () =>
      new Date(Date.parse(now) + ticks++ * 1000).toISOString()
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        composition.executionValidationService.validate(request, request.caller.servicePrincipalId)
      )
    )
    for (const result of results)
      expect(result.data.executionPlan).toEqual(results[0].data.executionPlan)
    await persistence.transaction(async (transaction) => {
      expect(await transaction.list('execution-validation-commands')).toHaveLength(1)
      expect(await transaction.list('execution-plans')).toHaveLength(1)
    })
    await persistence.close()
    persistence = new SqlitePersistenceProvider({ path })
    await persistence.migrate()
    const reopened = new LocalControlApiComposition(persistence, 'http://127.0.0.1:9')
    const unexpected = async () => {
      throw new Error('REPLAY_RECOMPILED')
    }
    Object.assign(reopened.executionValidationService.options, {
      now: () => {
        throw new Error('REPLAY_READ_CLOCK')
      },
      profiles: { getAgentProfileVersion: unexpected },
      projectStates: { getAtRevision: unexpected },
      skills: { getSkillVersion: unexpected },
      contextPackages: { get: unexpected },
    })
    const replay = await reopened.executionValidationService.validate(
      { ...request, issuedAt: '2026-09-08T12:00:00.000Z' },
      request.caller.servicePrincipalId
    )
    expect(replay.data.executionPlan).toEqual(results[0].data.executionPlan)
    expect(await reopened.executionPlans.get(replay.data.executionPlan)).toBeDefined()
    await expect(
      reopened.executionValidationService.validate(
        { ...request, payload: { ...request.payload, outputContractRef: 'contract://changed/v1' } },
        request.caller.servicePrincipalId
      )
    ).rejects.toMatchObject({ status: 409 })
  } finally {
    await persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})
