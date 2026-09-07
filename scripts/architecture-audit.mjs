import { JSONC } from 'bun'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const profilePorts = {
  cloud: {
    coordination: 'not-composed',
    discovery: 'PostgresRuntimeDiscoveryRepository',
    objectStore: 'R2ObjectStore',
    observability: 'packages/telemetry',
    persistence: 'PostgreSQL/Neon repositories',
    processes: 'Railway service lifecycle',
    runtimeTransport: 'DisabledCloudRuntime or CloudCertificationRuntime',
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
    workflow: 'Local Restate',
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
              }).sort()
              const developmentDependencies = Object.keys(manifest.devDependencies ?? {}).sort()
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
    .sort((left, right) => left.name.localeCompare(right.name))
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
    .sort((left, right) => left.operation.localeCompare(right.operation))
  const openApi = JSON.parse(
    await readFile(resolve(root, 'packages/control-sdk/openapi/control-plane.v2.json'), 'utf8')
  )
  const openapiOperations = Object.entries(openApi.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        path,
        method: method.toUpperCase(),
        operationId: operation.operationId,
        responseStatuses: Object.keys(operation.responses ?? {}).sort(),
        secured: Array.isArray(operation.security) && operation.security.length > 0,
        hasRequestSchema:
          operation.requestBody?.content?.['application/json']?.schema !== undefined,
      }))
    )
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
  const controllerFiles = (await walk(resolve(root, 'apps/control-api/src'))).filter((path) =>
    path.endsWith('.controller.ts')
  )
  const controllerPaths = (
    await Promise.all(controllerFiles.map((path) => discoverControllerPaths(path)))
  )
    .flat()
    .sort()
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
    controllerPaths,
    profileSourceDigests,
  }
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
  const packageByName = new Map(discoveredPackages.map((entry) => [entry.name, entry]))
  for (const entry of discoveredPackages.filter(({ layer }) => layer === 'core-port')) {
    for (const dependency of entry.workspaceDependencies) {
      if (packageByName.get(dependency)?.layer === 'adapter-infrastructure') {
        errors.push(`${entry.name}: core package depends on adapter ${dependency}`)
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
  const actualProfiles = (audit.profiles ?? []).map(({ id }) => id).sort()
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
    if (JSON.stringify(Object.keys(profile.ports ?? {}).sort()) !== JSON.stringify(portIds)) {
      errors.push(`${profile.id}: infrastructure port inventory is incomplete`)
    }
    if (JSON.stringify(profile.ports) !== JSON.stringify(profilePorts[profile.id])) {
      errors.push(`${profile.id}: infrastructure port bindings drifted`)
    }
    if (profile.sourceDigest !== discovered.profileSourceDigests[profile.id]) {
      errors.push(`${profile.id}: composition source digest drifted`)
    }
  }
  const parityIds = (audit.persistenceParity ?? []).map(({ id }) => id).sort()
  if (JSON.stringify(parityIds) !== JSON.stringify(persistenceIds)) {
    errors.push('persistence parity inventory drifted')
  }
  const actualCompatibility = (audit.compatibilityMatrix ?? []).map(({ id }) => id).sort()
  if (JSON.stringify(actualCompatibility) !== JSON.stringify(compatibilityIds)) {
    errors.push('compatibility matrix inventory drifted')
  }
  const actualOwnership = (audit.ownership ?? []).map(({ entity }) => entity).sort()
  if (JSON.stringify(actualOwnership) !== JSON.stringify(ownershipEntities)) {
    errors.push('ownership inventory drifted')
  }
  const actualLifecycle = (audit.lifecycleCoverage ?? []).map(({ concern }) => concern).sort()
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
      JSON.stringify(Object.keys(operation.trace ?? {}).sort()) !==
      JSON.stringify([...traceStages].sort())
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
  return { errors, warnings }
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
  return typeof exports === 'string' ? ['.'] : Object.keys(exports).sort()
}

async function discoverControllerPaths(path) {
  const source = await readFile(path, 'utf8')
  const controller = source.match(/@Controller\(\{([^}]+)\}\)/s)?.[1] ?? ''
  const version = controller.match(/version:\s*'([^']+)'/)?.[1]
  const base = controller.match(/path:\s*'([^']+)'/)?.[1] ?? ''
  if (version === undefined) return []
  return [...source.matchAll(/@Post\('([^']+)'\)/g)].map(
    (match) => `/${['v' + version, base, match[1]].filter(Boolean).join('/')}`
  )
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
  for (const path of [...paths].sort()) {
    digest.update(path)
    digest.update('\0')
    digest.update(await readFile(resolve(root, path)))
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

function discoverPublicOperations(discovered) {
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
      controllerReachable: discovered.controllerPaths.includes(operation.path),
    }
  })
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
  for (const evidence of row.evidence) {
    if (!evidence.kind || !evidence.path) {
      errors.push(`${row.id}: evidence kind and path are required`)
      continue
    }
    try {
      await access(resolve(root, evidence.path))
    } catch {
      errors.push(`${row.id}: evidence path does not exist: ${evidence.path}`)
    }
  }
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
