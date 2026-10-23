import { JSONC } from 'bun'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript6'
import {
  canonicalJsonStringify,
  compareCodePointOrder,
} from '../packages/contracts/src/canonical-json.ts'

function formatMarkdown(text) {
  const result = spawnSync(
    'bun',
    [
      'x',
      'oxfmt',
      '--stdin-filepath',
      'report.md',
      '--config',
      resolve(repositoryRoot, '.oxfmtrc.json'),
    ],
    { input: text, encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`oxfmt markdown formatting failed: ${result.stderr}`)
  return result.stdout
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const auditPath = resolve(repositoryRoot, 'docs/architecture/control-plane-architecture.v1.json')
const reportPath = resolve(repositoryRoot, 'docs/architecture/control-plane-architecture.md')
const classifications = new Set(['verified', 'partially_verified', 'not_implemented', 'superseded'])
const profileIds = ['cloud', 'hosted-server', 'hosted-simple', 'local']
const portIds = [
  'coordination',
  'discovery',
  'objectStore',
  'observability',
  'persistence',
  'processes',
  'runtimeTransport',
  'secrets',
  'workflow',
]
const compatibilityIds = [
  'COMPAT-CODEOWNERS',
  'COMPAT-CONTEXT-COMPILER-REACHABILITY',
  'COMPAT-CORTANA-ADAPTER-REACHABILITY',
  'COMPAT-DEPENDENCY-DIRECTION',
  'COMPAT-DOCUMENTATION',
  'COMPAT-EXPORTS',
  'COMPAT-PACKAGE-LOCK',
  'COMPAT-POSTGRES-MIGRATIONS',
  'COMPAT-PUBLIC-OPERATIONS',
  'COMPAT-RUNTIME-MATRIX',
  'COMPAT-SQLITE-SCHEMA',
]
const persistenceIds = [
  'PERSIST-BACKUP-RESTORE',
  'PERSIST-CATALOG',
  'PERSIST-COMMAND-INBOX',
  'PERSIST-CONTEXT-PACKAGE',
  'PERSIST-EXECUTION',
  'PERSIST-EXECUTION-PLAN',
  'PERSIST-MIGRATIONS',
  'PERSIST-OUTBOX-EVENTS',
  'PERSIST-PROJECT-STATE',
  'PERSIST-RECONCILIATION',
  'PERSIST-RETENTION',
  'PERSIST-RUNTIME-COMMANDS',
]
const ownershipEntities = [
  'AgentProfile/Skill',
  'Artifact',
  'ContextPackage',
  'ContextProvider/MemoryWriteProposal',
  'Execution/Attempt',
  'ExecutionPlan',
  'ProjectState',
  'RuntimeConnection/ExternalSession',
  'Tool/Model/Sandbox',
  'Usage/Evaluation',
  'events',
]
const lifecycleConcerns = [
  'approval-and-interaction',
  'cancellation-and-timeout',
  'idempotency-and-inbox',
  'immutable-pinning',
  'outbox-and-event-delivery',
  'reconciliation-and-restart',
  'retention-and-deletion',
  'state-machine-and-cas',
]
const traceStages = ['auth', 'service', 'persistence', 'execution', 'delivery', 'cleanup']
// Every HTTP verb the Control API can bind. Path-item keys that are not verbs
// (`parameters`, `summary`, `description`, ...) are OpenAPI documentation, not
// operations, and must never be discovered as public operations.
const httpMethods = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put']
const controllerDecorators = ['All', 'Delete', 'Get', 'Head', 'Options', 'Patch', 'Post', 'Put']
// Sources that decide which Control API capability bindings a profile composes.
// These are the entrypoint/composition files that assemble the API options; the
// per-profile digest list is deliberately separate because the canonical audit
// pins its own digests (that list is W1-owned and must not move under this audit).
const profileBindingSources = {
  cloud: ['apps/control-api/src/index.ts', 'apps/control-api/src/cloud-composition.ts'],
  'hosted-server': [
    'apps/hosted-control-plane/src/index.ts',
    'apps/hosted-control-plane/src/composition.ts',
  ],
  'hosted-simple': [
    'apps/local-control-plane/src/index.ts',
    'apps/local-control-plane/src/composition.ts',
  ],
  local: ['apps/local-control-plane/src/index.ts', 'apps/local-control-plane/src/composition.ts'],
}
const profilePorts = {
  cloud: {
    coordination: 'not-composed',
    discovery: 'PostgresRuntimeDiscoveryRepository',
    objectStore: 'R2ObjectStore',
    observability: 'packages/telemetry',
    persistence: 'PostgreSQL repositories',
    processes: 'Railway service lifecycle',
    runtimeTransport:
      'DisabledCloudRuntime, CloudCertificationRuntime, or explicit DurableRemoteWorkflowRuntime',
    secrets: 'Railway environment; no SecretsProvider',
    workflow: 'Restate',
  },
  'hosted-server': {
    coordination: 'LocalCoordinationProvider',
    discovery: 'StaticServiceDiscovery',
    objectStore: 'FilesystemObjectStore or injected S3-compatible ObjectStore',
    observability: 'BufferedObservabilityProvider',
    persistence: 'PostgreSQL repositories',
    processes: 'NodeProcessRuntimeProvider',
    runtimeTransport:
      'DurableRemoteWorkflowRuntime over PostgreSQL RuntimeCommand and discovery repositories',
    secrets: 'Composite environment/private-file SecretsProvider',
    workflow: 'Remote Restate',
  },
  'hosted-simple': {
    coordination: 'LocalCoordinationProvider',
    discovery: 'StaticServiceDiscovery',
    objectStore: 'FilesystemObjectStore',
    observability: 'BufferedObservabilityProvider',
    persistence: 'SqlitePersistenceProvider',
    processes: 'NodeProcessRuntimeProvider',
    runtimeTransport:
      'Packaged ManagedPiProcessClient or injected DirectRuntimeActivityPort; unavailable acceptance otherwise',
    secrets: 'Composite environment/private-file SecretsProvider',
    workflow: 'Local Restate',
  },
  local: {
    coordination: 'LocalCoordinationProvider',
    discovery: 'StaticServiceDiscovery',
    objectStore: 'FilesystemObjectStore',
    observability: 'BufferedObservabilityProvider',
    persistence: 'SqlitePersistenceProvider',
    processes: 'NodeProcessRuntimeProvider',
    runtimeTransport:
      'Packaged ManagedPiProcessClient or injected DirectRuntimeActivityPort; unavailable acceptance otherwise',
    secrets: 'Composite environment/private-file SecretsProvider',
    workflow: 'embedded SQLite queue (default Local); Restate only when explicitly selected',
  },
}

export async function discoverArchitecture(rootUrl = new URL('..', import.meta.url)) {
  const root = fileURLToPath(rootUrl)
  const lock = JSONC.parse(await readFile(resolve(root, 'bun.lock'), 'utf8'))
  const releaseManifest = JSON.parse(
    await readFile(resolve(root, '.release-please-manifest.json'), 'utf8')
  )
  const packages = (
    await Promise.all(
      ['apps', 'packages'].map(async (kind) => {
        const entries = await readdir(resolve(root, kind), { withFileTypes: true })
        return Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              const path = `${kind}/${entry.name}`
              const manifest = JSON.parse(
                await readFile(resolve(root, path, 'package.json'), 'utf8')
              )
              const dependencies = Object.keys({
                ...manifest.dependencies,
                ...manifest.optionalDependencies,
                ...manifest.peerDependencies,
              }).toSorted()
              const developmentDependencies = Object.keys(manifest.devDependencies ?? {}).toSorted()
              return {
                name: manifest.name,
                path,
                version: manifest.version,
                lockVersion: lock.workspaces[path]?.version ?? null,
                kind: kind === 'apps' ? 'application' : 'package',
                private: manifest.private === true,
                browser: manifest.browser ?? null,
                exports: exportKeys(manifest.exports),
                workspaceDependencies: dependencies.filter((name) =>
                  name.startsWith('@control-plane/')
                ),
                externalDependencies: dependencies.filter(
                  (name) => !name.startsWith('@control-plane/')
                ),
                developmentWorkspaceDependencies: developmentDependencies.filter((name) =>
                  name.startsWith('@control-plane/')
                ),
                developmentExternalDependencies: developmentDependencies.filter(
                  (name) => !name.startsWith('@control-plane/')
                ),
              }
            })
        )
      })
    )
  )
    .flat()
    .toSorted((left, right) => compareCodePointOrder(left.name, right.name))
  const { ControlApiOperations } = await import(
    pathToFileURL(resolve(root, 'packages/control-sdk/src/operations.ts')).href
  )
  const sdkOperations = Object.entries(ControlApiOperations)
    .map(([name, value]) => ({
      name,
      operation: value.operation,
      method: value.method,
      path: value.path,
    }))
    .toSorted((left, right) => compareCodePointOrder(left.operation, right.operation))
  const { PublicContractManifest } = await import(
    pathToFileURL(resolve(root, 'packages/contracts/src/versioning.ts')).href
  )
  const openApi = JSON.parse(
    await readFile(
      resolve(
        root,
        `packages/control-sdk/openapi/control-plane.v${PublicContractManifest.current.major}.json`
      ),
      'utf8'
    )
  )
  const openapiOperations = Object.entries(openApi.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([method]) => httpMethods.includes(method.toLowerCase()))
        .map(([method, operation]) => ({
          path,
          method: method.toUpperCase(),
          operationId: operation.operationId,
          responseStatuses: Object.keys(operation.responses ?? {}).toSorted(),
          secured: Array.isArray(operation.security) && operation.security.length > 0,
          hasRequestSchema:
            operation.requestBody?.content?.['application/json']?.schema !== undefined,
        }))
    )
    .toSorted(
      (left, right) =>
        compareCodePointOrder(left.operationId ?? '', right.operationId ?? '') ||
        compareCodePointOrder(left.path, right.path) ||
        compareCodePointOrder(left.method, right.method)
    )
  const versioning = await discoverVersioningDefaults(root)
  const controllerRoutes = await discoverControllerRoutes(root, versioning)
  const capabilityBindings = await discoverCapabilityBindings(root)
  const migrationInventory = await discoverMigrationInventory(root)
  const profileSourceDigests = Object.fromEntries(
    await Promise.all(
      [
        [
          'cloud',
          [
            'apps/control-api/src/cloud-composition.ts',
            'apps/workflow-worker/src/cloud-composition.ts',
          ],
        ],
        ['local', ['apps/local-control-plane/src/composition.ts']],
        ['hosted-simple', ['apps/local-control-plane/src/composition.ts']],
        ['hosted-server', ['apps/hosted-control-plane/src/composition.ts']],
      ].map(async ([profile, paths]) => [profile, await digestFiles(root, paths)])
    )
  )
  return {
    packages,
    releaseManifest,
    sdkOperations,
    openapiOperations,
    controllerRoutes,
    capabilityBindings,
    migrationInventory,
    profileSourceDigests,
  }
}

