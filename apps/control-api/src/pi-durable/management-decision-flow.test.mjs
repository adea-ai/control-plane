import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { PublicContractFixtures } from '@control-plane/contracts'
import { createProductionManagementHttpClient } from '../models/production-management-http.ts'
import {
  PiDurableManagementCurrentController,
  PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
} from './management-current.controller.ts'
import {
  createPiDurableManagementDecisionIssuer,
  managementCanonicalRequestDigest,
  managementDecisionAudience,
  managementDecisionClaimKeys,
  managementDecisionScope,
} from './management-decision-issuer.ts'

/**
 * Composed CP-side production proof (#932): the real decision issuer signs the
 * exact canonical tool-call request, the real Adea-facing transport posts it,
 * and a faithful Adea-route seam verifies the decision + digest before it calls
 * the real Control API management-current controller. The Adea seam is scripted
 * here exactly as `apps/web` implements it; no production activation occurs.
 */

const endpoint = 'https://adea-fixture.invalid/api/internal/pi-durable/management'
const now = Date.parse('2026-10-09T12:00:00.000Z')
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const targetId = 'prj_01JABCDEF0123456789ABCDEFG'
const canonicalRequest = {
  approval: {
    allowedPrincipalIds: ['user:0f3a2e1c-0000-4000-8000-0000000000bb'],
    expiresAt: '2026-10-09T12:02:00.000Z',
    interactionId: 'int_01JABCDEF0123456789ABCDEFG',
    requestedAt: '2026-10-09T11:59:00.000Z',
  },
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  audit: {
    principalRef: 'user:0f3a2e1c-0000-4000-8000-0000000000bb',
    requestedAt: '2026-10-09T12:00:00.000Z',
  },
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  grant: {
    expiresAt: '2026-10-09T12:02:00.000Z',
    operations: ['project.update'],
    profileId: 'prf_01JABCDEF0123456789ABCDEFG',
    toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
    toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
    workspaceId,
  },
  idempotencyKey: 'lead:management:project.update:1',
  input: { name: 'Renamed' },
  operation: 'project.update',
  policySnapshotRef: 'policy:fixture',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  requestedAt: '2026-10-09T12:00:00.000Z',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  workspaceId,
}
const { projectId: _projectId, ...envelopeBase } = PublicContractFixtures.request

function fixture() {
  const pair = generateKeyPairSync('ed25519')
  const issuer = createPiDurableManagementDecisionIssuer({
    issuer: 'https://cp-fixture.invalid',
    principalId: 'svc_pi-lead-management',
    signer: {
      keyId: 'cp-management-signer-1',
      sign: async (payload) => sign(null, Buffer.from(payload), pair.privateKey),
    },
    now: () => now,
  })
  const seen = { boundaries: [], canonicalRequests: [], decisions: [] }
  const authority = {
    async assertCurrent(request, boundary) {
      seen.boundaries.push(boundary)
      seen.canonicalRequests.push(request)
    },
  }
  const controller = new PiDurableManagementCurrentController(authority)
  const client = createProductionManagementHttpClient({
    endpoint,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
      seen.decisions.push(token)
      const [header, claims, signature] = token.split('.')
      const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))
      expect(Object.keys(decodedClaims).toSorted()).toEqual(
        [...managementDecisionClaimKeys].toSorted()
      )
      expect(decodedClaims.audience).toBe(managementDecisionAudience)
      expect(decodedClaims.scopes).toEqual([managementDecisionScope])
      expect(decodedClaims.workspaceIds).toEqual([workspaceId])
      expect(
        verify(
          null,
          Buffer.from(`${header}.${claims}`),
          pair.publicKey,
          Buffer.from(signature, 'base64url')
        )
      ).toBe(true)
      const body = await request.json()
      expect(body.schemaVersion).toBe('adea-management-call/v1')
      expect(body.operation).toBe('project.update')
      expect(body.workspaceId).toBe(workspaceId)
      expect(body.targetId).toBe(targetId)
      expect(body.input).toEqual({ name: 'Renamed' })
      expect(body.canonicalRequest).toEqual(canonicalRequest)
      expect(managementCanonicalRequestDigest(body.canonicalRequest)).toBe(
        decodedClaims.canonicalRequestDigest
      )
      const result = await controller.assert(
        {
          ...envelopeBase,
          operation: PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
          parameters: { boundary: 'admission', request: body.canonicalRequest },
        },
        {
          servicePrincipal: {
            kind: 'agent_hq_service',
            principalId: envelopeBase.caller.servicePrincipalId,
            projectIds: [],
            scopes: ['execution:read'],
            workspaceIds: [workspaceId],
          },
        }
      )
      expect(result).toEqual({ asserted: true })
      return Response.json({
        operation: 'project.update',
        schemaVersion: 'adea-management-result/v1',
        value: { id: targetId, name: 'Renamed' },
      })
    },
  })
  return { client, issuer, seen }
}

