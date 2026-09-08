import { expect, test } from 'bun:test'
import { AcpDriver } from './index.ts'

function fixture(agentCapabilities = {}, protocolVersion = 1, transportOverrides = {}) {
  const calls = []
  const driver = new AcpDriver({
    protocolVersion: 1,
    adapterVersion: '1.0.0',
    externalSessionId: (id) => id,
    interactionId: (id) => String(id),
    transport: {
      connectionState: () => 'connected',
      async request(method, params) {
        calls.push({ method, params })
        return {
          protocolVersion,
          agentInfo: { name: 'candidate-agent', version: '1.7.0' },
          agentCapabilities,
          authMethods: [],
        }
      },
      ...transportOverrides,
    },
  })
  return { driver, calls }
}

test('explicit ACP v1 uses v1 initialization and retains advertised session operations', async () => {
  const { driver, calls } = fixture({
    loadSession: true,
    sessionCapabilities: { list: {}, resume: {}, close: {} },
  })
  const result = await driver.inspect()
  expect(result.health).toBe('healthy')
  expect(result.metadata.harnessVersion).toBe('1.7.0')
  expect(calls).toEqual([
    {
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'control-plane', title: 'Control Plane', version: '1.0.0' },
      },
    },
  ])
  expect(result.capabilities.map(({ name }) => name)).toEqual([
    'execution.cancel',
    'interaction.approval',
    'session.close',
    'session.create',
    'session.list',
    'session.resume',
    'stream.events',
    'stream.output',
    'tool.call',
  ])
})

test('ACP v1 does not invent optional session methods or replay from baseline support', async () => {
  const { driver } = fixture({ sessionCapabilities: { list: null, resume: null, close: null } })
  const result = await driver.inspect([{ capability: 'session.list', necessity: 'required' }])
  expect(result.health).toBe('healthy')
  expect(result.capabilityEvaluation.eligible).toBe(false)
  expect(result.capabilities.map(({ name }) => name)).toEqual([
    'execution.cancel',
    'interaction.approval',
    'session.create',
    'stream.events',
    'stream.output',
    'tool.call',
  ])
})

test('an ACP v1 connection rejects a different negotiated protocol version', async () => {
  const { driver } = fixture({}, 2)
  const result = await driver.inspect()
  expect(result.health).toBe('unavailable')
  expect(result.capabilities).toEqual([])
})

test('ACP v1 load requires both native advertisement and transport replay support', async () => {
  const replay = async () => ({ updates: [], completeness: 'complete' })
  const withoutLoad = await fixture({}, 1, { replay }).driver.inspect()
  const withLoad = await fixture({ loadSession: true }, 1, { replay }).driver.inspect()
  expect(withoutLoad.capabilities.some(({ name }) => name === 'session.load')).toBe(false)
  expect(withLoad.capabilities.some(({ name }) => name === 'session.load')).toBe(true)
  const disabledReplay = await fixture({ loadSession: true }, 1, {
    replay,
    replaySupport: () => false,
  }).driver.inspect()
  expect(disabledReplay.capabilities.some(({ name }) => name === 'session.load')).toBe(false)
})

test('malformed ACP v1 optional capability values do not become supported methods', async () => {
  const { driver } = fixture({ sessionCapabilities: { list: true } })
  const result = await driver.inspect()
  expect(result.health).toBe('unavailable')
  expect(result.capabilities).toEqual([])
})
