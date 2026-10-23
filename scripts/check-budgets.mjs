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
 * The install layout of a `bun pm ls --all` listing: every entry with the
 * install path it sits at and the entry that holds it.
 *
 * The listing is a tree — an entry is printed under the entry that installs
 * it — so the depth of a line is the depth of its install path. `bun pm ls`
 * prints the package name under its parent, so the path is the chain of the
 * parents' identities, not a path in the listing's text.
 *
 * This is the layout of the **measured** input: the paths it reports are the
 * ones the installation actually uses.
 *
 * @param {string} lsOutput the output of `bun pm ls --all`
 * @returns {{ entries: Array<{identity: string, name: string, version: string, depth: number, parent: string|undefined, path: string[], installRoot: string|undefined}>, byIdentity: Map<string, object> }}
 */
export function parseListingLayout(lsOutput) {
  const entries = []
  const stack = []
  for (const line of lsOutput.split('\n')) {
    const match = line.match(/^((?:[│ ]   )*)(?:├── |└── )(.*)$/)
    if (match === null) continue
    const identity = match[2].trim()
    if (identity === '') continue
    const at = identity.lastIndexOf('@')
    if (at <= 0) continue
    const depth = match[1].length / 4 + 1
    stack.length = depth - 1
    const parent = depth >= 2 ? stack[depth - 2] : undefined
    stack[depth - 1] = identity
    const path = stack.slice(0, depth)
    entries.push({
      identity,
      name: identity.slice(0, at),
      version: identity.slice(at + 1),
      depth,
      parent,
      path,
      installRoot: path[0],
    })
  }
  return {
    entries,
    byIdentity: new Map(entries.map((entry) => [entry.identity, entry])),
  }
}

/**
 * The lockfile's dependency graph: its entries, the declared roots, the
 * manifest that owns each declaration, and the walk that reaches the external
 * identities from those roots.
 *
 * The walk is the one the attribution and the reduction plan share, so the
 * per-root numbers, the savings and the plan are measured on the same graph.
 */
function lockfileGraph(lockfileText) {
  const lock = JSONC.parse(lockfileText)
  const entries = new Map()
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    entries.set(key, {
      spec: Array.isArray(value) ? value[0] : value,
      meta:
        Array.isArray(value) && typeof value[2] === 'object' && value[2] !== null ? value[2] : {},
    })
  }
  // Resolve the nearest ancestor copy, including scoped package ancestors.
  // An unrelated nested copy never supplies a missing dependency.
  const providerOf = (parentKey, name) => {
    let ancestor = parentKey
    while (ancestor !== '') {
      const nested = `${ancestor}/${name}`
      if (entries.has(nested)) return nested
      ancestor = ancestor.replace(/(?:^|\/)(?:@[^/]+\/)?[^/]+$/u, '')
    }
    return entries.has(name) ? name : undefined
  }
  const rootProviders = new Map()
  const declaredRoots = []
  const owners = new Map()
  for (const [path, workspace] of Object.entries(lock.workspaces ?? {})) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(workspace[section] ?? {})) {
        declaredRoots.push(name)
        // Preserve each workspace's resolution before grouping roots by name.
        const provider = providerOf(workspace.name ?? '', name)
        if (!rootProviders.has(name)) rootProviders.set(name, new Set())
        if (provider !== undefined) rootProviders.get(name).add(provider)
        // The manifest that declares the root: the owner of the declaration,
        // and so of the identities removing it would shed.
        const list = owners.get(name) ?? []
        list.push(path === '' ? 'package.json (root)' : `${path}/package.json`)
        owners.set(name, list)
      }
    }
  }
  const roots = [...new Set(declaredRoots)]
  const identityOf = (key) => {
    const { spec } = entries.get(key)
    const at = spec.lastIndexOf('@')
    return `${normalizePackageName(key)}@${spec.slice(at + 1)}`
  }
  // The external identities the declared roots reach. A root resolves to the
  // hoisted copy of its name — the copy its manifest's range selects — and
  // every edge resolves to the entry that provides it.
  const closureOf = (rootNames) => {
    const identities = new Set()
    const resolutions = new Map()
    const visited = new Set()
    const queue = []
    const unresolved = []
    for (const root of new Set(rootNames)) {
      const keys = rootProviders.get(root) ?? new Set()
      if (keys.size === 0) {
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
      const identity = identityOf(key)
      if (!identity.startsWith('@control-plane/')) {
        identities.add(identity)
        // An alias entry names the package it resolves to, so the measured
        // identity can be traced to the package that is actually installed.
        resolutions.set(identity, spec)
      }
      const optionalPeers = new Set(meta.optionalPeers ?? [])
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of Object.keys(meta[section] ?? {})) {
          if (section === 'peerDependencies' && optionalPeers.has(name)) continue
          const child = providerOf(key, name)
          if (child !== undefined) queue.push(child)
        }
      }
    }
    return { identities, resolutions, unresolved }
  }
  return { entries, roots, owners, providerOf, identityOf, closureOf }
}

