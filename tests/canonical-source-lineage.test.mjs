import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as lineage from '../scripts/canonical-source-lineage.mjs'
const { parseSourceLines, partitionSourceLines } = lineage

test('source anchors preserve ranges and individually referenced lines', () => {
  assert.deepEqual(parseSourceLines('Protocol, L8–10; L12 / L14-L15', 20), [8, 9, 10, 12, 14, 15])
  assert.deepEqual(parseSourceLines('ADR-001: Three.js for Spatial Rendering, L10', 20), [10])
})

function fixture() {
  const captured = 'Heading\nOld obligation\nKeep\n'
  const current = 'Heading\nNew obligation\nKeep\nAdded\n'
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  return {
    historical: {
      sourceId: 'sample',
      sourceDocumentId: 'doc',
      sourceRevision: 1,
      sourceContentSha256: sha(captured),
      capturedLogicalLines: 3,
      atoms: [
        { id: 'OLD-001', columns: { Source: 'L2' } },
        { id: 'OLD-002', columns: { Source: 'L3' } },
      ],
    },
    receipt: {
      sourceId: 'sample',
      documentId: 'doc',
      capturedRevision: 1,
      capturedTextSha256: sha(captured),
      observedCurrentRevision: 2,
      observedTextSha256: sha(current),
      observedTextLogicalLines: 4,
    },
    analysis: {
      sourceId: 'sample',
      changedBlocks: [
        { type: 'replace', oldLines: [2, 2], currentLines: [2, 2] },
        { type: 'insert', oldLines: [], currentLines: [4, 4] },
      ],
    },
    proposal: {
      sourceId: 'sample',
      blocks: [
        {
          oldLines: [2, 2],
          currentLines: [2, 2],
          disposition: 'supersedes',
          reason: 'Revised obligation',
          oldAtomIds: ['OLD-001'],
          currentClauses: [{ sourceLines: [2], kind: 'obligation', text: 'New obligation' }],
        },
        {
          oldLines: [],
          currentLines: [4, 4],
          disposition: 'adds',
          reason: 'New requirement',
          oldAtomIds: [],
          currentClauses: [{ sourceLines: [4], kind: 'obligation', text: 'Added' }],
        },
      ],
    },
    captures: { captured, current },
  }
}

function reconcile(input) {
  return lineage.createSourceLineage(
    input.historical,
    input.receipt,
    input.analysis,
    input.proposal,
    input.captures
  )
}

test('insertions and deletions shift anchors without losing the remaining source text', () => {
  assert.deepEqual(
    partitionSourceLines(
      [
        { type: 'insert', oldLines: [], currentLines: [2, 2] },
        { type: 'delete', oldLines: [3, 3], currentLines: [] },
      ],
      4,
      4
    ),
    [
      { type: 'equal', oldLines: [1, 1], currentLines: [1, 1] },
      { type: 'insert', oldLines: [], currentLines: [2, 2] },
      { type: 'equal', oldLines: [2, 2], currentLines: [3, 3] },
      { type: 'delete', oldLines: [3, 3], currentLines: [] },
      { type: 'equal', oldLines: [4, 4], currentLines: [4, 4] },
    ]
  )
  assert.throws(() =>
    partitionSourceLines([{ type: 'replace', oldLines: [2, 2], currentLines: [3, 3] }], 4, 4)
  )
})

test('changed clauses and shifted equal anchors remain distinct from acceptance', () => {
  const result = reconcile(fixture())
  assert.deepEqual(result.atoms, [
    { atomId: 'OLD-001', oldLines: [2], currentLines: [], status: 'source-text-changed' },
    { atomId: 'OLD-002', oldLines: [3], currentLines: [3], status: 'source-text-unchanged' },
  ])
  assert.equal(result.blocks[0].currentClauses[0].id, 'sample-current-001')
  assert.equal(result.candidateAcceptance, 'not-assessed')
  assert.equal(result.independentReview, 'pending')
})

test('reconciliation fails closed on stale captures, missing blocks and omitted old atoms', () => {
  for (const alter of [
    (x) => {
      x.captures.current += 'drift'
    },
    (x) => {
      x.proposal.blocks.pop()
    },
    (x) => {
      x.proposal.blocks[0].oldAtomIds = []
    },
    (x) => {
      x.proposal.blocks[0].currentClauses[0].sourceLines = [3]
    },
    (x) => {
      x.captures.current = 'Different\nNew obligation\nKeep\nAdded\n'
      x.receipt.observedTextSha256 = createHash('sha256').update(x.captures.current).digest('hex')
    },
  ]) {
    const input = fixture()
    alter(input)
    assert.throws(() => reconcile(input))
  }
})

test('source anchors reject missing, inverted, zero and out-of-range references', () => {
  for (const anchor of ['Protocol', 'L0', 'L9-L8', 'L21', 'L8-L', 'L8-L9x'])
    assert.throws(() => parseSourceLines(anchor, 20), /source anchor/)
})

test('register verification retains every source and rejects fabricated lineage or acceptance', () => {
  const input = fixture()
  const register = { schemaVersion: 1, scope: lineage.lineageScope, sources: [reconcile(input)] }
  const old = { sources: [input.historical] }
  input.receipt.lineageRegisterSourceSha256 = lineage.sourceLineageSha256(register.sources[0])
  const current = { sources: [input.receipt] }
  assert.deepEqual(lineage.validateLineageRegister(register, old, current), [])
  for (const alter of [
    (x) => {
      x.sources = []
    },
    (x) => {
      x.sources.push(x.sources[0])
    },
    (x) => {
      x.sources[0].atoms.pop()
    },
    (x) => {
      x.sources[0].atoms[1].currentLines = [4]
    },
    (x) => {
      x.sources[0].candidateAcceptance = 'verified'
    },
    (x) => {
      x.sources[0].blocks[0].currentClauses = []
    },
    (x) => {
      x.sources[0].currentRevision = 999
    },
    (x) => {
      x.sources[0].blocks[0].currentClauses[0].text = 'Invented replacement obligation'
    },
  ]) {
    const corrupted = structuredClone(register)
    alter(corrupted)
    assert.ok(lineage.validateLineageRegister(corrupted, old, current).length > 0)
  }
})

test('committed current reconciliation covers the historical register and freshness receipt', async () => {
  const root = new URL('..', import.meta.url)
  const errors = await lineage.validateCanonicalSourceLineage(root.pathname)
  assert.deepEqual(errors, [])
  const read = async (file) =>
    JSON.parse(await readFile(new URL(`docs/requirements/${file}`, root), 'utf8'))
  const old = await read('control-plane-atomic-clauses.v1.json')
  const current = await read('canonical-source-lineage-2026-10-03.v1.json')
  assert.equal(
    current.sources.reduce((total, source) => total + source.atoms.length, 0),
    old.sources.reduce((total, source) => total + source.atoms.length, 0)
  )
  assert.ok(
    current.sources.every(
      (source) =>
        source.independentReview === 'pending' && source.candidateAcceptance === 'not-assessed'
    )
  )
})
