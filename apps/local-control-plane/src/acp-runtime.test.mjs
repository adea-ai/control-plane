import { expect, test } from 'bun:test'
import { createLocalAcpRuntime, createRepositoryAcpTaskPromptResolver } from './acp-runtime.ts'
import {
  ExecutorQualificationEvaluator,
  NativeRouteGate,
  qualifiedRouteEvidence,
  qualifiedRouteObservation,
} from '@control-plane/acp-adapter'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'

test('Local ACP materializes the exact context pin and rejects missing or corrupted content', async () => {
  const context = contextPackageSerializationFixtures.futurePi
  const executionPlan = createExecutionPlanTestFixture({ contextPackage: context })
  const request = {
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'local-task',
    executionPlan,
  }
  const signal = new AbortController().signal
  const resolver = createRepositoryAcpTaskPromptResolver({
    get: async (pin) => {
      expect(pin.contentDigest).toBe(context.contentDigest)
      return context
    },
  })
  const prompt = await resolver(request, signal)
  expect(prompt).toContain(context.objective)
  expect(prompt).toContain(JSON.stringify(context.successCriteria))
  expect(prompt).toContain(executionPlan.contentDigest)
  for (const value of [undefined, { ...context, objective: 'tampered task' }]) {
    await expect(
      createRepositoryAcpTaskPromptResolver({ get: async () => value })(request, signal)
    ).rejects.toThrow()
  }
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(resolver(request, cancelled.signal)).rejects.toThrow()
})

test('Local ACP rejects a launcher without explicit task materialization', () => {
  expect(() => createLocalAcpRuntime({})).toThrow('ACP_LOCAL_PROMPT_RESOLVER_REQUIRED')
})

test('explicit Local ACP factory opens native v1 without inheriting host environment', async () => {
  const context = contextPackageSerializationFixtures.futurePi
  const source = `
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (process.env.HOME !== undefined) throw Error('configuration mismatch');
        let result;
        if (message.method === 'initialize') {
          if (message.params.protocolVersion !== 1) throw Error('protocol mismatch');
          result = {protocolVersion:1, agentInfo:{name:'local-wire-fixture',version:'1.0.0'},
            agentCapabilities:{sessionCapabilities:{close:{}}}};
        } else if (message.method === 'session/new') result = {sessionId:'native-task-session'};
        else if (message.method === 'session/prompt') {
          if (!message.params.prompt[0].text.includes(${JSON.stringify(context.objective)}))
            throw Error('missing task content');
          result = {stopReason:'end_turn',usage:{inputTokens:0,outputTokens:0}};
        } else if (message.method === 'session/close') result = {};
        else throw Error('unexpected method');
        process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:message.id, result}) + '\\n');
      }
    });
  `
  const runtime = createLocalAcpRuntime({
    executablePath: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    environment: {},
    externalSessionId: () => 'ses_01JABCDEF0123456789ABCDEFG',
    interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
    resolvePrompt: createRepositoryAcpTaskPromptResolver({ get: async () => context }),
    requestTimeoutMs: 2000,
  })
  try {
    expect(runtime.transportKind).toBe('direct-local')
    await runtime.open()
    expect(await runtime.inspect()).toBeDefined()
    const handle = await runtime.start({
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'native-task-content',
      executionPlan: createExecutionPlanTestFixture({
        contextPackage: context,
        profileCapabilityRequirements: ['stream.output'],
        skillRequiredCapabilities: [],
      }),
    })
    for await (const _event of runtime.progress(handle)) {
      // Drain the real child protocol through its terminal response.
    }
    expect((await runtime.status(handle)).state).toBe('completed')
  } finally {
    await runtime.close()
    await runtime.close()
  }
})

test('explicit Local ACP factory hands the optional native route gate to the driver', async () => {
  const context = contextPackageSerializationFixtures.futurePi
  // A native child that advertises session close; whether the Control Plane
  // claims it is decided by the route evidence, never by the child.
  const source = `
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        let result;
        if (message.method === 'initialize') {
          result = {protocolVersion:1, agentInfo:{name:'local-wire-fixture',version:'1.0.0'},
            agentCapabilities:{sessionCapabilities:{close:{}}}};
        } else throw Error('unexpected method');
        process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:message.id, result}) + '\\n');
      }
    });
  `
  const now = '2026-10-08T12:00:00.000Z'
  const gate = (capabilities) =>
    new NativeRouteGate({
      evaluator: new ExecutorQualificationEvaluator(
        [qualifiedRouteEvidence({ capabilities })],
        () => new Date(now)
      ),
      observation: qualifiedRouteObservation(),
    })
  const capabilityNames = async (nativeRouteGate) => {
    const runtime = createLocalAcpRuntime({
      executablePath: process.execPath,
      args: ['-e', source],
      cwd: process.cwd(),
      environment: {},
      externalSessionId: () => 'ses_01JABCDEF0123456789ABCDEFG',
      interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
      resolvePrompt: createRepositoryAcpTaskPromptResolver({ get: async () => context }),
      requestTimeoutMs: 2000,
      ...(nativeRouteGate === undefined ? {} : { nativeRouteGate }),
    })
    try {
      await runtime.open()
      const inspection = await runtime.inspect()
      return inspection.capabilities.map((capability) => capability.name)
    } finally {
      await runtime.close()
    }
  }
  const ungated = await capabilityNames(undefined)
  expect(ungated).toContain('session.close')
  // The evidence allow-list is the ceiling: a claim it omits is not made.
  const gated = await capabilityNames(gate(['session.create', 'stream.output']))
  expect(gated).not.toContain('session.close')
  expect(gated.every((name) => ['session.create', 'stream.output'].includes(name))).toBe(true)
  // An unqualified route advertises nothing at all.
  const unqualified = new NativeRouteGate({
    evaluator: new ExecutorQualificationEvaluator([], () => new Date(now)),
    observation: qualifiedRouteObservation(),
  })
  expect(await capabilityNames(unqualified)).toEqual([])
})
