import { expect, test } from 'bun:test'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

/**
 * Actual production composition injection (#932): the launcher supplies the
 * host-governed management `service` plus its retained `interactions`, and the
 * real factory composes the canonical current-authority helper from the
 * fixture's real execution authority, intents, executions and plans. The
 * authority is then exercised against non-canonical input and must fail closed;
 * no provider call, credential or effect occurs.
 */

test('the production composition composes the host management authority and fails closed on non-canonical calls', async () => {
  const interactions = { get: async () => undefined }
  const prepared = []
  const managementAuthority = {
    interactions,
    service: {
      approvals: { repository: interactions },
      calls: {
        get: async (toolCallId) => {
          prepared.push(toolCallId)
          return undefined
        },
      },
      execute: async () => {
        throw new Error('TEST_EXECUTE_MUST_NOT_RUN')
      },
      gateway: {
        prepare: async (request) => {
          prepared.push(request)
          throw new Error('TEST_PREPARE_MUST_NOT_RUN')
        },
      },
    },
  }
  const host = await createProductionFactoryFixture({ managementAuthority })
  try {
    const authority = host.composition.piDurableCurrentToolAuthority
    expect(authority).toBeDefined()
    await expect(authority.assertCurrent({}, 'admission')).rejects.toThrow(
      'PI_TOOL_AUTHORITY_REJECTED'
    )
    await expect(
      authority.assertCurrent({ attemptId: 'not-a-canonical-request' }, 'admission')
    ).rejects.toThrow('PI_TOOL_AUTHORITY_REJECTED')
    await expect(
      authority.assertCurrent({ attemptId: 'att_01JABCDEF0123456789ABCDEFG' }, 'unknown')
    ).rejects.toThrow('PI_TOOL_AUTHORITY_REJECTED')
    expect(prepared).toEqual([])
    expect(host.state.physicalSends).toBe(0)
    expect(host.state.productReads).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
  } finally {
    await host.close()
  }
})
