import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSkillLibrary, validateSkillLibrary } from '../scripts/validate-skills.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const skillRoot = resolve(root, '.agents/skills')
const read = (path) => readFile(resolve(root, path), 'utf8')

test('the shared skill lock matches discoverable skill directories and valid identities', async () => {
  const lock = JSON.parse(await read('.agents/.skill-lock.json'))
  expect(new Set(lock.skills).size).toBe(lock.skills.length)
  const directories = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
  expect(lock.skills.toSorted()).toEqual(directories)
  for (const name of lock.skills) {
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    const text = await read(`.agents/skills/${name}/SKILL.md`)
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    expect(match).not.toBeNull()
    const metadata = Bun.YAML.parse(match[1])
    expect(metadata.name).toBe(name)
    expect(typeof metadata.description).toBe('string')
    expect(metadata.description.trim().length).toBeGreaterThan(0)
  }
})

test('every retained skill has an owner, version, complete evidence contract, valid commands, and local links', async () => {
  const lock = JSON.parse(await read('.agents/.skill-lock.json'))
  const scripts = JSON.parse(await read('package.json')).scripts
  const requiredContractFields = [
    '**Inputs:**',
    '**Safe assumptions:**',
    '**Allowed mutations:**',
    '**Outputs:**',
    '**Verification commands:**',
    '**Failure/skip reporting:**',
    '**Cleanup:**',
    '**Completion-claim guard:**',
  ]

  const { skills, errors } = await discoverSkillLibrary()
  expect(errors).toEqual([])
  expect(skills.map((skill) => skill.name)).toEqual(lock.skills.toSorted())
  for (const skill of skills) expect(skill.files).toContain('SKILL.md')

  await validateSkillLibrary()

  for (const name of lock.skills) {
    const text = await read(`.agents/skills/${name}/SKILL.md`)
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    const metadata = Bun.YAML.parse(match[1])
    expect(metadata.metadata?.version, name).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
    )
    expect(metadata.metadata?.owner?.trim().length, name).toBeGreaterThan(0)
    expect(/^## Evidence contract$/m.test(text), name).toBe(true)
    for (const field of requiredContractFields) expect(text, `${name}: ${field}`).toContain(field)

    const commands = [...text.matchAll(/`bun run ([a-z0-9][a-z0-9:_-]*)`/gu)].map(
      (command) => command[1]
    )
    for (const command of commands) {
      expect(typeof scripts[command], `${name}: bun run ${command}`).toBe('string')
    }
  }
})
