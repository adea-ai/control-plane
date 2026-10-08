import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { PiDurableRuntimeAdapter } from '@control-plane/pi-durable-adapter'
import { SqlitePiLeadPreparations } from './lead-preparation.ts'
import {
  DurablePiDurableLeadService,
  SqlitePiDurableLeadReceiptStore,
} from './pi-durable-lead.service.ts'
const at = '2026-10-08T00:00:00.000Z'
const deadlineAt = '2026-10-08T01:00:00.000Z'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const hash = (value) => createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-dispatch-recovery-'))
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const request = {
    executionId: id('exe'),
    attemptId: id('att'),
    idempotencyKey: 'canonical:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId: plan.correlation.workspaceId,
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${id('att')}`,
      currency: 'USD',
      maximumMicrounits: 1000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-lead-authority/v1',
    intentId,
    workspaceId: plan.correlation.workspaceId,
    allowedPrincipalIds: ['svc_adea'],
    admissionDigest: `sha256:${'a'.repeat(64)}`,
    deadlineAt,
    admittedAttempt: {
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
    },
    startRequest: request,
  }
  const principal = {
    kind: 'agent_hq_service',
    principalId: 'svc_adea',
    workspaceIds: [admission.workspaceId],
    projectIds: [plan.correlation.projectId],
    scopes: ['execution:accept', 'execution:read'],
  }
  let adapter,
    store,
    receipts,
    service,
    clock = at,
    providerFailure = false,
    providerPause,
    releaseFailure = false
  const metrics = { admissions: 0, releases: 0, sends: 0 }
  const preparationPath = join(directory, 'preparation.sqlite')
  let database
  async function open() {
    adapter = new PiDurableRuntimeAdapter({
      directory: join(directory, 'runtime'),
      now: () => clock,
      resolveAdmission: async () => ({
        schemaVersion: 'pi-durable-admission/v1',
        prompt: 'test',
        selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
        authority: {
          revision: 1,
          principalRef: 'actor:one',
          scopeRef: 'scope:one',
          expiresAt: deadlineAt,
        },
      }),
      assertAuthority: async () => {},
      resolveProvider: async () => {
        await providerPause?.()
        if (providerFailure) throw new Error('synthetic-before-journal')
        return {
          selectionRef: `msel_${'a'.repeat(32)}`,
          selectionRevision: 1,
          workspaceId: admission.workspaceId,
          provider: 'test',
          providerModel: 'mock',
          location: 'remote_host',
          harness: 'pi_durable',
          harnessVersion: '1.1.0',
          providerBinding: 'pi_durable_models',
          withModels: async () => {
            throw new Error('no-paid-provider')
          },
        }
      },
      authorizeInference: async () => ({
        maxOutputTokens: 10,
        maximumInputTokens: 10,
        assertActive: async () => {},
      }),
      settleUsage: async (_a, _k, u) => u,
      reconcileInference: async () => 'unresolved',
      engineFactory: async () => ({
        run: async () => {
          metrics.sends++
          throw new Error('synthetic-engine-stops')
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    database = new DatabaseSync(preparationPath)
    store = new SqlitePiLeadPreparations(
      database,
      {
        readFunding: async () => ({
          schemaVersion: 'model-funding-display/v1',
          workspaceId: admission.workspaceId,
          executionId: id('exe'),
          attemptId: id('att'),
          selectionRef: `msel_${'a'.repeat(32)}`,
          selectionRevision: 1,
          state: 'ready',
          provider: 'test',
          providerModel: 'mock',
          accountRef: 'account:test',
          authKind: 'api_key',
          fundingSource: 'byo_api',
          fundingOwner: {
            ownerRef: 'payer:test',
            kind: 'provider_account',
            displayName: 'Test payer',
            revision: 1,
            evidenceRef: 'payer:test',
          },
          authorizationRef: 'authorization:test',
          authorityRevision: 1,
          expiresAt: deadlineAt,
        }),
        releaseExpired: async () => {
          if (releaseFailure) throw new Error('hold-or-send-history')
          metrics.releases++
        },
      },
      () => clock,
      { findRuntimeHandle: (runtimeRequest) => adapter.findExistingHandle(runtimeRequest) }
    )
    receipts = new SqlitePiDurableLeadReceiptStore(database)
    service = new DurablePiDurableLeadService({
      adapter,
      receipts,
      preparations: store,
      findRuntimeHandle: (runtimeRequest) => adapter.findExistingHandle(runtimeRequest),
      now: () => clock,
      authority: {
        resolveIntent: async () => {
          metrics.admissions++
          return admission
        },
        assertCurrent: async () => {},
      },
    })
  }
  const envelope = (payload, key = 'transport-command:one') => ({
    caller: { servicePrincipalId: principal.principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId: admission.workspaceId,
    projectId: plan.correlation.projectId,
    correlation: { traceId: id('trc') },
    commandId: id('cmd'),
    idempotencyKey: key,
    payloadHash: hash(payload),
    operation: 'pi-durable.lead.dispatch',
    issuedAt: at,
    payload,
  })
  const close = async () => {
    await adapter?.close()
    database?.close()
    adapter = undefined
    database = undefined
  }
  try {
    await open()
    await body({
      admission,
      principal,
      envelope,
      metrics,
      preparationPath,
      open,
      close,
      get service() {
        return service
      },
      get store() {
        return store
      },
      get database() {
        return database
      },
      get adapter() {
        return adapter
      },
      advance: () => {
        clock = '2026-10-08T00:05:00.000Z'
      },
      providerFailure: () => {
        providerFailure = true
      },
      pauseProvider: (callback) => {
        providerPause = callback
      },
      releaseFailure: () => {
        releaseFailure = true
      },
    })
  } finally {
    await close()
    await rm(directory, { recursive: true, force: true })
  }
}

for (const ref of [undefined, `prep_${'f'.repeat(32)}`])
  test(`fresh ${ref ? 'bogus' : 'missing'} preparation ref fails before canonical admission or command bind`, () =>
    fixture(async (f) => {
      await expect(
        f.service.dispatch(
          f.envelope({ intentId, ...(ref ? { preparationRef: ref } : {}) }),
          f.principal
        )
      ).rejects.toThrow()
      expect(f.metrics.admissions).toBe(0)
      expect(f.database.prepare('SELECT count(*) AS count FROM pi_lead_commands').get().count).toBe(
        0
      )
      expect(f.adapter.journal.list()).toHaveLength(0)
    }))

test('pre-journal provider failure retains recoverable claim and expired inactive claim reclaims once after physical reopen', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    f.providerFailure()
    await expect(
      f.service.dispatch(
        f.envelope({ intentId, preparationRef: prepared.preparationRef }),
        f.principal
      )
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(f.adapter.journal.list()).toHaveLength(0)
    expect(
      JSON.parse(
        f.database
          .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
          .get(prepared.preparationRef).record
      ).state
    ).toBe('dispatching')
    await f.close()
    f.advance()
    await f.open()
    await f.store.recoverExpired()
    await f.store.recoverExpired()
    expect(f.metrics.releases).toBe(1)
    expect(f.metrics.sends).toBe(0)
    expect(
      JSON.parse(
        f.database
          .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
          .get(prepared.preparationRef).record
      ).state
    ).toBe('released')
  }))

test('live suspended pre-journal admission cannot be reclaimed at TTL or raced by a second dispatcher', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    let enter, resume
    const entered = new Promise((resolve) => {
      enter = resolve
    })
    const paused = new Promise((resolve) => {
      resume = resolve
    })
    f.pauseProvider(async () => {
      enter()
      await paused
    })
    f.providerFailure()
    const pending = f.service.dispatch(
      f.envelope({ intentId, preparationRef: prepared.preparationRef }),
      f.principal
    )
    const outcome = pending.catch((error) => error)
    try {
      await entered
      expect(f.adapter.journal.list()).toHaveLength(0)
      f.advance()
      await f.store.recoverExpired()
      expect(f.metrics.releases).toBe(0)
      const second = new SqlitePiLeadPreparations(
        f.database,
        f.store.authority,
        () => '2026-10-08T00:05:00.000Z',
        { findRuntimeHandle: (request) => f.adapter.findExistingHandle(request) }
      )
      await expect(
        second.assertDispatch(prepared.preparationRef, f.admission, f.principal)
      ).rejects.toThrow()
      expect(() => second.markDispatching(prepared.preparationRef)).toThrow()
      expect(f.metrics.sends).toBe(0)
    } finally {
      resume()
      await outcome
    }
    await f.store.recoverExpired()
    expect(f.metrics.releases).toBe(1)
    expect(f.metrics.sends).toBe(0)
  }))

test('SIGKILL after persisted dispatch claim reclaims a no-journal allocation after physical reopen', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    await f.close()
    const child = spawn(
      process.execPath,
      [
        '--eval',
        `
    import { DatabaseSync } from 'node:sqlite';
    import { SqlitePiLeadPreparations } from ${JSON.stringify(new URL('./lead-preparation.ts', import.meta.url).pathname)};
    const db = new DatabaseSync(${JSON.stringify(f.preparationPath)});
    const store = new SqlitePiLeadPreparations(db, {readFunding:async()=>{throw new Error('unused')}, releaseExpired:async()=>{throw new Error('unused')}}, ()=>${JSON.stringify(at)});
    store.markDispatching(${JSON.stringify(prepared.preparationRef)});
    process.stdout.write('claimed\\n');
    setInterval(()=>{},1000);
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal }))
    )
    try {
      await new Promise((resolve, reject) => {
        let output = ''
        child.stdout.on('data', (data) => {
          output += data
          if (output.includes('claimed')) resolve()
        })
        child.once('exit', (code) => reject(new Error(`claim worker exited before fence: ${code}`)))
        child.once('error', reject)
      })
      expect(child.kill('SIGKILL')).toBe(true)
      expect((await exited).signal).toBe('SIGKILL')
      f.advance()
      await f.open()
      expect(f.adapter.journal.list()).toHaveLength(0)
      await f.store.recoverExpired()
      await f.store.recoverExpired()
      expect(f.metrics.releases).toBe(1)
      expect(f.metrics.sends).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  }))

