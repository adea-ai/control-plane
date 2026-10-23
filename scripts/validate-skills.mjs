import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { compareCodePointOrder } from '../packages/contracts/src/canonical-json.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const skillsDirectory = '.agents/skills'
const inventoryFile = 'docs/skills/skill-library.json'
const INVENTORY_SCHEMA_VERSION = 1
const inventorySchemaFile = 'docs/skills/skill-library.schema.json'
const provenanceLedgerFile = 'docs/skills/provenance.md'
const REGISTRY_FILE = 'README.md'
const TEXT_FILE = /\.(?:md|ya?ml|json|m?js|ts|txt|sh|toml)$/iu
const RESOURCE_DIRECTORY = /(?:^|\/)references\//u
const WHITESPACE = /\s/u
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const MARKDOWN_REFERENCE = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|[^\s]+)(?:\s+.*)?$/gmu

/**
 * Routing contract: a skill's `description` is the only agent-visible
 * selection surface, so its trigger and non-trigger clauses are parsed out of
 * it and must be unique across the library.
 */
const ROUTING_PATTERN = /^Use when (?<trigger>.+?)\. Not for (?<nontrigger>.+?)\.(?=\s|$)/u
const MIN_ROUTING_LENGTH = 20

/** Boundary contract labels every retained skill must declare. */
const BOUNDARY_LABELS = ['Secrets', 'Dirty worktree', 'Migration', 'Generated files', 'Provider']
const BOUNDARY_HEADING = '### Boundary contract'
const BOUNDARY_PATTERN = /^- \*\*([^:*]+):\*\* (.+)$/gmu
const MIN_BOUNDARY_LENGTH = 30

const PROVENANCE_ORIGINS = ['repository-owned', 'vendored-upstream']

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
  '**Stop conditions:**',
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

/**
 * Extract the routing contract from a skill description.
 * The description must follow `Use when <trigger>. Not for <non-trigger>. …`.
 */
function parseRouting(description) {
  const match = ROUTING_PATTERN.exec(description)
  if (!match?.groups) return null
  return {
    trigger: match.groups.trigger.trim(),
    nontrigger: match.groups.nontrigger.trim(),
  }
}

