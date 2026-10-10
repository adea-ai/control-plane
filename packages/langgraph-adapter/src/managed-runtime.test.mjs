import { describe, expect, test } from 'bun:test'
import { MemorySaver } from '@langchain/langgraph'
import {
  GraphDefinitionCatalog,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
import { createDeclarativeGraphAssembly } from './managed-runtime.ts'

const pin = {
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  operation: 'store-json',
}
const compatibility = {
  capabilities: ['graph.tool-pins.v1'],
  contractMajorVersion: 1,
  compilerVersion: '1.0.0',
  adapterVersion: '1.4.12',
}
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'

async function publish(
  repository,
  graphDefinitionId,
  operation = { kind: 'tool', name: 'store-json', toolPin: pin }
) {
  return new GraphDefinitionCatalog(repository).publish({
    publishedAt: '2026-10-03T00:00:00.000Z',
    definition: {
      graphDefinitionId,
      graphVersion: '1.0.0',
      schemaVersion: 1,
      nodes: [{ node: 'store', operation }],
      edges: [
        { from: '__start__', to: 'store' },
        { from: 'store', to: '__end__' },
      ],
      schemas: { input: 'schema:json', state: 'schema:json', output: 'schema:json' },
      requiredCapabilities: ['graph.tool-pins.v1'],
      compatibility: {
        contractMajorVersions: [1],
        compilerVersions: ['1.0.0'],
        adapterVersions: ['1.4.12'],
      },
    },
  })
}

describe('provider-neutral declarative graph assembly', () => {
  test('shares publish-time compiler policy with execution and rejects unsupported nodes', async () => {
    const repository = new InMemoryGraphDefinitionRepository()
    const published = await publish(repository, 'graph:hosted')
    await publish(repository, 'graph:unsupported', { kind: 'runtime', name: 'remote-command' })
    const operations = []
    const assembly = createDeclarativeGraphAssembly({
      repository: () => repository,
      compatibility,
      operationAllowlist: [{ kind: 'tool', name: 'store-json' }],
      schemaRegistry: {
        getValidator(reference) {
          return reference === 'schema:json'
            ? (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
            : undefined
        },
      },
      checkpointer: new MemorySaver(),
      operations: {
        async invoke(operation) {
          operations.push(operation)
          return { digest: 'stored' }
        },
        async cancel() {
          return true
        },
      },
      events: { async publish() {} },
      // Test doubles: this test covers compilation and admission policy, not legacy fencing or gating.
      resumeFence: { async assertResumeAllowed() {} },
      admissionGuard: { async assertNewAdmissionAllowed() {} },
      authorizeDefinitionAndInput: (definition, input) =>
        typeof input.value === 'number' &&
        definition.content.nodes.every(
          ({ operation }) =>
            operation.kind === 'tool' &&
            operation.name === 'store-json' &&
            JSON.stringify(operation.toolPin) === JSON.stringify(pin)
        ),
    })

    expect(
      await assembly.authority.validate(workspaceId, {
        reference: published.reference,
        input: { value: 1 },
      })
    ).toBe(true)
    expect(
      await assembly.authority.validate(workspaceId, {
        reference: published.reference,
        input: { value: 'wrong' },
      })
    ).toBe(false)
    const unsupported = await new GraphDefinitionCatalog(repository).getPinned({
      graphDefinitionId: 'graph:unsupported',
      graphVersion: '1.0.0',
      contentDigest: (await repository.get('graph:unsupported', '1.0.0')).reference.contentDigest,
    })
    expect(
      await assembly.authority.validate(workspaceId, {
        reference: unsupported.reference,
        input: { value: 1 },
      })
    ).toBe(false)

    const result = await assembly.orchestration.run({
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      workspaceId,
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      graph: published.reference,
      threadId: 'graph:exe_01JABCDEF0123456789ABCDEFG',
      input: { value: 1 },
      idempotencyKey: 'hosted-graph-assembly-run',
    })
    expect(result.status).toBe('completed')
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ kind: 'tool', name: 'store-json', toolPin: pin })
  })
})
