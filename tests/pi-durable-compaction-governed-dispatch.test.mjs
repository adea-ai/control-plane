import { expect, test } from 'bun:test'
import { rm, stat } from 'node:fs/promises'
import {
  compactNativeSession,
  nativeSessionPath,
} from '../packages/pi-durable-adapter/src/native-session-compaction.fixture.mjs'
import {
  childIds,
  childObjective,
  childSettlementFor,
  createGovernedDispatchHooks,
  governedDispatchChildren,
  readChildCostState,
  readPublicationRecords,
  settleLeadTerminal,
} from './pi-durable-compaction-governed-dispatch.fixture.mjs'
import {
  openDurableChildStores,
  readDurableChildState,
  runChildSettlementProcess,
} from './pi-durable-child-settlement-process.fixture.mjs'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

const leadInteractionId = 'int_01JABCDEF0123456789ABCDEFG'
const leadQuestion = 'Synthetic actual factory question'
const summary = 'COMPACTED-LEAD-SUMMARY: the lead task and its child limits are preserved.'

function eventStream(events) {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}
const usage = {
  input_tokens: 5,
  output_tokens: 3,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
}
function completed(id, item) {
  return {
    type: 'response.completed',
    response: { id, status: 'completed', output: [item], usage },
  }
}
function textResponse(text, responseId) {
  const item = {
    type: 'message',
    id: `msg_${responseId}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return eventStream([
    { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    completed(responseId, item),
  ])
}
function delegateCallResponse() {
  const item = {
    id: 'fc_governed_dispatch',
    type: 'function_call',
    status: 'completed',
    name: 'delegate_child',
    call_id: 'call_governed_dispatch',
    arguments: JSON.stringify({ objective: childObjective }),
  }
  return eventStream([
    { type: 'response.created', response: { id: 'resp_delegate', status: 'in_progress' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    completed('resp_delegate', item),
  ])
}

/** Lead sends are told apart from the child's by the governed tool only the lead carries. */
function scriptedProvider(sent, behavior = {}) {
  return async ({ body }) => {
    const input = body.input
    const isChild =
      input.length === 1 &&
      input[0].content?.length === 1 &&
      input[0].content[0].text === childObjective
    if (isChild) {
      sent.child.push(body)
      if (behavior.childFails) return new Response('upstream failure', { status: 500 })
      return textResponse('Bounded child evidence.', 'resp_child')
    }
    sent.lead.push(body)
    if (sent.lead.length === 2) return delegateCallResponse()
    return textResponse(
      sent.lead.length === 1 ? 'Lead turn one answer.' : 'Child delegation receipt received.',
      `resp_lead_${sent.lead.length}`
    )
  }
}

async function waitFor(predicate, label) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_WAIT_TIMEOUT:${label}`)
}

async function createHost(options = {}, behavior = {}) {
  const hooks = createGovernedDispatchHooks()
  const sent = { lead: [], child: [] }
  const host = await createProductionFactoryFixture({
    childrenFactory: governedDispatchChildren(hooks),
    physicalResponder: scriptedProvider(sent, behavior),
    ...options,
  })
  hooks.host = host
  const selections = host.composition.modelConnectionService.selections
  const defaults = await selections.getDefaults(host.workspaceId)
  await selections.setDefaults(defaults.revision, {
    ...defaults,
    revision: defaults.revision + 1,
    child: {
      connectionRef: host.models.refs.connectionRef,
      providerModel: host.models.refs.providerModel,
    },
  })
  return { host, hooks, sent }
}

/** Lead turn one completes, then the session waits for human input, as a long-lived lead does. */
async function runLeadFirstTurn(host, hooks) {
  const intentId = host.setIntent()
  hooks.intentId = intentId
  const service = host.composition.piDurableLeadService
  const prepared = (
    await service.prepare(host.command('pi-durable.lead.prepare', { intentId }), host.principal)
  ).data
  const dispatch = (
    await service.dispatch(
      host.command('pi-durable.lead.dispatch', {
        intentId,
        preparationRef: prepared.preparationRef,
      }),
      host.principal
    )
  ).data
  host.state.parentExecutionId = dispatch.executionId
  const adapter = host.composition.adapter
  await adapter.drain()
  const row = adapter.journal
    .list()
    .find((candidate) => candidate.admission.request.executionId === dispatch.executionId)
  const handle = row.admission.handle
  expect((await adapter.status(handle)).state).toBe('completed')
  await adapter.awaitInput(handle, leadInteractionId)
  expect((await adapter.status(handle)).state).toBe('awaiting_input')
  return { intentId, dispatch, handle }
}

