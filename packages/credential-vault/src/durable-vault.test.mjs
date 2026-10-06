import { describe, expect, test } from 'bun:test'
import { assertCredentialVaultRepositoryConformance } from './conformance.ts'
import {
  CredentialVault,
  InMemoryCredentialVaultRepository,
  InMemorySecretProvider,
  NeonEncryptedSecretProvider,
  VaultToolCredentialBroker,
  createCredentialId,
  createCredentialLeaseId,
} from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JABCDEF0123456789ABCDEFH'
const credentialId = 'crd_01JABCDEF0123456789ABCDEFG'
const canary = 'durable-vault-SECRET-canary-7c1e'
const snapshot = { policyId: 'workspace-standard', version: 1, digest: `sha256:${'a'.repeat(64)}` }

function allowPdp() {
  const requests = []
  return {
    requests,
    async authorize(request) {
      requests.push(request)
      return {
        effect: 'allow',
        decisionId: `sha256:${'b'.repeat(64)}`,
        reasonCode: 'CEDAR_PERMIT',
        policySnapshot: request.policySnapshot,
        evaluatedAt: request.context.requestedAt,
      }
    },
  }
}

async function vaultFixture(options = {}) {
  const now = { value: '2026-10-06T09:00:00.000Z' }
  const provider = new InMemorySecretProvider()
  const repository = new InMemoryCredentialVaultRepository()
  const decisionPoint = options.decisionPoint === null ? undefined : allowPdp()
  const vault = new CredentialVault({
    provider,
    repository,
    ...(decisionPoint === undefined ? {} : { decisionPoint }),
    now: () => now.value,
  })
  await vault.create({
    credentialId,
    workspaceId,
    connectorRef: 'connector:linear',
    provider: 'linear',
    secret: canary,
    createdAt: now.value,
    createdBy: 'svc_agent-hq',
  })
  return { vault, provider, repository, decisionPoint, now }
}