/**
 * Compares the PostgreSQL migration SQL files against the Drizzle journal by
 * tag. Equal counts do not make a registry consistent: a renamed or replaced
 * file leaves the counts equal while the two sides name different migrations.
 *
 * `missingFromJournal` are SQL files with no journal entry, `orphanJournalTags`
 * are journal entries with no SQL file, `duplicateJournalTags` are tags the
 * journal lists more than once, and `untaggedJournalEntries` are the positions
 * of journal entries that carry no usable tag.
 */
export function compareMigrationRegistry(sqlTags, journalTags) {
  const sql = new Set(sqlTags)
  const tagged = journalTags.filter((tag) => tag !== null)
  const journal = new Set(tagged)
  return {
    missingFromJournal: [...sql].filter((tag) => !journal.has(tag)).toSorted(),
    orphanJournalTags: [...journal].filter((tag) => !sql.has(tag)).toSorted(),
    duplicateJournalTags: [
      ...new Set(tagged.filter((tag, index) => tagged.indexOf(tag) !== index)),
    ].toSorted(),
    untaggedJournalEntries: journalTags.flatMap((tag, index) => (tag === null ? [index] : [])),
  }
}

/**
 * Measures the migration registry of both persistence dialects.
 *
 * The canonical audit states migration and schema figures in prose. Measuring
 * them here keeps the next re-baseline on recorded numbers instead of
 * remembered ones, and catches a PostgreSQL registry whose SQL files and
 * Drizzle journal disagree.
 */
