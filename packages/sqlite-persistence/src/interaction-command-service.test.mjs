import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  DurableInteractionCommandService,
  DurableInteractionDeliveryService,
  InteractionService,
} from '@control-plane/domain'
import {
  SqliteInteractionCommandRepository,
  SqliteInteractionRepository,
  SqlitePersistenceProvider,
} from './index.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'interaction.respond',
  payload: {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    interactionId: 'int_01JABCDEF0123456789ABCDEFG',
    expectedVersion: 1,
    action: 'input',
    value: { text: 'continue' },
  },
}
const owner = request.caller.servicePrincipalId
const now = () => '2026-09-08T00:10:00.000Z'
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-interaction-command-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  const execution = {
    state: 'awaiting_input',
    latestAttemptId: request.payload.attemptId,
    correlation: { workspaceId: request.workspaceId, projectId: request.projectId },
  }
  const commands = {
    getByExecutionId: async () => ({
      ...execution.correlation,
      executionId: request.payload.executionId,
    }),
    getExecution: async () => execution,
  }
  const signals = []
  const dispatcher = {
    deliver: async (response) => {
      signals.push(response)
    },
  }
  const make = () => {
    const receipts = new SqliteInteractionCommandRepository(provider)
    const interactions = new SqliteInteractionRepository(provider)
    return {
      receipts,
      interactions,
      service: new DurableInteractionCommandService(
        receipts,
        new DurableInteractionDeliveryService(interactions, commands, dispatcher, now),
        now
      ),
    }
  }
  try {
    await provider.migrate()
    await new InteractionService(make().interactions).request({
      executionId: request.payload.executionId,
      attemptId: request.payload.attemptId,
      interactionId: request.payload.interactionId,
      kind: 'input',
      prompt: { title: 'Input requested' },
      allowedActions: ['input', 'cancel'],
      allowedPrincipalIds: [owner],
      requestedAt: '2026-09-08T00:00:00.000Z',
      expiresAt: '2026-09-08T01:00:00.000Z',
    })
    await run({
      make,
      execution,
      dispatcher,
      signals,
      reopen: async () => {
        provider.close()
        provider = new SqlitePersistenceProvider({ path })
        await provider.migrate()
      },
    })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('lost signal ACK survives SQLite reopen and uses the first command ID on retry', async () =>
  fixture(async ({ make, dispatcher, signals, reopen, execution }) => {
    dispatcher.deliver = async (response) => {
      signals.push(response)
      throw new Error('lost ACK')
    }
    await expect(make().service.respond(request, owner)).rejects.toThrow('lost ACK')
    expect((await make().receipts.get(request)).acceptedAt).toBeUndefined()
    await reopen()
    dispatcher.deliver = async (response) => {
      signals.push(response)
    }
    const retry = { ...request, commandId: `${request.commandId.slice(0, -1)}H` }
    const accepted = await make().service.respond(retry, owner)
    expect(accepted.data).toMatchObject({
      commandId: request.commandId,
      responseId: request.commandId,
      replayed: true,
    })
    expect(signals).toHaveLength(2)
    expect(signals[1]).toEqual(signals[0])
    expect((await make().receipts.get(request)).acceptedAt).toBe(now())
    execution.state = 'completed'
    await reopen()
    expect((await make().service.respond(retry, owner)).data).toEqual(accepted.data)
    expect(signals).toHaveLength(2)
  }))

test('actual payload conflict is rejected even if caller preserves the claimed hash', async () =>
  fixture(async ({ make, signals }) => {
    await make().service.respond(request, owner)
    await expect(
      make().service.respond(
        { ...request, payload: { ...request.payload, value: { text: 'different' } } },
        owner
      )
    ).rejects.toThrow('INTERACTION_COMMAND_PAYLOAD_CONFLICT')
    expect(signals).toHaveLength(1)
    expect((await make().receipts.get(request)).request.payload).toEqual(request.payload)
  }))

test('unauthorized callers cannot reserve a key or replay an accepted receipt', async () =>
  fixture(async ({ make, signals }) => {
    await expect(make().service.respond(request, 'svc_other')).rejects.toThrow(
      'INTERACTION_COMMAND_CALLER_MISMATCH'
    )
    const spoofed = { ...request, caller: { servicePrincipalId: 'svc_other' } }
    await expect(make().service.respond(spoofed, 'svc_other')).rejects.toThrow(
      'INTERACTION_DELIVERY_SCOPE_REJECTED'
    )
    expect(await make().receipts.get(spoofed)).toBeUndefined()
    expect(await make().receipts.get(request)).toBeUndefined()
    await make().service.respond(request, owner)
    await expect(make().service.respond(spoofed, 'svc_other')).rejects.toThrow(
      'INTERACTION_DELIVERY_SCOPE_REJECTED'
    )
    expect(signals).toHaveLength(1)
  }))

test('concurrent different command IDs reserve one response identity and one first acceptance', async () =>
  fixture(async ({ make, signals }) => {
    const results = await Promise.all(
      [request, { ...request, commandId: `${request.commandId.slice(0, -1)}H` }].map((input) =>
        make().service.respond(input, owner)
      )
    )
    expect(new Set(results.map((result) => result.data.responseId)).size).toBe(1)
    expect(results.filter((result) => !result.data.replayed)).toHaveLength(1)
    expect(new Set(signals.map((signal) => signal.response.responseId)).size).toBe(1)
  }))

test('failed receipt acknowledgement does not invent success and can retry safely', async () =>
  fixture(async ({ make, signals }) => {
    const initial = make()
    initial.receipts.markAccepted = async () => {
      throw new Error('receipt write failed')
    }
    await expect(initial.service.respond(request, owner)).rejects.toThrow('receipt write failed')
    expect((await make().receipts.get(request)).acceptedAt).toBeUndefined()
    expect((await make().service.respond(request, owner)).data.replayed).toBe(true)
    expect(signals).toHaveLength(2)
    expect(signals[0]).toEqual(signals[1])
  }))