test('runtime journal admission survives receipt fault and TTL scanner acknowledges actual handle without release or replay', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    const handle = await f.adapter.start(f.admission.startRequest)
    f.store.finishDispatchClaim(claim)
    await f.adapter.drain()
    expect(f.metrics.sends).toBe(1)
    await f.close()
    f.advance()
    await f.open()
    await f.store.recoverExpired()
    const retained = JSON.parse(
      f.database
        .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
        .get(prepared.preparationRef).record
    )
    expect(retained.state).toBe('dispatched')
    expect(retained.runtimeHandle).toEqual(handle)
    expect(f.metrics.releases).toBe(0)
    expect(f.metrics.sends).toBe(1)
  }))

test('unknown runtime lookup or paid hold evidence leaves cleanup pending and never releases', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    f.store.finishDispatchClaim(claim)
    f.advance()
    const failing = new SqlitePiLeadPreparations(
      f.database,
      f.store.authority,
      () => '2026-10-08T00:05:00.000Z',
      {
        findRuntimeHandle: async () => {
          throw new Error('DO_NOT_PERSIST_PRIVATE_DIAGNOSTIC')
        },
      }
    )
    await expect(failing.recoverExpired()).rejects.toThrow('PI_LEAD_FUNDING_CONFIRMATION_STALE')
    expect(f.metrics.releases).toBe(0)
    f.releaseFailure()
    await expect(f.store.recoverExpired()).rejects.toThrow('PI_LEAD_FUNDING_CONFIRMATION_STALE')
    expect(f.metrics.releases).toBe(0)
    const row = f.database
      .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
      .get(prepared.preparationRef).record
    expect(JSON.parse(row).state).toBe('release_pending')
    expect(row).not.toContain('DO_NOT_PERSIST_PRIVATE_DIAGNOSTIC')
  }))

