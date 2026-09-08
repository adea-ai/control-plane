import { expect, test } from 'bun:test'
import { DurableInteractionDeliveryService } from './interaction-delivery.ts'
import { InMemoryInteractionRepository, InteractionService } from './interactions.ts'

const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const input = {
  workspaceId: `wsp_${suffix}`,
  projectId: `prj_${suffix}`,
  executionId: `exe_${suffix}`,
  attemptId: `att_${suffix}`,
  interactionId: `int_${suffix}`,
  responseId: `cmd_${suffix}`,
  action: 'input',
  value: { text: 'continue' },
  expectedVersion: 1,
}
async function setup() {
  const interactions = new InMemoryInteractionRepository()
  await new InteractionService(interactions).request({
    interactionId: input.interactionId,
    executionId: input.executionId,
    attemptId: input.attemptId,
    kind: 'input',
    prompt: { title: 'Runtime input requested' },
    allowedActions: ['input', 'cancel'],
    allowedPrincipalIds: ['svc_owner'],
    requestedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-08T01:00:00.000Z',
  })
  const execution = {
    state: 'awaiting_input',
    latestAttemptId: input.attemptId,
    correlation: { workspaceId: input.workspaceId, projectId: input.projectId },
  }
  const commands = {
    getByExecutionId: async () => ({ executionId: input.executionId, ...execution.correlation }),
    getExecution: async () => execution,
  }
  const signals = []
  const dispatcher = {
    deliver: async (request) => {
      signals.push(request)
    },
  }
  const service = new DurableInteractionDeliveryService(
    interactions,
    commands,
    dispatcher,
    () => '2026-09-08T00:10:00.000Z'
  )
  return { interactions, commands, execution, signals, dispatcher, service }
}

test('ambiguous delivery retains the response and retries its exact stored identity', async () => {
  const { interactions, commands, dispatcher, signals, service } = await setup()
  dispatcher.deliver = async (request) => {
    expect(await interactions.get(input.interactionId)).toEqual(request)
    signals.push(request)
    throw new Error('lost acknowledgement')
  }
  await expect(service.respond(input, 'svc_owner')).rejects.toThrow('lost acknowledgement')
  expect(await interactions.get(input.interactionId)).toMatchObject({
    state: 'responded',
    version: 2,
  })
  const recovered = new DurableInteractionDeliveryService(
    interactions,
    commands,
    {
      deliver: async (request) => {
        signals.push(request)
      },
    },
    () => '2026-09-08T00:20:00.000Z'
  )
  expect(await recovered.respond(input, 'svc_owner')).toEqual(signals[0])
  expect(signals).toEqual([signals[0], signals[0]])
})

test.each(['workspaceId', 'projectId', 'executionId', 'attemptId'])(
  'wrong %s cannot replay an answered interaction',
  async (field) => {
    const { service, signals } = await setup()
    await service.respond(input, 'svc_owner')
    await expect(
      service.respond({ ...input, [field]: `${input[field].slice(0, -1)}W` }, 'svc_owner')
    ).rejects.toThrow('INTERACTION_DELIVERY_SCOPE_REJECTED')
    expect(signals).toHaveLength(1)
  }
)

test('principal and payload spoofing cannot persist or signal a response', async () => {
  const { service, interactions, signals } = await setup()
  await expect(service.respond(input, 'svc_other')).rejects.toThrow(
    'INTERACTION_DELIVERY_SCOPE_REJECTED'
  )
  await expect(
    service.respond({ ...input, respondingPrincipalId: 'svc_owner' }, 'svc_other')
  ).rejects.toThrow()
  expect(await interactions.get(input.interactionId)).toMatchObject({ state: 'pending' })
  expect(signals).toEqual([])
})

test.each([
  'completed',
  'cancelled',
  'failed',
  'timed_out',
  'cancelling',
  'reconciliation_required',
  'replaced',
])('inactive execution rejects response delivery: %s', async (state) => {
  const { service, execution, signals } = await setup()
  if (state === 'replaced') execution.latestAttemptId = `att_${suffix.slice(0, -1)}W`
  else execution.state = state
  await expect(service.respond(input, 'svc_owner')).rejects.toThrow(
    'INTERACTION_DELIVERY_EXECUTION_INACTIVE'
  )
  expect(signals).toEqual([])
})
