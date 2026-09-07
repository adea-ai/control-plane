import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { ControlApiFixtures } from '@control-plane/contracts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { VersionedCatalog, executionConstraintFixtures } from '@control-plane/domain'
import {
  PostgresCatalogRepository,
  PostgresContextPackageRepository,
  PostgresProjectStateRepository,
  PostgresExecutionPlanRepository,
  executionPlans,
  executionValidationCommands,
} from '@control-plane/database'
import { createIsolatedPostgres } from '@control-plane/testing/postgres'
import { createManagedCloudControlApiComposition } from './cloud-composition.ts'
import { createControlApiApplication } from './application.ts'

test.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'cloud HTTP validation replays after closing its application and PostgreSQL connection',
  async () => {
    const database = await createIsolatedPostgres()
    const applications = []
    const compositions = []
    const logger = { write() {} }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = new Date().toISOString()
    const package_ = contextPackageSerializationFixtures.futurePi
    const base = ControlApiFixtures.executionValidation.request
    const constraints = executionConstraintFixtures.write
    const profileId = 'prf_01JABCDEF0123456789ABCDEFG'
    const profileVersionId = 'pfv_01JABCDEF0123456789ABCDEFG'
    const url = new URL(process.env.DATABASE_URL)
    url.pathname = `/${database.name}`
    const authentication = {
      audience: 'control-plane',
      issuer: 'https://replay.test',
      trustedKeys: [{ keyId: 'replay-key', publicKey: publicKey.export({ format: 'jwk' }).x }],
      revokedCredentialIds: [],
    }
    const configuration = {
      service: 'control-api',
      database: { role: 'application', url: url.toString() },
      serviceAuthentication: authentication,
      restate: { role: 'caller', ingressUrl: 'http://127.0.0.1:9' },
    }
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
    const claims = {
      audience: authentication.audience,
      issuer: authentication.issuer,
      credentialId: 'replay-credential',
      credentialKind: 'service',
      keyId: 'replay-key',
      principalId: request.caller.servicePrincipalId,
      workspaceIds: [request.workspaceId],
      projectIds: [request.projectId],
      scopes: ['execution:validate'],
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    }
    const header = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', kid: claims.keyId, typ: 'JWT' })
    ).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signingInput = `${header}.${payload}`
    const token = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`
    let authorityCalls = 0
    const authoring = {
      authority: {
        authorize: async (principalRef, input) => {
          authorityCalls += 1
          return {
            principalRef,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            constraints: package_.constraints,
            permissions: package_.permissions,
            budgets: package_.budgets,
          }
        },
        resolveArtifact: async () => {
          throw new Error('UNEXPECTED_ARTIFACT_READ')
        },
      },
    }
    async function open(config = configuration, contextAuthoring) {
      const composition = createManagedCloudControlApiComposition(
        config,
        logger,
        undefined,
        contextAuthoring
      )
      compositions.push(composition)
      const metadata = {
        serviceName: 'control-api',
        version: '1.0.0',
        commitSha: 'test',
        environment: 'test',
        instanceId: 'replay',
      }
      const app = await createControlApiApplication({
        ...composition,
        logger,
        metadata,
        health: () => ({ status: 'ok', metadata }),
        readiness: () => ({ status: 'ready', metadata }),
      })
      applications.push(app)
      return { app, composition }
    }
    function send(app, value = request, credential = token) {
      return app.inject({
        method: 'POST',
        url: '/v1/executions/validate',
        headers: { authorization: `Bearer ${credential}` },
        payload: value,
      })
    }
    try {
      const repository = new PostgresCatalogRepository(database.application)
      const catalog = new VersionedCatalog(repository, repository)
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
      await new PostgresContextPackageRepository(database.application).put(package_)
      await new PostgresProjectStateRepository(database.application).create({
        schemaVersion: 1,
        ...package_.projectState,
        items: [],
        createdAt: now,
        updatedAt: now,
      })
      const first = await open(configuration, authoring)
      const results = await Promise.all(Array.from({ length: 8 }, () => send(first.app)))
      for (const result of results) {
        expect(result.statusCode).toBe(200)
        expect(result.json().data.executionPlan).toEqual(results[0].json().data.executionPlan)
      }
      const reference = results[0].json().data.executionPlan
      const plan = await new PostgresExecutionPlanRepository(database.application).get(reference)
      expect(plan).toBeDefined()
      expect(await database.application.select().from(executionPlans)).toHaveLength(1)
      expect(await database.application.select().from(executionValidationCommands)).toHaveLength(1)
      const inline = {
        ...request,
        idempotencyKey: 'cloud-inline-validation-0001',
        payload: {
          ...request.payload,
          contextPackage: undefined,
          contextInputs: {
            objective: 'Complete the fixture.',
            candidates: [],
            successCriteria: ['Done'],
            returnContract: { contractRef: request.payload.outputContractRef },
            budgets: package_.budgets,
          },
        },
      }
      const inlineResponse = await send(first.app, inline)
      expect(inlineResponse.statusCode).toBe(200)
      expect(authorityCalls).toBe(1)
      await first.app.close()
      applications.splice(applications.indexOf(first.app), 1)
      await first.composition.connection.close()
      compositions.splice(compositions.indexOf(first.composition), 1)
      const reopened = await open()
      const unexpected = () => {
        throw new Error('REPLAY_RECOMPILED')
      }
      Object.assign(reopened.composition.executionValidationService.options, {
        now: unexpected,
        profiles: { getAgentProfileVersion: unexpected },
        skills: { getSkillVersion: unexpected },
        projectStates: { getAtRevision: unexpected },
        contextPackages: { get: unexpected },
      })
      const replay = await send(reopened.app, { ...request, issuedAt: now })
      expect(replay.statusCode).toBe(200)
      expect(replay.json().data.executionPlan).toEqual(reference)
      const inlineReplay = await send(reopened.app, inline)
      expect(inlineReplay.statusCode).toBe(200)
      expect(inlineReplay.json().data.executionPlan).toEqual(
        inlineResponse.json().data.executionPlan
      )
      expect(authorityCalls).toBe(1)
      expect(
        (await send(reopened.app, { ...inline, idempotencyKey: 'cloud-unconfigured-inline-0001' }))
          .statusCode
      ).toBe(503)
      expect(
        await new PostgresExecutionPlanRepository(reopened.composition.connection.database).get(
          reference
        )
      ).toEqual(plan)
      expect(
        (
          await send(reopened.app, {
            ...request,
            payload: { ...request.payload, outputContractRef: 'contract://changed/v1' },
          })
        ).statusCode
      ).toBe(409)
      expect((await send(reopened.app, request, 'invalid-credential')).statusCode).toBe(401)
      const revoked = await open({
        ...configuration,
        serviceAuthentication: { ...authentication, revokedCredentialIds: [claims.credentialId] },
      })
      expect((await send(revoked.app)).statusCode).toBe(401)
    } finally {
      await Promise.all(applications.map((app) => app.close()))
      await Promise.all(compositions.map((composition) => composition.connection.close()))
      await database.dispose()
    }
  }
)
