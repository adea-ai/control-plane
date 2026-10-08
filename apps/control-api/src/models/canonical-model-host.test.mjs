import { expect, test } from 'bun:test'
import { fixture, at, expiry, exe, att } from './canonical-model-host-fixtures.mjs'
test('canonical host derives exact binding from retained owners and original actor, never transport identity', async () => {
  const f = await fixture()
  const binding = await f.host.resolveForReader(f.reader)
  expect(binding).toMatchObject({
    executionId: exe,
    attemptId: att,
    principalRef: 'svc_admission',
    canonicalActorPrincipalId: 'actor:original',
    leasePrincipalRef: 'svc_lease',
    executionPlanSchemaVersion: 2,
    executionPlanId: f.plan.executionPlanId,
    executionPlanDigest: f.plan.contentDigest,
  })
  expect(f.scopeInputs.every((input) => input.callerPrincipalId === 'actor:original')).toBe(true)
  expect(f.productInputs.every((input) => input.principalId === 'svc_transport')).toBe(true)
  await f.host.assertCurrent(binding)
  expect(JSON.stringify(binding)).not.toContain('prompt')
})

test('canonical host rejects a foreign reader, missing actor, pending marker and changed selection without inference', async () => {
  const f = await fixture()
  await expect(
    f.host.resolveForReader({ ...f.reader, principalId: 'svc_foreign' })
  ).rejects.toThrow('PROVIDER_POLICY_DENIED')
  f.setRetained({ ...f.intent, canonicalActorPrincipalId: undefined })
  await expect(f.host.resolveForReader(f.reader)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  f.setRetained(f.intent)
  f.setMarker({ state: 'pending' })
  await expect(f.host.resolveForReader(f.reader)).rejects.toThrow('PROVIDER_POLICY_DENIED')
})

test('canonical host rereads product grant, kernel scope and payer-independent actor on every boundary', async () => {
  for (const patch of [
    { canonicalActorPrincipalId: 'svc_transport' },
    { authorityRevision: 2 },
    { selectionRevision: 2 },
    { allowedPrincipalIds: [] },
    { expiresAt: at },
    { workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
  ]) {
    const f = await fixture()
    const binding = await f.host.resolveForReader(f.reader)
    f.setCurrent({ ...f.intent, ...patch })
    await expect(f.host.assertCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  }
  const f = await fixture()
  const binding = await f.host.resolveForReader(f.reader)
  f.setScope(false)
  await expect(f.host.assertCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
})

test('canonical host fences superseded attempt or cancellation during awaited product authority', async () => {
  const f = await fixture()
  const binding = await f.host.resolveForReader(f.reader)
  let once = false
  f.onProduct(async () => {
    if (once) return
    once = true
    const record = await f.executions.getExecution(exe)
    await f.executions.compareAndSetExecution(record.version, {
      ...record,
      version: record.version + 1,
      state: 'cancelling',
    })
  })
  await expect(f.host.assertCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
})

test('canonical host cannot accept caller plan/policy/principal pins or an expiry raced while reading', async () => {
  const f = await fixture()
  const binding = await f.host.resolveForReader(f.reader)
  for (const patch of [
    { requestId: 'req_01JABCDEF0123456789ABCDEFH' },
    { principalRef: 'svc_transport' },
    { leasePrincipalRef: 'svc_transport' },
    { executionPlanDigest: `sha256:${'a'.repeat(64)}` },
    { authorityRevision: 2 },
  ])
    await expect(f.host.assertCurrent({ ...binding, ...patch })).rejects.toThrow(
      'SELECTION_CHANGED'
    )
  f.onProduct(async () => {
    f.setTime(expiry)
  })
  await expect(f.host.assertCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
})

test('fresh product evidence cannot narrow workspace scope or change project with unchanged selection metadata', async () => {
  for (const scope of [
    { schemaVersion: 1, kind: 'project', projectId: 'prj_01JABCDEF0123456789ABCDEFG' },
    { schemaVersion: 2, kind: 'workspace' },
    undefined,
  ]) {
    const f = await fixture()
    const binding = await f.host.resolveForReader(f.reader)
    f.setCurrent({ ...f.intent, executionScope: scope, projectId: scope?.projectId })
    await expect(f.host.assertCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  }
})

test('kernel revocation during second product read and expiry during kernel await deny', async () => {
  const f = await fixture()
  const binding = await f.host.resolveForReader(f.reader)
  let reads = 0
  f.onProduct(async () => {
    if (++reads === 2) f.setScope(false)
  })
  await expect(f.host.assertCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  const g = await fixture()
  const accepted = await g.host.resolveForReader(g.reader)
  g.setScopeExpiry('2026-10-08T12:01:00.000Z')
  g.onScope(async () => {
    g.setTime('2026-10-08T12:02:00.000Z')
  })
  await expect(g.host.assertCurrent(accepted)).rejects.toThrow('PROVIDER_POLICY_DENIED')
})
