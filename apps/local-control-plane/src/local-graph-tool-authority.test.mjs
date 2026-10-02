import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { authorizeLocalGraphTool } from './local-graph-tool-authority.ts'
import { createLocalGraphToolFixture } from './local-graph-tool-fixture.mjs'

test('Local tool authority loads accepted immutable pins and rejects workspace/attempt/grant substitution', async () => {
  const fixture = await createLocalGraphToolFixture()
  const { operation, options } = fixture
  const toolPin = operation.toolPin
  try {
    const authority = await authorizeLocalGraphTool(operation, options)
    expect(authority.pin).toEqual(toolPin)
    expect(authority.command.callerPrincipalId).toBe('svc_graph-tool-test')
    expect(authority.requiresApproval).toBe(true)
    for (const override of [
      { workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
      { attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
      { node: 'not-accepted' },
      { toolPin: { ...toolPin, contentDigest: 'sha256:' + 'c'.repeat(64) } },
    ]) {
      await expect(
        authorizeLocalGraphTool({ ...operation, ...override }, options)
      ).rejects.toThrow()
    }
  } finally {
    await fixture.cleanup()
  }
})

test('Local tool authority denies capabilities absent from every accepted grant', async () => {
  const fixture = await createLocalGraphToolFixture({
    requiredCapabilities: ['object-store.write'],
  })
  try {
    await expect(authorizeLocalGraphTool(fixture.operation, fixture.options)).rejects.toThrow(
      'GRAPH_TOOL_CAPABILITY_DENIED'
    )
  } finally {
    await fixture.cleanup()
  }
})

test('Local graph tools refuse execution before its workflow attempt is running', async () => {
  const fixture = await createLocalGraphToolFixture({ activate: false })
  try {
    await expect(authorizeLocalGraphTool(fixture.operation, fixture.options)).rejects.toThrow(
      'GRAPH_TOOL_EXECUTION_AUTHORITY_MISMATCH'
    )
  } finally {
    await fixture.cleanup()
  }
})

test('compiled Local tool authority runs under the supported Node runtime without Bun globals', async () => {
  const fixture = await createLocalGraphToolFixture()
  try {
    const snapshot = {
      operation: fixture.operation,
      graph: fixture.graph,
      plan: fixture.plan,
      execution: await fixture.api.executions.getExecution(fixture.operation.executionId),
      attempt: await fixture.api.executions.getAttempt(fixture.operation.attemptId),
      command: await fixture.api.commandRepository.getByExecutionId(fixture.operation.executionId),
      definition: await fixture.registry.readDefinition(
        fixture.operation.toolPin.toolDefinitionId,
        fixture.operation.workspaceId
      ),
      version: fixture.version,
    }
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `
      import { readFileSync } from 'node:fs';
      import { authorizeLocalGraphTool } from './dist/local-graph-tool-authority.js';
      const snapshot = JSON.parse(readFileSync(0, 'utf8'));
      if ('Bun' in globalThis) throw Error('unexpected Bun runtime');
      const authority = await authorizeLocalGraphTool(snapshot.operation, {
        api: { executions: { getExecution: async () => snapshot.execution, getAttempt: async () => snapshot.attempt },
          commandRepository: { getByExecutionId: async () => snapshot.command }, executionPlans: { get: async () => snapshot.plan } },
        registry: { readDefinition: async () => snapshot.definition, readVersion: async () => snapshot.version },
        resolveGraph: async () => snapshot.graph,
      });
      process.stdout.write(JSON.stringify(authority.pin));
    `,
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        input: JSON.stringify(snapshot),
        encoding: 'utf8',
      }
    )
    expect({
      status: result.status,
      error: result.error?.message,
      stderr: result.stderr,
    }).toMatchObject({ status: 0, error: undefined })
    expect(JSON.parse(result.stdout)).toEqual(fixture.operation.toolPin)
  } finally {
    await fixture.cleanup()
  }
})
