import { test, expect } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { SqlitePiLeadPreparations } from './lead-preparation.ts'

const at = '2026-10-08T00:00:00.000Z'
const later = '2026-10-08T01:00:00.000Z'
const stale = 'PI_LEAD_FUNDING_CONFIRMATION_STALE'
const canary = 'DO_NOT_PERSIST_CREDENTIAL_OR_PRIVATE_ERROR'
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function fixture(body) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-preparation-'))
  const path = join(dir, 'store.sqlite')
  const connections = []
  const plan = createExecutionPlanTestFixture()
  const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
  const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
  const admission = {
    schemaVersion: 'pi-lead-authority/v1',
    intentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
    workspaceId: plan.correlation.workspaceId,
    allowedPrincipalIds: ['svc_adea'],
    admissionDigest: `sha256:${'a'.repeat(64)}`,
    deadlineAt: later,
    admittedAttempt: {
      executionId,
      attemptId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
    },
    startRequest: {
      executionId,
      attemptId,
      idempotencyKey: 'lead:one',
      executionPlan: plan,
      attemptBudget: {
        schemaVersion: 1,
        workspaceId: plan.correlation.workspaceId,
        executionId,
        attemptId,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
        reservationKey: `runtime-attempt:${attemptId}`,
        currency: 'USD',
        maximumMicrounits: 1000,
        maximumTokens: 100,
      },
    },
  }
  const principal = {
    kind: 'agent_hq_service',
    principalId: 'svc_adea',
    workspaceIds: [admission.workspaceId],
    projectIds: [],
    scopes: ['execution:accept'],
  }
  let funding = {
    schemaVersion: 'model-funding-display/v1',
    workspaceId: admission.workspaceId,
    executionId,
    attemptId,
    selectionRef: `msel_${'a'.repeat(32)}`,
    selectionRevision: 1,
    state: 'ready',
    provider: 'openai',
    providerModel: 'gpt-5',
    accountRef: 'account:one',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    fundingOwner: {
      ownerRef: 'payer:one',
      kind: 'provider_account',
      displayName: 'Example account',
      revision: 1,
      evidenceRef: 'evidence:one',
    },
    authorizationRef: 'authorization:one',
    authorityRevision: 1,
    expiresAt: later,
  }
  let currentTime = at,
    releaseCalls = 0,
    physicalReleases = 0
  const released = new Set()
  const authority = {
    readFunding: async () => structuredClone(funding),
    releaseExpired: async (value) => {
      releaseCalls++
      if (!released.has(value.admittedAttempt.attemptId)) {
        released.add(value.admittedAttempt.attemptId)
        physicalReleases++
      }
    },
  }
  const open = () => {
    const db = new DatabaseSync(path)
    connections.push(db)
    return { db, store: new SqlitePiLeadPreparations(db, authority, () => currentTime) }
  }
  const first = open()
  const rows = (db) =>
    db
      .prepare('SELECT record FROM pi_lead_preparations')
      .all()
      .map((row) => JSON.parse(row.record))
  try {
    await body({
      ...first,
      open,
      rows,
      admission,
      principal,
      authority,
      setFunding: (value) => {
        funding = value
      },
      funding: () => structuredClone(funding),
      advance: (ms) => {
        currentTime = new Date(Date.parse(at) + ms).toISOString()
      },
      releaseCalls: () => releaseCalls,
      physicalReleases: () => physicalReleases,
    })
  } finally {
    for (const db of connections) {
      try {
        db.close()
      } catch {}
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('retained exact funding replay preserves expiration and returns independent display data', async () =>
  fixture(async (f) => {
    const first = await f.store.prepare(f.admission, f.principal)
    first.funding.fundingOwner.displayName = 'caller mutated'
    f.advance(1000)
    const again = await f.store.prepare(f.admission, f.principal)
    expect(again.preparationRef).toBe(first.preparationRef)
    expect(again.expiresAt).toBe(first.expiresAt)
    expect(again.replayed).toBe(true)
    expect(again.funding.fundingOwner.displayName).toBe('Example account')
    await f.store.assertDispatch(again.preparationRef, f.admission, f.principal)
    expect(f.releaseCalls()).toBe(0)
  }))

test('funding read failure retains release before callback and survives physical reopen without secrets', async () =>
  fixture(async (f) => {
    f.authority.readFunding = async () => {
      expect(f.rows(f.db).some((row) => row.state === 'preparing')).toBe(true)
      throw new Error(canary)
    }
    f.authority.releaseExpired = async () => {
      expect(f.rows(f.db).some((row) => row.state === 'release_pending')).toBe(true)
      throw new Error(canary)
    }
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(f.rows(f.db).map((row) => row.state)).toEqual(['release_pending'])
    expect(JSON.stringify(f.rows(f.db))).not.toContain(canary)
    f.db.close()
    const reopened = f.open()
    let releases = 0
    f.authority.releaseExpired = async () => {
      releases++
    }
    await reopened.store.recoverExpired()
    await reopened.store.recoverExpired()
    expect(releases).toBe(1)
    expect(f.rows(reopened.db)[0].state).toBe('released')
  }))

test('crash during asynchronous preparation is reclaimed on physical reopen at TTL', async () =>
  fixture(async (f) => {
    const gate = deferred()
    f.authority.readFunding = () => gate.promise
    void f.store.prepare(f.admission, f.principal)
    expect(f.rows(f.db)[0].state).toBe('preparing')
    f.db.close()
    f.advance(300_000)
    const reopened = f.open()
    await reopened.store.recoverExpired()
    expect(f.physicalReleases()).toBe(1)
    expect(f.rows(reopened.db)[0].state).toBe('released')
  }))

test.each(['blocked', 'expired', 'foreign', 'secret_extension'])(
  'rejected funding %s releases unused allocation',
  async (fault) =>
    fixture(async (f) => {
      const value = f.funding()
      if (fault === 'blocked') {
        f.setFunding({
          schemaVersion: value.schemaVersion,
          workspaceId: value.workspaceId,
          executionId: value.executionId,
          attemptId: value.attemptId,
          selectionRef: value.selectionRef,
          selectionRevision: value.selectionRevision,
          state: 'blocked',
          reasonCode: 'READINESS_UNAVAILABLE',
        })
      }
      if (fault === 'expired') {
        value.expiresAt = at
        f.setFunding(value)
      }
      if (fault === 'foreign') {
        value.attemptId = 'att_01JABCDEF0123456789ABCDEFA'
        f.setFunding(value)
      }
      if (fault === 'secret_extension') {
        value.credential = canary
        f.setFunding(value)
      }
      await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
      expect(f.physicalReleases()).toBe(1)
      expect(f.rows(f.db)[0].state).toBe('released')
      expect(JSON.stringify(f.rows(f.db))).not.toContain(canary)
    })
)

test('expiry wins during funding await; late reply cannot revive or dispatch', async () =>
  fixture(async (f) => {
    const gate = deferred()
    f.authority.readFunding = () => gate.promise
    const pending = f.store.prepare(f.admission, f.principal)
    const outcome = pending.then(
      () => undefined,
      (error) => error
    )
    f.advance(300_000)
    await f.open().store.recoverExpired()
    gate.resolve(f.funding())
    expect((await outcome)?.message).toBe(stale)
    expect(f.rows(f.db).some((row) => row.state === 'prepared')).toBe(false)
    expect(f.physicalReleases()).toBe(1)
  }))

test('cross-connection concurrent prepare is bounded and preserves the admitted owner', async () =>
  fixture(async (f) => {
    const gate = deferred()
    f.authority.readFunding = () => gate.promise
    const first = f.store.prepare(f.admission, f.principal)
    await expect(f.open().store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(f.releaseCalls()).toBe(0)
    gate.resolve(f.funding())
    const retained = await first
    expect(retained.replayed).toBe(false)
    expect(f.rows(f.db).filter((row) => row.state === 'prepared')).toHaveLength(1)
  }))

test('changed funding cannot replace the accepted attempt winner or renew its TTL', async () =>
  fixture(async (f) => {
    const first = await f.store.prepare(f.admission, f.principal)
    const original = f.funding()
    const changed = f.funding()
    changed.fundingOwner.revision++
    changed.authorizationRef = 'authorization:two'
    f.setFunding(changed)
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(f.rows(f.db).filter((row) => row.state === 'prepared')).toHaveLength(1)
    expect(f.rows(f.db).find((row) => row.preparationRef === first.preparationRef).state).toBe(
      'prepared'
    )
    expect(f.releaseCalls()).toBe(0)
    f.setFunding(original)
    await f.store.assertDispatch(first.preparationRef, f.admission, f.principal)
    f.advance(300_000)
    await f.store.recoverExpired()
    expect(f.releaseCalls()).toBe(1)
  }))

test('retained dispatch fence prohibits expiry, rejection or refreshed funding from releasing in-flight allocation', async () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const claim = f.store.markDispatching(prepared.preparationRef)
    expect(() => f.store.markDispatching(prepared.preparationRef)).toThrow(stale)
    await f.store.rejectPreparation(prepared.preparationRef)
    f.advance(300_000)
    await f.store.recoverExpired()
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(f.releaseCalls()).toBe(0)
    expect(f.rows(f.db).find((row) => row.preparationRef === prepared.preparationRef).state).toBe(
      'dispatching'
    )
    f.store.finishDispatchClaim(claim)
  }))

test('dispatch checks expiry atomically even when no scanner has run', async () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    f.advance(300_000)
    expect(() => f.store.markDispatching(prepared.preparationRef)).toThrow(stale)
    await f.store.recoverExpired()
    expect(f.physicalReleases()).toBe(1)
  }))

