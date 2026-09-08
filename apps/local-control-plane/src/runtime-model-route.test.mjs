import { expect, test } from 'bun:test'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { LocalRuntimeModelRoute } from './runtime-model-route.ts'
import { createRepositoryAcpTaskPromptResolver } from './acp-runtime.ts'

const options = {
  provider: 'openai-codex',
  model: 'gpt-5.4',
  modelAlias: 'reasoning.standard',
  modelCapabilities: ['tool_calling', 'structured_output'],
  providerClass: 'managed',
  dataResidency: 'us',
}

test.each(['ACP', 'MANAGED_PI'])('shared model route preserves %s eligibility checks', (prefix) => {
  const policies = createExecutionPlanTestFixture().constraints.models
  const route = new LocalRuntimeModelRoute(options, prefix)
  expect(() => route.assertEligible(policies)).not.toThrow()
  expect(() => route.assertEligible([])).toThrow(`${prefix}_MODEL_ALIAS_UNRESOLVED`)
  for (const change of [
    (policy) => {
      policy.providerPolicy.deniedProviders = ['openai-codex']
    },
    (policy) => {
      policy.providerPolicy.allowedClasses = []
    },
    (policy) => {
      policy.providerPolicy.dataResidency = ['eu']
    },
  ]) {
    const denied = structuredClone(policies)
    change(denied[0])
    expect(() => route.assertEligible(denied)).toThrow(`${prefix}_MODEL_ROUTE_INELIGIBLE`)
  }
  expect(() =>
    new LocalRuntimeModelRoute({ ...options, modelCapabilities: [] }, prefix).assertEligible(
      policies
    )
  ).toThrow(`${prefix}_MODEL_ROUTE_INELIGIBLE`)
  expect(() => new LocalRuntimeModelRoute({ ...options, model: 'model; command' }, prefix)).toThrow(
    `${prefix}_MODEL_INVALID`
  )
})

test('ACP rejects an unresolved model route before reading task data', async () => {
  let reads = 0
  const route = new LocalRuntimeModelRoute({ ...options, modelAlias: 'unpublished.alias' }, 'ACP')
  const resolver = createRepositoryAcpTaskPromptResolver(
    {
      get: async () => {
        reads++
        return undefined
      },
    },
    undefined,
    route
  )
  await expect(
    resolver({ executionPlan: createExecutionPlanTestFixture() }, new AbortController().signal)
  ).rejects.toThrow('ACP_MODEL_ALIAS_UNRESOLVED')
  expect(reads).toBe(0)
})
