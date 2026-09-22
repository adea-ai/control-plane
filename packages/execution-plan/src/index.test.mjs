import { describe, expect, test } from 'bun:test'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { executionConstraintFixtures } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
  ExecutionPlanError,
  InMemoryExecutionPlanRepository,
  deriveExecutionPlan,
} from './index.ts'

const digest = (character) => `sha256:${character.repeat(64)}`
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
const correlation = {
  workspaceId: ids.workspaceId,
  projectId: ids.projectId,
  taskId: ids.taskId,
  agentId: ids.agentId,
  requestId: ids.requestId,
}

// Reproduces the pre-cutover canonicalization (#612): keys sorted with
// localeCompare, double-encoded exactly like the legacy sha256() did, and the
// same derived identifier. A plan written this way must still verify.
function legacyNormalize(value) {
  if (Array.isArray(value)) return value.map(legacyNormalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, legacyNormalize(entry)])
    )
  }
  return value
}

function legacyDigest(content) {
  const { createHash } = require('node:crypto')
  const serialized = JSON.stringify(JSON.stringify(legacyNormalize(content)))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

function legacyIdentifier(digestValue) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = Buffer.from(digestValue.slice(7, 39), 'hex')
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return `pln_${output.slice(0, 26)}`
}

describe('execution plan digest cutover', () => {
  test('a plan persisted pre-cutover still passes integrity via the legacy digest', async () => {
    const input = baseInput()
    // toolIds whose composite sort orders differ between localeCompare and
    // code-point ('g-a' before 'ga' by code point, after it under ICU), so the
    // two canonical forms genuinely diverge for this content.
    const baseGrant = input.constraints.tools.grants[0]
    // Keep the skill-required grant; append the divergent-ordering pair.
    input.constraints.tools.grants = [
      ...input.constraints.tools.grants,
      { ...baseGrant, tool: { ...baseGrant.tool, toolId: 'ga' } },
      { ...baseGrant, tool: { ...baseGrant.tool, toolId: 'g-a' } },
    ]
    const plan = compile(input)
    const { executionPlanId, contentDigest, ...content } = plan
    void executionPlanId
    void contentDigest
    const legacyContentDigest = legacyDigest(content)
    // Real divergence: the legacy bytes differ from the code-point form.
    expect(legacyContentDigest).not.toBe(plan.contentDigest)
    const preCutoverPlan = {
      ...content,
      contentDigest: legacyContentDigest,
      executionPlanId: legacyIdentifier(legacyContentDigest),
    }
    const verified = await new InMemoryExecutionPlanRepository().put(preCutoverPlan)
    expect(verified.executionPlanId).toBe(preCutoverPlan.executionPlanId)
    expect(verified.contentDigest).toBe(legacyContentDigest)
  })

  test('new plans carry the code-point digest and verify against it', async () => {
    const plan = compile(baseInput())
    const repository = new InMemoryExecutionPlanRepository()
    const reference = await repository.put(plan)
    expect(reference.contentDigest).toBe(plan.contentDigest)
    expect(
      await repository.get({
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
      })
    ).toMatchObject({ executionPlanId: plan.executionPlanId })
  })

  test('a tampered digest still fails integrity', async () => {
    const plan = compile(baseInput())
    await expect(
      new InMemoryExecutionPlanRepository().put({
        ...plan,
        contentDigest: `sha256:${'0'.repeat(64)}`,
      })
    ).rejects.toThrow('EXECUTION_PLAN_INTEGRITY_ERROR')
  })
})

