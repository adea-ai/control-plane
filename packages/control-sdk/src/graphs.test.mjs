import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { ControlPlaneClient, ControlApiFixtures, canonicalJsonStringify } from './index.ts'

const definition = {
  graphDefinitionId: 'graph:sdk',
  graphVersion: '1.0.0',
  schemaVersion: 1,
  nodes: [{ node: 'run', operation: { kind: 'runtime', name: 'execute' } }],
  edges: [
    { from: '__start__', to: 'run' },
    { from: 'run', to: '__end__' },
  ],
  schemas: { input: 'schema:input', state: 'schema:state', output: 'schema:output' },
  requiredCapabilities: [],
  compatibility: {
    contractMajorVersions: [1],
    compilerVersions: ['1.0.0'],
    adapterVersions: ['1.0.0'],
  },
}
const version = {
  reference: {
    graphDefinitionId: definition.graphDefinitionId,
    graphVersion: '1.0.0',
    contentDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(definition)).digest('hex')}`,
  },
  content: definition,
  revision: 1,
  lifecycle: 'published',
  publishedAt: '2026-09-30T23:00:00.000Z',
  changedAt: '2026-09-30T23:00:00.000Z',
}
const command = {
  ...ControlApiFixtures.executionValidation.request,
  idempotencyKey: 'graph:sdk:command:1',
}
delete command.projectId

test('SDK graph methods use versioned routes, validate requests, and parse immutable catalog snapshots', async () => {
  const calls = []
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'fixture-token',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, init, body })
      return Response.json({
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
        data: { definition: version },
      })
    },
  })
  expect(
    (await client.publishGraph({ ...command, operation: 'graph.publish', payload: { definition } }))
      .data.definition
  ).toEqual(version)
  const payload = {
    reference: version.reference,
    expectedRevision: 1,
    reason: 'reviewed lifecycle change',
  }
  await client.deprecateGraph({ ...command, operation: 'graph.deprecate', payload })
  await client.revokeGraph({ ...command, operation: 'graph.revoke', payload })
  await client.resolveGraph({
    caller: command.caller,
    contractVersion: command.contractVersion,
    requestId: command.requestId,
    workspaceId: command.workspaceId,
    correlation: command.correlation,
    operation: 'graph.resolve',
    requestedAt: command.issuedAt,
    parameters: { reference: version.reference },
  })
  expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
    '/v1/graphs/publish',
    '/v1/graphs/deprecate',
    '/v1/graphs/revoke',
    '/v1/graphs/resolve',
  ])
  for (const { init } of calls) expect(init.headers.authorization).toBe('Bearer fixture-token')
  await expect(
    client.publishGraph({
      ...command,
      operation: 'graph.publish',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      payload: { definition },
    })
  ).rejects.toThrow()
  expect(calls).toHaveLength(4)
})
