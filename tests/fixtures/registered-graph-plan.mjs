import { isDeepStrictEqual } from 'node:util'
import {
  ExecutionPlanAcceptanceValidator,
  ExecutionPlanCompiler,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { seedSystemCatalogOwners } from '../../apps/local-control-plane/src/test-catalog-owners.mjs'

export function createRegisteredGraphPlan(reference, input) {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...createExecutionPlanTestFixtureInputs(),
    graph: { reference, input },
  })
}

/**
 * Admission for the server-owned handwritten graph used by recovery fixtures.
 * This does not establish default production graph-catalog composition.
 */
export async function seedRegisteredGraphPlan(composition, plan, registeredSelection) {
  const inputs = createExecutionPlanTestFixtureInputs()
  await seedSystemCatalogOwners(composition.catalog, inputs.profile, inputs.skills)
  await composition.catalog.insertAgentProfileVersion(inputs.profile)
  for (const skill of inputs.skills) await composition.catalog.insertSkillVersion(skill)
  await composition.contextPackages.put(inputs.contextPackage)
  await composition.executionPlans.put(plan)
  const selection = structuredClone(registeredSelection)
  const workspaceId = inputs.correlation.workspaceId
  return new ExecutionPlanAcceptanceValidator(composition.executionPlans, {
    catalog: { profiles: composition.catalog, skills: composition.catalog },
    graphs: {
      validate: async (scope, proposed) =>
        scope === workspaceId && isDeepStrictEqual(proposed, selection),
      authorize: async (scope, reference) =>
        scope === workspaceId && isDeepStrictEqual(reference, selection.reference),
    },
  })
}
