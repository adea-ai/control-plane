// The dependency budget's measurement: scope, identities and the ceiling.
//
// The committed dependency budget counts the unique external
// `package@version` pairs of the resolved graph. Two things are pinned here:
//
//   - the fixtures exercise the checker's own exported `normalizePackageName`
//     and `countExternalPackages` on small explicit listings, so a wrong
//     package identity fails the regression even when the total count does
//     not change;
//   - the scope is measured on the real installed listing: the reported
//     identities are plain package identities (never an install path), the
//     workspace packages are absent, the count and the identities agree, and
//     the committed ceiling is still 285.
//
// The checker stays self-contained (the repository's own lane test copies it
// into a temporary repository and runs it there), so the fixtures reach it
// through its documented listing seam rather than by importing it across a
// workspace boundary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const budgets = JSON.parse(readFileSync(join(repositoryRoot, 'budgets.json'), 'utf8'))

/** The listing seam: the checker reads its listing from this file. */
const LISTING_FILE = 'ADEA_DEPS_LISTING_FILE'

/** Runs the dependency checker over an explicit listing. */
function checkListing(listing) {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-deps-listing-'))
  try {
    const file = join(directory, 'listing.txt')
    writeFileSync(file, listing)
    const result = spawnSync(process.execPath, ['scripts/check-budgets.mjs', 'deps'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, [LISTING_FILE]: file },
    })
    const line = result.stdout
      .split('\n')
      .find(
        (candidate) => candidate.startsWith('OK: ') || candidate.startsWith('BUDGET EXCEEDED: ')
      )
    assert.notEqual(
      line,
      undefined,
      `the checker reported nothing:\n${result.stdout}\n${result.stderr}`
    )
    return { ...JSON.parse(line.slice(line.indexOf('{'))), status: result.status }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a nested scoped install is normalized to its package identity', () => {
  const result = checkListing(
    [
      'node_modules',
      '├── vite-plus/oxlint/@oxlint/binding-darwin-arm64@1.88.0',
      '└── @oxlint/binding-darwin-arm64@1.88.0',
      '',
    ].join('\n')
  )
  // The same package reached through two install paths is one package.
  assert.deepEqual(result.pairs, ['@oxlint/binding-darwin-arm64@1.88.0'])
  assert.equal(result.measured, 1)
})

test('a nested unscoped install is normalized to its package identity', () => {
  const result = checkListing(
    ['node_modules', '├── vendor/nested/semver@7.8.5', '└── semver@7.8.5', ''].join('\n')
  )
  assert.deepEqual(result.pairs, ['semver@7.8.5'])
  assert.equal(result.measured, 1)
})

test('distinct versions of the same package are both counted', () => {
  const result = checkListing(
    ['node_modules', '├── semver@7.8.5', '├── semver@7.6.3', ''].join('\n')
  )
  assert.deepEqual(result.pairs, ['semver@7.6.3', 'semver@7.8.5'])
  assert.equal(result.measured, 2)
})

test('workspace links are excluded and header lines are ignored', () => {
  const result = checkListing(
    [
      'node_modules',
      '├── @control-plane/domain@1.0.0',
      '├── @control-plane/testing@1.0.0',
      '├── zod@4.6.5',
      '└── ',
      '',
      'some other line that is not a package',
    ].join('\n')
  )
  assert.deepEqual(result.pairs, ['zod@4.6.5'])
  assert.equal(result.measured, 1)
})

test('a wrong package identity fails even when the count does not change', () => {
  // Two install paths of the same package: a parser that keeps the path
  // would report two identities, and one that mangles the version would
  // report a wrong one. Either way the identities below change.
  const result = checkListing(
    [
      'node_modules',
      '├── vite-plus/oxlint/@oxlint/binding-darwin-arm64@1.88.0',
      '└── @oxlint/binding-darwin-arm64@1.88.0',
      '',
    ].join('\n')
  )
  assert.equal(result.measured, 1)
  assert.deepEqual(result.pairs, ['@oxlint/binding-darwin-arm64@1.88.0'])
  for (const identity of result.pairs) {
    assert.equal(identity.includes('/') && !identity.startsWith('@'), false)
    assert.equal(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9][^\s@]*$/u.test(identity), true)
  }
})

test('the measured scope of the real listing is the installed external graph', () => {
  const listing = spawnSync(process.execPath, ['pm', 'ls', '--all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.equal(listing.status, 0, listing.stderr)
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-deps-scope-'))
  try {
    const file = join(directory, 'listing.txt')
    writeFileSync(file, listing.stdout)
    const result = spawnSync(process.execPath, ['scripts/check-budgets.mjs', 'deps'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, [LISTING_FILE]: file },
    })
    const line = result.stdout
      .split('\n')
      .find(
        (candidate) => candidate.startsWith('OK: ') || candidate.startsWith('BUDGET EXCEEDED: ')
      )
    assert.notEqual(
      line,
      undefined,
      `the checker reported nothing:\n${result.stdout}\n${result.stderr}`
    )
    const measured = JSON.parse(line.slice(line.indexOf('{')))
    assert.equal(measured.measured, measured.pairs.length)
    // Every counted identity is a plain package identity, never an install
    // path: a mangled identity fails here even though the count is unchanged.
    for (const identity of measured.pairs) {
      assert.equal(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9][^\s@]*$/u.test(identity), true)
      assert.equal(identity.startsWith('@control-plane/'), false)
    }
    assert.equal(measured.ceiling, budgets.dependencies.externalPackageCeiling)
    assert.equal(measured.ok, measured.measured <= budgets.dependencies.externalPackageCeiling)
    assert.equal(result.status, measured.ok ? 0 : 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the committed dependency ceiling is unchanged', () => {
  assert.equal(budgets.dependencies.externalPackageCeiling, 285)
})
