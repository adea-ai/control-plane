import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { compareCodePointOrder } from '../packages/contracts/src/canonical-json.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const skillsDirectory = '.agents/skills'
const inventoryFile = 'docs/skills/skill-library.json'
const REGISTRY_FILE = 'README.md'
const TEXT_FILE = /\.(?:md|ya?ml|json|m?js|ts|txt|sh|toml)$/iu
const RESOURCE_DIRECTORY = /(?:^|\/)references\//u
const WHITESPACE = /\s/u
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const MARKDOWN_REFERENCE = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|[^\s]+)(?:\s+.*)?$/gmu

/** Machine-specific or absolute path markers that make skill text non-portable. */
const NON_PORTABLE = [/^\/(?:Users|home)\//u, /^[A-Z]:\\/u, /\/Users\/amf\//u]

/** High-confidence credential formats; report the file, never the matched value. */
const SENSITIVE_CONTENT = [
  { name: 'private key material', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  {
    name: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/u,
  },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
]

const REQUIRED_EVIDENCE_FIELDS = [
  '**Inputs:**',
  '**Safe assumptions:**',
  '**Allowed mutations:**',
  '**Outputs:**',
  '**Verification commands:**',
  '**Failure/skip reporting:**',
  '**Cleanup:**',
  '**Completion-claim guard:**',
]

function isInside(directory, target) {
  const pathFromDirectory = relative(directory, target)
  return (
    pathFromDirectory === '' ||
    (pathFromDirectory !== '..' &&
      !pathFromDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(pathFromDirectory))
  )
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (!match) return { metadata: null, error: 'missing YAML frontmatter' }
  try {
    const metadata = Bun.YAML.parse(match[1])
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { metadata: null, error: 'frontmatter must be a YAML mapping' }
    }
    return { metadata, error: null }
  } catch {
    return { metadata: null, error: 'frontmatter is not valid YAML' }
  }
}

function stripCode(markdown) {
  const output = []
  let fence = null
  for (const line of markdown.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence.marker && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = { marker: marker[0], length: marker.length }
      continue
    }
    output.push(line.replace(/`+[^`]*`+/gu, ''))
  }
  return output.join('\n')
}

function isLineTerminator(character) {
  return (
    character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029'
  )
}

// Pre-index delimiters once so malformed PR Markdown cannot trigger repeated suffix scans.
function indexMarkdownLinkSyntax(markdown) {
  const length = markdown.length
  const escaped = new Uint8Array(length)
  const matchingBrackets = new Int32Array(length)
  matchingBrackets.fill(-1)
  const openingBrackets = []

  for (let index = 0; index < length; index++) {
    const character = markdown[index]
    if (character === '\\' && index + 1 < length && !isLineTerminator(markdown[index + 1])) {
      escaped[index + 1] = 1
      index++
      continue
    }
    if (character === '[') openingBrackets.push(index)
    else if (character === ']' && openingBrackets.length > 0) {
      const openingBracket = openingBrackets.pop()
      matchingBrackets[openingBracket] = index
    }
  }

  const nextNonWhitespace = new Int32Array(length + 1)
  nextNonWhitespace.fill(-1)
  const previousNonWhitespace = new Int32Array(length + 1)
  previousNonWhitespace.fill(-1)
  const nextCloseParenthesis = new Int32Array(length + 1)
  nextCloseParenthesis.fill(-1)
  const nextUnquotedBoundary = new Int32Array(length + 1)
  nextUnquotedBoundary.fill(-1)
  const nextAngleClose = new Int32Array(length + 1)
  nextAngleClose.fill(-1)

  let nextNonWhitespaceIndex = -1
  let nextCloseParenthesisIndex = -1
  let nextUnquotedBoundaryIndex = -1
  let nextAngleCloseIndex = -1
  for (let index = length - 1; index >= 0; index--) {
    const character = markdown[index]
    if (!WHITESPACE.test(character)) nextNonWhitespaceIndex = index
    if (character === ')' && !escaped[index]) nextCloseParenthesisIndex = index
    if (character === '>') nextAngleCloseIndex = index
    if (
      (!escaped[index] && (character === ')' || WHITESPACE.test(character))) ||
      (character === '\\' &&
        !escaped[index] &&
        (index + 1 === length || isLineTerminator(markdown[index + 1])))
    ) {
      nextUnquotedBoundaryIndex = index
    }
    nextNonWhitespace[index] = nextNonWhitespaceIndex
    nextCloseParenthesis[index] = nextCloseParenthesisIndex
    nextUnquotedBoundary[index] = nextUnquotedBoundaryIndex
    nextAngleClose[index] = nextAngleCloseIndex
  }

  let previousNonWhitespaceIndex = -1
  for (let index = 0; index < length; index++) {
    if (!WHITESPACE.test(markdown[index])) previousNonWhitespaceIndex = index
    previousNonWhitespace[index + 1] = previousNonWhitespaceIndex
  }

  return {
    escaped,
    matchingBrackets,
    nextNonWhitespace,
    previousNonWhitespace,
    nextCloseParenthesis,
    nextUnquotedBoundary,
    nextAngleClose,
  }
}

function markdownInlineTargets(markdown) {
  const {
    escaped,
    matchingBrackets,
    nextNonWhitespace,
    previousNonWhitespace,
    nextCloseParenthesis,
    nextUnquotedBoundary,
    nextAngleClose,
  } = indexMarkdownLinkSyntax(markdown)
  const targets = new Set()

  for (let openingBracket = 0; openingBracket < markdown.length; openingBracket++) {
    if (markdown[openingBracket] !== '[' || escaped[openingBracket]) continue
    const closingBracket = matchingBrackets[openingBracket]
    if (closingBracket < 0 || markdown[closingBracket + 1] !== '(') continue

    const targetStart = nextNonWhitespace[closingBracket + 2]
    if (targetStart < 0) continue

    let targetEnd
    if (markdown[targetStart] === '<') {
      const closingAngle = nextAngleClose[targetStart + 1]
      if (closingAngle <= targetStart + 1) continue
      targetEnd = closingAngle + 1
    } else {
      const boundary = nextUnquotedBoundary[targetStart]
      if (boundary <= targetStart || markdown[boundary] === '\\') continue
      targetEnd = boundary
    }

    const suffixStart = nextNonWhitespace[targetEnd]
    if (suffixStart < 0) continue
    if (markdown[suffixStart] === ')' && !escaped[suffixStart]) {
      targets.add(markdown.slice(targetStart, targetEnd))
      openingBracket = suffixStart
      continue
    }

    const closingParenthesis = nextCloseParenthesis[suffixStart]
    if (closingParenthesis < 0) continue
    const titleStart = suffixStart
    const titleEnd = previousNonWhitespace[closingParenthesis]
    if (
      (markdown[titleStart] === '"' || markdown[titleStart] === "'") &&
      !escaped[titleStart] &&
      titleEnd > titleStart &&
      markdown[titleEnd] === markdown[titleStart] &&
      !escaped[titleEnd]
    ) {
      targets.add(markdown.slice(targetStart, targetEnd))
      openingBracket = closingParenthesis
    }
  }

  return targets
}

function markdownTargets(markdown) {
  const body = stripCode(markdown)
  const targets = markdownInlineTargets(body)
  for (const match of body.matchAll(MARKDOWN_REFERENCE)) targets.add(match[1])
  return targets
}

function parseRegistry(markdown, errors) {
  const rows = []
  for (const line of markdown.split(/\r?\n/u)) {
    if (!/^\s*\|/u.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length !== 6 || cells[0] === 'Skill' || /^-+$/u.test(cells[0] ?? '')) continue
    rows.push({
      name: cells[0].replace(/^`|`$/gu, ''),
      version: cells[1],
      purpose: cells[2],
      trigger: cells[3],
      owner: cells[4],
      evidence: cells[5],
    })
  }

  const byName = new Map()
  const uniqueValues = new Map([
    ['purpose', new Map()],
    ['trigger', new Map()],
  ])
  for (const row of rows) {
    if (byName.has(row.name)) {
      errors.push({ skill: row.name, message: 'registry contains a duplicate skill row' })
    } else {
      byName.set(row.name, row)
    }
    for (const [field, values] of uniqueValues) {
      const normalized = row[field]
        .replace(/[`*_]/gu, '')
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .trim()
      if (!normalized) continue
      const previous = values.get(normalized)
      if (previous) {
        const label = field === 'trigger' ? 'trigger boundary' : field
        errors.push({ skill: row.name, message: `registry ${label} duplicates '${previous}'` })
      } else {
        values.set(normalized, row.name)
      }
    }
  }
  return byName
}

