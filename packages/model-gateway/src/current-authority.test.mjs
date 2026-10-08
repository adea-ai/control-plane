import { expect, test } from 'bun:test'
import { CurrentModelAccountAuthorization } from './current-authority.ts'
import {
  createExecutionBoundModelSelectionService,
  createExecutionBoundModelHttpAuthority,
} from './execution-selection.ts'
import { ModelSelectionService, InMemoryModelSelectionRepository } from './selection-service.ts'
import { connection, selection } from './selection-fixtures.mjs'

const now = '2026-10-08T12:00:00.000Z'
const later = '2026-10-08T13:00:00.000Z'
const target = {
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
  location: 'remote_host',
}
const evidence = {
  schemaVersion: 'model-account-authority/v1',
  evidenceRef: 'account-proof:1',
  observedAt: now,
  expiresAt: later,
  workspaceId: connection.workspaceId,
  credentialRef: connection.credentialRef,
  credentialRevision: 1,
  provider: connection.provider,
  accountRef: connection.accountRef,
  authKind: connection.authKind,
  fundingSource: connection.fundingSource,
  models: connection.models,
  workspaceGrant: connection.workspaceGrant,
  allowedPrincipalRefs: [connection.ownerRef],
  targets: [target],
  entitlement: 'allowed',
  quota: 'available',
  residencyAllowed: true,
}
const binding = {
  schemaVersion: 'execution-model-selection/v1',
  workspaceId: connection.workspaceId,
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  executionPlanDigest: `sha256:${'a'.repeat(64)}`,
  executionPlanSchemaVersion: 2,
  policySnapshotDigest: `sha256:${'b'.repeat(64)}`,
  principalRef: 'svc_admission',
  modelAlias: 'reasoning.standard',
  canonicalActorPrincipalId: connection.ownerRef,
  leasePrincipalRef: 'svc_model-lease',
  authorityRevision: 1,
  selectionRef: selection.selectionRef,
  selectionRevision: 1,
}
const ref = {
  workspaceId: binding.workspaceId,
  selectionRef: binding.selectionRef,
  selectionRevision: 1,
}
async function fixture() {
  const repository = new InMemoryModelSelectionRepository()
  await repository.saveConnection(0, connection)
  await repository.insertSelection(selection)
  let record = structuredClone(evidence)
  let scopeActive = true
  let reads = 0
  let leases = 0
  let beforeUse = () => {}
  let beforeRead = async () => {}
  const qualification = new CurrentModelAccountAuthorization(
    {
      readCurrent: async (input) => {
        reads++
        await beforeRead()
        expect(input.requestedAt).toBe(now)
        return structuredClone(record)
      },
    },
    () => now
  )
  const selections = new ModelSelectionService({
    repository,
    qualification,
    now: () => now,
    vault: {
      metadata: async () => ({
        workspaceId: connection.workspaceId,
        credentialId: connection.credentialRef,
        provider: 'openai',
        revision: 1,
        status: 'active',
      }),
      lease: async () => {
        leases++
        return { capabilityRef: 'lease:fixture' }
      },
      use: async (_capability, _scope, operation) => {
        beforeUse()
        return operation('synthetic-key-canary')
      },
    },
  })
  const bound = createExecutionBoundModelSelectionService({
    selections,
    binding,
    currentExecutionAuthority: {
      assertCurrent: async (pin) => {
        expect(pin.canonicalActorPrincipalId).toBe(connection.ownerRef)
        expect(pin.executionPlanDigest).toBe(binding.executionPlanDigest)
        if (!scopeActive) throw new Error('private-scope-detail')
      },
    },
  })
  return {
    qualification,
    selections,
    bound,
    setRecord: (value) => {
      record = value
    },
    setScope: (active) => {
      scopeActive = active
    },
    beforeRead: (fn) => {
      beforeRead = fn
    },
    beforeUse: (fn) => {
      beforeUse = fn
    },
    reads: () => reads,
    leases: () => leases,
  }
}
test('current authority is read for connect, admission and every later inference, never cached', async () => {
  const f = await fixture()
  expect(
    (
      await f.qualification.authorize({
        ...ref,
        credentialRef: connection.credentialRef,
        credentialRevision: 1,
        principalRef: connection.ownerRef,
      })
    ).accountRef
  ).toBe(connection.accountRef)
  await f.bound.resolveSelection(ref)
  const before = f.reads()
  await f.bound.assertReady(selection)
  expect(f.reads()).toBeGreaterThan(before)
  f.setRecord({ ...evidence, quota: 'exhausted' })
  await expect(f.bound.resolveSelection(ref)).rejects.toThrow('QUOTA_EXHAUSTED')
  expect(f.leases()).toBe(0)
})
test('current qualification fails closed for stale, unknown, revoked, changed and incompatible evidence', async () => {
  const f = await fixture()
  const cases = [
    [undefined, 'READINESS_UNAVAILABLE'],
    [{ ...evidence, observedAt: '2026-10-08T11:59:59.000Z' }, 'READINESS_UNAVAILABLE'],
    [{ ...evidence, observedAt: later }, 'READINESS_UNAVAILABLE'],
    [{ ...evidence, expiresAt: now }, 'READINESS_UNAVAILABLE'],
    [{ ...evidence, quota: 'unknown' }, 'READINESS_UNAVAILABLE'],
    [{ ...evidence, entitlement: 'unknown' }, 'READINESS_UNAVAILABLE'],
    [{ ...evidence, entitlement: 'denied' }, 'PROVIDER_POLICY_DENIED'],
    [{ ...evidence, allowedPrincipalRefs: ['actor:foreign'] }, 'PROVIDER_POLICY_DENIED'],
    [{ ...evidence, residencyAllowed: false }, 'INCOMPATIBLE_LOCATION'],
    [{ ...evidence, accountRef: 'account:another' }, 'SELECTION_CHANGED'],
    [{ ...evidence, credentialRevision: 2 }, 'SELECTION_CHANGED'],
    [
      { ...evidence, workspaceGrant: { ...evidence.workspaceGrant, status: 'revoked' } },
      'WORKSPACE_GRANT_REVOKED',
    ],
    [
      { ...evidence, workspaceGrant: { ...evidence.workspaceGrant, expiresAt: now } },
      'WORKSPACE_GRANT_EXPIRED',
    ],
    [
      { ...evidence, workspaceGrant: { ...evidence.workspaceGrant, revision: 2 } },
      'SELECTION_CHANGED',
    ],
    [{ ...evidence, targets: [{ ...target, harnessVersion: '1.1.1' }] }, 'INCOMPATIBLE_HARNESS'],
    [
      { ...evidence, targets: [{ ...target, location: 'agent_hq_cloud' }] },
      'INCOMPATIBLE_LOCATION',
    ],
    [{ ...evidence, targets: [target, target] }, 'READINESS_UNAVAILABLE'],
    [{ ...evidence, models: ['another-model'] }, 'MODEL_UNAVAILABLE'],
    [{ ...evidence, rawSecret: 'secret-canary' }, 'READINESS_UNAVAILABLE'],
  ]
  for (const [record, reason] of cases) {
    f.setRecord(record)
    expect(
      await f.qualification.evaluate({
        connection,
        providerModel: selection.providerModel,
        target: selection,
      })
    ).toBe(reason)
  }
})
test('connect requires a current grant for the original actor and masks source failures', async () => {
  const f = await fixture()
  await expect(
    f.qualification.authorize({
      workspaceId: binding.workspaceId,
      credentialRef: connection.credentialRef,
      credentialRevision: 1,
      principalRef: 'svc_foreign',
    })
  ).rejects.toThrow('PROVIDER_POLICY_DENIED')
  const failed = new CurrentModelAccountAuthorization(
    {
      readCurrent: async () => {
        throw new Error('secret-canary')
      },
    },
    () => now
  )
  expect(
    await failed.evaluate({ connection, providerModel: selection.providerModel, target })
  ).toBe('READINESS_UNAVAILABLE')
})
test('execution facade refuses foreign pins and current actor/scope denial before vault use', async () => {
  const f = await fixture()
  await expect(f.bound.resolveSelection({ ...ref, selectionRevision: 2 })).rejects.toThrow(
    'SELECTION_CHANGED'
  )
  expect(() =>
    f.bound.assertBinding({ ...binding, canonicalActorPrincipalId: 'svc_foreign' })
  ).toThrow('SELECTION_CHANGED')
  f.setScope(false)
  await expect(f.bound.resolveSelection(ref)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  expect(f.leases()).toBe(0)
})
test('lease authority is bound and scope/account are reread inside the credential callback', async () => {
  const f = await fixture()
  const lease = {
    requestId: binding.requestId,
    principalRef: binding.leasePrincipalRef,
    policySnapshot: { digest: binding.policySnapshotDigest },
  }
  expect(
    await f.bound.withCredential(selection, lease, async (secret) => ({
      ok: secret === 'synthetic-key-canary',
    }))
  ).toEqual({ ok: true })
  await expect(
    f.bound.withCredential(selection, { ...lease, principalRef: 'svc_foreign' }, () => ({
      ok: true,
    }))
  ).rejects.toThrow('PROVIDER_POLICY_DENIED')
  expect(f.leases()).toBe(1)
})
test('HTTP spending authority rechecks scope and quota at physical send and closes denied leases', async () => {
  const f = await fixture()
  let closes = 0
  let delegateChecks = 0
  const context = {
    request: {
      ...binding,
      alias: binding.modelAlias,
      principalRef: binding.principalRef,
      policySnapshot: { digest: binding.policySnapshotDigest },
      selection,
    },
    deployment: {},
  }
  const signal = new AbortController().signal
  const wrapper = createExecutionBoundModelHttpAuthority({
    binding,
    selections: f.bound,
    authority: {
      authorize: async () => ({
        grant: {},
        price: {},
        proxyModelId: 'pinned',
        endpoint: 'https://fixture.invalid',
        credential: {
          value: new Uint8Array(),
          close: async () => {
            closes++
          },
        },
        assertActive: async () => {
          delegateChecks++
        },
      }),
    },
  })
  const approved = await wrapper.authorize(context, signal)
  await approved.assertActive(signal)
  expect(delegateChecks).toBe(1)
  f.setRecord({ ...evidence, quota: 'exhausted' })
  await expect(approved.assertActive(signal)).rejects.toThrow('QUOTA_EXHAUSTED')
  f.setRecord(evidence)
  f.setScope(false)
  await expect(approved.assertActive(signal)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  f.setScope(true)
  const racing = createExecutionBoundModelHttpAuthority({
    binding,
    selections: f.bound,
    authority: {
      authorize: async () => {
        f.setRecord({ ...evidence, quota: 'exhausted' })
        return {
          ...approved,
          credential: {
            value: new Uint8Array(),
            close: async () => {
              closes++
            },
          },
        }
      },
    },
  })
  await expect(racing.authorize(context, signal)).rejects.toThrow('QUOTA_EXHAUSTED')
  expect(closes).toBe(1)
})
test('revocation after leasing denies the provider callback and scope errors remain bounded', async () => {
  const f = await fixture()
  let invoked = 0
  f.beforeUse(() => f.setScope(false))
  await expect(
    f.bound.withCredential(
      selection,
      {
        requestId: binding.requestId,
        principalRef: binding.leasePrincipalRef,
        policySnapshot: { digest: binding.policySnapshotDigest },
      },
      () => {
        invoked++
        return { ok: true }
      }
    )
  ).rejects.toThrow('PROVIDER_POLICY_DENIED')
  expect(invoked).toBe(0)
  expect(f.leases()).toBe(1)
})
test('HTTP wrapper cannot pair a different execution with an otherwise identical selection', async () => {
  const f = await fixture()
  expect(() =>
    createExecutionBoundModelHttpAuthority({
      binding: { ...binding, authorityRevision: 2 },
      selections: f.bound,
      authority: {
        authorize: async () => {
          throw new Error('not reached')
        },
      },
    })
  ).toThrow('SELECTION_CHANGED')
})

test('cancellation closes an acquired HTTP lease without waiting for a hung post-authorization readiness read', async () => {
  const f = await fixture()
  let enter
  const entered = new Promise((resolve) => {
    enter = resolve
  })
  let release
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  let closes = 0
  const controller = new AbortController()
  const wrapper = createExecutionBoundModelHttpAuthority({
    binding,
    selections: f.bound,
    authority: {
      authorize: async () => {
        f.beforeRead(async () => {
          enter()
          await blocked
        })
        return {
          grant: {},
          price: {},
          proxyModelId: 'pinned',
          endpoint: 'https://fixture.invalid',
          credential: {
            value: new Uint8Array(),
            close: async () => {
              closes++
            },
          },
          assertActive: async () => {},
        }
      },
    },
  })
  const pending = wrapper.authorize(
    {
      request: {
        ...binding,
        alias: binding.modelAlias,
        policySnapshot: { digest: binding.policySnapshotDigest },
        selection,
      },
      deployment: {},
    },
    controller.signal
  )
  await entered
  controller.abort()
  try {
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('cleanup deadline exceeded')), 100)
        ),
      ])
    ).rejects.toThrow('aborted')
    expect(closes).toBe(1)
  } finally {
    release()
  }
  await Promise.resolve()
  expect(closes).toBe(1)
})
