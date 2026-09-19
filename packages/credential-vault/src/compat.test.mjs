import { describe, expect, test } from 'bun:test'
import {
  CredentialVault as EffectVault,
  NeonEncryptedSecretProvider as EffectProvider,
} from './index.ts'
// legacy.ts is a frozen byte-exact snapshot of the pre-Effect implementation
// (git blob 37006db on origin/main), used only to prove cross-implementation
// compatibility. It is excluded from the package build.
import {
  CredentialVault as LegacyVault,
  NeonEncryptedSecretProvider as LegacyProvider,
} from './legacy.ts'

const ids = {
  credential: 'crd_01JABCDEF0123456789ABCDEFG',
  credential2: 'crd_01JABCDEF0123456789ABCDEFH',
  lease: 'crl_01JABCDEF0123456789ABCDEFG',
  lease2: 'crl_01JABCDEF0123456789ABCDEFH',
  lease3: 'crl_01JABCDEF0123456789ABCDPGA',
  workspace: 'wsp_01JABCDEF0123456789ABCDEFG',
  otherWorkspace: 'wsp_01JABCDEF0123456789ABCDEFZ',
  request: 'req_01JABCDEF0123456789ABCDEFG',
}
const secret = 'secret-taint-SENTINEL-9f4a'
const snapshot = { policyId: 'workspace-standard', version: 1, digest: `sha256:${'a'.repeat(64)}` }

const deterministicPdp = () => ({
  requests: [],
  authorize(request) {
    this.requests.push(request)
    return Promise.resolve({
      effect: 'allow',
      decisionId: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'CEDAR_PERMIT',
      policySnapshot: request.policySnapshot,
      evaluatedAt: request.context.requestedAt,
    })
  },
})

