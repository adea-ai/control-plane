import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const registerPath = 'docs/requirements/control-plane-atomic-clauses.v1.json'
const registerScope = 'captured-text clauses; mapping and acceptance remain separate'

function splitRow(line) {
  const cells = []
  let cell = ''
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '\\' && index + 1 < line.length) {
      cell += character + line[++index]
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += character
  }
  cells.push(cell.trim())
  return cells.slice(1, -1)
}

export function extractAtomicClauses(document) {
  const atoms = []
  let headers
  let heading = ''
  for (const [index, line] of document.split(/\r?\n/).entries()) {
    if (/^#{1,6} /.test(line)) heading = line.replace(/^#{1,6} /, '')
    if (!line.startsWith('|') || !line.endsWith('|')) {
      headers = undefined
      continue
    }
    const cells = splitRow(line)
    if (cells[0] === 'Atom') {
      if (new Set(cells).size !== cells.length) throw new Error('duplicate atomic column')
      headers = cells
      continue
    }
    if (!headers || cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    const id = cells[0]?.replace(/^`([^`]+)`$/, '$1')
    if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(id ?? '') || cells.length !== headers.length) {
      throw new Error(`malformed atomic clause at inventory line ${index + 1}`)
    }
    atoms.push({
      id,
      inventoryLine: index + 1,
      heading,
      columns: Object.fromEntries(
        headers.slice(1).map((header, cell) => [header, cells[cell + 1]])
      ),
    })
  }
  return atoms
}

export async function collectAtomicClauses(sources, root) {
  const errors = []
  const capturedSources = []
  const ids = new Set()
  for (const source of sources) {
    const inventory = source.atomicInventory
    if (!inventory) {
      errors.push(`${source.id}: atomicInventory is required`)
      continue
    }
    if (
      ![inventory.sourceRevision, inventory.logicalLines, inventory.atoms].every(
        (value) => Number.isInteger(value) && value > 0
      ) ||
      !/^[a-f0-9]{64}$/.test(inventory.contentSha256 ?? '') ||
      inventory.extractionScope !== 'captured-text' ||
      !['requirementMapping', 'implementationMapping', 'candidateAcceptance'].every(
        (key) => typeof inventory[key] === 'string' && inventory[key].length > 0
      )
    ) {
      errors.push(`${source.id}: atomic inventory metadata is invalid`)
      continue
    }
    if (inventory.sourceRevision !== source.currentRevision)
      errors.push(`${source.id}: atomic inventory revision differs from source`)
    if (inventory.contentSha256 !== source.contentSha256)
      errors.push(`${source.id}: atomic inventory content hash differs from source`)
    const path = typeof inventory.path === 'string' ? inventory.path : ''
    const location = resolve(root, path)
    const within = relative(resolve(root, 'docs/requirements'), location)
    if (
      !path.startsWith('docs/requirements/') ||
      within === '..' ||
      within.startsWith(`..${sep}`)
    ) {
      errors.push(`${source.id}: atomic inventory path must be under docs/requirements`)
      continue
    }
    try {
      const actual = await realpath(location)
      const actualRoot = await realpath(resolve(root, 'docs/requirements'))
      const actualWithin = relative(actualRoot, actual)
      if (actualWithin === '..' || actualWithin.startsWith(`..${sep}`)) {
        errors.push(`${source.id}: atomic inventory path must be under docs/requirements`)
        continue
      }
      const document = await readFile(actual, 'utf8')
      const atoms = extractAtomicClauses(document)
      if (atoms.length !== inventory.atoms)
        errors.push(`${source.id}: atomic inventory count differs from declared atoms`)
      for (const atom of atoms) {
        if (ids.has(atom.id)) errors.push(`${source.id}: duplicate atomic clause ID ${atom.id}`)
        ids.add(atom.id)
      }
      capturedSources.push({
        sourceId: source.id,
        sourceTitle: source.title,
        sourceDocumentId: source.sourceId,
        sourceUri: source.uri,
        retrievalStatus: source.retrievalStatus,
        sourceRevision: inventory.sourceRevision,
        sourceRevisionModifiedAt: source.revisionModifiedAt,
        sourceModifiedAt: source.fileModifiedAt ?? source.updatedAt,
        sourceCapturedAt: source.retrievedAt,
        sourceContentSha256: inventory.contentSha256,
        capturedLogicalLines: inventory.logicalLines,
        extractionScope: inventory.extractionScope,
        inventoryPath: path,
        inventorySha256: createHash('sha256').update(document).digest('hex'),
        requirementMapping: inventory.requirementMapping,
        implementationMapping: inventory.implementationMapping,
        candidateAcceptance: inventory.candidateAcceptance,
        atoms,
      })
    } catch {
      errors.push(`${source.id}: atomic inventory is missing or malformed`)
    }
  }
  return { errors, sources: capturedSources }
}

function registerFor(sources) {
  return { schemaVersion: 1, scope: registerScope, sources }
}

export async function validateAtomicClauseRegister(sources, root) {
  const captured = await collectAtomicClauses(sources, root)
  if (captured.errors.length > 0) return captured.errors
  let current
  try {
    current = JSON.parse(await readFile(resolve(root, registerPath), 'utf8'))
  } catch {
    return ['Atomic clause register is missing or malformed']
  }
  return JSON.stringify(current) === JSON.stringify(registerFor(captured.sources))
    ? []
    : ['Atomic clause register drifted; run bun run requirements:atomic:write']
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const ledger = JSON.parse(
    await readFile(resolve(root, 'docs/requirements/control-plane-requirements.v1.json'), 'utf8')
  )
  if (process.argv.includes('--write')) {
    const captured = await collectAtomicClauses(ledger.sources, root)
    if (captured.errors.length > 0) throw new Error(captured.errors.join('\n'))
    await writeFile(
      resolve(root, registerPath),
      `${JSON.stringify(registerFor(captured.sources), null, 2)}\n`
    )
    console.log(`Wrote ${registerPath}`)
    return
  }
  const errors = await validateAtomicClauseRegister(ledger.sources, root)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(
    'Atomic clause register matches all captured source inventories; acceptance remains separate.'
  )
}

if (import.meta.main) await main()
