import assert from 'node:assert/strict'
import type { PolicyDecisionPoint } from '@control-plane/policy'
import type { CredentialVaultRepository } from './repository.js'
import { CredentialVault, CredentialVaultError, type SecretProvider } from './vault.js'

const workspaceId = 'wsp_01JCV00000000000000000000A'
const otherWorkspaceId = 'wsp_01JCV00000000000000000000B'
const credentialId = 'crd_01JCV00000000000000000000A'
const otherCredentialId = 'crd_01JCV00000000000000000000B'
const thirdCredentialId = 'crd_01JCV00000000000000000000C'
const requestId = 'req_01JCV00000000000000000000A'
const snapshot = {
  policyId: 'workspace-standard',
  version: 1,
  digest: `sha256:${'a'.repeat(64)}`,
} as const

const allowAll: PolicyDecisionPoint = {
  async authorize(request) {
    return {
      effect: 'allow',
      decisionId: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'CONFORMANCE_PERMIT',
      policySnapshot: request.policySnapshot,
      evaluatedAt: request.context.requestedAt,
    }
  },
}

class ConformanceSecretProvider implements SecretProvider {
  readonly secrets = new Map<string, string>()
  async store(input: { credentialId: string; revision: number; secret: string }) {
    const locator = `memory://${input.credentialId}/${input.revision}`
    this.secrets.set(locator, input.secret)
    return {
      backend: 'memory' as const,
      locator,
      version: String(input.revision),
      keyReference: 'memory://conformance',
      encryptionVersion: 'memory-v1' as const,
      ciphertextDigest: `sha256:${'c'.repeat(64)}` as const,
    }
  }
  async resolve(reference: { locator: string }) {
    const secret = this.secrets.get(reference.locator)
    if (secret === undefined) throw new Error('SECRET_MISSING')
    return secret
  }
  async revoke(reference: { locator: string }) {
    this.secrets.delete(reference.locator)
  }
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CredentialVaultError, `expected CredentialVaultError ${code}`)
    assert.equal(error.code, code)
    return true
  })
}

/**
 * Adapter-independent vault semantics. Every durable repository (in-memory, SQLite, PostgreSQL)
 * runs this sequence against a fresh store; it throws on the first divergence.
 */