const childExecutionId = childIds.executionId
const childAttemptId = childIds.attemptId

const kinds = (entries) => entries.map((entry) => entry.kind)
const childOf = (adapter) =>
  adapter.journal
    .list()
    .find((candidate) => candidate.admission.request.executionId === childExecutionId)
/** The complete durable publication rows of the parent's inbox (see `readPublicationRecords`). */
const publicationsOf = (hooks) =>
  readPublicationRecords(hooks.persistence, hooks.host.state.parentExecutionId)

/** Exactly one terminal publication for the child, keyed and carried by the child's delegation. */
function expectOneTerminalPublication(records, parentExecutionId) {
  const terminal = records.filter((record) => record.value.event.type === 'delegation.completed')
  expect(terminal).toHaveLength(1)
  expect(terminal[0].revision).toBe(1)
  expect(terminal[0].value.idempotencyKey.startsWith(`delegation:${childIds.delegationId}:`)).toBe(
    true
  )
  expect(terminal[0].value.event).toMatchObject({
    delegationId: childIds.delegationId,
    parentExecutionId,
  })
  return terminal[0]
}

/** Compacts the lead's native session while the whole production composition is closed. */
async function compactAcrossReopen(host, handle) {
  let compaction
  await host.reopenComposition(async () => {
    compaction = await compactNativeSession({
      runtimeDirectory: host.directory,
      externalSessionId: handle.externalSessionId,
      provider: host.selection.provider,
      modelId: host.selection.providerModel,
      summary,
    })
  })
  return compaction
}

const submitSecondTurn = (adapter, handle) =>
  adapter.submitInput(handle, {
    interactionId: leadInteractionId,
    idempotencyKey: 'lead-turn-two',
    text: 'Delegate the bounded objective.',
  })

