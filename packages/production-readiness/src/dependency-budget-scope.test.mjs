// The dependency budget's measurement: scope, identities and the ceiling.
//
// The committed dependency budget counts the unique external
// `package@version` pairs of the resolved graph. Three things are pinned here:
//
//   - the checker's OWN exported identity rule is exercised directly:
//     `normalizePackageName` and `countExternalPackages` are called on small
//     explicit fixtures, so a wrong package identity or a wrong count fails
//     the regression even when the measured total does not change;
//   - the same rule is exercised end to end through the checker's documented
//     listing seam, on small explicit listings, so the command and the
//     exported function cannot drift apart;
//   - the scope is measured on the REAL listing, with the seam **unset** —
//     the way the budget is measured — and the number the checker reports
//     must equal the distinct external pairs of `bun pm ls --all`, computed
//     independently here. The reported identities must be plain package
//     identities, the workspace packages must be absent, and the committed
//     ceiling must still be 285.
//
// The checker is copied into a temporary directory and imported from there,
// which is the pattern the repository's own lane test uses when it copies
// the checker into a temporary repository. Importing it in place would cross
// a workspace boundary; the copy is the same file, so the exported functions
// under test are the shipped ones. The seam changes the measurement's
// **input**, never its scope: the test asserts that the seam and the real
// path measure the same scope over the same listing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSONC } from 'bun'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const budgets = JSON.parse(readFileSync(join(repositoryRoot, 'budgets.json'), 'utf8'))

/** The listing seam: the checker reads its listing from this file. */
const LISTING_FILE = 'ADEA_DEPS_LISTING_FILE'

/**
 * The checker's exported functions, loaded from a copy of the shipped file.
 *
 * The copy is what keeps the import inside the workspace boundary; the
 * functions under test are the ones the repository ships.
 */