/**
 * The attribution of the measured closure: the external identities the
 * lockfile's graph reaches from the declared roots, how much each root
 * contributes, and what removing a root would actually shed.
 *
 * The attribution answers "which dependency brings this package in", so a
 * breach can be routed to the slice that owns the manifest instead of being
 * an unattributed count. It never changes the measurement: the counted
 * identities come from the listing, and this only explains them.
 *
 * Two rules make the attribution mean what it says:
 *
 * - **An edge resolves to the entry that provides it.** A dependency is
 *   satisfied by the copy installed under the requiring package, or by the
 *   hoisted copy when there is none. Resolving a dependency name to *every*
 *   entry that carries it would attribute a package's whole closure — every
 *   version of it — to each root that names it, and would report the same
 *   number for roots that share their dependencies.
 * - **An optional peer is not an edge that keeps a package installed.** A peer
 *   listed in `optionalPeers` is satisfied only when something else provides
 *   it, so it cannot hold a package in the tree on its own. It is still
 *   recorded as a consumer.
 *
 * @param {string} lockfileText the contents of `bun.lock`
 * @returns {{ identities: Set<string>, perRoot: Record<string, number>, owners: Map<string, string[]>, removalSavings: Record<string, number>, exclusivePerRoot: Record<string, number>, consumers: Map<string, string[]>, resolutions: Map<string, string>, unresolvedRoots: string[] }}
 */
export function attributeExternalPackages(lockfileText) {
  const { entries, roots, owners, providerOf, identityOf, closureOf } = lockfileGraph(lockfileText)
  const perRoot = {}
  const closures = new Map()
  for (const root of roots) {
    const { identities: rootIdentities } = closureOf([root])
    closures.set(root, rootIdentities)
    if (rootIdentities.size > 0) perRoot[root] = rootIdentities.size
  }
  // The exact offenders: the identities only one declared root brings in. A
  // dependency several roots share cannot be shed by dropping one of them, so
  // the exclusive part is what an owner could actually remove.
  const identityOwners = new Map()
  for (const [root, rootIdentities] of closures) {
    for (const identity of rootIdentities) {
      if (!identityOwners.has(identity)) identityOwners.set(identity, [])
      identityOwners.get(identity).push(root)
    }
  }
  const exclusivePerRoot = {}
  for (const [root, rootIdentities] of closures) {
    const exclusive = [...rootIdentities].filter(
      (identity) => identityOwners.get(identity).length === 1
    )
    if (exclusive.length > 0) exclusivePerRoot[root] = exclusive.length
  }
  // What removing a root would shed: the identities the remaining roots no
  // longer reach. This is the saving an owner can count on, and it is the
  // measure the reduction plan is built from.
  const all = closureOf(roots)
  const removalSavings = {}
  for (const root of roots) {
    if (all.identities.size === 0) break
    const remaining = closureOf(roots.filter((name) => name !== root))
    const saving = all.identities.size - remaining.identities.size
    if (saving > 0) removalSavings[root] = saving
  }
  // The consumers of every identity: the entries that name it, and the
  // section they name it in. An optional peer is a consumer too, but it is
  // not an edge, so it never keeps a package in the tree.
  const consumers = new Map()
  for (const [key, { meta }] of entries) {
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(meta[section] ?? {})) {
        const consumer = identityOf(key)
        if (consumer.startsWith('@control-plane/')) continue
        const required = !(
          section === 'peerDependencies' && (meta.optionalPeers ?? []).includes(name)
        )
        const provider = providerOf(key, name)
        if (provider === undefined) continue
        const identity = identityOf(provider)
        if (identity.startsWith('@control-plane/')) continue
        const list = consumers.get(identity) ?? []
        list.push(required ? `${consumer} (${section})` : `${consumer} (optional peer)`)
        consumers.set(identity, list)
      }
    }
  }
  return {
    identities: all.identities,
    perRoot,
    owners,
    removalSavings,
    exclusivePerRoot,
    consumers,
    resolutions: all.resolutions,
    unresolvedRoots: all.unresolved,
  }
}

/**
 * The measured reduction plan: the declared roots whose removal brings the
 * measured closure down to the ceiling, and what each removal saves.
 *
 * The plan is **measured, not argued**: every step's saving is the number of
 * identities the remaining roots no longer reach once that root is gone, so
 * the plan accounts for the identities several roots share instead of
 * counting them once per root.
 *
 * This greedy plan establishes a sufficient sequence, not the minimum.
 * Shared identities can disappear only after several roots are removed, so
 * summing individual savings cannot bound the saving of a combined removal.
 *
 * The plan is a *measurement of a possible reduction*. It changes nothing:
 * the ceiling, the count and the verdict are computed before it, and the
 * plan is only reported.
 *
 * @param {string} lockfileText the contents of `bun.lock`
 * @param {number} ceiling the committed ceiling the plan is measured against
 * @returns {{ steps: Array<{root: string, saving: number, closure: number}>, residual: number, reachable: boolean, minimumRemovals: number|null, overageUpperBound: number }}
 */
