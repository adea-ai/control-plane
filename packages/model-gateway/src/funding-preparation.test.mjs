import { expect, test } from 'bun:test'
import { createModelFundingPreparationService } from './funding-preparation.ts'

import { at, expiry, binding, view } from './funding-preparation-fixtures.mjs'
function fixture() {
  let record,
    current = structuredClone(view),
    time = at,
    active = true,
    writes = 0
  const confirmations = {
    getByAttempt: async () => record,
    putIfAbsent: async (value) => {
      writes++
      record ??= structuredClone(value)
      return structuredClone(record)
    },
  }
  const authority = {
    assertCurrent: async () => {
      if (!active) throw new Error('private-canary')
    },
  }
  const service = createModelFundingPreparationService({
    executionAuthority: authority,
    confirmations,
    readFunding: async () => structuredClone(current),
    now: () => time,
  })
  return {
    service,
    writes: () => writes,
    setView: (value) => {
      current = value
    },
    setTime: (value) => {
      time = value
    },
    setActive: (value) => {
      active = value
    },
  }
}
test('funding preparation retains one immutable display reference without model, lease or physical-send work', async () => {
  const f = fixture()
  const prepared = await f.service.prepareFunding(binding, expiry)
  expect(prepared).toMatchObject({
    schemaVersion: 'retained-model-funding/v1',
    funding: view,
    expiresAt: '2026-10-08T12:05:00.000Z',
    binding,
  })
  expect(await f.service.prepareFunding(binding, expiry)).toEqual(prepared)
  await f.service.assertFundingCurrent(binding, prepared.confirmationRef)
  expect(f.writes()).toBe(1)
})
test('dispatch never refreshes prepared payer, account, authorization or auth/funding source silently', async () => {
  for (const patch of [
    { accountRef: 'account:other' },
    { authorizationRef: 'spending:other' },
    { fundingOwner: { ...view.fundingOwner, revision: 2 } },
    { fundingOwner: { ...view.fundingOwner, ownerRef: 'payer:other' } },
    { authKind: 'provider_subscription' },
    { fundingSource: 'external_subscription' },
    { expiresAt: '2026-10-08T12:30:00.000Z' },
  ]) {
    const f = fixture()
    const prepared = await f.service.prepareFunding(binding, expiry)
    f.setView({ ...view, ...patch })
    await expect(f.service.assertFundingCurrent(binding, prepared.confirmationRef)).rejects.toThrow(
      'FUNDING_CONFIRMATION_STALE'
    )
    await expect(f.service.prepareFunding(binding, expiry)).rejects.toThrow(
      'FUNDING_CONFIRMATION_STALE'
    )
    expect(f.writes()).toBe(1)
  }
})
test('missing, expired, revoked or wrong-execution confirmation denies without replacing retained evidence', async () => {
  const f = fixture()
  await expect(f.service.assertFundingCurrent(binding, 'confirmation:missing')).rejects.toThrow(
    'FUNDING_CONFIRMATION_REQUIRED'
  )
  const prepared = await f.service.prepareFunding(binding, expiry)
  await expect(
    f.service.assertFundingCurrent(
      { ...binding, principalRef: 'svc_other' },
      prepared.confirmationRef
    )
  ).rejects.toThrow('FUNDING_CONFIRMATION_STALE')
  f.setView({ ...view, state: 'blocked', reasonCode: 'WORKSPACE_GRANT_REVOKED' })
  await expect(f.service.assertFundingCurrent(binding, prepared.confirmationRef)).rejects.toThrow(
    'FUNDING_CONFIRMATION_STALE'
  )
  f.setTime(expiry)
  await expect(f.service.assertFundingCurrent(binding, prepared.confirmationRef)).rejects.toThrow(
    'FUNDING_CONFIRMATION_STALE'
  )
})

test('prepare TTL is bounded by five minutes and both deadlines, including reopen and clock rollback', async () => {
  for (const [deadline, fundingExpiry, expected] of [
    [expiry, expiry, '2026-10-08T12:05:00.000Z'],
    ['2026-10-08T12:02:00.000Z', expiry, '2026-10-08T12:02:00.000Z'],
    [expiry, '2026-10-08T12:01:00.000Z', '2026-10-08T12:01:00.000Z'],
  ]) {
    const f = fixture()
    f.setView({ ...view, expiresAt: fundingExpiry })
    const record = await f.service.prepareFunding(binding, deadline)
    expect(record.expiresAt).toBe(expected)
    f.setTime(expected)
    await expect(f.service.confirmedExecutionAuthority.assertCurrent(binding)).rejects.toThrow(
      'FUNDING_CONFIRMATION_STALE'
    )
  }
  const f = fixture()
  const record = await f.service.prepareFunding(binding, expiry)
  f.setTime('2026-10-08T11:59:59.000Z')
  await expect(f.service.assertFundingCurrent(binding, record.confirmationRef)).rejects.toThrow(
    'FUNDING_CONFIRMATION_STALE'
  )
})

test('physical-send authority rereads payer and actor after confirmation without model or lease access', async () => {
  const f = fixture()
  await f.service.prepareFunding(binding, expiry)
  await f.service.confirmedExecutionAuthority.assertCurrent(binding)
  f.setView({ ...view, fundingOwner: { ...view.fundingOwner, evidenceRef: 'payer-proof:revoked' } })
  await expect(f.service.confirmedExecutionAuthority.assertCurrent(binding)).rejects.toThrow(
    'FUNDING_CONFIRMATION_STALE'
  )
  const g = fixture()
  await g.service.prepareFunding(binding, expiry)
  g.setActive(false)
  await expect(g.service.confirmedExecutionAuthority.assertCurrent(binding)).rejects.toThrow(
    'FUNDING_CONFIRMATION_STALE'
  )
})
