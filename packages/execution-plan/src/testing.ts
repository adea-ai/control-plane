import { contextPackageSerializationFixtures, type ContextPackage } from '@control-plane/context'
import { executionConstraintFixtures } from '@control-plane/domain'
import type { RuntimeCapabilityName } from '@control-plane/runtime-sdk'
import { ExecutionPlanCompiler, type ExecutionPlan } from './index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

export interface ExecutionPlanTestFixtureOptions {
  readonly contextPackage?: ContextPackage
  readonly profileCapabilityRequirements?: readonly RuntimeCapabilityName[]
  readonly skillRequiredCapabilities?: readonly RuntimeCapabilityName[]
}

export function createExecutionPlanTestFixture(
  options: ExecutionPlanTestFixtureOptions = {}
): ExecutionPlan {
  const ids = {
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
    agentId: 'agt_01JABCDEF0123456789ABCDEFG',
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    profileId: 'prf_01JABCDEF0123456789ABCDEFG',
    profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
    skillId: 'skl_01JABCDEF0123456789ABCDEFG',
    skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  }
  const constraints = structuredClone(executionConstraintFixtures.write)
  return new ExecutionPlanCompiler('1.0.0').compile({
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
      version: 3,
      revision: 2,
      lifecycle: 'published',
      contentDigest: digest('a'),
      definition: {
        schemaVersion: 1,
        roleInstructions: 'Complete the assigned task safely.',
        skills: [
          {
            skillId: ids.skillId,
            skillVersionId: ids.skillVersionId,
            contentDigest: digest('b'),
          },
        ],
        capabilityRequirements: options.profileCapabilityRequirements ?? ['filesystem.read'],
        executionConstraints: structuredClone(constraints),
        outputContractRefs: ['contract://execution-result/v1'],
      },
      createdAt: '2026-08-22T12:00:00.000Z',
      lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
    },
    skills: [
      {
        skillVersionId: ids.skillVersionId,
        skillId: ids.skillId,
        revision: 4,
        lifecycle: 'published',
        manifest: {
          schemaVersion: 1,
          semanticVersion: '2.1.0',
          contentDigest: digest('b'),
          requiredCapabilities: options.skillRequiredCapabilities ?? ['filesystem.read'],
          requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
          compatibleProfileSchemaVersions: [1],
          compatibleContractMajorVersions: [1],
        },
        content: { instructions: 'Inspect and update project files.', artifactRefs: [] },
        createdAt: '2026-08-22T12:00:00.000Z',
        lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
      },
    ],
    contextPackage: structuredClone(
      options.contextPackage ?? contextPackageSerializationFixtures.futurePi
    ),
    constraints,
    requestConstraints: [],
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    ],
    outputContract: { contractRef: 'contract://execution-result/v1' },
    compiledAt: '2026-08-23T12:00:00.000Z',
  })
}
