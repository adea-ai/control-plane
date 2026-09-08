import { expect, test } from 'bun:test'
import {
  ControlApiFixtures,
  ExecutionCancellationCommandSchema,
  ExecutionCancellationCommandResultSchema,
} from './control-api.ts'

const input = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'execution.cancel',
  payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
}

test('execution cancellation requires immutable command and workspace/project scope', () => {
  expect(ExecutionCancellationCommandSchema.parse(input)).toEqual(input)
  for (const field of [
    'commandId',
    'idempotencyKey',
    'workspaceId',
    'projectId',
    'caller',
    'payloadHash',
    'issuedAt',
  ]) {
    const candidate = { ...input }
    delete candidate[field]
    expect(ExecutionCancellationCommandSchema.safeParse(candidate).success).toBe(false)
  }
  expect(ExecutionCancellationCommandSchema.safeParse({ ...input, payload: {} }).success).toBe(
    false
  )
})

test('execution cancellation cannot supply runtime routing, leases or server authority', () => {
  for (const field of [
    'attemptId',
    'handleId',
    'runtimeConnectionId',
    'requestedAt',
    'expiresAt',
    'reason',
    'authenticatedPrincipalId',
  ]) {
    expect(
      ExecutionCancellationCommandSchema.safeParse({ ...input, [field]: 'caller-controlled' })
        .success
    ).toBe(false)
    expect(
      ExecutionCancellationCommandSchema.safeParse({
        ...input,
        payload: { ...input.payload, [field]: 'caller-controlled' },
      }).success
    ).toBe(false)
  }
})

test('cancellation acceptance cannot claim native completion or expose runtime internals', () => {
  const response = {
    contractVersion: input.contractVersion,
    requestId: input.requestId,
    correlation: input.correlation,
    data: {
      commandId: input.commandId,
      executionId: input.payload.executionId,
      status: 'accepted',
      replayed: false,
    },
  }
  expect(ExecutionCancellationCommandResultSchema.parse(response)).toEqual(response)
  for (const status of ['cancelled', 'completed', 'timed_out']) {
    expect(
      ExecutionCancellationCommandResultSchema.safeParse({
        ...response,
        data: { ...response.data, status },
      }).success
    ).toBe(false)
  }
  expect(
    ExecutionCancellationCommandResultSchema.safeParse({
      ...response,
      data: { ...response.data, handleId: 'private-handle' },
    }).success
  ).toBe(false)
})
