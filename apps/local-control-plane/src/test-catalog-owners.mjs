/** Seed explicit catalog ownership for plans inserted directly by Local tests. */
export async function seedSystemCatalogOwners(catalog, profileVersion, skillVersions) {
  if (!(await catalog.getAgentProfile(profileVersion.profileId))) {
    await catalog.insertAgentProfile({
      profileId: profileVersion.profileId,
      displayName: 'System test profile',
      ownership: { scope: 'system' },
      createdAt: profileVersion.createdAt,
    })
  }
  for (const skillVersion of skillVersions) {
    if (await catalog.getSkill(skillVersion.skillId)) continue
    await catalog.insertSkill({
      skillId: skillVersion.skillId,
      displayName: 'System test skill',
      ownership: { scope: 'system' },
      createdAt: skillVersion.createdAt,
    })
  }
}
