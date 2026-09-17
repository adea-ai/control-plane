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

  test('every retained skill documents an evidence contract', async () => {
    const skills = await validateSkillLibrary()
    for (const skill of skills) {
      const body = await (
        await import('node:fs/promises')
      ).readFile(`.agents/skills/${skill.name}/SKILL.md`, 'utf8')
      expect(/^## Evidence contract$/m.test(body), skill.name).toBe(true)
    }
  })

  test('every retained skill carries a declared version', async () => {
    const skills = await validateSkillLibrary()
    for (const skill of skills) {
      expect(typeof skill.version === 'string' && skill.version.length > 0, skill.name).toBe(true)
    }
  })
})
