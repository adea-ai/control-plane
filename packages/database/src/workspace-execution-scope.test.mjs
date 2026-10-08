import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { ExecutionSchema } from '@control-plane/domain'
import { ContextPackageCompiler, contextPackageSerializationFixtures } from '@control-plane/context'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import { fromExecutionRow, toExecutionRow } from './execution-repository.ts'
import { commandInbox } from './schema/commands.ts'
import { contextPackages } from './schema/context-packages.ts'
import { executionPlans } from './schema/execution-plans.ts'
import { executions } from './schema/executions.ts'
import { executionEvents } from './schema/events.ts'
import { executionCancellations } from './schema/execution-cancellations.ts'
import { executionScopeFieldsFromRow, executionRetentionScopeFromRow } from './execution-scope.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const executionScope = { schemaVersion: 1, kind: 'workspace' }

test('PostgreSQL scope mapping preserves legacy omission and explicit workspace/project scope', () => {
  expect(executionScopeFieldsFromRow({ workspaceId, projectId, executionScope: null })).toEqual({
    projectId,
  })
  expect(executionScopeFieldsFromRow({ workspaceId, projectId: null, executionScope })).toEqual({
    executionScope,
  })
  expect(
    executionScopeFieldsFromRow({
      workspaceId,
      projectId,
      executionScope: { schemaVersion: 1, kind: 'project', projectId },
    })
  ).toEqual({ projectId, executionScope: { schemaVersion: 1, kind: 'project', projectId } })
  expect(() =>
    executionScopeFieldsFromRow({ workspaceId, projectId: null, executionScope: null })
  ).toThrow()
  expect(() => executionScopeFieldsFromRow({ workspaceId, projectId, executionScope })).toThrow()
  expect(executionRetentionScopeFromRow({ workspaceId, projectId: null, executionScope })).toEqual({
    kind: 'workspace',
    workspaceId,
    executionScope,
  })
  expect(executionRetentionScopeFromRow({ workspaceId, projectId, executionScope: null })).toEqual({
    kind: 'project',
    workspaceId,
    projectId,
  })
})

test('versioned scope constraints and partial workspace uniqueness agree in schema, migration and snapshot', async () => {
  const migration = await readFile(
    new URL('../drizzle/0068_workspace_execution_scope.sql', import.meta.url),
    'utf8'
  )
  const snapshot = JSON.parse(
    await readFile(new URL('../drizzle/meta/0068_snapshot.json', import.meta.url), 'utf8')
  )
  for (const table of [
    commandInbox,
    contextPackages,
    executionPlans,
    executions,
    executionEvents,
    executionCancellations,
  ]) {
    const configuration = getTableConfig(table)
    expect(table.projectId.notNull).toBe(false)
    const constraint = configuration.checks.find(
      ({ name }) => name === `${configuration.name}_scope_check`
    )
    expect(constraint).toBeDefined()
    const value = new PgDialect().sqlToQuery(constraint.value).sql
    // SQL CHECK accepts UNKNOWN; the IS TRUE fence closes the both-null case.
    expect(value).toContain('is true')
    expect(migration).toContain(value)
    expect(
      snapshot.tables[`public.${configuration.name}`].checkConstraints[constraint.name].value
    ).toBe(value)
  }
  const index = getTableConfig(commandInbox).indexes.find(
    ({ config }) => config.name === 'command_inbox_workspace_idempotency_unique'
  )
  expect(index.config.unique).toBe(true)
  expect(new PgDialect().sqlToQuery(index.config.where).sql).toContain('"project_id" is null')
  expect(migration).toContain('CREATE UNIQUE INDEX "command_inbox_workspace_idempotency_unique"')
  expect(migration).not.toMatch(/UPDATE|DELETE|DROP INDEX/iu)
})

test('actual legacy and workspace execution row mappings preserve canonical correlation and plan pins', () => {
  const legacy = contextPackageSerializationFixtures.futurePi
  const context = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId,
    executionScope,
    revision: 1,
    objective: 'Run the workspace lead',
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  })
  const input = createExecutionPlanTestFixtureInputs({ contextPackage: context })
  const { projectId: _projectId, ...correlation } = input.correlation
  const workspace = new ExecutionPlanCompiler('1.0.0').compile({
    ...input,
    correlation: { ...correlation, executionScope },
  })
  for (const plan of [createExecutionPlanTestFixture(), workspace]) {
    const timestamp = '2026-10-08T12:00:00.000Z'
    const execution = ExecutionSchema.parse({
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      state: 'accepted',
      version: 1,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      attemptCount: 0,
      acceptedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const row = toExecutionRow(execution)
    expect(fromExecutionRow(row)).toEqual(execution)
    expect(row.projectId).toBe(plan.correlation.projectId ?? null)
    expect(row.executionScope).toEqual(plan.correlation.executionScope ?? null)
    expect(row.executionPlanDigest).toBe(plan.contentDigest)
    expect(Object.hasOwn(fromExecutionRow(row).correlation, 'executionScope')).toBe(
      plan.schemaVersion === 2
    )
  }
})
