// The dependency budget's measurement scope, pinned.
//
// The committed dependency budget counts the unique external
// `package@version` pairs of the resolved graph, and the external closure
// this repository currently measures (591) is above the committed ceiling
// (285). This test pins *what the measurement covers*, so a change of the
// measurement's scope is a visible, reviewed diff instead of a silent
// difference in the number:
//
//   - the pairs the checker reports are exactly the external pairs of the
//     lockfile, with the workspace packages excluded by name;
//   - the verdict it reports follows from the measured count and the
//     committed ceiling;
//   - the ceiling itself is still the reviewed value.
//
// The checker's own verdict is not asserted to be "ok": the measured closure
// is above the ceiling and that breach is reported, not waived.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const budgets = JSON.parse(readFileSync(join(repositoryRoot, 'budgets.json'), 'utf8'))

/** The package name of a listing entry, without its install path. */
function normalizePackageName(raw) {
  const segments = String(raw).split('/')
  if (segments.length >= 2 && segments[segments.length - 2].startsWith('@'))
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
  return segments[segments.length - 1]
}

/**
 * The distinct external `package@version` pairs of the installed listing.
 *
 * The reference is computed here from the listing the checker reads, with an
 * independent implementation, so the two must agree.
 */
function externalListingPairs() {
  const listing = spawnSync(process.execPath, ['pm', 'ls', '--all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.equal(listing.status, 0, listing.stderr)
  const pairs = new Set()
  for (const line of listing.stdout.split('\n')) {
    const match = line.match(/^(?:[\u2500-\u257f\s]*)(.*)@([^@\s]+)$/u)
    if (match === null) continue
    const name = normalizePackageName(match[1])
    if (name === '' || name.startsWith('@control-plane/')) continue
    pairs.add(`${name}@${match[2]}`)
  }
  return pairs
}

test('the dependency measurement covers the external pairs of the lockfile', () => {
  const result = spawnSync(process.execPath, ['scripts/check-budgets.mjs', 'deps'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  const line = result.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith('OK: ') || candidate.startsWith('BUDGET EXCEEDED: '))
  assert.notEqual(
    line,
    undefined,
    `the checker reported nothing:\n${result.stdout}\n${result.stderr}`
  )
  const measured = JSON.parse(line.slice(line.indexOf('{')))
  const expected = externalListingPairs()
  assert.equal(measured.measured, expected.size)
  assert.equal(measured.ceiling, budgets.dependencies.externalPackageCeiling)
  // The verdict follows from the measurement and the committed ceiling.
  assert.equal(measured.ok, expected.size <= budgets.dependencies.externalPackageCeiling)
  // The checker exits non-zero exactly when the measured closure is above the
  // ceiling; the exit code is the breach being reported, not a defect.
  assert.equal(result.status, measured.ok ? 0 : 1)
})

test('the committed dependency ceiling is unchanged', () => {
  assert.equal(budgets.dependencies.externalPackageCeiling, 285)
})