export async function discoverMigrationInventory(root) {
  const drizzleDirectory = resolve(root, 'packages/database/drizzle')
  const sqlFiles = (await readdir(drizzleDirectory))
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
  const journal = JSONC.parse(
    await readFile(resolve(drizzleDirectory, 'meta/_journal.json'), 'utf8')
  )
  const journalEntries = Array.isArray(journal?.entries) ? journal.entries : []
  const sqliteSource = await readFile(
    resolve(root, 'packages/sqlite-persistence/src/migrations.ts'),
    'utf8'
  )
  const sqliteVersions = [...sqliteSource.matchAll(/\{\s*version:\s*(\d+),\s*statements:/g)].map(
    (match) => Number(match[1])
  )
  return {
    postgres: {
      sqlFiles: sqlFiles.length,
      lastSqlFile: sqlFiles.at(-1) ?? null,
      journalEntries: journalEntries.length,
      lastJournalTag: journalEntries.at(-1)?.tag ?? null,
      // The full tag lists, so the registry is compared by identity and not
      // only by count: two registries of equal size can still disagree.
      sqlTags: sqlFiles.map((name) => name.slice(0, -'.sql'.length)),
      journalTags: journalEntries.map((entry) =>
        typeof entry?.tag === 'string' && entry.tag.length > 0 ? entry.tag : null
      ),
    },
    sqlite: {
      schemaVersion: sqliteVersions.length === 0 ? null : Math.max(...sqliteVersions),
      versions: sqliteVersions,
    },
  }
}

/**
 * Discovers the Control API capability bindings that exist only as a default.
 *
 * Every optional capability the Control API module accepts has a default
 * provider. When that default is an `Unavailable*`, `Disabled*` or `Empty*`
 * implementation, the capability is a disabled binding: a composition that
 * does not supply its own implementation serves a route that always refuses.
 * Those are the dead ends the reachability audit has to surface.
 */
export async function discoverCapabilityBindings(root) {
  const modulePath = 'apps/control-api/src/app.module.ts'
  const source = await readFile(resolve(root, modulePath), 'utf8')
  const defaults = [...source.matchAll(/options\.(\w+)\s*\?\?\s*new\s+(\w+)\s*\(/g)].map(
    (match) => ({
      option: match[1],
      implementation: match[2],
      disabled: /^(Unavailable|Disabled|Empty)/.test(match[2]),
    })
  )
  const uniqueDefaults = [
    ...new Map(defaults.map((entry) => [entry.option, entry])).values(),
  ].toSorted((left, right) => compareCodePointOrder(left.option, right.option))
  // Each source file is parsed once and answers for every capability, so the
  // scan stays a single pass over the profile's composition sources. The parse
  // is memoised per file identity (size and modification time), so repeated
  // discovery in one process does not re-parse the tree, and an edited file is
  // always re-read.
  const profiles = {}
  for (const [profile, paths] of Object.entries(profileBindingSources)) {
    const sources = []
    for (const path of paths) {
      sources.push(await parsedBindingSites(root, path))
    }
    const bound = uniqueDefaults
      .filter((entry) =>
        sources.some((sites) => {
          const matching = sites.get(entry.option)
          return matching !== undefined && matching.some((site) => !site.isUndefined)
        })
      )
      .map((entry) => entry.option)
      .toSorted()
    profiles[profile] = {
      bound,
      // A capability the profile never binds is served by the Control API from
      // its unavailable default, so the route exists and always refuses.
      unbound: uniqueDefaults
        .filter((entry) => entry.disabled && !bound.includes(entry.option))
        .map((entry) => entry.option)
        .toSorted(),
    }
  }
  return { defaults: uniqueDefaults, profiles }
}

/**
 * Parsed binding sites per source file.
 *
 * The entry is keyed by the canonical target path and validated by the
 * content hash, so two checkout roots never share an entry and an edited file
 * is always re-parsed.
 *
 * Keying by the relative path and comparing size and modification time is not
 * enough: two checkout roots can hold the same relative path with the same
 * size and timestamp and different contents, and the second root would then
 * reuse the first root's parse.
 */
const parsedSourceCache = new Map()

async function parsedBindingSites(root, path) {
  const target = resolve(root, path)
  let text = ''
  try {
    text = await readFile(target, 'utf8')
  } catch {
    text = ''
  }
  const identity = createHash('sha256').update(text).digest('hex')
  const key = await canonicalTargetPath(target)
  const cached = parsedSourceCache.get(key)
  if (cached !== undefined && cached.identity === identity) return cached.sites
  const sites = allBindingSites(parseModule(text))
  parsedSourceCache.set(key, { identity, sites })
  return sites
}

/** The canonical path of a source file, used as the cache key. */
async function canonicalTargetPath(target) {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

/**
 * Conservative source scan for a capability binding.
 *
 * A capability counts as bound only when the source contains a runtime object
 * literal that assigns it: a property assignment with a real value, or a
 * shorthand property whose value is not `undefined`.
 *
 * A name that appears only in a comment, only in a type-only declaration (an
 * interface member, a `type` alias, a class property signature) or in a
 * binding whose value is explicitly `undefined` is not a binding. The
 * capability is then served by the Control API from its unavailable default,
 * and reading it as a binding would conceal that missing default.
 *
 * The scan uses the TypeScript parser instead of a regular expression so the
 * language itself decides what is code, what is a type and what is a comment.
 */
export function bindsCapabilityOption(source, option) {
  for (const parsed of [parseModule(source), parseExpression(source)]) {
    if (parsed === undefined) continue
    const sites = allBindingSites(parsed).get(option)
    if (sites !== undefined && sites.some((site) => !site.isUndefined)) return true
  }
  return false
}

function parseModule(source) {
  return ts.createSourceFile(
    'capability-binding.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  )
}

/**
 * Parses a source that is a single expression, such as a bare object literal.
 * A source that is not one expression (a type declaration, a statement list, a
 * comment) is rejected instead of repaired, so it can never contribute a
 * binding that is not really there.
 */
function parseExpression(source) {
  const parsed = ts.createSourceFile(
    'capability-binding.ts',
    `const __capability_binding__ = (\n${source}\n)`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  )
  return parsed.parseDiagnostics.length > 0 ? undefined : parsed
}

/** Every runtime object-literal site that assigns a name, with its value state. */
function allBindingSites(parsed) {
  const declarations = variableDeclarations(parsed)
  const sites = new Map()
  const record = (name, site) => {
    const existing = sites.get(name)
    if (existing === undefined) sites.set(name, [site])
    else existing.push(site)
  }
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          record(property.name.text, {
            kind: 'shorthand',
            isUndefined: shorthandIsUndefined(property, declarations),
          })
          continue
        }
        if (!ts.isPropertyAssignment(property)) continue
        const name = property.name
        const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
        if (key === undefined) continue
        record(key, { kind: 'property', isUndefined: isUndefinedExpression(property.initializer) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return sites
}

/** The first declaration of each variable in the source, keyed by name. */
function variableDeclarations(parsed) {
  const declarations = new Map()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (!declarations.has(node.name.text)) declarations.set(node.name.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return declarations
}

/**
 * A shorthand property binds the variable it names. It binds `undefined` only
 * when that variable is declared as `undefined` in the same source; a variable
 * the source does not declare (a parameter, an import) is treated as a
 * binding, because its runtime value is unknown rather than absent.
 */
function shorthandIsUndefined(property, declarations) {
  const declaration = declarations.get(property.name.text)
  if (declaration === undefined) return false
  return declaration.initializer !== undefined && isUndefinedExpression(declaration.initializer)
}

/** True when the expression can only ever produce `undefined`. */
function isUndefinedExpression(node) {
  if (ts.isIdentifier(node)) return node.text === 'undefined'
  if (ts.isVoidExpression(node)) return true
  if (ts.isParenthesizedExpression(node)) return isUndefinedExpression(node.expression)
  if (ts.isConditionalExpression(node)) {
    return isUndefinedExpression(node.whenTrue) && isUndefinedExpression(node.whenFalse)
  }
  return false
}

export async function validateArchitectureAudit(audit, options = {}) {
  const errors = []
  const warnings = []
  const rootUrl = options.repositoryRoot ?? new URL('..', import.meta.url)
  const root = fileURLToPath(rootUrl)
  const discovered = options.discovered ?? (await discoverArchitecture(rootUrl))
  if (audit.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (!/^[0-9a-f]{40}$/.test(audit.candidate?.commit ?? '')) {
    errors.push('candidate.commit must be a full Git commit')
  } else {
    const candidate = spawnSync('git', ['cat-file', '-e', `${audit.candidate.commit}^{commit}`], {
      cwd: root,
    })
    if (candidate.status !== 0) {
      const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: root,
        encoding: 'utf8',
      })
      if (shallow.status === 0 && shallow.stdout.trim() === 'true') {
        warnings.push(
          `candidate commit ${audit.candidate.commit} is unavailable in this shallow checkout; architecture provenance must be reproduced from a full clone`
        )
      } else {
        errors.push('candidate.commit must exist')
      }
    }
  }
  const discoveredPackages = discovered.packages.map((entry) => ({
    ...entry,
    layer: packageLayer(entry),
  }))
  // Package versions are owned by Release Please: every version-bump PR would
  // otherwise read as architecture drift and no release could ever pass these
  // gates. Structural drift is still detected exactly; version consistency
  // between workspaces and the release manifest is covered by the check below.
  const structural = (entries) =>
    entries.map((entry) => {
      const copy = { ...entry }
      delete copy.version
      delete copy.lockVersion
      return copy
    })
  if (
    JSON.stringify(structural(audit.packages)) !== JSON.stringify(structural(discoveredPackages))
  ) {
    errors.push('package inventory drifted from workspace manifests')
  }
  if (
    discoveredPackages.some(({ path, version }) => discovered.releaseManifest?.[path] !== version)
  ) {
    errors.push('workspace package versions drifted from release-please manifest')
  }
  // The lockfile records each workspace's own version. A recorded version that
  // lags the manifest means the lockfile metadata no longer describes the
  // workspace it locks, and no other gate compares the two.
  const lockDrift = discoveredPackages
    .filter(({ version, lockVersion }) => lockVersion !== null && lockVersion !== version)
    .map(({ path, version, lockVersion }) => `${path} ${version}/${lockVersion}`)
    .toSorted()
  if (lockDrift.length > 0) {
    warnings.push(
      `workspace package versions drifted from the Bun lockfile: ${lockDrift.join(', ')}`
    )
  }
  const packageByName = new Map(discoveredPackages.map((entry) => [entry.name, entry]))
  for (const entry of discoveredPackages.filter(({ layer }) => layer === 'core-port')) {
    for (const dependency of entry.workspaceDependencies) {
      if (packageByName.get(dependency)?.layer === 'adapter-infrastructure') {
        errors.push(`${entry.name}: core package depends on adapter ${dependency}`)
      }
    }
    // The workspace half of the inward rule above cannot see a deployment
    // implementation that a core package requires directly, so the external half
    // is checked here. A development dependency is not shipped and is not
    // checked.
    for (const dependency of entry.externalDependencies) {
      if (deploymentImplementationPackages.has(dependency)) {
        errors.push(
          `${entry.name}: core package depends on deployment implementation ${dependency}`
        )
      }
    }
  }
  if (dependencyCycles(discoveredPackages).length > 0) {
    errors.push('workspace runtime dependency graph contains a cycle')
  }
  const operationDiscovery = discoverPublicOperations(discovered)
  const auditedOperations = (audit.operations ?? []).map(
    ({
      name,
      operation,
      method,
      path,
      inOpenApi,
      openApiOperationId,
      openApiResponseStatuses,
      openApiSecured,
      openApiHasRequestSchema,
      controllerReachable,
    }) => ({
      name,
      operation,
      method,
      path,
      inOpenApi,
      openApiOperationId,
      openApiResponseStatuses,
      openApiSecured,
      openApiHasRequestSchema,
      controllerReachable,
    })
  )
  if (JSON.stringify(auditedOperations) !== JSON.stringify(operationDiscovery)) {
    errors.push('operation inventory drifted from SDK declarations')
  }
  const actualProfiles = (audit.profiles ?? []).map(({ id }) => id).toSorted()
  if (JSON.stringify(actualProfiles) !== JSON.stringify(profileIds)) {
    errors.push('profiles must contain cloud, local, hosted-simple, and hosted-server')
  }
  for (const profile of audit.profiles ?? []) {
    requireFields(errors, profile, [
      'id',
      'entrypoint',
      'compositionRoot',
      'classification',
      'assessment',
      'ports',
      'sourceDigest',
      'evidence',
    ])
    if (JSON.stringify(Object.keys(profile.ports ?? {}).toSorted()) !== JSON.stringify(portIds)) {
      errors.push(`${profile.id}: infrastructure port inventory is incomplete`)
    }
    // The port map is a map, not a list: JSON key order carries no meaning, so a
    // reordered-but-identical binding map must not read as drift.
    if (
      canonicalJsonStringify(profile.ports ?? {}) !==
      canonicalJsonStringify(profilePorts[profile.id] ?? {})
    ) {
      errors.push(`${profile.id}: infrastructure port bindings drifted`)
    }
    if (profile.sourceDigest !== discovered.profileSourceDigests[profile.id]) {
      errors.push(`${profile.id}: composition source digest drifted`)
    }
  }
  const parityIds = (audit.persistenceParity ?? []).map(({ id }) => id).toSorted()
  if (JSON.stringify(parityIds) !== JSON.stringify(persistenceIds)) {
    errors.push('persistence parity inventory drifted')
  }
  // The canonical audit carries both the parity rows and a flat inventory of
  // their identifiers. The inventory was previously unvalidated dead data; it
  // must agree with the rows it summarises.
  if (Array.isArray(audit.persistenceParityInventory)) {
    if (
      canonicalJsonStringify([...audit.persistenceParityInventory].toSorted()) !==
      canonicalJsonStringify(parityIds)
    ) {
      errors.push('persistence parity inventory drifted from the persistence parity rows')
    }
  }
  const actualCompatibility = (audit.compatibilityMatrix ?? []).map(({ id }) => id).toSorted()
  if (JSON.stringify(actualCompatibility) !== JSON.stringify(compatibilityIds)) {
    errors.push('compatibility matrix inventory drifted')
  }
  const actualOwnership = (audit.ownership ?? []).map(({ entity }) => entity).toSorted()
  if (JSON.stringify(actualOwnership) !== JSON.stringify(ownershipEntities)) {
    errors.push('ownership inventory drifted')
  }
  const actualLifecycle = (audit.lifecycleCoverage ?? []).map(({ concern }) => concern).toSorted()
  if (JSON.stringify(actualLifecycle) !== JSON.stringify(lifecycleConcerns)) {
    errors.push('lifecycle inventory drifted')
  }
  for (const row of [
    ...(audit.operations ?? []),
    ...(audit.profiles ?? []),
    ...(audit.persistenceParity ?? []),
    ...(audit.compatibilityMatrix ?? []),
  ]) {
    validateClassifiedRow(errors, row)
    await validateEvidence(errors, row, root)
  }
  for (const row of audit.ownership ?? []) {
    requireFields(errors, row, ['id', 'entity', 'authority', 'boundary', 'evidence'])
    await validateEvidence(errors, row, root)
  }
  for (const row of audit.lifecycleCoverage ?? []) {
    requireFields(errors, row, ['id', 'concern', 'assessment', 'evidence'])
    await validateEvidence(errors, row, root)
  }
  for (const operation of audit.operations ?? []) {
    requireFields(errors, operation, ['trace', 'assessment'])
    if (
      JSON.stringify(Object.keys(operation.trace ?? {}).toSorted()) !==
      JSON.stringify([...traceStages].toSorted())
    ) {
      errors.push(`${operation.id}: operation trace stages are incomplete`)
    }
    if (
      !operation.inOpenApi ||
      operation.openApiOperationId !== operation.operation ||
      !operation.openApiSecured ||
      !operation.openApiHasRequestSchema ||
      operation.openApiResponseStatuses.length === 0
    ) {
      errors.push(`${operation.id}: SDK and OpenAPI method/schema/security metadata drifted`)
    }
    if (operation.classification === 'verified' && !operation.controllerReachable) {
      errors.push(`${operation.id}: verified operation must have a reachable controller`)
    }
  }
  const ids = [
    ...(audit.operations ?? []),
    ...(audit.profiles ?? []),
    ...(audit.persistenceParity ?? []),
    ...(audit.compatibilityMatrix ?? []),
    ...(audit.ownership ?? []),
    ...(audit.lifecycleCoverage ?? []),
  ].map(({ id }) => id)
  if (new Set(ids).size !== ids.length) errors.push('audit row IDs must be unique')
  reportContractSurface(errors, warnings, discovered)
  return { errors, warnings }
}

/**
 * Cross-checks the three public-contract surfaces against each other.
 *
 * The SDK declares the public operations, the OpenAPI artifact publishes them,
 * and the Control API controllers serve them. The SDK is the source of truth:
 * an OpenAPI operation with no SDK binding is a published contract that no
 * client can call, and a served route with no SDK binding is a public
 * operation the reachability audit cannot trace.
 */
function reportContractSurface(errors, warnings, discovered) {
  const sdkRoutes = discovered.sdkOperations.map((operation) => ({
    method: operation.method,
    path: operation.path,
  }))
  const servedBySdk = (method, path) => sdkRoutes.some((entry) => routeMatches(entry, method, path))
  for (const operation of discovered.openapiOperations) {
    // A path-item key that is not an HTTP verb is OpenAPI documentation, not an
    // operation, and can never be an unbound public operation.
    if (!httpMethods.includes(operation.method.toLowerCase())) continue
    if (!servedBySdk(operation.method, operation.path)) {
      errors.push(
        `OpenAPI advertises an operation with no SDK binding: ${operation.method} ${operation.path}`
      )
    }
  }
  const unboundRoutes = (discovered.controllerRoutes ?? []).filter(
    (route) => !servedBySdk(route.method, route.path)
  )
  if (unboundRoutes.length > 0) {
    warnings.push(
      `Control API serves ${unboundRoutes.length} HTTP route(s) with no SDK operation binding: ${unboundRoutes
        .map((route) => `${route.method} ${route.path}`)
        .join(', ')}`
    )
  }
  const disabled = discovered.capabilityBindings?.defaults.filter((entry) => entry.disabled) ?? []
  if (disabled.length > 0) {
    warnings.push(
      `Control API exposes ${disabled.length} capability binding(s) that default to an unavailable implementation: ${disabled
        .map((entry) => entry.option)
        .join(', ')}`
    )
  }
  for (const [profile, bindings] of Object.entries(discovered.capabilityBindings?.profiles ?? {})) {
    if (bindings.unbound.length > 0) {
      warnings.push(
        `${profile}: never binds ${bindings.unbound.length} capability binding(s), so the Control API serves them from an unavailable default: ${bindings.unbound.join(', ')}`
      )
    }
  }
  const digests = discovered.profileSourceDigests ?? {}
  const colliding = Object.entries(digests)
    .filter(([, digest]) => digest !== undefined)
    .filter(([profile, digest]) =>
      Object.entries(digests).some(
        ([other, otherDigest]) => other !== profile && otherDigest === digest
      )
    )
    .map(([profile]) => profile)
  if (colliding.length > 1) {
    warnings.push(
      `profiles ${colliding.join(' and ')} share one composition source digest, so a change to the source that separates them is not digest-covered`
    )
  }
  const migrations = discovered.migrationInventory
  if (migrations !== undefined) {
    const { postgres, sqlite } = migrations
    if (postgres.sqlFiles !== postgres.journalEntries) {
      errors.push(
        `PostgreSQL migration registry drifted: ${postgres.sqlFiles} SQL file(s) against ${postgres.journalEntries} Drizzle journal entr(ies)`
      )
    }
    const registry = compareMigrationRegistry(postgres.sqlTags ?? [], postgres.journalTags ?? [])
    if (registry.missingFromJournal.length > 0) {
      errors.push(
        `PostgreSQL migration registry drifted: SQL file(s) without a Drizzle journal entry: ${registry.missingFromJournal.join(', ')}`
      )
    }
    if (registry.orphanJournalTags.length > 0) {
      errors.push(
        `PostgreSQL migration registry drifted: Drizzle journal entr(ies) without a SQL file: ${registry.orphanJournalTags.join(', ')}`
      )
    }
    if (registry.duplicateJournalTags.length > 0) {
      errors.push(
        `PostgreSQL migration registry drifted: duplicate Drizzle journal tag(s): ${registry.duplicateJournalTags.join(', ')}`
      )
    }
    if (registry.untaggedJournalEntries.length > 0) {
      errors.push(
        `PostgreSQL migration registry drifted: Drizzle journal entr(ies) without a tag at position(s) ${registry.untaggedJournalEntries.join(', ')}`
      )
    }
    if (postgres.sqlFiles > 0 && sqlite.schemaVersion !== null) {
      warnings.push(
        `measured migration inventory: PostgreSQL ${postgres.sqlFiles} migration(s) up to ${postgres.lastSqlFile}, SQLite schema version ${sqlite.schemaVersion}`
      )
    }
  }
}

export async function renderArchitectureReport(audit) {
  const lines = [
    '# Control Plane architecture, contracts, persistence, and production wiring audit',
    '',
    `Generated from [control-plane-architecture.v1.json](./control-plane-architecture.v1.json) for candidate \`${audit.candidate.commit}\`. Do not edit this report directly; run \`bun run architecture:write\`.`,
    '',
    '## Audit summary',
    '',
    `- ${audit.packages.length} workspace packages and applications.`,
    `- ${audit.operations.length} public SDK operations.`,
    `- ${audit.profiles.length} deployment profiles.`,
    `- ${audit.persistenceParity.length} persistence parity boundaries.`,
    `- ${countRows(audit, 'verified')} verified, ${countRows(audit, 'partially_verified')} partially verified, ${countRows(audit, 'not_implemented')} not implemented, and ${countRows(audit, 'superseded')} superseded classified paths.`,
    '',
    '## Package dependency diagram',
    '',
    '```mermaid',
    'flowchart LR',
    ...packageDiagram(audit.packages),
    '```',
    '',
    '## Deployment composition diagram',
    '',
    '```mermaid',
    'flowchart LR',
    '  Cloud[Railway Cloud] --> Core[Shared domain / contracts / execution core]',
    '  Local[Local all-in-one] --> Core',
    '  Simple[Hosted Simple] --> Core',
    '  Server[Hosted Server] --> Core',
    '  Core --> PG[(PostgreSQL)]',
    '  Core --> SQLite[(SQLite)]',
    '  Core --> Restate[Restate]',
    '  Core --> Direct[Direct RuntimeTransport]',
    '  Core --> Gateway[Remote Runtime Gateway]',
    '  Core --> Storage[ObjectStore]',
    '```',
    '',
    '## Package inventory',
    '',
    '| Package | Manifest / lock version | Layer | Kind | Internal dependencies | External dependencies | Exports |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...audit.packages.map(
      (entry) =>
        `| \`${entry.name}\`<br>\`${entry.path}\` | ${entry.version} / ${entry.lockVersion ?? 'missing'} | ${entry.layer} | ${entry.kind} | ${formatList(entry.workspaceDependencies)} | ${formatList(entry.externalDependencies)} | ${formatList(entry.exports)} |`
    ),
    '',
    '## Public operation reachability',
    '',
    '| Operation | SDK / OpenAPI / controller | Classification | Entrypoint-to-side-effect trace | Assessment | Gap |',
    '| --- | --- | --- | --- | --- | --- |',
    ...audit.operations.map(
      (row) =>
        `| \`${row.operation}\`<br>\`${row.method} ${row.path}\` | SDK: yes<br>OpenAPI: ${yesNo(row.inOpenApi)}<br>Controller: ${yesNo(row.controllerReachable)} | ${row.classification} | ${formatTrace(row.trace)} | ${escapeCell(row.assessment)} | ${formatGap(row.gap)} |`
    ),
    '',
    '## Deployment profiles and infrastructure ports',
    '',
    '| Profile | Entrypoint / composition | Classification | Ports | Assessment | Gap |',
    '| --- | --- | --- | --- | --- | --- |',
    ...audit.profiles.map(
      (row) =>
        `| ${row.id} | \`${row.entrypoint}\`<br>\`${row.compositionRoot}\` | ${row.classification} | ${Object.entries(
          row.ports
        )
          .map(([port, adapter]) => `${port}: ${adapter}`)
          .join('<br>')} | ${escapeCell(row.assessment)} | ${formatGap(row.gap)} |`
    ),
    '',
    '## Ownership boundaries',
    '',
    '| Entity | Authority | Boundary | Evidence |',
    '| --- | --- | --- | --- |',
    ...audit.ownership.map(
      (row) =>
        `| ${row.entity} | ${escapeCell(row.authority)} | ${escapeCell(row.boundary)} | ${row.evidence.map(formatEvidence).join('<br>')} |`
    ),
    '',
    '## Contract, schema, and migration compatibility',
    '',
    '| ID | Representations | Classification | Assessment | Gap |',
    '| --- | --- | --- | --- | --- |',
    ...audit.compatibilityMatrix.map(
      (row) =>
        `| ${row.id} | ${formatList(row.representations)} | ${row.classification} | ${escapeCell(row.assessment)} | ${formatGap(row.gap)} |`
    ),
    '',
    '## Persistence parity',
    '',
    '| Boundary | PostgreSQL | SQLite | Classification | Assessment | Gap |',
    '| --- | --- | --- | --- | --- | --- |',
    ...audit.persistenceParity.map(
      (row) =>
        `| ${row.id} | ${escapeCell(row.postgresql)} | ${escapeCell(row.sqlite)} | ${row.classification} | ${escapeCell(row.assessment)} | ${formatGap(row.gap)} |`
    ),
    '',
    '## Lifecycle and concurrency coverage',
    '',
    '| Concern | Assessment | Evidence |',
    '| --- | --- | --- |',
    ...audit.lifecycleCoverage.map(
      (row) =>
        `| ${row.concern} | ${escapeCell(row.assessment)} | ${row.evidence.map(formatEvidence).join('<br>')} |`
    ),
    '',
    '## Maintenance',
    '',
    'Run `bun run architecture:check` after changing package manifests, public SDK operations, OpenAPI, controllers, composition roots, persistence adapters, or this audit. Run `bun run architecture:refresh` only after explicitly reviewing newly discovered package and operation drift.',
    '',
  ]
  return formatMarkdown(lines.join('\n'))
}

function exportKeys(exports) {
  if (exports === undefined) return []
  return typeof exports === 'string' ? ['.'] : Object.keys(exports).toSorted()
}

/**
 * Reads the Nest URI-versioning defaults the API actually serves with, so a
 * controller that does not pin its own version is resolved the same way the
 * running application resolves it instead of being dropped from discovery.
 */
export async function discoverVersioningDefaults(root) {
  const source = await readFile(resolve(root, 'apps/control-api/src/application.ts'), 'utf8')
  const defaultVersion = source.match(/defaultVersion:\s*'([^']*)'/)?.[1]
  const prefix = source.match(/prefix:\s*'([^']*)'/)?.[1]
  return {
    defaultVersion: defaultVersion ?? '1',
    prefix: prefix ?? 'v',
  }
}

/**
 * Resolves the URI segment a controller contributes. `VERSION_NEUTRAL` serves the
 * route unversioned; a pinned version serves `v<version>`; a controller without
 * a version inherits the application's default version.
 */
function controllerVersionSegment(controller, versioning) {
  if (/version:\s*VERSION_NEUTRAL\b/.test(controller)) return null
  const pinned = controller.match(/version:\s*'([^']*)'/)?.[1]
  const version = pinned ?? versioning.defaultVersion
  if (version === '' || version === 'VERSION_NEUTRAL') return null
  return `${versioning.prefix}${version}`
}

/**
 * Discovers every HTTP route the Control API controllers serve, keeping the
 * HTTP method with the path. Reachability is a method-and-path property: a
 * `GET` route never satisfies a `POST` operation.
 */
export async function discoverControllerRoutes(root, versioning) {
  const controllerFiles = (await walk(resolve(root, 'apps/control-api/src'))).filter((path) =>
    path.endsWith('.controller.ts')
  )
  const routes = (
    await Promise.all(
      controllerFiles.map(async (path) => {
        const source = await readFile(path, 'utf8')
        const controller = source.match(/@Controller\(\{([^}]*)\}\)/s)?.[1]
        if (controller === undefined) return []
        const version = controllerVersionSegment(controller, versioning)
        const base = controller.match(/path:\s*'([^']*)'/)?.[1] ?? ''
        const decorator = new RegExp(`@(${controllerDecorators.join('|')})\\('([^']*)'\\)`, 'g')
        return [...source.matchAll(decorator)].map((match) => ({
          method: match[1].toUpperCase(),
          path: `/${[version, base, match[2]].filter(Boolean).join('/')}`,
          controller: relative(root, path),
        }))
      })
    )
  )
    .flat()
    .toSorted(
      (left, right) =>
        compareCodePointOrder(left.path, right.path) ||
        compareCodePointOrder(left.method, right.method) ||
        compareCodePointOrder(left.controller, right.controller)
    )
  return routes
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name)
        return entry.isDirectory() ? walk(path) : [path]
      })
    )
  ).flat()
}