async function listFiles(directory, skill, errors, base = directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    errors.push({ skill, message: `${relative(base, directory)} could not be read` })
    return []
  }

  const files = []
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full, skill, errors, base)))
    else if (entry.isFile()) files.push(relative(base, full).split('\\').join('/'))
    else if (entry.isSymbolicLink()) {
      errors.push({
        skill,
        message: `${relative(base, full).split('\\').join('/')} is a symlink; skill resources must be repository-owned files`,
      })
    }
  }
  return files.toSorted()
}

async function validateMarkdownLinks(skill, sourcePath, markdown, root, rootRealpath, errors) {
  const sourceFile = relative(root, sourcePath).split('\\').join('/')
  const targets = new Set()
  for (const raw of markdownTargets(markdown)) {
    const target = raw.startsWith('<') ? raw.slice(1, -1) : raw
    if (!target) continue
    if (/^file:/iu.test(target)) {
      errors.push({ skill, message: `${sourceFile}: file-URI links are not portable` })
      continue
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target)) continue

    const pathPart = target.split(/[?#]/u, 1)[0]
    let decodedPath
    try {
      decodedPath = decodeURIComponent(pathPart)
    } catch {
      errors.push({ skill, message: `${sourceFile}: local Markdown link has invalid URL encoding` })
      continue
    }

    const targetPath = resolve(dirname(sourcePath), decodedPath || sourcePath)
    if (!isInside(root, targetPath)) {
      errors.push({
        skill,
        message: `${sourceFile}: local Markdown link resolves outside the repository`,
      })
      continue
    }

    try {
      const targetRealpath = await realpath(targetPath)
      if (!isInside(rootRealpath, targetRealpath)) {
        errors.push({
          skill,
          message: `${sourceFile}: local Markdown link resolves outside the repository`,
        })
      } else {
        targets.add(targetRealpath)
      }
    } catch {
      errors.push({
        skill,
        message: `${sourceFile}: local Markdown link target '${target}' does not exist`,
      })
    }
  }
  return targets
}

export async function discoverSkillLibrary(options = {}) {
  const root = resolve(options.repositoryRoot ?? repositoryRoot)
  const skillsRoot = join(root, skillsDirectory)
  const errors = []
  for (const path of [join(root, '.agents'), skillsRoot]) {
    try {
      const stat = await lstat(path)
      if (!stat.isDirectory()) {
        errors.push({
          skill: 'library',
          message: `${relative(root, path)} must be a real directory; symlinks are not allowed`,
        })
      }
    } catch {
      errors.push({
        skill: 'library',
        message: `${relative(root, path)} is missing or unreadable`,
      })
    }
  }
  if (errors.length > 0) return { skills: [], errors }

  let directories
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        errors.push({
          skill: entry.name,
          message: 'skill directory is a symlink; skill resources must be repository-owned files',
        })
      }
    }
    directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted()
  } catch {
    return {
      skills: [],
      errors: [{ skill: 'library', message: `${skillsDirectory} is missing or unreadable` }],
    }
  }

  let rootRealpath
  try {
    rootRealpath = await realpath(root)
  } catch {
    return {
      skills: [],
      errors: [{ skill: 'library', message: 'repository root is not readable' }],
    }
  }

  const skills = []
  const registryPath = join(skillsRoot, REGISTRY_FILE)
  let registry
  try {
    const registryStat = await lstat(registryPath)
    if (!registryStat.isFile()) {
      errors.push({
        skill: 'library',
        message: `${skillsDirectory}/${REGISTRY_FILE} must be a regular, non-symlink file`,
      })
      return { skills: [], errors }
    }
    registry = parseRegistry(await readFile(registryPath, 'utf8'), errors)
  } catch {
    errors.push({ skill: 'library', message: `${skillsDirectory}/${REGISTRY_FILE} is missing` })
    registry = new Map()
  }

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

    const { metadata: frontmatter, error: frontmatterError } = parseFrontmatter(skillMd)
    if (frontmatterError) {
      errors.push({ skill: name, message: `SKILL.md ${frontmatterError}` })
      continue
    }

    const skillMetadata = frontmatter.metadata
    const version = skillMetadata?.version
    const owner = skillMetadata?.owner
    if (!frontmatter.name)
      errors.push({ skill: name, message: 'SKILL.md frontmatter is missing a name' })
    if (frontmatter.name !== undefined && frontmatter.name !== name) {
      errors.push({
        skill: name,
        message: `frontmatter name '${frontmatter.name}' does not match directory '${name}'`,
      })
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
      errors.push({ skill: name, message: 'skill directory name is not a valid skill identity' })
    }
    if (typeof frontmatter.description !== 'string' || frontmatter.description.trim().length < 10) {
      errors.push({ skill: name, message: 'SKILL.md frontmatter is missing a usable description' })
    }
    if (typeof version !== 'string' || !SEMANTIC_VERSION.test(version)) {
      errors.push({
        skill: name,
        message: 'SKILL.md frontmatter metadata.version must be a semantic version',
      })
    }
    if (typeof owner !== 'string' || owner.trim().length === 0) {
      errors.push({ skill: name, message: 'SKILL.md frontmatter metadata.owner is missing' })
    }
    if (!/^## Evidence contract$/mu.test(skillMd)) {
      errors.push({ skill: name, message: 'SKILL.md is missing an Evidence contract section' })
    }
    for (const field of REQUIRED_EVIDENCE_FIELDS) {
      if (!skillMd.includes(field)) {
        errors.push({ skill: name, message: `SKILL.md evidence contract is missing ${field}` })
      }
    }

    const registryRow = registry.get(name)
    if (!registryRow) {
      errors.push({
        skill: name,
        message: `${skillsDirectory}/${REGISTRY_FILE} has no inventory row`,
      })
    } else {
      if (!registryRow.purpose || registryRow.purpose.length < 10) {
        errors.push({ skill: name, message: 'registry purpose is missing or too short' })
      }
      if (!registryRow.trigger || registryRow.trigger.length < 10) {
        errors.push({ skill: name, message: 'registry trigger boundary is missing or too short' })
      }
      if (typeof version === 'string' && registryRow.version !== version) {
        errors.push({
          skill: name,
          message: `registry version '${registryRow.version}' does not match SKILL.md version '${version}'`,
        })
      }
      if (typeof owner === 'string' && registryRow.owner !== owner) {
        errors.push({
          skill: name,
          message: `registry owner '${registryRow.owner}' does not match SKILL.md owner`,
        })
      }
      if (!registryRow.evidence.includes(`./${name}/SKILL.md#evidence-contract`)) {
        errors.push({
          skill: name,
          message: 'registry evidence contract must link to this skill’s Evidence contract section',
        })
      }
    }

    const files = await listFiles(directory, name, errors)
    const referencedTargets = new Set()
    const mentionedReferences = new Set()
    const referenceFiles = files.filter((file) => RESOURCE_DIRECTORY.test(file))
    for (const file of files) {
      if (!TEXT_FILE.test(file)) continue
      const fullPath = join(directory, file)
      const content = file === 'SKILL.md' ? skillMd : await readFile(fullPath, 'utf8')
      for (const marker of NON_PORTABLE) {
        if (marker.test(content)) {
          errors.push({ skill: name, message: `${file} contains a machine-specific absolute path` })
          break
        }
      }
      for (const detector of SENSITIVE_CONTENT) {
        if (detector.pattern.test(content)) {
          errors.push({ skill: name, message: `${file} contains possible ${detector.name}` })
        }
      }
      if (file.endsWith('.md')) {
        const linked = await validateMarkdownLinks(
          name,
          fullPath,
          content,
          root,
          rootRealpath,
          errors
        )
        for (const target of linked) referencedTargets.add(target)
        for (const referenceFile of referenceFiles) {
          if (file !== referenceFile && content.includes(referenceFile)) {
            mentionedReferences.add(referenceFile)
          }
        }
      }
    }

    for (const file of referenceFiles) {
      const fullPath = join(directory, file)
      try {
        if (!referencedTargets.has(await realpath(fullPath)) && !mentionedReferences.has(file)) {
          errors.push({
            skill: name,
            message: `${file} is an orphaned reference; route to it from a Markdown file or remove it`,
          })
        }
      } catch {
        // listFiles excludes symlinks; this is a defensive guard against a concurrent replacement.
        errors.push({
          skill: name,
          message: `${file} could not be resolved as a repository-owned resource`,
        })
      }
    }

    skills.push({
      name,
      description: (typeof frontmatter.description === 'string' ? frontmatter.description : '')
        .split(/\r?\n\s*\r?\n/u, 1)[0]
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 400),
      version: typeof version === 'string' ? version : undefined,
      files,
      skillMdBytes: Buffer.byteLength(skillMd, 'utf8'),
    })
  }

  for (const name of registry.keys()) {
    if (!directories.includes(name)) {
      errors.push({ skill: name, message: 'registry row has no matching skill directory' })
    }
  }

  for (const marker of NON_PORTABLE) {
    try {
      const registryText = await readFile(registryPath, 'utf8')
      if (marker.test(registryText)) {
        errors.push({
          skill: 'library-registry',
          message: `${skillsDirectory}/${REGISTRY_FILE} contains a machine-specific absolute path`,
        })
        break
      }
    } catch {
      break
    }
  }
  try {
    const registryText = await readFile(registryPath, 'utf8')
    for (const detector of SENSITIVE_CONTENT) {
      if (detector.pattern.test(registryText)) {
        errors.push({
          skill: 'library-registry',
          message: `${skillsDirectory}/${REGISTRY_FILE} contains possible ${detector.name}`,
        })
      }
    }
    await validateMarkdownLinks(
      'library-registry',
      registryPath,
      registryText,
      root,
      rootRealpath,
      errors
    )
  } catch {
    // The missing registry was reported above.
  }

  return {
    skills: skills.toSorted((left, right) => compareCodePointOrder(left.name, right.name)),
    errors,
  }
}

export async function validateSkillLibrary(options = {}) {
  const root = resolve(options.repositoryRoot ?? repositoryRoot)
  const { skills, errors } = await discoverSkillLibrary({ repositoryRoot: root })
  if (errors.length > 0) {
    for (const error of errors) console.error(`${error.skill}: ${error.message}`)
    throw new Error(`Skill library validation found ${errors.length} problem(s).`)
  }
  const inventoryPath = join(root, inventoryFile)
  if (options.refresh) {
    await writeFile(inventoryPath, `${JSON.stringify({ skills }, null, 2)}\n`)
  }
  let stored
  try {
    stored = JSON.parse(await readFile(inventoryPath, 'utf8'))
  } catch {
    throw new Error(`${inventoryFile} is missing; run with --refresh to write it.`)
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
