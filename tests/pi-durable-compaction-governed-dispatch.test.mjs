import { expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import {
  compactNativeSession,
  nativeSessionPath,
} from '../packages/pi-durable-adapter/src/native-session-compaction.fixture.mjs'
import {
  childIds,
  childObjective,
  createGovernedDispatchHooks,
  governedDispatchChildren,
} from './pi-durable-compaction-governed-dispatch.fixture.mjs'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

const leadInteractionId = 'int_01JABCDEF0123456789ABCDEFG'
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
function scriptedProvider(sent) {
  return async ({ body }) => {
    const input = body.input
    const isChild =
      input.length === 1 &&
      input[0].content?.length === 1 &&
      input[0].content[0].text === childObjective
    if (isChild) {
      sent.child.push(body)
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

async function createHost(options = {}) {
  const hooks = createGovernedDispatchHooks()
  const sent = { lead: [], child: [] }
  const host = await createProductionFactoryFixture({
    childrenFactory: governedDispatchChildren(hooks),
    physicalResponder: scriptedProvider(sent),
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
const eventTypes = async (hooks) => (await hooks.events.list()).map((event) => event.type)

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

    // The lead's second request carries the native summary instead of the replayed first turn.
    const compactedRequest = JSON.stringify(sent.lead[1].input)
    expect(compactedRequest).toContain('COMPACTED-LEAD-SUMMARY')
    expect(JSON.stringify(sent.lead[0].input)).not.toContain('COMPACTED-LEAD-SUMMARY')
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
    const published = await eventTypes(hooks)
    expect(published.filter((type) => type === 'delegation.completed')).toHaveLength(1)
    await hooks.scanner.scan(adapter)
    expect(await eventTypes(hooks)).toEqual(published)

    // A further restart replays nothing: no second start, send, reservation or usage entry.
    await host.reopenComposition()
    const reopened = host.composition.adapter
    expect((await reopened.status(childRow.admission.handle)).state).toBe('completed')
    expect(hooks.evidence.childStarts).toHaveLength(1)
    expect(hooks.evidence.reservations).toHaveLength(1)
    expect(host.state.physicalSends).toBe(4)
    expect(await host.ledger.entries(host.workspaceId, childExecutionId)).toEqual(childEntries)
    expect(await eventTypes(hooks)).toEqual(published)
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
    expect(await eventTypes(hooks)).toEqual([])
    // The lead stays unsettled for reconciliation rather than reporting a result.
    expect((await adapter.status(handle)).state).toBe('unknown')
    const parentEntries = await host.ledger.entries(host.workspaceId, dispatch.executionId)
    expect(parentEntries.some((entry) => entry.reservationKey?.startsWith('child:'))).toBe(false)
  } finally {
    await host.close()
  }
}, 60000)
