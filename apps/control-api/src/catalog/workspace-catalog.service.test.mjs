import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceCatalogFixtures } from '@control-plane/contracts'
import { VersionedCatalog, executionConstraintFixtures } from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
  SqliteWorkspaceCatalogCommandRepository,
} from '@control-plane/sqlite-persistence'
import { createControlApiApplication } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import { RepositoryWorkspaceCatalogService } from './workspace-catalog.service.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JZZZZZZ0123456789ABCDEFG'
const principal = 'svc_agent-hq'
const at = '2026-10-06T12:00:00.000Z'
const skillId = 'skl_01JABCDEF0123456789ABCDEF1'
const otherSkillId = 'skl_01JABCDEF0123456789ABCDEF2'
const systemSkillId = 'skl_01JABCDEF0123456789ABCDEF0'
const privateSkillId = 'skl_01JABCDEF0123456789ABCDEF9'
const profileId = 'prf_01JABCDEF0123456789ABCDEF1'
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'catalog-test',
}
const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-catalog-api-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  cleanups.push(async () => {
    await persistence.close()
    await rm(directory, { recursive: true, force: true })
  })
  await persistence.migrate()
  const catalog = new SqliteVersionedCatalogRepository(persistence)
  const logs = []
  let clock = Date.parse(at)
  const service = new RepositoryWorkspaceCatalogService({
    catalog,
    commands: new SqliteWorkspaceCatalogCommandRepository(persistence),
    logger: { write: (entry) => logs.push(entry) },
    now: () => new Date((clock += 1_000)),
  })
  return { persistence, catalog, service, logs }
}

/** Seeds records outside the API: one system Skill and one private Skill. */
async function seedForeignOwners(catalog) {
  const versioned = new VersionedCatalog(catalog, catalog)
  for (const [id, ownership] of [
    [systemSkillId, { scope: 'system' }],
    [privateSkillId, { scope: 'private', principalRef: principal }],
  ]) {
    await versioned.createSkill({ skillId: id, displayName: 'Seeded', ownership, createdAt: at })
    await versioned.publishNewSkillVersion({
      skillId: id,
      skillVersionId: id.replace('skl_', 'skv_'),
      manifest: manifest('1.0.0'),
      content: { instructions: 'Seeded skill.', artifactRefs: [] },
      at,
    })
  }
}

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

function read(operation, parameters, workspace = workspaceId) {
  return {
    ...WorkspaceCatalogFixtures.skillList.request,
    workspaceId: workspace,
    operation,
    parameters,
  }
}

function command(operation, payload, key, workspace = workspaceId) {
  return {
    ...WorkspaceCatalogFixtures.skillPublish.request,
    workspaceId: workspace,
    operation,
    idempotencyKey: `catalog-test-${key}`.padEnd(16, '0'),
    payload,
  }
}

function publishSkill(versionId, semanticVersion, key, extra = {}) {
  return command(
    'catalog.skill.publish',
    {
      skillId,
      skillVersionId: versionId,
      displayName: 'Release notes',
      manifest: manifest(semanticVersion),
      content: { instructions: 'Summarize merged work on localhost:3000.', artifactRefs: [] },
      ...extra,
    },
    key
  )
}

function profileDefinition(skills) {
  return {
    schemaVersion: 1,
    roleInstructions: 'Coordinate releases',
    skills,
    capabilityRequirements: [],
    executionConstraints: executionConstraintFixtures.readOnly,
    outputContractRefs: [],
  }
}

