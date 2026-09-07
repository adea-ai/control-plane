import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import {
  assertContextPackageIntegrity,
  contextAuthoringCommandKey,
  contextPackageSerializationFixtures,
} from '../packages/context/src/index.ts'

export function contextAuthoringRecoveryFixture(marker) {
  const package_ = contextPackageSerializationFixtures.futurePi
  const record = {
    scope: {
      principalRef: 'service:recovery-fixture',
      workspaceId: package_.projectState.workspaceId,
      projectId: package_.projectState.projectId,
      operation: 'context.author',
      idempotencyKey: `postgres-recovery:${marker}`,
    },
    payloadHash: `sha256:${createHash('sha256').update(marker).digest('hex')}`,
    contextPackage: {
      contextPackageId: package_.contextPackageId,
      contentDigest: package_.contentDigest,
    },
  }
  return {
    package_,
    record,
    commandKey: contextAuthoringCommandKey(record.scope),
    assertRecovered(recoveredRecord, recoveredPackage) {
      deepStrictEqual(recoveredRecord, record)
      deepStrictEqual(assertContextPackageIntegrity(recoveredPackage), package_)
    },
  }
}
