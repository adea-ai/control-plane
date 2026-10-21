import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { JSONC } from 'bun'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const budgetFile = resolveBudgetFile()
const usage =
  'usage: check-budgets.mjs [lane --group <unit|e2e|smoke|build> --seconds <n> | dist | deps]'

function resolveBudgetFile() {
  if (process.env.BUDGETS_FILE !== undefined) return process.env.BUDGETS_FILE
  return new URL('../budgets.json', import.meta.url)
}

export function parseBudgets(raw) {
  const budgets = JSON.parse(raw)
  if (budgets.schemaVersion !== 1)
    throw new Error(`unsupported budgets schemaVersion: ${String(budgets.schemaVersion)}`)
  return budgets
}

export function checkLaneBudget(budgets, group, measuredSeconds) {
  const lane = budgets.lanes?.[group]
  if (lane === undefined) throw new Error(`no lane budget for group: ${group}`)
  return {
    ok: measuredSeconds <= lane.ceilingSeconds,
    ceiling: lane.ceilingSeconds,
    baseline: lane.baselineSeconds,
    measured: measuredSeconds,
  }
}

async function totalDistBytes() {
  let total = 0
  for (const sourceRoot of ['packages', 'apps']) {
    const root = new URL(`../${sourceRoot}/`, import.meta.url)
    let entries
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const result = spawnSync('du', ['-sk', new URL(`${entry}/dist/`, root).pathname], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
      if (result.status === 0) {
        total += Number.parseInt(result.stdout.split('\t')[0] ?? '0', 10)
      }
    }
  }
  return total * 1024
}

export function checkDistBudget(budgets, totalBytes) {
  const ceilingBytes = budgets.dist.totalMbCeiling * 1024 * 1024
  return {
    ok: totalBytes <= ceilingBytes,
    ceilingMb: budgets.dist.totalMbCeiling,
    measuredMb: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
  }
}

/**
 * The package name of a tree entry, without the install path it is nested
 * under.
 *
 * `bun pm ls --all` prints a tree entry under its parent, so an entry is
 * normally already a plain package name (`@oxlint/binding-darwin-arm64`).
 * An install path can still reach the counter — the lockfile nests a
 * conflicting version under its parent, and the nested path is
 * `vite-plus/oxlint/@oxlint/binding-darwin-arm64` — so the trailing scope is
 * kept and the path is dropped: the package is
 * `@oxlint/binding-darwin-arm64` and that is what the closure counts.
 */
export function normalizePackageName(raw) {
  const segments = String(raw).trim().split('/')
  if (segments.length >= 2 && segments[segments.length - 2].startsWith('@'))
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
  return segments[segments.length - 1]
}

/**
 * The number of distinct external `package@version` pairs in a
 * `bun pm ls --all` listing.
 *
 * The listing is the **lockfile's** dependency tree (`bun pm ls` lists the
 * tree "according to the current lockfile"), so it also carries the optional
 * platform-specific binaries of every supported platform, not only the ones
 * installed on the host that runs the measurement. The name is normalized
 * before it is counted: the same package installed under two paths is one
 * package, and a nested scoped package is counted rather than dropped.
 */
export function externalPackagePairs(lsOutput) {
  const external = new Set()
  for (const line of lsOutput.split('\n')) {
    const match = line.match(/^(?:[│├└─\s]*)(.*)@([^@\s]+)$/)
    if (match === null) continue
    const name = normalizePackageName(match[1])
    if (name === '') continue
    if (name.startsWith('@control-plane/')) continue
    external.add(`${name}@${match[2]}`)
  }
  return external
}

export function countExternalPackages(lsOutput) {
  return externalPackagePairs(lsOutput).size
}

/**
 * The attribution of the measured closure: the external identities the
 * lockfile's graph reaches from the declared roots, and how much each root
 * contributes.
 *
 * The attribution answers "which dependency brings this package in", so a
 * breach can be routed to the slice that owns the manifest instead of being
 * an unattributed count. It never changes the measurement: the counted
 * identities come from the listing, and this only explains them.
 *
 * @param {string} lockfileText the contents of `bun.lock`
 * @returns {{ identities: Set<string>, perRoot: Record<string, number>, unresolvedRoots: string[] }}
 */
