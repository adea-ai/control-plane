import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { SqliteContextPackageRepository, SqliteExecutionPlanRepository } from './index.ts'

export const acceptancePlan = createExecutionPlanTestFixture()

export const acceptancePlanReference = {
  executionPlanId: acceptancePlan.executionPlanId,
  contentDigest: acceptancePlan.contentDigest,
  schemaVersion: acceptancePlan.schemaVersion,
}

export async function seedAcceptancePlan(provider) {
  await new SqliteContextPackageRepository(provider).put(
    contextPackageSerializationFixtures.futurePi
  )
  await new SqliteExecutionPlanRepository(provider).put(acceptancePlan)
  return { plan: acceptancePlan, reference: acceptancePlanReference }
}
