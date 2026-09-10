import { describe, expect, test } from 'bun:test'
import {
  InMemoryVersionedCatalogRepository,
  VersionedCatalog,
  executionConstraintFixtures,
  resolveCatalogManifest,
} from './index.ts'

const now = '2026-08-28T12:00:00.000Z'
const ids = {
  profile: 'prf_01JABCDEF0123456789ABCDEFG',
  profileVersion: 'pfv_01JABCDEF0123456789ABCDEFG',
  root: 'skl_01JABCDEF0123456789ABCDEFG',
  rootVersion: 'skv_01JABCDEF0123456789ABCDEFG',
  dep: 'skl_01JBBCDEF0123456789ABCDEFG',
  depV1: 'skv_01JBBCDEF0123456789ABCDEFG',
  depV2: 'skv_01JCBCDEF0123456789ABCDEFG',
}

describe('deterministic catalog resolution', () => {
  test('selects the highest compatible stable dependency and emits a DAG order', async () => {
    const { catalog, repository } = await setup()
    const depV1 = await skill(catalog, ids.dep, ids.depV1, '1.2.0')
    const depV2 = await skill(catalog, ids.dep, ids.depV2, '1.4.0')
    await catalog.publishSkillVersion({
      skillVersionId: depV1.skillVersionId,
      expectedRevision: 1,
      publishedAt: now,
    })
    await catalog.publishSkillVersion({
      skillVersionId: depV2.skillVersionId,
      expectedRevision: 1,
      publishedAt: now,
    })
    const root = await skill(catalog, ids.root, ids.rootVersion, '2.0.0', [
      { skillId: ids.dep, versionRange: '^1.0.0' },
    ])
    await catalog.publishSkillVersion({
      skillVersionId: root.skillVersionId,
      expectedRevision: 1,
      publishedAt: now,
    })
    const profileDraft = await catalog.createAgentProfileDraft({
      profileId: ids.profile,
      profileVersionId: ids.profileVersion,
      version: 1,
      definition: profileDefinition([
        {
          skillId: ids.root,
          skillVersionId: root.skillVersionId,
          contentDigest: root.manifest.contentDigest,
        },
      ]),
      createdAt: now,
    })
    const profile = await catalog.publishAgentProfileVersion({
      profileVersionId: ids.profileVersion,
      expectedRevision: profileDraft.revision,
      publishedAt: now,
    })
    const resolved = await resolveCatalogManifest({ profile, skills: repository })
    expect(resolved.skills.map((resolvedSkill) => resolvedSkill.skillVersionId)).toEqual([
      ids.depV2,
      ids.rootVersion,
    ])
    expect(
      resolved.provenance.selected.find((selectedSkill) => selectedSkill.skillId === ids.dep)
        .requestedRanges
    ).toEqual(['^1.0.0'])
    expect(resolved.provenance.digest).toMatch(/^sha256:/)
  })

  test('fails closed for dependency cycles and prerelease-only candidates', async () => {
    const { catalog, repository } = await setup()
    const first = await skill(catalog, ids.root, ids.rootVersion, '1.0.0', [
      { skillId: ids.dep, versionRange: '^1.0.0' },
    ])
    const second = await skill(catalog, ids.dep, ids.depV1, '1.0.0', [
      { skillId: ids.root, versionRange: '^1.0.0' },
    ])
    await catalog.publishSkillVersion({
      skillVersionId: first.skillVersionId,
      expectedRevision: 1,
      publishedAt: now,
    })
    await catalog.publishSkillVersion({
      skillVersionId: second.skillVersionId,
      expectedRevision: 1,
      publishedAt: now,
    })
    await expect(
      resolveCatalogManifest({ profile: profileFor(first), skills: repository })
    ).rejects.toMatchObject({ code: 'SKILL_DEPENDENCY_CYCLE' })
  })
})

async function setup() {
  const repository = new InMemoryVersionedCatalogRepository()
  const catalog = new VersionedCatalog(repository, repository)
  await catalog.createAgentProfile({
    profileId: ids.profile,
    displayName: 'Test profile',
    ownership: { scope: 'system' },
    createdAt: now,
  })
  await catalog.createSkill({
    skillId: ids.root,
    displayName: ids.root,
    ownership: { scope: 'system' },
    createdAt: now,
  })
  await catalog.createSkill({
    skillId: ids.dep,
    displayName: ids.dep,
    ownership: { scope: 'system' },
    createdAt: now,
  })
  return { catalog, repository }
}

async function skill(catalog, skillId, skillVersionId, semanticVersion, dependencies = []) {
  return catalog.createSkillDraft({
    skillId,
    skillVersionId,
    manifest: {
      schemaVersion: 1,
      semanticVersion,
      requiredCapabilities: [],
      requiredTools: [],
      dependencies,
      conflicts: [],
      supersedes: [],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [2],
    },
    content: { instructions: 'test', artifactRefs: [] },
    createdAt: now,
  })
}

function profileDefinition(skills) {
  return {
    schemaVersion: 1,
    roleInstructions: 'test',
    skills,
    capabilityRequirements: [],
    executionConstraints: executionConstraintFixtures.safe,
    outputContractRefs: [],
  }
}

function profileFor(root) {
  return {
    profileVersionId: ids.profileVersion,
    profileId: ids.profile,
    version: 1,
    revision: 1,
    lifecycle: 'published',
    contentDigest: root.manifest.contentDigest,
    definition: profileDefinition([
      {
        skillId: root.skillId,
        skillVersionId: root.skillVersionId,
        contentDigest: root.manifest.contentDigest,
      },
    ]),
    createdAt: now,
    lifecycleMetadata: { publishedAt: now },
  }
}
