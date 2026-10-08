import { expect, test } from 'bun:test'
import * as context from './index.ts'
import {
  ContextPackageCompiler,
  ContextPackageSchema,
  ContextPackageAuthoringService,
  InMemoryContextPackageRepository,
  assertContextPackageIntegrity,
  assertContextPackageDerivedFrom,
  contextPackageSerializationFixtures,
  deriveContextPackage,
  composeProviderContextPackage,
} from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const artifactId = 'art_01JABCDEF0123456789ABCDEFG'
const executionScope = { schemaVersion: 1, kind: 'workspace' }
const compiler = new ContextPackageCompiler('1.0.0')

function input() {
  const legacy = contextPackageSerializationFixtures.futurePi
  return {
    workspaceId,
    executionScope,
    revision: 4,
    objective: 'Run the workspace lead',
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  }
}

function projectPackage(overrides = {}) {
  const base = input()
  return compiler.compile({
    objective: base.objective,
    projectState: {
      schemaVersion: 1,
      workspaceId,
      projectId,
      revision: 4,
      items: [],
      createdAt: base.compiledAt,
      updatedAt: base.compiledAt,
      ...overrides.projectState,
    },
    expectedProjectStateRevision: 4,
    candidates: [],
    artifacts: [],
    constraints: base.constraints,
    permissions: [],
    successCriteria: base.successCriteria,
    returnContract: base.returnContract,
    budgets: base.budgets,
    compiledAt: base.compiledAt,
    ...overrides,
  })
}

test('workspace parent binds an independently compiled project child without creating authority', () => {
  const parent = compiler.compileWorkspace(input())
  const project = projectPackage()
  const child = context.bindProjectContextPackageToWorkspaceParent(parent, project)
  expect(child.schemaVersion).toBe(1)
  expect(child.projectState).toEqual(project.projectState)
  expect(child.parentContextPackage).toEqual({
    contextPackageId: parent.contextPackageId,
    contentDigest: parent.contentDigest,
  })
  expect(child.contentDigest).not.toBe(project.contentDigest)
  expect(assertContextPackageIntegrity(project)).toEqual(project)
  expect(assertContextPackageDerivedFrom(parent, child)).toEqual(child)
  expect(() => context.bindProjectContextPackageToWorkspaceParent(parent, parent)).toThrow(
    'CHILD_SCOPE_EXPANSION'
  )
  const otherParent = compiler.compileWorkspace({
    ...input(),
    objective: 'Another workspace intent',
  })
  expect(() => context.bindProjectContextPackageToWorkspaceParent(otherParent, child)).toThrow(
    'CONTRADICTORY_CONTEXT_REFERENCE'
  )
})

test('project child binding rejects cross-workspace, resource, permission, provider and budget expansion', () => {
  const parent = compiler.compileWorkspace(input())
  for (const project of [
    projectPackage({
      projectState: {
        schemaVersion: 1,
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH',
        projectId,
        revision: 4,
        items: [],
        createdAt: input().compiledAt,
        updatedAt: input().compiledAt,
      },
    }),
    projectPackage({ permissions: ['project:write'] }),
    projectPackage({ constraints: { ...input().constraints, allowedArtifactIds: [artifactId] } }),
    projectPackage({
      constraints: {
        ...input().constraints,
        allowedStateItemIds: ['psi_01JABCDEF0123456789ABCDEFG'],
      },
    }),
    composeProviderContextPackage(projectPackage(), {
      callerContextRefs: [],
      localProjectGrantRefs: ['grant://project'],
      contributions: [],
    }),
  ])
    expect(() => context.bindProjectContextPackageToWorkspaceParent(parent, project)).toThrow(
      'CHILD_SCOPE_EXPANSION'
    )
  expect(() =>
    context.bindProjectContextPackageToWorkspaceParent(
      parent,
      projectPackage({
        budgets: { ...input().budgets, maximumBytes: input().budgets.maximumBytes + 1 },
      })
    )
  ).toThrow('CHILD_BUDGET_EXPANSION')
})

test('legacy package identity and serialization stay pinned without normalized scope injection', () => {
  const legacy = contextPackageSerializationFixtures.futurePi
  expect(legacy.contentDigest).toBe(
    'sha256:29eddfaf33523139f4af9bb9bb12e6786df2c30e93790a8360874e88191eb641'
  )
  expect(legacy.contextPackageId).toBe('ctx_57PXZBSKA8RKKX5FKEWVP4Q6F0')
  expect(assertContextPackageIntegrity(legacy)).toEqual(legacy)
  for (const mutated of [
    { ...legacy, executionScope },
    { ...legacy, projectState: { ...legacy.projectState, executionScope } },
    { ...legacy, schemaVersion: 2 },
    {
      ...legacy,
      schemaVersion: 2,
      projectState: {
        ...legacy.projectState,
        executionScope: { schemaVersion: 1, kind: 'project', projectId },
      },
    },
  ])
    expect(() => assertContextPackageIntegrity(mutated)).toThrow()
})

