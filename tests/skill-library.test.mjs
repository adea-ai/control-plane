import { describe, expect, test } from 'bun:test'
import { validateSkillLibrary } from '../scripts/validate-skills.mjs'

describe('M11.11 skill library baseline', () => {
  test('the committed inventory matches the on-disk skills', async () => {
    const skills = await validateSkillLibrary()
    expect(skills.length).toBeGreaterThanOrEqual(9)
    for (const skill of skills) {
      expect(skill.files).toContain('SKILL.md')
      expect(skill.skillMdBytes).toBeGreaterThan(0)
    }
  })

  test('every retained skill has a usable trigger description', async () => {
    const skills = await validateSkillLibrary()
    for (const skill of skills) {
      expect(skill.description.length, skill.name).toBeGreaterThanOrEqual(10)
    }
  })

  test('every retained skill carries a declared version', async () => {
    const skills = await validateSkillLibrary()
    for (const skill of skills) {
      expect(typeof skill.version === 'string' && skill.version.length > 0, skill.name).toBe(true)
    }
  })
})
