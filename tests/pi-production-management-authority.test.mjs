import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PublicContractFixtures } from '@control-plane/contracts'
import { toolInputDigest } from '@control-plane/tool-execution'
import { createControlApiApplication } from '../apps/control-api/src/application.ts'
import { PolicyServiceAuthenticator } from '../apps/control-api/src/auth/service-authentication.ts'
import { PI_DURABLE_MANAGEMENT_CURRENT_OPERATION } from '../apps/control-api/src/pi-durable/management-current.controller.ts'
import {
  createPiDurableManagementDecisionIssuer,
  managementCanonicalRequestDigest,
} from '../apps/control-api/src/pi-durable/management-decision-issuer.ts'
import {
  createPiDurableGovernedManagementCall,
  SqlitePiDurableManagementCallStore,
} from '../apps/control-api/src/pi-durable/management-governed-call.ts'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

/**
 * Actual production composition injection (#932): the launcher supplies the
 * host-governed management `service` plus its retained `interactions`, and the
 * real factory composes the canonical current-authority helper from the
 * fixture's real execution authority, intents, executions and plans. The
 * authority is then exercised against non-canonical input and must fail closed;
 * no provider call, credential or effect occurs.
 */

test('the production composition composes the host management authority and fails closed on non-canonical calls', async () => {
  const interactions = { get: async () => undefined }
  const prepared = []
  const managementAuthority = {
    interactions,
    service: {
      approvals: { repository: interactions },
      calls: {
        get: async (toolCallId) => {
          prepared.push(toolCallId)
          return undefined
        },
      },
      execute: async () => {
        throw new Error('TEST_EXECUTE_MUST_NOT_RUN')
      },
      gateway: {
        prepare: async (request) => {
          prepared.push(request)
          throw new Error('TEST_PREPARE_MUST_NOT_RUN')
        },
      },
    },
  }
  const host = await createProductionFactoryFixture({ managementAuthority })
  try {
    const authority = host.composition.piDurableCurrentToolAuthority
    expect(authority).toBeDefined()
    await expect(authority.assertCurrent({}, 'admission')).rejects.toThrow(
      'PI_TOOL_AUTHORITY_REJECTED'
    )
    await expect(
      authority.assertCurrent({ attemptId: 'not-a-canonical-request' }, 'admission')
    ).rejects.toThrow('PI_TOOL_AUTHORITY_REJECTED')
    await expect(
      authority.assertCurrent({ attemptId: 'att_01JABCDEF0123456789ABCDEFG' }, 'unknown')
    ).rejects.toThrow('PI_TOOL_AUTHORITY_REJECTED')
    expect(prepared).toEqual([])
    expect(host.state.physicalSends).toBe(0)
    expect(host.state.productReads).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
  } finally {
    await host.close()
  }
})

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const uuid = '0f3a2e1c-0000-4000-8000-0000000000bb'

