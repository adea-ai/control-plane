import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('principle crosswalk retains all reviewed anchors and resolves every cited requirement', async () => {
  const document = await readFile(
    new URL('../docs/requirements/control-plane-prd-principle-crosswalk.md', import.meta.url),
    'utf8'
  )
  const ledger = JSON.parse(
    await readFile(
      new URL('../docs/requirements/control-plane-requirements.v1.json', import.meta.url),
      'utf8'
    )
  )
  const ids = new Set(ledger.requirements.map(({ id }) => id))
  const rows = document.split('\n').filter((line) => /^\|\s+P\d{5}\s+\|/.test(line))
  expect(rows.map((line) => line.split('|')[1].trim())).toEqual(
    [55, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66].map(
      (number) => `P${String(number).padStart(5, '0')}`
    )
  )
  for (const row of rows) {
    const references = [...row.matchAll(/`([A-Z][A-Z0-9-]+)`/g)].map((match) => match[1])
    expect(references.length).toBeGreaterThan(0)
    for (const id of references) expect(ids.has(id)).toBe(true)
  }
  // Structural integrity only; this test does not certify semantic equivalence.
  expect(document).toContain('No issue is closed or requirement reclassified')
  expect(document).toContain('Independent approval is still required.')
})
