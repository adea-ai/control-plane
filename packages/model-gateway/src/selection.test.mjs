import { expect, test } from 'bun:test'
import { RuntimeProviderSelectionSchema, ModelConnectionSchema } from './selection.ts'

import { connection, selection } from './selection-fixtures.mjs'

test('accepts truthful BYO API provenance and rejects secret-bearing or mismatched selections', () => {
  expect(RuntimeProviderSelectionSchema.parse(selection)).toEqual(selection)
  for (const invalid of [
    { ...selection, secret: 'secret-canary-1234' },
    { ...selection, credentialRef: 'vault://raw-secret' },
    { ...selection, fundingSource: 'external_subscription' },
    { ...selection, providerBinding: 'pi_model_runtime' },
  ])
    expect(RuntimeProviderSelectionSchema.safeParse(invalid).success).toBe(false)
})

test('connections retain only opaque vault metadata with explicit workspace grants', () => {
  expect(ModelConnectionSchema.parse(connection)).toEqual(connection)
  expect(
    ModelConnectionSchema.safeParse({ ...connection, apiKey: 'secret-canary-1234' }).success
  ).toBe(false)
  expect(
    ModelConnectionSchema.safeParse({ ...connection, fundingSource: 'external_subscription' })
      .success
  ).toBe(false)
})