export async function assertCredentialVaultRepositoryConformance(
  repository: CredentialVaultRepository,
  options: { readonly secretCanary: string } = { secretCanary: 'conformance-canary-SECRET-01' }
): Promise<void> {
  let now = '2026-10-06T09:00:00.000Z'
  const provider = new ConformanceSecretProvider()
  const vault = new CredentialVault({
    provider,
    decisionPoint: allowAll,
    repository,
    now: () => now,
  })
  const firstSecret = `${options.secretCanary}-r1`
  const secondSecret = `${options.secretCanary}-r2`
  const receipt = {
    workspaceId,
    callerId: 'svc_agent-hq',
    operation: 'create' as const,
    idempotencyKey: 'credential-create-conformance-0001',
    payloadHash: 'd'.repeat(64),
  }
  const created = await vault.create({
    credentialId,
    workspaceId,
    connectorRef: 'connector:github',
    provider: 'github',
    secret: firstSecret,
    createdAt: now,
    createdBy: 'svc_agent-hq',
    command: { receipt },
  })
  assert.equal(created.status, 'active')
  assert.equal(created.revision, 1)
  assert.equal(created.createdBy, 'svc_agent-hq')
  const replay = await repository.getCommandReceipt(receipt)
  assert.deepEqual(replay?.result, created)

  // Replays of the receipt and connector conflicts never bind a second secret.
  await rejectsWith(
    vault.create({
      credentialId: otherCredentialId,
      workspaceId,
      connectorRef: 'connector:other',
      provider: 'github',
      secret: secondSecret,
      createdAt: now,
      command: { receipt },
    }),
    'CREDENTIAL_COMMAND_REPLAYED'
  )
  await rejectsWith(
    vault.create({
      credentialId: otherCredentialId,
      workspaceId,
      connectorRef: 'connector:github',
      provider: 'github',
      secret: secondSecret,
      createdAt: now,
    }),
    'CREDENTIAL_CONNECTOR_IN_USE'
  )
  assert.equal(await repository.getCredential(otherCredentialId), undefined)
  assert.equal(provider.secrets.size, 1)

  // Another workspace may bind the same connector name; reads stay workspace-scoped.
  await vault.create({
    credentialId: otherCredentialId,
    workspaceId: otherWorkspaceId,
    connectorRef: 'connector:github',
    provider: 'github',
    secret: secondSecret,
    createdAt: now,
  })
  await rejectsWith(vault.metadata(otherCredentialId, workspaceId), 'CREDENTIAL_MISSING')
  await rejectsWith(
    vault.rotate(otherCredentialId, secondSecret, 'svc_agent-hq', { workspaceId }),
    'CREDENTIAL_MISSING'
  )
  await rejectsWith(
    vault.revoke(otherCredentialId, 'svc_agent-hq', { workspaceId }),
    'CREDENTIAL_MISSING'
  )
  const page = await vault.list(workspaceId, { limit: 10 })
  assert.deepEqual(
    page.credentials.map((credential) => credential.credentialId),
    [credentialId]
  )
  assert.equal(page.nextCredentialId, undefined)

  // Rotation pins existing leases to their revision; new leases select the current revision.
  const leaseInput = {
    credentialId,
    requestId,
    workspaceId,
    principalRef: 'service:tool-gateway',
    operation: 'issues.create',
    resourceRef: 'mcp/github/issues.create',
    requestedAt: now,
    expiresAt: '2026-10-06T09:02:00.000Z',
    policySnapshot: snapshot,
  }
  const scope = {
    workspaceId,
    operation: leaseInput.operation,
    resourceRef: leaseInput.resourceRef,
  }
  const pinned = await vault.lease({
    ...leaseInput,
    credentialLeaseId: 'crl_01JCV00000000000000000000A',
  })
  await rejectsWith(
    vault.lease({ ...leaseInput, credentialLeaseId: 'crl_01JCV00000000000000000000A' }),
    'LEASE_CONFLICT'
  )
  await rejectsWith(
    vault.rotate(credentialId, secondSecret, 'svc_agent-hq', { expectedRevision: 7 }),
    'CREDENTIAL_REVISION_CONFLICT'
  )
  const rotated = await vault.rotate(credentialId, secondSecret, 'svc_agent-hq', {
    workspaceId,
    expectedRevision: 1,
  })
  assert.equal(rotated.revision, 2)
  const current = await vault.lease({
    ...leaseInput,
    credentialLeaseId: 'crl_01JCV00000000000000000000B',
  })
  assert.equal(pinned.credentialRevision, 1)
  assert.equal(current.credentialRevision, 2)
  assert.equal(
    await vault.use(pinned.capabilityRef, scope, (secret) => secret === firstSecret),
    true
  )
  assert.equal(
    await vault.use(current.capabilityRef, scope, (secret) => secret === secondSecret),
    true
  )
  await rejectsWith(
    vault.use(pinned.capabilityRef, scope, () => true),
    'LEASE_CONSUMED'
  )

  // Concurrent uses of one lease decrypt at most once.
  const raced = await vault.lease({
    ...leaseInput,
    credentialLeaseId: 'crl_01JCV00000000000000000000C',
  })
  let decryptions = 0
  const outcomes = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      vault.use(raced.capabilityRef, scope, () => {
        decryptions += 1
        return true
      })
    )
  )
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(decryptions, 1)

  // Scope mismatch and expiry fail closed.
  const scoped = await vault.lease({
    ...leaseInput,
    credentialLeaseId: 'crl_01JCV00000000000000000000D',
  })
  await rejectsWith(
    vault.use(scoped.capabilityRef, { ...scope, workspaceId: otherWorkspaceId }, () => true),
    'LEASE_SCOPE_MISMATCH'
  )
  await rejectsWith(
    vault.lease({
      ...leaseInput,
      credentialLeaseId: 'crl_01JCV00000000000000000000E',
      expiresAt: '2026-10-06T09:05:00.001Z',
    }),
    'LEASE_EXPIRED'
  )
  now = '2026-10-06T09:02:00.000Z'
  await rejectsWith(
    vault.use(scoped.capabilityRef, scope, () => true),
    'LEASE_EXPIRED'
  )
  assert.equal((await repository.getLease(scoped.capabilityRef))?.status, 'expired')

  // Revocation revokes outstanding leases and blocks new ones.
  const outstanding = await vault.lease({
    ...leaseInput,
    credentialLeaseId: 'crl_01JCV00000000000000000000F',
    requestedAt: now,
    expiresAt: '2026-10-06T09:03:00.000Z',
  })
  const revoked = await vault.revoke(credentialId, 'svc_agent-hq', { workspaceId })
  assert.equal(revoked.status, 'revoked')
  assert.equal((await vault.revoke(credentialId, 'svc_agent-hq')).status, 'revoked')
  await rejectsWith(
    vault.use(outstanding.capabilityRef, scope, () => true),
    'LEASE_REVOKED'
  )
  await rejectsWith(
    vault.lease({
      ...leaseInput,
      credentialLeaseId: 'crl_01JCV00000000000000000000G',
      requestedAt: now,
      expiresAt: '2026-10-06T09:03:00.000Z',
    }),
    'CREDENTIAL_REVOKED'
  )
  await rejectsWith(vault.rotate(credentialId, firstSecret, 'svc_agent-hq'), 'CREDENTIAL_REVOKED')
  assert.equal(
    [...provider.secrets.keys()].some((key) => key.includes(credentialId)),
    false
  )

  // A revoked binding frees the connector for a new credential in the same workspace.
  const replacement = await vault.create({
    credentialId: thirdCredentialId,
    workspaceId,
    connectorRef: 'connector:github',
    provider: 'github',
    secret: firstSecret,
    createdAt: now,
  })
  assert.equal(
    (await vault.findByConnector(workspaceId, 'connector:github'))?.credentialId,
    replacement.credentialId
  )
  const firstPage = await vault.list(workspaceId, { limit: 1 })
  assert.equal(firstPage.credentials.length, 1)
  assert.equal(firstPage.nextCredentialId, credentialId)
  const secondPage = await vault.list(workspaceId, {
    limit: 1,
    afterCredentialId: credentialId,
  })
  assert.deepEqual(
    secondPage.credentials.map((credential) => credential.credentialId),
    [thirdCredentialId]
  )

  // Audit and persisted state carry identifiers only.
  const audit = await vault.audit({ workspaceId })
  assert.ok(audit.some((event) => event.action === 'credential.rotated'))
  assert.ok(audit.some((event) => event.action === 'lease.used'))
  assert.ok(audit.every((event) => event.workspaceId === workspaceId))
  const persisted = JSON.stringify({
    audit: await repository.listAudit({}),
    credentials: await repository.listCredentials(workspaceId, { limit: 100 }),
    others: await repository.listCredentials(otherWorkspaceId, { limit: 100 }),
    lease: await repository.getLease(current.capabilityRef),
    receipt: await repository.getCommandReceipt(receipt),
  })
  assert.equal(persisted.includes(options.secretCanary), false)
}