describe('immutable ExecutionPlan compilation', () => {
  test('pins exact profile, skill, context, policy, constraint, and compiler versions', () => {
    const plan = compile(baseInput())

    expect(plan).toMatchObject({
      schemaVersion: 1,
      compiler: { name: 'control-plane-execution-plan', version: '1.0.0' },
      correlation,
      profile: {
        profileId: ids.profileId,
        profileVersionId: ids.profileVersionId,
        version: 3,
        revision: 2,
        contentDigest: digest('a'),
      },
      skills: [
        {
          skillId: ids.skillId,
          skillVersionId: ids.skillVersionId,
          revision: 4,
          semanticVersion: '2.1.0',
          contentDigest: digest('b'),
        },
      ],
      contextPackage: {
        contextPackageId: contextPackageSerializationFixtures.futurePi.contextPackageId,
        contentDigest: contextPackageSerializationFixtures.futurePi.contentDigest,
        schemaVersion: 1,
        compilerVersion: '1.0.0',
      },
      policySnapshot: executionConstraintFixtures.write.policySnapshot,
    })
    expect(plan.constraints.tools.grants[0].operations).toEqual(['read', 'write'])
    expect(plan.runtimeRequirements.map((entry) => entry.capability)).toEqual([
      'filesystem.read',
      'stream.output',
    ])
  })

  test('produces the same normalized plan and digest for equivalent pinned inputs', () => {
    const first = compile(baseInput())
    const reordered = baseInput()
    reordered.runtimeRequirements.reverse()
    reordered.profile.definition.capabilityRequirements.reverse()
    reordered.profile.definition.executionConstraints.context.allowedClassifications.reverse()
    reordered.profile.definition.executionConstraints.runtime.allowedFamilies.reverse()
    reordered.profile.definition.executionConstraints.runtime.allowedLocations.reverse()
    reordered.profile.definition.executionConstraints.models[0].requiredCapabilities.reverse()
    reordered.profile.definition.executionConstraints.models[0].providerPolicy.allowedClasses.reverse()
    reordered.constraints.context.allowedClassifications.reverse()
    reordered.constraints.runtime.allowedFamilies.reverse()
    reordered.constraints.runtime.allowedLocations.reverse()
    reordered.constraints.models[0].requiredCapabilities.reverse()
    reordered.constraints.models[0].providerPolicy.allowedClasses.reverse()

    const second = compile(JSON.parse(JSON.stringify(reordered)))
    expect(second).toEqual(first)
    expect(second.executionPlanId).toBe(first.executionPlanId)
    expect(second.contentDigest).toBe(first.contentDigest)
  })

  test('rejects missing, revoked, deprecated, incompatible, and contradictory references', () => {
    const missingSkill = baseInput()
    missingSkill.skills = []
    expectPlanError(missingSkill, 'MISSING_SKILL_VERSION')

    const revoked = baseInput()
    revoked.skills[0].lifecycle = 'revoked'
    expectPlanError(revoked, 'REVOKED_REFERENCE')

    const deprecated = baseInput()
    deprecated.profile.lifecycle = 'deprecated'
    expectPlanError(deprecated, 'DEPRECATED_REFERENCE')

    const incompatible = baseInput()
    incompatible.skills[0].manifest.compatibleContractMajorVersions = [2]
    expectPlanError(incompatible, 'INCOMPATIBLE_REFERENCE')

    const contradictory = baseInput()
    contradictory.requestConstraints = [
      {
        ...executionConstraintFixtures.write,
        runtime: { ...executionConstraintFixtures.write.runtime, allowedFamilies: ['other'] },
      },
    ]
    expectPlanError(contradictory, 'CONTRADICTORY_REQUIREMENTS')
  })

  test('fails before dispatch when pins, tool grants, context, or output contracts conflict', () => {
    const wrongDigest = baseInput()
    wrongDigest.profile.definition.skills[0].contentDigest = digest('c')
    expectPlanError(wrongDigest, 'CONTRADICTORY_REFERENCE')

    const missingTool = baseInput()
    missingTool.constraints.tools.grants = []
    expectPlanError(missingTool, 'INCOMPATIBLE_REFERENCE')

    const oversizedContext = baseInput()
    oversizedContext.contextPackage.usage.bytes = 1_000
    oversizedContext.constraints.context.maximumBytes = 500
    expectPlanError(oversizedContext, 'CONTEXT_CONSTRAINT_VIOLATION')

    const wrongOutput = baseInput()
    wrongOutput.outputContract.contractRef = 'contract://unapproved/v1'
    expectPlanError(wrongOutput, 'INCOMPATIBLE_REFERENCE')
  })

  test('never stores raw provider, harness, connector, or credential material', () => {
    const input = baseInput()
    input.providerCredential = 'secret'
    expect(() => compile(input)).toThrow()

    const serialized = JSON.stringify(compile(baseInput()))
    expect(serialized).not.toMatch(/credential|apiKey|accessToken|nativeSession|connectorSecret/)
  })

  test('persists immutable content-addressed plans for retry, audit, eval, and reproduction', async () => {
    const plan = compile(baseInput())
    const repository = new InMemoryExecutionPlanRepository()
    const reference = await repository.put(plan)

    expect(await repository.get(reference)).toEqual(plan)
    expect(await repository.put(plan)).toEqual(reference)
    const loaded = await repository.get(reference)
    loaded.outputContract.contractRef = 'contract://tampered/v1'
    expect((await repository.get(reference)).outputContract).toEqual(plan.outputContract)
    await expect(
      repository.put({ ...plan, compiledAt: '2026-08-23T13:00:00.000Z' })
    ).rejects.toThrow('EXECUTION_PLAN_INTEGRITY_ERROR')
  })

  test('validates persisted plan digest, schema version, and execution scope before acceptance', async () => {
    const plan = compile(baseInput())
    const repository = new InMemoryExecutionPlanRepository()
    await repository.put(plan)
    const validator = new ExecutionPlanAcceptanceValidator(repository)
    const input = {
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
    }

    expect(await validator.validate(input)).toBe(true)
    expect(
      await validator.validate({
        ...input,
        executionPlan: { ...input.executionPlan, schemaVersion: 2 },
      })
    ).toBe(false)
    expect(
      await validator.validate({
        ...input,
        projectId: 'prj_01JZBCDEF0123456789ABCDEFG',
      })
    ).toBe(false)
  })

  test('allows child derivation to narrow authority and rejects every expansion dimension', () => {
    const parent = compile(baseInput())
    const childConstraints = globalThis.structuredClone(parent.constraints)
    childConstraints.tools.grants[0].operations = ['read']
    childConstraints.models[0].providerPolicy.allowedClasses = ['local']
    childConstraints.runtime.allowedFamilies = ['pi']
    childConstraints.limits.budget.maximumMicrounits = 1_000_000
    childConstraints.limits.tokens.maximumTotal = 10_000
    const childContext = deriveContextPackage(contextPackageSerializationFixtures.futurePi, {
      objective: 'Complete the focused child task',
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      budgets: { maximumBytes: 512, maximumTokens: 128 },
      successCriteria: ['Return focused output'],
      returnContract: { contractRef: 'contract://adapter-result/v1' },
      compiledAt: '2026-08-23T12:30:00.000Z',
    })
    const child = deriveExecutionPlan(parent, childInput(childConstraints, childContext))

    expect(child.parentExecutionPlan).toEqual({
      executionPlanId: parent.executionPlanId,
      contentDigest: parent.contentDigest,
    })
    expect(child.constraints.tools.grants[0].operations).toEqual(['read'])
    expect(child.constraints.models[0].providerPolicy.allowedClasses).toEqual(['local'])

    for (const mutate of [
      (value) => value.tools.grants[0].operations.push('admin'),
      (value) => value.models[0].providerPolicy.allowedClasses.push('private_cloud'),
      (value) => value.runtime.allowedFamilies.push('other'),
      (value) => (value.limits.budget.maximumMicrounits += 1),
      (value) => (value.limits.sandbox.memoryMebibytes += 1),
    ]) {
      const expanded = globalThis.structuredClone(parent.constraints)
      mutate(expanded)
      expect(() => deriveExecutionPlan(parent, childInput(expanded, childContext))).toThrow(
        'CHILD_AUTHORITY_EXPANSION'
      )
    }
  })

  test('requires child context to be equal to or derived from the parent package', () => {
    const parent = compile(baseInput())
    expect(() =>
      deriveExecutionPlan(
        parent,
        childInput(parent.constraints, contextPackageSerializationFixtures.futureLangGraph)
      )
    ).toThrow('CHILD_CONTEXT_EXPANSION')
  })
})

