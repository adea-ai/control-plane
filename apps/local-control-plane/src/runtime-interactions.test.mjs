import { expect, test } from 'bun:test'
import { InMemoryInteractionRepository, InteractionService } from '@control-plane/domain'
import { LocalRuntimeInteractions } from './runtime-interactions.ts'

const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const executionId = `exe_${suffix}`
const attemptId = `att_${suffix}`
const interactionId = `int_${suffix}`
const command = {
  executionId,
  workspaceId: `wsp_${suffix}`,
  projectId: `prj_${suffix}`,
  callerPrincipalId: 'svc_owner',
  retentionExpiresAt: '2099-01-01T00:00:00.000Z',
}
const execution = {
  state: 'running',
  latestAttemptId: attemptId,
  correlation: { workspaceId: command.workspaceId, projectId: command.projectId },
}
const event = (kind = 'permission') => ({
  type: 'interaction',
  data: {
    interactionId,
    kind,
    allowedPrincipalIds: ['svc_attacker'],
    prompt: 'untrusted runtime text',
  },
})
function setup(overrides = {}) {
  const repository = new InMemoryInteractionRepository()
  const bridge = new LocalRuntimeInteractions(repository, {
    getByExecutionId: async () => command,
    getExecution: async () => execution,
    ...overrides,
  })
  return { repository, bridge }
}

test('terminal cleanup cancels only pending requests for its exact attempt and is replayable', async () => {
  const { repository, bridge } = setup()
  await bridge.record(executionId, attemptId, event())
  const pending = await repository.get(interactionId)
  const answeredId = `int_${suffix.slice(0, -1)}W`
  await repository.insert({ ...pending, interactionId: answeredId })
  const answered = await new InteractionService(repository).respond({
    interactionId: answeredId,
    executionId,
    attemptId,
    responseId: `cmd_${suffix}`,
    action: 'deny',
    respondingPrincipalId: 'svc_owner',
    expectedVersion: 1,
    respondedAt: new Date().toISOString(),
  })
  const other = {
    ...pending,
    interactionId: `int_${suffix.slice(0, -1)}X`,
    attemptId: `att_${suffix.slice(0, -1)}W`,
  }
  await repository.insert(other)
  await bridge.resolveTerminal(executionId, attemptId)
  const cancelled = await repository.get(interactionId)
  expect(cancelled).toMatchObject({ state: 'cancelled', version: 2 })
  expect(cancelled.resolvedAt).toBeString()
  expect(await repository.get(answeredId)).toEqual(answered)
  expect(await repository.get(other.interactionId)).toEqual(other)
  await bridge.resolveTerminal(executionId, attemptId)
  expect(await repository.get(interactionId)).toEqual(cancelled)
})

test('native interaction ownership comes from accepted command, not runtime data', async () => {
  const { repository, bridge } = setup()
  await bridge.record(executionId, attemptId, event())
  const stored = await repository.get(interactionId)
  expect(stored).toMatchObject({
    executionId,
    attemptId,
    kind: 'permission',
    allowedPrincipalIds: ['svc_owner'],
    allowedActions: ['grant', 'deny', 'cancel'],
    state: 'pending',
  })
  expect(stored.prompt.title).not.toBe('untrusted runtime text')
  expect(Date.parse(stored.expiresAt) - Date.parse(stored.requestedAt)).toBeLessThanOrEqual(900001)
  await bridge.record(executionId, attemptId, event())
  expect(await repository.get(interactionId)).toEqual(stored)
  await expect(bridge.record(executionId, attemptId, event('input'))).rejects.toThrow(
    'LOCAL_INTERACTION_ID_CONFLICT'
  )
})

test.each([
  { getByExecutionId: async () => undefined },
  { getExecution: async () => ({ ...execution, latestAttemptId: `att_${suffix.slice(0, -1)}W` }) },
  {
    getExecution: async () => ({
      ...execution,
      correlation: { ...execution.correlation, workspaceId: `wsp_${suffix.slice(0, -1)}W` },
    }),
  },
])('missing or mismatched accepted scope cannot create a request %#', async (overrides) => {
  const { bridge, repository } = setup(overrides)
  await expect(bridge.record(executionId, attemptId, event())).rejects.toThrow(
    'LOCAL_INTERACTION_SCOPE_MISSING'
  )
  expect(await repository.get(interactionId)).toBeUndefined()
})

test('runtime response requires the exact durably authorized response', async () => {
  const { bridge, repository } = setup()
  await bridge.record(executionId, attemptId, event('input'))
  const response = {
    interactionId,
    executionId,
    attemptId,
    responseId: `cmd_${suffix}`,
    action: 'input',
    value: { text: 'authorized' },
  }
  await expect(bridge.assertResponse(response)).rejects.toThrow(
    'LOCAL_INTERACTION_RESPONSE_UNCONFIRMED'
  )
  await new InteractionService(repository).respond({
    ...response,
    expectedVersion: 1,
    respondingPrincipalId: 'svc_owner',
    respondedAt: new Date().toISOString(),
  })
  await bridge.assertResponse(response)
  for (const changed of [
    { action: 'approve' },
    { value: { text: 'changed' } },
    { executionId: `exe_${suffix.slice(0, -1)}W` },
    { responseId: `cmd_${suffix.slice(0, -1)}W` },
  ])
    await expect(bridge.assertResponse({ ...response, ...changed })).rejects.toThrow(
      'LOCAL_INTERACTION_RESPONSE_UNCONFIRMED'
    )
})

test.each([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'cancelling',
  'reconciliation_required',
  'replaced-attempt',
])('retained response cannot drive a terminal or replaced execution: %s', async (state) => {
  let current = { ...execution, state: 'awaiting_input' }
  const { bridge, repository } = setup({ getExecution: async () => current })
  await bridge.record(executionId, attemptId, event('input'))
  const response = {
    interactionId,
    executionId,
    attemptId,
    responseId: `cmd_${suffix}`,
    action: 'input',
    value: 'authorized earlier',
  }
  await new InteractionService(repository).respond({
    ...response,
    expectedVersion: 1,
    respondingPrincipalId: 'svc_owner',
    respondedAt: new Date().toISOString(),
  })
  current =
    state === 'replaced-attempt'
      ? { ...current, latestAttemptId: `att_${suffix.slice(0, -1)}W` }
      : { ...current, state }
  await expect(bridge.assertResponse(response)).rejects.toThrow(
    'LOCAL_INTERACTION_RESPONSE_UNCONFIRMED'
  )
  await expect(bridge.record(executionId, attemptId, event())).rejects.toThrow(
    'LOCAL_INTERACTION_SCOPE_MISSING'
  )
})
