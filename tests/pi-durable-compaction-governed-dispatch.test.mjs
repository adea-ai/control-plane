import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { aggregateUsage } from '@control-plane/pi-durable-adapter'
import { RuntimeUsageSchema } from '@control-plane/runtime-sdk'
import {
  compactNativeSession,
  nativeSessionPath,
} from '../packages/pi-durable-adapter/src/native-session-compaction.fixture.mjs'
import { PiChildTerminalSettlement } from '../apps/control-api/src/pi-durable/child-terminal-settlement.ts'
import { mutateChildUsage } from '../apps/control-api/src/pi-durable/child-usage-outcomes.ts'
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
  closeChildSettlementWorker,
  openDurableChildStores,
  readDurableChildState,
  runChildSettlementProcess,
} from './pi-durable-child-settlement-process.fixture.mjs'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

test('settlement process result waits for stdout to close after exit', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  })
  let resolved = false
  const pending = runChildSettlementProcess('/unused', {}, { spawnWorker: () => child }).then(
    (result) => {
      resolved = true
      return result
    }
  )
  child.emit('exit', 0, null)
  await Promise.resolve()
  expect(resolved).toBe(false)
  child.stdout.emit('data', 'RESULT {"retained":true}\n')
  child.emit('close', 0, null)
  expect((await pending).result).toEqual({ retained: true })
})

test('settlement process rejects malformed or missing successful output', async () => {
  for (const output of ['RESULT {invalid json}\n', '']) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const pending = runChildSettlementProcess('/unused', {}, { spawnWorker: () => child })
    pending.catch(() => {})
    child.stdout.emit('data', output)
    expect(() => child.emit('close', 0, null)).not.toThrow()
    await expect(pending).rejects.toThrow()
  }
})

test('settlement process kills a timed-out worker and waits for it to close', async () => {
  const signals = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill(signal) {
      signals.push(signal)
      queueMicrotask(() => this.emit('close', null, signal))
      return true
    },
  })
  await expect(
    runChildSettlementProcess('/unused', {}, { spawnWorker: () => child, timeoutMs: 10 })
  ).rejects.toThrow('CHILD_SETTLEMENT_PROCESS_TIMEOUT')
  expect(signals).toEqual(['SIGKILL'])
})

test('settlement process rejects spawn errors', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  })
  const pending = runChildSettlementProcess('/unused', {}, { spawnWorker: () => child })
  pending.catch(() => {})
  child.emit('error', new Error('SPAWN_FAILED'))
  child.emit('close', -1, null)
  await expect(pending).rejects.toThrow('SPAWN_FAILED')
})

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

function managementCallResponse() {
  const item = {
    id: 'fc_governed_dispatch_child_management',
    type: 'function_call',
    status: 'completed',
    name: 'management_call',
    call_id: 'call_governed_dispatch_child_management',
    arguments: JSON.stringify({ operation: 'workspace.rename', input: { name: 'Renamed' } }),
  }
  return eventStream([
    { type: 'response.created', response: { id: 'resp_child_management', status: 'in_progress' } },
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
    completed('resp_child_management', item),
  ])
}

/**
 * The child's sends are told apart from the lead's by its objective, which stays the first input item
 * of every child request, including the one that follows a tool result.
 */
