import { describe, expect, test } from 'bun:test'
import {
  CredentialVault,
  CredentialVaultError,
  InMemorySecretProvider,
  NeonEncryptedSecretProvider,
} from './compat.ts'

const ids = {
  credential: 'crd_01JABCDEF0123456789ABCDEFG',
  lease: 'crl_01JABCDEF0123456789ABCDEFG',
  workspace: 'wsp_01JABCDEF0123456789ABCDEFG',
  otherWorkspace: 'wsp_01JABCDEF0123456789ABCDEFH',
  request: 'req_01JABCDEF0123456789ABCDEFG',
}
const secret = 'secret-taint-SENTINEL-9f4a'
const snapshot = { policyId: 'workspace-standard', version: 1, digest: `sha256:${'a'.repeat(64)}` }

const allowPdp = {
  requests: [],
  async authorize(request) {
    this.requests.push(request)
    return {
      effect: 'allow',
      decisionId: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'CEDAR_PERMIT',
      policySnapshot: request.policySnapshot,
      evaluatedAt: request.context.requestedAt,
    }
  },
}

async function fixture(provider = new InMemorySecretProvider()) {
  let now = '2026-08-25T09:00:00.000Z'
  const vault = new CredentialVault({ provider, decisionPoint: allowPdp, now: () => now })
  const metadata = await vault.create({
    credentialId: ids.credential,
    workspaceId: ids.workspace,
    connectorRef: 'connector:github',
    provider: 'github',
    secret,
    createdAt: now,
  })
  return {
    vault,
    provider,
    metadata,
    setNow: (value) => {
      now = value
    },
  }
}

const leaseRequest = (overrides = {}) => ({
  credentialLeaseId: ids.lease,
  credentialId: ids.credential,
  requestId: ids.request,
  workspaceId: ids.workspace,
  principalRef: 'service:tool-gateway',
  operation: 'issues.create',
  resourceRef: 'tool:github.issues',
  requestedAt: '2026-08-25T09:00:00.000Z',
  expiresAt: '2026-08-25T09:02:00.000Z',
  policySnapshot: snapshot,
  ...overrides,
})

