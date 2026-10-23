import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryModelSelectionRepository } from '@control-plane/model-gateway'
import { createProductionPiLeadComposition } from './production-model-composition.ts'

const at = '2026-10-08T09:00:00.000Z'
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}

/** Deterministic in-memory collaborators only: no vault secret, provider, network or database service. */
test('the production lead composition exposes both terminal settlement functions and leaves the child pair as configured', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-terminal-surface-'))
  const fn = async () => {}
  let composition
  try {
    composition = await createProductionPiLeadComposition({
      directory: join(parent, 'lead'),
      fundingDirectory: parent,
      admission: {
        scopeAuthority: {},
        admissionPrincipalId: 'svc_pi-admission',
        now: () => at,
      },
      product: { readCurrent: fn },
      profiles: { resolveImmutable: fn },
      publicationAuthority: fn,
      releaseExpired: fn,
      reconcileInference: fn,
      modelConnections: {
        repository: new InMemoryModelSelectionRepository(),
        vault: { metadata: fn },
        currentAccountAuthority: { readCurrent: fn },
        now: () => at,
      },
      readiness: {
        target,
        gateway: { assertRequestReady: fn },
        buildRequest: fn,
      },
      ledger: {},
      leasePrincipalRef: 'svc_lease',
      modelAlias: 'lead',
    })

    // The lead pair is on the actual returned surface.
    expect(typeof composition.settleTerminalAccounting).toBe('function')
    expect(composition.terminalSettlementBlocked).toBe(false)
    // The bounded drain outcome is on the same surface.
    expect(composition.drainIncomplete).toBe(false)

    // An empty lead settles nothing, pending nothing and leaves the store unblocked.
    expect(await composition.settleTerminalAccounting()).toEqual({
      settled: 0,
      pending: 0,
      unbound: 0,
    })
    expect(composition.terminalSettlementBlocked).toBe(false)

    // A failing settlement pass blocks the store, observed through the returned getter. The journal
    // read is forced to fail for one pass and then restored, so the blocked state is not hardcoded.
    const journal = composition.adapter.journal
    const listRecords = journal.list
    journal.list = () => {
      throw new Error('forced journal failure')
    }
    try {
      await expect(composition.settleTerminalAccounting()).rejects.toThrow('forced journal failure')
      expect(composition.terminalSettlementBlocked).toBe(true)
    } finally {
      journal.list = listRecords
    }
    expect(await composition.settleTerminalAccounting()).toEqual({
      settled: 0,
      pending: 0,
      unbound: 0,
    })
    expect(composition.terminalSettlementBlocked).toBe(false)

    // Without child configuration the child pair is not exposed: unchanged from main.
    expect('settleChildTerminalAccounting' in composition).toBe(false)
    expect(composition.childTerminalSettlementBlocked).toBe(false)
  } finally {
    await composition?.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

/** The bounded close drain reports an incomplete teardown on the host-facing surface. */
test('the production lead composition exposes the drain outcome and a clean close leaves it unset', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-drain-surface-'))
  const fn = async () => {}
  let composition
  try {
    composition = await createProductionPiLeadComposition({
      directory: join(parent, 'lead'),
      fundingDirectory: parent,
      admission: {
        scopeAuthority: {},
        admissionPrincipalId: 'svc_pi-admission',
        now: () => at,
      },
      product: { readCurrent: fn },
      profiles: { resolveImmutable: fn },
      publicationAuthority: fn,
      releaseExpired: fn,
      reconcileInference: fn,
      modelConnections: {
        repository: new InMemoryModelSelectionRepository(),
        vault: { metadata: fn },
        currentAccountAuthority: { readCurrent: fn },
        now: () => at,
      },
      readiness: {
        target,
        gateway: { assertRequestReady: fn },
        buildRequest: fn,
      },
      ledger: {},
      leasePrincipalRef: 'svc_lease',
      modelAlias: 'lead',
    })

    // The host can read the drain outcome before and after the close.
    expect(composition.drainIncomplete).toBe(false)
    await composition.close()
    // A clean drain leaves it unset: the teardown waited for every accepted recovery.
    expect(composition.drainIncomplete).toBe(false)
  } finally {
    await composition?.close()
    rmSync(parent, { recursive: true, force: true })
  }
})
