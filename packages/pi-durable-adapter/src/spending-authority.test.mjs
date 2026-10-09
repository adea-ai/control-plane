import { expect, test } from 'bun:test'
import { createPiRecordedSpendingAuthority } from './spending-authority.ts'
import { createPiDurableUsageAuthority } from './usage-authority.ts'
import { withUsageAuthorityContext, at, ids } from './usage-authority.fixture.mjs'

function recordedFixture(authority, priceSnapshot, ledger) {
  const plan = authority.request.executionPlan
  const selected = {
    ...authority.admission.selection,
    workspaceId: plan.correlation.workspaceId,
    credentialRef: 'credential:one',
    provider: priceSnapshot.provider,
    providerModel: priceSnapshot.model,
    fundingSource: priceSnapshot.fundingSource,
  }
  const decision = {
    executionPlanId: plan.executionPlanId,
    executionPlanDigest: plan.contentDigest,
    ...authority.admission.selection,
    price: priceSnapshot,
    grant: {
      schemaVersion: 1,
      authorizationId: 'model-spend:recorded',
      evidenceRef: 'decision:one',
      workspaceId: selected.workspaceId,
      ...ids,
      deploymentId: priceSnapshot.deploymentId,
      credentialRef: selected.credentialRef,
      principalRef: authority.admission.authority.principalRef,
      alias: 'reasoning.standard',
      policySnapshotDigest: plan.policySnapshot.digest,
      currency: 'USD',
      fundingSource: priceSnapshot.fundingSource,
      maximumMicrounits: 1000,
      maximumTokens: 100,
      issuedAt: at,
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
  }
  const state = { decision, selected, revoked: false, now: at, reads: 0 }
  const ports = createPiRecordedSpendingAuthority({
    ledger,
    alias: 'reasoning.standard',
    now: () => state.now,
    readRecordedDecision: async () => {
      state.reads++
      if (state.revoked) throw new Error('RECORDED_DECISION_REVOKED')
      return state.decision
    },
    resolveSelection: async () => state.selected,
  })
  return { state, ports, bridge: createPiDurableUsageAuthority({ ledger, ...ports }) }
}

test('canonical recorded decision gates a real SQLite ledger hold and exact settlement', async () => {
  await withUsageAuthorityContext(async ({ authority, priceSnapshot, ledger, workspaceId }) => {
    const { bridge, state } = recordedFixture(authority, priceSnapshot, ledger)
    const key = 'pi-turn:recorded:pi-generation:2'
    const allowance = await bridge.authorizeInference(authority, key)
    expect(allowance.maximumInputTokens).toBe(64)
    expect(allowance.maxOutputTokens).toBe(32)
    await allowance.assertActive()
    expect(state.reads).toBe(5)
    const receipt = await bridge.settleUsage(authority, key, {
      inputTokens: 20,
      outputTokens: 10,
      durationMs: 3,
    })
    expect(receipt.accounting.chargedMicrounits).toBe(40)
    expect(
      (await ledger.entries(workspaceId, ids.executionId)).filter(
        (entry) => entry.kind === 'model_reservation'
      )
    ).toHaveLength(1)
  })
})

test('revocation, stale evidence and expired authority block the final send assertion', async () => {
  await withUsageAuthorityContext(async ({ authority, priceSnapshot, ledger }) => {
    const { bridge, state } = recordedFixture(authority, priceSnapshot, ledger)
    const allowance = await bridge.authorizeInference(authority, 'pi-turn:one:pi-generation:2')
    state.revoked = true
    await expect(allowance.assertActive()).rejects.toThrow('RECORDED_DECISION_REVOKED')
    state.revoked = false
    state.decision.grant.evidenceRef = 'decision:replacement'
    await expect(allowance.assertActive()).rejects.toThrow('PI_RECORDED_MODEL_SPENDING_DENIED')
    state.decision.grant.evidenceRef = 'decision:one'
    state.now = '2027-01-01T00:00:00.000Z'
    await expect(allowance.assertActive()).rejects.toThrow('PI_RECORDED_MODEL_SPENDING_DENIED')
  })
})

test('plan, credential, provider, selection, policy and principal mismatches fail before ledger dispatch', async () => {
  await withUsageAuthorityContext(async ({ authority, priceSnapshot, ledger, workspaceId }) => {
    const mutations = [
      (state) => {
        state.decision.executionPlanDigest = `sha256:${'d'.repeat(64)}`
      },
      (state) => {
        state.decision.selectionRevision++
      },
      (state) => {
        state.selected.selectionRevision++
      },
      (state) => {
        state.selected.credentialRef = 'credential:other'
      },
      (state) => {
        state.selected.provider = 'other-provider'
      },
      (state) => {
        state.selected.providerModel = 'other-model'
      },
      (state) => {
        state.selected.fundingSource = 'external_subscription'
      },
      (state) => {
        state.decision.grant.policySnapshotDigest = `sha256:${'d'.repeat(64)}`
      },
      (state) => {
        state.decision.grant.principalRef = 'principal:other'
      },
      (state) => {
        state.decision.grant.alias = 'alias:other'
      },
      (state) => {
        state.decision.grant.deploymentId = 'other-deployment'
      },
      (state) => {
        state.decision.grant.maximumTokens = 99
      },
      (state) => {
        state.decision.grant.maximumMicrounits = 999
      },
    ]
    for (const mutate of mutations) {
      const { bridge, state } = recordedFixture(authority, structuredClone(priceSnapshot), ledger)
      mutate(state)
      await expect(
        bridge.authorizeInference(authority, 'pi-turn:one:pi-generation:2')
      ).rejects.toThrow('PI_RECORDED_MODEL_SPENDING_DENIED')
    }
    expect(
      (await ledger.entries(workspaceId, ids.executionId)).filter(
        (entry) => entry.kind === 'model_reservation'
      )
    ).toHaveLength(0)
  })
})

test('actual persistent attempt allocation must match the immutable authority and recorded spending ceiling', async () => {
  await withUsageAuthorityContext(async ({ authority, priceSnapshot, ledger }) => {
    const { bridge } = recordedFixture(authority, priceSnapshot, ledger)
    await expect(
      bridge.authorizeInference(
        {
          ...authority,
          request: {
            ...authority.request,
            attemptBudget: { ...authority.request.attemptBudget, maximumTokens: 99 },
          },
        },
        'pi-turn:one:pi-generation:2'
      )
    ).rejects.toThrow('PI_RECORDED_MODEL_SPENDING_DENIED')
  })
})

test('malformed or unsupported funding evidence cannot bypass the canonical grant schema', async () => {
  await withUsageAuthorityContext(async ({ authority, priceSnapshot, ledger }) => {
    const { bridge, state } = recordedFixture(authority, priceSnapshot, ledger)
    state.decision.grant.schemaVersion = 999
    await expect(
      bridge.authorizeInference(authority, 'pi-turn:one:pi-generation:2')
    ).rejects.toThrow()
    state.decision.grant.schemaVersion = 1
    state.decision.grant.fundingSource = 'invented_funding'
    await expect(
      bridge.authorizeInference(authority, 'pi-turn:one:pi-generation:2')
    ).rejects.toThrow()
  })
})