export function attributeExternalPackages(lockfileText) {
  const lock = JSONC.parse(lockfileText)
  const entries = new Map()
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    entries.set(key, {
      spec: Array.isArray(value) ? value[0] : value,
      meta: Array.isArray(value) ? (value[2] ?? {}) : {},
    })
  }
  const byBaseName = new Map()
  for (const key of entries.keys()) {
    const base = normalizePackageName(key)
    if (!byBaseName.has(base)) byBaseName.set(base, [])
    byBaseName.get(base).push(key)
  }
  const declaredRoots = []
  for (const workspace of Object.values(lock.workspaces ?? {})) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(workspace[section] ?? {})) declaredRoots.push(name)
    }
  }
  const closureOf = (rootNames) => {
    const identities = new Set()
    const resolutions = new Map()
    const visited = new Set()
    const queue = []
    const unresolved = []
    for (const root of new Set(rootNames)) {
      const keys = byBaseName.get(root)
      if (!keys?.length) {
        unresolved.push(root)
        continue
      }
      queue.push(...keys)
    }
    while (queue.length > 0) {
      const key = queue.pop()
      if (visited.has(key)) continue
      visited.add(key)
      const { spec, meta } = entries.get(key)
      const at = spec.lastIndexOf('@')
      const identity = `${normalizePackageName(key)}@${spec.slice(at + 1)}`
      if (!identity.startsWith('@control-plane/')) {
        identities.add(identity)
        // An alias entry names the package it resolves to, so the measured
        // identity can be traced to the package that is actually installed.
        resolutions.set(identity, spec)
      }
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of Object.keys(meta[section] ?? {})) {
          for (const child of byBaseName.get(name) ?? []) queue.push(child)
        }
      }
    }
    return { identities, resolutions, unresolved }
  }
  const perRoot = {}
  for (const root of new Set(declaredRoots)) {
    const { identities } = closureOf([root])
    if (identities.size > 0) perRoot[root] = identities.size
  }
  const { identities, resolutions, unresolved } = closureOf(declaredRoots)
  return { identities, perRoot, resolutions, unresolvedRoots: unresolved }
}

/**
 * The attribution of a measured closure, reduced to what a report carries:
 * the reachable identities and the roots that contribute the most. A
 * lockfile that cannot be read is reported as an absent attribution, never as
 * an empty one.
 */
export function summarizeAttribution(lockfileText) {
  try {
    const { identities, perRoot, resolutions, unresolvedRoots } =
      attributeExternalPackages(lockfileText)
    const roots = Object.entries(perRoot).toSorted((left, right) => right[1] - left[1])
    const aliases = Object.fromEntries(
      [...resolutions].filter(([identity, resolved]) => resolved !== identity)
    )
    return {
      reachableIdentities: identities.size,
      declaredRootCount: Object.keys(perRoot).length,
      largestContributors: Object.fromEntries(roots.slice(0, 10)),
      aliasedIdentities: Object.keys(aliases).length,
      aliases,
      unresolvedRoots,
    }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) }
  }
}

export function checkDependencyBudget(budgets, externalCount) {
  const ceiling = budgets.dependencies.externalPackageCeiling
  return {
    ok: externalCount <= ceiling,
    ceiling,
    measured: externalCount,
  }
}

function report(check) {
  const status = check.ok ? 'OK' : 'BUDGET EXCEEDED'
  console.log(`${status}: ${JSON.stringify(check)}`)
  if (!check.ok) process.exitCode = 1
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const budgets = parseBudgets(await readFile(budgetFile, 'utf8'))
  if (command === 'lane') {
    const group = args[args.indexOf('--group') + 1]
    const seconds = Number(args[args.indexOf('--seconds') + 1])
    if (group === undefined || !Number.isFinite(seconds)) {
      console.error(usage)
      process.exitCode = 2
    } else {
      report(checkLaneBudget(budgets, group, seconds))
    }
  } else if (command === 'dist') {
    report(checkDistBudget(budgets, await totalDistBytes()))
  } else if (command === 'deps') {
    // The listing seam: when ADEA_DEPS_LISTING_FILE names a file, that
    // listing is measured instead of the lockfile's dependency tree, and the
    // counted package identities are reported with it. It exists so the
    // measurement can be exercised on explicit fixtures; the seam changes
    // the measurement's input, not its scope: the repository's measured
    // scope is the lockfile's dependency tree, which carries the optional
    // platform-specific binaries of every supported platform.
    const listingFile = process.env.ADEA_DEPS_LISTING_FILE
    let listing
    if (listingFile !== undefined && listingFile !== '') {
      try {
        listing = await readFile(listingFile, 'utf8')
      } catch (error) {
        console.error(`failed to read the dependency listing: ${error.message}`)
        process.exitCode = 1
        listing = undefined
      }
    } else {
      const result = spawnSync('bun', ['pm', 'ls', '--all'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
      if (result.error !== undefined || result.status !== 0) {
        console.error('failed to enumerate dependencies via bun pm ls --all')
        process.exitCode = 1
      } else {
        listing = result.stdout ?? ''
      }
    }
    if (listing !== undefined) {
      const pairs = [...externalPackagePairs(listing)].toSorted()
      const check = checkDependencyBudget(budgets, pairs.length)
      // The attribution explains the measured count: which declared root pulls
      // in how much of the closure. It is read from the lockfile and never
      // changes the measurement or the verdict.
      let attribution
      try {
        attribution = summarizeAttribution(
          await readFile(new URL('../bun.lock', import.meta.url), 'utf8')
        )
      } catch (error) {
        attribution = { unavailable: error instanceof Error ? error.message : String(error) }
      }
      if (listingFile !== undefined && listingFile !== '')
        report({ ...check, pairs, scope: 'listing file', attribution })
      else report({ ...check, scope: 'lockfile tree', attribution })
    }
  } else {
    console.error(usage)
    process.exitCode = 2
  }
}