function compile(input) {
  return new ExecutionPlanCompiler('1.0.0').compile(input)
}

function expectPlanError(input, code) {
  try {
    compile(input)
    throw new Error('Expected plan compilation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionPlanError)
    expect(error.code).toBe(code)
  }
}

function childInput(constraints, contextPackage) {
  return {
    correlation: {
      ...correlation,
      taskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
      requestId: 'req_01JBBCDEF0123456789ABCDEFG',
    },
    contextPackage,
    constraints,
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
      { capability: 'filesystem.read', necessity: 'required', minimumSupport: 'supported' },
    ],
    outputContract: { contractRef: 'contract://execution-result/v1' },
    compiledAt: '2026-08-23T12:30:00.000Z',
  }
}

function baseInput() {
  const skill = {
    skillVersionId: ids.skillVersionId,
    skillId: ids.skillId,
    revision: 4,
    lifecycle: 'published',
    manifest: {
      schemaVersion: 1,
      semanticVersion: '2.1.0',
      contentDigest: digest('b'),
      requiredCapabilities: ['filesystem.read'],
      requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
    },
    content: { instructions: 'Inspect and update project files.', artifactRefs: [] },
    createdAt: '2026-08-22T12:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
  }
  return {
    correlation,
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
        capabilityRequirements: ['filesystem.read'],
        executionConstraints: globalThis.structuredClone(executionConstraintFixtures.write),
        outputContractRefs: ['contract://execution-result/v1'],
      },
      createdAt: '2026-08-22T12:00:00.000Z',
      lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
    },
    skills: [skill],
    contextPackage: globalThis.structuredClone(contextPackageSerializationFixtures.futurePi),
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    requestConstraints: [],
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    ],
    outputContract: { contractRef: 'contract://execution-result/v1' },
    compiledAt: '2026-08-23T12:00:00.000Z',
  }
}
