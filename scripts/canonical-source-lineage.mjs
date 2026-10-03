import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Text lineage is an audit input, never implementation or candidate acceptance.
export function parseSourceLines(anchor, logicalLines) {
  if (typeof anchor !== 'string' || !Number.isInteger(logicalLines) || logicalLines < 1)
    throw new Error('invalid source anchor')
  const lines = new Set()
  const remainder = anchor.replace(
    /\bL(\d+)(?:\s*[-–]\s*L?(\d+))?(?![\p{L}\p{N}_])/gu,
    (_, first, last) => {
      const start = Number(first)
      const end = Number(last ?? first)
      if (start < 1 || end < start || end > logicalLines)
        throw new Error('source anchor is outside the captured text')
      for (let line = start; line <= end; line++) lines.add(line)
      return '\0'
    }
  )
  if (lines.size === 0 || /\bL(?:\d|\b)|\0\s*[-–]/u.test(remainder))
    throw new Error('malformed source anchor')
  return [...lines].sort((left, right) => left - right)
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const sha = (text) => createHash('sha256').update(text).digest('hex')
const logicalLines = (text) => {
  if (!text) return []
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}
function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function rangeLength(range, limit) {
  requireCondition(Array.isArray(range), 'invalid line range')
  if (range.length === 0) return 0
  requireCondition(
    range.length === 2 &&
      range.every(Number.isInteger) &&
      range[0] > 0 &&
      range[1] >= range[0] &&
      range[1] <= limit,
    'invalid line range'
  )
  return range[1] - range[0] + 1
}

export function partitionSourceLines(changes, oldCount, currentCount) {
  const segments = []
  let oldCursor = 1
  let currentCursor = 1
  for (const block of changes) {
    const oldLength = rangeLength(block.oldLines, oldCount)
    const currentLength = rangeLength(block.currentLines, currentCount)
    requireCondition(oldLength + currentLength > 0, 'empty change block')
    const type = oldLength ? (currentLength ? 'replace' : 'delete') : 'insert'
    requireCondition(block.type === type, 'change type differs from line ranges')
    const gap = oldLength ? block.oldLines[0] - oldCursor : block.currentLines[0] - currentCursor
    requireCondition(
      gap >= 0 && (!currentLength || block.currentLines[0] === currentCursor + gap),
      'change blocks are not ordered aligned partitions'
    )
    if (gap)
      segments.push({
        type: 'equal',
        oldLines: [oldCursor, oldCursor + gap - 1],
        currentLines: [currentCursor, currentCursor + gap - 1],
      })
    segments.push({ type, oldLines: block.oldLines, currentLines: block.currentLines })
    oldCursor += gap + oldLength
    currentCursor += gap + currentLength
  }
  const tail = oldCount - oldCursor + 1
  requireCondition(tail >= 0 && tail === currentCount - currentCursor + 1, 'uncovered source lines')
  if (tail)
    segments.push({
      type: 'equal',
      oldLines: [oldCursor, oldCount],
      currentLines: [currentCursor, currentCount],
    })
  return segments
}

function verifyCaptures(historical, receipt, segments, captures) {
  requireCondition(
    sha(captures.captured) === historical.sourceContentSha256 &&
      sha(captures.current) === receipt.observedTextSha256,
    'capture hash differs from provenance'
  )
  const oldLines = logicalLines(captures.captured)
  const currentLines = logicalLines(captures.current)
  requireCondition(
    oldLines.length === historical.capturedLogicalLines &&
      currentLines.length === receipt.observedTextLogicalLines,
    'capture logical line count differs'
  )
  for (const segment of segments.filter((entry) => entry.type === 'equal'))
    requireCondition(
      same(
        oldLines.slice(segment.oldLines[0] - 1, segment.oldLines[1]),
        currentLines.slice(segment.currentLines[0] - 1, segment.currentLines[1])
      ),
      'equal span text differs'
    )
  return { oldLines, currentLines }
}

function lineageAtoms(historical, segments) {
  const mapped = new Map()
  for (const segment of segments.filter((entry) => entry.type === 'equal'))
    for (let line = segment.oldLines[0]; line <= segment.oldLines[1]; line++)
      mapped.set(line, segment.currentLines[0] + line - segment.oldLines[0])
  const ids = new Set()
  return historical.atoms.map((atom) => {
    requireCondition(
      typeof atom.id === 'string' && !ids.has(atom.id),
      'duplicate or missing old atom'
    )
    ids.add(atom.id)
    const anchor = Object.entries(atom.columns).find(([key]) => key.startsWith('Source'))?.[1]
    const oldLines = parseSourceLines(anchor, historical.capturedLogicalLines)
    const unchanged = oldLines.every((line) => mapped.has(line))
    return {
      atomId: atom.id,
      oldLines,
      currentLines: unchanged ? oldLines.map((line) => mapped.get(line)) : [],
      status: unchanged ? 'source-text-unchanged' : 'source-text-changed',
    }
  })
}

function validateBlocks(changes, proposal, atoms, lines) {
  requireCondition(proposal.blocks?.length === changes.length, 'proposal is missing changed blocks')
  let sequence = 0
  return changes.map((change, index) => {
    const block = proposal.blocks[index]
    requireCondition(
      same(change.oldLines, block.oldLines) && same(change.currentLines, block.currentLines),
      'proposal block differs from captured change'
    )
    requireCondition(
      ['clarifies', 'supersedes', 'adds', 'deletes', 'metadata', 'mixed'].includes(
        block.disposition
      ) &&
        typeof block.reason === 'string' &&
        block.reason.trim(),
      'change disposition and reason are required'
    )
    const oldAtomIds = atoms
      .filter((atom) =>
        atom.oldLines.some(
          (line) =>
            change.oldLines.length && line >= change.oldLines[0] && line <= change.oldLines[1]
        )
      )
      .map((atom) => atom.atomId)
    requireCondition(
      same([...oldAtomIds].sort(), [...(block.oldAtomIds ?? [])].sort()),
      'changed old atoms are omitted, duplicated or incorrectly associated'
    )
    requireCondition(Array.isArray(block.currentClauses), 'current clauses are required')
    const covered = new Set()
    const clauses = block.currentClauses.map((clause) => {
      requireCondition(
        [
          'obligation',
          'definition',
          'dated-status',
          'supersession',
          'metadata',
          'navigation',
        ].includes(clause.kind) &&
          typeof clause.text === 'string' &&
          clause.text.trim(),
        'invalid current clause'
      )
      requireCondition(
        Array.isArray(clause.sourceLines) &&
          clause.sourceLines.length > 0 &&
          new Set(clause.sourceLines).size === clause.sourceLines.length &&
          clause.sourceLines.every(
            (line) =>
              Number.isInteger(line) &&
              change.currentLines.length &&
              line >= change.currentLines[0] &&
              line <= change.currentLines[1]
          ),
        'clause anchor is outside the changed block'
      )
      clause.sourceLines.forEach((line) => covered.add(line))
      return {
        id: `${proposal.sourceId}-current-${String(++sequence).padStart(3, '0')}`,
        sourceLines: clause.sourceLines,
        kind: clause.kind,
        text: clause.text,
      }
    })
    const slice = (textLines, range) =>
      range.length ? textLines.slice(range[0] - 1, range[1]) : []
    const currentNonblankLines = lines
      ? [...coveredRange(change.currentLines)].filter((line) => lines.currentLines[line - 1].trim())
      : block.currentNonblankLines
    requireCondition(
      Array.isArray(currentNonblankLines) &&
        new Set(currentNonblankLines).size === currentNonblankLines.length &&
        currentNonblankLines.every(
          (line) =>
            Number.isInteger(line) &&
            change.currentLines.length &&
            line >= change.currentLines[0] &&
            line <= change.currentLines[1] &&
            covered.has(line)
        ),
      'nonblank changed source line has no clause'
    )
    const oldBlockSha256 = lines
      ? sha(JSON.stringify(slice(lines.oldLines, change.oldLines)))
      : block.oldBlockSha256
    const currentBlockSha256 = lines
      ? sha(JSON.stringify(slice(lines.currentLines, change.currentLines)))
      : block.currentBlockSha256
    requireCondition(
      [oldBlockSha256, currentBlockSha256].every((hash) => /^[a-f0-9]{64}$/.test(hash ?? '')),
      'change block hash is missing'
    )
    return {
      ...change,
      oldBlockSha256,
      currentBlockSha256,
      currentNonblankLines,
      disposition: block.disposition,
      reason: block.reason,
      oldAtomIds,
      currentClauses: clauses,
    }
  })
}

export function createSourceLineage(historical, receipt, analysis, proposal, captures) {
  requireCondition(
    [receipt.sourceId, analysis.sourceId, proposal.sourceId].every(
      (id) => id === historical.sourceId
    ) &&
      receipt.documentId === historical.sourceDocumentId &&
      receipt.capturedRevision === historical.sourceRevision &&
      receipt.capturedTextSha256 === historical.sourceContentSha256 &&
      Number.isInteger(receipt.observedCurrentRevision) &&
      receipt.observedCurrentRevision >= historical.sourceRevision &&
      Number.isInteger(receipt.observedTextLogicalLines) &&
      receipt.observedTextLogicalLines > 0 &&
      /^[a-f0-9]{64}$/.test(receipt.observedTextSha256 ?? ''),
    'source provenance differs from historical register'
  )
  const changes = analysis.changedBlocks.map(({ type, oldLines, currentLines }) => ({
    type,
    oldLines,
    currentLines,
  }))
  const segments = partitionSourceLines(
    changes,
    historical.capturedLogicalLines,
    receipt.observedTextLogicalLines
  )
  const lines = captures ? verifyCaptures(historical, receipt, segments, captures) : undefined
  const atoms = lineageAtoms(historical, segments)
  const blocks = validateBlocks(changes, proposal, atoms, lines)
  return {
    sourceId: historical.sourceId,
    documentId: receipt.documentId,
    capturedRevision: receipt.capturedRevision,
    capturedTextSha256: receipt.capturedTextSha256,
    currentRevision: receipt.observedCurrentRevision,
    currentTextSha256: receipt.observedTextSha256,
    capturedLogicalLines: historical.capturedLogicalLines,
    currentLogicalLines: receipt.observedTextLogicalLines,
    interpretation:
      'equal line text is mechanical lineage; document context and semantics require review',
    requirementMapping: 'pending',
    implementationMapping: 'pending',
    candidateAcceptance: 'not-assessed',
    independentReview: 'pending',
    atoms,
    blocks,
  }
}

function* coveredRange(range) {
  if (range.length) for (let line = range[0]; line <= range[1]; line++) yield line
}

export const lineageScope =
  'captured current text reconciliation; semantic review, mapping and acceptance remain pending'

export const sourceLineageSha256 = (source) => sha(JSON.stringify(source))

export function validateLineageRegister(register, historical, freshness) {
  const errors = []
  try {
    requireCondition(
      register.schemaVersion === 1 && register.scope === lineageScope,
      'invalid lineage register schema or scope'
    )
    const sourceIds = (document) => document.sources.map((source) => source.sourceId).sort()
    const expectedIds = sourceIds(historical)
    requireCondition(
      new Set(expectedIds).size === expectedIds.length &&
        same(sourceIds(register), expectedIds) &&
        same(sourceIds(freshness), expectedIds),
      'lineage sources differ from historical register or freshness receipt'
    )
    for (const source of historical.sources) {
      const current = register.sources.find((entry) => entry.sourceId === source.sourceId)
      const receipt = freshness.sources.find((entry) => entry.sourceId === source.sourceId)
      try {
        requireCondition(
          sourceLineageSha256(current) === receipt.lineageRegisterSourceSha256,
          'reconciled clauses differ from the bound freshness receipt'
        )
        const rebuilt = createSourceLineage(
          source,
          receipt,
          { sourceId: source.sourceId, changedBlocks: current.blocks },
          current
        )
        requireCondition(
          same(current, rebuilt),
          'stored lineage differs from derived anchors, clauses or provenance'
        )
      } catch (error) {
        errors.push(`${source.sourceId}: ${error.message}`)
      }
    }
  } catch (error) {
    errors.push(error.message)
  }
  return errors
}

const registerPath = 'docs/requirements/canonical-source-lineage-2026-10-03.v1.json'
const historicalPath = 'docs/requirements/control-plane-atomic-clauses.v1.json'
const freshnessPath = 'docs/requirements/canonical-source-freshness-2026-10-03.v1.json'
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export async function validateCanonicalSourceLineage(root) {
  try {
    const [register, historical, freshness] = await Promise.all(
      [registerPath, historicalPath, freshnessPath].map((path) => readJson(resolve(root, path)))
    )
    return validateLineageRegister(register, historical, freshness)
  } catch (error) {
    return [`current source lineage is missing or malformed: ${error.message}`]
  }
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const args = process.argv.slice(2)
  const option = (name) => {
    const index = args.indexOf(name)
    requireCondition(
      index >= 0 && args[index + 1] && !args[index + 1].startsWith('--'),
      `${name} is required`
    )
    return resolve(args[index + 1])
  }
  const historical = await readJson(resolve(root, historicalPath))
  const freshness = await readJson(resolve(root, freshnessPath))
  let register
  if (args.includes('--write')) {
    const analysis = await readJson(option('--analysis'))
    const proposals = await readJson(option('--proposals'))
    const captures = option('--capture-dir')
    const ids = historical.sources.map((source) => source.sourceId).sort()
    requireCondition(
      same(analysis.map((source) => source.sourceId).sort(), ids) &&
        same(proposals.sources.map((source) => source.sourceId).sort(), ids),
      'analysis or proposals omit or duplicate sources'
    )
    const sources = []
    for (const source of historical.sources) {
      const captured = await readFile(resolve(captures, `${source.sourceId}-pinned.txt`), 'utf8')
      const current = await readFile(resolve(captures, `${source.sourceId}.txt`), 'utf8')
      sources.push(
        createSourceLineage(
          source,
          freshness.sources.find((entry) => entry.sourceId === source.sourceId),
          analysis.find((entry) => entry.sourceId === source.sourceId),
          proposals.sources.find((entry) => entry.sourceId === source.sourceId),
          { captured, current }
        )
      )
    }
    register = { schemaVersion: 1, scope: lineageScope, sources }
    for (const source of sources)
      freshness.sources.find(
        (entry) => entry.sourceId === source.sourceId
      ).lineageRegisterSourceSha256 = sourceLineageSha256(source)
  } else register = await readJson(resolve(root, registerPath))
  const errors = validateLineageRegister(register, historical, freshness)
  requireCondition(errors.length === 0, errors.join('\n'))
  if (args.includes('--check-captures')) {
    const captures = option('--check-captures')
    for (const source of historical.sources) {
      const stored = register.sources.find((entry) => entry.sourceId === source.sourceId)
      const captured = await readFile(resolve(captures, `${source.sourceId}-pinned.txt`), 'utf8')
      const current = await readFile(resolve(captures, `${source.sourceId}.txt`), 'utf8')
      const rebuilt = createSourceLineage(
        source,
        freshness.sources.find((entry) => entry.sourceId === source.sourceId),
        { sourceId: source.sourceId, changedBlocks: stored.blocks },
        stored,
        { captured, current }
      )
      requireCondition(
        same(stored, rebuilt),
        `${source.sourceId}: stored block hashes or coverage differ from captures`
      )
    }
  }
  if (args.includes('--write')) {
    await writeFile(resolve(root, registerPath), `${JSON.stringify(register, null, 2)}\n`)
    await writeFile(resolve(root, freshnessPath), `${JSON.stringify(freshness, null, 2)}\n`)
  }
  console.log(
    `Validated ${register.sources.length} source revisions and ${register.sources.reduce((total, source) => total + source.atoms.length, 0)} historical clause anchors; semantic review and acceptance remain pending`
  )
}

if (import.meta.main) await main()
