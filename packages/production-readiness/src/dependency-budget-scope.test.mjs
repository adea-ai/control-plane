// The dependency budget's measurement: scope, identities and the ceiling.
//
// The committed dependency budget counts the unique external
// `package@version` pairs of the resolved graph. Two things are pinned here:
//
//   - the fixtures drive the checker's own identity rule through its
//     documented listing seam, on small explicit listings, so a wrong
//     package identity fails the regression even when the total count does
//     not change;
//   - the scope is measured on the REAL listing, with the seam **unset** —
//     the way the budget is measured — and the number the checker reports
//     must equal the distinct external pairs of `bun pm ls --all`, computed
//     independently here. The reported identities must be plain package
//     identities, the workspace packages must be absent, and the committed
//     ceiling must still be 285.
//
// The checker stays self-contained (the repository's own lane test copies it
// into a temporary repository and runs it there), so the fixtures reach it
// through its documented listing seam rather than by importing it across a
// workspace boundary. The seam changes the measurement's **input**, never its
// scope: the test asserts that the seam and the real path measure the same
// scope over the same listing.
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

/**
 * The listing the budget measures: the lockfile's dependency tree, as
 * `bun pm ls --all` reports it.
 */
function realListing() {
  const result = spawnSync('bun', ['pm', 'ls', '--all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}

/**
 * The distinct external `package@version` pairs of a listing, computed here
 * independently of the checker.
 *
 * The reference is a second implementation of the same question, so a change
 * of the checker's scope — a different set of packages counted — is a visible
 * difference in the number rather than a silent one.
 */
function externalPairs(listing) {
  const pairs = new Set()
  for (const line of listing.split('\n')) {
    const entry = line.replace(/^[│├└─\s]*/, '')
    const at = entry.lastIndexOf('@')
    if (at <= 0) continue
    const name = entry.slice(0, at)
    const version = entry.slice(at + 1)
    if (version === '' || /\s/u.test(version)) continue
    // A scoped package keeps its scope; an install path in front of it is
    // dropped, so the entry is counted as the package it names.
    const segments = name.split('/')
    const identity =
      segments.length >= 2 && segments[segments.length - 2].startsWith('@')
        ? `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
        : segments[segments.length - 1]
    if (identity === '' || identity.startsWith('@control-plane/')) continue
    pairs.add(`${identity}@${version}`)
  }
  return pairs
}

/** Runs the dependency checker and returns its report and exit status. */
function runChecker({ listingFile } = {}) {
  const env = { ...process.env }
  // The seam is REMOVED unless a listing file is named, so the real
  // measurement is exercised even when the ambient environment carries the
  // seam variable.
  if (listingFile === undefined) delete env[LISTING_FILE]
  else env[LISTING_FILE] = listingFile
  const result = spawnSync(process.execPath, ['scripts/check-budgets.mjs', 'deps'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  })
  const line = result.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith('OK: ') || candidate.startsWith('BUDGET EXCEEDED: '))
  assert.notEqual(
    line,
    undefined,
    `the checker reported nothing:\n${result.stdout}\n${result.stderr}`
  )
  return { report: JSON.parse(line.slice(line.indexOf('{'))), status: result.status }
}

/** Runs the dependency checker over an explicit listing. */
function checkListing(listing) {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-deps-listing-'))
  try {
    const file = join(directory, 'listing.txt')
    writeFileSync(file, listing)
    const { report, status } = runChecker({ listingFile: file })
    return { ...report, status }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('the checker measures the distinct external pairs of the real listing', () => {
  // The real measurement: the seam is unset, so the checker enumerates the
  // lockfile's dependency tree itself. Its count must equal the count this
  // test computes from the same listing, independently.
  const expected = externalPairs(realListing())
  const { report, status } = runChecker()
  assert.equal(report.measured, expected.size)
  assert.equal(report.ceiling, budgets.dependencies.externalPackageCeiling)
  // The verdict follows from the measurement and the committed ceiling.
  assert.equal(report.ok, expected.size <= budgets.dependencies.externalPackageCeiling)
  // The checker exits non-zero exactly when the measured closure is above the
  // ceiling; the exit code is the breach being reported, not a defect.
  assert.equal(status, report.ok ? 0 : 1)
})

test('the listing seam measures the same scope as the real listing', () => {
  const listing = realListing()
  const expected = externalPairs(listing)
  const result = checkListing(listing)
  // The seam changes the input, not the scope: over the same listing the
  // counted identities are the same ones the real path counts.
  assert.equal(result.measured, expected.size)
  assert.deepEqual(result.pairs, [...expected].toSorted())
  // Every counted identity is a plain package identity, never an install
  // path: a mangled identity fails here even though the count is unchanged.
  for (const identity of result.pairs) {
    assert.equal(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9][^\s@]*$/u.test(identity), true)
    assert.equal(identity.startsWith('@control-plane/'), false)
  }
})

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

test('the committed dependency ceiling is unchanged', () => {
  assert.equal(budgets.dependencies.externalPackageCeiling, 285)
})
