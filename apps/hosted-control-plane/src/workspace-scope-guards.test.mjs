import { expect, test } from 'bun:test'
import { authorizeHostedGraphTool } from './hosted-graph-tool-operations.ts'

test('project-only hosted graph tools reject workspace owners before plan or registry reads', async () => {
  let reads = 0
  await expect(
    authorizeHostedGraphTool(
      { kind: 'tool', executionId: 'execution', attemptId: 'attempt' },
      {
        executions: {
          getExecution: async () => ({
            correlation: {
              workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
              executionScope: { schemaVersion: 1, kind: 'workspace' },
            },
          }),
          getAttempt: async () => ({}),
        },
        commands: { getByExecutionId: async () => ({}) },
        plans: {
          get: async () => {
            reads++
            return undefined
          },
        },
      },
      {}
    )
  ).rejects.toThrow('HOSTED_GRAPH_TOOL_EXECUTION_AUTHORITY_MISMATCH')
  expect(reads).toBe(0)
})