test('governed child dispatch after native compaction and reopen runs once with current grants and retained usage', async () => {
  const { host, hooks, sent } = await createHost()
  try {
    const { dispatch, handle } = await runLeadFirstTurn(host, hooks)
    expect(sent.lead).toHaveLength(1)
    const mappedBefore = structuredClone(host.composition.adapter.journal.get(handle.handleId))

    const compaction = await compactAcrossReopen(host, handle)
    // The compacted file is the one the journal maps this execution/attempt to, and it keeps its
    // summary when reopened.
    expect(compaction).toMatchObject({
      outcome: 'completed',
      summaries: 1,
      summarizerCalls: 1,
      reopened: { summaries: 1, conversationId: compaction.conversationId },
    })
    expect(compaction.path).toBe(nativeSessionPath(host.directory, handle.externalSessionId))
    expect((await stat(compaction.path)).size).toBeGreaterThan(0)

    const adapter = host.composition.adapter
    expect(adapter.journal.get(handle.handleId).admission).toEqual(mappedBefore.admission)
    expect((await adapter.status(handle)).state).toBe('awaiting_input')
    // Nothing is dispatched, funded or sent merely by reopening a compacted session.
    expect(hooks.evidence.childStarts).toHaveLength(0)
    expect(hooks.evidence.reservations).toHaveLength(0)
    expect(sent.lead).toHaveLength(1)
    const productReadsAfterReopen = host.state.productReads

    await submitSecondTurn(adapter, handle)
    await adapter.drain()
    await waitFor(async () => {
      const row = childOf(adapter)
      return row && (await adapter.status(row.admission.handle)).state === 'completed'
    }, 'child completed')

    // The lead's second request replaces the replayed first turn with the native summary. The
    // original question is gone; only the summary, the native recent tail (the lead's last answer)
    // and the new input remain.
    const firstRequest = JSON.stringify(sent.lead[0].input)
    const compactedRequest = JSON.stringify(sent.lead[1].input)
    expect(firstRequest).toContain(leadQuestion)
    expect(firstRequest).not.toContain('COMPACTED-LEAD-SUMMARY')
    expect(compactedRequest).toContain('COMPACTED-LEAD-SUMMARY')
    expect(compactedRequest).not.toContain(leadQuestion)
    expect(
      sent.lead[1].input.map((item) =>
        item.content
          .map((part) => part.text ?? '')
          .join('')
          .replace(/\s+/g, ' ')
      )
    ).toEqual([
      expect.stringContaining('COMPACTED-LEAD-SUMMARY'),
      'Lead turn one answer.',
      'Delegate the bounded objective.',
    ])
    // Lead: first turn, delegating turn and the turn that reads the child receipt. Child: one send.
    expect(sent.lead).toHaveLength(3)
    expect(sent.child).toHaveLength(1)
    expect(host.state.physicalSends).toBe(4)

    // Current grants were read again, after the reopen, for this dispatch: product, policy and the
    // production child authority reader behind the bridge.
    expect(host.state.productReads).toBeGreaterThan(productReadsAfterReopen)
    expect(hooks.evidence.policyDecisions).toBe(1)
    expect(hooks.evidence.executorCalls).toBe(1)
    expect(hooks.evidence.bridgeAuthorityReads).toBeGreaterThan(0)

    // Exactly one admitted child, one runtime start, one budget reservation.
    const call = await hooks.toolCalls.get(childIds.toolCallId)
    expect(call.status).toBe('succeeded')
    expect(call.result.output).toMatchObject({
      delegationId: childIds.delegationId,
      childExecutionId,
      childAttemptId,
    })
    expect(await hooks.delegationRecords.listByParent(dispatch.executionId)).toHaveLength(1)
    expect(hooks.evidence.childStarts).toHaveLength(1)
    expect(hooks.evidence.childStarts[0]).toMatchObject({
      executionId: childExecutionId,
      attemptId: childAttemptId,
      idempotencyKey: `delegation:${childIds.delegationId}:attempt:${childAttemptId}`,
    })
    expect(hooks.evidence.reservations).toHaveLength(1)
    expect(hooks.evidence.reservations[0]).toMatchObject({
      executionId: childExecutionId,
      attemptId: childAttemptId,
      reservationKey: `runtime-attempt:${childAttemptId}`,
    })
    expect(hooks.evidence.fundingWrites).toEqual([childAttemptId])
    const childRow = childOf(adapter)
    expect(childRow.admission.handle.externalSessionId).toBe(call.result.output.externalSessionId)
    expect(childRow.admission.handle.externalSessionId).not.toBe(handle.externalSessionId)
    expect((await adapter.status(childRow.admission.handle)).result).toMatchObject({
      outcome: 'completed',
      output: { text: 'Bounded child evidence.' },
    })

    // Funding comes from the parent's stated allowance, not from the lead's own attempt.
    const parentEntries = await host.ledger.entries(host.workspaceId, dispatch.executionId)
    const childFunding = parentEntries.filter(
      (entry) => entry.reservationKey === `child:${childExecutionId}`
    )
    expect(childFunding).toHaveLength(1)
    const childEntries = await host.ledger.entries(host.workspaceId, childExecutionId)
    expect(childEntries[0]).toMatchObject({ kind: 'credit' })
    expect(childEntries[0].quantity.value).toBe(childFunding[0].quantity.value)
    expect(childFunding[0].quantity.value).toBe(
      host.parentPlanForIntent(hooks.intentId).constraints.limits.childExecutions.budgetAllowance
        .maximumMicrounits
    )

    // Retained usage outcome for the child's one send: reserved, charged exactly, released.
    expect(kinds(childEntries)).toEqual([
      'credit',
      'reservation',
      'model_reservation',
      'model_usage',
      'model_release',
    ])
    const [, attemptReservation, , usageEntry] = childEntries
    expect(attemptReservation.reservationKey).toBe(`runtime-attempt:${childAttemptId}`)
    expect(usageEntry).toMatchObject({ attemptId: childAttemptId, costExact: true })
    expect(usageEntry.costMicrounits).toBeGreaterThan(0)

    // The scan publishes the terminal child evidence once; repeating it changes nothing.
    await hooks.scanner.scan(adapter)
    const published = await publicationsOf(hooks)
    expectOneTerminalPublication(published, hooks.host.state.parentExecutionId)
    await hooks.scanner.scan(adapter)
    expect(await publicationsOf(hooks)).toEqual(published)

    // A further restart replays nothing: no second start, send, reservation or usage entry.
    await host.reopenComposition()
    const reopened = host.composition.adapter
    expect((await reopened.status(childRow.admission.handle)).state).toBe('completed')
    expect(hooks.evidence.childStarts).toHaveLength(1)
    expect(hooks.evidence.reservations).toHaveLength(1)
    expect(host.state.physicalSends).toBe(4)
    expect(await host.ledger.entries(host.workspaceId, childExecutionId)).toEqual(childEntries)
    expect(await publicationsOf(hooks)).toEqual(published)
    expect(await hooks.delegationRecords.listByParent(dispatch.executionId)).toHaveLength(1)
  } finally {
    await host.close()
  }
}, 90000)