test.each(['expiry', 'rejection', 'dispatch', 'funding'])(
  'dispatch funding await is fenced against concurrent %s',
  async (fault) =>
    fixture(async (f) => {
      const prepared = await f.store.prepare(f.admission, f.principal)
      const gate = deferred()
      f.authority.readFunding = () => gate.promise
      const pending = f.store.assertDispatch(prepared.preparationRef, f.admission, f.principal)
      const outcome = pending.then(
        () => undefined,
        (error) => error
      )
      if (fault === 'expiry') {
        f.advance(300_000)
        await f.open().store.recoverExpired()
      }
      if (fault === 'rejection') await f.open().store.rejectPreparation(prepared.preparationRef)
      if (fault === 'dispatch') f.open().store.markDispatching(prepared.preparationRef)
      const result = f.funding()
      if (fault === 'funding') result.authorityRevision++
      gate.resolve(result)
      expect((await outcome)?.message).toBe(stale)
      if (fault === 'expiry' || fault === 'rejection')
        expect(() => f.store.markDispatching(prepared.preparationRef)).toThrow(stale)
    })
)

test('rejected publication retains cleanup failure then retries idempotently after physical reopen', async () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    f.authority.releaseExpired = async () => {
      throw new Error(canary)
    }
    await expect(f.store.rejectPreparation(prepared.preparationRef)).rejects.toThrow(stale)
    expect(f.rows(f.db).find((row) => row.preparationRef === prepared.preparationRef).state).toBe(
      'release_pending'
    )
    f.db.close()
    const reopened = f.open()
    let count = 0
    f.authority.releaseExpired = async () => {
      count++
    }
    await reopened.store.recoverExpired()
    await reopened.store.rejectPreparation(prepared.preparationRef)
    expect(count).toBe(1)
    expect(JSON.stringify(f.rows(reopened.db))).not.toContain(canary)
  }))

