import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { DurableExecutionValidationService } from './execution-validation.service.ts'

const graph = {
  reference: {
    graphDefinitionId: 'review-task',
    graphVersion: '1.0.0',
    contentDigest: `sha256:${'c'.repeat(64)}`,
  },
  input: { objective: 'Review the task' },
}

function setup(graphs) {
  const input = createExecutionPlanTestFixtureInputs()
  const contextPackage = input.contextPackage
  const records = new Map()
  const plans = []
  const request = {
    ...ControlApiFixtures.executionValidation.request,
    workspaceId: input.correlation.workspaceId,
    projectId: input.correlation.projectId,
    payload: {
      ...ControlApiFixtures.executionValidation.request.payload,
      taskId: input.correlation.taskId,
      agentId: input.correlation.agentId,
      profileVersionId: input.profile.profileVersionId,
      skillVersionIds: input.skills.map((s) => s.skillVersionId),
      graph,
      contextPackage: {
        contextPackageId: contextPackage.contextPackageId,
        contentDigest: contextPackage.contentDigest,
        schemaVersion: contextPackage.schemaVersion,
        compilerVersion: contextPackage.compiler.version,
      },
      projectState: contextPackage.projectState,
      policySnapshot: {
        policySnapshotId: input.constraints.policySnapshot.policyId,
        revision: input.constraints.policySnapshot.version,
        contentDigest: input.constraints.policySnapshot.digest,
      },
      runtimeRequirements: ['stream.output'],
      outputContractRef: input.outputContract.contractRef,
    },
  }
  const service = new DurableExecutionValidationService({
    compilerVersion: '1.0.0',
    now: () => input.compiledAt,
    graphs,
    contextPackages: { get: async () => contextPackage },
    commands: {
      get: async (scope) => records.get(JSON.stringify(scope)),
      commit: async (record, plan) => {
        records.set(JSON.stringify(record.scope), record)
        plans.push(plan)
        return record
      },
    },
    profiles: {
      getAgentProfileVersion: async () => input.profile,
      getAgentProfile: async (profileId) => ({ profileId, ownership: { scope: 'system' } }),
    },
    skills: {
      getSkillVersion: async () => input.skills[0],
      getSkill: async (skillId) => ({ skillId, ownership: { scope: 'system' } }),
    },
    projectStates: {
      getAtRevision: async () => ({
        schemaVersion: 1,
        ...contextPackage.projectState,
        items: [],
        createdAt: input.compiledAt,
        updatedAt: input.compiledAt,
      }),
    },
  })
  return { request, service, plans }
}

test('persists graph input and pin only after trusted workspace admission, preserving exact retries', async () => {
  let reads = 0
  const { request, service, plans } = setup({
    validate: async (workspaceId, selection) => {
      reads++
      expect(workspaceId).toBe(request.workspaceId)
      expect(selection).toEqual(graph)
      return true
    },
  })
  const first = await service.validate(request, request.caller.servicePrincipalId)
  expect(plans[0].graph).toEqual(graph)
  const replay = await service.validate(request, request.caller.servicePrincipalId)
  expect(replay.data.executionPlan).toEqual(first.data.executionPlan)
  expect(reads).toBe(1)
  expect(plans).toHaveLength(1)
  await expect(
    service.validate(
      { ...request, payload: { ...request.payload, graph: { ...graph, input: {} } } },
      request.caller.servicePrincipalId
    )
  ).rejects.toMatchObject({ status: 409 })
  expect(plans).toHaveLength(1)
})

test.each([undefined, { validate: async () => false }])(
  'does not persist graph plans without trusted executable-graph admission',
  async (graphs) => {
    const { request, service, plans } = setup(graphs)
    await expect(
      service.validate(request, request.caller.servicePrincipalId)
    ).rejects.toMatchObject({ status: 422 })
    expect(plans).toHaveLength(0)
  }
)
