import { expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import {
  createPiDurableManagementDecisionIssuer,
  managementCanonicalRequestDigest,
  managementDecisionAudience,
  managementDecisionClaimKeys,
  managementDecisionScope,
} from './management-decision-issuer.ts'

const issuer = 'https://cp-fixture.invalid'
const keyId = 'cp-management-signer-1'
const principalId = 'svc_pi-lead-management'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const targetId = 'prj_01JABCDEF0123456789ABCDEFG'
const now = Date.parse('2026-10-09T12:00:00.000Z')
const canonicalRequest = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function fixture(options = {}) {
  const pair = generateKeyPairSync('ed25519')
  const signer = {
    keyId,
    sign: async (payload) => sign(null, Buffer.from(payload), pair.privateKey),
  }
  const instance = createPiDurableManagementDecisionIssuer({
    issuer,
    principalId,
    signer,
    now: () => now,
    ...options,
  })
  return { instance, publicKey: pair.publicKey }
}

const binding = {
  actionDigest: digest('{"operation":"project.update"}'),
  inputDigest: digest('{"name":"Renamed"}'),
  operation: 'project.update',
  targetDigest: digest('{"targetId":"prj"}'),
  targetId,
  workspaceId,
}

const request = {
  actorUserId: '0f3a2e1c-0000-4000-8000-0000000000bb',
  approval: {
    audienceRef: 'audience:fixture',
    expiresAt: '2026-10-09T12:02:00.000Z',
    interactionId: 'interaction-1',
  },
  audienceRef: 'audience:fixture',
  authorityRef: 'authority-1',
  authorityRevision: 7,
  binding,
  canonicalRequest,
  credentialId: 'credential-1',
  decisionId: 'decision-1',
  intentId: 'intent-1',
  leadAgentId: 'agent-lead-1',
  planRef: 'plan:fixture',
  planRevision: 3,
}

const decode = (token) => {
  const [header, claims, signature] = token.split('.')
  return {
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')),
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    signature: Buffer.from(signature, 'base64url'),
    signingInput: `${header}.${claims}`,
  }
}

test('issues the exact Adea claim grammar bound to the canonical request digest', async () => {
  const { instance, publicKey } = fixture()
  const issued = await instance.issue(request)
  expect(issued.canonicalRequestDigest).toBe(managementCanonicalRequestDigest(canonicalRequest))
  expect(issued.decision.startsWith('eyJ')).toBe(true)
  const decoded = decode(issued.decision)
  expect(Object.keys(decoded.header).toSorted()).toEqual(['alg', 'kid', 'typ'])
  expect(decoded.header).toEqual({ alg: 'EdDSA', kid: keyId, typ: 'JWT' })
  expect(Object.keys(decoded.claims).toSorted()).toEqual(
    [...managementDecisionClaimKeys].toSorted()
  )
  expect(decoded.claims).toMatchObject({
    actionDigest: binding.actionDigest,
    actorUserId: request.actorUserId,
    approvalAudienceRef: request.approval.audienceRef,
    approvalExpiresAt: request.approval.expiresAt,
    approvalInteractionId: request.approval.interactionId,
    audience: managementDecisionAudience,
    audienceRef: request.audienceRef,
    authorityRevision: 7,
    canonicalRequestDigest: issued.canonicalRequestDigest,
    credentialId: 'credential-1',
    credentialKind: 'service',
    decision: 'allowed',
    decisionId: 'decision-1',
    expiresAt: '2026-10-09T12:02:00.000Z',
    inputDigest: binding.inputDigest,
    intentId: 'intent-1',
    issuedAt: '2026-10-09T12:00:00.000Z',
    issuer,
    keyId,
    leadAgentId: 'agent-lead-1',
    operation: 'project.update',
    planRef: 'plan:fixture',
    planRevision: 3,
    principalId,
    projectIds: [],
    scopes: [managementDecisionScope],
    targetDigest: binding.targetDigest,
    targetId,
    workspaceIds: [workspaceId],
  })
  expect(verify(null, Buffer.from(decoded.signingInput), publicKey, decoded.signature)).toBe(true)
})

test('the digest matches Adea canonical JSON for reordered keys and nested values', async () => {
  const { instance } = fixture()
  const issued = await instance.issue({
    ...request,
    canonicalRequest: { toolCallId: 'x', nested: { b: [1, true, null], a: 'n' }, attemptId: 'a' },
  })
  const expected = `sha256:${createHash('sha256')
    .update('{"attemptId":"a","nested":{"a":"n","b":[1,true,null]},"toolCallId":"x"}')
    .digest('hex')}`
  expect(issued.canonicalRequestDigest).toBe(expected)
})

test('lifetime is bounded and derived from the injected clock', async () => {
  const { instance } = fixture({ lifetimeMs: 300_000 })
  const issued = await instance.issue(request)
  expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt)).toBe(300_000)
  expect(() =>
    createPiDurableManagementDecisionIssuer({
      issuer,
      principalId,
      signer: { keyId, sign: async () => new Uint8Array(64) },
      lifetimeMs: 300_001,
    })
  ).toThrow('PI_MANAGEMENT_DECISION_INVALID')
})

test('rejects malformed digests, bindings and expired approvals before signing', async () => {
  let signed = 0
  const pair = generateKeyPairSync('ed25519')
  const instance = createPiDurableManagementDecisionIssuer({
    issuer,
    principalId,
    signer: {
      keyId,
      async sign(payload) {
        signed++
        return sign(null, Buffer.from(payload), pair.privateKey)
      },
    },
    now: () => now,
  })
  const invalid = [
    { ...request, binding: { ...binding, actionDigest: 'sha256:nope' } },
    { ...request, binding: { ...binding, targetId: '' } },
    { ...request, actorUserId: 'not-a-uuid' },
    { ...request, authorityRevision: 0 },
    { ...request, planRevision: 0 },
    { ...request, approval: { ...request.approval, expiresAt: '2026-10-09T11:59:00.000Z' } },
    { ...request, canonicalRequest: undefined },
    { ...request, canonicalRequest: () => undefined },
    { ...request, canonicalRequest: { value: Number.NaN } },
    { ...request, canonicalRequest: new Date() },
    { ...request, extra: true },
  ]
  for (const input of invalid) {
    await expect(instance.issue(input)).rejects.toThrow('PI_MANAGEMENT_DECISION_INVALID')
  }
  expect(signed).toBe(0)
})

test('rejects a signature that is not 64 bytes', async () => {
  const instance = createPiDurableManagementDecisionIssuer({
    issuer,
    principalId,
    signer: { keyId, sign: async () => new Uint8Array(63) },
    now: () => now,
  })
  await expect(instance.issue(request)).rejects.toThrow('PI_MANAGEMENT_DECISION_INVALID')
})

test('bounds the canonical request size', async () => {
  const { instance } = fixture()
  const oversized = { value: 'x'.repeat(200_000) }
  expect(managementCanonicalRequestDigest(oversized)).toBeNull()
  await expect(instance.issue({ ...request, canonicalRequest: oversized })).rejects.toThrow(
    'PI_MANAGEMENT_DECISION_INVALID'
  )
})
