import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as atomicLedger from '../scripts/atomic-clause-ledger.mjs'
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
  provider: 'work-drive',
  revisionMetadataStatus: 'Revision verified separately; exact fetch instant unavailable.',
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

const crosswalkTable = `## Existing requirements crosswalk
| Existing requirement | Existing classification | Atomic inventory mapping |
| --- | --- | --- |
| \`CP-TEST-001\` | partially_verified | TDD-A001-A002; A002 remains incomplete. |
`

describe('atomic requirement crosswalk', () => {
  test('normalizes explicit ranges and shorthand while retaining qualifications', () => {
    expect(atomicLedger.extractRequirementCrosswalk).toBeFunction()
    const rows = atomicLedger.extractRequirementCrosswalk(crosswalkTable, 'TDD-A')
    expect(rows).toEqual([
      {
        requirementId: 'CP-TEST-001',
        atomIds: ['TDD-A001', 'TDD-A002'],
        inventoryLine: 4,
        heading: 'Existing requirements crosswalk',
        columns: {
          'Existing classification': 'partially_verified',
          'Atomic inventory mapping': 'TDD-A001-A002; A002 remains incomplete.',
        },
      },
    ])
    expect(
      atomicLedger.extractRequirementCrosswalk(
        '| Existing row | Atomic inventory mapping |\n| --- | --- |\n| CP-TEST-002 | CPPRD-104-105 |',
        'CPPRD-'
      )[0].atomIds
    ).toEqual(['CPPRD-104', 'CPPRD-105'])
  })

  test('rejects malformed, reversed, and foreign-source atom references', () => {
    for (const mapping of ['TDD-A002-A001', 'TDD-A99', 'CPPRD-001', 'no explicit atoms']) {
      expect(() =>
        atomicLedger.extractRequirementCrosswalk(
          crosswalkTable.replace('TDD-A001-A002; A002 remains incomplete.', mapping),
          'TDD-A'
        )
      ).toThrow()
    }
    expect(() =>
      atomicLedger.extractRequirementCrosswalk(
        crosswalkTable.replace('| partially_verified |', '|'),
        'TDD-A'
      )
    ).toThrow()
  })

  test('rejects unknown requirements, unknown atoms, duplicate rows and source mismatches', async () => {
    await fixture(async (root) => {
      const configured = structuredClone(source)
      configured.atomicInventory.requirementCrosswalk = { atomIdPrefix: 'TDD-A' }
      const ledger = {
        sources: [configured],
        requirements: [{ id: 'CP-TEST-001', sourceId: source.id, classification: 'tbd' }],
      }
      const document = table.replaceAll('A-L008-01', 'TDD-A001').replaceAll('A-L009-01', 'TDD-A002')
      await writeFile(join(root, source.atomicInventory.path), document + crosswalkTable)
      expect(atomicLedger.collectAtomicCrosswalk).toBeFunction()
      const valid = await atomicLedger.collectAtomicCrosswalk(ledger, root)
      expect(valid.errors).toEqual([])
      expect(valid.register.sources[0]).toMatchObject({
        requirementMapping: 'incomplete',
        candidateAcceptance: 'not-established',
        unmappedAtomIds: [],
      })
      expect(ledger.requirements[0].classification).toBe('tbd')
      for (const [changed, expected] of [
        [crosswalkTable.replace('CP-TEST-001', 'CP-TEST-999'), 'unknown requirement'],
        [crosswalkTable.replaceAll('A002', 'A999'), 'unknown atom'],
        [crosswalkTable + crosswalkTable, 'duplicate requirement'],
        ['', 'missing crosswalk'],
      ]) {
        await writeFile(join(root, source.atomicInventory.path), document + changed)
        expect(
          (await atomicLedger.collectAtomicCrosswalk(ledger, root)).errors.join('\n')
        ).toContain(expected)
      }
      await writeFile(join(root, source.atomicInventory.path), document + crosswalkTable)
      ledger.requirements[0].sourceId = 'another-source'
      expect((await atomicLedger.collectAtomicCrosswalk(ledger, root)).errors.join('\n')).toContain(
        'source mismatch'
      )
    })
  })

  test('existing crosswalks cannot disappear by removing their configuration', async () => {
    await fixture(async (root) => {
      const document = table.replaceAll('A-L008-01', 'TDD-A001').replaceAll('A-L009-01', 'TDD-A002')
      await writeFile(join(root, source.atomicInventory.path), document + crosswalkTable)
      const result = await atomicLedger.collectAtomicCrosswalk(
        {
          sources: [source],
          requirements: [{ id: 'CP-TEST-001', sourceId: source.id }],
        },
        root
      )
      expect(result.errors.join('\n')).toContain('crosswalk configuration required')
    })
  })

  test('requirement identities are validated against the ledger rather than a CP-only prefix', () => {
    expect(
      atomicLedger.extractRequirementCrosswalk(
        crosswalkTable.replace('CP-TEST-001', 'PROJECT-INDEX-RETRIEVAL-001'),
        'TDD-A'
      )[0].requirementId
    ).toBe('PROJECT-INDEX-RETRIEVAL-001')
  })

  test('rejects a malformed atom beside a valid reference instead of truncating the binding', () => {
    for (const mapping of [
      'TDD-A001, TDD-A00O',
      'TDD-A001, A00O',
      'TDD-A001, TDD-A002-A00O',
      'TDD-A001, CPPRD-00O',
      'TDD-A001, TDD-A002_bad',
      'TDD-A001; tdd-a002',
      'TDD-A001; a002',
      'TDD-A001; TDD-A002é',
      'TDD-A001; éTDD-A002',
      'TDD-A001; éA002',
      'TDD-A001; TDD‐A002',
      'TDD-A001; CPPRD‐001',
      'TDD-A001; TDD-A002–A004',
      'TDD-A001; TDD−A002',
      'TDD-A001; TDD-A002\u200b',
    ]) {
      expect(() =>
        atomicLedger.extractRequirementCrosswalk(
          crosswalkTable.replace('TDD-A001-A002; A002 remains incomplete.', mapping),
          'TDD-A'
        )
      ).toThrow('malformed atom reference')
    }
  })

  test('crosswalk drift rejects lost links, duplicated bindings and altered qualification text', async () => {
    await fixture(async (root) => {
      const configured = structuredClone(source)
      configured.atomicInventory.requirementCrosswalk = { atomIdPrefix: 'TDD-A' }
      const ledger = {
        sources: [configured],
        requirements: [{ id: 'CP-TEST-001', sourceId: source.id }],
      }
      const document = table.replaceAll('A-L008-01', 'TDD-A001').replaceAll('A-L009-01', 'TDD-A002')
      await writeFile(join(root, source.atomicInventory.path), document + crosswalkTable)
      const captured = await atomicLedger.collectAtomicCrosswalk(ledger, root)
      const path = join(root, 'docs/requirements/control-plane-atomic-crosswalk.v1.json')
      expect(await atomicLedger.validateAtomicCrosswalk(ledger, root)).toEqual([
        'Atomic crosswalk is missing or malformed',
      ])
      await writeFile(path, JSON.stringify(captured.register))
      expect(await atomicLedger.validateAtomicCrosswalk(ledger, root)).toEqual([])
      for (const mutate of [
        (record) => record.sources[0].mappings[0].atomIds.pop(),
        (record) => record.sources[0].mappings.push(record.sources[0].mappings[0]),
        (record) => {
          record.sources[0].mappings[0].columns['Atomic inventory mapping'] = 'All accepted.'
        },
        (record) => {
          record.sources[0].candidateAcceptance = 'established'
        },
      ]) {
        const changed = structuredClone(captured.register)
        mutate(changed)
        await writeFile(path, JSON.stringify(changed))
        expect((await atomicLedger.validateAtomicCrosswalk(ledger, root))[0]).toContain('drifted')
      }
    })
  })

  test('checked-in crosswalk preserves the exact partial mapping and separate audit tables', async () => {
    const ledger = JSON.parse(
      await readFile(
        new URL('../docs/requirements/control-plane-requirements.v1.json', import.meta.url),
        'utf8'
      )
    )
    const root = fileURLToPath(new URL('..', import.meta.url))
    expect(await atomicLedger.validateAtomicCrosswalk(ledger, root)).toEqual([])
    const { register } = await atomicLedger.collectAtomicCrosswalk(ledger, root)
    expect(register.summary).toEqual({
      atomicClauseCount: 6093,
      mappedAtomCount: 291,
      unmappedAtomCount: 5802,
      mappedRequirementCount: 70,
      unlinkedRequirementCount: 130,
      linkCount: 333,
    })
    expect(
      register.sources.find(({ sourceId }) => sourceId === 'security-trust-model')
        .unmaterializedCrosswalkTables
    ).toHaveLength(1)
    expect(register.sources.every((item) => item.candidateAcceptance === 'not-established')).toBe(
      true
    )
  })
})

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
  test('preserves provider identity and provenance uncertainty in the standalone register', async () => {
    await fixture(async (root) => {
      const captured = await collectAtomicClauses([source], root)
      expect(captured.sources[0]).toMatchObject({
        sourceProvider: 'work-drive',
        sourceRevisionMetadataStatus:
          'Revision verified separately; exact fetch instant unavailable.',
      })
    })
  })

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
