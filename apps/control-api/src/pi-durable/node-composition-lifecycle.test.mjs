import { test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createNodePiDurableLeadComposition } from './node-composition.ts'
import { SqlitePiDurableLeadReceiptStore } from './pi-durable-lead.service.ts'

// Lifecycle of the lead composition's periodic recovery, without a run. A failed initialization and a
// closed composition must not reach the journal or the ledger, and no interval may fire after close.

const at = '2026-10-08T09:00:00.000Z'
const fastInterval = 5
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function fakeLedger() {
  const ledger = {
    settles: 0,
    async settle() {
      ledger.settles += 1
      throw new Error('UNUSED_LEDGER_SETTLE')
    },
  }
  return ledger
}

function baseOptions(directory, { ledger = fakeLedger(), ...overrides } = {}) {
  const unused = async () => {
    throw new Error('UNUSED_PORT')
  }
  return {
    directory,
    admission: {
      product: { readCurrent: unused },
      resolvePlan: unused,
      plans: {},
      commandRepository: {},
      planValidator: {},
      executions: {},
      budgetAdmission: {},
      admissionPrincipalId: 'svc_pi-admission',
      now: () => at,
    },
    usage: { ledger, resolvePrice: unused, assertSpendingAuthorized: unused },
    provider: unused,
    reconcileInference: async () => 'unresolved',
    periodicRecoveryIntervalMs: fastInterval,
    ...overrides,
  }
}

// Counts journal reads from the moment the adapter exists, so a read after a failure or close is visible.
function journalReadCounter() {
  const counter = { reads: 0 }
  counter.attach = (adapter) => {
    const list = adapter.journal.list.bind(adapter.journal)
    adapter.journal.list = () => {
      counter.reads += 1
      return list()
    }
  }
  return counter
}