test('trusted workspace compilation and repository round trip need no project row', async () => {
  const package_ = compiler.compileWorkspace(input())
  expect(package_.schemaVersion).toBe(2)
  expect(package_.projectState).toEqual({ workspaceId, executionScope, revision: 4 })
  expect(package_.stateItems).toEqual([])
  expect(package_.constraints.allowedStateItemIds).toEqual([])
  const repository = new InMemoryContextPackageRepository()
  const reference = await repository.put(package_)
  expect(await repository.get(reference)).toEqual(package_)
  const child = deriveContextPackage(package_, {
    objective: 'Narrow workspace child',
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: package_.budgets,
    successCriteria: package_.successCriteria,
    returnContract: package_.returnContract,
    compiledAt: package_.compiledAt,
  })
  expect(assertContextPackageDerivedFrom(package_, child)).toEqual(child)
  expect(child.projectState).toEqual(package_.projectState)
})

test('workspace schema fails closed on missing scope, fake project and project state items', () => {
  const package_ = compiler.compileWorkspace(input())
  const legacy = contextPackageSerializationFixtures.futurePi
  for (const mutated of [
    { ...package_, schemaVersion: 1 },
    { ...package_, projectState: { workspaceId, revision: 4 } },
    { ...package_, projectState: { ...package_.projectState, projectId } },
    {
      ...package_,
      constraints: {
        ...package_.constraints,
        allowedStateItemIds: ['psi_01JABCDEF0123456789ABCDEFG'],
      },
    },
    { ...package_, projectState: { ...package_.projectState, projectId: null } },
    {
      ...legacy,
      schemaVersion: 2,
      projectState: {
        ...legacy.projectState,
        executionScope: {
          schemaVersion: 1,
          kind: 'project',
          projectId: 'prj_01JABCDEF0123456789ABCDEFH',
        },
      },
    },
  ])
    expect(ContextPackageSchema.safeParse(mutated).success).toBe(false)
  expect(() =>
    assertContextPackageIntegrity({
      ...package_,
      projectState: { ...package_.projectState, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
    })
  ).toThrow('CONTEXT_PACKAGE_INTEGRITY_ERROR')
})

test('workspace artifacts require explicit current host authorization and obey budgets', () => {
  const base = input()
  const artifact = {
    artifactId,
    contentDigest: `sha256:${'b'.repeat(64)}`,
    mediaType: 'text/plain',
    sizeBytes: 64,
    sensitivity: 'public',
    authorized: true,
    state: 'available',
  }
  const scoped = {
    ...base,
    artifacts: [artifact],
    constraints: { ...base.constraints, allowedArtifactIds: [artifactId] },
  }
  const package_ = compiler.compileWorkspace(scoped)
  expect(package_.artifactRefs.map((entry) => entry.artifactId)).toEqual([artifactId])
  expect(package_.usage).toEqual({ bytes: 64, tokens: 16 })
  expect(() =>
    compiler.compileWorkspace({ ...scoped, artifacts: [{ ...artifact, authorized: false }] })
  ).toThrow('UNAUTHORIZED_CONTEXT')
  expect(() =>
    compiler.compileWorkspace({ ...scoped, artifacts: [{ ...artifact, state: 'revoked' }] })
  ).toThrow('REVOKED_ARTIFACT')
  expect(() =>
    compiler.compileWorkspace({ ...scoped, budgets: { maximumBytes: 63, maximumTokens: 16 } })
  ).toThrow('REQUIRED_CONTEXT_EXCEEDS_BUDGET')
  expect(() => compiler.compileWorkspace({ ...scoped, projectId })).toThrow()
})

test('workspace packages cannot compose project-only provider grants or contributions', () => {
  const package_ = compiler.compileWorkspace(input())
  expect(() =>
    composeProviderContextPackage(package_, {
      callerContextRefs: [],
      localProjectGrantRefs: ['grant://project'],
      contributions: [],
    })
  ).toThrow('WORKSPACE_CONTEXT_PROVIDER_UNSUPPORTED')
})

test('project-only compiler and authoring reject workspace scope before project lookup', async () => {
  const scopeInput = {
    ...input(),
    projectId,
    projectState: { workspaceId, projectId, executionScope },
  }
  expect(() => compiler.compile(scopeInput)).toThrow('WORKSPACE_CONTEXT_UNSUPPORTED')
  let lookedUp = false
  let authorized = false
  const service = new ContextPackageAuthoringService({
    compilerVersion: '1.0.0',
    projectStates: {
      async getAtRevision() {
        lookedUp = true
      },
    },
    packages: new InMemoryContextPackageRepository(),
    authority: {
      async authorize() {
        authorized = true
      },
      async resolveArtifact() {},
    },
    now: () => new Date(input().compiledAt),
  })
  await expect(service.create('principal://workspace', scopeInput)).rejects.toThrow(
    'WORKSPACE_CONTEXT_UNSUPPORTED'
  )
  expect(authorized).toBe(false)
  expect(lookedUp).toBe(false)
})
