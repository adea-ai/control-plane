import { describe, expect, test } from 'bun:test'
import {
  InMemoryVersionedCatalogRepository,
  VersionedCatalog,
  WorkspaceCatalog,
  WorkspaceCatalogError,
  visiblePage,
  workspaceCatalogVisibility,
} from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JZZZZZZ0123456789ABCDEFG'
const at = '2026-10-06T12:00:00.000Z'
const later = '2026-10-06T13:00:00.000Z'

function manifest(semanticVersion) {
  return {
    schemaVersion: 1,
    semanticVersion,
    requiredCapabilities: [],
    requiredTools: [],
    compatibleProfileSchemaVersions: [1],
    compatibleContractMajorVersions: [3],
  }
}

describe('workspace catalog visibility', () => {
  test('exposes exact workspace and system ownership only', () => {
    expect(workspaceCatalogVisibility({ scope: 'system' }, workspaceId)).toBe('system')
    expect(workspaceCatalogVisibility({ scope: 'workspace', workspaceId }, workspaceId)).toBe(
      'owned'
    )
    for (const ownership of [
      { scope: 'workspace', workspaceId: otherWorkspaceId },
      { scope: 'workspace', workspaceId, extra: true },
      { scope: 'system', workspaceId },
      { scope: 'private', principalRef: 'svc_agent-hq' },
      { scope: 'organization', organizationRef: 'org' },
      null,
      [],
    ]) {
      expect(workspaceCatalogVisibility(ownership, workspaceId)).toBeUndefined()
    }
  })

  test('pages visible records by ascending ID after an exclusive bound', () => {
    const items = [
      { id: 'b', ownership: { scope: 'system' } },
      { id: 'a', ownership: { scope: 'workspace', workspaceId } },
      { id: 'c', ownership: { scope: 'workspace', workspaceId: otherWorkspaceId } },
      { id: 'd', ownership: { scope: 'workspace', workspaceId } },
    ]
    const page = (after, limit) =>
      visiblePage(items, (item) => item.id, { workspaceId, after, limit }).map(({ id }) => id)
    expect(page(undefined, 2)).toEqual(['a', 'b'])
    expect(page('b', 2)).toEqual(['d'])
  })
})

describe('workspace catalog use cases', () => {
  test('publishes through the versioned catalog and changes item lifecycles in order', async () => {
    const repository = new InMemoryVersionedCatalogRepository()
    const catalog = new WorkspaceCatalog(repository, workspaceId)
    const skillId = 'skl_01JABCDEF0123456789ABCDEF1'
    for (const [index, semanticVersion] of ['1.0.0', '1.1.0'].entries()) {
      await catalog.publishSkillVersion({
        skillId,
        skillVersionId: `skv_01JABCDEF0123456789ABCDEF${index + 1}`,
        displayName: 'Release notes',
        manifest: manifest(semanticVersion),
        content: { instructions: 'Summarize.', artifactRefs: [] },
        at: index === 0 ? at : later,
      })
    }
    expect((await repository.getSkill(skillId)).provenance).toEqual({
      source: 'workspace-authorized',
      ownerRef: workspaceId,
      trust: 'authorized',
    })
    const listing = await catalog.listSkills(repository, { limit: 10 })
    expect(listing.items[0].latestVersion.manifest.semanticVersion).toBe('1.1.0')
    const { changed } = await catalog.changeSkillLifecycle(
      'deprecate',
      skillId,
      { reason: 'Retire' },
      later
    )
    expect(changed.map((version) => version.manifest.semanticVersion)).toEqual(['1.0.0', '1.1.0'])
    await expect(
      new WorkspaceCatalog(repository, otherWorkspaceId).changeSkillLifecycle(
        'revoke',
        skillId,
        { reason: 'Not owner' },
        later
      )
    ).rejects.toBeInstanceOf(WorkspaceCatalogError)
  })

  test('system items are readable but never writable by a workspace', async () => {
    const repository = new InMemoryVersionedCatalogRepository()
    const versioned = new VersionedCatalog(repository, repository)
    const profileId = 'prf_01JABCDEF0123456789ABCDEF1'
    await versioned.createAgentProfile({
      profileId,
      displayName: 'System coordinator',
      ownership: { scope: 'system' },
      createdAt: at,
    })
    const catalog = new WorkspaceCatalog(repository, workspaceId)
    expect((await catalog.getAgentProfile(profileId)).profile.profileId).toBe(profileId)
    await expect(
      catalog.changeAgentProfileLifecycle('deprecate', profileId, { reason: 'No' }, later)
    ).rejects.toMatchObject({ code: 'CATALOG_ITEM_READ_ONLY' })
  })
})
