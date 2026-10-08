import { expect, test } from 'bun:test'
import { ContextPackageCompiler, contextPackageSerializationFixtures } from '@control-plane/context'
import {
  assertPortableManifest,
  createPortableRecord,
  finalizePortableManifest,
} from './manifest.ts'

function manifest(package_) {
  return finalizePortableManifest({
    schemaVersion: 1,
    contractVersion: 'control-plane-portable-state-v1',
    exportId: 'export-workspace-denial',
    sourceProfile: 'local',
    createdAt: package_.compiledAt,
    quiesced: true,
    includesSelectedHistory: false,
    componentVersions: {},
    compatibility: {
      minimumSchemaVersion: 1,
      contractVersion: 'control-plane-portable-state-v1',
      requiredCapabilities: [],
      sourcePersistence: 'sqlite',
      sourceObjectStore: 'filesystem',
    },
    records: [
      createPortableRecord({
        category: 'context-package',
        logicalId: `context-packages/${package_.contextPackageId}`,
        revision: 0,
        value: package_,
      }),
    ],
    artifacts: [],
    secretReferences: [],
    unsupportedReferences: [],
  })
}

test('project-only portability preserves historical project package and rejects workspace evidence', () => {
  const legacy = contextPackageSerializationFixtures.futurePi
  expect(assertPortableManifest(manifest(legacy)).records[0].value).toEqual(legacy)
  const workspace = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId: legacy.projectState.workspaceId,
    executionScope: { schemaVersion: 1, kind: 'workspace' },
    revision: legacy.projectState.revision,
    objective: 'Workspace lead',
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  })
  expect(() => assertPortableManifest(manifest(workspace))).toThrow(
    'PORTABLE_WORKSPACE_SCOPE_UNSUPPORTED'
  )
})
