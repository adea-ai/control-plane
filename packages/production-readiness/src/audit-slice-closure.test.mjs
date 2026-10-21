// The dependency-budget provenance guard for the admitted runtime-audit
// slice.
//
// The external closure the repository measures (591 `package@version` pairs
// against the committed 285 ceiling) was investigated: none of the overage is
// attributable to this slice. The slice added no dependency at all and
// removed four declarations that no source in those packages imports.
//
// These checks pin that fact so the slice cannot quietly grow the closure,
// and so the committed ceilings cannot be raised from inside it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const budgets = JSON.parse(readFileSync(join(repositoryRoot, 'budgets.json'), 'utf8'))

/** The source files this slice added to the repository. */
const SLICE_FILES = [
  'startup-budget-probe.mjs',
  'startup-budget.test.mjs',
  'budget-regression.test.mjs',
  'audit-slice-closure.test.mjs',
]

/** The import specifiers of a module, as written in its source. */
function importSpecifiers(source) {
  const specifiers = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/gu
  for (const match of source.matchAll(dynamic)) specifiers.push(match[1])
  return specifiers
}

test('the audit slice imports no external package', () => {
  const external = []
  for (const file of SLICE_FILES) {
    const source = readFileSync(join(packageRoot, file), 'utf8')
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue
      external.push(`${file} -> ${specifier}`)
    }
  }
  assert.deepEqual(external, [])
})

test('the audit slice does not reach for the package external dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, '..', 'package.json'), 'utf8'))
  const external = []
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith('@control-plane/')) continue
      external.push(name)
    }
  }
  const used = []
  for (const file of SLICE_FILES) {
    const specifiers = importSpecifiers(readFileSync(join(packageRoot, file), 'utf8'))
    for (const name of external) {
      if (specifiers.includes(name)) used.push(`${file} -> ${name}`)
    }
  }
  // The package external dependencies are pre-existing; the slice does not
  // reach for any of them, so it adds nothing to the closure.
  assert.deepEqual(used, [])
})

test('the committed ceilings are unchanged', () => {
  assert.equal(budgets.dependencies.externalPackageCeiling, 285)
  assert.equal(budgets.dist.totalMbCeiling, 12)
  assert.equal(budgets.startup.localAllInOneReadySecondsCeiling, 45)
  assert.equal(budgets.rss.localAllInOnePeakMbCeiling, 256)
  assert.equal(budgets.lanes.build.ceilingSeconds, 300)
})