async function digestFiles(root, paths) {
  const digest = createHash('sha256')
  for (const path of [...paths].toSorted()) {
    digest.update(path)
    digest.update('\0')
    digest.update(await readFile(resolve(root, path)))
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

export function discoverPublicOperations(discovered) {
  const routes = discovered.controllerRoutes ?? []
  return discovered.sdkOperations.map((operation) => {
    const openApi = discovered.openapiOperations.find(
      (entry) => entry.path === operation.path && entry.method === operation.method
    )
    return {
      ...operation,
      inOpenApi: openApi !== undefined,
      openApiOperationId: openApi?.operationId ?? null,
      openApiResponseStatuses: openApi?.responseStatuses ?? [],
      openApiSecured: openApi?.secured ?? false,
      openApiHasRequestSchema: openApi?.hasRequestSchema ?? false,
      // Reachability is a method-and-path property: a route served under a
      // different HTTP verb does not make the operation reachable.
      controllerReachable: routes.some((route) =>
        routeMatches(route, operation.method, operation.path)
      ),
    }
  })
}

/** A route serves an operation when the path matches and the verb does too. `@All` serves every verb. */
function routeMatches(route, method, path) {
  if (route.path !== path) return false
  return route.method === 'ALL' || route.method === method
}

function dependencyCycles(packages) {
  const dependencies = new Map(
    packages.map((entry) => [
      entry.name,
      entry.workspaceDependencies.filter((dependency) =>
        packages.some((candidate) => candidate.name === dependency)
      ),
    ])
  )
  const visiting = new Set()
  const visited = new Set()
  const cycles = []

  function visit(name, path) {
    if (visiting.has(name)) {
      cycles.push([...path.slice(path.indexOf(name)), name])
      return
    }
    if (visited.has(name)) return
    visiting.add(name)
    for (const dependency of dependencies.get(name) ?? []) visit(dependency, [...path, name])
    visiting.delete(name)
    visited.add(name)
  }

  for (const name of dependencies.keys()) visit(name, [])
  return cycles
}

function validateClassifiedRow(errors, row) {
  requireFields(errors, row, ['id', 'classification', 'assessment', 'evidence'])
  if (!classifications.has(row.classification)) {
    errors.push(`${row.id}: invalid classification ${row.classification}`)
  }
  if (row.classification !== 'verified') validateGap(errors, row)
}

async function validateEvidence(errors, row, root) {
  if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
    errors.push(`${row.id}: evidence is required`)
    return
  }
  const realRoot = await canonicalRepositoryRoot(root)
  for (const evidence of row.evidence) {
    if (!evidence.kind || !evidence.path) {
      errors.push(`${row.id}: evidence kind and path are required`)
      continue
    }
    // Evidence must be a repository-relative file inside the audited checkout:
    // an absolute or escaping path could cite anything on the host, and a
    // directory is not a citable artifact.
    const reason = await evidencePathError(root, evidence.path, realRoot)
    if (reason !== undefined) {
      errors.push(`${row.id}: ${reason}: ${evidence.path}`)
    }
  }
}

/**
 * The canonical real path of the audited checkout.
 *
 * The root is compared in canonical form so a checkout that is itself reached
 * through a symlinked path does not make every in-tree path look like an
 * escape.
 */
async function canonicalRepositoryRoot(root) {
  try {
    return await realpath(root)
  } catch {
    return resolve(root)
  }
}

/**
 * Checks one evidence path against the audited checkout.
 *
 * Returns undefined when the path is a citable file inside the repository, and
 * otherwise the reason it is not.
 *
 * The repository root and the evidence target are compared as canonical real
 * paths, not as resolved paths. A lexical containment check cannot see that a
 * symlink inside the repository points outside it, and following that symlink
 * would let a path in the tree cite a file anywhere on the host. The target is
 * therefore canonicalised first, and only a canonical target inside the
 * canonical root is accepted.
 */
export async function evidencePathError(root, path, realRoot) {
  if (isAbsolute(path)) return 'evidence path must be repository-relative'
  const resolved = resolve(root, path)
  const inside = relative(root, resolved)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return 'evidence path escapes the repository'
  }
  const canonicalRoot = realRoot ?? (await canonicalRepositoryRoot(root))
  let realTarget
  try {
    realTarget = await realpath(resolved)
  } catch (error) {
    const code = error?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? 'evidence path does not exist'
      : 'evidence path could not be resolved'
  }
  const realInside = relative(canonicalRoot, realTarget)
  if (realInside === '' || realInside.startsWith('..') || isAbsolute(realInside)) {
    return 'evidence path escapes the repository'
  }
  let stats
  try {
    stats = await stat(realTarget)
  } catch {
    return 'evidence path does not exist'
  }
  return stats.isFile() ? undefined : 'evidence path is not a file'
}

