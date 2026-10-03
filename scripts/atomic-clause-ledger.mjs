import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const registerPath = 'docs/requirements/control-plane-atomic-clauses.v1.json'
const registerScope = 'captured-text clauses; mapping and acceptance remain separate'
const crosswalkPath = 'docs/requirements/control-plane-atomic-crosswalk.v1.json'

export function extractRequirementCrosswalk(document, prefix) {
  if (!/^[A-Z][A-Z0-9-]*$/.test(prefix)) throw new Error('invalid crosswalk atom prefix')
  const shorthand = prefix.match(/-([A-Z]+)$/)?.[1] ?? ''
  const rangePattern = new RegExp(
    `^(?:${prefix}${shorthand ? `|${shorthand}` : ''})(\\d{3})(?:-(?:${prefix}${shorthand ? `|${shorthand}` : ''})?(\\d{3}))?$`
  )
  const rows = []
  let headers
  let heading = ''
  for (const [index, line] of document.split(/\r?\n/).entries()) {
    if (/^#{1,6} /.test(line)) heading = line.replace(/^#{1,6} /, '')
    if (!line.startsWith('|') || !line.endsWith('|')) {
      headers = undefined
      continue
    }
    const cells = splitRow(line)
    if (['Existing row', 'Existing requirement'].includes(cells[0])) {
      if (new Set(cells).size !== cells.length || !cells.includes('Atomic inventory mapping'))
        throw new Error('malformed crosswalk columns')
      headers = cells
      continue
    }
    if (!headers || cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    const requirementId = cells[0]?.replace(/^`([^`]+)`$/, '$1')
    if (
      cells.length !== headers.length ||
      !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(requirementId ?? '')
    )
      throw new Error(`malformed crosswalk row at inventory line ${index + 1}`)
    const columns = Object.fromEntries(headers.slice(1).map((key, cell) => [key, cells[cell + 1]]))
    const atomIds = new Set()
    const mapping = columns['Atomic inventory mapping']
    // Inspect complete Unicode tokens so malformed prefixes/suffixes cannot be truncated.
    for (const reference of mapping.match(/[\p{L}\p{M}\p{N}\p{Pd}\p{Cf}_\u2212]+/gu) ?? []) {
      const atomLikeToken = reference.toUpperCase().replace(/[\p{Pd}\u2212]/gu, '-')
      const resemblesAtom =
        atomLikeToken.includes(prefix) ||
        (shorthand && new RegExp(`${shorthand}[A-Z0-9]*\\d`).test(atomLikeToken)) ||
        /[A-Z][A-Z0-9]*-[A-Z0-9-]*\d/.test(atomLikeToken)
      // M9/M10 references in explanatory notes are not atom identifiers.
      if (!resemblesAtom) continue
      const range = reference.match(rangePattern)
      if (!range) throw new Error(`malformed atom reference ${reference}`)
      const start = Number(range[1])
      const end = Number(range[2] ?? range[1])
      if (start === 0 || end < start) throw new Error(`invalid atom range ${reference}`)
      for (let sequence = start; sequence <= end; sequence++)
        atomIds.add(`${prefix}${String(sequence).padStart(3, '0')}`)
    }
    if (atomIds.size === 0)
      throw new Error(`crosswalk row has no atom references: ${requirementId}`)
    rows.push({ requirementId, atomIds: [...atomIds], inventoryLine: index + 1, heading, columns })
  }
  return rows
}

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
  const documents = new Map()
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
      documents.set(source.id, document)
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
        sourceProvider: source.provider,
        sourceDocumentId: source.sourceId,
        sourceUri: source.uri,
        retrievalStatus: source.retrievalStatus,
        sourceRevision: inventory.sourceRevision,
        sourceRevisionMetadataStatus: source.revisionMetadataStatus,
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
  return { errors, sources: capturedSources, documents }
}

export async function collectAtomicCrosswalk(ledger, root) {
  const captured = await collectAtomicClauses(ledger.sources, root)
  const errors = [...captured.errors]
  const requirements = new Map()
  for (const row of ledger.requirements) {
    if (requirements.has(row.id)) errors.push(`duplicate requirement ID ${row.id}`)
    requirements.set(row.id, row)
  }
  const mappedRequirements = new Set()
  let linkCount = 0
  let mappedAtomCount = 0
  const sources = captured.sources.map(({ atoms, ...source }) => {
    const configuration = ledger.sources.find(({ id }) => id === source.sourceId).atomicInventory
      .requirementCrosswalk
    const crosswalkTables = captured.documents
      .get(source.sourceId)
      .split(/\r?\n/)
      .flatMap((line, index) =>
        /^\|\s*Existing (?:row|requirement)\s*\|/.test(line)
          ? [{ inventoryLine: index + 1, columns: splitRow(line) }]
          : []
      )
    if (
      configuration === undefined &&
      crosswalkTables.some(({ columns }) => columns.includes('Atomic inventory mapping'))
    )
      errors.push(`${source.sourceId}: crosswalk configuration required`)
    let mappings = []
    if (configuration !== undefined) {
      try {
        mappings = extractRequirementCrosswalk(
          captured.documents.get(source.sourceId),
          configuration?.atomIdPrefix
        )
      } catch (error) {
        errors.push(`${source.sourceId}: ${error.message}`)
      }
      if (mappings.length === 0) errors.push(`${source.sourceId}: missing crosswalk`)
    }
    const atomIds = new Set(atoms.map(({ id }) => id))
    const seen = new Set()
    const linkedAtoms = new Set()
    for (const row of mappings) {
      if (seen.has(row.requirementId))
        errors.push(`${source.sourceId}: duplicate requirement ${row.requirementId}`)
      seen.add(row.requirementId)
      const requirement = requirements.get(row.requirementId)
      if (!requirement) errors.push(`${source.sourceId}: unknown requirement ${row.requirementId}`)
      else if (requirement.sourceId !== source.sourceId)
        errors.push(`${source.sourceId}: requirement source mismatch ${row.requirementId}`)
      mappedRequirements.add(row.requirementId)
      for (const id of row.atomIds) {
        if (!atomIds.has(id)) errors.push(`${source.sourceId}: unknown atom ${id}`)
        linkedAtoms.add(id)
        linkCount++
      }
    }
    if (configuration !== undefined) {
      for (const requirement of ledger.requirements.filter(
        (row) => row.sourceId === source.sourceId
      ))
        if (!seen.has(requirement.id))
          errors.push(`${source.sourceId}: missing crosswalk requirement ${requirement.id}`)
    }
    mappedAtomCount += linkedAtoms.size
    return {
      ...source,
      mappings,
      unmaterializedCrosswalkTables: crosswalkTables.filter(
        ({ columns }) => !columns.includes('Atomic inventory mapping')
      ),
      unmappedAtomIds: atoms.filter(({ id }) => !linkedAtoms.has(id)).map(({ id }) => id),
    }
  })
  const atomicClauseCount = captured.sources.reduce(
    (count, source) => count + source.atoms.length,
    0
  )
  return {
    errors,
    register: {
      schemaVersion: 1,
      scope: 'explicit existing requirement links; mapping and acceptance remain incomplete',
      summary: {
        atomicClauseCount,
        mappedAtomCount,
        unmappedAtomCount: atomicClauseCount - mappedAtomCount,
        mappedRequirementCount: mappedRequirements.size,
        unlinkedRequirementCount: requirements.size - mappedRequirements.size,
        linkCount,
      },
      sources,
    },
  }
}

export async function validateAtomicCrosswalk(ledger, root) {
  const captured = await collectAtomicCrosswalk(ledger, root)
  if (captured.errors.length > 0) return captured.errors
  try {
    const current = JSON.parse(await readFile(resolve(root, crosswalkPath), 'utf8'))
    return JSON.stringify(current) === JSON.stringify(captured.register)
      ? []
      : ['Atomic crosswalk drifted; run bun run requirements:crosswalk:write']
  } catch {
    return ['Atomic crosswalk is missing or malformed']
  }
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
  if (process.argv.includes('--crosswalk')) {
    const captured = await collectAtomicCrosswalk(ledger, root)
    if (captured.errors.length > 0) throw new Error(captured.errors.join('\n'))
    if (process.argv.includes('--write')) {
      const formatted = spawnSync(
        'bun',
        [
          'x',
          'oxfmt',
          '--stdin-filepath',
          crosswalkPath,
          '--config',
          resolve(root, '.oxfmtrc.json'),
        ],
        {
          input: `${JSON.stringify(captured.register, null, 2)}\n`,
          encoding: 'utf8',
        }
      )
      if (formatted.status !== 0) throw new Error('Atomic crosswalk formatting failed')
      await writeFile(resolve(root, crosswalkPath), formatted.stdout)
      console.log(`Wrote ${crosswalkPath}`)
    } else {
      const errors = await validateAtomicCrosswalk(ledger, root)
      if (errors.length > 0) throw new Error(errors.join('\n'))
    }
    return
  }
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