test('public recovery and process reopen replay a retained terminal inbox into the product wake', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-timeline-node-'))
  const parentExecutionId = 'exe_01JABCDEF0123456789ABCDEFG'
  const dispatchId = `dispatch_${'a'.repeat(32)}`
  const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
  const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
  const events = []
  const delivered = []
  let refuseDelivery = false
  const options = baseOptions(directory, {
    periodicRecoveryIntervalMs: 60_000,
    parentInbox: { list: async () => events },
    childTimelineDelivery: {
      principalId: 'svc_adea',
      notify: async (input) => {
        if (refuseDelivery) throw new Error('PRODUCT_OFFLINE')
        delivered.push(input)
      },
    },
  })
  let composition
  try {
    composition = await createNodePiDurableLeadComposition(options)
    const database = new DatabaseSync(join(directory, 'lead-admission.sqlite'))
    try {
      const receipts = new SqlitePiDurableLeadReceiptStore(database)
      await receipts.insert({
        schemaVersion: 'pi-lead-receipt/v1',
        dispatchId,
        intentId,
        workspaceId,
        admissionDigest: `sha256:${'1'.repeat(64)}`,
        startDigest: `sha256:${'2'.repeat(64)}`,
        deadlineAt: '2026-10-20T16:00:00.000Z',
        executionId: parentExecutionId,
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        allowedPrincipalIds: ['svc_adea'],
        revision: 2,
        state: 'dispatched',
        handle: {
          handleId: 'hEC01JABCDEF0123456789ABCDEFGH',
          attemptId: 'att_01JABCDEF0123456789ABCDEFG',
          externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
          startedAt: at,
        },
      })
    } finally {
      database.close()
    }
    events.push({
      type: 'delegation.completed',
      delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
      parentExecutionId,
      childExecutionId: `${parentExecutionId.slice(0, -1)}H`,
      occurredAt: at,
      details: { state: 'completed', childAttemptId: 'att_01JABCDEF0123456789ABCDEFG' },
    })
    refuseDelivery = true
    await composition.recover()
    expect(composition.childTimelineRecovery).toEqual({
      delivered: 0,
      blocked: [dispatchId],
      rejected: 0,
    })
    expect(composition.childTimelineDeliveryBlocked).toBe(true)
    refuseDelivery = false
    await composition.recover()
    expect(composition.childTimelineRecovery).toEqual({ delivered: 1, blocked: [], rejected: 0 })
    expect(composition.childTimelineDeliveryBlocked).toBe(false)
    await composition.close()
    composition = await createNodePiDurableLeadComposition(options)
    expect(composition.childTimelineRecovery).toEqual({ delivered: 1, blocked: [], rejected: 0 })
    expect(delivered).toEqual([
      { workspaceId, intentId, principalId: 'svc_adea' },
      { workspaceId, intentId, principalId: 'svc_adea' },
    ])
    await composition.close()
    composition = await createNodePiDurableLeadComposition({
      ...options,
      periodicRecoveryIntervalMs: fastInterval,
    })
    const initialWakes = delivered.length
    for (let index = 0; index < 30 && delivered.length === initialWakes; index++)
      await pause(fastInterval)
    expect(delivered.length).toBeGreaterThan(initialWakes)
  } finally {
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('a failed initialization leaves no recovery pass running against the store it closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-init-failure-'))
  const journal = journalReadCounter()
  try {
    await expect(
      createNodePiDurableLeadComposition(
        baseOptions(directory, {
          onAdapterReady: journal.attach,
          childProgress: {
            scan: async () => {
              throw new Error('CHILD_SCAN_FAILED')
            },
          },
        })
      )
    ).rejects.toThrow('CHILD_SCAN_FAILED')
    const atFailure = journal.reads
    await pause(12 * fastInterval)
    expect(journal.reads).toBe(atFailure)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('after close, recovery and terminal settlement refuse, and no interval reaches the store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-close-'))
  const journal = journalReadCounter()
  const ledger = fakeLedger()
  try {
    const composition = await createNodePiDurableLeadComposition(
      baseOptions(directory, {
        ledger,
        onAdapterReady: journal.attach,
        childProgress: { scan: async () => undefined },
      })
    )
    await composition.close()
    const atClose = journal.reads
    await expect(composition.settleTerminalAccounting()).rejects.toThrow(
      'PI_LEAD_TERMINAL_SETTLEMENT_CLOSED'
    )
    await expect(composition.recover()).rejects.toThrow('PI_LEAD_COMPOSITION_CLOSED')
    await pause(12 * fastInterval)
    expect(journal.reads).toBe(atClose)
    expect(ledger.settles).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('same-version handoff drains accepted lead recovery and fences every later pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-upgrade-close-'))
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const journal = journalReadCounter()
  let hold = false
  let scans = 0
  let adapterCloses = 0
  let composition
  let recovery
  let handoff
  let watchdog
  try {
    composition = await createNodePiDurableLeadComposition(
      baseOptions(directory, {
        onAdapterReady: journal.attach,
        childProgress: {
          scan: async (adapter) => {
            scans += 1
            if (hold) {
              entered.resolve()
              await release.promise
            }
            adapter.journal.list()
          },
        },
      })
    )
    const closeAdapter = composition.adapter.close.bind(composition.adapter)
    composition.adapter.close = () => {
      adapterCloses += 1
      return closeAdapter()
    }
    hold = true
    recovery = composition.recover()
    recovery.catch(() => undefined)
    await Promise.race([
      entered.promise,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('UPGRADE_RECOVERY_NOT_ENTERED')), 1000)
      }),
    ])
    clearTimeout(watchdog)
    handoff = composition.closeForSameVersionUpgrade()
    handoff.catch(() => undefined)
    // The adapter and manifest cannot close underneath an accepted lead recovery.
    expect(adapterCloses).toBe(0)
    release.resolve()
    await recovery
    const manifest = await handoff
    expect(manifest.schemaVersion).toBe('pi-local-upgrade-manifest/v1')
    expect(adapterCloses).toBe(1)
    expect(composition.drainIncomplete).toBe(false)
    await expect(composition.recover()).rejects.toThrow('PI_LEAD_COMPOSITION_CLOSED')
    await expect(composition.settleTerminalAccounting()).rejects.toThrow(
      'PI_LEAD_TERMINAL_SETTLEMENT_CLOSED'
    )
    expect(() => composition.admission.options.database.prepare('SELECT 1')).toThrow()
    const scansAtHandoff = scans
    const readsAtHandoff = journal.reads
    await pause(12 * fastInterval)
    expect(scans).toBe(scansAtHandoff)
    expect(journal.reads).toBe(readsAtHandoff)
  } finally {
    clearTimeout(watchdog)
    release.resolve()
    await recovery?.catch(() => undefined)
    await handoff?.catch(() => undefined)
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('a recovery interval that is not a positive integer is refused before any store is opened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-interval-'))
  try {
    await expect(
      createNodePiDurableLeadComposition(baseOptions(directory, { periodicRecoveryIntervalMs: 0 }))
    ).rejects.toThrow('PI_LEAD_RECOVERY_INTERVAL_INVALID')
    expect(existsSync(join(directory, 'lead-admission.sqlite'))).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('a configured child reader reaches retained receipt lookup without starting child work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-child-reader-'))
  let childReads = 0
  const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
  const principalId = 'svc_pi-admission'
  let composition
  try {
    composition = await createNodePiDurableLeadComposition(
      baseOptions(directory, {
        childDelegations: {
          async listChildren() {
            childReads++
            return []
          },
        },
      })
    )
    await expect(
      composition.service.children(
        {
          caller: { servicePrincipalId: principalId },
          contractVersion: { major: 1, minor: 0 },
          requestId: 'req_01JABCDEF0123456789ABCDEFG',
          workspaceId,
          correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
          operation: 'pi-durable.lead.children',
          requestedAt: at,
          parameters: { dispatchId: `dispatch_${'a'.repeat(32)}` },
        },
        {
          kind: 'agent_hq_service',
          principalId,
          projectIds: [],
          scopes: ['execution:read'],
          workspaceIds: [workspaceId],
        }
      )
    ).rejects.toThrow('PI_LEAD_MISSING')
    expect(childReads).toBe(0)
  } finally {
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('close drains a held periodic scan and concurrent closes share its completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-close-in-flight-'))
  const journal = journalReadCounter()
  const ledger = fakeLedger()
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let scans = 0
  let completedScans = 0
  let composition
  let watchdog
  try {
    composition = await createNodePiDurableLeadComposition(
      baseOptions(directory, {
        ledger,
        onAdapterReady: journal.attach,
        childProgress: {
          scan: async (adapter) => {
            scans += 1
            // Construction runs the first scan; hold only the periodic pass.
            if (scans === 2) {
              started.resolve()
              await release.promise
            }
            // The store must remain open until the held scan finishes.
            adapter.journal.list()
            completedScans += 1
          },
        },
      })
    )
    await Promise.race([
      started.promise,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('PERIODIC_SCAN_NOT_STARTED')), 1000)
      }),
    ])
    clearTimeout(watchdog)
    const firstClose = composition.close()
    const secondClose = composition.close()
    expect(secondClose).toBe(firstClose)
    let closed = false
    const closing = firstClose.then(() => {
      closed = true
    })
    // Give queued close continuations a turn without releasing the scan.
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(completedScans).toBe(1)
    expect(scans).toBe(2)

    release.resolve()
    await Promise.all([closing, secondClose])
    expect(closed).toBe(true)
    expect(completedScans).toBe(2)
    const readsAtClose = journal.reads
    expect(composition.close()).toBe(firstClose)
    await expect(composition.recover()).rejects.toThrow('PI_LEAD_COMPOSITION_CLOSED')
    await expect(composition.settleTerminalAccounting()).rejects.toThrow(
      'PI_LEAD_TERMINAL_SETTLEMENT_CLOSED'
    )
    await pause(12 * fastInterval)
    expect(scans).toBe(2)
    expect(completedScans).toBe(2)
    expect(journal.reads).toBe(readsAtClose)
    expect(ledger.settles).toBe(0)
  } finally {
    clearTimeout(watchdog)
    release.resolve()
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

for (const failFirstScan of [false, true]) {
  test(`close drains both public recoveries before store teardown (scan failure: ${failFirstScan})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-lead-public-recover-close-'))
    const entered = Promise.withResolvers()
    const releases = [Promise.withResolvers(), Promise.withResolvers()]
    const scanError = new Error('PUBLIC_RECOVERY_SCAN_FAILED')
    const journal = journalReadCounter()
    let scans = 0
    let adapterCloses = 0
    let storeCloses = 0
    let composition
    let recoveries = []
    let closing
    let watchdog
    try {
      composition = await createNodePiDurableLeadComposition(
        baseOptions(directory, {
          periodicRecoveryIntervalMs: 60_000,
          onAdapterReady: journal.attach,
          childProgress: {
            scan: async (adapter) => {
              const index = ++scans - 2
              if (index >= 0) {
                if (index === 1) entered.resolve()
                await releases[index].promise
              }
              adapter.journal.list()
              if (index === 0 && failFirstScan) throw scanError
            },
          },
        })
      )
      const closeAdapter = composition.adapter.close.bind(composition.adapter)
      composition.adapter.close = () => {
        adapterCloses += 1
        return closeAdapter()
      }
      const closeStore = composition.adapter.journal.close.bind(composition.adapter.journal)
      composition.adapter.journal.close = () => {
        storeCloses += 1
        closeStore()
      }
      recoveries = [composition.recover(), composition.recover()].map((recovery) =>
        recovery.then(
          () => undefined,
          (error) => error
        )
      )
      await Promise.race([
        entered.promise,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('PUBLIC_RECOVERIES_NOT_ENTERED')), 1000)
        }),
      ])
      clearTimeout(watchdog)
      closing = composition.close()
      const concurrent = composition.close()
      let closed = false
      const completion = closing.then(() => {
        closed = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(concurrent).toBe(closing)
      expect(adapterCloses).toBe(0)
      expect(storeCloses).toBe(0)
      releases[0].resolve()
      expect(await recoveries[0]).toBe(failFirstScan ? scanError : undefined)
      await new Promise((resolve) => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(storeCloses).toBe(0)
      releases[1].resolve()
      expect(await recoveries[1]).toBeUndefined()
      await Promise.all([completion, concurrent])
      expect(closed).toBe(true)
      expect(adapterCloses).toBe(1)
      expect(storeCloses).toBe(1)
      const readsAtClose = journal.reads
      expect(composition.close()).toBe(closing)
      await expect(composition.recover()).rejects.toThrow('PI_LEAD_COMPOSITION_CLOSED')
      await expect(composition.settleTerminalAccounting()).rejects.toThrow(
        'PI_LEAD_TERMINAL_SETTLEMENT_CLOSED'
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(scans).toBe(3)
      expect(journal.reads).toBe(readsAtClose)
    } finally {
      clearTimeout(watchdog)
      releases.forEach((release) => release.resolve())
      await Promise.all(recoveries)
      await closing
      await composition?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
}

test('close bounds the drain so a wedged recovery cannot wedge process teardown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-bounded-drain-'))
  let hang = false
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let composition
  const ledger = fakeLedger()
  const journal = journalReadCounter()
  try {
    composition = await createNodePiDurableLeadComposition(
      baseOptions(directory, {
        drainTimeoutMs: 150,
        ledger,
        onAdapterReady: journal.attach,
        childProgress: {
          scan: async () => {
            if (hang) await gate
          },
        },
      })
    )
    hang = true
    // An accepted recovery that never settles.
    const recovery = composition.recover()
    const outcome = recovery.then(
      () => undefined,
      (error) => error
    )
    const closing = composition.close()
    // The close must complete on its own instead of waiting for the wedged recovery forever.
    await closing
    expect(composition.drainIncomplete).toBe(true)
    await expect(composition.closeForSameVersionUpgrade()).rejects.toThrow(
      'PI_LEAD_UPGRADE_DRAIN_INCOMPLETE'
    )
    await expect(composition.recover()).rejects.toThrow('PI_LEAD_COMPOSITION_CLOSED')
    const database = composition.admission.options.database
    const prepare = database.prepare.bind(database)
    let lateStoreReads = 0
    database.prepare = (...args) => {
      lateStoreReads += 1
      return prepare(...args)
    }
    const readsAtClose = journal.reads
    // Resume the accepted callback only after teardown timed out and closed its stores.
    hang = false
    release()
    expect((await outcome)?.message).toBe('PI_LEAD_TERMINAL_SETTLEMENT_CLOSED')
    await pause(12 * fastInterval)
    expect(lateStoreReads).toBe(0)
    expect(journal.reads).toBe(readsAtClose)
    expect(ledger.settles).toBe(0)
  } finally {
    hang = false
    release?.()
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('a completed drain reports no incomplete teardown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-complete-drain-'))
  let composition
  try {
    composition = await createNodePiDurableLeadComposition(
      baseOptions(directory, { drainTimeoutMs: 5_000 })
    )
    await composition.recover()
    await composition.close()
    expect(composition.drainIncomplete).toBe(false)
  } finally {
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
