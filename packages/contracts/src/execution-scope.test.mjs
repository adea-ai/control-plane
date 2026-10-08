import { expect, test } from 'bun:test'
import {
  ExecutionScopeFieldsSchema,
  executionScopeOf,
  executionScopesEqual,
  executionScopeCanNarrow,
} from './execution-scope.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'

test('legacy scope round trip keeps bytes while normalization is read-only', () => {
  const legacy = { workspaceId, projectId }
  expect(ExecutionScopeFieldsSchema.parse(legacy)).toEqual(legacy)
  expect(executionScopeOf(legacy)).toEqual({ schemaVersion: 1, kind: 'project', projectId })
  expect(legacy).toEqual({ workspaceId, projectId })
})

test('workspace scope is explicit and cannot carry a project or infer authority', () => {
  const workspace = { workspaceId, executionScope: { schemaVersion: 1, kind: 'workspace' } }
  expect(ExecutionScopeFieldsSchema.parse(workspace)).toEqual(workspace)
  for (const input of [
    { workspaceId },
    { ...workspace, projectId },
    { ...workspace, projectId: null },
    {
      workspaceId,
      projectId,
      executionScope: {
        schemaVersion: 1,
        kind: 'project',
        projectId: 'prj_01JABCDEF0123456789ABCDEFH',
      },
    },
  ]) {
    expect(ExecutionScopeFieldsSchema.safeParse(input).success).toBe(false)
  }
  expect(
    executionScopesEqual(workspace, { ...workspace, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' })
  ).toBe(false)
  expect(executionScopesEqual(workspace, { workspaceId, projectId })).toBe(false)
  expect(executionScopeCanNarrow(workspace, { workspaceId })).toBe(false)
  expect(executionScopeCanNarrow(workspace, { ...workspace, projectId })).toBe(false)
})
