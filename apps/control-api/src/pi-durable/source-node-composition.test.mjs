import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextPackageCompiler } from '@control-plane/context'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { piLeadConversationAgentContextRef } from '@control-plane/contracts'
import {
  assertSourceLeadExecutionPlan,
  createProductionSourceNodeComposition,
} from './source-node-composition.ts'

const uuid = (char) =>
  `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(12)}`
function fixture() {
  const inputs = createExecutionPlanTestFixtureInputs()
  const authority = {
    schemaVersion: 'pi-lead-host-source-authority/v1',
    intentId: uuid('1'),
    host: {
      workspaceId: `wsp_${'9'.repeat(26)}`,
      productWorkspaceId: uuid('2'),
      conversationId: uuid('3'),
      conversationVersion: 1,
      messageId: uuid('4'),
      messageVersion: 1,
      canonicalActorPrincipalId: `user:${uuid('5')}`,
      audienceDigest: `sha256:${'a'.repeat(64)}`,
      enlistmentGrantId: 'gra_source',
      enlistmentRevision: 1,
    },
    source: {
      workspaceId: inputs.correlation.workspaceId,
      productWorkspaceId: uuid('6'),
      agentId: inputs.correlation.agentId,
      productAgentId: uuid('7'),
      profileId: inputs.profile.profileId,
      profileVersion: String(inputs.profile.version),
      profileRevision: inputs.profile.revision,
    },
    contextRef: '',
  }
  authority.contextRef = piLeadConversationAgentContextRef(authority)
  const retained = {
    authority,
    profileVersionId: inputs.profile.profileVersionId,
    profileContentDigest: inputs.profile.contentDigest,
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 1,
  }
  return { inputs, retained }
}
function compileWorkspace(inputs, workspaceId = inputs.correlation.workspaceId) {
  const clone = structuredClone(inputs)
  delete clone.correlation.projectId
  clone.correlation.workspaceId = workspaceId
  clone.correlation.executionScope = { schemaVersion: 1, kind: 'workspace' }
  const context = clone.contextPackage
  clone.contextPackage = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId,
    executionScope: { schemaVersion: 1, kind: 'workspace' },
    revision: 1,
    objective: 'One authorized host human turn',
    artifacts: [],
    permissions: [],
    constraints: context.constraints,
    successCriteria: context.successCriteria,
    returnContract: context.returnContract,
    budgets: context.budgets,
    compiledAt: clone.compiledAt,
  })
  return new ExecutionPlanCompiler('1.0.0').compile(clone)
}
test('a real compiled source workspace plan retains the exact qualified Agent and immutable profile', () => {
  const f = fixture()
  const plan = compileWorkspace(f.inputs)
  expect(assertSourceLeadExecutionPlan(plan, f.retained)).toEqual(plan)
})
test('a host workspace plan or legacy project plan cannot substitute for source execution', () => {
  const f = fixture()
  expect(() =>
    assertSourceLeadExecutionPlan(
      compileWorkspace(f.inputs, f.retained.authority.host.workspaceId),
      f.retained
    )
  ).toThrow('PI_LEAD_SOURCE_PLAN_CHANGED')
  expect(() =>
    assertSourceLeadExecutionPlan(new ExecutionPlanCompiler('1.0.0').compile(f.inputs), f.retained)
  ).toThrow('PI_LEAD_SOURCE_PLAN_CHANGED')
})
test.each(['agentId', 'profileVersionId', 'profileContentDigest'])(
  'changed %s rejects a valid compiled replacement plan',
  (pin) => {
    const f = fixture()
    if (pin === 'agentId') f.inputs.correlation.agentId = `agt_${'8'.repeat(26)}`
    if (pin === 'profileVersionId') f.inputs.profile.profileVersionId = `pfv_${'8'.repeat(26)}`
    if (pin === 'profileContentDigest') f.inputs.profile.contentDigest = `sha256:${'d'.repeat(64)}`
    expect(() => assertSourceLeadExecutionPlan(compileWorkspace(f.inputs), f.retained)).toThrow(
      'PI_LEAD_SOURCE_PLAN_CHANGED'
    )
  }
)
test('missing host context qualification and unqualified child wiring reject before creating runtime stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-composition-config-'))
  const runtime = join(directory, 'runtime')
  try {
    const options = {
      directory: runtime,
      transportPrincipalId: 'svc_source-test',
      sourceProduct: { readCurrent: async () => undefined, readRetained: () => undefined },
      admission: {},
      usage: {},
      provider: async () => {},
      reconcileInference: async () => {},
    }
    await expect(createProductionSourceNodeComposition(options)).rejects.toThrow(
      'PI_LEAD_SOURCE_COMPOSITION_REQUIRED'
    )
    await expect(
      createProductionSourceNodeComposition({
        ...options,
        assertHostContext: async () => {},
        childAuthority: {},
      })
    ).rejects.toThrow('PI_LEAD_SOURCE_CHILD_UNQUALIFIED')
    expect(existsSync(runtime)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
