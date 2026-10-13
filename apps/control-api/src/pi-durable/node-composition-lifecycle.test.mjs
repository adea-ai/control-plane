import { test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodePiDurableLeadComposition } from './node-composition.ts'

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
