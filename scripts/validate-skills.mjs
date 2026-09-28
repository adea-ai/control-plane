import { readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { compareCodePointOrder } from '../packages/contracts/src/canonical-json.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const skillsRoot = join(repositoryRoot, '.agents', 'skills')
const inventoryPath = join(repositoryRoot, 'docs', 'skills', 'skill-library.json')

/** Machine-specific or absolute path markers that make a skill non-portable. */
const NON_PORTABLE = [/^\/(?:Users|home)\//u, /^[A-Z]:\\/u, /\/Users\/amf\//u]
const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/gu
const TEXT_FILE = /\.(?:md|ya?ml|json|m?js|ts|txt)$/iu

function isInside(directory, target) {
  const pathFromDirectory = relative(directory, target)
  return (
    pathFromDirectory === '' ||
    (!pathFromDirectory.startsWith('..') && !isAbsolute(pathFromDirectory))
  )
}

async function validateMarkdownLinks(skill, sourcePath, markdown, errors) {
  const file = relative(repositoryRoot, sourcePath).split('\\').join('/')
  const repositoryRealpath = await realpath(repositoryRoot)
  const withoutFencedCode = markdown.replace(/^ {0,3}```[\s\S]*?^ {0,3}```[^\r\n]*?/gmu, '')

  for (const match of withoutFencedCode.matchAll(MARKDOWN_LINK)) {
    const rawTarget = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1]
    if (!rawTarget) continue
    if (/^file:/iu.test(rawTarget)) {
      errors.push({ skill, message: `${file}: file-URI links are not portable` })
      continue
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(rawTarget)) continue

    const pathPart = rawTarget.split(/[?#]/u, 1)[0]
    let decodedPath
    try {
      decodedPath = decodeURIComponent(pathPart)
    } catch {
      errors.push({ skill, message: `${file}: local Markdown link has invalid URL encoding` })
      continue
    }

    const targetPath = resolve(dirname(sourcePath), decodedPath || sourcePath)
    if (!isInside(repositoryRoot, targetPath)) {
      errors.push({
        skill,
        message: `${file}: local Markdown link resolves outside the repository`,
      })
      continue
    }

    try {
      const targetRealpath = await realpath(targetPath)
      if (!isInside(repositoryRealpath, targetRealpath)) {
        errors.push({
          skill,
          message: `${file}: local Markdown link resolves outside the repository`,
        })
      }
    } catch {
      errors.push({
        skill,
        message: `${file}: local Markdown link target '${rawTarget}' does not exist`,
      })
    }
  }
}

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
    const versionMatch = /^\s{2}version:\s*"(.+)"\s*$/m.exec(skillMd)
    if (!versionMatch) {
      errors.push({ skill: name, message: 'SKILL.md frontmatter is missing metadata.version' })
    }
    if (!/^## Evidence contract$/m.test(skillMd)) {
      errors.push({ skill: name, message: 'SKILL.md is missing an Evidence contract section' })
    }
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
    const files = await listFiles(directory)
    for (const file of files) {
      if (!TEXT_FILE.test(file)) continue
      const content = file === 'SKILL.md' ? skillMd : await readFile(join(directory, file), 'utf8')
      for (const marker of NON_PORTABLE) {
        if (marker.test(content)) {
          errors.push({ skill: name, message: `${file} contains a machine-specific absolute path` })
          break
        }
      }
      if (file.endsWith('.md')) {
        await validateMarkdownLinks(name, join(directory, file), content, errors)
      }
    }
    skills.push({
      name,
      description: (frontmatter.description ?? '').slice(0, 400),
      version: versionMatch ? versionMatch[1] : undefined,
      files,
      skillMdBytes: Buffer.byteLength(skillMd, 'utf8'),
    })
  }
  const registryPath = join(skillsRoot, 'README.md')
  try {
    await validateMarkdownLinks(
      'library-registry',
      registryPath,
      await readFile(registryPath, 'utf8'),
      errors
    )
  } catch {
    errors.push({ skill: 'library-registry', message: '.agents/skills/README.md is missing' })
  }
  return {
    skills: skills.toSorted((left, right) => compareCodePointOrder(left.name, right.name)),
    errors,
  }
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
