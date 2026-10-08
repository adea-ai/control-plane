import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createFileRecordedModelFundingAuthority } from './file-recorded-funding.ts'
import { now, later, binding, decision } from './recorded-funding-fixtures.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-recorded-funding-'))
  const records = join(root, binding.workspaceId, binding.executionId)
  const payers = join(root, binding.workspaceId, 'payers')
  mkdirSync(records, { recursive: true, mode: 0o700 })
  mkdirSync(payers, { recursive: true, mode: 0o700 })
  const recordPath = join(records, `${binding.attemptId}.json`)
  const payerPath = join(
    payers,
    `${createHash('sha256').update(decision.fundingOwner.ownerRef).digest('hex')}.json`
  )
  let mutate = async () => {}
  const write = (path, data) => writeFileSync(path, JSON.stringify(data), { mode: 0o600 })
  const record = {
    schemaVersion: 'recorded-funding-host/v1',
    binding,
    decision,
    status: 'active',
    expiresAt: later,
  }
  const payer = {
    schemaVersion: 'recorded-funding-payer/v1',
    workspaceId: binding.workspaceId,
    authorizationRef: decision.grant.authorizationId,
    fundingOwner: decision.fundingOwner,
    status: 'active',
    expiresAt: later,
  }
  write(recordPath, record)
  write(payerPath, payer)
  const authority = createFileRecordedModelFundingAuthority({
    directory: root,
    currentExecutionAuthority: {
      assertCurrent: async () => {
        await mutate()
      },
    },
    now: () => now,
  })
  return {
    authority,
    root,
    recordPath,
    payerPath,
    record,
    payer,
    write,
    onCurrent: (value) => {
      mutate = value
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}
test('operator-owned metadata files recheck exact recorded grant and independent explicit payer', async () => {
  const f = fixture()
  try {
    expect(await f.authority.readCurrent(binding)).toEqual(decision)
    f.write(f.payerPath, { ...f.payer, status: 'revoked' })
    await expect(f.authority.readCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  } finally {
    f.close()
  }
})
test('changed binding, payer evidence, expiry, insecure permissions and symlink deny safe metadata-only reads', async () => {
  for (const change of [
    (f) => f.write(f.recordPath, { ...f.record, binding: { ...binding, authorityRevision: 2 } }),
    (f) =>
      f.write(f.payerPath, { ...f.payer, fundingOwner: { ...decision.fundingOwner, revision: 2 } }),
    (f) => f.write(f.recordPath, { ...f.record, expiresAt: now }),
    (f) => chmodSync(f.recordPath, 0o644),
    (f) => {
      rmSync(f.payerPath)
      symlinkSync(f.recordPath, f.payerPath)
    },
  ]) {
    const f = fixture()
    try {
      change(f)
      await expect(f.authority.readCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
    } finally {
      f.close()
    }
  }
})
test('revocation while awaiting current canonical authority is detected by authenticated file reread', async () => {
  const f = fixture()
  try {
    let calls = 0
    f.onCurrent(async () => {
      if (++calls === 2) f.write(f.payerPath, { ...f.payer, status: 'revoked' })
    })
    await expect(f.authority.readCurrent(binding)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  } finally {
    f.close()
  }
})