import { ModelSelectionService, InMemoryModelSelectionRepository } from './selection-service.ts'
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
const defaults = {
  workspaceId: connection.workspaceId,
  revision: 1,
  lead: { connectionRef: connection.connectionRef, providerModel: 'gpt-5' },
  child: { connectionRef: connection.connectionRef, providerModel: 'gpt-5' },
}
async function fixture() {
  const repository = new InMemoryModelSelectionRepository()
  await repository.saveConnection(0, connection)
  await repository.saveDefaults(0, defaults)
  let metadata = {
    credentialId: connection.credentialRef,
    workspaceId: connection.workspaceId,
    provider: 'openai',
    revision: 1,
    status: 'active',
  }
  let reason = 'READY'
  const service = new ModelSelectionService({
    repository,
    vault: { metadata: async () => metadata },
    qualification: { evaluate: async () => reason },
    now: () => '2026-10-08T12:00:00.000Z',
  })
  return {
    service,
    repository,
    setMetadata: (value) => {
      metadata = value
    },
    setReason: (value) => {
      reason = value
    },
  }
}
test('pins defaults and overrides independently; immutable admission survives later default changes', async () => {
  const { service, repository } = await fixture()
  const accepted = await service.select({
    workspaceId: connection.workspaceId,
    role: 'lead',
    target,
  })
  await service.setDefaults(1, { ...defaults, revision: 2, lead: undefined })
  expect(
    await service.resolveSelection({
      selectionRef: accepted.selectionRef,
      selectionRevision: 1,
      workspaceId: connection.workspaceId,
    })
  ).toEqual(accepted)
  await expect(
    service.select({ workspaceId: connection.workspaceId, role: 'direct', target })
  ).rejects.toThrow('MODEL_UNAVAILABLE')
  expect(
    (
      await service.select({
        workspaceId: connection.workspaceId,
        role: 'direct',
        target,
        override: defaults.child,
      })
    ).providerModel
  ).toBe('gpt-5')
  expect(await repository.getDefaults(connection.workspaceId)).toMatchObject({ revision: 2 })
  await expect(service.setDefaults(1, { ...defaults, revision: 2 })).rejects.toThrow(
    'SELECTION_CHANGED'
  )
})
async function twoConnections() {
  const repository = new InMemoryModelSelectionRepository()
  const second = {
    ...connection,
    connectionRef: `mconn_${'3'.repeat(32)}`,
    credentialRef: 'crd_01JBBCDEF0123456789ABCDEFG',
    accountRef: 'account:byo-two',
    workspaceGrant: { ...connection.workspaceGrant, grantRef: 'grant:two' },
  }
  await repository.saveConnection(0, connection)
  await repository.saveConnection(0, second)
  await repository.saveDefaults(0, {
    workspaceId: connection.workspaceId,
    revision: 1,
    lead: { connectionRef: connection.connectionRef, providerModel: 'gpt-5' },
    child: { connectionRef: second.connectionRef, providerModel: 'gpt-5' },
    direct: { connectionRef: second.connectionRef, providerModel: 'gpt-5' },
  })
  const blocked = new Set()
  const service = new ModelSelectionService({
    repository,
    vault: {
      metadata: async (credentialRef) => ({
        credentialId: credentialRef,
        workspaceId: connection.workspaceId,
        provider: 'openai',
        revision: 1,
        status: 'active',
      }),
    },
    qualification: {
      evaluate: async ({ connection: candidate, providerModel }) =>
        blocked.has(`${candidate.connectionRef}:${providerModel}`) ? 'QUOTA_EXHAUSTED' : 'READY',
    },
    now: () => '2026-10-08T12:00:00.000Z',
  })
  return { repository, service, blocked, second }
}
test('a blocked default never falls back to another connection, model or role default', async () => {
  const { repository, service, blocked, second } = await twoConnections()
  blocked.add(`${connection.connectionRef}:gpt-5`)
  let inserted = 0
  const insert = repository.insertSelection.bind(repository)
  repository.insertSelection = async (next) => {
    inserted++
    return insert(next)
  }
  await expect(
    service.select({ workspaceId: connection.workspaceId, role: 'lead', target })
  ).rejects.toThrow('QUOTA_EXHAUSTED')
  expect(inserted).toBe(0)
  // Only an explicit caller override can choose the other ready connection.
  expect(
    (
      await service.select({
        workspaceId: connection.workspaceId,
        role: 'lead',
        target,
        override: { connectionRef: second.connectionRef, providerModel: 'gpt-5' },
      })
    ).connectionRef
  ).toBe(second.connectionRef)
  expect(inserted).toBe(1)
})
test('a blocked lead default leaves child and direct selections usable without substituting the lead', async () => {
  const { service, blocked, second } = await twoConnections()
  blocked.add(`${connection.connectionRef}:gpt-5`)
  await expect(
    service.select({ workspaceId: connection.workspaceId, role: 'lead', target })
  ).rejects.toThrow('QUOTA_EXHAUSTED')
  for (const role of ['child', 'direct']) {
    expect(
      (await service.select({ workspaceId: connection.workspaceId, role, target })).connectionRef
    ).toBe(second.connectionRef)
  }
})
test('readiness and request boundary fail closed for every revocation, expiry, quota and target fault', async () => {
  for (const code of [
    'QUOTA_EXHAUSTED',
    'INCOMPATIBLE_HARNESS',
    'INCOMPATIBLE_LOCATION',
    'AUTH_MODE_UNSUPPORTED',
    'PROVIDER_POLICY_DENIED',
  ]) {
    const { service, setReason } = await fixture()
    const accepted = await service.select({
      workspaceId: connection.workspaceId,
      role: 'lead',
      target,
    })
    setReason(code)
    await expect(service.assertReady(accepted)).rejects.toThrow(code)
  }
  for (const status of ['expired', 'revoked', 'secret_required']) {
    const { service, setMetadata } = await fixture()
    const accepted = await service.select({
      workspaceId: connection.workspaceId,
      role: 'lead',
      target,
    })
    setMetadata({
      credentialId: connection.credentialRef,
      workspaceId: connection.workspaceId,
      provider: 'openai',
      revision: 1,
      status,
    })
    await expect(service.assertReady(accepted)).rejects.toThrow(
      status === 'secret_required' ? 'CREDENTIAL_MISSING' : `CREDENTIAL_${status.toUpperCase()}`
    )
  }
})
test('refuses forged snapshots, cross-workspace reads, rotated credentials and mutated grants', async () => {
  const { service, repository, setMetadata } = await fixture()
  const accepted = await service.select({
    workspaceId: connection.workspaceId,
    role: 'lead',
    target,
  })
  await expect(service.assertReady({ ...accepted, accountRef: 'forged' })).rejects.toThrow(
    'SELECTION_CHANGED'
  )
  await expect(
    service.resolveSelection({
      selectionRef: accepted.selectionRef,
      selectionRevision: 1,
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH',
    })
  ).rejects.toThrow('SELECTION_CHANGED')
  setMetadata({
    credentialId: connection.credentialRef,
    workspaceId: connection.workspaceId,
    provider: 'openai',
    revision: 2,
    status: 'active',
  })
  await expect(service.assertReady(accepted)).rejects.toThrow('CREDENTIAL_REVISION_CHANGED')
  await repository.saveConnection(1, {
    ...connection,
    revision: 2,
    workspaceGrant: { ...connection.workspaceGrant, status: 'revoked', revision: 2 },
  })
  await expect(service.assertReady(accepted)).rejects.toThrow('WORKSPACE_GRANT_REVOKED')
})