/** Normalized form used for routing-clause uniqueness and overlap checks. */
function normalizeRoutingClause(value) {
  return value.replace(/[`*_]/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** Extract the boundary contract block from a skill body. */
function parseBoundaryContract(skillMd) {
  const heading = skillMd.indexOf(BOUNDARY_HEADING)
  if (heading < 0) return null
  const rest = skillMd.slice(heading + BOUNDARY_HEADING.length)
  const end = rest.search(/^##\s+/mu)
  const block = end < 0 ? rest : rest.slice(0, end)
  const boundaries = new Map()
  for (const match of block.matchAll(BOUNDARY_PATTERN)) {
    boundaries.set(match[1].trim(), match[2].trim())
  }
  return boundaries
}

/** SHA-256 digest of the skill entrypoint, used for pinned provenance. */
function digestOf(content) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Read one labelled bullet out of a skill's Evidence contract. */
function extractEvidenceField(skillMd, label) {
  const match = new RegExp(`^- ${escapeRegExp(label)}\\s*(.*)$`, 'mu').exec(skillMd)
  return match?.[1]?.trim()
}

/**
 * Minimal JSON Schema validator covering the keywords the manifest schema
 * uses. It exists so `docs/skills/skill-library.schema.json` is an enforced
 * contract rather than documentation: a manifest that satisfies the validator
 * but not the schema fails the lane, and the two cannot drift apart silently.
 */
function resolveSchemaReference(reference, root) {
  if (!reference.startsWith('#/')) {
    throw new Error(`unsupported schema reference: ${reference}`)
  }
  let node = root
  for (const segment of reference.slice(2).split('/')) {
    node = node?.[segment.replace(/~1/gu, '/').replace(/~0/gu, '~')]
    if (node === undefined) throw new Error(`unresolvable schema reference: ${reference}`)
  }
  return node
}

function schemaTypeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesSchemaType(value, type) {
  const actual = schemaTypeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'integer') return actual === 'integer'
  return actual === type
}

function schemaErrorsFor(schema, instance, root, path, errors) {
  if (schema === undefined || schema === true) return
  if (schema === false) {
    errors.push(`${path}: no value is allowed here`)
    return
  }
  if (typeof schema !== 'object' || schema === null) return
  if (typeof schema.$ref === 'string') {
    schemaErrorsFor(resolveSchemaReference(schema.$ref, root), instance, root, path, errors)
    return
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesSchemaType(instance, type))) {
      errors.push(`${path}: expected ${types.join(' or ')} but found ${schemaTypeOf(instance)}`)
      return
    }
  }
  if (schema.const !== undefined && JSON.stringify(instance) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum.some(
      (option) => JSON.stringify(option) === JSON.stringify(instance)
    )
    if (!allowed) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`)
  }
  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push(`${path}: is shorter than ${schema.minLength} characters`)
    }
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
      errors.push(`${path}: is longer than ${schema.maxLength} characters`)
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(instance)) {
      errors.push(`${path}: does not match the required pattern`)
    }
  }
  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) {
      errors.push(`${path}: is below the minimum ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && instance > schema.maximum) {
      errors.push(`${path}: is above the maximum ${schema.maximum}`)
    }
  }
  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`${path}: has fewer than ${schema.minItems} items`)
    }
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      errors.push(`${path}: has more than ${schema.maxItems} items`)
    }
    if (schema.items !== undefined) {
      instance.forEach((item, index) => {
        schemaErrorsFor(schema.items, item, root, `${path}[${index}]`, errors)
      })
    }
  }
  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(instance, key)) {
        errors.push(`${path}: is missing the required property '${key}'`)
      }
    }
    const properties = schema.properties ?? {}
    for (const [key, value] of Object.entries(instance)) {
      const child = properties[key]
      if (child !== undefined) {
        schemaErrorsFor(child, value, root, `${path}.${key}`, errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: has the unexpected property '${key}'`)
      } else if (typeof schema.additionalProperties === 'object') {
        schemaErrorsFor(schema.additionalProperties, value, root, `${path}.${key}`, errors)
      }
    }
  }
  for (const sub of schema.allOf ?? []) schemaErrorsFor(sub, instance, root, path, errors)
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((sub) => {
      const local = []
      schemaErrorsFor(sub, instance, root, path, local)
      return local.length === 0
    })
    if (!matched) errors.push(`${path}: does not match any allowed variant`)
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((sub) => {
      const local = []
      schemaErrorsFor(sub, instance, root, path, local)
      return local.length === 0
    }).length
    if (matched !== 1) {
      errors.push(`${path}: must match exactly one allowed variant but matched ${matched}`)
    }
  }
  if (schema.not !== undefined) {
    const local = []
    schemaErrorsFor(schema.not, instance, root, path, local)
    if (local.length === 0) errors.push(`${path}: must not match the forbidden variant`)
  }
  if (schema.if !== undefined) {
    const local = []
    schemaErrorsFor(schema.if, instance, root, path, local)
    const branch = local.length === 0 ? schema.then : schema.else
    if (branch !== undefined) schemaErrorsFor(branch, instance, root, path, errors)
  }
}

/**
 * Parse the provenance ledger table. The ledger is a human-readable view of
 * the same facts the frontmatter carries, so the two are compared rather than
 * trusted independently.
 */