test('a grant revoked after the compaction reopen starts no child and funds nothing', async () => {
  const { host, hooks, sent } = await createHost()
  try {
    const { dispatch, handle } = await runLeadFirstTurn(host, hooks)
    await compactAcrossReopen(host, handle)
    // The governed tool was allowed by policy; the workspace grant is withdrawn before the child is
    // allocated, so current authority has to refuse it.
    hooks.afterPolicyAllow = () => {
      host.state.revoked = true
    }
    const adapter = host.composition.adapter
    await submitSecondTurn(adapter, handle)
    await adapter.drain()

    expect(hooks.evidence.policyDecisions).toBe(1)
    expect((await hooks.toolCalls.get(childIds.toolCallId)).status).toBe('reconciliation_required')
    expect(hooks.evidence.executorCalls).toBe(0)
    expect(hooks.evidence.childStarts).toHaveLength(0)
    expect(hooks.evidence.reservations).toHaveLength(0)
    expect(hooks.evidence.fundingWrites).toHaveLength(0)
    expect(await hooks.delegationRecords.listByParent(dispatch.executionId)).toHaveLength(0)
    expect(childOf(adapter)).toBeUndefined()
    expect(sent.child).toHaveLength(0)
    expect(sent.lead).toHaveLength(2)
    expect(await publicationsOf(hooks)).toEqual([])
    // The lead stays unsettled for reconciliation rather than reporting a result.
    expect((await adapter.status(handle)).state).toBe('unknown')
    const parentEntries = await host.ledger.entries(host.workspaceId, dispatch.executionId)
    expect(parentEntries.some((entry) => entry.reservationKey?.startsWith('child:'))).toBe(false)
  } finally {
    await host.close()
  }
}, 60000)

/** Lead first turn, compaction across a reopen, then the delegating turn until the child completes. */
async function dispatchChildAfterCompaction(host, hooks, { waitForCompleted = true } = {}) {
  const { dispatch, handle } = await runLeadFirstTurn(host, hooks)
  await compactAcrossReopen(host, handle)
  const adapter = host.composition.adapter
  await submitSecondTurn(adapter, handle)
  await adapter.drain()
  await waitFor(async () => {
    const row = childOf(adapter)
    if (!row) return false
    const state = (await adapter.status(row.admission.handle)).state
    return waitForCompleted ? state === 'completed' : state !== 'running' && state !== 'starting'
  }, 'child terminal')
  return { dispatch, handle, adapter }
}

const rowsOf = async (host, dispatch) => ({
  parent: await host.ledger.entries(host.workspaceId, dispatch.executionId),
  child: await host.ledger.entries(host.workspaceId, childExecutionId),
})
const summaryOf = (host, executionId) => host.ledger.summary(host.workspaceId, executionId)
const stableSummary = (value) => JSON.stringify(value)

/** Everything one settled child leaves in the child's own ledger: funded, spent once, released. */
function expectSettledChildLedger(childEntries) {
  expect(kinds(childEntries)).toEqual([
    'credit',
    'reservation',
    'model_reservation',
    'model_usage',
    'model_release',
    'release',
    'settlement',
    'settlement',
  ])
  const [credit, , , usageEntry, , attemptRelease, attemptSettlement, budgetSettlement] =
    childEntries
  expect(usageEntry).toMatchObject({ costExact: true })
  const spent = usageEntry.costMicrounits
  expect(spent).toBeGreaterThan(0)
  // The attempt reservation held the whole funded balance: what was not spent is released, what was
  // spent is the settlement, and finalizing the budget settles the same amount again once.
  expect(attemptRelease.quantity.value).toBe(credit.quantity.value - spent)
  expect(attemptSettlement.quantity.value).toBe(spent)
  expect(budgetSettlement.quantity.value).toBe(spent)
  return spent
}

