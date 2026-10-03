import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectAtomicClauses,
  extractAtomicClauses,
  validateAtomicClauseRegister,
} from '../scripts/atomic-clause-ledger.mjs'

const table = `## Accepted source clauses
| Atom | Source | Clause |
| --- | --- | --- |
| A-L008-01 | L8 | A literal a\\|b stays in its clause. |
| A-L009-01 | L9 | Preserve \\|, \\*, and Markdown exactly. |

## Line coverage
| Line | Atoms |
| --- | --- |
| L8 | A-L008-01 |
`
const source = {
  id: 'test-source',
  retrievalStatus: 'retrieved',
  currentRevision: 2,
  fileModifiedAt: '2026-09-29T02:15:40.033Z',
  contentSha256: 'a'.repeat(64),
  atomicInventory: {
    path: 'docs/requirements/test-atomic-inventory.md',
    sourceRevision: 2,
    contentSha256: 'a'.repeat(64),
    logicalLines: 9,
    atoms: 2,
    extractionScope: 'captured-text',
    requirementMapping: 'incomplete',
    implementationMapping: 'bounded-path-inspection',
    candidateAcceptance: 'not-established',
  },
}

async function fixture(run, document = table) {
  const root = await mkdtemp(join(tmpdir(), 'cp-atomic-ledger-test-'))
  try {
    await mkdir(join(root, 'docs/requirements'), { recursive: true })
    await writeFile(join(root, source.atomicInventory.path), document)
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('atomic clause ledger', () => {
  test('rejects empty or malformed inventory metadata before producing a register', async () => {
    await fixture(async (root) => {
      const changed = structuredClone(source)
      changed.atomicInventory.logicalLines = 0
      changed.atomicInventory.contentSha256 = 'unidentified bytes'
      const result = await collectAtomicClauses([changed], root)
      expect(result.errors).toContain('test-source: atomic inventory metadata is invalid')
      expect(result.sources).toEqual([])
    })
  })

  test('retains the captured clauses when current source retrieval becomes unavailable', async () => {
    await fixture(async (root) => {
      const changed = structuredClone(source)
      changed.retrievalStatus = 'missing'
      const result = await collectAtomicClauses([changed], root)
      expect(result.errors).toEqual([])
      expect(result.sources[0].atoms).toHaveLength(2)
      expect(result.sources[0].retrievalStatus).toBe('missing')
    })
  })

  test('captures clauses and their exact source columns without treating coverage rows as atoms', () => {
    const atoms = extractAtomicClauses(table)
    expect(atoms.map(({ id }) => id)).toEqual(['A-L008-01', 'A-L009-01'])
    expect(atoms[0]).toMatchObject({
      heading: 'Accepted source clauses',
      inventoryLine: 4,
      columns: { Source: 'L8', Clause: 'A literal a\\|b stays in its clause.' },
    })
    expect(atoms[1].columns.Clause).toBe('Preserve \\|, \\*, and Markdown exactly.')
  })

  test('rejects truncated clause rows and duplicate column names instead of losing content', () => {
    expect(() =>
      extractAtomicClauses(table.replace(' | A literal a\\|b stays in its clause.', ''))
    ).toThrow('malformed atomic clause')
    expect(() =>
      extractAtomicClauses(
        table.replace('| Atom | Source | Clause |', '| Atom | Clause | Clause |')
      )
    ).toThrow('duplicate atomic column')
  })

  test('rejects duplicate identities even when the declared clause count still matches', async () => {
    await fixture(
      async (root) => {
        const result = await collectAtomicClauses([source], root)
        expect(result.errors).toContain('test-source: duplicate atomic clause ID A-L008-01')
      },
      table.replace('A-L009-01', 'A-L008-01')
    )
  })

  test('does not read an inventory path outside the requirement directory', async () => {
    await fixture(async (root) => {
      const changed = structuredClone(source)
      changed.atomicInventory.path = 'docs/requirements/../../outside.md'
      const result = await collectAtomicClauses([changed], root)
      expect(result.errors).toEqual([
        'test-source: atomic inventory path must be under docs/requirements',
      ])
      expect(result.sources).toEqual([])
    })
  })

  test('rejects a repository inventory symlink to content outside the requirement directory', async () => {
    await fixture(async (root) => {
      const path = join(root, source.atomicInventory.path)
      const outside = join(root, 'outside.md')
      await writeFile(outside, table)
      await rm(path)
      await symlink(outside, path)
      const result = await collectAtomicClauses([source], root)
      expect(result.errors).toEqual([
        'test-source: atomic inventory path must be under docs/requirements',
      ])
      expect(result.sources).toEqual([])
    })
  })

  test('register comparison rejects altered clause text with unchanged identities and counts', async () => {
    await fixture(async (root) => {
      const captured = await collectAtomicClauses([source], root)
      const register = {
        schemaVersion: 1,
        scope: 'captured-text clauses; mapping and acceptance remain separate',
        sources: captured.sources,
      }
      const registerPath = join(root, 'docs/requirements/control-plane-atomic-clauses.v1.json')
      await writeFile(registerPath, JSON.stringify(register))
      expect(await validateAtomicClauseRegister([source], root)).toEqual([])
      register.sources[0].atoms[0].columns.Clause = 'An unsupported replacement.'
      await writeFile(registerPath, JSON.stringify(register))
      expect(await validateAtomicClauseRegister([source], root)).toEqual([
        'Atomic clause register drifted; run bun run requirements:atomic:write',
      ])
    })
  })

  test('register comparison reports missing artifacts and retains incomplete mapping boundaries', async () => {
    await fixture(async (root) => {
      expect(await validateAtomicClauseRegister([source], root)).toEqual([
        'Atomic clause register is missing or malformed',
      ])
      const captured = await collectAtomicClauses([source], root)
      expect(captured.sources[0]).toMatchObject({
        requirementMapping: 'incomplete',
        candidateAcceptance: 'not-established',
      })
      expect(captured.sources[0].atoms[0]).not.toHaveProperty('verified')
    })
  })

  test('checked-in register includes the exact current clause inventory of every source', async () => {
    const ledger = JSON.parse(
      await readFile(
        new URL('../docs/requirements/control-plane-requirements.v1.json', import.meta.url),
        'utf8'
      )
    )
    const root = fileURLToPath(new URL('..', import.meta.url))
    expect(await validateAtomicClauseRegister(ledger.sources, root)).toEqual([])
    const captured = await collectAtomicClauses(ledger.sources, root)
    expect(captured.errors).toEqual([])
    expect(captured.sources).toHaveLength(15)
    expect(captured.sources.reduce((count, item) => count + item.atoms.length, 0)).toBe(6093)
  })
})