test('concurrent recovery may retry only the idempotent release, never dispatch or replace', async () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    f.advance(300_000)
    const gate = deferred()
    let calls = 0
    f.authority.releaseExpired = async () => {
      calls++
      await gate.promise
    }
    const first = f.store.recoverExpired()
    const second = f.open().store.recoverExpired()
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(() => f.store.markDispatching(prepared.preparationRef)).toThrow(stale)
    gate.resolve()
    await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(f.rows(f.db).find((row) => row.preparationRef === prepared.preparationRef).state).toBe(
      'released'
    )
  }))

test.each(['json', 'identity', 'scope', 'plan', 'extra_secret'])(
  'corrupted store %s fails closed before release callbacks',
  async (fault) =>
    fixture(async (f) => {
      const prepared = await f.store.prepare(f.admission, f.principal)
      const retained = f.rows(f.db).find((row) => row.preparationRef === prepared.preparationRef)
      if (fault === 'identity') retained.preparationRef = `prep_${'0'.repeat(32)}`
      if (fault === 'scope') retained.admission.workspaceId = 'wsp_01JABCDEF0123456789ABCDEFA'
      if (fault === 'plan')
        retained.admission.startRequest.executionPlan.constraints.limits.tokens.maximumTotal++
      if (fault === 'extra_secret') retained.credential = canary
      f.db
        .prepare('UPDATE pi_lead_preparations SET record = ? WHERE preparation_ref = ?')
        .run(fault === 'json' ? '{bad' : JSON.stringify(retained), prepared.preparationRef)
      f.advance(300_000)
      await expect(f.store.recoverExpired()).rejects.toThrow(stale)
      expect(f.releaseCalls()).toBe(0)
    })
)

test('dispatch readiness errors are bounded and preserve cleanup evidence without private diagnostics', async () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    f.authority.readFunding = async () => {
      throw new Error(canary)
    }
    const error = await f.store
      .assertDispatch(prepared.preparationRef, f.admission, f.principal)
      .catch((value) => value)
    expect(error.message).toBe(stale)
    expect(error.message).not.toContain(canary)
    expect(f.rows(f.db).find((row) => row.preparationRef === prepared.preparationRef).state).toBe(
      'prepared'
    )
    f.advance(300_000)
    await f.store.recoverExpired()
    expect(f.physicalReleases()).toBe(1)
  }))