test('transactional selection/defaults survive SQLite reopen and reject competing writers', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SqlitePersistenceProvider } = await import('@control-plane/sqlite-persistence')
  const { PersistentModelSelectionRepository } = await import('./selection-repository.ts')
  const directory = await mkdtemp(join(tmpdir(), 'model-selection-'))
  let persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await persistence.migrate()
    let repository = new PersistentModelSelectionRepository(persistence)
    expect(await repository.saveConnection(0, connection)).toBe(true)
    const competing = await Promise.all([
      repository.saveDefaults(0, defaults),
      repository.saveDefaults(0, { ...defaults, lead: undefined }),
    ])
    expect(competing.filter(Boolean)).toHaveLength(1)
    expect(await repository.insertSelection(selection)).toBe(true)
    expect(await repository.insertSelection({ ...selection, providerModel: 'different' })).toBe(
      false
    )
    await persistence.close()
    persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    await persistence.migrate()
    repository = new PersistentModelSelectionRepository(persistence)
    expect(await repository.getSelection(connection.workspaceId, selection.selectionRef)).toEqual(
      selection
    )
    expect(
      await repository.getSelection('wsp_01JABCDEF0123456789ABCDEFH', selection.selectionRef)
    ).toBeUndefined()
    expect(await repository.listConnections(connection.workspaceId)).toEqual([connection])
    expect(
      await repository.saveConnection(1, {
        ...connection,
        revision: 2,
        accountRef: 'switched-account',
      })
    ).toBe(false)
  } finally {
    await persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('vault integration scopes one-use inference and blocks secret egress and rotated revision', async () => {
  const { CredentialVault, InMemorySecretProvider } =
    await import('@control-plane/credential-vault')
  const repository = new InMemoryModelSelectionRepository()
  const now = () => '2026-10-08T12:00:00.000Z'
  const policySnapshot = {
    policyId: 'workspace-standard',
    version: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  }
  const vault = new CredentialVault({
    provider: new InMemorySecretProvider(),
    now,
    decisionPoint: {
      authorize: async (input) => ({
        effect: 'allow',
        decisionId: `sha256:${'b'.repeat(64)}`,
        reasonCode: 'CEDAR_PERMIT',
        policySnapshot,
        evaluatedAt: input.context.requestedAt,
      }),
    },
  })
  await vault.create({
    credentialId: connection.credentialRef,
    workspaceId: connection.workspaceId,
    connectorRef: 'model:one',
    provider: 'openai',
    secret: 'model-SECRET-canary-1234',
    createdAt: now(),
  })
  await repository.saveConnection(0, connection)
  await repository.saveDefaults(0, defaults)
  const service = new ModelSelectionService({
    repository,
    vault,
    qualification: { evaluate: async () => 'READY' },
    now,
  })
  const accepted = await service.select({
    workspaceId: connection.workspaceId,
    role: 'lead',
    target,
  })
  const authority = {
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    principalRef: 'svc_runtime-worker',
    policySnapshot,
  }
  expect(
    await service.withCredential(accepted, authority, (secret) => {
      expect(secret).toBe('model-SECRET-canary-1234')
      return { content: 'safe response' }
    })
  ).toEqual({ content: 'safe response' })
  await expect(
    service.withCredential(accepted, authority, (secret) => ({ content: secret }))
  ).rejects.toThrow('READINESS_UNAVAILABLE')
  for (const escape of [
    (secret) => Object.assign([], { hidden: secret }),
    (secret) => Object.assign([], { hidden: () => secret }),
    (secret) => () => secret,
    (secret) => ({ infer: () => secret }),
    (secret) => Object.defineProperty({}, 'credential', { value: secret }),
    (secret) =>
      new (class Registry {
        infer() {
          return secret
        }
      })(),
    (secret) => Object.defineProperty({}, 'result', { enumerable: true, get: () => secret }),
  ]) {
    await expect(service.withCredential(accepted, authority, escape)).rejects.toThrow(
      'READINESS_UNAVAILABLE'
    )
  }
  await vault.rotate(connection.credentialRef, 'rotated-SECRET-canary-1234', 'svc_admin')
  let invoked = false
  await expect(
    service.withCredential(accepted, authority, () => {
      invoked = true
    })
  ).rejects.toThrow('CREDENTIAL_REVISION_CHANGED')
  expect(invoked).toBe(false)
  expect(JSON.stringify(await vault.audit())).not.toContain('SECRET-canary')
})

test('qualification distinguishes local Pi credentials, Durable Models and Cloudflare bindings', async () => {
  const { ConfiguredModelQualification } = await import('./qualification.ts')
  const evidence = {
    provider: 'openai',
    providerModel: 'gpt-5',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    target,
    workspaceId: connection.workspaceId,
    accountRef: connection.accountRef,
    policyAllowed: true,
    quotaState: 'available',
    validUntil: '2026-10-09T12:00:00.000Z',
  }
  const qualify = new ConfiguredModelQualification([evidence], () => '2026-10-08T12:00:00.000Z')
  expect(await qualify.evaluate({ connection, providerModel: 'gpt-5', target })).toBe('READY')
  expect(
    await qualify.evaluate({
      connection,
      providerModel: 'gpt-5',
      target: { ...target, providerBinding: 'pi_model_runtime' },
    })
  ).toBe('INCOMPATIBLE_HARNESS')
  expect(
    await qualify.evaluate({
      connection,
      providerModel: 'gpt-5',
      target: { ...target, location: 'agent_hq_cloud' },
    })
  ).toBe('INCOMPATIBLE_LOCATION')
  expect(
    await qualify.evaluate({
      connection: {
        ...connection,
        authKind: 'provider_subscription',
        fundingSource: 'external_subscription',
      },
      providerModel: 'gpt-5',
      target,
    })
  ).toBe('AUTH_MODE_UNSUPPORTED')
  expect(
    await new ConfiguredModelQualification(
      [{ ...evidence, policyAllowed: false }],
      () => '2026-10-08T12:00:00.000Z'
    ).evaluate({
      connection,
      providerModel: 'gpt-5',
      target,
    })
  ).toBe('PROVIDER_POLICY_DENIED')
  expect(
    await new ConfiguredModelQualification(
      [{ ...evidence, quotaState: 'exhausted' }],
      () => '2026-10-08T12:00:00.000Z'
    ).evaluate({
      connection,
      providerModel: 'gpt-5',
      target,
    })
  ).toBe('QUOTA_EXHAUSTED')
})

test('Durable readiness cannot label native subscription credentials ready before a supported binding exists', async () => {
  const repository = new InMemoryModelSelectionRepository()
  await repository.saveConnection(0, {
    ...connection,
    authKind: 'local_runtime',
    fundingSource: 'external_subscription',
  })
  const service = new ModelSelectionService({
    repository,
    vault: {
      metadata: async () => ({
        credentialId: connection.credentialRef,
        workspaceId: connection.workspaceId,
        provider: connection.provider,
        revision: 1,
        status: 'active',
      }),
    },
    qualification: { evaluate: async () => 'READY' },
    now: () => '2026-10-08T12:00:00.000Z',
  })
  expect((await service.list(connection.workspaceId, target))[0].models[0].readiness).toEqual({
    ready: false,
    reasonCode: 'AUTH_MODE_UNSUPPORTED',
  })
  await expect(
    service.select({
      workspaceId: connection.workspaceId,
      role: 'lead',
      target,
      override: defaults.lead,
    })
  ).rejects.toThrow('AUTH_MODE_UNSUPPORTED')
})

test('connection administration uses trusted account grants and never reads or accepts a reusable secret', async () => {
  const { ModelConnectionAdministration } = await import('./connection-administration.ts')
  const { repository } = await fixture()
  const admin = new ModelConnectionAdministration({
    repository,
    vault: {
      metadata: async () => ({
        credentialId: connection.credentialRef,
        workspaceId: connection.workspaceId,
        provider: 'openai',
        status: 'active',
        revision: 1,
      }),
    },
    grants: {
      authorize: async () => ({
        accountRef: connection.accountRef,
        authKind: connection.authKind,
        fundingSource: connection.fundingSource,
        models: connection.models,
        workspaceGrant: connection.workspaceGrant,
      }),
    },
  })
  const current = await admin.connect({
    workspaceId: connection.workspaceId,
    principalRef: connection.ownerRef,
    credentialRef: connection.credentialRef,
    credentialRevision: 1,
  })
  expect(current.fundingSource).toBe('byo_api')
  const revoked = await admin.revoke({
    workspaceId: current.workspaceId,
    principalRef: current.ownerRef,
    connectionRef: current.connectionRef,
    expectedRevision: 1,
  })
  expect(revoked.status).toBe('revoked')
  expect(await repository.saveConnection(2, { ...revoked, revision: 3, status: 'active' })).toBe(
    false
  )
  await expect(
    admin.revoke({
      workspaceId: connection.workspaceId,
      principalRef: 'svc_unauthorized',
      connectionRef: connection.connectionRef,
      expectedRevision: 1,
    })
  ).rejects.toThrow('PROVIDER_POLICY_DENIED')
})

test('connection administration retains safe missing-credential reasons and masks unexpected failures', async () => {
  const { ModelConnectionAdministration } = await import('./connection-administration.ts')
  const { CredentialVaultError } = await import('@control-plane/credential-vault')
  for (const [error, code] of [
    [new CredentialVaultError('CREDENTIAL_MISSING'), 'CREDENTIAL_MISSING'],
    [new Error('secret-canary'), 'READINESS_UNAVAILABLE'],
  ]) {
    const admin = new ModelConnectionAdministration({
      repository: new InMemoryModelSelectionRepository(),
      vault: {
        metadata: async () => {
          throw error
        },
      },
      grants: {
        authorize: async () => {
          throw new Error('unreachable')
        },
      },
    })
    await expect(
      admin.connect({
        workspaceId: connection.workspaceId,
        principalRef: connection.ownerRef,
        credentialRef: connection.credentialRef,
        credentialRevision: 1,
      })
    ).rejects.toThrow(code)
  }
})
