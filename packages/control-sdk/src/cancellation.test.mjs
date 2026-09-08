import { expect, test } from 'bun:test'
import { ControlApiFixtures, ControlPlaneClient } from './index.ts'
test('SDK cancellation validates request and acceptance without claiming native completion', async () => {
  const command = {
    ...ControlApiFixtures.executionAcceptance.request,
    operation: 'execution.cancel',
    payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
  }
  const result = {
    contractVersion: command.contractVersion,
    requestId: command.requestId,
    correlation: command.correlation,
    data: {
      commandId: command.commandId,
      executionId: command.payload.executionId,
      status: 'accepted',
      replayed: false,
    },
  }
  const calls = []
  let status = 'accepted'
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.test/root/',
    credential: 'cancel-token',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return Response.json({ ...result, data: { ...result.data, status } }, { status: 202 })
    },
  })
  expect(await client.cancelExecution(command)).toEqual(result)
  expect(calls[0].url).toBe('https://control-plane.test/root/v1/executions/cancel')
  expect(calls[0].init.headers.authorization).toBe('Bearer cancel-token')
  expect(JSON.parse(calls[0].init.body)).toEqual(command)
  await expect(
    client.cancelExecution({ ...command, payload: { ...command.payload, handleId: 'private' } })
  ).rejects.toThrow()
  expect(calls).toHaveLength(1)
  status = 'cancelled'
  await expect(client.cancelExecution(command)).rejects.toThrow()
})
