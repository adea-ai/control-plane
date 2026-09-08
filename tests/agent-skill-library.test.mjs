import { expect, test } from 'bun:test'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

test.each(['control-plane-audit', 'code-review'])(
  '%s has versioned ownership, resolvable references, and real commands',
  async (name) => {
    const path = resolve(skillRoot, name, 'SKILL.md')
    const text = await readFile(path, 'utf8')
    const metadata = Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(text)[1])
    expect(metadata.metadata.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(metadata.metadata.owner.trim().length).toBeGreaterThan(0)
    const canonicalRoot = await realpath(root)
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1])
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      const target = await realpath(resolve(dirname(path), link))
      const local = relative(canonicalRoot, target)
      expect(local.startsWith('..')).toBe(false)
    }
    const scripts = JSON.parse(await read('package.json')).scripts
    const commands = [...text.matchAll(/`bun run ([a-z0-9:-]+)`/g)].map((match) => match[1])
    if (name === 'control-plane-audit') expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) expect(typeof scripts[command]).toBe('string')
  }
)
