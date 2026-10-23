import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  compareCodePointOrder,
  ErrorResponseEnvelopeSchema,
  PublicContractManifest,
} from '@control-plane/contracts'
import { z } from 'zod'
import { ControlApiOperations } from '../src/operations.ts'

const packageRoot = new URL('../', import.meta.url)

function formatJson(text) {
  const config = fileURLToPath(new URL('../../.oxfmtrc.json', packageRoot))
  return execFileSync(
    'bun',
    ['x', 'oxfmt', '--stdin-filepath', 'artifact.json', '--config', config],
    {
      input: text,
      encoding: 'utf8',
    }
  )
}
const major = PublicContractManifest.current.major
const artifactUrl = new URL(`openapi/control-plane.v${major}.json`, packageRoot)
const baselineUrl = new URL(`compatibility/control-plane.v${major}.baseline.json`, packageRoot)

/**
 * The runtime patterns that accept both cases, as the generated document spells
 * them.
 *
 * A JSON Schema `pattern` has no case-insensitive flag, so a runtime regex that
 * accepts both cases would be published narrower than the contract that accepts
 * it. Each of these runtime sources is published as its explicit ASCII form,
 * which matches exactly the same ASCII strings: the runtime model id accepts
 * `DeepSeek-V3`, and the published pattern has to accept it too.
 *
 * The declaration cannot drift silently. The generation fails when a declared
 * source no longer appears in the document, and the parity test compares the
 * published pattern with the runtime schema over the ASCII domain, so a
 * runtime change that is not published here breaks the check instead of
 * narrowing the contract.
 */
const caseInsensitiveRuntimePatterns = ['^[a-z0-9][a-z0-9._/-]*$']

/**
 * The explicit ASCII form of a case-insensitive pattern: every ASCII letter
 * becomes a two-character class or an expanded range, which matches exactly
 * the strings the case-insensitive pattern matches.
 */
export function expandAsciiCasePattern(source) {
  let expanded = ''
  let inClass = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      expanded += source.slice(index, index + 2)
      index += 1
      continue
    }
    if (character === '[') {
      inClass = true
      expanded += character
      continue
    }
    if (character === ']') {
      inClass = false
      expanded += character
      continue
    }
    if (
      inClass &&
      /[A-Za-z]/.test(character) &&
      source[index + 1] === '-' &&
      /[A-Za-z]/.test(source[index + 2] ?? '')
    ) {
      const start = character
      const end = source[index + 2]
      const flip = (letter) =>
        letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
      expanded += `${start}-${end}${flip(start)}-${flip(end)}`
      index += 2
      continue
    }
    if (/[A-Za-z]/.test(character)) {
      const lower = character.toLowerCase()
      const upper = character.toUpperCase()
      expanded += inClass ? `${lower}${upper}` : `[${lower}${upper}]`
      continue
    }
    expanded += character
  }
  return expanded
}

/**
 * Publishes every declared case-insensitive runtime pattern as its explicit
 * ASCII form, and fails when a declared source is not in the document.
 */
function applyCaseInsensitivePatterns(document, expanded) {
  const declared = new Set(caseInsensitiveRuntimePatterns)
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'pattern' && typeof child === 'string' && declared.has(child)) {
        value[key] = expandAsciiCasePattern(child)
        expanded.add(child)
        continue
      }
      walk(child)
    }
  }
  walk(document)
  return document
}

export function createControlApiOpenApiDocument() {
  const expanded = new Set()
  const paths = {}
  for (const operation of Object.values(ControlApiOperations)) {
    paths[operation.path] = {
      [operation.method.toLowerCase()]: {
        operationId: operation.operation,
        security: [{ serviceBearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: jsonSchema(operation.requestSchema, 'input', expanded) },
          },
        },
        responses: {
          [operation.responseStatus ?? 200]: {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: jsonSchema(operation.responseSchema, 'output', expanded),
              },
            },
          },
          default: {
            description: 'Normalized error response',
            content: {
              'application/json': {
                schema: jsonSchema(ErrorResponseEnvelopeSchema, 'output', expanded),
              },
            },
          },
        },
      },
    }
  }
  const missing = caseInsensitiveRuntimePatterns.filter((source) => !expanded.has(source))
  if (missing.length > 0) {
    throw new Error(
      `The generated contract does not carry the declared case-insensitive pattern(s): ${missing.join(', ')}`
    )
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent HQ Control Plane API',
      version: `${PublicContractManifest.current.major}.${PublicContractManifest.current.minor}.0`,
    },
    paths: sortObject(paths),
    components: {
      securitySchemes: {
        serviceBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'service-credential' },
      },
    },
  }
}

