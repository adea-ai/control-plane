import { expect, test } from 'bun:test'
import { RestateExecutionWorkflowDispatcher } from './execution-acceptance.service.ts'

const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const request = {
  interactionId: `int_${suffix}`,
  executionId: `exe_${suffix}`,
  attemptId: `att_${suffix}`,
  kind: 'input',
  prompt: { title: 'Runtime input requested' },
  allowedActions: ['input'],
  allowedPrincipalIds: ['svc_owner'],
  state: 'responded',
  version: 2,
  requestedAt: '2026-09-08T00:00:00.000Z',
  expiresAt: '2026-09-08T01:00:00.000Z',
  response: {
    responseId: `cmd_${suffix}`,
    action: 'input',
    value: { text: 'continue' },
    respondingPrincipalId: 'svc_owner',
    respondedAt: '2026-09-08T00:10:00.000Z',
  },
}

test('response delivery pins Restate handler, body and idempotency identity across retries', async () => {
  const calls = []
  const dispatcher = new RestateExecutionWorkflowDispatcher({
    ingressUrl: 'http://restate.internal:8080/private',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({
          status: calls.length === 1 ? 'Accepted' : 'PreviouslyAccepted',
          invocationId: 'inv_01JABC',
        }),
        {
          status: 202,
        }
      )
    },
  })
  await dispatcher.deliver(request)
  await dispatcher.deliver(request)
  expect(calls).toHaveLength(2)
  expect(calls[0].url).toBe(
    `http://restate.internal:8080/private/execution-lifecycle/${request.executionId}/respondToInteraction/send`
  )
  expect(calls[0].init.headers['idempotency-key']).toBe(
    `${request.interactionId}:${request.response.responseId}`
  )
  expect(calls[0].init.redirect).toBe('error')
  expect(JSON.parse(calls[0].init.body)).toEqual({
    interactionId: request.interactionId,
    responseId: request.response.responseId,
    action: 'input',
    value: request.response.value,
  })
  expect(calls[1].init.body).toBe(calls[0].init.body)
  expect(calls[1].init.headers).toEqual(calls[0].init.headers)
  await dispatcher.deliver({ ...request, interactionId: `int_${suffix.slice(0, -1)}W` })
  expect(calls[2].init.headers['idempotency-key']).not.toBe(
    calls[0].init.headers['idempotency-key']
  )
})

test.each([409, 500, 200])(
  'response delivery does not treat HTTP %s as accepted',
  async (status) => {
    const dispatcher = new RestateExecutionWorkflowDispatcher({
      ingressUrl: 'http://restate.internal:8080',
      fetch: async () => new Response('{}', { status }),
    })
    await expect(dispatcher.deliver(request)).rejects.toThrow('Restate workflow submission failed')
  }
)

test('pending records cannot be dispatched', async () => {
  let calls = 0
  const dispatcher = new RestateExecutionWorkflowDispatcher({
    ingressUrl: 'http://restate.internal:8080',
    fetch: async () => {
      calls++
      throw new Error('unexpected')
    },
  })
  await expect(
    dispatcher.deliver({ ...request, state: 'pending', response: undefined })
  ).rejects.toThrow()
  expect(calls).toBe(0)
})