test('child settlement carries the parent allowance through actual usage to final settlement', async () => {
  const { host, hooks } = await createHost()
  try {
    const { dispatch, handle, adapter } = await dispatchChildAfterCompaction(host, hooks)
    const settlement = childSettlementFor(hooks)
    const reservationKey = `runtime-attempt:${childAttemptId}`

    // The proof so far: the child completed, but both attempt reservations are still open, and the
    // projection holds only the estimate and the reservation it was admitted with.
    await expect(
      host.ledger.assertRuntimeAttemptReleased(host.workspaceId, childExecutionId, childAttemptId)
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })
    await expect(
      host.ledger.assertRuntimeAttemptReleased(
        host.workspaceId,
        dispatch.executionId,
        handle.attemptId
      )
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })
    const admitted = (await readChildCostState(hooks)).outcome
    expect(admitted.costState).toBe('reserved')
    expect(admitted.estimated).toMatchObject({ currency: 'USD' })
    expect(admitted.reserved).toMatchObject({ reservationKey, executionId: childExecutionId })
    expect(admitted.reported).toBeUndefined()

    // Lead terminal settlement is the existing production class. It settles the lead's attempt and
    // leaves the child's completed record alone, as it has no lead budget bound to it.
    expect(await settleLeadTerminal(host)).toEqual({ settled: 1, pending: 0, unbound: 1 })
    await host.ledger.assertRuntimeAttemptReleased(
      host.workspaceId,
      dispatch.executionId,
      handle.attemptId
    )
    expect((await summaryOf(host, dispatch.executionId)).reservedMicrounits).toBeGreaterThan(0)

    expect(await settlement.settle()).toMatchObject({ state: 'settled' })

    // Allowance -> funding -> usage -> settlement, in the canonical ledger.
    const { parent, child } = await rowsOf(host, dispatch)
    const spent = expectSettledChildLedger(child)
    const allowance = host.parentPlanForIntent(hooks.intentId).constraints.limits.childExecutions
      .budgetAllowance.maximumMicrounits
    expect(child[0].quantity.value).toBe(allowance)
    const funding = parent.filter((entry) => entry.reservationKey === `child:${childExecutionId}`)
    expect(kinds(funding)).toEqual(['reservation', 'release', 'settlement'])
    expect(funding[0].quantity.value).toBe(allowance)
    expect(funding[1].quantity.value).toBe(allowance - spent)
    expect(funding[2].quantity.value).toBe(spent)

    // Conservation: the parent's spend is its own three sends plus the child's one, nothing is held,
    // and the child budget is settled.
    const leadSpent = parent
      .filter((entry) => entry.kind === 'model_usage')
      .reduce((total, entry) => total + entry.costMicrounits, 0)
    const parentSummary = await summaryOf(host, dispatch.executionId)
    expect(parentSummary).toMatchObject({
      spentMicrounits: leadSpent + spent,
      reservedMicrounits: 0,
      settled: false,
    })
    expect(parentSummary.spentMicrounits + parentSummary.availableMicrounits).toBe(
      parentSummary.maximumMicrounits
    )
    expect(await summaryOf(host, childExecutionId)).toMatchObject({
      spentMicrounits: spent,
      reservedMicrounits: 0,
      settled: true,
    })
    // Every reservation is released, so the parent can finalize and the retained model caches can go.
    await host.ledger.assertRuntimeAttemptReleased(
      host.workspaceId,
      childExecutionId,
      childAttemptId
    )
    await host.composition.collectTerminalModels()
    expect(
      await host.ledger.finalizeBudget({
        workspaceId: host.workspaceId,
        executionId: dispatch.executionId,
        source: { sourceId: 'parent-final', idempotencyKey: 'parent-final:finalize' },
      })
    ).toMatchObject({ settled: true, spentMicrounits: leadSpent + spent })

    // The cost state reached 'settled' from recorded evidence only, at the amount the ledger settled.
    const settled = await readChildCostState(hooks)
    expect(settled.outcome).toMatchObject({
      costState: 'settled',
      estimated: { currency: 'USD' },
      reserved: { reservationKey },
      reported: { accounting: { costExact: true, chargedMicrounits: spent } },
      reconciled: { result: 'within_reservation', reportedChargedMicrounits: spent },
      settled: { settledMicrounits: spent },
    })

    // Repeating every pass changes nothing: settlement, lead settlement, the scanner, and an
    // in-process composition reopen that re-runs the startup scan (persistence stays open).
    const before = {
      rows: await rowsOf(host, dispatch),
      parentSummary: stableSummary(await summaryOf(host, dispatch.executionId)),
      cost: stableSummary(await readChildCostState(hooks)),
    }
    await hooks.scanner.scan(adapter)
    const published = await publicationsOf(hooks)
    expectOneTerminalPublication(published, hooks.host.state.parentExecutionId)
    const repeat = async () => {
      expect(await settlement.settle()).toMatchObject({ state: 'settled' })
      expect(await settleLeadTerminal(host)).toEqual({ settled: 1, pending: 0, unbound: 1 })
      await hooks.scanner.scan(host.composition.adapter)
    }
    await repeat()
    await host.reopenComposition()
    await repeat()
    expect(await rowsOf(host, dispatch)).toEqual(before.rows)
    expect(stableSummary(await summaryOf(host, dispatch.executionId))).toBe(before.parentSummary)
    expect(stableSummary(await readChildCostState(hooks))).toBe(before.cost)
    expect(await publicationsOf(hooks)).toEqual(published)
    expect(hooks.evidence.childStarts).toHaveLength(1)
    expect(hooks.evidence.reservations).toHaveLength(1)
    expect(host.state.physicalSends).toBe(4)
  } finally {
    await host.close()
  }
}, 120000)