test('an authorized issuer → governed caller → HTTP current-authority route succeeds and revocation refuses', async () => {
  const interactions = { get: async () => undefined }
  const executor = { reference: 'fixture.management.v1', type: 'internal' }
  let serviceRevoked = false
  let call
  const managementAuthority = {
    interactions,
    service: {
      approvals: { repository: interactions },
      calls: {
        get: async (toolCallId) =>
          call?.toolCallId === toolCallId ? structuredClone(call) : undefined,
      },
      execute: async () => {
        throw new Error('TEST_EXECUTE_MUST_NOT_RUN')
      },
      gateway: {
        prepare: async (input) => {
          if (serviceRevoked) throw new Error('TEST_AUTHORITY_REVOKED')
          return {
            executor,
            operation: { approvalMode: 'none', name: input.operation },
            request: input,
            version: {
              executor,
              toolDefinitionId: input.toolDefinitionId,
              toolVersionId: input.toolVersionId,
            },
          }
        },
      },
    },
  }
  const host = await createProductionFactoryFixture({ managementAuthority })
  const databasePath = join(host.directory, 'management-calls.sqlite')
  let application
  try {
    const intentId = host.setIntent()
    const preparation = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    const dispatched = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: preparation.preparationRef,
        }),
        host.principal
      )
    ).data
    await host.composition.adapter.drain()
    const product = host.rawProductEvidence(intentId)
    const authority = host.composition.piDurableCurrentToolAuthority
    expect(authority).toBeDefined()
    const targetId = id('prj')
    const request = {
      attemptId: dispatched.attemptId,
      audit: { principalRef: product.canonicalActorPrincipalId, traceId: id('trc') },
      executionId: dispatched.executionId,
      grant: {
        expiresAt: host.expiresAt,
        operations: ['project.update'],
        profileId: product.profileId,
        toolDefinitionId: id('tld'),
        toolVersionId: id('tlv'),
        workspaceId: host.workspaceId,
      },
      idempotencyKey: 'management:fixture:1',
      input: { name: 'Renamed' },
      operation: 'project.update',
      policySnapshotRef: 'policy://fixture',
      profileId: product.profileId,
      requestId: id('req'),
      requestedAt: host.at,
      toolCallId: id('tlc'),
      toolDefinitionId: id('tld'),
      toolVersionId: id('tlv'),
      workspaceId: host.workspaceId,
    }
    call = {
      attemptId: request.attemptId,
      executionId: request.executionId,
      executor,
      idempotencyKey: request.idempotencyKey,
      inputDigest: toolInputDigest(request.input),
      operation: request.operation,
      policySnapshotRef: request.policySnapshotRef,
      principalRef: request.audit.principalRef,
      profileId: request.profileId,
      requestedAt: request.requestedAt,
      startedAt: host.at,
      status: 'executing',
      toolCallId: request.toolCallId,
      toolDefinitionId: request.toolDefinitionId,
      toolVersionId: request.toolVersionId,
      workspaceId: request.workspaceId,
    }
    await authority.assertCurrent(request, 'admission')
    await authority.assertCurrent(request, 'effect')

    const { projectId: _projectId, ...envelopeBase } = PublicContractFixtures.request
    const envelopeFor = (candidate, boundary) => ({
      ...envelopeBase,
      caller: { servicePrincipalId: host.principal.principalId },
      operation: PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
      parameters: { boundary, request: candidate },
      workspaceId: host.workspaceId,
    })
    const metadata = {
      commitSha: 'test',
      environment: 'test',
      instanceId: 'factory-management-positive',
      serviceName: 'control-api',
      version: 'test',
    }
    application = await createControlApiApplication({
      health: () => ({ metadata, status: 'ok' }),
      logger: { write: () => undefined },
      metadata,
      piDurableCurrentToolAuthority: authority,
      readiness: () => ({ metadata, status: 'ready' }),
      serviceAuthenticator: new PolicyServiceAuthenticator({
        audience: 'control-plane',
        clockSkewMs: 30_000,
        issuer: 'https://agent-hq.example',
        logger: { write: () => undefined },
        now: () => new Date('2026-08-23T12:00:00.000Z'),
        revocationChecker: { isRevoked: async () => false },
        verifier: {
          verify: async () => ({
            audience: 'control-plane',
            credentialId: 'credential-factory-management',
            credentialKind: 'service',
            expiresAt: '2026-08-23T13:00:00.000Z',
            issuedAt: '2026-08-23T12:00:00.000Z',
            issuer: 'https://agent-hq.example',
            keyId: 'test-key',
            principalId: host.principal.principalId,
            projectIds: [],
            scopes: ['execution:read'],
            workspaceIds: [host.workspaceId],
          }),
        },
      }),
    })
    const assertViaHttp = async (candidate, boundary) => {
      const response = await application.inject({
        headers: { authorization: 'Bearer factory-management-token' },
        method: 'POST',
        payload: envelopeFor(candidate, boundary),
        url: '/v1/pi-durable/management-current/assert',
      })
      return { body: response.json(), status: response.statusCode }
    }
    expect(await assertViaHttp(request, 'effect')).toEqual({
      body: { asserted: true },
      status: 200,
    })

    const pair = generateKeyPairSync('ed25519')
    const issuer = createPiDurableManagementDecisionIssuer({
      issuer: 'https://cp-fixture.invalid',
      now: () => Date.parse(host.at),
      principalId: host.principal.principalId,
      signer: {
        keyId: 'fixture-management-key',
        sign: async (payload) => sign(null, Buffer.from(payload), pair.privateKey),
      },
    })
    const decision = async (candidate) =>
      issuer.issue({
        actorUserId: uuid,
        approval: {
          audienceRef: 'audience:fixture',
          expiresAt: new Date(Date.parse(host.at) + 120_000).toISOString(),
          interactionId: 'interaction-1',
        },
        audienceRef: 'audience:fixture',
        authorityRef: 'authority-1',
        authorityRevision: product.authorityRevision,
        binding: {
          actionDigest: managementCanonicalRequestDigest({ operation: candidate.operation }),
          inputDigest: managementCanonicalRequestDigest(candidate.input),
          operation: candidate.operation,
          targetDigest: managementCanonicalRequestDigest({ targetId }),
          targetId,
          workspaceId: host.workspaceId,
        },
        canonicalRequest: candidate,
        credentialId: 'credential-1',
        decisionId: id('dcl'),
        intentId,
        leadAgentId: 'agent-lead-1',
        planRef: 'plan:fixture',
        planRevision: 1,
      })
    const dispatches = []
    const database = new DatabaseSync(databasePath)
    const caller = createPiDurableGovernedManagementCall({
      authority: {
        assertCurrent: (candidate, boundary) => authority.assertCurrent(candidate, boundary),
      },
      callAdea: async (input) => {
        dispatches.push(input)
        const result = await assertViaHttp(input.canonicalRequest, 'effect')
        expect(result.status).toBe(200)
        return { ok: true, value: { id: targetId } }
      },
      issue: async () => decision(request),
      resolveTargetId: () => targetId,
      store: new SqlitePiDurableManagementCallStore(database),
    })
    expect(await caller.execute(request)).toEqual({
      state: 'succeeded',
      value: { id: targetId },
    })
    expect(dispatches).toHaveLength(1)
    const identityKey = JSON.stringify([host.workspaceId, request.idempotencyKey])
    const readDatabase = new DatabaseSync(databasePath)
    const retained = await new SqlitePiDurableManagementCallStore(readDatabase).get(identityKey)
    readDatabase.close()
    expect(retained?.state).toBe('settled')

    // Current-authority revocation: the service and the product revoke, the
    // authority refuses, the route is unavailable and no fresh dispatch occurs.
    serviceRevoked = true
    host.state.revoked = true
    const revokedRequest = {
      ...request,
      idempotencyKey: 'management:fixture:2',
      toolCallId: id('tlc2'),
    }
    await expect(authority.assertCurrent(revokedRequest, 'admission')).rejects.toThrow(
      'PI_TOOL_AUTHORITY_REJECTED'
    )
    const revokedRoute = await assertViaHttp(revokedRequest, 'admission')
    expect(revokedRoute.status).toBe(503)
    expect(JSON.stringify(revokedRoute.body)).toContain('PI_MANAGEMENT_CURRENT_UNAVAILABLE')
    expect(JSON.stringify(revokedRoute.body)).not.toContain('PI_TOOL_AUTHORITY_REJECTED')
    const revokedCaller = createPiDurableGovernedManagementCall({
      authority: {
        assertCurrent: (candidate, boundary) => authority.assertCurrent(candidate, boundary),
      },
      callAdea: async () => {
        dispatches.push('revoked')
        return { ok: true, value: null }
      },
      issue: async () => decision(revokedRequest),
      resolveTargetId: () => targetId,
      store: new SqlitePiDurableManagementCallStore(new DatabaseSync(databasePath)),
    })
    expect(await revokedCaller.execute(revokedRequest)).toEqual({
      code: 'authority_unavailable',
      state: 'refused',
    })
    expect(dispatches).toHaveLength(1)
  } finally {
    await application?.close()
    await host.close()
  }
})
