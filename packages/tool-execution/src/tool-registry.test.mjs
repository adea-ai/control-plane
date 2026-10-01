import { describe, expect, test } from 'bun:test'
import {
  FakeToolExecutor,
  InMemoryToolRegistryRepository,
  ToolGateway,
  ToolGatewayError,
  ToolRegistry,
} from './tool-registry.ts'

const ids = {
  tool: 'tld_01JABCDEF0123456789ABCDEFG',
  version: 'tlv_01JABCDEF0123456789ABCDEFG',
  workspace: 'wsp_01JABCDEF0123456789ABCDEFG',
  otherWorkspace: 'wsp_01JABCDEF0123456789ABCDEFH',
  profile: 'prf_01JABCDEF0123456789ABCDEFG',
  execution: 'exe_01JABCDEF0123456789ABCDEFG',
  attempt: 'att_01JABCDEF0123456789ABCDEFG',
  request: 'req_01JABCDEF0123456789ABCDEFG',
  trace: 'trc_01JABCDEF0123456789ABCDEFG',
}

const definition = {
  toolDefinitionId: ids.tool,
  name: 'files.read',
  displayName: 'Read file',
  description: 'Reads an explicitly scoped file.',
  ownership: { scope: 'workspace', workspaceId: ids.workspace },
  createdAt: '2026-08-25T08:00:00.000Z',
}

const version = {
  toolVersionId: ids.version,
  toolDefinitionId: ids.tool,
  semanticVersion: '1.0.0',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', maxLength: 64 } },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { content: { type: 'string' } },
    required: ['content'],
    additionalProperties: false,
  },
  operations: [
    {
      name: 'read',
      requiredCapabilities: ['filesystem.read'],
      riskClass: 'low',
      approvalMode: 'never',
      idempotency: 'inherent',
    },
  ],
  executor: { type: 'internal', reference: 'files-v1' },
  limits: { maxInputBytes: 128, maxOutputBytes: 256, timeoutMs: 5_000 },
  createdAt: '2026-08-25T08:01:00.000Z',
  publishedAt: '2026-08-25T08:02:00.000Z',
}

const grant = {
  workspaceId: ids.workspace,
  profileId: ids.profile,
  toolDefinitionId: ids.tool,
  toolVersionId: ids.version,
  operations: ['read'],
}

const request = {
  requestId: ids.request,
  executionId: ids.execution,
  attemptId: ids.attempt,
  workspaceId: ids.workspace,
  profileId: ids.profile,
  toolDefinitionId: ids.tool,
  toolVersionId: ids.version,
  operation: 'read',
  input: { path: 'README.md' },
  grant,
  audit: { principalRef: 'service:runtime-worker', traceId: ids.trace },
}

async function fixture() {
  const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
  await registry.createDefinition(definition)
  const published = await registry.publishVersion(version)
  const executor = new FakeToolExecutor(() => ({ content: 'hello' }))
  const gateway = new ToolGateway(registry)
  gateway.registerExecutor('internal', 'files-v1', executor)
  return { registry, published, executor, gateway }
}

describe('Tool Gateway registry', () => {
  test('lists, reads, and resolves exact immutable versions within workspace scope', async () => {
    const { registry, published } = await fixture()

    expect(await registry.readDefinition(ids.tool, ids.workspace)).toEqual(definition)
    expect(await registry.readVersion(ids.version, ids.workspace)).toEqual(published)
    expect(await registry.resolve('files.read', '1.0.0', ids.workspace)).toEqual(published)
    expect(await registry.list(ids.workspace)).toEqual([{ definition, versions: [published] }])
    expect(await registry.list(ids.otherWorkspace)).toEqual([])

    await expect(
      registry.publishVersion({
        ...version,
        toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFH',
        inputSchema: { type: 'string' },
      })
    ).rejects.toMatchObject({ code: 'SEMANTIC_VERSION_CONFLICT' })

    await expect(
      registry.publishVersion({
        ...version,
        toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFJ',
        semanticVersion: '1.1.0',
        inputSchema: {
          type: 'object',
          properties: { apiKey: { type: 'string' } },
        },
      })
    ).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })

    await expect(
      registry.publishVersion({
        ...version,
        toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFK',
        semanticVersion: '1.2.0',
        inputSchema: { type: 'object', description: 'x'.repeat(300_000) },
      })
    ).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
  })

  test('executes only registered, granted, schema-valid, bounded operations', async () => {
    const { gateway, executor } = await fixture()

    await expect(gateway.execute(request)).resolves.toMatchObject({
      output: { content: 'hello' },
      toolVersionId: ids.version,
      executor: { type: 'internal', reference: 'files-v1' },
    })
    expect(executor.requests).toHaveLength(1)

    for (const invalid of [
      { ...request, workspaceId: ids.otherWorkspace },
      { ...request, operation: 'delete' },
      { ...request, input: { unknown: true } },
      { ...request, input: { path: 'x'.repeat(200) } },
      { ...request, toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFH' },
    ]) {
      await expect(gateway.execute(invalid)).rejects.toBeInstanceOf(ToolGatewayError)
    }
    expect(executor.requests).toHaveLength(1)
  })

  test('rejects invalid executor output and permits implementation replacement behind a stable ref', async () => {
    const { gateway } = await fixture()
    gateway.registerExecutor(
      'internal',
      'files-v1',
      new FakeToolExecutor(() => ({ unexpected: 'unsafe' }))
    )
    await expect(gateway.execute(request)).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
      effectState: 'committed',
    })

    gateway.registerExecutor(
      'internal',
      'files-v1',
      new FakeToolExecutor(() => ({ content: 'x'.repeat(300) }))
    )
    await expect(gateway.execute(request)).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT_EXCEEDED',
      effectState: 'committed',
    })

    gateway.registerExecutor(
      'internal',
      'files-v1',
      new FakeToolExecutor(() => ({ content: 'replacement' }))
    )
    await expect(gateway.execute(request)).resolves.toMatchObject({
      output: { content: 'replacement' },
      toolDefinitionId: ids.tool,
      toolVersionId: ids.version,
    })
  })

  test('aborts a timed-out attempt, returns when cancellation is ignored, and never retries', async () => {
    const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
    await registry.createDefinition(definition)
    await registry.publishVersion({
      ...version,
      operations: [
        {
          ...version.operations[0],
          retryPolicy: { maxAttempts: 2, retryableErrorCodes: ['TIMEOUT'] },
        },
      ],
      limits: { ...version.limits, timeoutMs: 10 },
    })
    const gateway = new ToolGateway(registry)
    const events = []
    let attempts = 0
    gateway.registerExecutor('internal', 'files-v1', {
      execute: async (_request, _version, signal) => {
        const attempt = ++attempts
        events.push(`started:${attempt}`)
        return new Promise(() => {
          signal.addEventListener(
            'abort',
            () => {
              events.push(`aborted:${attempt}`)
            },
            { once: true }
          )
        })
      },
    })

    // The gateway's own timeout is the behavior under test. An outer wall-clock
    // watchdog starts before async preparation and can race it under suite load.
    const outcome = await gateway.execute(request).then(
      () => 'unexpected-success',
      (error) => error
    )
    expect(outcome).toMatchObject({ code: 'EXECUTION_TIMEOUT', executorCode: 'TIMEOUT' })
    expect(events).toEqual(['started:1', 'aborted:1'])
    expect(attempts).toBe(1)
  })
})
