import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import {
  ExecutionLifecycleService,
  InMemoryExecutionRepository,
  executionConstraintFixtures,
} from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  InMemoryExecutionPlanRepository,
} from '@control-plane/execution-plan'
import { DelegationService, InMemoryDelegationRepository } from './delegation.ts'
export const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
  childTaskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
  agentId: 'agt_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  childRequestId: 'req_01JBBCDEF0123456789ABCDEFG',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
}
const digest = (character) => `sha256:${character.repeat(64)}`

export async function createFixture(graphs, storage = {}) {
  const parentPlan =
    storage.parentPlan ?? new ExecutionPlanCompiler('1.0.0').compile(parentPlanInput())
  const executions = storage.executions ?? new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executions)
  const plans = storage.plans ?? new InMemoryExecutionPlanRepository()
  await storage.contexts?.put(storage.parentContext ?? contextPackageSerializationFixtures.futurePi)
  await plans.put(parentPlan)
  await lifecycle.createExecution({
    executionId: ids.parentExecutionId,
    correlation: parentPlan.correlation,
    executionPlan: {
      executionPlanId: parentPlan.executionPlanId,
      contentDigest: parentPlan.contentDigest,
      schemaVersion: parentPlan.schemaVersion,
    },
    acceptedAt: '2026-08-25T18:00:00.000Z',
    deadlineAt: '2026-08-25T19:00:00.000Z',
  })
  const events = []
  const delegations = storage.delegations ?? new InMemoryDelegationRepository()
  const service = new DelegationService({
    delegations,
    lifecycle,
    plans,
    graphs,
    scopeAdmission: storage.scopeAdmission,
    childAdmission: storage.childAdmission,
    childAllocator: storage.childAllocator,
    onEventRetained: storage.onEventRetained,
    events: storage.events ?? {
      async publish(event) {
        events.push(event)
      },
    },
  })
  return { parentPlan, executions, lifecycle, plans, events, service, delegations }
}

export function delegationInput({ parentPlan }) {
  const constraints = globalThis.structuredClone(parentPlan.constraints)
  constraints.tools.grants[0].operations = ['read']
  constraints.limits.budget.maximumMicrounits = 1_000_000
  constraints.limits.tokens.maximumTotal = 10_000
  constraints.limits.duration.maximumMs = 600_000
  const contextPackage = deriveContextPackage(contextPackageSerializationFixtures.futurePi, {
    objective: 'Complete focused research',
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: { maximumBytes: 512, maximumTokens: 128 },
    successCriteria: ['Return evidence'],
    returnContract: { contractRef: 'contract://adapter-result/v1' },
    compiledAt: '2026-08-25T18:01:00.000Z',
  })
  return {
    delegationId: ids.delegationId,
    parentExecutionId: ids.parentExecutionId,
    childExecutionId: ids.childExecutionId,
    role: 'researcher',
    profileVersionId: ids.profileVersionId,
    objective: 'Research the bounded question',
    parentPlan,
    childPlan: {
      correlation: {
        ...parentPlan.correlation,
        taskId: ids.childTaskId,
        requestId: ids.childRequestId,
      },
      contextPackage,
      constraints,
      runtimeRequirements: parentPlan.runtimeRequirements,
      outputContract: parentPlan.outputContract,
      compiledAt: '2026-08-25T18:01:00.000Z',
    },
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'retry',
      maximumRetries: 2,
    },
    acceptedAt: '2026-08-25T18:01:00.000Z',
    deadlineAt: '2026-08-25T18:10:00.000Z',
  }
}

export function parentPlanInput() {
  const skill = {
    skillVersionId: ids.skillVersionId,
    skillId: ids.skillId,
    revision: 1,
    lifecycle: 'published',
    manifest: {
      schemaVersion: 1,
      semanticVersion: '1.0.0',
      contentDigest: digest('b'),
      requiredCapabilities: ['filesystem.read'],
      requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
    },
    content: { instructions: 'Inspect project files.', artifactRefs: [] },
    createdAt: '2026-08-25T17:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-25T17:00:00.000Z' },
  }
  return {
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
      requestId: ids.requestId,
    },
    profile: {
      profileVersionId: ids.profileVersionId,
      profileId: ids.profileId,
      version: 1,
      revision: 1,
      lifecycle: 'published',
      contentDigest: digest('a'),
      definition: {
        schemaVersion: 1,
        roleInstructions: 'Coordinate safely.',
        skills: [
          { skillId: ids.skillId, skillVersionId: ids.skillVersionId, contentDigest: digest('b') },
        ],
        capabilityRequirements: ['filesystem.read'],
        executionConstraints: globalThis.structuredClone(executionConstraintFixtures.write),
        outputContractRefs: ['contract://execution-result/v1'],
      },
      createdAt: '2026-08-25T17:00:00.000Z',
      lifecycleMetadata: { publishedAt: '2026-08-25T17:00:00.000Z' },
    },
    skills: [skill],
    contextPackage: globalThis.structuredClone(contextPackageSerializationFixtures.futurePi),
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    requestConstraints: [],
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    ],
    outputContract: { contractRef: 'contract://execution-result/v1' },
    compiledAt: '2026-08-25T17:00:00.000Z',
  }
}