test('release acknowledgement lost after host release recovers with the same immutable attempt', async () =>
  fixture(async (f) => {
    const prepared = await f.store.prepare(f.admission, f.principal)
    const released = new Set()
    let physical = 0,
      calls = 0,
      fail = true
    f.authority.releaseExpired = async (admission) => {
      calls++
      expect(admission.admittedAttempt).toEqual(f.admission.admittedAttempt)
      if (!released.has(admission.admittedAttempt.attemptId)) {
        released.add(admission.admittedAttempt.attemptId)
        physical++
      }
      if (fail) throw new Error(canary)
    }
    await expect(f.store.rejectPreparation(prepared.preparationRef)).rejects.toThrow(stale)
    expect(f.rows(f.db).find((row) => row.preparationRef === prepared.preparationRef).state).toBe(
      'release_pending'
    )
    f.db.close()
    fail = false
    const reopened = f.open()
    await reopened.store.recoverExpired()
    expect(physical).toBe(1)
    expect(calls).toBe(2)
    expect(
      f.rows(reopened.db).find((row) => row.preparationRef === prepared.preparationRef).state
    ).toBe('released')
  }))

test('already expired admission still retains and releases its unused admitted allocation', async () =>
  fixture(async (f) => {
    f.admission.deadlineAt = at
    let reads = 0
    f.authority.readFunding = async () => {
      reads++
      return f.funding()
    }
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(reads).toBe(0)
    expect(f.physicalReleases()).toBe(1)
    expect(f.rows(f.db)[0].state).toBe('released')
  }))

test('mandatory cleanup callback is checked before configuring the preparation table', async () =>
  fixture(async (f) => {
    expect(
      () => new SqlitePiLeadPreparations(f.db, { readFunding: f.authority.readFunding }, () => at)
    ).toThrow(stale)
    expect(f.rows(f.db)).toEqual([])
  }))

test('keeps a secret canary out of Pi lead preparation rows through every failure path', async () => {
  await fixture(async (f) => {
    // The canary is thrown from the funding read. Cleanup succeeds, so the row is released.
    f.authority.readFunding = async () => {
      throw new Error(canary)
    }
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(f.physicalReleases()).toBe(1)
    expect(f.rows(f.db).map((row) => row.state)).toEqual(['released'])
    expect(JSON.stringify(f.rows(f.db))).not.toContain(canary)
  })
  await fixture(async (f) => {
    // A canary carried as an extension of the funding display is rejected and then released.
    const value = f.funding()
    value.credential = canary
    f.setFunding(value)
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(f.physicalReleases()).toBe(1)
    expect(f.rows(f.db).map((row) => row.state)).toEqual(['released'])
    expect(JSON.stringify(f.rows(f.db))).not.toContain(canary)
  })
  await fixture(async (f) => {
    // Callback and cleanup both fail with the canary. The retained row survives a physical reopen.
    f.authority.readFunding = async () => {
      throw new Error(canary)
    }
    f.authority.releaseExpired = async () => {
      throw new Error(canary)
    }
    await expect(f.store.prepare(f.admission, f.principal)).rejects.toThrow(stale)
    expect(f.rows(f.db).map((row) => row.state)).toEqual(['release_pending'])
    expect(JSON.stringify(f.rows(f.db))).not.toContain(canary)
    f.db.close()
    const reopened = f.open()
    let releases = 0
    f.authority.releaseExpired = async () => {
      releases++
    }
    await reopened.store.recoverExpired()
    expect(releases).toBe(1)
    expect(f.rows(reopened.db).map((row) => row.state)).toEqual(['released'])
    expect(JSON.stringify(f.rows(reopened.db))).not.toContain(canary)
  })
  await fixture(async (f) => {
    // Rejection cleanup fails with the canary. Retrying after reopen releases the row without persisting it.
    const prepared = await f.store.prepare(f.admission, f.principal)
    f.authority.releaseExpired = async () => {
      throw new Error(canary)
    }
    await expect(f.store.rejectPreparation(prepared.preparationRef)).rejects.toThrow(stale)
    // prepare() superseded its initial preparing row; the rejected prepared row awaits release.
    expect(
      f
        .rows(f.db)
        .map((row) => row.state)
        .toSorted()
    ).toEqual(['release_pending', 'superseded'])
    expect(JSON.stringify(f.rows(f.db))).not.toContain(canary)
    f.db.close()
    const reopened = f.open()
    let count = 0
    f.authority.releaseExpired = async () => {
      count++
    }
    await reopened.store.recoverExpired()
    await reopened.store.rejectPreparation(prepared.preparationRef)
    expect(count).toBe(1)
    expect(
      f
        .rows(reopened.db)
        .map((row) => row.state)
        .toSorted()
    ).toEqual(['released', 'superseded'])
    expect(JSON.stringify(f.rows(reopened.db))).not.toContain(canary)
  })
})
