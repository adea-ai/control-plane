import { expect, test } from 'bun:test'
import { ControlPlaneClient, WorkspaceCatalogFixtures } from './index.ts'

function client(responses, calls) {
  return new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'fixture-token',
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return Response.json(responses.shift())
    },
  })
}

test('SDK workspace catalog methods use versioned routes and parse catalog responses', async () => {
  const calls = []
  const sdk = client(
    [
      WorkspaceCatalogFixtures.skillList.response,
      WorkspaceCatalogFixtures.skillGet.response,
      WorkspaceCatalogFixtures.skillDeprecation.response,
      WorkspaceCatalogFixtures.profileList.response,
    ],
    calls
  )
  expect(
    (await sdk.listWorkspaceSkills(WorkspaceCatalogFixtures.skillList.request)).data.items
  ).toHaveLength(1)
  expect(
    (await sdk.getWorkspaceSkill(WorkspaceCatalogFixtures.skillGet.request)).data.version.content
  ).toEqual({ instructions: 'Summarize merged changes.', artifactRefs: [] })
  expect(
    (await sdk.deprecateWorkspaceSkill(WorkspaceCatalogFixtures.skillDeprecation.request)).data
      .changed[0].lifecycle
  ).toBe('deprecated')
  expect(
    (await sdk.listWorkspaceProfiles(WorkspaceCatalogFixtures.profileList.request)).data.items[0]
      .profile.readOnly
  ).toBe(false)
  expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
    '/v1/catalog/skills/list',
    '/v1/catalog/skills/get',
    '/v1/catalog/skills/deprecate',
    '/v1/catalog/profiles/list',
  ])
})

test('SDK rejects invalid catalog requests before transport', async () => {
  const calls = []
  const sdk = client([], calls)
  await expect(
    sdk.publishWorkspaceSkill({
      ...WorkspaceCatalogFixtures.skillPublish.request,
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    })
  ).rejects.toThrow()
  await expect(
    sdk.revokeWorkspaceProfile({
      ...WorkspaceCatalogFixtures.profileRevocation.request,
      payload: { reason: 'missing target' },
    })
  ).rejects.toThrow()
  expect(calls).toEqual([])
})