describe('durable credential vault', () => {
  test('passes the repository conformance sequence in memory', async () => {
    await assertCredentialVaultRepositoryConformance(new InMemoryCredentialVaultRepository())
  })

  test('generates canonical opaque credential and lease identifiers', () => {
    expect(createCredentialId()).toMatch(/^crd_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(createCredentialLeaseId()).toMatch(/^crl_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(createCredentialId()).not.toBe(createCredentialId())
  })

  test('fails leases closed when the composition has no policy decision point', async () => {
    const { vault } = await vaultFixture({ decisionPoint: null })
    await expect(
      vault.lease({
        credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFG',
        credentialId,
        requestId: 'req_01JABCDEF0123456789ABCDEFG',
        workspaceId,
        principalRef: 'service:tool-gateway',
        operation: 'issues.list',
        resourceRef: 'mcp/linear/issues.list',
        requestedAt: '2026-10-06T09:00:00.000Z',
        expiresAt: '2026-10-06T09:01:00.000Z',
        policySnapshot: snapshot,
      })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    const audit = await vault.audit({ workspaceId })
    expect(audit.at(-1)).toMatchObject({
      action: 'lease.denied',
      reasonCode: 'POLICY_DECISION_POINT_UNAVAILABLE',
    })
  })

  test('requires secret re-entry for metadata without usable secret material', async () => {
    const provider = new InMemorySecretProvider()
    const repository = new InMemoryCredentialVaultRepository()
    await repository.insertCredential({
      metadata: {
        credentialId,
        workspaceId,
        connectorRef: 'connector:linear',
        provider: 'linear',
        status: 'secret_required',
        revision: 3,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      secretRevisions: [],
    })
    const vault = new CredentialVault({
      provider,
      repository,
      decisionPoint: allowPdp(),
      now: () => '2026-10-06T09:00:00.000Z',
    })
    const broker = new VaultToolCredentialBroker({
      vault,
      policySnapshot: () => snapshot,
      now: () => new Date('2026-10-06T09:00:00.000Z'),
    })
    const request = {
      workspaceId,
      connectorRef: 'connector:linear',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      principalRef: 'service:tool-gateway',
      operation: 'issues.list',
      resourceRef: 'mcp/linear/issues.list',
    }
    await expect(broker.withCredential(request, () => true)).rejects.toMatchObject({
      code: 'CREDENTIAL_SECRET_REQUIRED',
    })
    const reentered = await vault.rotate(credentialId, canary, 'operator:import', {
      workspaceId,
      expectedRevision: 3,
    })
    expect(reentered).toMatchObject({ status: 'active', revision: 4 })
    await expect(broker.withCredential(request, (secret) => secret === canary)).resolves.toBe(true)
  })

  test('derives expiry without persisting it and refuses rotation or leases after expiry', async () => {
    const provider = new InMemorySecretProvider()
    const repository = new InMemoryCredentialVaultRepository()
    const now = { value: '2026-10-06T09:00:00.000Z' }
    const vault = new CredentialVault({
      provider,
      repository,
      decisionPoint: allowPdp(),
      now: () => now.value,
    })
    await vault.create({
      credentialId,
      workspaceId,
      connectorRef: 'connector:linear',
      provider: 'linear',
      secret: canary,
      createdAt: now.value,
      expiresAt: '2026-10-06T10:00:00.000Z',
    })
    now.value = '2026-10-06T10:00:00.000Z'
    expect((await vault.metadata(credentialId)).status).toBe('expired')
    expect((await repository.getCredential(credentialId)).metadata.status).toBe('active')
    await expect(vault.rotate(credentialId, canary, 'svc_agent-hq')).rejects.toMatchObject({
      code: 'CREDENTIAL_EXPIRED',
    })
    await expect(
      vault.create({
        credentialId: 'crd_01JABCDEF0123456789ABCDEFH',
        workspaceId,
        connectorRef: 'connector:other',
        provider: 'linear',
        secret: canary,
        createdAt: now.value,
        expiresAt: '2026-10-06T09:30:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' })
  })

  test('rejects secrets outside the accepted length bounds without echoing them', async () => {
    const { vault } = await vaultFixture()
    for (const secret of ['short', 'x'.repeat(65_537), 42]) {
      const failure = await vault
        .rotate(credentialId, secret, 'svc_agent-hq')
        .then(() => undefined)
        .catch((error) => error)
      expect(failure).toMatchObject({ code: 'CREDENTIAL_SECRET_INVALID' })
      expect(String(failure.message)).toBe('CREDENTIAL_SECRET_INVALID')
    }
  })

  test('the broker leases per call for the execution workspace connector and blocks egress', async () => {
    const { vault, decisionPoint } = await vaultFixture()
    const broker = new VaultToolCredentialBroker({
      vault,
      policySnapshot: (requested) => (requested === workspaceId ? snapshot : undefined),
      now: () => new Date('2026-10-06T09:00:00.000Z'),
    })
    const request = {
      workspaceId,
      connectorRef: 'connector:linear',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      principalRef: 'service:tool-gateway',
      operation: 'issues.list',
      resourceRef: 'mcp/linear/issues.list',
    }
    await expect(
      broker.withCredential(request, (secret) => ({ ok: secret === canary }))
    ).resolves.toEqual({ ok: true })
    expect(decisionPoint.requests.at(-1)).toMatchObject({
      action: 'credential:lease',
      resource: { type: 'credential', id: credentialId, workspaceId },
    })
    await expect(
      broker.withCredential(request, (secret) => ({ echoed: secret }))
    ).rejects.toMatchObject({ code: 'SECRET_EGRESS_BLOCKED' })
    await expect(
      broker.withCredential({ ...request, workspaceId: otherWorkspaceId }, () => true)
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    const unsnapshotted = new VaultToolCredentialBroker({
      vault,
      policySnapshot: () => snapshot,
      now: () => new Date('2026-10-06T09:00:00.000Z'),
    })
    await expect(
      unsnapshotted.withCredential({ ...request, workspaceId: otherWorkspaceId }, () => true)
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' })
    await expect(
      unsnapshotted.withCredential({ ...request, connectorRef: 'connector:absent' }, () => true)
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' })
    const failingSnapshot = new VaultToolCredentialBroker({
      vault,
      policySnapshot: () => {
        throw new Error(`snapshot store failure ${canary}`)
      },
    })
    const failure = await failingSnapshot
      .withCredential(request, () => true)
      .catch((error) => error)
    expect(failure).toMatchObject({ code: 'POLICY_DENIED' })
    expect(JSON.stringify(await vault.audit())).not.toContain(canary)
    expect(
      () =>
        new VaultToolCredentialBroker({
          vault,
          policySnapshot: () => snapshot,
          leaseTtlMs: 300_001,
        })
    ).toThrow('CREDENTIAL_LEASE_TTL_INVALID')
  })

  test('secret references never carry a plaintext digest', async () => {
    const memory = await new InMemorySecretProvider().store({
      credentialId,
      revision: 1,
      secret: canary,
    })
    const records = new Map()
    const neon = new NeonEncryptedSecretProvider({
      store: {
        async put(input) {
          records.set(`${input.locator}:${input.version}`, input)
        },
        async get(input) {
          return records.get(`${input.locator}:${input.version}`)
        },
        async delete(input) {
          records.delete(`${input.locator}:${input.version}`)
        },
      },
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const encrypted = await neon.store({ credentialId, revision: 1, secret: canary })
    const plaintextDigest = `sha256:${new Bun.CryptoHasher('sha256').update(canary).digest('hex')}`
    expect(memory.ciphertextDigest).not.toBe(plaintextDigest)
    expect(encrypted.ciphertextDigest).not.toBe(plaintextDigest)
    expect(await neon.resolve(encrypted)).toBe(canary)
  })
})
