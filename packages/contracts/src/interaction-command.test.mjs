import { expect, test } from 'bun:test'
import {
  ControlApiFixtures,
  InteractionResponseCommandSchema,
  InteractionResponseCommandResultSchema,
} from './control-api.ts'

const base = ControlApiFixtures.executionAcceptance.request
const input = {
  ...base,
  operation: 'interaction.respond',
  payload: {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    interactionId: 'int_01JABCDEF0123456789ABCDEFG',
    expectedVersion: 1,
    action: 'input',
    value: 'continue',
  },
}

test('interaction commands carry complete authenticated-command and attempt scope', () => {
  expect(InteractionResponseCommandSchema.parse(input)).toEqual(input)
  for (const field of [
    'commandId',
    'idempotencyKey',
    'workspaceId',
    'projectId',
    'payloadHash',
    'caller',
  ]) {
    const omitted = { ...input }
    delete omitted[field]
    expect(InteractionResponseCommandSchema.safeParse(omitted).success).toBe(false)
  }
  for (const field of ['executionId', 'attemptId', 'interactionId', 'expectedVersion']) {
    const payload = { ...input.payload }
    delete payload[field]
    expect(InteractionResponseCommandSchema.safeParse({ ...input, payload }).success).toBe(false)
  }
})

test('interaction commands reject caller-supplied response authority and unknown fields', () => {
  for (const field of [
    'respondingPrincipalId',
    'respondedAt',
    'responseId',
    'allowedPrincipalIds',
  ]) {
    expect(
      InteractionResponseCommandSchema.safeParse({ ...input, [field]: 'spoofed' }).success
    ).toBe(false)
    expect(
      InteractionResponseCommandSchema.safeParse({
        ...input,
        payload: { ...input.payload, [field]: 'spoofed' },
      }).success
    ).toBe(false)
  }
})

test('interaction command input limit counts UTF-8 JSON bytes and preserves explicit null', () => {
  const parse = (value, action = 'input') =>
    InteractionResponseCommandSchema.safeParse({
      ...input,
      payload: { ...input.payload, action, value },
    }).success
  expect(parse(null)).toBe(true)
  expect(parse(undefined)).toBe(false)
  expect(parse('é'.repeat(4095))).toBe(true)
  expect(parse('é'.repeat(4096))).toBe(false)
  expect(parse(undefined, 'deny')).toBe(true)
  expect(parse(null, 'deny')).toBe(false)
})

test('public acknowledgement cannot imply runtime completion or leak stored response content', () => {
  const result = {
    contractVersion: base.contractVersion,
    requestId: base.requestId,
    correlation: base.correlation,
    data: {
      commandId: base.commandId,
      responseId: base.commandId,
      executionId: input.payload.executionId,
      attemptId: input.payload.attemptId,
      interactionId: input.payload.interactionId,
      status: 'accepted',
      replayed: false,
    },
  }
  expect(InteractionResponseCommandResultSchema.parse(result)).toEqual(result)
  expect(
    InteractionResponseCommandResultSchema.safeParse({
      ...result,
      data: { ...result.data, status: 'completed' },
    }).success
  ).toBe(false)
  expect(
    InteractionResponseCommandResultSchema.safeParse({
      ...result,
      data: { ...result.data, value: 'private input' },
    }).success
  ).toBe(false)
})