function validateGap(errors, row) {
  for (const field of ['issue', 'severity', 'owner', 'disposition']) {
    if (row.gap?.[field] === undefined || row.gap[field] === '') {
      errors.push(`${row.id}: gap.${field} is required for ${row.classification}`)
    }
  }
  if (!Number.isInteger(row.gap?.issue)) errors.push(`${row.id}: gap.issue must be numeric`)
  if (!['critical', 'high', 'medium', 'low'].includes(row.gap?.severity)) {
    errors.push(`${row.id}: gap.severity is invalid`)
  }
}

function requireFields(errors, value, fields) {
  for (const field of fields) {
    if (value?.[field] === undefined || value[field] === '') {
      errors.push(`${value?.id ?? 'row'}: ${field} is required`)
    }
  }
}

function countRows(audit, classification) {
  return [
    ...audit.operations,
    ...audit.profiles,
    ...audit.persistenceParity,
    ...audit.compatibilityMatrix,
  ].filter((row) => row.classification === classification).length
}

function packageDiagram(packages) {
  const names = new Map(packages.map((entry, index) => [entry.name, `P${index}`]))
  const nodes = packages.map(
    (entry, index) => `  P${index}["${entry.name.replace('@control-plane/', '')}"]`
  )
  const edges = packages.flatMap((entry) =>
    entry.workspaceDependencies
      .filter((dependency) => names.has(dependency))
      .map((dependency) => `  ${names.get(entry.name)} --> ${names.get(dependency)}`)
  )
  return [...nodes, ...edges]
}