test('release_pending CAS fences a dispatcher while the no-runtime proof awaits', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    f.store.finishDispatchClaim(claim)
    f.advance()
    let enter, resume
    const entered = new Promise((resolve) => {
      enter = resolve
    })
    const paused = new Promise((resolve) => {
      resume = resolve
    })
    const recovering = new SqlitePiLeadPreparations(
      f.database,
      f.store.authority,
      () => '2026-10-08T00:05:00.000Z',
      {
        findRuntimeHandle: async (request) => {
          enter()
          await paused
          return f.adapter.findExistingHandle(request)
        },
      }
    )
    const pending = recovering.recoverExpired()
    try {
      await entered
      expect(
        JSON.parse(
          f.database
            .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
            .get(prepared.preparationRef).record
        ).state
      ).toBe('release_pending')
      await expect(
        f.service.dispatch(
          f.envelope({ intentId, preparationRef: prepared.preparationRef }),
          f.principal
        )
      ).rejects.toThrow('PI_LEAD_FUNDING_CONFIRMATION_STALE')
      expect(f.metrics.admissions).toBe(0)
      expect(() => f.store.markDispatching(prepared.preparationRef)).toThrow()
      expect(f.adapter.journal.list()).toHaveLength(0)
    } finally {
      resume()
      await pending
    }
    expect(f.metrics.releases).toBe(1)
    expect(f.metrics.sends).toBe(0)
  }))

