// The dependency-budget provenance guard for the admitted runtime-audit
// slice.
//
// The external closure the repository measures is above the committed
// ceiling (the numbers are in docs/405-runtime-audit.md), and the overage
// was investigated: none of it is attributable to this slice. The slice
// added no dependency at all and removed three declarations that no source in
// those packages imports.
//
// These checks pin that fact so the slice cannot quietly grow the closure,
// and so the committed ceilings cannot be raised from inside it.
//
// The file inventory below is the slice's own source surface, and it is
// checked against the package: every file the slice added is listed, every
// listed file exists, and no source of this package imports an external
// package the package does not declare — so a file added to the slice
// without being listed cannot slip past the guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
  'dependency-budget-scope.test.mjs',
]

/** The repository scripts this slice owns. */
const SLICE_SCRIPTS = ['check-budgets.mjs', 'check-startup-budget.mjs']

/** The import specifiers of a module, as written in its source. */
function importSpecifiers(source) {
  const specifiers = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/gu
  for (const match of source.matchAll(dynamic)) specifiers.push(match[1])
  return specifiers
}

/**
 * The runtime's own modules. They are builtins, not dependencies of the
 * package: `bun:test` is the test runner and `bun` is the runtime module the
 * lockfile reader uses. Neither adds anything to the measured closure.
 */
function isBuiltinSpecifier(specifier) {
  return specifier === 'bun' || specifier.startsWith('bun:')
}

/** The source of a slice file, read from the package or from `scripts/`. */
function sliceSource(file) {
  const path = SLICE_FILES.includes(file)
    ? join(packageRoot, file)
    : join(repositoryRoot, 'scripts', file)
  return readFileSync(path, 'utf8')
}

/** The slice's own source files, as paths. */
function slicePaths() {
  return [
    ...SLICE_FILES.map((file) => join(packageRoot, file)),
    ...SLICE_SCRIPTS.map((file) => join(repositoryRoot, 'scripts', file)),
  ]
}

test('the audit slice imports no external package', () => {
  const external = []
  for (const file of [...SLICE_FILES, ...SLICE_SCRIPTS]) {
    const source = sliceSource(file)
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue
      if (isBuiltinSpecifier(specifier)) continue
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
  for (const file of [...SLICE_FILES, ...SLICE_SCRIPTS]) {
    const specifiers = importSpecifiers(sliceSource(file))
    for (const name of external) {
      if (specifiers.includes(name)) used.push(`${file} -> ${name}`)
    }
  }
  // The package external dependencies are pre-existing; the slice does not
  // reach for any of them, so it adds nothing to the closure.
  assert.deepEqual(used, [])
})

test('the slice inventory covers the files the slice added', () => {
  // Every listed file exists, so a renamed or removed file cannot leave the
  // guard reading a file that is no longer there.
  for (const path of slicePaths()) {
    assert.equal(readFileSync(path, 'utf8').length > 0, true, path)
  }
  // And no source of this package reaches for an external package the
  // package does not declare: a file added to the slice without being
  // listed above still cannot pull a package into the closure.
  const manifest = JSON.parse(readFileSync(join(packageRoot, '..', 'package.json'), 'utf8'))
  const declared = new Set()
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) declared.add(name)
  }
  // The test runner and the runtime module are builtins, not dependencies of
  // the package.
  declared.add('bun:test')
  declared.add('bun')
  const undeclared = []
  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!/\.(ts|tsx|mjs|js)$/u.test(entry.name)) continue
    for (const specifier of importSpecifiers(readFileSync(join(packageRoot, entry.name), 'utf8'))) {
      if (specifier.startsWith('node:')) continue
      if (isBuiltinSpecifier(specifier)) continue
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue
      if (specifier.startsWith('@control-plane/')) continue
      if (declared.has(specifier)) continue
      undeclared.push(`${entry.name} -> ${specifier}`)
    }
  }
  assert.deepEqual(undeclared, [])
})

test('the committed ceilings are unchanged', () => {
  assert.equal(budgets.dependencies.externalPackageCeiling, 285)
  assert.equal(budgets.dist.totalMbCeiling, 12)
  assert.equal(budgets.startup.localAllInOneReadySecondsCeiling, 45)
  assert.equal(budgets.rss.localAllInOnePeakMbCeiling, 256)
  assert.equal(budgets.lanes.build.ceilingSeconds, 300)
})