const makeStore = () => {
  const map = new Map()
  return {
    map,
    async put(input) {
      map.set(`${input.locator}:${input.version}`, { ...input })
    },
    async get(input) {
      const record = map.get(`${input.locator}:${input.version}`)
      return record === undefined ? undefined : { ...record }
    },
    async delete(input) {
      map.delete(`${input.locator}:${input.version}`)
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

const scope = {
  workspaceId: ids.workspace,
  operation: 'issues.create',
  resourceRef: 'tool:github.issues',
}

async function makeVault(VaultClass, ProviderClass) {
  const provider = new ProviderClass({
    store: makeStore(),
    encryptionKey: 'a'.repeat(64),
    keyReference: 'control-plane-secret-key-v1',
  })
  let now = '2026-08-25T09:00:00.000Z'
  const decisionPoint = deterministicPdp()
  const vault = new VaultClass({ provider, decisionPoint, now: () => now })
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
    metadata,
    provider,
    decisionPoint,
    setNow: (value) => {
      now = value
    },
  }
}

describe('cross-implementation ciphertext compatibility (AES-256-GCM, aad-v1)', () => {
  test('legacy implementation decrypts Effect-produced ciphertext', async () => {
    const effectStore = makeStore()
    const effectProvider = new EffectProvider({
      store: effectStore,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const legacyProvider = new LegacyProvider({
      store: effectStore, // reads the same records the Effect provider wrote
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const reference = await effectProvider.store({
      credentialId: ids.credential,
      revision: 1,
      secret,
    })
    expect(await legacyProvider.resolve(reference)).toBe(secret)
  })

  test('Effect implementation decrypts legacy-produced ciphertext', async () => {
    const legacyStore = makeStore()
    const legacyProvider = new LegacyProvider({
      store: legacyStore,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const effectProvider = new EffectProvider({
      store: legacyStore, // reads the same records the legacy provider wrote
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const reference = await legacyProvider.store({
      credentialId: ids.credential,
      revision: 1,
      secret,
    })
    expect(await effectProvider.resolve(reference)).toBe(secret)
  })

  test('serialized store records carry identical fields and formats', async () => {
    const effectStore = makeStore()
    const legacyStore = makeStore()
    const effectProvider = new EffectProvider({
      store: effectStore,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const legacyProvider = new LegacyProvider({
      store: legacyStore,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const effectReference = await effectProvider.store({
      credentialId: ids.credential,
      revision: 1,
      secret,
    })
    const legacyReference = await legacyProvider.store({
      credentialId: ids.credential,
      revision: 1,
      secret,
    })
    const effectRecord = [...effectStore.map.values()][0]
    const legacyRecord = [...legacyStore.map.values()][0]
    expect(Object.keys(effectRecord).toSorted()).toEqual(Object.keys(legacyRecord).toSorted())
    expect(effectRecord.locator).toBe(legacyRecord.locator)
    expect(effectRecord.keyReference).toBe(legacyRecord.keyReference)
    expect(effectRecord.encryptionVersion).toBe('aad-v1')
    expect(legacyRecord.encryptionVersion).toBe('aad-v1')
    // base64url encodings, not base64
    expect(effectRecord.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(effectRecord.iv).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(effectRecord.authTag).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(effectReference.ciphertextDigest).toBe(legacyReference.ciphertextDigest)
    expect(JSON.stringify({ effectRecord, legacyRecord })).not.toContain(secret)
  })

  test('AAD binding failures are equivalent across implementations', async () => {
    const tampered = makeStore()
    const effectProvider = new EffectProvider({
      store: tampered,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const legacyProvider = new LegacyProvider({
      store: tampered,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const reference = await effectProvider.store({
      credentialId: ids.credential,
      revision: 1,
      secret,
    })
    const record = tampered.map.get(`${reference.locator}:${reference.version}`)
    // Tampering with the IV must break GCM authentication for both implementations.
    tampered.map.set(`${reference.locator}:${reference.version}`, {
      ...record,
      iv: Buffer.from('000000000000', 'binary').toString('base64url'),
    })
    await expect(legacyProvider.resolve(reference)).rejects.toThrow('SECRET_CORRUPTED')
    await expect(effectProvider.resolve(reference)).rejects.toThrow('SECRET_CORRUPTED')
  })
})

describe('cross-implementation lease-lifecycle parity', () => {
  test('identical fixtures produce identical leases, metadata, and audit trails', async () => {
    const effect = await makeVault(EffectVault, EffectProvider)
    const legacy = await makeVault(LegacyVault, LegacyProvider)

    const effectLease = await effect.vault.lease(leaseRequest())
    const legacyLease = await legacy.vault.lease(leaseRequest())
    // capabilityRef is deterministic (hash of leaseId + decisionId + expiresAt):
    // equality here proves the serialized lease record format is unchanged.
    expect(effectLease).toEqual(legacyLease)
    expect(effectLease.capabilityRef).toBe(legacyLease.capabilityRef)
    expect(effect.metadata).toEqual(legacy.metadata)
    expect(await effect.vault.audit()).toEqual(await legacy.vault.audit())

    const effectUsed = await effect.vault.use(effectLease.capabilityRef, scope, async () => ({
      ok: true,
    }))
    const legacyUsed = await legacy.vault.use(legacyLease.capabilityRef, scope, async () => ({
      ok: true,
    }))
    expect(effectUsed).toEqual(legacyUsed)
    expect(await effect.vault.audit()).toEqual(await legacy.vault.audit())
  })

  test('error taxonomy and ordering match across every rejection path', async () => {
    const effect = await makeVault(EffectVault, EffectProvider)
    const legacy = await makeVault(LegacyVault, LegacyProvider)

    const code = async (run) => {
      try {
        await run()
        return undefined
      } catch (error) {
        // Class-identity agnostic: each module defines its own CredentialVaultError class.
        if (error.name === 'CredentialVaultError') return error.code
        return `RAW:${error.name}`
      }
    }

    const scenarios = [
      ['duplicate create', (f) => () =>
        f.vault.create({
          credentialId: ids.credential,
          workspaceId: ids.workspace,
          connectorRef: 'connector:github',
          provider: 'github',
          secret: 'another-secret-long-enough',
          createdAt: '2026-08-25T09:00:00.000Z',
        })],
      ['missing credential', (f) => () => f.vault.metadata('crd_01JZZZZZZZZZZZZZZZZZZZZZZZ')],
      ['invalid secret length', (f) => () =>
        f.vault.create({
          credentialId: ids.credential2,
          workspaceId: ids.workspace,
          connectorRef: 'connector:github',
          provider: 'github',
          secret: 'short',
          createdAt: '2026-08-25T09:00:00.000Z',
        })],
      ['malformed credential id', (f) => () =>
        f.vault.create({
          credentialId: 'not-an-id',
          workspaceId: ids.workspace,
          connectorRef: 'connector:github',
          provider: 'github',
          secret: 'long-enough-secret',
          createdAt: '2026-08-25T09:00:00.000Z',
        })],
      ['clock skew beyond window', (f) => () =>
        f.vault.lease(
          leaseRequest({
            requestedAt: '2027-08-25T09:00:00.000Z',
            expiresAt: '2027-08-25T09:05:00.000Z',
          })
        )],
      ['ttl beyond maximum', (f) => () =>
        f.vault.lease(
          leaseRequest({
            expiresAt: '2026-08-25T10:00:00.000Z',
          })
        )],
      ['workspace scope mismatch', (f) => () =>
        f.vault.lease(leaseRequest({ workspaceId: ids.otherWorkspace }))],
      ['policy deny', (f) => {
        const allow = f.decisionPoint.authorize
        f.decisionPoint.authorize = async (request) => ({
          effect: 'deny',
          decisionId: `sha256:${'c'.repeat(64)}`,
          reasonCode: 'RULE_X',
          policySnapshot: request.policySnapshot,
          evaluatedAt: request.context.requestedAt,
        })
        return async () => {
          try {
            return await f.vault.lease(leaseRequest({ credentialLeaseId: ids.lease2 }))
          } finally {
            f.decisionPoint.authorize = allow
          }
        }
      }],
      ['policy evaluator failure', (f) => {
        const allow = f.decisionPoint.authorize
        f.decisionPoint.authorize = async () => {
          throw new Error(`provider failure ${secret}`)
        }
        return async () => {
          try {
            return await f.vault.lease(leaseRequest({ credentialLeaseId: ids.lease2 }))
          } finally {
            f.decisionPoint.authorize = allow
          }
        }
      }],
    ]

    for (const [name, scenario] of scenarios) {
      const effectCode = await code(scenario(effect))
      const legacyCode = await code(scenario(legacy))
      expect([name, effectCode]).toEqual([name, legacyCode])
    }

    const effectLease = await effect.vault.lease(
      leaseRequest({ credentialLeaseId: ids.lease3 })
    )
    const legacyLease = await legacy.vault.lease(
      leaseRequest({ credentialLeaseId: ids.lease3 })
    )
    expect(effectLease.capabilityRef).toBe(legacyLease.capabilityRef)

    // egress blocking
    const egressScope = { ...scope }
    const effectEgress = await code(() =>
      effect.vault.use(effectLease.capabilityRef, egressScope, async (value) => ({ token: value }))
    )
    const legacyEgress = await code(() =>
      legacy.vault.use(legacyLease.capabilityRef, egressScope, async (value) => ({ token: value }))
    )
    expect(['egress', effectEgress]).toEqual(['egress', legacyEgress])
    expect(effectEgress).toBe('SECRET_EGRESS_BLOCKED')

    // replay of the consumed lease
    const replayEffect = await code(() =>
      effect.vault.use(effectLease.capabilityRef, egressScope, async () => true)
    )
    const replayLegacy = await code(() =>
      legacy.vault.use(legacyLease.capabilityRef, egressScope, async () => true)
    )
    expect(['replay', replayEffect]).toEqual(['replay', replayLegacy])

    // unknown capability ref
    const missingEffect = await code(() => effect.vault.use('lease://nope/x', scope, async () => true))
    const missingLegacy = await code(() => legacy.vault.use('lease://nope/x', scope, async () => true))
    expect(['missing', missingEffect]).toEqual(['missing', missingLegacy])

    // revocation cascades
    await effect.vault.revoke(ids.credential, 'operator:security')
    await legacy.vault.revoke(ids.credential, 'operator:security')
    const revokedLeaseEffect = await code(() =>
      effect.vault.lease(leaseRequest({ credentialLeaseId: ids.lease2 }))
    )
    const revokedLeaseLegacy = await code(() =>
      legacy.vault.lease(leaseRequest({ credentialLeaseId: ids.lease2 }))
    )
    expect(['revoked', revokedLeaseEffect]).toEqual(['revoked', revokedLeaseLegacy])
    expect(effect.metadata).toEqual(legacy.metadata)
    expect(await effect.vault.audit()).toEqual(await legacy.vault.audit())
  })
})