export function planDependencyReduction(lockfileText, ceiling) {
  const { roots, owners, closureOf } = lockfileGraph(lockfileText)
  const measured = closureOf(roots).identities.size
  const overage = Math.max(0, measured - ceiling)
  // The plan itself: remove the root with the largest marginal saving until
  // the closure is at or below the ceiling.
  const steps = []
  let remainingRoots = [...roots]
  let closure = measured
  while (closure > ceiling && steps.length < roots.length) {
    let best = null
    for (const root of remainingRoots) {
      const size = closureOf(remainingRoots.filter((name) => name !== root)).identities.size
      if (best === null || size < best.size) best = { root, size }
    }
    if (best === null) break
    const saving = closure - best.size
    if (saving <= 0) break
    steps.push({
      root: best.root,
      saving,
      closure: best.size,
      owner: owners.get(best.root) ?? [],
    })
    remainingRoots = remainingRoots.filter((name) => name !== best.root)
    closure = best.size
  }
  return {
    steps,
    residual: closure,
    reachable: closure <= ceiling,
    minimumRemovals: measured <= ceiling ? 0 : null,
    overageUpperBound: overage,
  }
}

/**
 * The install layout of the measured listing, reduced to what a report
 * carries: how the measured identities are installed, and the consumers each
 * one has.
 *
 * The layout is the **measured** input's own layout, so the paths it reports
 * are the ones the installation uses. The consumers come from the lockfile:
 * they are the entries that name an identity, which is the only place the
 * requirement edges are recorded.
 */
export function summarizeInstallLayout(listingText, consumers) {
  const { entries, byIdentity } = parseListingLayout(listingText)
  const external = entries.filter((entry) => !entry.name.startsWith('@control-plane/'))
  const nested = external.filter((entry) => entry.depth > 1)
  const roots = new Map()
  for (const entry of external) {
    const root = entry.installRoot ?? entry.identity
    roots.set(root, (roots.get(root) ?? 0) + 1)
  }
  const samples = nested.slice(0, 5).map((entry) => ({
    identity: entry.identity,
    installPath: entry.path.join(' > '),
    consumers: (consumers?.get(entry.identity) ?? []).slice(0, 3),
  }))
  return {
    entries: external.length,
    nestedEntries: nested.length,
    installRoots: roots.size,
    largestInstallRoots: Object.fromEntries(
      [...roots].toSorted((left, right) => right[1] - left[1]).slice(0, 5)
    ),
    nestedSamples: samples,
    byIdentity,
  }
}

/**
 * The attribution of a measured closure, reduced to what a report carries:
 * the reachable identities, the roots that contribute the most, what removing
 * a root would shed, and the measured residual. A lockfile that cannot be
 * read is reported as an absent attribution, never as an empty one.
 */
export function summarizeAttribution(lockfileText, listingText, ceiling) {
  try {
    const {
      identities,
      perRoot,
      removalSavings,
      exclusivePerRoot,
      consumers,
      resolutions,
      unresolvedRoots,
    } = attributeExternalPackages(lockfileText)
    const roots = Object.entries(perRoot).toSorted((left, right) => right[1] - left[1])
    const offenders = Object.entries(removalSavings).toSorted((left, right) => right[1] - left[1])
    const aliases = Object.fromEntries(
      [...resolutions].filter(([identity, resolved]) => resolved !== identity)
    )
    const plan = ceiling === undefined ? undefined : planDependencyReduction(lockfileText, ceiling)
    return {
      reachableIdentities: identities.size,
      declaredRootCount: Object.keys(perRoot).length,
      largestContributors: Object.fromEntries(roots.slice(0, 10)),
      // The exact offenders: what removing each declared root would shed, so an
      // owner can see what dropping that dependency would actually save.
      largestOffenders: Object.fromEntries(offenders.slice(0, 10)),
      // The exclusive share of every root, for comparison with the saving:
      // the two agree when the attribution resolves every edge to the entry
      // that provides it.
      exclusiveShareTotal: Object.values(exclusivePerRoot).reduce((sum, count) => sum + count, 0),
      removalSavingTotal: Object.values(removalSavings).reduce((sum, count) => sum + count, 0),
      aliasedIdentities: Object.keys(aliases).length,
      aliases,
      unresolvedRoots,
      ...(plan === undefined ? {} : { reductionPlan: plan }),
      ...(listingText === undefined
        ? {}
        : { installLayout: summarizeInstallLayout(listingText, consumers) }),
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
      // in how much of the closure, and what removing a root would shed. It is
      // read from the lockfile and never changes the measurement or the
      // verdict.
      let attribution
      try {
        attribution = summarizeAttribution(
          await readFile(new URL('../bun.lock', import.meta.url), 'utf8'),
          listing,
          budgets.dependencies.externalPackageCeiling
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