// Two recovery scopes are proven below and kept apart on purpose:
// - production composition: the real production-factory host (adapter, scanner, bridge, lead
//   settlement) is reopened in the same process while its persistence stays open.
// - standalone settlement process: only the child settlement driver runs, in separate OS processes
//   that open the on-disk stores. They have no composition, so they never scan, publish, start or
//   send; the test reads the publication rows back from disk to show they were not touched.
// In both, "unchanged" means the complete durable publication rows (storage id, revision, write
// time, idempotency key and whole event) are equal, not only the event types.
// An interrupted settlement leaves exactly the evidence recorded so far. The cost state never runs
// ahead of the ledger, a restart does not repeat a recorded step or republish the terminal event,
// and the resumed settlement ends in the same ledger as an uninterrupted one.
const interruptions = {
  reported: { cost: 'reported', attemptReleased: false, budgetSettled: false },
  'attempt-settled': { cost: 'reported', attemptReleased: true, budgetSettled: false },
  'budget-finalized': { cost: 'reported', attemptReleased: true, budgetSettled: true },
  reconciled: { cost: 'reconciled', attemptReleased: true, budgetSettled: true },
}

const openReservations = (host, executionId) =>
  host.repositories.usage.transaction(host.workspaceId, async (transaction) =>
    (await transaction.getBudget(executionId)).reservations
      .filter((reservation) => reservation.status === 'open')
      .map((reservation) => reservation.reservationKey)
  )
const finalizeParent = (host, dispatch, key) =>
  host.ledger.finalizeBudget({
    workspaceId: host.workspaceId,
    executionId: dispatch.executionId,
    source: { sourceId: key, idempotencyKey: `${key}:finalize` },
  })

for (const [step, expected] of Object.entries(interruptions)) {
  test(`production composition: settlement interrupted after ${step} reconciles across an in-process reopen`, async () => {
    const { host, hooks } = await createHost()
    try {
      const { dispatch, handle, adapter } = await dispatchChildAfterCompaction(host, hooks)
      // The lead settles first, so any reservation still open on the parent is the child's alone.
      expect(await settleLeadTerminal(host)).toEqual({ settled: 1, pending: 0, unbound: 1 })
      await host.ledger.assertRuntimeAttemptReleased(
        host.workspaceId,
        dispatch.executionId,
        handle.attemptId
      )
      // Terminal publication happens once, before any settlement is attempted.
      await hooks.scanner.scan(adapter)
      const published = await publicationsOf(hooks)
      expectOneTerminalPublication(published, hooks.host.state.parentExecutionId)
      const expectPublishedOnce = async () => {
        await hooks.scanner.scan(host.composition.adapter)
        expect(await publicationsOf(hooks)).toEqual(published)
      }

      hooks.settlementSeam = async (reached) => {
        if (reached === step) throw new Error(`SETTLEMENT_INTERRUPTED:${step}`)
      }
      await expect(childSettlementFor(hooks).settle()).rejects.toThrow(
        `SETTLEMENT_INTERRUPTED:${step}`
      )
      hooks.settlementSeam = undefined
      await expectPublishedOnce()

      const snapshotState = async () => ({
        rows: await rowsOf(host, dispatch),
        child: stableSummary(await summaryOf(host, childExecutionId)),
        parent: stableSummary(await summaryOf(host, dispatch.executionId)),
        cost: stableSummary(await readChildCostState(hooks)),
        publications: await publicationsOf(hooks),
      })
      const interrupted = await snapshotState()

      // Truthful partial state, from the ledger and the projection rather than from this test.
      expect((await readChildCostState(hooks)).outcome.costState).toBe(expected.cost)
      const release = host.ledger.assertRuntimeAttemptReleased(
        host.workspaceId,
        childExecutionId,
        childAttemptId
      )
      if (expected.attemptReleased) await release
      else await expect(release).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })
      expect((await summaryOf(host, childExecutionId)).settled).toBe(expected.budgetSettled)
      // With the lead already settled, the child's funding reservation alone is what holds the
      // parent open, until the child budget is finalized.
      if (expected.budgetSettled) {
        expect(await openReservations(host, dispatch.executionId)).toEqual([])
      } else {
        expect(await openReservations(host, dispatch.executionId)).toEqual([
          `child:${childExecutionId}`,
        ])
        await expect(finalizeParent(host, dispatch, 'parent-early')).rejects.toMatchObject({
          code: 'SETTLEMENT_INCOMPLETE',
        })
        expect(await snapshotState()).toEqual(interrupted)
      }

      // An in-process composition reopen (persistence stays open) changes nothing that was recorded,
      // and its startup scan and a further scan do not republish the terminal event.
      await host.reopenComposition()
      await expectPublishedOnce()
      expect(await snapshotState()).toEqual(interrupted)

      // The resumed settlement completes once; the ledger matches an uninterrupted run.
      expect(await childSettlementFor(hooks).settle()).toMatchObject({ state: 'settled' })
      const { parent, child } = await rowsOf(host, dispatch)
      const spent = expectSettledChildLedger(child)
      expect(
        parent
          .filter((entry) => entry.reservationKey === `child:${childExecutionId}`)
          .map((entry) => entry.kind)
      ).toEqual(['reservation', 'release', 'settlement'])
      expect((await readChildCostState(hooks)).outcome).toMatchObject({
        costState: 'settled',
        settled: { settledMicrounits: spent },
      })
      await expectPublishedOnce()
      const settled = await snapshotState()
      expect(await childSettlementFor(hooks).settle()).toMatchObject({ state: 'settled' })
      await expectPublishedOnce()
      expect(await snapshotState()).toEqual(settled)
      // Nothing is held any more, so the parent finalizes at lead plus child spend.
      expect(await openReservations(host, dispatch.executionId)).toEqual([])
      const leadSpent = parent
        .filter((entry) => entry.kind === 'model_usage')
        .reduce((total, entry) => total + entry.costMicrounits, 0)
      expect(await finalizeParent(host, dispatch, 'parent-final')).toMatchObject({
        settled: true,
        spentMicrounits: leadSpent + spent,
      })
      expect(hooks.evidence.childStarts).toHaveLength(1)
      expect(host.state.physicalSends).toBe(4)
    } finally {
      await host.close()
    }
  }, 150000)
}

