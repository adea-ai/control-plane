import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  DurableExecutionCancellationService,
  executionCancellationScopeKey,
} from './execution-cancellation-command.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'execution.cancel',
  payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
}
const principal = request.caller.servicePrincipalId
function fixture() {
  const records = new Map()
  const sent = []
  let state = 'running'
  let loseAck = false
  const receipts = {
    get: async (scope) => structuredClone(records.get(executionCancellationScopeKey(scope))),
    reserve: async (value) => {
      const key = executionCancellationScopeKey(value.request)
      const existing = records.get(key)
      if (!existing) records.set(key, structuredClone(value))
      return { receipt: structuredClone(existing ?? value), inserted: !existing }
    },
    markAccepted: async (scope, at) => {
      const value = records.get(executionCancellationScopeKey(scope))
      value.acceptedAt ??= at
      return structuredClone(value)
    },
  }
  const service = () =>
    new DurableExecutionCancellationService(
      receipts,
      {
        getByExecutionId: async () => ({
          executionId: request.payload.executionId,
          callerPrincipalId: principal,
          workspaceId: request.workspaceId,
          projectId: request.projectId,
        }),
        getExecution: async () => ({
          executionId: request.payload.executionId,
          state,
          correlation: { workspaceId: request.workspaceId, projectId: request.projectId },
        }),
      },
      {
        cancel: async (stored) => {
          sent.push(structuredClone(stored))
          if (loseAck) throw new Error('LOST_ACK')
        },
      },
      () => '2026-09-08T07:00:00.000Z'
    )
  return {
    records,
    sent,
    service,
    setState: (value) => {
      state = value
    },
    loseAck: (value) => {
      loseAck = value
    },
  }
}
test('lost ACK replay retains the first identity across service reconstruction and terminal state', async () => {
  const f = fixture()
  f.loseAck(true)
  await expect(f.service().cancel(request, principal)).rejects.toThrow('LOST_ACK')
  expect(f.records.size).toBe(1)
  f.setState('cancelled')
  f.loseAck(false)
  const replay = { ...request, commandId: 'cmd_01JABCDEF0123456789ABCDEFH' }
  expect((await f.service().cancel(replay, principal)).data).toMatchObject({
    commandId: request.commandId,
    replayed: true,
    status: 'accepted',
  })
  expect(f.sent).toEqual([request, request])
  await f.service().cancel(replay, principal)
  expect(f.sent).toHaveLength(2)
})
test('scope and caller rejection do not reserve an identity or send a signal', async () => {
  for (const changed of [
    { ...request, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
    { ...request, projectId: 'prj_01JABCDEF0123456789ABCDEFH' },
    { ...request, caller: { ...request.caller, servicePrincipalId: 'svc_other' } },
    { ...request, payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFH' } },
  ]) {
    const f = fixture()
    await expect(f.service().cancel(changed, changed.caller.servicePrincipalId)).rejects.toThrow(
      'EXECUTION_CANCELLATION_SCOPE_REJECTED'
    )
    expect(f.records.size).toBe(0)
    expect(f.sent).toHaveLength(0)
  }
  await expect(fixture().service().cancel(request, 'svc_other')).rejects.toThrow(
    'EXECUTION_CANCELLATION_CALLER_MISMATCH'
  )
})
test('new cancellation cannot claim already-terminal work', async () => {
  for (const state of ['completed', 'failed', 'cancelled', 'timed_out']) {
    const f = fixture()
    f.setState(state)
    await expect(f.service().cancel(request, principal)).rejects.toThrow(
      'EXECUTION_CANCELLATION_EXECUTION_INACTIVE'
    )
    expect(f.records.size).toBe(0)
  }
})
test('a reused hash cannot hide a conflicting stored execution target', async () => {
  const f = fixture()
  f.records.set(executionCancellationScopeKey(request), {
    request: { ...request, payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFH' } },
  })
  await expect(f.service().cancel(request, principal)).rejects.toThrow(
    'EXECUTION_CANCELLATION_PAYLOAD_CONFLICT'
  )
  expect(f.sent).toHaveLength(0)
})
test('concurrent retries reserve one immutable request and deliver the same signal identity', async () => {
  const f = fixture()
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      f
        .service()
        .cancel({ ...request, commandId: `cmd_${String(index).padStart(26, '0')}` }, principal)
    )
  )
  expect(f.records.size).toBe(1)
  expect(new Set(results.map(({ data }) => data.commandId)).size).toBe(1)
  for (const sent of f.sent) expect(sent).toEqual(f.sent[0])
})