describe('workspace catalog service', () => {
  test('publishes immutable workspace Skill versions with the operator digest rules', async () => {
    const { service, logs } = await setup()
    const first = await service.publishSkill(
      publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'skill-1'),
      principal
    )
    expect(first.data.skill).toEqual({
      skillId,
      displayName: 'Release notes',
      ownership: { scope: 'workspace', workspaceId },
      readOnly: false,
      createdAt: '2026-10-06T12:00:01.000Z',
    })
    expect(first.data.version).toMatchObject({
      skillVersionId: 'skv_01JABCDEF0123456789ABCDEF1',
      semanticVersion: '1.0.0',
      revision: 2,
      lifecycle: 'published',
    })
    expect(first.data.version.manifest.contentDigest).toBe(first.data.version.contentDigest)

    // A new semantic version under the same Skill; the display name may be omitted.
    const second = await service.publishSkill(
      publishSkill('skv_01JABCDEF0123456789ABCDEF2', '1.1.0', 'skill-2', {
        displayName: undefined,
      }),
      principal
    )
    expect(second.data.version.lifecycle).toBe('published')

    // Immutability: a reused semantic version or version ID never replaces content.
    await expect(
      service.publishSkill(
        publishSkill('skv_01JABCDEF0123456789ABCDEF3', '1.0.0', 'skill-3'),
        principal
      )
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'SKILL_SEMANTIC_VERSION_CONFLICT' },
    })
    await expect(
      service.publishSkill(
        publishSkill('skv_01JABCDEF0123456789ABCDEF1', '2.0.0', 'skill-4'),
        principal
      )
    ).rejects.toMatchObject({ status: 409, response: { code: 'VERSION_ALREADY_EXISTS' } })
    await expect(
      service.publishSkill(
        publishSkill('skv_01JABCDEF0123456789ABCDEF5', '2.0.0', 'skill-5', {
          displayName: 'Renamed',
        }),
        principal
      )
    ).rejects.toMatchObject({ status: 409, response: { code: 'CATALOG_DISPLAY_NAME_CONFLICT' } })

    const audit = logs.filter((entry) => entry.event === 'catalog.skill.publish')
    expect(audit).toHaveLength(2)
    expect(audit[0].details).toMatchObject({
      workspaceId,
      principalId: principal,
      itemId: skillId,
      replayed: false,
    })
    expect(JSON.stringify(audit)).not.toContain('Summarize merged work')
  })

  test('replays the original receipt and rejects a changed payload under the same key', async () => {
    const { service, persistence, logs } = await setup()
    const request = publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'replay')
    const original = await service.publishSkill(request, principal)
    const replay = await service.publishSkill(
      { ...request, requestId: 'req_01JABCDEF0123456789ABCDEFH' },
      principal
    )
    expect(replay.requestId).toBe('req_01JABCDEF0123456789ABCDEFH')
    expect(replay.data).toEqual(original.data)
    expect(logs.at(-1).details.replayed).toBe(true)
    await expect(
      service.publishSkill(
        { ...request, payload: { ...request.payload, manifest: manifest('9.0.0') } },
        principal
      )
    ).rejects.toMatchObject({ status: 409, response: { code: 'CATALOG_COMMAND_CONFLICT' } })
    const receipts = await persistence.transaction((transaction) =>
      transaction.list('workspace-catalog-commands')
    )
    expect(receipts).toHaveLength(1)
  })

  test('lists owned and system items with stable pagination and hides other owners', async () => {
    const { service, catalog } = await setup()
    await seedForeignOwners(catalog)
    await service.publishSkill(
      publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'list-1'),
      principal
    )
    await service.publishSkill(
      command(
        'catalog.skill.publish',
        {
          skillId: otherSkillId,
          skillVersionId: 'skv_01JABCDEF0123456789ABCDEF7',
          displayName: 'Other workspace',
          manifest: manifest('1.0.0'),
          content: { instructions: 'Other.', artifactRefs: [] },
        },
        'list-other',
        otherWorkspaceId
      ),
      principal
    )

    const first = await service.listSkills(read('catalog.skill.list', { limit: 1 }), principal)
    expect(first.data.items.map(({ skill }) => skill.skillId)).toEqual([systemSkillId])
    expect(first.data.items[0].skill.readOnly).toBe(true)
    expect(first.data.items[0].latestVersion.lifecycle).toBe('published')
    const second = await service.listSkills(
      read('catalog.skill.list', { limit: 1, cursor: first.data.page.nextCursor }),
      principal
    )
    expect(second.data.items.map(({ skill }) => skill.skillId)).toEqual([skillId])
    expect(second.data.page.nextCursor).toBeUndefined()

    const other = await service.listSkills(
      read('catalog.skill.list', {}, otherWorkspaceId),
      principal
    )
    expect(other.data.items.map(({ skill }) => skill.skillId)).toEqual([
      systemSkillId,
      otherSkillId,
    ])
    await expect(
      service.listSkills(read('catalog.skill.list', { cursor: 'cur_not-a-cursor' }), principal)
    ).rejects.toMatchObject({ status: 400, response: { code: 'CATALOG_CURSOR_INVALID' } })
  })

  test('denies reads and writes across workspaces and keeps system items read-only', async () => {
    const { service, catalog } = await setup()
    await seedForeignOwners(catalog)
    await service.publishSkill(
      publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'deny-1'),
      principal
    )
    for (const id of [skillId, privateSkillId]) {
      await expect(
        service.getSkill(read('catalog.skill.get', { skillId: id }, otherWorkspaceId), principal)
      ).rejects.toMatchObject({ status: 404, response: { code: 'CATALOG_ITEM_NOT_FOUND' } })
    }
    await expect(
      service.publishSkill(
        command(
          'catalog.skill.publish',
          {
            skillId,
            skillVersionId: 'skv_01JABCDEF0123456789ABCDEF8',
            manifest: manifest('3.0.0'),
            content: { instructions: 'Hijack.', artifactRefs: [] },
          },
          'deny-2',
          otherWorkspaceId
        ),
        principal
      )
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      service.deprecateSkill(
        command(
          'catalog.skill.deprecate',
          { skillId, reason: 'not yours' },
          'deny-3',
          otherWorkspaceId
        ),
        principal
      )
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      service.publishSkill(
        command(
          'catalog.skill.publish',
          {
            skillId: systemSkillId,
            skillVersionId: 'skv_01JABCDEF0123456789ABCDEF6',
            manifest: manifest('2.0.0'),
            content: { instructions: 'Override.', artifactRefs: [] },
          },
          'deny-4'
        ),
        principal
      )
    ).rejects.toMatchObject({ status: 403, response: { code: 'CATALOG_ITEM_READ_ONLY' } })
    await expect(
      service.revokeSkill(
        command('catalog.skill.revoke', { skillId: systemSkillId, reason: 'no' }, 'deny-5'),
        principal
      )
    ).rejects.toMatchObject({ status: 403 })
    const system = await service.getSkill(
      read('catalog.skill.get', { skillId: systemSkillId }),
      principal
    )
    expect(system.data.skill.readOnly).toBe(true)
    expect(system.data.version.content.instructions).toBe('Seeded skill.')
    await expect(
      service.getSkill(read('catalog.skill.get', { skillId }), 'svc_someone-else')
    ).rejects.toMatchObject({ status: 403, response: { code: 'CATALOG_CALLER_MISMATCH' } })
  })

  test('deprecates and revokes exact versions or whole items with revision checks', async () => {
    const { service } = await setup()
    const first = await service.publishSkill(
      publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'life-1'),
      principal
    )
    await service.publishSkill(
      publishSkill('skv_01JABCDEF0123456789ABCDEF2', '1.1.0', 'life-2'),
      principal
    )
    const versionTarget = {
      skillId,
      skillVersionId: first.data.version.skillVersionId,
      expectedRevision: first.data.version.revision,
      reason: 'Superseded by 1.1.0',
    }
    const deprecated = await service.deprecateSkill(
      command('catalog.skill.deprecate', versionTarget, 'life-3'),
      principal
    )
    expect(deprecated.data.changed).toMatchObject([
      { skillVersionId: versionTarget.skillVersionId, revision: 3, lifecycle: 'deprecated' },
    ])
    await expect(
      service.deprecateSkill(command('catalog.skill.deprecate', versionTarget, 'life-4'), principal)
    ).rejects.toMatchObject({ status: 409, response: { code: 'VERSION_REVISION_CONFLICT' } })

    const item = await service.deprecateSkill(
      command('catalog.skill.deprecate', { skillId, reason: 'Retiring' }, 'life-5'),
      principal
    )
    expect(item.data.changed.map(({ semanticVersion }) => semanticVersion)).toEqual(['1.1.0'])
    const revoked = await service.revokeSkill(
      command('catalog.skill.revoke', { skillId, reason: 'Retired' }, 'life-6'),
      principal
    )
    expect(revoked.data.changed.map(({ lifecycle }) => lifecycle)).toEqual(['revoked', 'revoked'])
    const empty = await service.revokeSkill(
      command('catalog.skill.revoke', { skillId, reason: 'Again' }, 'life-7'),
      principal
    )
    expect(empty.data.changed).toEqual([])
    const detail = await service.getSkill(read('catalog.skill.get', { skillId }), principal)
    expect(detail.data.versions.map(({ lifecycle }) => lifecycle)).toEqual(['revoked', 'revoked'])
    // Revoked versions keep their exact content for provenance.
    expect(detail.data.version.content.instructions).toContain('Summarize merged work')
  })

  test('publishes profiles only with visible, published, digest-exact Skill pins', async () => {
    const { service, catalog } = await setup()
    await seedForeignOwners(catalog)
    const skill = await service.publishSkill(
      publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'pin-1'),
      principal
    )
    const pin = {
      skillId,
      skillVersionId: skill.data.version.skillVersionId,
      contentDigest: skill.data.version.contentDigest,
    }
    const system = await catalog.getSkillVersion('skv_01JABCDEF0123456789ABCDEF0')
    const systemPin = {
      skillId: systemSkillId,
      skillVersionId: system.skillVersionId,
      contentDigest: system.manifest.contentDigest,
    }
    const publishProfile = (profileVersionId, version, skills, key) =>
      command(
        'catalog.profile.publish',
        {
          profileId,
          profileVersionId,
          displayName: 'Release manager',
          version,
          definition: profileDefinition(skills),
        },
        key
      )

    const published = await service.publishProfile(
      publishProfile('pfv_01JABCDEF0123456789ABCDEF1', 1, [pin, systemPin], 'profile-1'),
      principal
    )
    expect(published.data.profile.ownership).toEqual({ scope: 'workspace', workspaceId })
    expect(published.data.version).toMatchObject({ version: 1, lifecycle: 'published' })

    const privateVersion = await catalog.getSkillVersion('skv_01JABCDEF0123456789ABCDEF9')
    for (const [skills, key] of [
      [[{ ...pin, contentDigest: `sha256:${'0'.repeat(64)}` }], 'profile-2'],
      [
        [
          {
            skillId: privateSkillId,
            skillVersionId: privateVersion.skillVersionId,
            contentDigest: privateVersion.manifest.contentDigest,
          },
        ],
        'profile-3',
      ],
    ]) {
      await expect(
        service.publishProfile(
          publishProfile('pfv_01JABCDEF0123456789ABCDEF2', 2, skills, key),
          principal
        )
      ).rejects.toMatchObject({ status: 422, response: { code: 'CATALOG_SKILL_PIN_INVALID' } })
    }
    await expect(
      service.publishProfile(
        publishProfile('pfv_01JABCDEF0123456789ABCDEF3', 1, [pin], 'profile-4'),
        principal
      )
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      service.publishProfile(
        command(
          'catalog.profile.publish',
          {
            profileId,
            profileVersionId: 'pfv_01JABCDEF0123456789ABCDEF4',
            version: 2,
            definition: { schemaVersion: 1 },
          },
          'profile-5'
        ),
        principal
      )
    ).rejects.toMatchObject({ status: 422, response: { code: 'CATALOG_CONTENT_INVALID' } })

    // Deprecated Skills cannot be newly pinned.
    await service.deprecateSkill(
      command('catalog.skill.deprecate', { skillId, reason: 'Old' }, 'profile-6'),
      principal
    )
    await expect(
      service.publishProfile(
        publishProfile('pfv_01JABCDEF0123456789ABCDEF5', 2, [pin], 'profile-7'),
        principal
      )
    ).rejects.toMatchObject({ status: 422 })

    const listed = await service.listProfiles(read('catalog.profile.list', {}), principal)
    expect(listed.data.items.map(({ profile }) => profile.profileId)).toEqual([profileId])
    expect(
      (await service.listProfiles(read('catalog.profile.list', {}, otherWorkspaceId), principal))
        .data.items
    ).toEqual([])
    const revoked = await service.revokeProfile(
      command(
        'catalog.profile.revoke',
        {
          profileId,
          profileVersionId: 'pfv_01JABCDEF0123456789ABCDEF1',
          expectedRevision: 2,
          reason: 'Retired',
        },
        'profile-8'
      ),
      principal
    )
    expect(revoked.data.changed[0].lifecycle).toBe('revoked')
    const detail = await service.getProfile(
      read('catalog.profile.get', {
        profileId,
        profileVersionId: 'pfv_01JABCDEF0123456789ABCDEF1',
      }),
      principal
    )
    expect(detail.data.version.definition.roleInstructions).toBe('Coordinate releases')
    await expect(
      service.getProfile(
        read('catalog.profile.get', {
          profileId,
          profileVersionId: 'pfv_01JABCDEF0123456789ABCDEF9',
        }),
        principal
      )
    ).rejects.toMatchObject({ status: 404, response: { code: 'CATALOG_VERSION_NOT_FOUND' } })
  })

  test('rejects credential material and requires a display name for new items', async () => {
    const { service } = await setup()
    await expect(
      service.publishSkill(
        publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'cred-1', {
          content: { instructions: 'Use ghp_' + 'a'.repeat(36), artifactRefs: [] },
        }),
        principal
      )
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'CATALOG_CREDENTIAL_INPUT_REJECTED' },
    })
    await expect(
      service.publishSkill(
        publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'cred-2', {
          displayName: undefined,
        }),
        principal
      )
    ).rejects.toMatchObject({ status: 422, response: { code: 'CATALOG_DISPLAY_NAME_REQUIRED' } })
    // Nothing was committed by the rejected commands.
    await expect(
      service.getSkill(read('catalog.skill.get', { skillId }), principal)
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('workspace catalog routes', () => {
  async function application(scopes, workspaceIds = [workspaceId]) {
    const { service } = await setup()
    const app = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      logger: { write: () => undefined },
      metadata,
      readiness: () => ({ status: 'ready', metadata }),
      workspaceCatalogService: service,
      serviceAuthenticator: new PolicyServiceAuthenticator({
        audience: 'control-plane',
        issuer: 'https://agent-hq.example',
        logger: { write: () => undefined },
        now: () => new Date('2026-10-06T12:00:00.000Z'),
        revocationChecker: { isRevoked: async () => false },
        verifier: {
          verify: async () => ({
            audience: 'control-plane',
            credentialId: 'credential-catalog-test',
            credentialKind: 'service',
            expiresAt: '2026-10-06T12:05:00.000Z',
            issuedAt: '2026-10-06T12:00:00.000Z',
            issuer: 'https://agent-hq.example',
            keyId: 'agent-hq-2026-10',
            principalId: principal,
            projectIds: [],
            scopes,
            workspaceIds,
          }),
        },
      }),
    })
    cleanups.push(() => app.close())
    return app
  }

  const post = (app, url, payload) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer catalog-test-credential' },
      payload,
    })

  test('deny by default: each route requires its own catalog scope', async () => {
    const readOnly = await application(['catalog:read'])
    const publish = publishSkill('skv_01JABCDEF0123456789ABCDEF1', '1.0.0', 'route-1')
    const denied = await post(readOnly, '/v1/catalog/skills/publish', publish)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    expect(
      (await post(readOnly, '/v1/catalog/skills/list', read('catalog.skill.list', {}))).statusCode
    ).toBe(200)

    const publisher = await application(['catalog:publish'])
    expect((await post(publisher, '/v1/catalog/skills/publish', publish)).statusCode).toBe(200)
    expect(
      (await post(publisher, '/v1/catalog/skills/list', read('catalog.skill.list', {}))).statusCode
    ).toBe(403)
    expect(
      (
        await post(
          publisher,
          '/v1/catalog/skills/deprecate',
          command('catalog.skill.deprecate', { skillId, reason: 'x' }, 'route-2')
        )
      ).statusCode
    ).toBe(403)

    const unrelated = await application(['graph:publish', 'profile:resolve'])
    for (const [url, body] of [
      ['/v1/catalog/profiles/list', read('catalog.profile.list', {})],
      ['/v1/catalog/profiles/get', read('catalog.profile.get', { profileId })],
      ['/v1/catalog/skills/get', read('catalog.skill.get', { skillId })],
    ]) {
      expect((await post(unrelated, url, body)).statusCode).toBe(403)
    }
  })

  test('the credential workspace claim must cover the envelope workspace', async () => {
    const app = await application(['catalog:read'], [otherWorkspaceId])
    const response = await post(app, '/v1/catalog/skills/list', read('catalog.skill.list', {}))
    expect(response.statusCode).toBe(403)
  })

  test('rejects project-scoped envelopes and an unconfigured deployment fails closed', async () => {
    const app = await application(['catalog:read'])
    const projectScoped = await post(app, '/v1/catalog/skills/list', {
      ...read('catalog.skill.list', {}),
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    })
    expect(projectScoped.statusCode).toBe(403)

    const unconfigured = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      logger: { write: () => undefined },
      metadata,
      readiness: () => ({ status: 'ready', metadata }),
    })
    cleanups.push(() => unconfigured.close())
    const response = await post(
      unconfigured,
      '/v1/catalog/skills/list',
      read('catalog.skill.list', {})
    )
    expect(response.statusCode).toBe(503)
  })
})