export function findBreakingContractChanges(previous, next) {
  const changes = []
  for (const [path, previousPath] of Object.entries(previous.paths ?? {})) {
    const nextPath = next.paths?.[path]
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const previousOperation = previousPath?.[method]
      if (previousOperation === undefined) continue
      const operationLabel = `${method.toUpperCase()} ${path}`
      const nextOperation = nextPath?.[method]
      if (nextOperation === undefined) {
        changes.push(`Removed operation ${operationLabel}`)
        continue
      }
      compareSchema(
        previousOperation.requestBody?.content?.['application/json']?.schema,
        nextOperation.requestBody?.content?.['application/json']?.schema,
        { changes, direction: 'request', operationLabel, path: '' }
      )
      for (const [status, response] of Object.entries(previousOperation.responses ?? {})) {
        if (!/^2\d\d$/.test(status)) continue
        compareSchema(
          response?.content?.['application/json']?.schema,
          nextOperation.responses?.[status]?.content?.['application/json']?.schema,
          { changes, direction: 'response', operationLabel, path: '' }
        )
      }
    }
  }
  return changes
}

function compareSchema(previous, next, context) {
  const label = context.direction === 'request' ? 'Request' : 'Response'
  if (previous === undefined) return
  if (next === undefined) {
    context.changes.push(
      `${label} ${context.operationLabel} removed schema at ${displayPath(context.path)}`
    )
    return
  }
  // A request may add alternatives when one entire branch still accepts the old shape.
  // Only handle a plain union here: sibling constraints must not be silently discarded.
  if (
    context.direction === 'request' &&
    (previous.anyOf !== undefined || next.anyOf !== undefined)
  ) {
    const branches = (schema) =>
      schema.anyOf === undefined
        ? [schema]
        : Array.isArray(schema.anyOf) &&
            schema.anyOf.length > 0 &&
            Object.keys(schema).every((key) => ['anyOf', 'title', 'description'].includes(key))
          ? schema.anyOf
          : undefined
    const before = branches(previous)
    const after = branches(next)
    if (
      !before ||
      !after ||
      !before.every((oldBranch) =>
        after.some((newBranch) => {
          const changes = []
          compareSchema(oldBranch, newBranch, { ...context, changes })
          return changes.length === 0
        })
      )
    )
      context.changes.push(
        `${label} ${context.operationLabel} has no compatible request alternative at ${displayPath(context.path)}`
      )
    return
  }
  if (JSON.stringify(previous.type) !== JSON.stringify(next.type)) {
    context.changes.push(
      `${label} ${context.operationLabel} changed type at ${displayPath(context.path)}`
    )
  }
  if (
    (previous.enum !== undefined || next.enum !== undefined) &&
    JSON.stringify(previous.enum) !== JSON.stringify(next.enum)
  ) {
    context.changes.push(
      `${label} ${context.operationLabel} changed closed enum at ${displayPath(context.path)}`
    )
  }
  if (previous.const !== next.const) {
    context.changes.push(
      `${label} ${context.operationLabel} changed constant at ${displayPath(context.path)}`
    )
  }
  compareConstraints(previous, next, context)

  const previousRequired = new Set(previous.required ?? [])
  const nextRequired = new Set(next.required ?? [])
  if (context.direction === 'request') {
    for (const field of nextRequired) {
      if (!previousRequired.has(field)) {
        context.changes.push(
          `${label} ${context.operationLabel} added required field ${joinPath(context.path, field)}`
        )
      }
    }
  } else {
    for (const field of previousRequired) {
      if (!nextRequired.has(field)) {
        context.changes.push(
          `${label} ${context.operationLabel} removed required field ${joinPath(context.path, field)}`
        )
      }
    }
  }

  for (const [field, previousProperty] of Object.entries(previous.properties ?? {})) {
    const propertyPath = joinPath(context.path, field)
    const nextProperty = next.properties?.[field]
    if (nextProperty === undefined) {
      context.changes.push(`${label} ${context.operationLabel} removed field ${propertyPath}`)
      continue
    }
    compareSchema(previousProperty, nextProperty, { ...context, path: propertyPath })
  }
  if (previous.items !== undefined) {
    compareSchema(previous.items, next.items, { ...context, path: `${context.path}[]` })
  }
}

