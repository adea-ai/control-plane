import { describe, expect, test } from 'bun:test'
import {
  AuthorizationDecisionInputSchema,
  ExecutionConstraintSetSchema,
  ExecutionLimitsSchema,
  ModelRequirementSchema,
  ToolAccessPolicySchema,
  composeExecutionConstraints,
  evaluateToolAccess,
  executionConstraintFixtures,
} from './index.ts'

describe('tool, model, policy, and execution constraints', () => {
  test('denies tool access unless the exact operation is granted', () => {
    const policy = ToolAccessPolicySchema.parse({ default: 'deny', grants: [] })

    expect(
      evaluateToolAccess(policy, {
        toolId: 'project-files',
        versionRange: '^1.0.0',
        operation: 'read',
      })
    ).toEqual({ allowed: false, reason: 'NO_MATCHING_GRANT' })
    expect(
      evaluateToolAccess(executionConstraintFixtures.readOnly.tools, {
        toolId: 'project-files',
        versionRange: '^1.0.0',
        operation: 'write',
      })
    ).toEqual({ allowed: false, reason: 'OPERATION_NOT_GRANTED' })
    expect(
      evaluateToolAccess(executionConstraintFixtures.readOnly.tools, {
        toolId: 'project-files',
        versionRange: '^2.0.0',
        operation: 'read',
      })
    ).toEqual({ allowed: false, reason: 'NO_MATCHING_GRANT' })
  })

  test('distinguishes tool identity, operation, risk, and approval mode', () => {
    const result = evaluateToolAccess(executionConstraintFixtures.write.tools, {
      toolId: 'project-files',
      versionRange: '^1.0.0',
      operation: 'write',
    })

    expect(result).toEqual({
      allowed: true,
      approval: 'per_operation',
      riskClass: 'write',
    })
  })

  test('expresses model requests using logical aliases without concrete providers', () => {
    expect(
      ModelRequirementSchema.parse({
        alias: 'reasoning.standard',
        requiredCapabilities: ['tool_calling', 'structured_output'],
        providerPolicy: {
          allowedClasses: ['managed', 'local'],
          deniedProviders: [],
          dataResidency: ['us'],
        },
        fallback: 'same_capabilities',
      })
    ).not.toHaveProperty('provider')
    expect(() =>
      ModelRequirementSchema.parse({
        alias: 'reasoning.standard',
        provider: 'openai',
        requiredCapabilities: [],
        providerPolicy: {
          allowedClasses: ['managed'],
          deniedProviders: [],
          dataResidency: ['us'],
        },
        fallback: 'none',
      })
    ).toThrow()
  })

  test('validates budgets, timeouts, concurrency, child executions, and sandbox resources', () => {
    const limits = ExecutionLimitsSchema.parse(executionConstraintFixtures.budgetConstrained.limits)

    expect(limits).toMatchObject({
      budget: { currency: 'USD', maximumMicrounits: 2_000_000 },
      tokens: { maximumTotal: 50_000 },
      duration: { maximumMs: 300_000 },
      concurrency: { maximumParallel: 2 },
      childExecutions: { maximumTotal: 3, maximumDepth: 1 },
      sandbox: { cpuMillicores: 1_000, memoryMebibytes: 2_048, storageMebibytes: 4_096 },
    })
    expect(() =>
      ExecutionLimitsSchema.parse({
        ...executionConstraintFixtures.budgetConstrained.limits,
        concurrency: { maximumParallel: 0 },
      })
    ).toThrow()
  })

  test('composes restrictive constraints without widening authority', () => {
    const composed = composeExecutionConstraints([
      executionConstraintFixtures.write,
      executionConstraintFixtures.budgetConstrained,
    ])

    expect(
      composeExecutionConstraints([
        executionConstraintFixtures.budgetConstrained,
        executionConstraintFixtures.write,
      ])
    ).toEqual(composed)
    expect(composed.limits.budget.maximumMicrounits).toBe(2_000_000)
    expect(composed.limits.concurrency.maximumParallel).toBe(2)
    expect(
      evaluateToolAccess(composed.tools, {
        toolId: 'project-files',
        versionRange: '^1.0.0',
        operation: 'write',
      }).allowed
    ).toBe(true)

    const noFallback = ExecutionConstraintSetSchema.parse({
      ...executionConstraintFixtures.write,
      models: [{ ...executionConstraintFixtures.write.models[0], fallback: 'none' }],
    })
    expect(
      composeExecutionConstraints([executionConstraintFixtures.write, noFallback]).models[0]
        .fallback
    ).toBe('none')
  })

  test('rejects contradictory constraints deterministically', () => {
    const localOnly = ExecutionConstraintSetSchema.parse({
      ...executionConstraintFixtures.readOnly,
      models: [
        {
          ...executionConstraintFixtures.readOnly.models[0],
          providerPolicy: {
            allowedClasses: ['local'],
            deniedProviders: [],
            dataResidency: ['us'],
          },
        },
      ],
    })
    const managedOnly = ExecutionConstraintSetSchema.parse({
      ...executionConstraintFixtures.readOnly,
      models: [
        {
          ...executionConstraintFixtures.readOnly.models[0],
          providerPolicy: {
            allowedClasses: ['managed'],
            deniedProviders: [],
            dataResidency: ['eu'],
          },
        },
      ],
    })

    expect(() => composeExecutionConstraints([managedOnly, localOnly])).toThrow(
      'CONSTRAINT_CONFLICT:model:reasoning.standard:allowedClasses'
    )
    expect(() => composeExecutionConstraints([localOnly, managedOnly])).toThrow(
      'CONSTRAINT_CONFLICT:model:reasoning.standard:allowedClasses'
    )

    const noApprovals = ExecutionConstraintSetSchema.parse({
      ...executionConstraintFixtures.readOnly,
      interaction: { ...executionConstraintFixtures.readOnly.interaction, approvals: 'disabled' },
    })
    const approvalsRequired = ExecutionConstraintSetSchema.parse({
      ...executionConstraintFixtures.readOnly,
      interaction: { ...executionConstraintFixtures.readOnly.interaction, approvals: 'required' },
    })
    expect(() => composeExecutionConstraints([noApprovals, approvalsRequired])).toThrow(
      'CONSTRAINT_CONFLICT:interaction:approvals'
    )
  })

  test('defines evaluator-neutral authorization inputs and common fixtures', () => {
    const decision = AuthorizationDecisionInputSchema.parse({
      principalRef: 'principal://agent-hq/service',
      action: 'tool.invoke',
      resourceRef: 'tool://project-files/write',
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      policySnapshot: {
        policyId: 'workspace-standard',
        version: 3,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      context: { riskClass: 'write' },
    })

    expect(decision.policySnapshot.version).toBe(3)
    expect(Object.keys(executionConstraintFixtures).toSorted()).toEqual([
      'budgetConstrained',
      'privileged',
      'readOnly',
      'safe',
      'write',
    ])
  })
})
