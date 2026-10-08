import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createModelFundingPreparationService } from '@control-plane/model-gateway'
import { at, expiry, binding, view } from './model-funding-preparation-fixtures.mjs'
import { createSqliteModelFundingConfirmations } from './sqlite-funding-confirmations.ts'

test('actual SQLite reopen retains exact payer confirmation and rejects changed current decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-funding-confirmation-'))
  const path = join(root, 'host.sqlite')
  let db
  let current = view
  const service = () =>
    createModelFundingPreparationService({
      confirmations: createSqliteModelFundingConfirmations(db),
      executionAuthority: { assertCurrent: async () => {} },
      readFunding: async () => structuredClone(current),
      now: () => at,
    })
  try {
    db = new Database(path)
    const original = await service().prepareFunding(binding, expiry)
    db.close()
    db = new Database(path)
    expect(await service().prepareFunding(binding, expiry)).toEqual(original)
    await service().assertFundingCurrent(binding, original.confirmationRef)
    current = { ...view, fundingOwner: { ...view.fundingOwner, revision: 2 } }
    await expect(service().confirmedExecutionAuthority.assertCurrent(binding)).rejects.toThrow(
      'PI_LEAD_FUNDING_CONFIRMATION_STALE'
    )
    expect(db.query('SELECT count(*) AS total FROM model_funding_confirmations').get().total).toBe(
      1
    )
    expect(
      db.query('SELECT record_json FROM model_funding_confirmations').get().record_json
    ).not.toContain('secret')
  } finally {
    db?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('SQLite atomic winner cannot be replaced and corrupt evidence fails closed', async () => {
  const db = new Database(':memory:')
  try {
    const repository = createSqliteModelFundingConfirmations(db)
    const service = createModelFundingPreparationService({
      confirmations: repository,
      executionAuthority: { assertCurrent: async () => {} },
      readFunding: async () => view,
      now: () => at,
    })
    const original = await service.prepareFunding(binding, expiry)
    expect(
      await repository.putIfAbsent({
        ...original,
        funding: { ...view, accountRef: 'account:other' },
      })
    ).toEqual(original)
    expect(
      await repository.getByAttempt({ ...binding, attemptId: 'att_01JABCDEF0123456789ABCDEFH' })
    ).toBeUndefined()
    db.exec("UPDATE model_funding_confirmations SET record_json = '{}'")
    await expect(service.assertFundingCurrent(binding, original.confirmationRef)).rejects.toThrow(
      'PI_LEAD_FUNDING_CONFIRMATION_STALE'
    )
  } finally {
    db.close()
  }
})

test('native Node DatabaseSync reopens exact confirmation and denies changed funding', () => {
  const gateway = new URL('../../../../packages/model-gateway/dist/index.js', import.meta.url).href
  const repository = new URL('../../dist/models/sqlite-funding-confirmations.js', import.meta.url)
    .href
  const root = mkdtempSync(join(tmpdir(), 'pi-native-funding-'))
  try {
    const source = `import {DatabaseSync} from 'node:sqlite';
      import {createModelFundingPreparationService} from ${JSON.stringify(gateway)};
      import {createSqliteModelFundingConfirmations} from ${JSON.stringify(repository)};
      const binding=${JSON.stringify(binding)}, view=${JSON.stringify(view)};
      const path=${JSON.stringify(join(root, 'native.sqlite'))};
      let db=new DatabaseSync(path),current=view;
      const service=()=>createModelFundingPreparationService({
        confirmations:createSqliteModelFundingConfirmations(db),
        executionAuthority:{assertCurrent:async()=>{}},readFunding:async()=>current,
        now:()=>${JSON.stringify(at)}});
      const first=await service().prepareFunding(binding,${JSON.stringify(expiry)});
      db.close();db=new DatabaseSync(path);
      const reopened=await service().prepareFunding(binding,${JSON.stringify(expiry)});
      if(first.confirmationRef!==reopened.confirmationRef)throw new Error('reopen mismatch');
      current={...view,accountRef:'account:changed'};
      let denied=false;try{await service().confirmedExecutionAuthority.assertCurrent(binding)}
      catch(error){denied=error.code==='PI_LEAD_FUNDING_CONFIRMATION_STALE'};
      db.close();if(!denied)throw new Error('changed payer not denied');
      process.stdout.write('native-node-reopen-and-stale-pass');`
    expect(
      execFileSync('node', ['--input-type=module', '--eval', source], {
        encoding: 'utf8',
        timeout: 10000,
      })
    ).toBe('native-node-reopen-and-stale-pass')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