function scriptedProvider(sent, behavior = {}) {
  return async ({ request, body }) => {
    const input = body.input
    const isChild = input[0]?.content?.length === 1 && input[0].content[0].text === childObjective
    if (isChild) {
      sent.child.push(body)
      if (behavior.childResponder) return behavior.childResponder({ request, body })
      if (behavior.childFails) return new Response('upstream failure', { status: 500 })
      // A child that calls a tool in its first generation and answers in its second.
      if (behavior.childManagementCall && sent.child.length === 1) return managementCallResponse()
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

test('production child cancellation bypasses lost model and payer readiness but preserves current scope and retained stop fencing', async () => {
  let aborted = false
  let releaseChild = () => {}
  let productChanges = {}
  let currentHost
  const { host, hooks, sent } = await createHost(
    {
      productReader: {
        async readCurrent(input) {
          return {
            ...currentHost.rawProductEvidence(input.intentId),
            ...productChanges,
          }
        },
      },
    },
    {
      childResponder: ({ request }) => {
        return new Promise((_resolve, reject) => {
          releaseChild = () => reject(new Error('TEST_CHILD_TEARDOWN'))
          request.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('TEST_CHILD_SEND_ABORTED'))
            },
            { once: true }
          )
        })
      },
    }
  )
  currentHost = host
  try {
    const { handle } = await runLeadFirstTurn(host, hooks)
    const adapter = host.composition.adapter
    await submitSecondTurn(adapter, handle)
    await waitFor(() => sent.child.length === 1, 'held child send')
    await waitFor(
      async () => (await adapter.status(handle)).state === 'completed',
      'parent complete'
    )
    const row = childOf(adapter)
    const childHandle = row.admission.handle
    const authority = { request: row.admission.request, admission: row.admission.admission }
    expect(row.state).toBe('running')
    expect(sent.child).toHaveLength(1)

    // Only the raw product revision changes; the retained intent and all other evidence
    // stay fixed. Refusal must precede the physical abort and journal stop retention.
    for (const [fault, change] of [
      ['revision-only', { authorityRevision: 2 }],
      ['audience', { allowedPrincipalIds: [host.principal.principalId, 'svc_added'] }],
      ['message', { messageRef: 'message:changed' }],
      ['profile', { profileRevision: host.productProfilePin.profileRevision + 1 }],
      ['principal', { principalRef: 'svc_changed' }],
      ['scope', { scopeRef: 'scope:changed' }],
    ]) {
      productChanges = change
      await expect(
        adapter.cancel(childHandle, {
          idempotencyKey: `cancel:raw-product-${fault}-drift`,
          requestedAt: host.at,
        })
      ).rejects.toMatchObject({ code: 'PI_AUTHORITY_REJECTED' })
      expect(aborted).toBe(false)
      expect(adapter.journal.get(childHandle.handleId).detail.cancellationIntent).toBeUndefined()
    }
    productChanges = {}

    host.models.setCurrentAccount({ quota: 'exhausted' })
    await expect(host.composition.childAuthority.assertAuthority(authority)).rejects.toThrow()
    await host.composition.childAuthority.assertAuthority(authority, 'cancel')
    host.models.state.accountAvailable = false
    await host.models.vault.revoke(
      host.models.refs.credentialRef,
      host.models.refs.administratorPrincipalRef,
      { workspaceId: host.workspaceId }
    )
    // A stop is still possible with no readable payer record; it cannot prepare new funding.
    await rm(join(host.directory, 'private-funding', host.workspaceId, childExecutionId), {
      recursive: true,
    })
    await expect(host.composition.childAuthority.assertAuthority(authority)).rejects.toThrow()
    const before = {
      reads: host.models.state.accountReads,
      leases: host.models.secretProvider.resolveCount,
      sends: host.state.physicalSends,
      entries: await host.ledger.entries(host.workspaceId, childExecutionId),
    }
    const cancel = {
      idempotencyKey: 'cancel:child-model-unavailable',
      requestedAt: host.at,
    }
    host.state.denyNextScopeAuthorityRead = true
    await expect(adapter.cancel(childHandle, cancel)).rejects.toMatchObject({
      code: 'PI_AUTHORITY_REJECTED',
    })
    expect(aborted).toBe(false)
    expect(adapter.journal.get(childHandle.handleId).detail.cancellationIntent).toBeUndefined()

    const cancelled = await adapter.cancel(childHandle, cancel)
    expect(['cancelling', 'cancelled']).toContain(cancelled.state)
    expect(aborted).toBe(true)
    await adapter.drain()
    const retained = adapter.journal.get(childHandle.handleId).detail.cancellationIntent
    expect(retained).toMatchObject({ targetKind: 'active_generation' })
    // Unknown physical outcomes keep the existing reconciliation fence, including on reopen.
    expect((await adapter.reconcile(childHandle)).state).toBe('cancelling')
    await host.reopenComposition()
    expect((await host.composition.adapter.reconcile(childHandle)).state).toBe('cancelling')
    expect(
      host.composition.adapter.journal.get(childHandle.handleId).detail.cancellationIntent
    ).toEqual(retained)
    expect(host.models.state.accountReads).toBe(before.reads)
    expect(host.models.secretProvider.resolveCount).toBe(before.leases)
    expect(host.state.physicalSends).toBe(before.sends)
    expect(await host.ledger.entries(host.workspaceId, childExecutionId)).toEqual(before.entries)
    expect(hooks.evidence.reservations).toHaveLength(1)
  } finally {
    releaseChild()
    await host.close()
  }
}, 120000)

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
  const { host, hooks, sent, dispatch, handle } = await forkAwaitingLead()
  try {
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

/** Runs the delegating turn with the bridge's authority read replaced, without compaction. */
async function delegateWithBridgeAuthority(override) {
  const { host, hooks, sent, dispatch, handle } = await forkAwaitingLead()
  hooks.authorityOverride = override(hooks)
  const adapter = host.composition.adapter
  await submitSecondTurn(adapter, handle)
  await adapter.drain()
  return { host, hooks, sent, dispatch, handle, adapter }
}

async function expectNoChildStartedAfterRestart({ host, hooks, sent, dispatch, handle }) {
  const sendsBefore = host.state.physicalSends
  await host.reopenComposition()
  await hooks.scanner.scan(host.composition.adapter)
  await hooks.scanner.scan(host.composition.adapter)
  expect(hooks.evidence.childStarts).toHaveLength(0)
  expect(sent.child).toHaveLength(0)
  expect(host.state.physicalSends).toBe(sendsBefore)
  expect((await publicationsOf(hooks)).map((record) => record.value.event.type)).not.toContain(
    'delegation.completed'
  )
  expect(childOf(host.composition.adapter)).toBeUndefined()
  expect((await host.composition.adapter.status(handle)).state).toBe('unknown')
  expect(await hooks.delegationRecords.listByParent(dispatch.executionId)).toHaveLength(1)
}

test('a child authority that cannot be read at the bridge reserves, funds and starts nothing', async () => {
  const run = await delegateWithBridgeAuthority(() => async () => {
    throw new Error('TEST_CHILD_AUTHORITY_MISSING')
  })
  const { host, hooks, sent, adapter, handle } = run
  try {
    // The bridge reads authority before it reserves a budget, so a missing authority ends there.
    expect(hooks.evidence.bridgeAuthorityReads).toBeGreaterThan(0)
    expect(hooks.evidence.reservations).toHaveLength(0)
    expect(hooks.evidence.fundingWrites).toHaveLength(0)
    expect(hooks.evidence.childStarts).toHaveLength(0)
    expect(sent.child).toHaveLength(0)
    expect(childOf(adapter)).toBeUndefined()
    expect((await hooks.toolCalls.get(childIds.toolCallId)).status).toBe('reconciliation_required')
    expect((await adapter.status(handle)).state).toBe('unknown')
    await expectNoChildStartedAfterRestart(run)
  } finally {
    await host.close()
  }
}, 60000)

test('authority revoked after the reservation is funded starts no child and sends nothing', async () => {
  let reads = 0
  const run = await delegateWithBridgeAuthority((hooks) => async (input) => {
    // The first read admits the reservation; every later read finds the grant withdrawn.
    if (++reads === 1) return hooks.host.composition.childAuthorityCurrent.readRecord(input)
    throw new Error('TEST_CHILD_AUTHORITY_REVOKED')
  })
  const { host, hooks, sent, adapter, handle } = run
  try {
    expect(hooks.evidence.reservations).toHaveLength(1)
    expect(hooks.evidence.fundingWrites).toEqual([childIds.attemptId])
    // Authority is re-read after the reservation and before the runtime start.
    expect(hooks.evidence.bridgeAuthorityReads).toBe(2)
    expect(hooks.evidence.childStarts).toHaveLength(0)
    expect(sent.child).toHaveLength(0)
    expect(childOf(adapter)).toBeUndefined()
    expect((await hooks.toolCalls.get(childIds.toolCallId)).status).toBe('reconciliation_required')
    expect((await adapter.status(handle)).state).toBe('unknown')
    await expectNoChildStartedAfterRestart(run)
    // Reopening and scanning never re-reserves or re-funds.
    expect(hooks.evidence.reservations).toHaveLength(1)
    expect(hooks.evidence.fundingWrites).toHaveLength(1)
  } finally {
    await host.close()
  }
}, 60000)

/** Lead first turn, compaction across a reopen, then the delegating turn until the child completes. */
async function dispatchChildAfterCompaction(host, hooks, { waitForCompleted = true, lead } = {}) {
  const { dispatch, handle } = lead ?? (await runLeadFirstTurn(host, hooks))
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

/**
 * Two dozen proofs below start from the same state, and building it takes about ten seconds of CPU:
 * the real lead turn, native compaction, reopen, second turn and child run. It is built once by the
 * real production composition over real SQLite, then checkpointed: the canonical database through
 * the provider's own backup, every other file of the runtime directory by copy, and the host's
 * in-memory bindings by value. Each proof restores a checkpoint over the same host and opens a fresh
 * production composition over the restored files, which is the restart path the composition already
 * supports. Mutating proofs (tampered rows, interrupted and killed settlements, separate settlement
 * processes) therefore start from identical durable state and cannot leak into each other. The
 * uncheckpointed flow stays in the tests that assert each of its steps.
 *
 * Two checkpoints are taken on one shared host: the lead awaiting input after its first turn, and the
 * child completed after compaction and the delegating turn.
 */
const sqliteFileNames = new Set([
  'canonical.sqlite',
  'canonical.sqlite-wal',
  'canonical.sqlite-shm',
])
let sharedScenario
/** The plain data of a fixture object; behavior (functions and the authority port) is kept as is. */
const dataOf = (record) =>
  Object.fromEntries(
    Object.entries(record)
      .filter(([key, value]) => typeof value !== 'function' && key !== 'scopeAuthority')
      .map(([key, value]) => [key, structuredClone(value)])
  )
function restoreData(target, saved) {
  for (const key of Object.keys(target))
    if (typeof target[key] !== 'function' && key !== 'scopeAuthority' && !(key in saved))
      delete target[key]
  for (const [key, value] of Object.entries(saved)) target[key] = structuredClone(value)
}

/** Closes the composition and store, then captures the durable files and the in-memory bindings. */
async function captureCheckpoint({ host, hooks, sent, behavior }) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-dispatch-checkpoint-'))
  await host.suspend()
  await cp(host.directory, directory, {
    recursive: true,
    filter: (source) => !sqliteFileNames.has(basename(source)),
  })
  await hooks.persistence.migrate()
  const sqlite = await hooks.persistence.backup()
  await host.resume()
  return {
    directory,
    sqlite,
    state: dataOf(host.state),
    records: structuredClone([...host.records]),
    evidence: dataOf(hooks.evidence),
    sent: dataOf(sent),
    behavior: dataOf(behavior),
    intentId: hooks.intentId,
  }
}

async function restoreCheckpoint({ host, hooks, sent, behavior }, checkpoint) {
  await host.suspend()
  await hooks.persistence.restore(checkpoint.sqlite)
  for (const name of await readdir(host.directory))
    if (!sqliteFileNames.has(name))
      await rm(join(host.directory, name), { recursive: true, force: true })
  await cp(checkpoint.directory, host.directory, { recursive: true })
  restoreData(host.state, checkpoint.state)
  host.records.clear()
  for (const [key, value] of structuredClone(checkpoint.records)) host.records.set(key, value)
  restoreData(hooks.evidence, checkpoint.evidence)
  restoreData(sent, checkpoint.sent)
  restoreData(behavior, checkpoint.behavior)
  hooks.intentId = checkpoint.intentId
  hooks.afterPolicyAllow = undefined
  hooks.authorityOverride = undefined
  hooks.settlementSeam = undefined
  // Stores the composition keeps only in memory start empty, as after a real restart.
  hooks.resetInMemoryStores()
  await host.resume()
}

/** The shared host with its lead awaiting input after the first turn, built on first use. */
function leadScenario() {
  sharedScenario ??= (async () => {
    const behavior = {}
    const { host, hooks, sent } = await createHost({}, behavior)
    const lead = await runLeadFirstTurn(host, hooks)
    const scenario = { host, hooks, sent, behavior, lead, checkpoints: {} }
    scenario.checkpoints.lead = await captureCheckpoint(scenario)
    return scenario
  })()
  return sharedScenario
}

const forkView = (scenario) => ({
  // `close()` only releases the fork; the shared host is closed once, after the last test.
  host: Object.create(scenario.host, { close: { value: async () => {} } }),
  hooks: scenario.hooks,
  sent: scenario.sent,
  behavior: scenario.behavior,
})

/** Restores the lead awaiting its second turn, before compaction. */
async function forkAwaitingLead() {
  const scenario = await leadScenario()
  await restoreCheckpoint(scenario, scenario.checkpoints.lead)
  return { ...forkView(scenario), ...scenario.lead }
}

/** Restores the completed child after compaction and the delegating turn. */
async function forkDispatchedHost() {
  const scenario = await leadScenario()
  scenario.checkpoints.dispatched ??= (async () => {
    await restoreCheckpoint(scenario, scenario.checkpoints.lead)
    await dispatchChildAfterCompaction(scenario.host, scenario.hooks, { lead: scenario.lead })
    return captureCheckpoint(scenario)
  })()
  await restoreCheckpoint(scenario, await scenario.checkpoints.dispatched)
  return {
    ...forkView(scenario),
    ...scenario.lead,
    adapter: scenario.host.composition.adapter,
  }
}

afterAll(async () => {
  try {
    const scenario = await sharedScenario?.catch(() => undefined)
    if (!scenario) return
    await scenario.host.close()
    for (const checkpoint of Object.values(scenario.checkpoints))
      await rm((await checkpoint).directory, { recursive: true, force: true })
  } finally {
    await closeChildSettlementWorker()
  }
})

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
  const { host, hooks, dispatch, handle, adapter } = await forkDispatchedHost()
  try {
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

test('the production composition settles the admitted child through its own settlement path', async () => {
  const { host, hooks, dispatch } = await forkDispatchedHost()
  try {
    // Only the production composition runs here: no test-built settlement instance.
    expect(typeof host.composition.settleChildTerminalAccounting).toBe('function')
    expect(host.composition.childTerminalSettlementBlocked).toBe(false)
    expect((await readChildCostState(hooks)).outcome.costState).toBe('reserved')
    expect(await settleLeadTerminal(host)).toEqual({ settled: 1, pending: 0, unbound: 1 })

    const sends = host.state.physicalSends
    const starts = hooks.evidence.childStarts.length
    expect(await host.composition.settleChildTerminalAccounting()).toEqual({
      settled: 1,
      pending: 0,
      unpriced: 0,
    })
    expect(host.composition.childTerminalSettlementBlocked).toBe(false)

    const { parent, child } = await rowsOf(host, dispatch)
    const spent = expectSettledChildLedger(child)
    expect(
      kinds(parent.filter((entry) => entry.reservationKey === `child:${childExecutionId}`))
    ).toEqual(['reservation', 'release', 'settlement'])
    expect(await summaryOf(host, childExecutionId)).toMatchObject({
      spentMicrounits: spent,
      reservedMicrounits: 0,
      settled: true,
    })
    expect((await readChildCostState(hooks)).outcome).toMatchObject({
      costState: 'settled',
      reported: { accounting: { costExact: true, chargedMicrounits: spent } },
      reconciled: { result: 'within_reservation', reportedChargedMicrounits: spent },
      settled: { settledMicrounits: spent },
    })

    // Repeating the pass and reopening the composition (which re-runs recovery, including this
    // settlement) change no money, no cost state, no event, and send or start nothing.
    // The terminal event is the progress scanner's to publish, once; settlement never publishes.
    await hooks.scanner.scan(host.composition.adapter)
    const before = {
      rows: await rowsOf(host, dispatch),
      cost: stableSummary(await readChildCostState(hooks)),
      publications: await publicationsOf(hooks),
    }
    expectOneTerminalPublication(before.publications, hooks.host.state.parentExecutionId)
    expect(await host.composition.settleChildTerminalAccounting()).toEqual({
      settled: 1,
      pending: 0,
      unpriced: 0,
    })
    await host.reopenComposition()
    expect(hooks.evidence.timelineWakes).toContainEqual({
      workspaceId: host.workspaceId,
      intentId: hooks.intentId,
      principalId: 'svc_factory-proof',
    })
    expect(await host.composition.settleChildTerminalAccounting()).toEqual({
      settled: 1,
      pending: 0,
      unpriced: 0,
    })
    expect(host.composition.childTerminalSettlementBlocked).toBe(false)
    expect(await rowsOf(host, dispatch)).toEqual(before.rows)
    expect(stableSummary(await readChildCostState(hooks))).toBe(before.cost)
    expect(await publicationsOf(hooks)).toEqual(before.publications)
    expect(host.state.physicalSends).toBe(sends)
    expect(hooks.evidence.childStarts).toHaveLength(starts)
    expect(hooks.evidence.reservations).toHaveLength(1)
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
    const { host, hooks, dispatch, handle, adapter } = await forkDispatchedHost()
    try {
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
    const { host, hooks, dispatch, handle, adapter } = await forkDispatchedHost()
    let directory
    try {
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
      directory = await host.suspend()

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
      // Read the runtime-attempt fence from a fresh connection, including the boundary between
      // reporting usage and settling the attempt, before either resume process can repair it.
      const crashedStores = await openDurableChildStores(directory, ids)
      try {
        const released = crashedStores.ledger.assertRuntimeAttemptReleased(
          ids.workspaceId,
          childExecutionId,
          childAttemptId
        )
        if (expected.attemptReleased) await released
        else await expect(released).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })
      } finally {
        await crashedStores.close()
      }
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
      // The directory belongs to the shared host; the next fork restores it from the checkpoint.
      await host.close()
    }
  }, 150000)
}

test('a child whose send failed is never settled or reported as complete', async () => {
  const { host, hooks, behavior, ...lead } = await forkAwaitingLead()
  behavior.childFails = true
  try {
    const { dispatch, adapter } = await dispatchChildAfterCompaction(host, hooks, {
      waitForCompleted: false,
      lead,
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

// Change exactly one field on disk: ordinary transaction.put also changes revision/write time,
// which would let a broken key/event comparison pass solely because metadata changed.
const publicationTampers = {
  'storage id': (row) => (row.id += '-x'),
  revision: (row) => row.revision++,
  'write time': (row) => (row.updatedAt = new Date(Date.parse(row.updatedAt) + 1).toISOString()),
  'idempotency key': (row) => (row.value.idempotencyKey += '-x'),
  'delegation id': (row) => (row.value.event.delegationId += 'x'),
  'payload field': (row) => (row.value.event.details.payloadProbe = 'changed'),
}
for (const [tamper, change] of Object.entries(publicationTampers)) {
  test(`publication records differ when the ${tamper} of the terminal publication changes`, async () => {
    const { host, hooks, dispatch, adapter } = await forkDispatchedHost()
    try {
      await hooks.scanner.scan(adapter)
      const before = await publicationsOf(hooks)
      const terminal = expectOneTerminalPublication(before, dispatch.executionId)
      const changed = structuredClone(terminal)
      change(changed)
      // Deliberate corruption of disposable fixture data bypasses the normal writer so that all
      // fields except the named mutation remain byte-identical, including storage metadata.
      const database = new DatabaseSync(join(host.directory, 'canonical.sqlite'))
      try {
        const result = database
          .prepare(
            'UPDATE control_plane_records SET id = ?, revision = ?, updated_at = ?, value = ? WHERE namespace = ? AND id = ?'
          )
          .run(
            changed.id,
            changed.revision,
            changed.updatedAt,
            JSON.stringify(changed.value),
            terminal.namespace,
            terminal.id
          )
        expect(Number(result.changes)).toBe(1)
      } finally {
        database.close()
      }
      const after = await publicationsOf(hooks)
      // Same number of rows and the same event type, yet not the same record.
      expect(after.map((record) => record.value.event.type)).toEqual(
        before.map((record) => record.value.event.type)
      )
      expect(after).toEqual(
        before
          .map((record) => (record.id === terminal.id ? changed : record))
          .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      )
      expect(after).not.toEqual(before)
    } finally {
      await host.close()
    }
  }, 120000)
}

const terminalCostIdentity = (host) => ({
  parentExecutionId: host.state.parentExecutionId,
  delegationId: childIds.delegationId,
  childExecutionId,
  childAttemptId,
})

function terminalPass(host, hooks, overrides = {}) {
  return new PiChildTerminalSettlement({
    journal: { list: () => host.composition.adapter.journal.list() },
    ledger: host.ledger,
    delegations: hooks.delegationRecords,
    usageOutcomes: () => hooks.usageOutcomes,
    now: () => hooks.at,
    ...overrides,
  })
}

async function captureTerminalState(host, hooks, dispatch) {
  return {
    rows: await rowsOf(host, dispatch),
    parentSummary: await summaryOf(host, dispatch.executionId),
    childSummary: await summaryOf(host, childExecutionId),
    cost: await readChildCostState(hooks),
  }
}

const settlementCorruptions = {
  'charged amount': async (host) => ({
    journal: {
      list() {
        return host.composition.adapter.journal.list().map((record) => {
          if (record.admission.request.executionId !== childExecutionId) return record
          const changed = structuredClone(record)
          changed.detail.result.usage.accounting.chargedMicrounits += 1
          delete changed.detail.result.usage.cost
          return changed
        })
      },
    },
  }),
  'ledger attempt': async (host) => {
    const ledger = new Proxy(host.ledger, {
      get(target, property) {
        if (property === 'entries')
          return async (...args) =>
            (await target.entries(...args)).map((entry) =>
              entry.kind === 'model_usage'
                ? { ...entry, attemptId: 'att_01JCCDEF0123456789ABCDEFG' }
                : entry
            )
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { ledger }
  },
  'projection report': async (host, hooks) => {
    const usageEntry = (await host.ledger.entries(host.workspaceId, childExecutionId)).find(
      (entry) => entry.kind === 'model_usage'
    )
    const changed = structuredClone(childOf(host.composition.adapter).detail.result.usage)
    changed.accounting.chargedMicrounits += 1
    delete changed.cost
    await mutateChildUsage(hooks.usageOutcomes, (cost) =>
      cost.recordReportedUsage(terminalCostIdentity(host), changed, {
        reportId: 'conflicting-terminal-report',
        publicationSequence: usageEntry.sequence + 1000,
      })
    )
    return {}
  },
  'projection reservation': async (host, hooks) => {
    const stored = await hooks.usageOutcomes.load()
    const snapshot = structuredClone(stored.snapshot)
    const entry = snapshot.entries.find(
      (item) => item.outcome.identity.childAttemptId === childAttemptId
    )
    entry.outcome.reserved.reservationKey = 'different-attempt-hold'
    await hooks.usageOutcomes.save({ revision: stored.revision + 1, snapshot })
    return {}
  },
}

for (const [corruption, prepare] of Object.entries(settlementCorruptions)) {
  test(`terminal settlement rejects mismatched ${corruption} before changing durable state`, async () => {
    const { host, hooks, dispatch } = await forkDispatchedHost()
    try {
      const overrides = await prepare(host, hooks)
      const before = await captureTerminalState(host, hooks, dispatch)
      const pass = terminalPass(host, hooks, overrides)
      await expect(pass.settle()).rejects.toThrow('PI_CHILD_SETTLEMENT_MISMATCH')
      expect(pass.blocked).toBe(true)
      expect(await captureTerminalState(host, hooks, dispatch)).toEqual(before)
    } finally {
      await host.close()
    }
  }, 120000)
}

test('a newer report after budget finalization cannot receive the earlier report settlement', async () => {
  const { host, hooks, dispatch } = await forkDispatchedHost()
  try {
    const usageEntry = (await host.ledger.entries(host.workspaceId, childExecutionId)).find(
      (entry) => entry.kind === 'model_usage'
    )
    const newer = structuredClone(childOf(host.composition.adapter).detail.result.usage)
    newer.accounting.chargedMicrounits += 1
    delete newer.cost
    let injected = false
    const pass = terminalPass(host, hooks, {
      afterStep: async (step) => {
        if (step !== 'budget-finalized' || injected) return
        injected = true
        await mutateChildUsage(hooks.usageOutcomes, (cost) =>
          cost.recordReportedUsage(terminalCostIdentity(host), newer, {
            reportId: 'newer-terminal-report',
            publicationSequence: usageEntry.sequence + 1000,
          })
        )
      },
    })

    await expect(pass.settle()).rejects.toThrow('PI_CHILD_SETTLEMENT_MISMATCH')
    expect(pass.blocked).toBe(true)
    const latest = await readChildCostState(hooks)
    expect(latest.outcome).toMatchObject({ costState: 'reported', reported: newer })
    expect(latest.outcome.reconciled).toBeUndefined()
    expect(latest.outcome.settled).toBeUndefined()
    const beforeRetry = await captureTerminalState(host, hooks, dispatch)
    await expect(pass.settle()).rejects.toThrow('PI_CHILD_SETTLEMENT_MISMATCH')
    expect(await captureTerminalState(host, hooks, dispatch)).toEqual(beforeRetry)
  } finally {
    await host.close()
  }
}, 120000)

test('a newer identical report keeps its own publication fence after budget finalization', async () => {
  const { host, hooks, dispatch } = await forkDispatchedHost()
  try {
    const usageEntry = (await host.ledger.entries(host.workspaceId, childExecutionId)).find(
      (entry) => entry.kind === 'model_usage'
    )
    const sameUsage = structuredClone(childOf(host.composition.adapter).detail.result.usage)
    let injected = false
    const pass = terminalPass(host, hooks, {
      afterStep: async (step) => {
        if (step !== 'budget-finalized' || injected) return
        injected = true
        await mutateChildUsage(hooks.usageOutcomes, (cost) =>
          cost.recordReportedUsage(terminalCostIdentity(host), sameUsage, {
            reportId: 'newer-identical-terminal-report',
            publicationSequence: usageEntry.sequence + 1000,
          })
        )
      },
    })

    await expect(pass.settle()).rejects.toThrow('PI_CHILD_SETTLEMENT_MISMATCH')
    const latest = await readChildCostState(hooks)
    expect(latest.outcome).toMatchObject({ costState: 'reported', reported: sameUsage })
    expect(latest.outcome.reconciled).toBeUndefined()
    expect(latest.outcome.settled).toBeUndefined()
    const beforeRetry = await captureTerminalState(host, hooks, dispatch)
    await expect(pass.settle()).rejects.toThrow('PI_CHILD_SETTLEMENT_MISMATCH')
    expect(await captureTerminalState(host, hooks, dispatch)).toEqual(beforeRetry)
  } finally {
    await host.close()
  }
}, 120000)

test('a failed child lookup does not prevent a later completed record from settling', async () => {
  const { host, hooks, dispatch } = await forkDispatchedHost()
  try {
    const record = childOf(host.composition.adapter)
    const lookupError = new Error('FIRST_CHILD_LOOKUP_FAILED')
    let reads = 0
    const pass = terminalPass(host, hooks, {
      journal: { list: () => [record, record] },
      delegations: {
        async findByChild(id) {
          reads += 1
          if (reads === 1) throw lookupError
          return hooks.delegationRecords.findByChild(id)
        },
      },
    })

    await expect(pass.settle()).rejects.toBe(lookupError)
    expect(pass.blocked).toBe(true)
    expect(reads).toBe(2)
    expect(await summaryOf(host, childExecutionId)).toMatchObject({ settled: true })
    expect((await readChildCostState(hooks)).outcome.costState).toBe('settled')
    expect(await rowsOf(host, dispatch)).toMatchObject({ child: expect.any(Array) })
  } finally {
    await host.close()
  }
}, 120000)

test('a restored proof does not inherit the in-memory rate-limiter or interaction state of an earlier one', async () => {
  const key = 'checkpoint-isolation'
  const first = await forkDispatchedHost()
  expect(await first.hooks.rateLimiter.consume(key, 1, 60000, first.hooks.at)).toBe(true)
  expect(await first.hooks.rateLimiter.consume(key, 1, 60000, first.hooks.at)).toBe(false)
  expect(first.hooks.interactions.insertSynchronously({ interactionId: key, version: 1 })).toBe(
    true
  )

  const second = await forkDispatchedHost()
  expect(await second.hooks.rateLimiter.consume(key, 1, 60000, second.hooks.at)).toBe(true)
  expect(await second.hooks.interactions.get(key)).toBeUndefined()
}, 120000)

/**
 * Constructed evidence for states a real child cannot be driven into: a second inference reserved but
 * not yet settled in the ledger, a ledger row that differs from its receipt, and a completed result
 * whose receipts are gone. The second inference is added to a completed child the way the production
 * path records one (a ledger dispatch reservation and settlement, a retained journal receipt, and the
 * composite `pi-turn-usage:` aggregate in the result). The real two-call child, with no constructed
 * receipt, is the test further down.
 */
const secondCharge = { microunits: 7, inputTokens: 4, outputTokens: 2, durationMs: 50 }
const secondHex = createHash('sha256')
  .update('second-inference-of-the-completed-child')
  .digest('hex')
const secondSourceId = `pi-inference:${secondHex}`
const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const modelCallIdOf = (hex) => {
  let value = BigInt(`0x${hex.slice(0, 32)}`)
  let encoded = ''
  for (let position = 0; position < 26; position++) {
    encoded = crockford[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return `mdc_${encoded}`
}

async function completeWithTwoInferences(host, { settleSecond = true, ledgerMicrounits } = {}) {
  const adapter = host.composition.adapter
  const row = childOf(adapter)
  const entries = await host.ledger.entries(host.workspaceId, childExecutionId)
  const reservation = entries.find((entry) => entry.kind === 'model_reservation')
  const [firstKey, first] = Object.entries(row.detail.inferenceReceipts)[0]
  const hex = secondHex
  const sourceId = secondSourceId
  const modelCallId = modelCallIdOf(hex)
  const ledgerScope = {
    workspaceId: host.workspaceId,
    executionId: childExecutionId,
    attemptId: childAttemptId,
    reservationKey: reservation.reservationKey,
    modelCallId,
  }
  await host.ledger.reserveModelRequestForDispatch({
    ...ledgerScope,
    maximumMicrounits: 100,
    maximumTokens: 64,
    fundingSource: reservation.fundingSource,
    priceSnapshotDigest: reservation.priceSnapshotDigest,
    requestDigest: `sha256:${hex}`,
    source: { sourceId, idempotencyKey: `${sourceId}:dispatch` },
  })
  if (settleSecond)
    await host.ledger.settleModelRequest({
      ...ledgerScope,
      costMicrounits: ledgerMicrounits ?? secondCharge.microunits,
      tokens: secondCharge.inputTokens + secondCharge.outputTokens,
      source: { sourceId, idempotencyKey: `${sourceId}:settle` },
    })
  const second = RuntimeUsageSchema.parse({
    inputTokens: secondCharge.inputTokens,
    outputTokens: secondCharge.outputTokens,
    durationMs: secondCharge.durationMs,
    cost: { amount: `0.${String(secondCharge.microunits).padStart(6, '0')}`, currency: 'USD' },
    accounting: {
      schemaVersion: 1,
      sourceId,
      fundingSource: first.usage.accounting.fundingSource,
      currency: 'USD',
      chargedMicrounits: secondCharge.microunits,
      costExact: true,
    },
  })
  const turnUsage = aggregateUsage([RuntimeUsageSchema.parse(first.usage), second])
  expect(turnUsage.accounting.sourceId.startsWith('pi-turn-usage:')).toBe(true)
  const secondKey = `${firstKey.slice(0, firstKey.lastIndexOf(':') + 1)}pi-generation:second`
  adapter.journal.update(row.handleId, row.epoch, {
    detail: {
      ...row.detail,
      inferenceReceipts: {
        ...row.detail.inferenceReceipts,
        [secondKey]: {
          turnKey: first.turnKey,
          nativeDigest: `sha256:${hex}`,
          usage: second,
        },
      },
      result: { ...row.detail.result, usage: turnUsage },
    },
  })
  return { first: RuntimeUsageSchema.parse(first.usage), second, usage: turnUsage }
}

test('a completed child with several priced inferences settles from its retained receipts and stays settled', async () => {
  const { host, hooks, dispatch } = await forkDispatchedHost()
  try {
    expect(await settleLeadTerminal(host)).toEqual({ settled: 1, pending: 0, unbound: 1 })
    const { first, usage: turnUsage } = await completeWithTwoInferences(host, {
      settleSecond: false,
    })
    const total = first.accounting.chargedMicrounits + secondCharge.microunits
    expect(turnUsage.accounting.chargedMicrounits).toBe(total)

    // The second inference is reserved but not yet settled in the ledger, so the child is pending:
    // nothing is settled, released or reported, and nothing is inferred from the aggregate alone.
    expect(await host.composition.settleChildTerminalAccounting()).toEqual({
      settled: 0,
      pending: 1,
      unpriced: 0,
    })
    expect(host.composition.childTerminalSettlementBlocked).toBe(true)
    expect(kinds((await rowsOf(host, dispatch)).child)).not.toContain('settlement')
    expect((await readChildCostState(hooks)).outcome.costState).toBe('reserved')

    // The ledger then records it, and the next pass settles the aggregate from both receipts.
    await host.ledger.settleModelRequest({
      workspaceId: host.workspaceId,
      executionId: childExecutionId,
      attemptId: childAttemptId,
      reservationKey: `runtime-attempt:${childAttemptId}`,
      modelCallId: modelCallIdOf(secondHex),
      costMicrounits: secondCharge.microunits,
      tokens: secondCharge.inputTokens + secondCharge.outputTokens,
      source: { sourceId: secondSourceId, idempotencyKey: `${secondSourceId}:settle` },
    })
    const settled = { settled: 1, pending: 0, unpriced: 0 }
    expect(await host.composition.settleChildTerminalAccounting()).toEqual(settled)
    expect(host.composition.childTerminalSettlementBlocked).toBe(false)

    const { child } = await rowsOf(host, dispatch)
    expect(kinds(child)).toEqual([
      'credit',
      'reservation',
      'model_reservation',
      'model_usage',
      'model_release',
      'model_reservation',
      'model_usage',
      'model_release',
      'release',
      'settlement',
      'settlement',
    ])
    expect(
      child.filter((entry) => entry.kind === 'model_usage').map((entry) => entry.costMicrounits)
    ).toEqual([first.accounting.chargedMicrounits, secondCharge.microunits])
    expect(await summaryOf(host, childExecutionId)).toMatchObject({
      spentMicrounits: total,
      reservedMicrounits: 0,
      settled: true,
    })
    expect((await readChildCostState(hooks)).outcome).toMatchObject({
      costState: 'settled',
      reported: {
        accounting: { sourceId: turnUsage.accounting.sourceId, chargedMicrounits: total },
      },
      reconciled: { result: 'within_reservation', reportedChargedMicrounits: total },
      settled: { settledMicrounits: total },
    })

    // Repeating the pass and reopening the composition change no money and no cost state.
    const before = {
      rows: await rowsOf(host, dispatch),
      cost: stableSummary(await readChildCostState(hooks)),
    }
    expect(await host.composition.settleChildTerminalAccounting()).toEqual(settled)
    await host.reopenComposition()
    expect(await host.composition.settleChildTerminalAccounting()).toEqual(settled)
    expect(host.composition.childTerminalSettlementBlocked).toBe(false)
    expect(await rowsOf(host, dispatch)).toEqual(before.rows)
    expect(stableSummary(await readChildCostState(hooks))).toBe(before.cost)
  } finally {
    await host.close()
  }
}, 120000)

test('a completed child whose retained receipts do not match the canonical ledger settles nothing', async () => {
  const mismatch = 'PI_CHILD_SETTLEMENT_MISMATCH'
  // The ledger charged one microunit more than the second receipt reported.
  const overcharged = await forkDispatchedHost()
  try {
    await completeWithTwoInferences(overcharged.host, {
      ledgerMicrounits: secondCharge.microunits + 1,
    })
    await expect(overcharged.host.composition.settleChildTerminalAccounting()).rejects.toThrow(
      mismatch
    )
    expect((await readChildCostState(overcharged.hooks)).outcome.costState).toBe('reserved')
    expect(kinds((await rowsOf(overcharged.host, overcharged.dispatch)).child)).not.toContain(
      'settlement'
    )
  } finally {
    await overcharged.host.close()
  }

  // The completed result claims an aggregate the retained receipts cannot reproduce.
  const unproven = await forkDispatchedHost()
  try {
    await completeWithTwoInferences(unproven.host)
    const row = childOf(unproven.host.composition.adapter)
    const [firstKey] = Object.keys(row.detail.inferenceReceipts)
    const { [firstKey]: _dropped, ...remaining } = row.detail.inferenceReceipts
    unproven.host.composition.adapter.journal.update(row.handleId, row.epoch, {
      detail: { ...row.detail, inferenceReceipts: remaining },
    })
    await expect(unproven.host.composition.settleChildTerminalAccounting()).rejects.toThrow(
      mismatch
    )
    expect((await readChildCostState(unproven.hooks)).outcome.costState).toBe('reserved')
    expect(kinds((await rowsOf(unproven.host, unproven.dispatch)).child)).not.toContain(
      'settlement'
    )
  } finally {
    await unproven.host.close()
  }
}, 120000)

test('a child attempt that ran more than one turn is refused rather than settled against one turn of usage', async () => {
  const { host, hooks, dispatch } = await forkDispatchedHost()
  try {
    // The ledger spend is the whole attempt's; the reported usage is the completed turn's alone.
    const adapter = host.composition.adapter
    const row = childOf(adapter)
    const [[, receipt]] = Object.entries(row.detail.inferenceReceipts)
    adapter.journal.update(row.handleId, row.epoch, {
      detail: {
        ...row.detail,
        inferenceReceipts: {
          ...row.detail.inferenceReceipts,
          [`pi-turn:${childAttemptId}:earlier:pi-generation:1`]: {
            ...receipt,
            turnKey: `pi-turn:${childAttemptId}:earlier`,
          },
        },
      },
    })
    await expect(host.composition.settleChildTerminalAccounting()).rejects.toThrow(
      'PI_CHILD_SETTLEMENT_MULTI_TURN_UNSUPPORTED'
    )
    expect(host.composition.childTerminalSettlementBlocked).toBe(true)
    expect((await readChildCostState(hooks)).outcome.costState).toBe('reserved')
    expect(kinds((await rowsOf(host, dispatch)).child)).not.toContain('settlement')
  } finally {
    await host.close()
  }
}, 120000)

/**
 * A governed management call the child can make in its first generation. It is the child's only tool
 * that returns to the model, so the child's turn is two real generations: the call, then the answer.
 */
function childManagementCall(calls) {
  let host
  return {
    bind: (value) => (host = value),
    compiler: {
      prepare: async (authority, verified) => {
        const workspaceId = authority.request.executionPlan.correlation.workspaceId
        const profileId = authority.request.executionPlan.profile.profileId
        const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFG'
        const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFG'
        calls.prepared.push(authority.request.executionId)
        return {
          requestId: 'req_01JABCDEF0123456789ABCDEFG',
          executionId: authority.request.executionId,
          attemptId: authority.request.attemptId,
          workspaceId,
          profileId,
          toolDefinitionId,
          toolVersionId,
          operation: verified.args.operation,
          input: verified.args.input,
          grant: {
            workspaceId,
            profileId,
            toolDefinitionId,
            toolVersionId,
            operations: [verified.args.operation],
          },
          audit: {
            principalRef: authority.admission.canonicalActorPrincipalId,
            traceId: 'trc_01JABCDEF0123456789ABCDEFG',
          },
          toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
          idempotencyKey: `child-management:${verified.sourceKey}`,
          requestedAt: host.at,
          policySnapshotRef: 'policy://governed-dispatch-child-management/v1',
        }
      },
      execute: async (request) => {
        calls.executed.push(request.executionId)
        return { state: 'succeeded', value: { renamed: true } }
      },
    },
  }
}

test('a child that makes two priced model calls in one turn settles from its real receipts', async () => {
  const calls = { prepared: [], executed: [] }
  const management = childManagementCall(calls)
  const { host, hooks, sent } = await createHost(
    { governedManagementCall: management.compiler },
    { childManagementCall: true }
  )
  management.bind(host)
  try {
    const { dispatch, adapter } = await dispatchChildAfterCompaction(host, hooks)

    // The child's one turn was two generations around one governed tool call, both really sent.
    expect(sent.child).toHaveLength(2)
    expect(sent.child[0].tools.map((tool) => tool.name)).toContain('management_call')
    expect(calls).toEqual({ prepared: [childExecutionId], executed: [childExecutionId] })
    const row = childOf(adapter)
    expect(Object.keys(row.detail.inferenceReceipts)).toHaveLength(2)
    const reported = row.detail.result.usage
    expect(reported.accounting.sourceId.startsWith('pi-turn-usage:')).toBe(true)

    // Both generations are priced and in the canonical ledger as they happened, and each receipt
    // matches its ledger row. The reported usage is their aggregate, not a source of its own.
    const childEntries = (await rowsOf(host, dispatch)).child
    expect(kinds(childEntries)).toEqual([
      'credit',
      'reservation',
      'model_reservation',
      'model_usage',
      'model_release',
      'model_reservation',
      'model_usage',
      'model_release',
    ])
    const usageRows = childEntries.filter((entry) => entry.kind === 'model_usage')
    const receipts = Object.values(row.detail.inferenceReceipts).map((receipt) => receipt.usage)
    expect(receipts.map((receipt) => receipt.accounting.sourceId).toSorted()).toEqual(
      usageRows.map((entry) => entry.source.sourceId).toSorted()
    )
    const spent = usageRows.reduce((total, entry) => total + entry.costMicrounits, 0)
    expect(reported.accounting.chargedMicrounits).toBe(spent)
    expect(reported.inputTokens).toBe(
      receipts.reduce((total, receipt) => total + receipt.inputTokens, 0)
    )

    // The lead settles first. The child is completed but nothing of it is settled yet.
    expect(await settleLeadTerminal(host)).toEqual({ settled: 1, pending: 0, unbound: 1 })
    await hooks.scanner.scan(adapter)
    const published = await publicationsOf(hooks)
    expectOneTerminalPublication(published, hooks.host.state.parentExecutionId)
    const counts = () => ({
      physicalSends: host.state.physicalSends,
      childSends: sent.child.length,
      leadSends: sent.lead.length,
      starts: hooks.evidence.childStarts.length,
      reservations: hooks.evidence.reservations.length,
      management: calls.executed.length,
    })
    const before = counts()
    expect(before).toMatchObject({ physicalSends: 5, childSends: 2, starts: 1, reservations: 1 })
    expect((await readChildCostState(hooks)).outcome.costState).toBe('reserved')

    // A settlement cut off after the attempt settled leaves exactly what was recorded, and a restart
    // resumes it through the production composition.
    hooks.settlementSeam = async (reached) => {
      if (reached === 'attempt-settled') throw new Error('SETTLEMENT_INTERRUPTED')
    }
    await expect(childSettlementFor(hooks).settle()).rejects.toThrow('SETTLEMENT_INTERRUPTED')
    hooks.settlementSeam = undefined
    await host.ledger.assertRuntimeAttemptReleased(
      host.workspaceId,
      childExecutionId,
      childAttemptId
    )
    expect((await readChildCostState(hooks)).outcome.costState).toBe('reported')
    expect((await summaryOf(host, childExecutionId)).settled).toBe(false)
    await host.reopenComposition()

    const settled = { settled: 1, pending: 0, unpriced: 0 }
    expect(await host.composition.settleChildTerminalAccounting()).toEqual(settled)
    expect(host.composition.childTerminalSettlementBlocked).toBe(false)

    // Exact child accounting: two usages, both releases, one settlement of the attempt and of the budget.
    const { parent, child } = await rowsOf(host, dispatch)
    expect(kinds(child)).toEqual([
      'credit',
      'reservation',
      'model_reservation',
      'model_usage',
      'model_release',
      'model_reservation',
      'model_usage',
      'model_release',
      'release',
      'settlement',
      'settlement',
    ])
    const attemptSettlement = child.at(-2)
    const budgetSettlement = child.at(-1)
    expect(attemptSettlement.quantity.value).toBe(spent)
    expect(budgetSettlement.quantity.value).toBe(spent)
    expect(await summaryOf(host, childExecutionId)).toMatchObject({
      spentMicrounits: spent,
      reservedMicrounits: 0,
      settled: true,
    })

    // Exact parent accounting: the allowance funded the child, the unspent part came back, and the
    // parent's spend is its own three sends plus the child's two.
    const allowance = host.parentPlanForIntent(hooks.intentId).constraints.limits.childExecutions
      .budgetAllowance.maximumMicrounits
    expect(child[0].quantity.value).toBe(allowance)
    const funding = parent.filter((entry) => entry.reservationKey === `child:${childExecutionId}`)
    expect(kinds(funding)).toEqual(['reservation', 'release', 'settlement'])
    expect(funding.map((entry) => entry.quantity.value)).toEqual([
      allowance,
      allowance - spent,
      spent,
    ])
    const leadUsage = parent.filter((entry) => entry.kind === 'model_usage')
    expect(leadUsage).toHaveLength(3)
    const leadSpent = leadUsage.reduce((total, entry) => total + entry.costMicrounits, 0)
    const parentSummary = await summaryOf(host, dispatch.executionId)
    expect(parentSummary).toMatchObject({
      spentMicrounits: leadSpent + spent,
      reservedMicrounits: 0,
      settled: false,
    })
    expect(parentSummary.spentMicrounits + parentSummary.availableMicrounits).toBe(
      parentSummary.maximumMicrounits
    )
    expect(
      await host.ledger.finalizeBudget({
        workspaceId: host.workspaceId,
        executionId: dispatch.executionId,
        source: { sourceId: 'parent-final', idempotencyKey: 'parent-final:finalize' },
      })
    ).toMatchObject({ settled: true, spentMicrounits: leadSpent + spent })
    expect((await readChildCostState(hooks)).outcome).toMatchObject({
      costState: 'settled',
      reported: {
        accounting: { sourceId: reported.accounting.sourceId, chargedMicrounits: spent },
      },
      reconciled: { result: 'within_reservation', reportedChargedMicrounits: spent },
      settled: { settledMicrounits: spent },
    })

    // Retrying and reopening change no money, no cost state, no publication, and send or start nothing.
    const afterSettlement = {
      rows: await rowsOf(host, dispatch),
      cost: stableSummary(await readChildCostState(hooks)),
    }
    expect(await host.composition.settleChildTerminalAccounting()).toEqual(settled)
    await host.reopenComposition()
    expect(await host.composition.settleChildTerminalAccounting()).toEqual(settled)
    await hooks.scanner.scan(host.composition.adapter)
    expect(host.composition.childTerminalSettlementBlocked).toBe(false)
    expect(await rowsOf(host, dispatch)).toEqual(afterSettlement.rows)
    expect(stableSummary(await readChildCostState(hooks))).toBe(afterSettlement.cost)
    expect(await publicationsOf(hooks)).toEqual(published)
    expect(counts()).toEqual(before)
  } finally {
    await host.close()
  }
}, 120000)
