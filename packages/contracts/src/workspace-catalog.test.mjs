import { describe, expect, test } from 'bun:test'
import {
  PublicContractManifest,
  ReadRequestEnvelopeSchema,
  StateChangingCommandEnvelopeSchema,
  WorkspaceAgentProfileGetRequestSchema,
  WorkspaceAgentProfileListRequestSchema,
  WorkspaceAgentProfileListResponseSchema,
  WorkspaceAgentProfileRevocationRequestSchema,
  WorkspaceCatalogFixtures,
  WorkspaceCatalogOwnershipSchema,
  WorkspaceCatalogScopes,
  WorkspaceSkillDeprecationRequestSchema,
  WorkspaceSkillGetRequestSchema,
  WorkspaceSkillGetResponseSchema,
  WorkspaceSkillLifecycleResponseSchema,
  WorkspaceSkillListRequestSchema,
  WorkspaceSkillListResponseSchema,
  WorkspaceSkillPublishRequestSchema,
  assessContractCompatibility,
} from './index.ts'

describe('workspace catalog contracts', () => {
  test('provider and consumer fixtures parse and stay generic envelopes', () => {
    const pairs = [
      [WorkspaceSkillListRequestSchema, WorkspaceCatalogFixtures.skillList.request],
      [WorkspaceSkillListResponseSchema, WorkspaceCatalogFixtures.skillList.response],
      [WorkspaceSkillGetRequestSchema, WorkspaceCatalogFixtures.skillGet.request],
      [WorkspaceSkillGetResponseSchema, WorkspaceCatalogFixtures.skillGet.response],
      [WorkspaceSkillPublishRequestSchema, WorkspaceCatalogFixtures.skillPublish.request],
      [WorkspaceSkillDeprecationRequestSchema, WorkspaceCatalogFixtures.skillDeprecation.request],
      [WorkspaceSkillLifecycleResponseSchema, WorkspaceCatalogFixtures.skillDeprecation.response],
      [WorkspaceAgentProfileListRequestSchema, WorkspaceCatalogFixtures.profileList.request],
      [WorkspaceAgentProfileListResponseSchema, WorkspaceCatalogFixtures.profileList.response],
      [WorkspaceAgentProfileGetRequestSchema, WorkspaceCatalogFixtures.profileGet.request],
      [
        WorkspaceAgentProfileRevocationRequestSchema,
        WorkspaceCatalogFixtures.profileRevocation.request,
      ],
    ]
    for (const [schema, fixture] of pairs) expect(schema.parse(fixture)).toEqual(fixture)
    for (const read of [
      WorkspaceCatalogFixtures.skillList.request,
      WorkspaceCatalogFixtures.profileGet.request,
    ]) {
      expect(ReadRequestEnvelopeSchema.safeParse(read).success).toBe(true)
    }
    for (const command of [
      WorkspaceCatalogFixtures.skillPublish.request,
      WorkspaceCatalogFixtures.profileRevocation.request,
    ]) {
      expect(StateChangingCommandEnvelopeSchema.safeParse(command).success).toBe(true)
    }
  })

  test('requests are workspace-scoped and reject unknown authority fields', () => {
    const { request } = WorkspaceCatalogFixtures.skillPublish
    expect(
      WorkspaceSkillPublishRequestSchema.safeParse({
        ...request,
        projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      }).success
    ).toBe(false)
    expect(
      WorkspaceSkillPublishRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, ownership: { scope: 'system' } },
      }).success
    ).toBe(false)
    expect(
      WorkspaceSkillListRequestSchema.safeParse({
        ...WorkspaceCatalogFixtures.skillList.request,
        parameters: { limit: 101 },
      }).success
    ).toBe(false)
  })

  test('lifecycle targets are either one exact version with a revision or the whole item', () => {
    const { request } = WorkspaceCatalogFixtures.skillDeprecation
    const parse = (payload) =>
      WorkspaceSkillDeprecationRequestSchema.safeParse({ ...request, payload }).success
    expect(parse({ skillId: request.payload.skillId, reason: 'Retire' })).toBe(true)
    expect(parse(request.payload)).toBe(true)
    expect(
      parse({
        skillId: request.payload.skillId,
        skillVersionId: request.payload.skillVersionId,
        reason: 'Missing revision',
      })
    ).toBe(false)
    expect(parse({ ...request.payload, reason: '' })).toBe(false)
  })

  test('ownership exposes only system and workspace scopes', () => {
    expect(WorkspaceCatalogOwnershipSchema.safeParse({ scope: 'system' }).success).toBe(true)
    expect(
      WorkspaceCatalogOwnershipSchema.safeParse({ scope: 'private', principalRef: 'p' }).success
    ).toBe(false)
    expect(
      WorkspaceCatalogOwnershipSchema.safeParse({ scope: 'organization', organizationRef: 'o' })
        .success
    ).toBe(false)
  })

  test('is additive within the current major with explicit scopes', () => {
    expect(PublicContractManifest.current.major).toBe(3)
    expect(
      assessContractCompatibility({
        consumer: PublicContractManifest.current,
        producer: WorkspaceCatalogFixtures.skillList.response.contractVersion,
      }).compatible
    ).toBe(true)
    expect(WorkspaceCatalogScopes).toEqual({
      read: 'catalog:read',
      publish: 'catalog:publish',
      manage: 'catalog:manage',
    })
  })
})