test('a real prepared reference for another intent cannot allocate or bind a fresh transport command', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    await expect(
      f.service.dispatch(
        f.envelope({
          intentId: '9643a115-617d-4bae-8d52-cfe458c0b8ac',
          preparationRef: prepared.preparationRef,
        }),
        f.principal
      )
    ).rejects.toThrow('PI_LEAD_FUNDING_CONFIRMATION_STALE')
    expect(f.metrics.admissions).toBe(0)
    expect(f.database.prepare('SELECT count(*) AS count FROM pi_lead_commands').get().count).toBe(0)
    expect(f.adapter.journal.list()).toHaveLength(0)
  }))

test('foreign live process generation and missing runtime metadata integration cannot reclaim a retained claim', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    f.store.finishDispatchClaim(claim)
    const original = JSON.parse(
      f.database
        .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
        .get(prepared.preparationRef).record
    )
    const foreign = {
      ...original,
      dispatchClaim: {
        ...original.dispatchClaim,
        ownerBootRef: `piboot_${'f'.repeat(32)}`,
        ownerPid: process.ppid,
      },
    }
    f.database
      .prepare('UPDATE pi_lead_preparations SET record=? WHERE preparation_ref=?')
      .run(JSON.stringify(foreign), prepared.preparationRef)
    f.advance()
    await f.store.recoverExpired()
    expect(f.metrics.releases).toBe(0)
    expect(
      JSON.parse(
        f.database
          .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
          .get(prepared.preparationRef).record
      ).state
    ).toBe('dispatching')
    f.database
      .prepare('UPDATE pi_lead_preparations SET record=? WHERE preparation_ref=?')
      .run(JSON.stringify(original), prepared.preparationRef)
    const missing = new SqlitePiLeadPreparations(
      f.database,
      f.store.authority,
      () => '2026-10-08T00:05:00.000Z'
    )
    await expect(missing.recoverExpired()).rejects.toThrow('PI_LEAD_FUNDING_CONFIRMATION_STALE')
    expect(f.metrics.releases).toBe(0)
    expect(
      JSON.parse(
        f.database
          .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
          .get(prepared.preparationRef).record
      ).state
    ).toBe('release_pending')
  }))

test('legacy dispatched receipt without a handle remains conservatively retained at TTL', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const row = JSON.parse(
      f.database
        .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
        .get(prepared.preparationRef).record
    )
    f.database
      .prepare('UPDATE pi_lead_preparations SET record=? WHERE preparation_ref=?')
      .run(JSON.stringify({ ...row, state: 'dispatched' }), prepared.preparationRef)
    f.advance()
    await f.store.recoverExpired()
    expect(f.metrics.releases).toBe(0)
    expect(
      JSON.parse(
        f.database
          .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
          .get(prepared.preparationRef).record
      ).state
    ).toBe('dispatched')
  }))