// The same interruptions as a real crash: the host is closed completely (composition, persistence
// and every store), a separate process settles until it SIGKILLs itself right after the step, and a
// third and fourth process resume and repeat from the on-disk stores alone. Those processes have no
// provider transport, credentials or composition, so they cannot start, send or publish.
for (const [step, expected] of Object.entries(interruptions)) {
  test(`standalone settlement process: killed after ${step}, a new process resumes from the stores`, async () => {
    const { host, hooks } = await createHost()
    let directory
    try {
      const { dispatch, handle, adapter } = await dispatchChildAfterCompaction(host, hooks)
      expect(await settleLeadTerminal(host)).toEqual({ settled: 1, pending: 0, unbound: 1 })
      await hooks.scanner.scan(adapter)
      const published = await publicationsOf(hooks)
      expectOneTerminalPublication(published, hooks.host.state.parentExecutionId)
      const ids = {
        workspaceId: host.workspaceId,
        parentExecutionId: dispatch.executionId,
        at: hooks.at,
      }
      const sends = host.state.physicalSends
      directory = await host.detach()

      const readStores = async () => {
        const stores = await openDurableChildStores(directory, ids)
        try {
          return await readDurableChildState(stores)
        } finally {
          await stores.close()
        }
      }
      const closed = await readStores()
      expect(closed.publications).toEqual(published)
      expect(closed.cost.outcome.costState).toBe('reserved')

      // A process that dies mid-settlement, with no chance to clean up.
      const killed = await runChildSettlementProcess(directory, ids, { killAtStep: step })
      expect(killed.signal).toBe('SIGKILL')
      expect(killed.result).toBeUndefined()
      expect(killed.pid).not.toBe(process.pid)
      const crashed = await readStores()
      expect(crashed.cost.outcome.costState).toBe(expected.cost)
      expect(crashed.childSummary.settled).toBe(expected.budgetSettled)
      // The lead settled before the crash, so the parent's remaining hold is the child's funding alone.
      const funding = crashed.parentEntries.find(
        (entry) =>
          entry.reservationKey === `child:${childExecutionId}` && entry.kind === 'reservation'
      )
      expect(crashed.parentSummary.reservedMicrounits).toBe(
        expected.budgetSettled ? 0 : funding.quantity.value
      )
      expect(crashed.publications).toEqual(published)
      expect(crashed.childJournal).toEqual(closed.childJournal)
      expect(crashed.delegationCount).toBe(1)

      // A new process resumes from the stores and finishes the settlement.
      const resumed = await runChildSettlementProcess(directory, ids)
      expect(resumed.code).toBe(0)
      expect(new Set([process.pid, killed.pid, resumed.pid]).size).toBe(3)
      expect(resumed.result.settlement).toMatchObject({ state: 'settled' })
      const done = resumed.result.state
      const spent = expectSettledChildLedger(done.childEntries)
      expect(
        done.parentEntries
          .filter((entry) => entry.reservationKey === `child:${childExecutionId}`)
          .map((entry) => entry.kind)
      ).toEqual(['reservation', 'release', 'settlement'])
      expect(done.cost.outcome).toMatchObject({
        costState: 'settled',
        settled: { settledMicrounits: spent },
      })
      expect(done.parentSummary.reservedMicrounits).toBe(0)
      expect(done.publications).toEqual(published)
      expect(done.childJournal).toEqual(closed.childJournal)
      expect(done.delegationCount).toBe(1)

      // A further process repeats it with no change anywhere.
      const repeated = await runChildSettlementProcess(directory, ids)
      expect(repeated.code).toBe(0)
      expect(repeated.result.state).toEqual(done)
      expect(await readStores()).toEqual(done)
      expect(host.state.physicalSends).toBe(sends)
      expect(hooks.evidence.childStarts).toHaveLength(1)
      expect(handle.attemptId).toBeDefined()
    } finally {
      await host.close()
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }, 150000)
}

test('a child whose send failed is never settled or reported as complete', async () => {
  const { host, hooks } = await createHost({}, { childFails: true })
  try {
    const { dispatch, adapter } = await dispatchChildAfterCompaction(host, hooks, {
      waitForCompleted: false,
    })
    const row = childOf(adapter)
    const status = await adapter.status(row.admission.handle)
    // The send's outcome is unknown, so the runtime leaves it for reconciliation.
    expect(status.state).toBe('unknown')
    const before = {
      rows: await rowsOf(host, dispatch),
      cost: stableSummary(await readChildCostState(hooks)),
    }
    const result = await childSettlementFor(hooks).settle()
    expect(result).toMatchObject({ state: 'not_terminal' })
    // Nothing was reported, released or settled for an outcome the runtime could not confirm: the
    // reservation stays held and the cost state stays at what was admitted.
    expect(await rowsOf(host, dispatch)).toEqual(before.rows)
    expect(stableSummary(await readChildCostState(hooks))).toBe(before.cost)
    expect((await readChildCostState(hooks)).outcome.costState).toBe('reserved')
    await expect(
      host.ledger.assertRuntimeAttemptReleased(host.workspaceId, childExecutionId, childAttemptId)
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })
    expect(await summaryOf(host, childExecutionId)).toMatchObject({ settled: false })
    expect(hooks.evidence.childStarts).toHaveLength(1)

    // A restart does not turn the uncertain send into a result either.
    await host.reopenComposition()
    expect((await host.composition.adapter.status(row.admission.handle)).state).toBe('unknown')
    expect(await childSettlementFor(hooks).settle()).toMatchObject({
      state: 'not_terminal',
    })
    expect(await rowsOf(host, dispatch)).toEqual(before.rows)
    expect(hooks.evidence.childStarts).toHaveLength(1)
  } finally {
    await host.close()
  }
}, 120000)

