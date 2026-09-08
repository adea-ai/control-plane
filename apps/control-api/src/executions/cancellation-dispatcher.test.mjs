import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { RestateExecutionWorkflowDispatcher } from './execution-acceptance.service.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'execution.cancel',
  payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
}
test('cancellation pins handler and idempotency identity through lost acknowledgement', async () => {
  const calls = []
  const dispatcher = new RestateExecutionWorkflowDispatcher({
    ingressUrl: 'http://restate.internal:8080/private',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (calls.length === 1) throw new Error('lost acknowledgement')
      return new Response(
        JSON.stringify({ status: 'PreviouslyAccepted', invocationId: 'inv_01JABC' }),
        { status: 202 }
      )
    },
  })
  await expect(dispatcher.cancel(request)).rejects.toThrow('Restate workflow submission failed')
  await dispatcher.cancel(request)
  expect(calls[0].url).toBe(
    `http://restate.internal:8080/private/execution-lifecycle/${request.payload.executionId}/cancelExecution/send`
  )
  expect(calls[0].init.headers['idempotency-key']).toBe(
    `${request.payload.executionId}:${request.commandId}`
  )
  expect(calls[0].init.body).toBe('{}')
  expect(calls[0].init.redirect).toBe('error')
  expect(calls[1].init.headers).toEqual(calls[0].init.headers)
  expect(calls[1].init.body).toBe(calls[0].init.body)
})
test.each([
  [200, '{}'],
  [409, '{}'],
  [500, '{}'],
  [202, '{}'],
  [202, 'not json'],
  [202, JSON.stringify({ status: 'Completed', invocationId: 'inv_01JABC' })],
  [202, JSON.stringify({ status: 'Accepted', invocationId: 'invalid' })],
  [202, 'x'.repeat(4097)],
])('cancellation rejects unconfirmed response with HTTP %s', async (status, body) => {
  const dispatcher = new RestateExecutionWorkflowDispatcher({
    ingressUrl: 'http://restate.internal:8080',
    fetch: async () => new Response(body, { status }),
  })
  await expect(dispatcher.cancel(request)).rejects.toThrow('Restate workflow submission failed')
})
