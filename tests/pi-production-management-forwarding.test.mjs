import { expect, test } from 'bun:test'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

function managementToolResponse() {
  const item = {
    id: 'fc_management_forwarding_fixture',
    type: 'function_call',
    status: 'completed',
    name: 'management_call',
    call_id: 'call_management_forwarding_fixture',
    arguments: JSON.stringify({ operation: 'workspace.rename', input: { name: 'Renamed' } }),
  }
  const events = [
    {
      type: 'response.created',
      response: { id: 'resp_management_fixture', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_management_fixture',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}

function managementTextResponse() {
  const text = 'Management call completed.\n'
  const item = {
    type: 'message',
    id: 'msg_management_fixture',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const events = [
    {
      type: 'response.created',
      response: { id: 'resp_management_final_fixture', status: 'in_progress' },
    },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_management_final_fixture',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}

test('production composition forwards governed management prepare and execute to the durable runtime', async () => {
  const preparedCalls = []
  const executedCalls = []
  const offeredTools = []
  let host
  host = await createProductionFactoryFixture({
    governedManagementCall: {
      prepare: async (authority, verified) => {
        preparedCalls.push({ authority, verified })
        const workspaceId = authority.request.executionPlan.correlation.workspaceId
        const profileId = authority.request.executionPlan.profile.profileId
        const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFG'
        const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFG'
        return {
          requestId: 'req_01JABCDEF0123456789ABCDEFG',
          executionId: authority.request.executionId,
          attemptId: authority.request.attemptId,
          workspaceId,
          profileId,
          toolDefinitionId,
          toolVersionId,
          operation: verified.args.operation,
          input: verified.args.input,
          grant: {
            workspaceId,
            profileId,
            toolDefinitionId,
            toolVersionId,
            operations: [verified.args.operation],
          },
          audit: {
            principalRef: authority.admission.canonicalActorPrincipalId,
            traceId: 'trc_01JABCDEF0123456789ABCDEFG',
          },
          toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
          idempotencyKey: `management-forwarding:${verified.sourceKey}`,
          requestedAt: host.at,
          policySnapshotRef: 'policy://management-forwarding-test/v1',
        }
      },
      execute: async (request) => {
        executedCalls.push(request)
        return { state: 'succeeded', value: { renamed: true } }
      },
    },
    physicalResponder: async ({ body, state }) => {
      offeredTools.push(body.tools?.map((tool) => tool.name) ?? [])
      return state.physicalSends === 1 ? managementToolResponse() : managementTextResponse()
    },
  })
  try {
    const intentId = host.setIntent()
    const prepared = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    const dispatched = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: prepared.preparationRef,
        }),
        host.principal
      )
    ).data
    await host.composition.adapter.drain()

    expect(offeredTools[0]).toContain('management_call')
    expect(preparedCalls).toHaveLength(1)
    expect(preparedCalls[0]?.verified.args).toEqual({
      operation: 'workspace.rename',
      input: { name: 'Renamed' },
    })
    expect(executedCalls).toHaveLength(1)
    expect(executedCalls[0]).toMatchObject({
      operation: 'workspace.rename',
      input: { name: 'Renamed' },
      workspaceId: host.workspaceId,
      executionId: dispatched.executionId,
      attemptId: dispatched.attemptId,
      audit: { principalRef: host.actorPrincipalId },
    })
    const status = (
      await host.composition.piDurableLeadService.status(
        host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }),
        host.principal
      )
    ).data.status
    expect(status.state).toBe('completed')
  } finally {
    await host.close()
  }
}, 30000)
