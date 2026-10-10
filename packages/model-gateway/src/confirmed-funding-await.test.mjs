import { expect, test } from 'bun:test'
import { createModelFundingPreparationService } from './funding-preparation.ts'
import { createExecutionBoundModelSelectionService } from './execution-selection.ts'
import { at, expiry, binding, view } from './funding-preparation-fixtures.mjs'
import { selection as selected } from './selection-fixtures.mjs'

// Deterministic host-port fault injection, separate from actual candidate HTTP proof.
async function fixture() {
  let retained,
    time = at,
    actor = true,
    device = true
  const state = { credentialCallbacks: 0, operations: 0, selectionReads: 0 }
  let onSelection = async () => {},
    onCredential = async () => {},
    currentView = structuredClone(view)
  const preparation = createModelFundingPreparationService({
    executionAuthority: {
      assertCurrent: async () => {
        if (!actor || !device) throw new Error('private-host-revocation')
      },
    },
    confirmations: {
      getByAttempt: async () => retained,
      putIfAbsent: async (record) => {
        retained ??= structuredClone(record)
        return retained
      },
    },
    readFunding: async () => structuredClone(currentView),
    now: () => time,
  })
  const selection = {
    ...selected,
    workspaceId: binding.workspaceId,
    selectionRef: binding.selectionRef,
    selectionRevision: binding.selectionRevision,
  }
  const facade = createExecutionBoundModelSelectionService({
    binding,
    currentExecutionAuthority: preparation.confirmedExecutionAuthority,
    selections: {
      resolveSelection: async () => {
        state.selectionReads++
        await onSelection()
        return structuredClone(selection)
      },
      assertReady: async () => {},
      withCredential: async (_selection, _authority, use) => {
        state.credentialCallbacks++
        await onCredential()
        return use('synthetic-fixture-only')
      },
    },
  })
  const prepared = await preparation.prepareFunding(binding, expiry)
  return {
    facade,
    preparation,
    selection,
    prepared,
    state,
    mutate(fault) {
      if (fault === 'funding-expiry') time = '2026-10-08T12:05:00.000Z'
      else if (fault === 'actor-revoked') actor = false
      else if (fault === 'device-revoked') device = false
      else
        currentView = { ...currentView, fundingOwner: { ...currentView.fundingOwner, revision: 2 } }
    },
    onSelection: (use) => {
      onSelection = use
    },
    onCredential: (use) => {
      onCredential = use
    },
  }
}

for (const fault of ['funding-expiry', 'actor-revoked', 'device-revoked', 'payer-revision']) {
  test(`same confirmed facade denies ${fault} across selection and credential awaits`, async () => {
    const f = await fixture()
    const pin = {
      workspaceId: binding.workspaceId,
      selectionRef: binding.selectionRef,
      selectionRevision: binding.selectionRevision,
    }
    expect(await f.facade.resolveSelection(pin)).toEqual(f.selection)
    f.onCredential(async () => {
      await Promise.resolve()
      f.mutate(fault)
    })
    await expect(
      f.facade.withCredential(
        f.selection,
        {
          requestId: binding.requestId,
          principalRef: binding.leasePrincipalRef,
          policySnapshot: { digest: binding.policySnapshotDigest },
        },
        async () => {
          f.state.operations++
          return { sent: true }
        }
      )
    ).rejects.toThrow('PROVIDER_POLICY_DENIED')
    expect(f.state.credentialCallbacks).toBe(1)
    expect(f.state.operations).toBe(0)
    await expect(f.facade.resolveSelection(pin)).rejects.toThrow('PROVIDER_POLICY_DENIED')
    await expect(f.preparation.prepareFunding(binding, expiry)).rejects.toThrow(
      'FUNDING_CONFIRMATION_STALE'
    )
    expect(f.prepared.funding.fundingOwner.revision).toBe(1)
    const g = await fixture()
    g.onSelection(async () => {
      await Promise.resolve()
      g.mutate(fault)
    })
    await expect(g.facade.resolveSelection(pin)).rejects.toThrow('PROVIDER_POLICY_DENIED')
    expect(g.state.credentialCallbacks).toBe(0)
    expect(g.state.operations).toBe(0)
  })
}