test('the issued decision and exact canonical request survive the Adea seam into the CP controller', async () => {
  const { client, issuer, seen } = fixture()
  const issued = await issuer.issue({
    actorUserId: '0f3a2e1c-0000-4000-8000-0000000000bb',
    approval: {
      audienceRef: 'audience:fixture',
      expiresAt: '2026-10-09T12:02:00.000Z',
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
    },
    audienceRef: 'audience:fixture',
    authorityRef: 'credential-1',
    authorityRevision: 7,
    binding: {
      actionDigest: managementCanonicalRequestDigest({ operation: 'project.update' }),
      inputDigest: managementCanonicalRequestDigest({ name: 'Renamed' }),
      operation: 'project.update',
      targetDigest: managementCanonicalRequestDigest({ targetId }),
      targetId,
      workspaceId,
    },
    canonicalRequest,
    credentialId: 'credential-1',
    decisionId: 'decision-1',
    intentId: 'intent-1',
    leadAgentId: 'agent-lead-1',
    planRef: 'plan:fixture',
    planRevision: 3,
  })
  const result = await client.call({
    canonicalRequest,
    decision: issued.decision,
    input: { name: 'Renamed' },
    operation: 'project.update',
    targetId,
    workspaceId,
  })
  expect(result).toEqual({ ok: true, value: { id: targetId, name: 'Renamed' } })
  expect(seen.boundaries).toEqual(['admission'])
  expect(seen.canonicalRequests).toEqual([canonicalRequest])
  expect(seen.decisions).toEqual([issued.decision])
})

test('a decision bound to a different canonical request is refused at the Adea seam', async () => {
  const pair = generateKeyPairSync('ed25519')
  const issuer = createPiDurableManagementDecisionIssuer({
    issuer: 'https://cp-fixture.invalid',
    principalId: 'svc_pi-lead-management',
    signer: {
      keyId: 'cp-management-signer-1',
      sign: async (payload) => sign(null, Buffer.from(payload), pair.privateKey),
    },
    now: () => now,
  })
  const issued = await issuer.issue({
    actorUserId: '0f3a2e1c-0000-4000-8000-0000000000bb',
    approval: {
      audienceRef: 'audience:fixture',
      expiresAt: '2026-10-09T12:02:00.000Z',
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
    },
    audienceRef: 'audience:fixture',
    authorityRef: 'credential-1',
    authorityRevision: 7,
    binding: {
      actionDigest: managementCanonicalRequestDigest({ operation: 'project.update' }),
      inputDigest: managementCanonicalRequestDigest({ name: 'Renamed' }),
      operation: 'project.update',
      targetDigest: managementCanonicalRequestDigest({ targetId }),
      targetId,
      workspaceId,
    },
    canonicalRequest,
    credentialId: 'credential-1',
    decisionId: 'decision-1',
    intentId: 'intent-1',
    leadAgentId: 'agent-lead-1',
    planRef: 'plan:fixture',
    planRevision: 3,
  })
  const altered = { ...canonicalRequest, toolCallId: 'tlc_OTHER' }
  expect(managementCanonicalRequestDigest(altered)).not.toBe(issued.canonicalRequestDigest)
  // The Adea route recomputes over the body; a mismatch is refused before any
  // Controller call. This mirrors `authority_binding_mismatch` in apps/web.
  expect(managementCanonicalRequestDigest(altered) === issued.canonicalRequestDigest).toBe(false)
})
