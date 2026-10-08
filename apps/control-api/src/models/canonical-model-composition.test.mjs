import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixture, at, expiry } from './canonical-model-host-fixtures.mjs'
import { decision } from './model-recorded-funding-fixtures.mjs'
import { selection } from './model-selection-fixtures.mjs'
import { createCanonicalModelHostComposition } from './canonical-model-composition.ts'

test('canonical stores + private records + SQLite confirmation compose without model work and recheck both native owners', async () => {
  const f = await fixture()
  const binding = await f.host.resolveForReader(f.reader)
  const root = mkdtempSync(join(tmpdir(), 'pi-canonical-funding-'))
  const records = join(root, binding.workspaceId, binding.executionId)
  const payers = join(root, binding.workspaceId, 'payers')
  mkdirSync(records, { recursive: true, mode: 0o700 })
  mkdirSync(payers, { recursive: true, mode: 0o700 })
  const payerPath = join(
    payers,
    `${createHash('sha256').update(decision.fundingOwner.ownerRef).digest('hex')}.json`
  )
  const grant = {
    ...decision.grant,
    workspaceId: binding.workspaceId,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
    principalRef: binding.principalRef,
    alias: binding.modelAlias,
    policySnapshotDigest: binding.policySnapshotDigest,
  }
  const current = {
    ...decision,
    executionPlanId: binding.executionPlanId,
    executionPlanDigest: binding.executionPlanDigest,
    selectionRef: binding.selectionRef,
    selectionRevision: binding.selectionRevision,
    canonicalActorPrincipalId: binding.canonicalActorPrincipalId,
    authorityRevision: binding.authorityRevision,
    grant,
  }
  const payer = {
    schemaVersion: 'recorded-funding-payer/v1',
    workspaceId: binding.workspaceId,
    authorizationRef: grant.authorizationId,
    fundingOwner: decision.fundingOwner,
    status: 'active',
    expiresAt: expiry,
  }
  const write = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  write(join(records, `${binding.attemptId}.json`), {
    schemaVersion: 'recorded-funding-host/v1',
    binding,
    decision: current,
    status: 'active',
    expiresAt: expiry,
  })
  write(payerPath, payer)
  const db = new Database(':memory:')
  let leases = 0
  try {
    const host = createCanonicalModelHostComposition({
      canonical: f.hostOptions,
      maximumRetainedFacades: 1,
      fundingDirectory: root,
      database: db,
      selections: {
        resolveSelection: async () => ({
          ...selection,
          workspaceId: binding.workspaceId,
          selectionRef: binding.selectionRef,
          selectionRevision: binding.selectionRevision,
        }),
        assertReady: async () => {},
        withCredential: async () => {
          leases++
          throw new Error('must not lease')
        },
      },
      now: () => at,
    })
    const prepared = await host.prepareForReader(f.reader, expiry)
    expect(prepared.funding).toMatchObject({ state: 'ready', fundingOwner: decision.fundingOwner })
    expect(leases).toBe(0)
    const providerOwner = host.forExecution(binding)
    const spendingOwner = host.forExecution(binding)
    expect(providerOwner).toBe(spendingOwner)
    expect(() => host.forExecution({ ...binding, principalRef: 'svc_other' })).toThrow(
      'SELECTION_CHANGED'
    )
    expect(() =>
      host.forExecution({ ...binding, attemptId: 'att_01JABCDEF0123456789ABCDEFH' })
    ).toThrow('READINESS_UNAVAILABLE')
    await providerOwner.resolveSelection({
      workspaceId: binding.workspaceId,
      selectionRef: binding.selectionRef,
      selectionRevision: binding.selectionRevision,
    })
    write(payerPath, { ...payer, status: 'revoked' })
    await expect(host.assertFundingCurrent(binding, prepared.confirmationRef)).rejects.toThrow(
      'PI_LEAD_FUNDING_CONFIRMATION_STALE'
    )
    await expect(
      spendingOwner.resolveSelection({
        workspaceId: binding.workspaceId,
        selectionRef: binding.selectionRef,
        selectionRevision: binding.selectionRevision,
      })
    ).rejects.toThrow('PROVIDER_POLICY_DENIED')
    await expect(host.prepareForReader(f.reader, expiry)).rejects.toThrow(
      'PI_LEAD_FUNDING_CONFIRMATION_STALE'
    )
    expect(leases).toBe(0)
    host.forgetTerminalExecution(binding)
    const reopenedFacade = host.forExecution(binding)
    expect(reopenedFacade).not.toBe(providerOwner)
    await expect(
      reopenedFacade.resolveSelection({
        workspaceId: binding.workspaceId,
        selectionRef: binding.selectionRef,
        selectionRevision: binding.selectionRevision,
      })
    ).rejects.toThrow('PROVIDER_POLICY_DENIED')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
