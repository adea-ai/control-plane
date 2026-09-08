import { afterAll, beforeAll, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { ControlApiFixtures } from '@control-plane/contracts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  VersionedCatalog,
  executionConstraintFixtures,
  CommandInboxService,
  ExecutionLifecycleService,
  InteractionService,
} from '@control-plane/domain'
import {
  PostgresCatalogRepository,
  PostgresContextPackageRepository,
  PostgresProjectStateRepository,
  PostgresExecutionPlanRepository,
  PostgresCommandAcceptanceRepository,
  PostgresExecutionRepository,
  PostgresInteractionRepository,
  PostgresInteractionCommandRepository,
  executionPlans,
  executionValidationCommands,
} from '@control-plane/database'
import { createIsolatedPostgres } from '@control-plane/testing/postgres'
import { createManagedCloudControlApiComposition } from './cloud-composition.ts'
import { createControlApiApplication } from './application.ts'

let database
const applications = []
const compositions = []

test.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'cloud interaction HTTP replay preserves the response identity after a lost signal ACK and API restart',
  async () => {
    const signals = []
    const ingress = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      signals.push({
        url: request.url,
        key: request.headers['idempotency-key'],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      })
      if (signals.length === 1) return response.destroy()
      response.writeHead(202, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          invocationId: 'inv_1bSDgN8dDIPn8wdBx7D4EiU4SaNtmauLF9',
          status: 'PreviouslyAccepted',
        })
      )
    })
    await new Promise((resolve) => ingress.listen(0, '127.0.0.1', resolve))
    const request = structuredClone(ControlApiFixtures.interactionResponse.request)
    const now = new Date().toISOString()
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const url = new URL(process.env.DATABASE_URL)
    url.pathname = `/${database.name}`
    const configuration = {
      service: 'control-api',
      database: { role: 'application', url: url.toString() },
      serviceAuthentication: {
        audience: 'control-plane',
        issuer: 'https://interaction.test',
        trustedKeys: [
          { keyId: 'interaction-key', publicKey: publicKey.export({ format: 'jwk' }).x },
        ],
        revokedCredentialIds: [],
      },
      restate: { role: 'caller', ingressUrl: `http://127.0.0.1:${ingress.address().port}` },
    }
    const claims = {
      audience: 'control-plane',
      issuer: 'https://interaction.test',
      credentialId: 'interaction-credential',
      credentialKind: 'service',
      keyId: 'interaction-key',
      principalId: request.caller.servicePrincipalId,
      workspaceIds: [request.workspaceId],
      projectIds: [request.projectId],
      scopes: ['interaction:respond'],
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    }
    const signingInput = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: claims.keyId, typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
    const token = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`
    async function open() {
      const composition = createManagedCloudControlApiComposition(configuration, { write() {} })
      compositions.push(composition)
      const metadata = {
        serviceName: 'control-api',
        version: 'test',
        commitSha: 'test',
        environment: 'test',
        instanceId: 'interaction',
      }
      const app = await createControlApiApplication({
        ...composition,
        metadata,
        logger: { write() {} },
        health: () => ({ status: 'ok', metadata }),
        readiness: () => ({ status: 'ready', metadata }),
      })
      applications.push(app)
      await app.listen(0, '127.0.0.1')
      return { app, composition, baseUrl: `http://127.0.0.1:${app.getHttpServer().address().port}` }
    }
    const send = (host, payload, credential = token) =>
      fetch(`${host.baseUrl}/v1/interactions/respond`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    try {
      const accepted = await new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(database.application),
        executionIdFactory: () => request.payload.executionId,
        executionPlanValidator: { validate: async () => true },
      }).acceptExecution({
        callerPrincipalId: request.caller.servicePrincipalId,
        operation: 'execution.accept',
        commandId: 'cmd_01JABCDEF0123456789ABCDEFA',
        requestId: request.requestId,
        idempotencyKey: 'interaction-seed',
        payloadHash: 'c'.repeat(64),
        correlation: {
          workspaceId: request.workspaceId,
          projectId: request.projectId,
          taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
          agentId: 'agt_01JABCDEF0123456789ABCDEFG',
        },
        executionPlan: ControlApiFixtures.executionAcceptance.request.payload.executionPlan,
        receivedAt: now,
        retentionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      })
      const lifecycle = new ExecutionLifecycleService(
        new PostgresExecutionRepository(database.application)
      )
      await lifecycle.createAttempt({
        executionId: request.payload.executionId,
        attemptId: request.payload.attemptId,
        expectedExecutionVersion: accepted.execution.version,
        queuedAt: now,
      })
      for (const to of ['queued', 'running']) {
        const current = await lifecycle.getExecution(request.payload.executionId)
        await lifecycle.transitionExecution({
          executionId: current.executionId,
          expectedVersion: current.version,
          to,
          transitionedAt: now,
        })
      }
      const interactions = new PostgresInteractionRepository(database.application)
      await new InteractionService(interactions).request({
        interactionId: request.payload.interactionId,
        executionId: request.payload.executionId,
        attemptId: request.payload.attemptId,
        kind: 'permission',
        prompt: { title: 'Grant fixture permission' },
        allowedActions: ['grant', 'deny'],
        allowedPrincipalIds: [request.caller.servicePrincipalId],
        requestedAt: now,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      })
      request.payload.action = 'grant'
      delete request.payload.value
      const first = await open()
      expect((await send(first, request, 'invalid')).status).toBe(401)
      expect(
        (await send(first, { ...request, projectId: 'prj_01JABCDEF0123456789ABCDEFH' })).status
      ).toBe(403)
      expect(signals).toHaveLength(0)
      expect((await send(first, request)).status).toBe(503)
      const receipts = new PostgresInteractionCommandRepository(database.application)
      expect((await receipts.get(request)).acceptedAt).toBeUndefined()
      expect((await interactions.get(request.payload.interactionId)).response.responseId).toBe(
        request.commandId
      )
      await first.app.close()
      await first.composition.connection.close()
      const second = await open()
      const retry = { ...request, commandId: 'cmd_01JABCDEF0123456789ABCDEFH' }
      const result = await send(second, retry)
      expect(result.status).toBe(202)
      expect((await result.json()).data).toMatchObject({
        responseId: request.commandId,
        replayed: true,
      })
      expect(signals).toHaveLength(2)
      expect(signals[1]).toEqual(signals[0])
      expect(signals[0].url).toBe(
        `/execution-lifecycle/${request.payload.executionId}/respondToInteraction/send`
      )
      expect(signals[0].key).toBe(`${request.payload.interactionId}:${request.commandId}`)
      expect((await receipts.get(request)).acceptedAt).toBeString()
      expect(signals[0].body).toEqual({
        interactionId: request.payload.interactionId,
        responseId: request.commandId,
        action: 'grant',
      })
      expect((await send(second, retry)).status).toBe(202)
      expect(signals).toHaveLength(2)
      expect(
        (await send(second, { ...retry, payload: { ...retry.payload, action: 'deny' } })).status
      ).toBe(409)
      expect(signals).toHaveLength(2)
    } finally {
      ingress.closeAllConnections()
      await new Promise((resolve) => ingress.close(resolve))
    }
  }
)

