import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  PiDurableLeadDispatchResponseSchema,
  PiDurableLeadStatusResponseSchema,
} from '@control-plane/runtime-sdk'
import {
  DurablePiDurableLeadService,
  PiDurableLeadError,
  SqlitePiDurableLeadReceiptStore,
} from './pi-durable-lead.service.ts'
import {
  PreChangeDispatchResponseSchema,
  PreChangeStatusResponseSchema,
} from './lead-pre-change-client.fixture.mjs'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const deadlineAt = '2027-01-01T00:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const principalId = 'svc_target-test'
const hash = (value) =>
  createHash('sha256')
    .update(canonicalJsonStringify(value) ?? 'null')
    .digest('hex')
const requestedTarget = {
  sessionId: id('ses'),
  taskId: '00000000-0000-4000-8000-0000000000f1',
  generation: 3,
}

function harness(options = {}) {
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const workspaceId = plan.correlation.workspaceId
  const projectId = plan.correlation.projectId
  const startRequest = {
    executionId: id('exe'),
    attemptId: id('att'),
    idempotencyKey: 'target-message:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId,
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${id('att')}`,
      currency: 'USD',
      maximumMicrounits: 10000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-lead-authority/v1',
    workspaceId,
    intentId,
    admissionDigest: `sha256:${'a'.repeat(64)}`,
    startRequest,
    admittedAttempt: {
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
    },
    deadlineAt,
    allowedPrincipalIds: [principalId],
  }
  const principal = {
    kind: 'internal_service',
    principalId,
    projectIds: projectId ? [projectId] : [],
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
    workspaceIds: [workspaceId],
  }
  // Real durable store on an isolated in-memory database: retention,
  // idempotency, and echo go through the production JSON record path,
  // never a hand-rolled fake.
  const receipts = new SqlitePiDurableLeadReceiptStore(new DatabaseSync(':memory:'))
  const calls = { starts: 0, cancels: 0, childStops: [] }
  let confirmed = false
  const handle = {
    handleId: 'hEC01JABCDEF0123456789ABCDEFGH',
    attemptId: id('att'),
    externalSessionId: id('ses'),
    startedAt: at,
  }
  const adapter = {
    start: async () => {
      calls.starts += 1
      return handle
    },
    status: async () => ({
      handle,
      state: calls.cancels > 0 ? (confirmed ? 'cancelled' : 'cancelling') : 'running',
      observedAt: at,
      ...(options.observedGeneration ? { observedGeneration: options.observedGeneration } : {}),
    }),
    progress: async function* () {},
    cancel: async () => {
      calls.cancels += 1
      const generation = options.cancelGeneration ?? options.observedGeneration
      return {
        handle,
        state: confirmed ? 'cancelled' : 'cancelling',
        observedAt: at,
        ...(generation ? { observedGeneration: generation } : {}),
      }
    },
  }
  const service = new DurablePiDurableLeadService({
    authority: {
      resolveIntent: async () => admission,
      assertCurrent: async () => undefined,
    },
    receipts,
    adapter,
    // A spying delegation service stays configured on the ordinary path
    // precisely so an accidental child-cancel call would fail the
    // zero-call assertions below. Omitting it would not catch such a
    // regression. The explicit authorized cascade path stays covered by
    // the existing service test and the delegation suite.
    delegationService: {
      cancelChildren: async (input) => {
        calls.childStops.push(input)
        return { cancelled: [], state: 'cancelled' }
      },
    },
  })
  const envelope = (operation, payload, key = 'target-command:one') => ({
    caller: { servicePrincipalId: principalId },
    contractVersion: options.contractVersion ?? { major: 3, minor: 1 },
    requestId: id('req'),
    commandId: id('cmd'),
    workspaceId,
    ...(projectId ? { projectId } : {}),
    correlation: { traceId: id('trc') },
    idempotencyKey: key,
    payloadHash: hash(payload),
    operation,
    issuedAt: at,
    payload,
  })
  const read = (operation, parameters) => ({
    caller: { servicePrincipalId: principalId },
    contractVersion: options.contractVersion ?? { major: 3, minor: 1 },
    requestId: id('req'),
    workspaceId,
    ...(projectId ? { projectId } : {}),
    correlation: { traceId: id('trc') },
    operation,
    requestedAt: at,
    parameters,
  })
  const confirm = () => {
    confirmed = true
  }
  return { service, envelope, read, principal, calls, confirm }
}

const codeOf = async (work) => {
  try {
    await work()
  } catch (error) {
    if (error instanceof PiDurableLeadError) return error.code
    throw error
  }
  throw new Error('expected PiDurableLeadError')
}

/**
 * control-plane#935: requested-target handling at the lead service.
 * Dispatch retains the request target on the immutable receipt; lookup
 * and status echo it; redelivery naming another target conflicts at the
 * command digest instead of rebinding. A retained claim is never an
 * observation: forged targets read back as requests and cannot become
 * runtime bindings, authorize effects, or retarget execution. Ordinary
 * lead-stop performs zero child-cancel calls (spied, not omitted).
 */
test('935: dispatch retains the target; lookup and status echo it', async () => {
  const { service, envelope, read, principal } = harness()
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget }),
    principal
  )
  expect(dispatched.data.requestedTarget).toEqual(requestedTarget)
  const lookup = await service.lookup(read('pi-durable.lead.lookup', { intentId }), principal)
  expect(lookup.data.receipt).toMatchObject({ requestedTarget })
  const status = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(status.data).toMatchObject({ requestedTarget })
})

test('935: redelivery cannot rebind the retained target', async () => {
  const { service, envelope, principal } = harness()
  await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget }),
    principal
  )
  const other = { ...requestedTarget, generation: 9 }
  // Same idempotency key with a changed target: command conflict, never a
  // silent rebinding.
  expect(
    await codeOf(() =>
      service.dispatch(
        envelope('pi-durable.lead.dispatch', { intentId, requestedTarget: other }),
        principal
      )
    )
  ).toBe('PI_LEAD_COMMAND_CONFLICT')
  // Fresh key with a changed target: returns the ORIGINAL retained receipt
  // unchanged — the claim never moves under the same dispatch.
  const replayed = await service.dispatch(
    envelope(
      'pi-durable.lead.dispatch',
      { intentId, requestedTarget: other },
      'target-command:two'
    ),
    principal
  )
  expect(replayed.data.requestedTarget).toEqual(requestedTarget)
})

test('935: cancellation reports pending until the engine confirms', async () => {
  const { service, envelope, read, principal, calls, confirm } = harness()
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget }),
    principal
  )
  // The fake engine never confirms: the intent stays pending, and every
  // status read says so — never settled, never lost.
  await service.cancel(
    envelope(
      'pi-durable.lead.cancel',
      { dispatchId: dispatched.data.dispatchId },
      'target-cancel:pending'
    ),
    principal
  )
  expect(calls.cancels).toBe(1)
  const pending = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(pending.data.state).toBe('cancelling')
  expect(pending.data).toMatchObject({ requestedTarget })
  confirm()
  const settled = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(settled.data.state).toBe('cancelled')
  expect(settled.data).toMatchObject({ requestedTarget })
})

test('935: forged requestedTarget with a valid intent is never an observation', async () => {
  // Desktop-credentialed bypass of client preflight, fully retained: the
  // forged claim is wellformed and the intent is valid, so admission keeps
  // it as a request. It must never become a runtime-owned observation,
  // authorize an effect, or retarget execution: the observed session stays
  // the adapter-reported one (deliberately distinct here), the handle
  // binding stays pinned to the admitted attempt, and status never merges
  // the two.
  const forged = {
    sessionId: 'ses_02JABCDEF0123456789ABCDEH',
    taskId: '11111111-2222-4333-8444-555555555555',
    generation: 9999,
  }
  const { service, envelope, read, principal } = harness()
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget: forged }),
    principal
  )
  expect(dispatched.data.requestedTarget).toEqual(forged)
  const lookup = await service.lookup(read('pi-durable.lead.lookup', { intentId }), principal)
  expect(lookup.data.receipt).toMatchObject({ requestedTarget: forged })
  expect(lookup.data.receipt.runtimeSessionId).toBe(id('ses'))
  expect(lookup.data.receipt.runtimeSessionId).not.toBe(forged.sessionId)
  const status = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(status.data).toMatchObject({ requestedTarget: forged })
  expect(status.data.runtimeSessionId).toBe(id('ses'))
})

test('935: observedTarget binds server-owned session and plan task', async () => {
  // The observed target comes ONLY from server-held records: the
  // adapter-observed execution session plus the authority-resolved plan
  // task. The claimed task is deliberately different — the observed
  // triple must follow the records, never the claim.
  const { service, envelope, principal } = harness()
  const claimed = {
    sessionId: 'ses_02JABCDEF0123456789ABCDEH',
    taskId: '11111111-2222-4333-8444-555555555555',
    generation: 7,
  }
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget: claimed }),
    principal
  )
  expect(dispatched.data.requestedTarget).toEqual(claimed)
  expect(dispatched.data.observedTarget).toBeDefined()
  expect(dispatched.data.observedTarget.taskId).not.toBe(claimed.taskId)
  expect(dispatched.data.observedTarget.sessionId).toBe(dispatched.data.runtimeSessionId)
})

test('935: the receipt carries the runtime-observed generation, never the claimed one', async () => {
  // The claim stays a claim: the caller's number is echoed on the receipt as
  // the request's target and never becomes an observation. The observation is
  // the runtime's own identity for the attempt that owns the receipt.
  const observedGeneration = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: id('att'),
    turnKey: `pi-turn:${id('att')}:initial`,
    inferenceId: 'pi-generation:1',
    inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
  }
  const { service, envelope, principal } = harness({ observedGeneration })
  const claimed = {
    sessionId: 'ses_02JABCDEF0123456789ABCDEH',
    taskId: '11111111-2222-4333-8444-555555555555',
    generation: 7,
  }
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget: claimed }),
    principal
  )
  expect(dispatched.data.requestedTarget).toEqual(claimed)
  expect(dispatched.data.observedTarget.generation).toEqual(observedGeneration)
  // The claimed number is not the observation, and never becomes one.
  expect(dispatched.data.observedTarget.generation).not.toEqual(claimed.generation)
})

test('935: a generation observed for another attempt is fenced at the control boundary', async () => {
  // A runtime that reports a generation observed for another attempt is
  // reporting a late old-attempt event. The control is refused instead of
  // publishing an outcome for the wrong attempt.
  const foreignGeneration = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: 'att_01JABCDEF0123456789ABCDEFH',
    turnKey: `pi-turn:att_01JABCDEF0123456789ABCDEFH:initial`,
    inferenceId: 'pi-generation:late',
    inferenceKey: `pi-turn:att_01JABCDEF0123456789ABCDEFH:initial:pi-generation:late`,
  }
  const { service, envelope, principal, calls } = harness({
    observedGeneration: {
      schemaVersion: 'runtime-observed-generation/v1',
      attemptId: id('att'),
      turnKey: `pi-turn:${id('att')}:initial`,
      inferenceId: 'pi-generation:1',
      inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
    },
    cancelGeneration: foreignGeneration,
  })
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget }),
    principal
  )
  expect(
    await codeOf(() =>
      service.cancel(
        envelope(
          'pi-durable.lead.cancel',
          { dispatchId: dispatched.data.dispatchId },
          'target-cancel:late-generation'
        ),
        principal
      )
    )
  ).toBe('PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN')
  expect(calls.cancels).toBe(1)
  // The lead-stop itself never cascaded to children.
  expect(calls.childStops).toHaveLength(0)
})

test('935: ordinary lead-stop performs zero child-cancel calls', async () => {
  // CP935 first clause: ordinary lead-stop stops the lead execution only.
  // The spying delegation service is deliberately configured: the proof
  // is its exact-zero call count, which catches any accidental child-cancel
  // regression (omitting the spy would not). Explicit authorized cascade
  // stays separate (existing service test + delegation suite).
  const { service, envelope, principal, calls } = harness()
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget }),
    principal
  )
  await service.cancel(
    envelope(
      'pi-durable.lead.cancel',
      { dispatchId: dispatched.data.dispatchId },
      'target-cancel:one'
    ),
    principal
  )
  expect(calls.cancels).toBe(1)
  expect(calls.childStops).toHaveLength(0)
})

test('935: an old consumer parses the new server response with the pre-3.1 strict shapes', async () => {
  // Rollout compatibility: the installed Adea SDK validates a lead response
  // with the pre-3.1 strict target and runtime-status shapes and maps a parse
  // failure to an invalid response. A consumer that advertised 3.0 must
  // therefore receive a response those shapes accept.
  const observedGeneration = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: id('att'),
    turnKey: `pi-turn:${id('att')}:initial`,
    inferenceId: 'pi-generation:1',
    inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
  }
  const { service, envelope, read, principal } = harness({
    observedGeneration,
    contractVersion: { major: 3, minor: 0 },
  })
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget }),
    principal
  )
  const status = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  // The installed consumer's own validation accepts the response.
  expect(() => PreChangeDispatchResponseSchema.parse(dispatched)).not.toThrow()
  expect(() => PreChangeStatusResponseSchema.parse(status)).not.toThrow()
  // The observed generation is not published to a consumer that cannot parse
  // it: it is absent from the observed target and from the runtime status.
  expect(dispatched.data.observedTarget).not.toHaveProperty('generation')
  expect(status.data.observedTarget).not.toHaveProperty('generation')
  expect(status.data.status).not.toHaveProperty('observedGeneration')
  // The gate is required, not cosmetic: the same response with the
  // generation published is rejected by the installed consumer's shapes.
  expect(() =>
    PreChangeStatusResponseSchema.parse({
      ...status,
      data: {
        ...status.data,
        observedTarget: { ...status.data.observedTarget, generation: observedGeneration },
        status: { ...status.data.status, observedGeneration },
      },
    })
  ).toThrow()
})

test('935: an updated consumer receives and parses the observed generation', async () => {
  const observedGeneration = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: id('att'),
    turnKey: `pi-turn:${id('att')}:initial`,
    inferenceId: 'pi-generation:1',
    inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
  }
  const { service, envelope, read, principal } = harness({ observedGeneration })
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, requestedTarget }),
    principal
  )
  const status = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(dispatched.data.observedTarget.generation).toEqual(observedGeneration)
  expect(status.data.status.observedGeneration).toEqual(observedGeneration)
  // The current consumer's own validation accepts the response.
  expect(() => PiDurableLeadDispatchResponseSchema.parse(dispatched)).not.toThrow()
  expect(() => PiDurableLeadStatusResponseSchema.parse(status)).not.toThrow()
})