test('expired previous-boot claim reusing the current PID releases a no-journal allocation exactly once', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    f.store.finishDispatchClaim(claim)
    const original = JSON.parse(
      f.database
        .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
        .get(prepared.preparationRef).record
    )
    const old = {
      ...original,
      dispatchClaim: {
        ...original.dispatchClaim,
        ownerPid: process.pid,
        ownerBootRef: `piboot_${'f'.repeat(32)}`,
      },
    }
    f.database
      .prepare('UPDATE pi_lead_preparations SET record=? WHERE preparation_ref=?')
      .run(JSON.stringify(old), prepared.preparationRef)
    await f.close()
    f.advance()
    await f.open()
    await f.store.recoverExpired()
    await f.store.recoverExpired()
    expect(f.metrics.releases).toBe(1)
    expect(f.adapter.journal.list()).toHaveLength(0)
    expect(f.metrics.sends).toBe(0)
    expect(
      JSON.parse(
        f.database
          .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
          .get(prepared.preparationRef).record
      ).state
    ).toBe('released')
  }))

test('duplicate module loading shares process generation and retains the same-boot active claim fence', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    f.advance()
    const other = await import('./lead-preparation.ts?qualification-duplicate-realm=1')
    const store = new other.SqlitePiLeadPreparations(
      f.database,
      f.store.authority,
      () => '2026-10-08T00:05:00.000Z',
      { findRuntimeHandle: (request) => f.adapter.findExistingHandle(request) }
    )
    try {
      await store.recoverExpired()
      expect(f.metrics.releases).toBe(0)
      expect(
        JSON.parse(
          f.database
            .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
            .get(prepared.preparationRef).record
        ).state
      ).toBe('dispatching')
    } finally {
      f.store.finishDispatchClaim(claim)
    }
    await store.recoverExpired()
    expect(f.metrics.releases).toBe(1)
    expect(f.metrics.sends).toBe(0)
  }))

test('unsupported worker-thread preparation host is rejected before constructing durable records', async () => {
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    (async()=> {
      const {DatabaseSync} = await import('node:sqlite');
      const {SqlitePiLeadPreparations} = await import(${JSON.stringify(new URL('./lead-preparation.ts', import.meta.url).pathname)});
      const db = new DatabaseSync(':memory:');
      try {
        new SqlitePiLeadPreparations(db, {readFunding:async()=>{},releaseExpired:async()=>{}});
        parentPort.postMessage({accepted:true});
      } catch(error) {
        parentPort.postMessage({code:error.code,tables:db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='pi_lead_preparations'").get().count});
      } finally { db.close(); }
    })().catch(error=>parentPort.postMessage({unexpected:String(error)}));
  `,
    { eval: true }
  )
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exit ${code}`))
      })
    })
    expect(result).toEqual({ code: 'PI_LEAD_FUNDING_CONFIRMATION_STALE', tables: 0 })
  } finally {
    await worker.terminate()
  }
})

test('live exact claim token fences cleanup despite changed persisted boot metadata', () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    const original = JSON.parse(
      f.database
        .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
        .get(prepared.preparationRef).record
    )
    const changed = {
      ...original,
      dispatchClaim: { ...original.dispatchClaim, ownerBootRef: `piboot_${'f'.repeat(32)}` },
    }
    f.database
      .prepare('UPDATE pi_lead_preparations SET record=? WHERE preparation_ref=?')
      .run(JSON.stringify(changed), prepared.preparationRef)
    f.advance()
    try {
      await f.store.recoverExpired()
      expect(f.metrics.releases).toBe(0)
      expect(
        JSON.parse(
          f.database
            .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref=?')
            .get(prepared.preparationRef).record
        ).state
      ).toBe('dispatching')
      expect(f.adapter.journal.list()).toHaveLength(0)
    } finally {
      f.store.finishDispatchClaim(claim)
    }
    await f.store.recoverExpired()
    await f.store.recoverExpired()
    expect(f.metrics.releases).toBe(1)
    expect(f.metrics.sends).toBe(0)
  }))