describe('connector credential vault', () => {
  test('stores only encrypted references and leases an operation-scoped capability', async () => {
    const { vault, provider, metadata } = await fixture()
    const lease = await vault.lease(leaseRequest())
    expect(metadata).toMatchObject({
      credentialId: ids.credential,
      revision: 1,
      status: 'active',
      connectorRef: 'connector:github',
    })
    expect(JSON.stringify({ metadata, lease, audit: await vault.audit() })).not.toContain(secret)
    expect(await provider.references()).toHaveLength(1)
    expect(allowPdp.requests.at(-1)).toMatchObject({
      action: 'credential:lease',
      policySnapshot: snapshot,
    })
  })

  test('rejects caller timestamps outside the clock-skew window before policy evaluation', async () => {
    const { vault } = await fixture()
    const policyRequestCount = allowPdp.requests.length

    await expect(
      vault.lease(
        leaseRequest({
          requestedAt: '2027-08-25T09:00:00.000Z',
          expiresAt: '2027-08-25T09:05:00.000Z',
        })
      )
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
    await expect(
      vault.lease(
        leaseRequest({
          credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFH',
          requestedAt: '2020-08-25T09:00:00.000Z',
          expiresAt: '2026-08-25T09:05:00.000Z',
        })
      )
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
    expect(allowPdp.requests).toHaveLength(policyRequestCount)
  })

  test('uses the vault clock at the exact accepted skew and lease lifetime boundaries', async () => {
    const { vault } = await fixture()
    const lease = await vault.lease(
      leaseRequest({
        requestedAt: '2026-08-25T08:59:30.000Z',
        expiresAt: '2026-08-25T09:05:00.000Z',
      })
    )

    expect(lease).toMatchObject({
      issuedAt: '2026-08-25T09:00:00.000Z',
      expiresAt: '2026-08-25T09:05:00.000Z',
    })
    expect(allowPdp.requests.at(-1).context.requestedAt).toBe(lease.issuedAt)
  })

  test('uses a secret only inside the provider callback and blocks runtime/model egress', async () => {
    const { vault } = await fixture()
    const lease = await vault.lease(leaseRequest())
    await expect(
      vault.use(
        lease.capabilityRef,
        {
          workspaceId: ids.workspace,
          operation: 'issues.create',
          resourceRef: 'tool:github.issues',
        },
        async (value) => ({ ok: value === secret })
      )
    ).resolves.toEqual({ ok: true })
    await expect(
      vault.use(
        lease.capabilityRef,
        {
          workspaceId: ids.workspace,
          operation: 'issues.create',
          resourceRef: 'tool:github.issues',
        },
        async () => true
      )
    ).rejects.toMatchObject({ code: 'LEASE_CONSUMED' })

    const second = await vault.lease(
      leaseRequest({ credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFH' })
    )
    await expect(
      vault.use(
        second.capabilityRef,
        {
          workspaceId: ids.workspace,
          operation: 'issues.create',
          resourceRef: 'tool:github.issues',
        },
        async (value) => ({ token: value })
      )
    ).rejects.toMatchObject({ code: 'SECRET_EGRESS_BLOCKED' })
    expect(JSON.stringify(await vault.audit())).not.toContain(secret)
  })

  test('denies expired, cross-scope, replayed, and revoked leases without decrypting', async () => {
    const { vault, provider, setNow } = await fixture()
    const crossScope = await vault.lease(leaseRequest())
    await expect(
      vault.use(
        crossScope.capabilityRef,
        {
          workspaceId: ids.otherWorkspace,
          operation: 'issues.create',
          resourceRef: 'tool:github.issues',
        },
        async () => true
      )
    ).rejects.toBeInstanceOf(CredentialVaultError)
    expect(provider.resolveCount).toBe(0)

    setNow('2026-08-25T09:03:00.000Z')
    await expect(
      vault.use(
        crossScope.capabilityRef,
        {
          workspaceId: ids.workspace,
          operation: 'issues.create',
          resourceRef: 'tool:github.issues',
        },
        async () => true
      )
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
    setNow('2026-08-25T09:00:30.000Z')
    await vault.revoke(ids.credential, 'operator:security')
    await expect(
      vault.lease(leaseRequest({ credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFH' }))
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' })
  })

  test('fails closed when policy denies or its evaluator is unavailable', async () => {
    const provider = new InMemorySecretProvider()
    const denying = {
      authorize: async (request) => ({
        effect: 'deny',
        decisionId: `sha256:${'c'.repeat(64)}`,
        reasonCode: 'POLICY_DENIED',
        policySnapshot: request.policySnapshot,
        evaluatedAt: request.context.requestedAt,
      }),
    }
    const deniedVault = new CredentialVault({
      provider,
      decisionPoint: denying,
      now: () => '2026-08-25T09:00:30.000Z',
    })
    await deniedVault.create({
      credentialId: ids.credential,
      workspaceId: ids.workspace,
      connectorRef: 'connector:github',
      provider: 'github',
      secret,
      createdAt: '2026-08-25T09:00:00.000Z',
    })
    await expect(deniedVault.lease(leaseRequest())).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    })

    denying.authorize = async () => {
      throw new Error(`provider failure ${secret}`)
    }
    await expect(
      deniedVault.lease(leaseRequest({ credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFH' }))
    ).rejects.toMatchObject({ code: 'POLICY_DENIED', message: 'POLICY_DENIED' })
    expect(JSON.stringify(await deniedVault.audit())).not.toContain(secret)
  })

  test('rotates secret material while preserving stable connector identity', async () => {
    const { vault } = await fixture()
    const rotated = await vault.rotate(ids.credential, 'new-secret-value', 'operator:rotation')
    expect(rotated).toMatchObject({
      credentialId: ids.credential,
      connectorRef: 'connector:github',
      revision: 2,
      status: 'active',
    })
    expect(JSON.stringify(rotated)).not.toContain('new-secret-value')
    const lease = await vault.lease(
      leaseRequest({ credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFH' })
    )
    await expect(
      vault.use(
        lease.capabilityRef,
        {
          workspaceId: ids.workspace,
          operation: 'issues.create',
          resourceRef: 'tool:github.issues',
        },
        async (value) => value === 'new-secret-value'
      )
    ).resolves.toBe(true)
  })

  test('encrypts Neon-backed secrets without leaking plaintext or provider types into vault contracts', async () => {
    const records = new Map()
    const store = {
      async put(input) {
        records.set(`${input.locator}:${input.version}`, input)
      },
      async get(input) {
        return records.get(`${input.locator}:${input.version}`)
      },
      async delete(input) {
        records.delete(`${input.locator}:${input.version}`)
      },
    }
    const provider = new NeonEncryptedSecretProvider({
      store,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const { vault, metadata } = await fixture(provider)
    expect([...records.values()][0].ciphertext).not.toContain(secret)
    expect([...records.values()][0].encryptionVersion).toBe('aad-v1')
    expect(JSON.stringify(metadata)).not.toContain(secret)
    expect(JSON.stringify(await vault.audit())).not.toContain(secret)
    expect(
      await provider.resolve(
        await provider.store({
          credentialId: ids.credential,
          revision: 2,
          secret,
        })
      )
    ).toBe(secret)
  })

  test('binds encrypted secrets to their locator, version, key reference, and format', async () => {
    const records = new Map()
    const store = {
      async put(input) {
        records.set(`${input.locator}:${input.version}`, { ...input })
      },
      async get(input) {
        const record = records.get(`${input.locator}:${input.version}`)
        return record === undefined ? undefined : { ...record }
      },
      async delete(input) {
        records.delete(`${input.locator}:${input.version}`)
      },
    }
    const provider = new NeonEncryptedSecretProvider({
      store,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const first = await provider.store({
      credentialId: 'cred_01JABCDEF0123456789ABCDEFG',
      revision: 1,
      secret: 'first-secret-value',
    })
    const second = await provider.store({
      credentialId: 'cred_01JBBCDEF0123456789ABCDEFG',
      revision: 1,
      secret: 'second-secret-value',
    })
    const firstRecord = records.get(`${first.locator}:${first.version}`)
    const secondKey = `${second.locator}:${second.version}`
    const secondRecord = records.get(secondKey)

    records.set(secondKey, {
      ...secondRecord,
      ciphertext: firstRecord.ciphertext,
      iv: firstRecord.iv,
      authTag: firstRecord.authTag,
    })
    await expect(provider.resolve(second)).rejects.toThrow('SECRET_CORRUPTED')

    records.set(secondKey, { ...secondRecord, encryptionVersion: 'legacy-v0' })
    await expect(provider.resolve(second)).rejects.toThrow('SECRET_LEGACY_FORMAT')

    records.set(secondKey, { ...secondRecord, keyReference: 'control-plane-secret-key-v2' })
    await expect(provider.resolve(second)).rejects.toThrow('SECRET_MISSING')

    records.set(secondKey, secondRecord)
    await expect(
      provider.resolve({ ...second, keyReference: 'control-plane-secret-key-v2' })
    ).rejects.toThrow('SECRET_MISSING')
  })
})
