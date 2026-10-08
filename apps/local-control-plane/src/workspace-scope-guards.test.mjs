import { expect, test } from 'bun:test'
import { authorizeLocalGraphTool } from './local-graph-tool-authority.ts'
import { LocalRuntimeInteractions } from './runtime-interactions.ts'

const correlation = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  executionScope: { schemaVersion: 1, kind: 'workspace' },
}

test('project-only graph tools reject workspace owners before plan, registry or graph reads', async () => {
  let reads = 0
  await expect(
    authorizeLocalGraphTool(
      { kind: 'tool', executionId: 'execution', attemptId: 'attempt' },
      {
        api: {
          executions: { getExecution: async () => ({ correlation }), getAttempt: async () => ({}) },
          commandRepository: { getByExecutionId: async () => ({}) },
          executionPlans: {
            get: async () => {
              reads++
              return undefined
            },
          },
        },
        registry: {
          readDefinition: async () => {
            reads++
          },
        },
        resolveGraph: async () => {
          reads++
        },
      }
    )
  ).rejects.toThrow('GRAPH_TOOL_EXECUTION_AUTHORITY_MISMATCH')
  expect(reads).toBe(0)
})

test('project-only local interactions reject workspace owners before interaction writes', async () => {
  let writes = 0
  const interactions = new LocalRuntimeInteractions(
    {
      insert: async () => {
        writes++
        return true
      },
    },
    {
      getByExecutionId: async () => ({}),
      getExecution: async () => ({ correlation }),
    }
  )
  await expect(
    interactions.record('execution', 'attempt', { data: { kind: 'input' } })
  ).rejects.toThrow('LOCAL_INTERACTION_SCOPE_MISSING')
  expect(writes).toBe(0)
})