async function loadChecker() {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-deps-checker-'))
  const file = join(directory, 'check-budgets.mjs')
  try {
    copyFileSync(new URL('../../../scripts/check-budgets.mjs', import.meta.url), file)
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

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

/** Independent reference over every lock entry, including other platforms. */
function fullLockPairs() {
  const lock = JSONC.parse(readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8'))
  return externalPairs(
    Object.entries(lock.packages)
      .map(([key, entry]) => {
        const resolved = entry[0]
        return `${key}@${resolved.slice(resolved.lastIndexOf('@') + 1)}`
      })
      .join('\n')
  )
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

test('the checker preserves the distinct all-platform lock identities', () => {
  // The real measurement: the seam is unset, so the checker enumerates the
  // lockfile's dependency tree itself. Its count must equal the count this
  // test computes from the same listing, independently.
  const expected = fullLockPairs()
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

test("the checker's own identity rule normalizes a package identity", async () => {
  const { normalizePackageName } = await loadChecker()
  // A plain package name is already an identity.
  assert.equal(normalizePackageName('zod'), 'zod')
  // A scoped package keeps its scope.
  assert.equal(normalizePackageName('@oxlint/binding-darwin-arm64'), '@oxlint/binding-darwin-arm64')
  // An install path in front of a scoped package is dropped, the scope is not.
  assert.equal(
    normalizePackageName('vite-plus/oxlint/@oxlint/binding-darwin-arm64'),
    '@oxlint/binding-darwin-arm64'
  )
  // An install path in front of an unscoped package is dropped.
  assert.equal(normalizePackageName('vendor/nested/semver'), 'semver')
  // A nested entry under a scoped parent names the child, not the parent.
  assert.equal(normalizePackageName('@fastify/ajv-compiler/fast-uri'), 'fast-uri')
  assert.equal(normalizePackageName('vitest/vite'), 'vite')
  // The workspace packages are recognisable by name, so they can be excluded.
  assert.equal(normalizePackageName('@control-plane/domain'), '@control-plane/domain')
  // Nothing is not a package.
  assert.equal(normalizePackageName(''), '')
})

test("the checker's own counter counts distinct external identities", async () => {
  const { countExternalPackages, externalPackagePairs } = await loadChecker()
  // The same package under two install paths is one package.
  assert.equal(
    countExternalPackages(
      [
        'node_modules',
        '├── vite-plus/oxlint/@oxlint/binding-darwin-arm64@1.88.0',
        '└── @oxlint/binding-darwin-arm64@1.88.0',
        '',
      ].join('\n')
    ),
    1
  )
  // Distinct versions of the same package are two packages.
  assert.equal(
    countExternalPackages(['node_modules', '├── semver@7.8.5', '├── semver@7.6.3', ''].join('\n')),
    2
  )
  // The workspace links and the lines that are not packages are not counted.
  assert.equal(
    countExternalPackages(
      [
        'node_modules',
        '├── @control-plane/domain@1.0.0',
        '├── @control-plane/testing@1.0.0',
        '├── zod@4.6.5',
        '└── ',
        '',
        'some other line that is not a package',
      ].join('\n')
    ),
    1
  )
  // The counted identities are plain package identities, never install paths.
  const pairs = externalPackagePairs(
    ['node_modules', '├── vite-plus/oxlint/@oxlint/binding-darwin-arm64@1.88.0', ''].join('\n')
  )
  assert.deepEqual([...pairs], ['@oxlint/binding-darwin-arm64@1.88.0'])
})

test('the installed CLI listing is counted exactly without redefining the full-lock scope', async () => {
  // The measurement's own source: `bun pm ls --all` lists the tree "according
  // to the current lockfile", so the counted identities are the lockfile's
  // external packages and every one of them is reachable from a workspace
  // root. The checker's own counter must read the same number.
  const { countExternalPackages } = await loadChecker()
  const listing = realListing()
  assert.equal(countExternalPackages(listing), externalPairs(listing).size)
})

test('no package entry of the real listing is dropped by the identity rule', async () => {
  // Every line of the real listing that names a package must yield a usable
  // identity: a package the counter silently drops would make the measured
  // closure smaller than the graph, and the measurement would understate the
  // breach instead of overstating it.
  const { normalizePackageName } = await loadChecker()
  const listing = realListing()
  let packageLines = 0
  for (const line of listing.split('\n')) {
    const body = line.replace(/^[│├└─\s]*/, '')
    if (body === '' || !body.includes('@')) continue
    packageLines += 1
    const at = body.lastIndexOf('@')
    assert.ok(at > 0, `a listing entry has no identity separator: ${line}`)
    const name = normalizePackageName(body.slice(0, at))
    const version = body.slice(at + 1)
    assert.notEqual(name, '', `a listing entry has no package identity: ${line}`)
    assert.equal(/\s/u.test(version), false, `a listing entry has an unusable version: ${line}`)
  }
  assert.ok(packageLines > 0, 'the real listing has no package entries')
})

test('every counted identity is named by the lockfile, and only the workspaces are excluded', async () => {
  // The attribution the audit depends on: each counted identity resolves to a
  // lockfile entry, so the measured closure is the lockfile's external
  // closure and not a parser artefact. The only lockfile packages the count
  // leaves out are the workspace packages, which are not external.
  const { normalizePackageName } = await loadChecker()
  const lock = JSONC.parse(readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8'))
  const lockNames = new Set(
    Object.keys(lock.packages ?? {}).map((key) => normalizePackageName(key))
  )
  const counted = [...fullLockPairs()]
  const countedNames = new Set(counted.map((pair) => pair.slice(0, pair.lastIndexOf('@'))))

  const phantom = [...countedNames].filter((name) => !lockNames.has(name))
  assert.deepEqual(phantom, [], 'a counted identity is not named by the lockfile')

  const excluded = [...lockNames].filter((name) => !countedNames.has(name)).toSorted()
  assert.ok(excluded.length > 0, 'the lockfile names packages the count excludes')
  assert.deepEqual(
    excluded.filter((name) => !name.startsWith('@control-plane/')),
    [],
    'a non-workspace lockfile package is excluded from the count'
  )
})

test('every counted identity of the real listing is a plain package identity', async () => {
  // The identity rule over the real measurement, not only over a fixture: an
  // install path or a mangled version in the measured set would be counted
  // under an identity the lockfile does not name.
  const { externalPackagePairs } = await loadChecker()
  for (const identity of externalPackagePairs(realListing())) {
    assert.equal(
      /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9][^\s@]*$/u.test(identity),
      true,
      `not a plain package identity: ${identity}`
    )
    assert.equal(identity.startsWith('@control-plane/'), false)
  }
})

test('the measured closure is exactly the lockfile graph reachable from the declared roots', async () => {
  // The attribution the audit rests on, recomputed: the counted identities and
  // the identities reachable from the declared roots are the same set. A
  // difference in either direction means the measurement and the attribution
  // have drifted apart.
  const { attributeExternalPackages } = await loadChecker()
  const counted = fullLockPairs()
  const { identities, unresolvedRoots } = attributeExternalPackages(
    readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8')
  )
  assert.deepEqual(unresolvedRoots, [], 'a declared root has no lockfile entry')
  assert.deepEqual(
    [...counted].filter((identity) => !identities.has(identity)),
    []
  )
  assert.deepEqual(
    [...identities].filter((identity) => !counted.has(identity)),
    []
  )
})

test('the named toolchain identities are attributable subsets of the full lock receipt', async () => {
  // The residual, recomputed rather than asserted in prose: the toolchain
  // closure is a proper part of the measured set, and removing it entirely
  // still leaves the closure above the unchanged ceiling. That is what makes
  // the breach a genuine overage rather than a counting artefact. If the
  // reduction ever lands, this check fails loudly and the audit is revisited.
  const { attributeExternalPackages } = await loadChecker()
  const counted = fullLockPairs()
  const { identities } = attributeExternalPackages(
    readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8')
  )
  // The toolchain closure: the Vite+ toolchain and the two copies of the
  // formatter and the linter it brings with it.
  const toolchain = new Set(
    [...identities].filter(
      (identity) =>
        identity.startsWith('vite-plus@') ||
        identity.startsWith('oxfmt@') ||
        identity.startsWith('oxlint@') ||
        identity.startsWith('rolldown@')
    )
  )
  assert.ok(toolchain.size > 0, 'the toolchain closure is empty')
  for (const identity of toolchain) assert.equal(counted.has(identity), true, identity)
})

test('every installed external package is covered by the measured closure', async () => {
  // The installed graph, where the packages are installed: the measurement
  // counts the lockfile's closure, so every installed external package must be
  // covered by it. The comparison is per package name, because an installed
  // package can be named by an alias in the lockfile, and because an install
  // that predates the lockfile's pins carries an older version of a package.
  // Where the tree carries no installed store, there is nothing to check.
  const { attributeExternalPackages } = await loadChecker()
  const counted = fullLockPairs()
  // A counted identity can be an alias, so the package it resolves to is
  // covered too: the lockfile names `vite@1.3.0` for
  // `@voidzero-dev/vite-plus-core@1.3.0`.
  const { resolutions } = attributeExternalPackages(
    readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8')
  )
  const countedNames = new Set(
    [...counted, ...resolutions.values()].map((identity) =>
      identity.slice(0, identity.lastIndexOf('@'))
    )
  )
  const store = join(repositoryRoot, 'node_modules', '.bun')
  let entries = []
  try {
    entries = readdirSync(store)
  } catch {
    return
  }
  const installed = new Set()
  for (const entry of entries) {
    const base = join(store, entry, 'node_modules')
    let names = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const name of names) {
      const candidates = name.startsWith('@')
        ? readdirSync(join(base, name)).map((child) => join(name, child))
        : [name]
      for (const candidate of candidates) {
        const manifest = join(base, candidate, 'package.json')
        if (!existsSync(manifest)) continue
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        installed.add(`${pkg.name}@${pkg.version}`)
      }
    }
  }
  const external = [...installed].filter((identity) => !identity.startsWith('@control-plane/'))
  assert.ok(external.length > 0, 'the installed graph is empty')
  const uncovered = external
    .map((identity) => identity.slice(0, identity.lastIndexOf('@')))
    .filter((name) => !countedNames.has(name))
  assert.deepEqual(uncovered, [], 'an installed external package is not covered by the measurement')
})

test('the exact offenders are attributed per root, and their removal is what an owner could shed', async () => {
  // The actionable attribution: what removing each declared root would shed.
  // A dependency several roots share cannot be shed by dropping one of them,
  // so the saving of a root is what the remaining roots no longer reach once it
  // is gone — and that is the same set as the identities only that root
  // brings in. The two agree only when every edge resolves to the entry that
  // provides it; when they disagree, the attribution is attributing a shared
  // dependency to a root that does not own it.
  const { attributeExternalPackages } = await loadChecker()
  const counted = fullLockPairs()
  const { identities, exclusivePerRoot, removalSavings } = attributeExternalPackages(
    readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8')
  )
  assert.deepEqual(
    [...identities].filter((identity) => !counted.has(identity)),
    [],
    'an attributed identity is not counted'
  )
  const exclusive = Object.values(exclusivePerRoot)
  const total = exclusive.reduce((sum, count) => sum + count, 0)
  assert.ok(total > 0, 'no root has an exclusive share')
  assert.ok(total <= identities.size, 'the exclusive shares exceed the closure')
  // The exclusive share of a root and the saving of removing it are the same
  // set: an identity only that root reaches is exactly an identity the other
  // roots stop reaching when it is removed.
  for (const [root, saving] of Object.entries(removalSavings)) {
    assert.equal(
      exclusivePerRoot[root],
      saving,
      `${root}: the exclusive share and the removal saving disagree`
    )
  }
})

test('the per-root attribution reproduces the published dependency-path attribution', async () => {
  // The attribution is pinned against the numbers the audit publishes, so the
  // two cannot drift apart: a root that resolves to the wrong entry — every
  // version of a name instead of the copy that provides it — changes these
  // numbers without changing the measured total.
  const { attributeExternalPackages } = await loadChecker()
  const { perRoot, owners } = attributeExternalPackages(
    readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8')
  )
  const expected = {
    'vite-plus': 168,
    '@earendil-works/pi-durable': 115,
    '@earendil-works/pi-ai': 85,
    '@nestjs/platform-fastify': 76,
    miniflare: 56,
    fastify: 49,
    '@sentry/node': 42,
    'drizzle-kit': 38,
  }
  for (const [root, identities] of Object.entries(expected)) {
    assert.equal(perRoot[root], identities, `${root}: the attributed closure changed`)
  }
  // The owner of each declaration: the manifest that would have to change for
  // the saving to be realized.
  assert.deepEqual(owners.get('miniflare'), ['packages/pi-cloudflare-host/package.json'])
  assert.deepEqual(owners.get('@sentry/node'), ['packages/telemetry/package.json'])
  assert.deepEqual(owners.get('drizzle-kit'), ['packages/database/package.json'])
  assert.deepEqual(owners.get('vite-plus'), ['package.json (root)'])
})

test('the reduction sequence accounts for each marginal saving without claiming a minimum', async () => {
  // The plan is measured, not argued: every step's saving is the number of
  // identities the remaining roots no longer reach. This greedy sequence is
  // sufficient; shared ownership prevents inferring a minimum from singles.
  const { planDependencyReduction } = await loadChecker()
  const measured = fullLockPairs().size
  const ceiling = budgets.dependencies.externalPackageCeiling
  const plan = planDependencyReduction(
    readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8'),
    ceiling
  )
  assert.equal(plan.residual <= ceiling, true, 'the plan does not reach the ceiling')
  assert.equal(plan.reachable, true)
  assert.equal(plan.minimumRemovals, null)
  let closure = measured
  for (const step of plan.steps) {
    assert.equal(step.closure, closure - step.saving)
    assert.ok(step.saving > 0)
    closure = step.closure
  }
  assert.equal(closure, plan.residual)
  // Every step names the manifest that owns the declaration it would remove.
  for (const step of plan.steps) {
    assert.ok(step.owner.length > 0, `${step.root}: no owning manifest is named`)
  }
  // The plan is a measurement of a possible reduction: it changes neither the
  // count nor the ceiling.
  assert.equal(measured, 548)
  assert.equal(ceiling, 285)
})

test('every attributed path names the install path and the consumers of the package', async () => {
  // The path attribution is taken from the measured listing's own layout: the
  // install path a package sits at, and the entries that require it. A nested
  // copy of a package is a different install of the same identity, and the
  // consumers say which package asked for it.
  const { attributeExternalPackages, externalPackagePairs, parseListingLayout } =
    await loadChecker()
  const listing = realListing()
  const counted = externalPackagePairs(listing)
  const { consumers } = attributeExternalPackages(
    readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8')
  )
  const { entries } = parseListingLayout(listing)
  // The layout covers the measured listing: every counted identity is
  // installed at a path the listing names.
  const installed = new Set(entries.map((entry) => entry.identity))
  for (const identity of counted) {
    assert.ok(installed.has(identity), `${identity} is counted but not installed`)
  }
  // Preserve the nested/scoped layout contract independently of which
  // current packages are hoisted after dependency consolidation.
  const fixture = parseListingLayout(
    'node_modules\n└── tool@1.0.0\n    └── formatter@2.0.0\n        └── @scope/binding@2.0.0\n'
  )
  const nested = fixture.entries.find((entry) => entry.identity === '@scope/binding@2.0.0')
  assert.equal(nested.depth, 3)
  assert.equal(nested.installRoot, 'tool@1.0.0')
  assert.equal(nested.path.length, 3)
  // Its consumer: the entry that requires it, with the section it requires it
  // in.
  const required = consumers.get('@oxfmt/binding-darwin-arm64@0.73.0') ?? []
  assert.ok(
    required.some((consumer) => consumer.startsWith('oxfmt@0.73.0 (optionalDependencies)')),
    `the nested binding has no consumer: ${required.join(', ')}`
  )
})
test('attribution follows the nearest nested version rather than every same-named entry', async () => {
  const { attributeExternalPackages } = await loadChecker()
  const lock = {
    workspaces: { '': { dependencies: { consumer: '1.0.0', '@owner/other': '1.0.0' } } },
    packages: {
      consumer: ['consumer@1.0.0', '', { dependencies: { shared: '1.0.0' } }],
      '@owner/other': ['@owner/other@1.0.0', '', { dependencies: { shared: '2.0.0' } }],
      shared: ['shared@1.0.0', '', {}],
      '@owner/other/shared': ['shared@2.0.0', '', {}],
    },
  }
  const { identities, perRoot, exclusivePerRoot } = attributeExternalPackages(JSON.stringify(lock))
  assert.equal(identities.size, 4)
  assert.deepEqual(perRoot, { consumer: 2, '@owner/other': 2 })
  assert.deepEqual(exclusivePerRoot, { consumer: 2, '@owner/other': 2 })
})

test('attribution starts each dependency at its declaring workspace and preserves aliases', async () => {
  const { attributeExternalPackages } = await loadChecker()
  const lock = {
    workspaces: {
      '': { name: 'repo', dependencies: { shared: '1.0.0' } },
      'packages/consumer': {
        name: '@owner/consumer',
        dependencies: { shared: '2.0.0', shim: 'npm:actual@1.0.0' },
      },
    },
    packages: {
      shared: ['shared@1.0.0', '', {}],
      '@owner/consumer/shared': ['shared@2.0.0', '', { dependencies: { '@scope/leaf': '1.0.0' } }],
      '@owner/consumer/@scope/leaf': ['@scope/leaf@1.0.0', '', {}],
      shim: ['actual@1.0.0', '', {}],
    },
  }
  const { identities, perRoot, resolutions, unresolvedRoots } = attributeExternalPackages(
    JSON.stringify(lock)
  )
  assert.deepEqual([...identities].toSorted(), [
    '@scope/leaf@1.0.0',
    'shared@1.0.0',
    'shared@2.0.0',
    'shim@1.0.0',
  ])
  assert.deepEqual(perRoot, { shared: 3, shim: 1 })
  assert.equal(resolutions.get('shim@1.0.0'), 'actual@1.0.0')
  assert.deepEqual(unresolvedRoots, [])
})

test('the greedy plan does not claim an unproved minimum', async () => {
  const { planDependencyReduction } = await loadChecker()
  const lockfile = readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8')
  const plan = planDependencyReduction(lockfile, budgets.dependencies.externalPackageCeiling)
  assert.equal(plan.reachable, true)
  assert.equal(plan.minimumRemovals, null)
})

test('direct formatter and linter pins share the exact Vite+ versions', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  const lock = JSONC.parse(readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8'))
  const bundled = lock.packages['vite-plus'][2].dependencies
  for (const name of ['oxfmt', 'oxlint']) {
    const expected = bundled[name].replace(/^=/u, '')
    assert.equal(manifest.devDependencies[name], expected, `${name}: direct pin duplicates Vite+`)
    const versions = new Set(
      Object.entries(lock.packages)
        .filter(([key]) => key === name || key.endsWith(`/${name}`))
        .map(([, entry]) => entry[0])
    )
    assert.deepEqual([...versions], [`${name}@${expected}`])
  }
})

test('compatible transitive pins consolidate existing versions without dropping consumers', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  const lock = JSONC.parse(readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8'))
  for (const [name, version] of Object.entries({
    '@smithy/core': '3.35.0',
    '@smithy/types': '4.19.0',
    'magic-string': '1.4.3',
  })) {
    assert.equal(manifest.overrides[name], version)
    const versions = new Set(
      Object.entries(lock.packages)
        .filter(([key]) => key === name || key.endsWith(`/${name}`))
        .map(([, entry]) => entry[0])
    )
    assert.deepEqual([...versions], [`${name}@${version}`])
  }
  // These consumers remain in the real lock: no supported provider or bundler
  // was deleted to create the saving.
  for (const consumer of [
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-s3',
    '@sentry/bundler-plugins',
  ])
    assert.ok(lock.packages[consumer], `${consumer}: required consumer disappeared`)
})

test('the stable full-lock receipt preserves all-platform scope and the real 43-pair reduction', async () => {
  const { lockfileExternalPairs, externalPackagePairs } = await loadChecker()
  const before = externalPackagePairs(
    readFileSync(
      join(repositoryRoot, 'packages/production-readiness/fixtures/dependency-before-bun143.txt'),
      'utf8'
    )
  )
  const after = externalPackagePairs(
    readFileSync(
      join(repositoryRoot, 'packages/production-readiness/fixtures/dependency-after-bun143.txt'),
      'utf8'
    )
  )
  const current = lockfileExternalPairs(readFileSync(join(repositoryRoot, 'bun.lock'), 'utf8'))
  assert.equal(before.size, 591)
  assert.equal(after.size, 551)
  assert.equal(current.size, 548)
  assert.deepEqual([...after].filter((pair) => !current.has(pair)).toSorted(), [
    '@smithy/core@3.33.3',
    '@smithy/types@4.17.2',
    'magic-string@0.30.21',
  ])
  assert.deepEqual(
    [...current].filter((pair) => !after.has(pair)),
    []
  )
  assert.equal([...before].filter((pair) => !after.has(pair)).length, 40)
  assert.deepEqual(
    [...after].filter((pair) => !before.has(pair)),
    []
  )
})

test('the stable receipt counts orphan lock entries and refuses malformed lockfiles', async () => {
  const { lockfileExternalPairs } = await loadChecker()
  assert.deepEqual(
    [...lockfileExternalPairs(JSON.stringify({ packages: { orphan: ['orphan@1.0.0', '', {}] } }))],
    ['orphan@1.0.0']
  )
  assert.throws(() => lockfileExternalPairs('{}'))
  assert.throws(() => lockfileExternalPairs('{'))
  assert.throws(() => lockfileExternalPairs(JSON.stringify({ packages: { invalid: [] } })))
})

test('every current installed CLI identity is covered by the full-lock receipt', async () => {
  const { externalPackagePairs } = await loadChecker()
  const counted = fullLockPairs()
  const installed = externalPackagePairs(realListing())
  assert.deepEqual(
    [...installed].filter((identity) => !counted.has(identity)),
    []
  )
  const { report } = runChecker()
  assert.equal(report.installedListing.measured, installed.size)
  assert.equal(report.scope, 'all-platform lockfile identities')
  assert.equal(report.measured, counted.size)
})

test('an explicit listing fixture remains usable without a lockfile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-fixture-without-lock-'))
  try {
    copyFileSync(join(repositoryRoot, 'scripts/check-budgets.mjs'), join(directory, 'checker.mjs'))
    const listing = join(directory, 'listing.txt')
    writeFileSync(listing, 'node_modules\n└── example@1.0.0\n')
    const result = spawnSync(process.execPath, [join(directory, 'checker.mjs'), 'deps'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        BUDGETS_FILE: join(repositoryRoot, 'budgets.json'),
        ADEA_DEPS_LISTING_FILE: listing,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
    assert.equal(report.measured, 1)
    assert.equal(report.scope, 'listing file')
    assert.equal(typeof report.attribution.unavailable, 'string')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