// Remote schema installation has its own budget; keep the replay behavior's
// 30-second deadline independent of provisioning every migration over the network.
beforeAll(async () => {
  if (process.env.RUN_DATABASE_INTEGRATION !== 'true') return
  database = await createIsolatedPostgres({ migrate: false })
  await database.migrate()
}, 60000)

afterAll(async () => {
  try {
    await Promise.all(applications.map((app) => app.close()))
  } finally {
    try {
      await Promise.all(compositions.map((composition) => composition.connection.close()))
    } finally {
      await database?.dispose()
    }
  }
}, 30000)

test.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'cloud HTTP validation replays after closing its application and PostgreSQL connection',
  async () => {
    const startedAt = performance.now()
    function checkpoint(stage) {
      if (process.env.INTEGRATION_TIMING === 'true')
        console.info(`validation-replay ${stage}: ${Math.round(performance.now() - startedAt)}ms`)
    }
    checkpoint('database-ready')
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
      checkpoint('application-ready')
      const results = await Promise.all(Array.from({ length: 8 }, () => send(first.app)))
      checkpoint('concurrent-validation-complete')
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
      checkpoint('inline-validation-complete')
      await first.app.close()
      checkpoint('application-closed')
      applications.splice(applications.indexOf(first.app), 1)
      await first.composition.connection.close()
      checkpoint('connection-closed')
      compositions.splice(compositions.indexOf(first.composition), 1)
      const reopened = await open()
      checkpoint('application-reopened')
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
      checkpoint('replay-complete')
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
      checkpoint('behavior-complete')
    }
  }
)