// The publication comparison must be able to fail: the same event type with a changed id, key or
// payload, or a rewritten row, is a different durable record.
for (const tamper of ['idempotency key', 'delegation id', 'payload field']) {
  test(`publication records differ when the ${tamper} of the terminal publication changes`, async () => {
    const { host, hooks } = await createHost()
    try {
      const { dispatch, adapter } = await dispatchChildAfterCompaction(host, hooks)
      await hooks.scanner.scan(adapter)
      const before = await publicationsOf(hooks)
      const terminal = expectOneTerminalPublication(before, dispatch.executionId)
      const value = structuredClone(terminal.value)
      if (tamper === 'idempotency key') value.idempotencyKey = `${value.idempotencyKey}-x`
      else if (tamper === 'delegation id') value.event.delegationId = `${value.event.delegationId}x`
      else value.event.payloadProbe = 'changed'
      await hooks.persistence.transaction((transaction) =>
        transaction.put({
          namespace: 'delegation-publications',
          id: terminal.id,
          expectedRevision: terminal.revision,
          value,
        })
      )
      const after = await publicationsOf(hooks)
      // Same number of rows and the same event type, yet not the same record.
      expect(after.map((record) => record.value.event.type)).toEqual(
        before.map((record) => record.value.event.type)
      )
      expect(after).not.toEqual(before)
      expect(after.find((record) => record.id === terminal.id).revision).toBe(2)
    } finally {
      await host.close()
    }
  }, 120000)
}