function parseProvenanceLedger(markdown) {
  const rows = new Map()
  let inLedger = false
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^##\s+/u.test(line)) {
      inLedger = /ledger/iu.test(line)
      continue
    }
    if (!inLedger || !/^\s*\|/u.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length !== 6 || cells[0] === 'Skill' || /^-+$/u.test(cells[0] ?? '')) continue
    if (rows.has(cells[0])) {
      throw new Error(`duplicate provenance ledger row for '${cells[0]}'`)
    }
    rows.set(cells[0], {
      origin: cells[1],
      upstreamSource: cells[2],
      upstreamVersion: cells[3],
      integrationVersion: cells[4],
      owner: cells[5],
    })
  }
  return rows
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
    if (cells.length !== 7 || cells[0] === 'Skill' || /^-+$/u.test(cells[0] ?? '')) continue
    rows.push({
      name: cells[0].replace(/^`|`$/gu, ''),
      version: cells[1],
      purpose: cells[2],
      trigger: cells[3],
      nontrigger: cells[4],
      owner: cells[5],
      evidence: cells[6],
    })
  }

  const byName = new Map()
  const uniqueValues = new Map([
    ['purpose', new Map()],
    ['trigger', new Map()],
    ['nontrigger', new Map()],
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
        const label =
          field === 'trigger'
            ? 'trigger boundary'
            : field === 'nontrigger'
              ? 'non-trigger boundary'
              : field
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
  const routingClauses = []
  const boundaryValues = []
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

    // Routing contract: the description is the agent-visible selection surface.
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
    const routing = parseRouting(description)
    if (!routing) {
      errors.push({
        skill: name,
        message:
          'SKILL.md description must follow the routing convention "Use when <trigger>. Not for <non-trigger>."',
      })
    } else {
      if (routing.trigger.length < MIN_ROUTING_LENGTH) {
        errors.push({ skill: name, message: 'routing trigger is missing or too short' })
      }
      if (routing.nontrigger.length < MIN_ROUTING_LENGTH) {
        errors.push({ skill: name, message: 'routing non-trigger is missing or too short' })
      }
      routingClauses.push({ name, kind: 'trigger', value: routing.trigger })
      routingClauses.push({ name, kind: 'non-trigger', value: routing.nontrigger })
    }

    // Boundary contract: secrets, dirty worktree, migration, generated files, provider.
    const boundaries = parseBoundaryContract(skillMd)
    if (!boundaries) {
      errors.push({
        skill: name,
        message: `SKILL.md is missing the "${BOUNDARY_HEADING}" section`,
      })
    } else {
      for (const label of BOUNDARY_LABELS) {
        const value = boundaries.get(label)
        if (!value) {
          errors.push({ skill: name, message: `boundary contract is missing "${label}"` })
          continue
        }
        if (value.length < MIN_BOUNDARY_LENGTH) {
          errors.push({
            skill: name,
            message: `boundary contract "${label}" is missing or too short`,
          })
          continue
        }
        boundaryValues.push({ name, label, value })
      }
      for (const label of boundaries.keys()) {
        if (!BOUNDARY_LABELS.includes(label)) {
          errors.push({ skill: name, message: `boundary contract has an unknown label "${label}"` })
        }
      }
    }

    // Provenance: where the skill came from and which local revision applies.
    const provenance = skillMetadata?.provenance
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
      errors.push({ skill: name, message: 'SKILL.md frontmatter metadata.provenance is missing' })
    } else if (!PROVENANCE_ORIGINS.includes(provenance.origin)) {
      errors.push({
        skill: name,
        message: `SKILL.md frontmatter metadata.provenance.origin must be one of ${PROVENANCE_ORIGINS.join(', ')}`,
      })
    } else if (provenance.origin === 'repository-owned') {
      if (provenance.source) {
        errors.push({
          skill: name,
          message: 'repository-owned skills must not declare metadata.provenance.source',
        })
      }
      if (provenance.integration_version !== undefined) {
        if (
          typeof provenance.integration_version !== 'string' ||
          !SEMANTIC_VERSION.test(provenance.integration_version)
        ) {
          errors.push({
            skill: name,
            message:
              'metadata.provenance.integration_version must be a semantic version when declared',
          })
        } else if (typeof version === 'string' && provenance.integration_version !== version) {
          errors.push({
            skill: name,
            message:
              'metadata.provenance.integration_version must match the skill metadata.version for repository-owned skills',
          })
        }
      }
    } else {
      if (typeof provenance.source !== 'string' || provenance.source.trim().length === 0) {
        errors.push({
          skill: name,
          message: 'vendored skills need metadata.provenance.source naming the upstream origin',
        })
      }
      if (
        typeof provenance.upstream_version !== 'string' ||
        !SEMANTIC_VERSION.test(provenance.upstream_version)
      ) {
        errors.push({
          skill: name,
          message:
            'vendored skills need metadata.provenance.upstream_version as a semantic version',
        })
      } else if (typeof version === 'string' && provenance.upstream_version !== version) {
        errors.push({
          skill: name,
          message:
            'metadata.provenance.upstream_version must match the pinned metadata.version for vendored skills',
        })
      }
      if (
        typeof provenance.integration_version !== 'string' ||
        !SEMANTIC_VERSION.test(provenance.integration_version)
      ) {
        errors.push({
          skill: name,
          message:
            'vendored skills need metadata.provenance.integration_version as a semantic version',
        })
      }
    }

    // Lifecycle: a deprecated skill must name its replacement.
    const deprecated = skillMetadata?.deprecated === true
    const supersededBy = skillMetadata?.superseded_by
    if (deprecated) {
      if (typeof supersededBy !== 'string' || supersededBy.trim().length === 0) {
        errors.push({
          skill: name,
          message: 'a deprecated skill needs metadata.superseded_by naming its replacement',
        })
      }
      if (!/^> \*\*Deprecated:\*\*/mu.test(skillMd)) {
        errors.push({
          skill: name,
          message: 'a deprecated skill needs a "> **Deprecated:**" notice in its body',
        })
      }
    } else if (supersededBy !== undefined) {
      errors.push({
        skill: name,
        message: 'metadata.superseded_by is only allowed on a deprecated skill',
      })
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
      if (!registryRow.nontrigger || registryRow.nontrigger.length < 10) {
        errors.push({
          skill: name,
          message: 'registry non-trigger boundary is missing or too short',
        })
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
      if (routing) {
        if (registryRow.trigger !== routing.trigger) {
          errors.push({
            skill: name,
            message: `registry trigger boundary does not match the SKILL.md description trigger`,
          })
        }
        if (registryRow.nontrigger !== routing.nontrigger) {
          errors.push({
            skill: name,
            message: `registry non-trigger boundary does not match the SKILL.md description non-trigger`,
          })
        }
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
      description: description
        .split(/\r?\n\s*\r?\n/u, 1)[0]
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 400),
      version: typeof version === 'string' ? version : undefined,
      owner: typeof owner === 'string' ? owner : undefined,
      trigger: routing?.trigger,
      nontrigger: routing?.nontrigger,
      boundaries:
        routing && boundaries
          ? Object.fromEntries(BOUNDARY_LABELS.map((label) => [label, boundaries.get(label)]))
          : undefined,
      stopConditions: extractEvidenceField(skillMd, '**Stop conditions:**'),
      cleanup: extractEvidenceField(skillMd, '**Cleanup:**'),
      deprecated,
      supersededBy: typeof supersededBy === 'string' ? supersededBy : undefined,
      provenance: provenance
        ? {
            origin: provenance.origin,
            source: provenance.source,
            upstreamVersion: provenance.upstream_version,
            integrationVersion: provenance.integration_version,
          }
        : undefined,
      files,
      skillMdBytes: Buffer.byteLength(skillMd, 'utf8'),
      skillMdDigest: digestOf(skillMd),
    })
  }

  // Cross-skill routing uniqueness: no two skills may share a trigger or a
  // non-trigger clause, and no clause may overlap another skill's clause.
  for (const clause of routingClauses) {
    const normalized = normalizeRoutingClause(clause.value)
    for (const other of routingClauses) {
      if (other.name === clause.name) continue
      const otherNormalized = normalizeRoutingClause(other.value)
      if (normalized === otherNormalized) {
        errors.push({
          skill: clause.name,
          message: `routing ${clause.kind} duplicates '${other.name}'`,
        })
      } else if (otherNormalized.includes(normalized)) {
        errors.push({
          skill: clause.name,
          message: `routing ${clause.kind} overlaps '${other.name}' ${other.kind}`,
        })
      }
    }
  }

  // Cross-skill boundary uniqueness: a declared boundary must be
  // skill-specific, not a shared boilerplate line.
  for (const entry of boundaryValues) {
    for (const other of boundaryValues) {
      if (other.name === entry.name || other.label !== entry.label) continue
      if (normalizeRoutingClause(other.value) === normalizeRoutingClause(entry.value)) {
        errors.push({
          skill: entry.name,
          message: `boundary "${entry.label}" duplicates '${other.name}'`,
        })
      }
    }
  }

  for (const name of registry.keys()) {
    if (!directories.includes(name)) {
      errors.push({ skill: name, message: 'registry row has no matching skill directory' })
    }
  }

  for (const skill of skills) {
    if (!skill.deprecated) continue
    if (skill.supersededBy && !directories.includes(skill.supersededBy)) {
      errors.push({
        skill: skill.name,
        message: `metadata.superseded_by '${skill.supersededBy}' does not name a retained skill`,
      })
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
  // The manifest is validated in the form it is written in, so an absent
  // optional field is absent rather than an undefined value.
  const manifest = JSON.parse(JSON.stringify({ schemaVersion: INVENTORY_SCHEMA_VERSION, skills }))

  // The published schema is an enforced contract: the manifest is validated
  // against it, so a manifest that satisfies the validator but not the schema
  // fails the lane.
  const schemaPath = join(root, inventorySchemaFile)
  let schema = null
  try {
    schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  } catch (error) {
    throw new Error(`${inventorySchemaFile} could not be read: ${error.message}`, { cause: error })
  }
  const schemaErrors = []
  schemaErrorsFor(schema, manifest, schema, 'skill-library', schemaErrors)
  if (schemaErrors.length > 0) {
    for (const error of schemaErrors) console.error(`skill-library: ${error}`)
    throw new Error(
      `Skill library manifest does not satisfy ${inventorySchemaFile} (${schemaErrors.length} problem(s)).`
    )
  }

  // The provenance ledger mirrors the frontmatter facts, so the two are
  // compared instead of being trusted independently.
  const ledgerPath = join(root, provenanceLedgerFile)
  let ledgerMarkdown
  try {
    ledgerMarkdown = await readFile(ledgerPath, 'utf8')
  } catch (error) {
    throw new Error(`${provenanceLedgerFile} could not be read: ${error.message}`, { cause: error })
  }
  const ledger = parseProvenanceLedger(ledgerMarkdown)
  const ledgerErrors = []
  for (const skill of skills) {
    const row = ledger.get(skill.name)
    if (!row) {
      ledgerErrors.push(`${skill.name}: ${provenanceLedgerFile} has no ledger row`)
      continue
    }
    const provenance = skill.provenance ?? {}
    if (row.origin !== provenance.origin) {
      ledgerErrors.push(
        `${skill.name}: ledger origin '${row.origin}' does not match metadata.provenance.origin '${provenance.origin}'`
      )
    }
    if (row.owner !== skill.owner) {
      ledgerErrors.push(
        `${skill.name}: ledger owner '${row.owner}' does not match metadata.owner '${skill.owner}'`
      )
    }
    if (provenance.origin === 'vendored-upstream') {
      if (row.upstreamSource !== provenance.source) {
        ledgerErrors.push(
          `${skill.name}: ledger upstream source does not match metadata.provenance.source`
        )
      }
      if (row.upstreamVersion !== provenance.upstreamVersion) {
        ledgerErrors.push(
          `${skill.name}: ledger upstream version '${row.upstreamVersion}' does not match metadata.provenance.upstream_version '${provenance.upstreamVersion}'`
        )
      }
    } else {
      if (row.upstreamSource !== '—') {
        ledgerErrors.push(
          `${skill.name}: ledger records an upstream source for repository-owned content`
        )
      }
      if (row.upstreamVersion !== '—') {
        ledgerErrors.push(
          `${skill.name}: ledger records an upstream version for repository-owned content`
        )
      }
    }
    if (row.integrationVersion !== provenance.integrationVersion) {
      ledgerErrors.push(
        `${skill.name}: ledger integration version '${row.integrationVersion}' does not match metadata.provenance.integration_version '${provenance.integrationVersion}'`
      )
    }
  }
  for (const name of ledger.keys()) {
    if (!skills.some((skill) => skill.name === name)) {
      ledgerErrors.push(`${name}: ${provenanceLedgerFile} has a ledger row with no matching skill`)
    }
  }
  if (ledgerErrors.length > 0) {
    for (const error of ledgerErrors) console.error(`${provenanceLedgerFile}: ${error}`)
    throw new Error(
      `Skill provenance ledger drifted from the skills (${ledgerErrors.length} problem(s)).`
    )
  }

  if (options.refresh) {
    await writeFile(inventoryPath, `${JSON.stringify(manifest, null, 2)}\n`)
    // Normalize the inventory with the repository formatter so the refreshed
    // artifact satisfies `bun run format:check`. The formatter is a
    // convenience here, not a contract, so its absence is not an error.
    const formatter = join(root, 'node_modules', '.bin', 'oxfmt')
    if (existsSync(formatter)) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, formatter, '--write', inventoryPath],
        cwd: root,
      })
      if (result.exitCode !== 0) {
        console.error('The repository formatter could not normalize the inventory')
      }
    }
  }
  let stored
  try {
    stored = JSON.parse(await readFile(inventoryPath, 'utf8'))
  } catch {
    throw new Error(`${inventoryFile} is missing; run with --refresh to write it.`)
  }
  if (stored?.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    throw new Error(
      `${inventoryFile} declares schemaVersion '${stored?.schemaVersion}'; expected '${INVENTORY_SCHEMA_VERSION}'.`
    )
  }
  const storedSchemaErrors = []
  schemaErrorsFor(schema, stored, schema, 'skill-library', storedSchemaErrors)
  if (storedSchemaErrors.length > 0) {
    for (const error of storedSchemaErrors) console.error(`skill-library: ${error}`)
    throw new Error(
      `${inventoryFile} does not satisfy ${inventorySchemaFile} (${storedSchemaErrors.length} problem(s)).`
    )
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