const lowerBounds = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']
const upperBounds = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']

function compareConstraints(previous, next, context) {
  const label = context.direction === 'request' ? 'Request' : 'Response'
  const changed = (constraint) =>
    context.changes.push(
      `${label} ${context.operationLabel} changed compatibility constraint ${constraint} at ${displayPath(context.path)}`
    )
  for (const constraint of lowerBounds) {
    const before = previous[constraint]
    const after = next[constraint]
    if (context.direction === 'request') {
      if (after !== undefined && (before === undefined || after > before)) changed(constraint)
    } else if (before !== undefined && (after === undefined || after < before)) {
      changed(constraint)
    }
  }
  for (const constraint of upperBounds) {
    const before = previous[constraint]
    const after = next[constraint]
    if (context.direction === 'request') {
      if (after !== undefined && (before === undefined || after < before)) changed(constraint)
    } else if (before !== undefined && (after === undefined || after > before)) {
      changed(constraint)
    }
  }
  for (const constraint of ['pattern', 'format', 'multipleOf']) {
    if (previous[constraint] !== next[constraint]) changed(constraint)
  }
  if (
    context.direction === 'request' &&
    previous.additionalProperties !== false &&
    next.additionalProperties === false
  ) {
    changed('additionalProperties')
  }
}

function jsonSchema(schema, io, expanded) {
  const { $schema: _schema, ...document } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
  })
  return sortObject(applyCaseInsensitivePatterns(document, expanded))
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => compareCodePointOrder(left, right))
      .map(([key, child]) => [key, sortObject(child)])
  )
}

function joinPath(parent, field) {
  return parent.length === 0 ? field : `${parent}.${field}`
}

function displayPath(path) {
  return path.length === 0 ? '<root>' : path
}

async function run() {
  const generated = createControlApiOpenApiDocument()
  const serialized = formatJson(JSON.stringify(generated))
  if (process.argv.includes('--initialize-baseline')) {
    if (readBaselineFromBase() !== undefined) {
      throw new Error(`Compatibility baseline v${major} already exists on the target branch`)
    }
    await writeFile(artifactUrl, serialized)
    await writeFile(baselineUrl, serialized)
    return
  }
  if (process.argv.includes('--write')) {
    await writeFile(artifactUrl, serialized)
    return
  }
  if (!process.argv.includes('--check')) {
    throw new Error('Use --write, --initialize-baseline, or --check')
  }

  const committed = await readFile(artifactUrl, 'utf8')
  if (committed !== serialized) {
    throw new Error(`OpenAPI artifact drifted; run bun run openapi:generate`)
  }
  const baseline = JSON.parse(await readFile(baselineUrl, 'utf8'))
  assertBaselineImmutable()
  const changes = findBreakingContractChanges(baseline, generated)
  if (changes.length > 0) {
    throw new Error(
      `Breaking v${major} contract changes require a new major boundary:\n${changes.join('\n')}`
    )
  }
}

function assertBaselineImmutable() {
  const previous = readBaselineFromBase()
  if (previous === undefined) return
  const current = readBaselineFromRef('HEAD')
  if (current === undefined) {
    throw new Error(`Compatibility baseline v${major} cannot be removed`)
  }
  assertBaselineUnchanged(previous, current, major)
}

function readBaselineFromBase() {
  const baseBranch = process.env.GITHUB_BASE_REF || 'main'
  return readBaselineFromRef(`origin/${baseBranch}`)
}

function readBaselineFromRef(ref) {
  const baselinePath = `packages/control-sdk/compatibility/control-plane.v${major}.baseline.json`
  try {
    return execFileSync('git', ['show', `${ref}:${baselinePath}`], {
      cwd: fileURLToPath(new URL('../../', packageRoot)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

export function assertBaselineUnchanged(previous, current, contractMajor) {
  if (previous !== current) {
    throw new Error(
      `Compatibility baseline v${contractMajor} is immutable; create a new major boundary`
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run()
