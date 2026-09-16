import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const skillsRoot = join(repositoryRoot, '.agents', 'skills')
const inventoryPath = join(repositoryRoot, 'docs', 'skills', 'skill-library.json')

/** Machine-specific or absolute path markers that make a skill non-portable. */
const NON_PORTABLE = [/^\/(?:Users|home)\//u, /^[A-Z]:\\/u, /\/Users\/amf\//u]

async function listSkillDirectories() {
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
}

async function listFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full, base)))
    else if (entry.isFile()) files.push(relative(base, full).split('\\').join('/'))
  }
  return files.toSorted()
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const result = {}
  const lines = text.slice(4, end).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(lines[index])
    if (!match) continue
    if (match[2] === '|' || match[2] === '>' || match[2] === '|-' || match[2] === '>-') {
      // Block scalar: fold the indented continuation lines into one value.
      const body = []
      let cursor = index + 1
      while (cursor < lines.length && /^\s{2,}/.test(lines[cursor])) {
        body.push(lines[cursor].trim())
        cursor += 1
      }
      result[match[1]] = body.join(' ')
      index = cursor - 1
      continue
    }
    result[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return result
}

export async function discoverSkillLibrary() {
  const directories = await listSkillDirectories()
  const skills = []
  const errors = []
  for (const name of directories) {
    const directory = join(skillsRoot, name)
    const skillMdPath = join(directory, 'SKILL.md')
    let skillMd
    try {
      skillMd = await readFile(skillMdPath, 'utf8')
    } catch {
      errors.push({ skill: name, message: 'missing SKILL.md' })
      continue
    }
    const frontmatter = parseFrontmatter(skillMd)
    if (!frontmatter.name)
      errors.push({ skill: name, message: 'SKILL.md frontmatter is missing a name' })
    if (frontmatter.name !== undefined && frontmatter.name !== name) {
      errors.push({
        skill: name,
        message: `frontmatter name '${frontmatter.name}' does not match directory '${name}'`,
      })
    }
    if (!frontmatter.description || frontmatter.description.length < 10) {
      errors.push({ skill: name, message: 'SKILL.md frontmatter is missing a usable description' })
    }
    for (const marker of NON_PORTABLE) {
      if (marker.test(skillMd)) {
        errors.push({ skill: name, message: 'SKILL.md contains a machine-specific absolute path' })
        break
      }
    }
    const files = await listFiles(directory)
    skills.push({
      name,
      description: (frontmatter.description ?? '').slice(0, 400),
      files,
      skillMdBytes: Buffer.byteLength(skillMd, 'utf8'),
    })
  }
  return { skills: skills.toSorted((left, right) => left.name.localeCompare(right.name)), errors }
}

export async function validateSkillLibrary(options = {}) {
  const { skills, errors } = await discoverSkillLibrary()
  if (errors.length > 0) {
    for (const error of errors) console.error(`${error.skill}: ${error.message}`)
    throw new Error(`Skill library validation found ${errors.length} problem(s).`)
  }
  if (options.refresh) {
    await writeFile(inventoryPath, `${JSON.stringify({ skills }, null, 2)}\n`)
  }
  let stored
  try {
    stored = JSON.parse(await readFile(inventoryPath, 'utf8'))
  } catch {
    throw new Error('docs/skills/skill-library.json is missing; run with --refresh to write it.')
  }
  if (JSON.stringify(stored.skills) !== JSON.stringify(skills)) {
    throw new Error(
      'Skill library inventory drifted from the on-disk skills; re-run with --refresh.'
    )
  }
  return skills
}

if (import.meta.main) {
  const refresh = process.argv.includes('--refresh')
  try {
    const skills = await validateSkillLibrary({ refresh })
    console.log(`Skill library valid: ${skills.length} skills.`)
    if (refresh) console.log('Inventory written.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