function formatList(values) {
  return values.length === 0 ? '—' : values.map((value) => `\`${value}\``).join('<br>')
}

function formatEvidence(evidence) {
  return `\`${evidence.path}\``
}

function formatGap(gap) {
  if (!gap) return '—'
  return `[#${gap.issue}](https://github.com/adea-ai/control-plane/issues/${gap.issue}) ${gap.severity}; ${escapeCell(gap.owner)}; ${escapeCell(gap.disposition)}`
}

function formatTrace(trace) {
  return traceStages.map((stage) => `${stage}: ${escapeCell(trace[stage])}`).join('<br>')
}

function yesNo(value) {
  return value ? 'yes' : 'no'
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

async function main() {
  let audit = JSON.parse(await readFile(auditPath, 'utf8'))
  if (process.argv.includes('--refresh')) {
    const discovered = await discoverArchitecture(new URL('..', import.meta.url))
    const operationByName = new Map(audit.operations.map((row) => [row.name, row]))
    const missing = discovered.sdkOperations.filter(({ name }) => !operationByName.has(name))
    const removed = audit.operations.filter(
      ({ name }) => !discovered.sdkOperations.some((operation) => operation.name === name)
    )
    if (missing.length > 0 || removed.length > 0) {
      throw new Error(
        `Operation drift requires explicit audit: missing [${missing.map(({ name }) => name).join(', ')}], removed [${removed.map(({ name }) => name).join(', ')}]`
      )
    }
    audit = {
      ...audit,
      packages: discovered.packages.map((entry) => ({
        ...entry,
        layer: packageLayer(entry),
      })),
      operations: discoverPublicOperations(discovered).map((operation) => ({
        ...operationByName.get(operation.name),
        ...operation,
      })),
      profiles: audit.profiles.map((profile) => ({
        ...profile,
        sourceDigest: discovered.profileSourceDigests[profile.id],
      })),
    }
    await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`)
  }
  const discovered = await discoverArchitecture(new URL('..', import.meta.url))
  const { errors, warnings } = await validateArchitectureAudit(audit, {
    repositoryRoot: new URL('..', import.meta.url),
    discovered,
  })
  for (const warning of warnings) console.warn(`Architecture audit warning: ${warning}`)
  if (errors.length > 0) throw new Error(`Architecture audit is invalid:\n- ${errors.join('\n- ')}`)
  const report = await renderArchitectureReport(audit)
  if (process.argv.includes('--write') || process.argv.includes('--refresh')) {
    await writeFile(reportPath, report)
    console.log(`Wrote ${relative(repositoryRoot, reportPath)}`)
    return
  }
  if ((await readFile(reportPath, 'utf8')) !== report) {
    throw new Error('Architecture report drifted; run bun run architecture:write')
  }
  console.log(
    `Validated ${audit.packages.length} packages, ${audit.operations.length} operations, and ${audit.profiles.length} profiles`
  )
}

// CP #187 acceptance: "No core package directly requires Neon, R2, Railway,
// Redis/Valkey, Runtime Gateway transport, OS keychain, or another deployment
// implementation." The audit proved the workspace half of that rule — a core
// package may not depend on an adapter package — but it never read a core
// package's own external dependencies, so a deployment implementation could be
// required directly by a core package and the audit still validated. Each entry
// below is the npm package that binds one of the named implementations.
// Railway is repository-owned deployment configuration rather than a package,
// so it is covered by the profile configuration rules instead.
const deploymentImplementationPackages = new Set([
  'postgres', // Neon / PostgreSQL
  '@neondatabase/serverless', // Neon serverless driver
  '@aws-sdk/client-s3', // R2 / S3-compatible object storage
  'ioredis', // Redis
  'redis', // Redis
  '@valkey/valkey-glide', // Valkey
  'keytar', // OS keychain
  '@hpke/core', // remote transport (Runtime Gateway / relay)
  '@hpke/dhkem-x25519', // remote transport (Runtime Gateway / relay)
])

function packageLayer(entry) {
  const name = basename(entry.path)
  if (entry.kind === 'application') return 'composition-root'
  if (
    [
      'contracts',
      'context',
      'config',
      'deployment',
      'domain',
      'events',
      'execution-plan',
      'orchestration',
      'policy',
      'runtime-sdk',
      'tool-sdk',
      'telemetry',
      'usage-ledger',
      'workflow-runtime',
    ].includes(name)
  ) {
    return 'core-port'
  }
  return 'adapter-infrastructure'
}

if (import.meta.main) await main()
