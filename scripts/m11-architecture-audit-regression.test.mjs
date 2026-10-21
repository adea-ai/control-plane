import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import {
  bindsCapabilityOption,
  discoverArchitecture,
  discoverCapabilityBindings,
  discoverControllerRoutes,
  discoverPublicOperations,
  discoverVersioningDefaults,
  renderArchitectureReport,
  validateArchitectureAudit,
} from './architecture-audit.mjs'

/**
 * Regression coverage for the architecture-audit tooling itself.
 *
 * The canonical audit and its generated report stay with their existing owner.
 * These checks therefore never edit them: they prove that the tooling detects
 * the drift it is supposed to detect, and that the checks stay deterministic
 * when the audited tree changes.
 *
 * This file sits next to the tool it covers because it imports
 * `scripts/architecture-audit.mjs` directly: `scripts/workspace-boundaries.mjs`
 * rejects an import that leaves a package directory, so the file cannot live
 * under `apps/` or `packages/`, and `tests/` requires lane registration that
 * this work does not own. Run it with
 * `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs`,
 * using the same timeout the repository lanes use.
 */

const repositoryRoot = new URL('..', import.meta.url)
const auditUrl = new URL('../docs/architecture/control-plane-architecture.v1.json', import.meta.url)
const reportUrl = new URL('../docs/architecture/control-plane-architecture.md', import.meta.url)
const audit = JSON.parse(await readFile(auditUrl, 'utf8'))
const clone = (value) => JSON.parse(JSON.stringify(value))

const unboundRoutes = [
  'GET /health',
  'GET /ready',
  'POST /v1/executions/admission-resume',
  'POST /v1/executions/admission-stop',
  'POST /v1/executions/tool-effects/inspect',
  'POST /v1/executions/tool-effects/reconcile',
  'POST /v1/pi-durable/management-current/assert',
  'POST /v1/system/authenticated',
  'GET /v1/system/echo',
]

const disabledCapabilityOptions = [
  'admissionControlService',
  'contextPackageResolutionService',
  'credentialAdministrationService',
  'executionAcceptanceService',
  'executionCancellationService',
  'executionValidationService',
  'graphAdministrationService',
  'interactionCommandService',
  'marketplaceInstallationService',
  'marketplaceRegistryService',
  'modelConnectionService',
  'piDurableCurrentToolAuthority',
  'piDurableLeadService',
  'profileResolutionService',
  'projectStateInitializationService',
  'projectStateResolutionService',
  'runtimeDiscoveryRepository',
  'runtimeNodeCredentialRevocationService',
  'serviceAuthenticator',
  'toolEffectRecoveryService',
  'workspaceCatalogService',
]

const unboundCapabilities = {
  cloud: ['runtimeNodeCredentialRevocationService', 'toolEffectRecoveryService'],
  'hosted-server': [
    'admissionControlService',
    'credentialAdministrationService',
    'marketplaceInstallationService',
    'marketplaceRegistryService',
    'modelConnectionService',
    'piDurableCurrentToolAuthority',
    'piDurableLeadService',
    'toolEffectRecoveryService',
  ],
  'hosted-simple': [
    'marketplaceInstallationService',
    'modelConnectionService',
    'piDurableCurrentToolAuthority',
    'piDurableLeadService',
    'runtimeNodeCredentialRevocationService',
  ],
  local: [
    'marketplaceInstallationService',
    'modelConnectionService',
    'piDurableCurrentToolAuthority',
    'piDurableLeadService',
    'runtimeNodeCredentialRevocationService',
  ],
}

describe('M11.2 architecture audit tooling regressions', () => {
  test('the canonical audit validates with no errors', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const { errors } = await validateArchitectureAudit(audit, { repositoryRoot, discovered })
    expect(errors).toEqual([])
  })

  test('the generated report stays byte-identical to the canonical audit', async () => {
    const report = await readFile(reportUrl, 'utf8')
    expect(report).toBe(await renderArchitectureReport(audit))
  })

  test('matches controller reachability on the HTTP method, not the path alone', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const operation = discovered.sdkOperations.find(
      (entry) => entry.method === 'POST' && entry.path === '/v1/authentication/verify'
    )
    expect(operation).toBeDefined()

    const wrongMethod = clone(discovered)
    wrongMethod.controllerRoutes = wrongMethod.controllerRoutes.map((route) =>
      route.path === operation.path ? { ...route, method: 'GET' } : route
    )
    const mismatched = discoverPublicOperations(wrongMethod).find(
      (entry) => entry.operation === operation.operation
    )
    expect(mismatched.controllerReachable).toBe(false)

    const sameMethod = clone(discovered)
    sameMethod.controllerRoutes = sameMethod.controllerRoutes.filter(
      (route) => route.path !== operation.path
    )
    const missing = discoverPublicOperations(sameMethod).find(
      (entry) => entry.operation === operation.operation
    )
    expect(missing.controllerReachable).toBe(false)
  })

  test('discovers every served HTTP verb, including unversioned routes', async () => {
    const versioning = await discoverVersioningDefaults(fileURLToPath(repositoryRoot))
    const routes = await discoverControllerRoutes(fileURLToPath(repositoryRoot), versioning)
    const served = new Set(routes.map((route) => `${route.method} ${route.path}`))

    expect(served.has('GET /health')).toBe(true)
    expect(served.has('GET /ready')).toBe(true)
    expect(served.has('POST /v1/authentication/verify')).toBe(true)
    expect(served.has('POST /v3/pi-durable/lead-dispatches/dispatch')).toBe(true)
    expect(served.has('GET /v1/system/echo')).toBe(true)
    // Every discovered route must be a served verb, never a documentation key.
    expect(
      routes.every((route) => typeof route.method === 'string' && route.method.length > 0)
    ).toBe(true)
    expect(routes.every((route) => route.path.startsWith('/'))).toBe(true)
  })

  test('ignores OpenAPI path-item documentation keys when discovering operations', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    expect(discovered.openapiOperations).toHaveLength(discovered.sdkOperations.length)
    expect(
      discovered.openapiOperations.every((entry) => typeof entry.operationId === 'string')
    ).toBe(true)
    expect(
      discovered.openapiOperations.every((entry) => entry.method === entry.method.toUpperCase())
    ).toBe(true)

    const withDocumentationKey = clone(discovered)
    withDocumentationKey.openapiOperations = [
      ...withDocumentationKey.openapiOperations,
      {
        path: '/v1/documentation-only',
        method: 'PARAMETERS',
        operationId: undefined,
        responseStatuses: [],
        secured: false,
        hasRequestSchema: false,
      },
    ]
    const { errors } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: withDocumentationKey,
    })
    expect(errors).toEqual([])
  })

  test('rejects an OpenAPI operation that no SDK operation binds', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const drifted = clone(discovered)
    drifted.openapiOperations = [
      ...drifted.openapiOperations,
      {
        path: '/v1/not-in-the-sdk',
        method: 'POST',
        operationId: 'not.in.the.sdk',
        responseStatuses: ['200'],
        secured: true,
        hasRequestSchema: true,
      },
    ]
    const { errors } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: drifted,
    })
    expect(errors).toContain(
      'OpenAPI advertises an operation with no SDK binding: POST /v1/not-in-the-sdk'
    )
  })

  test('treats a reordered but identical profile port map as unchanged', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const reordered = clone(audit)
    const local = reordered.profiles.find((profile) => profile.id === 'local')
    local.ports = Object.fromEntries(Object.entries(local.ports).toReversed())
    const { errors } = await validateArchitectureAudit(reordered, { repositoryRoot, discovered })
    expect(errors).not.toContain('local: infrastructure port bindings drifted')
    expect(errors).toEqual([])

    const rebinding = clone(audit)
    rebinding.profiles.find((profile) => profile.id === 'local').ports.persistence =
      'OtherPersistence'
    const drifted = await validateArchitectureAudit(rebinding, { repositoryRoot, discovered })
    expect(drifted.errors).toContain('local: infrastructure port bindings drifted')
  })

  test('rejects evidence that escapes the repository or is not a file', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    for (const [path, expected] of [
      ['../outside-the-repository.md', 'evidence path escapes the repository'],
      ['/etc/hosts', 'evidence path must be repository-relative'],
      ['docs', 'evidence path is not a file'],
      ['docs/architecture/does-not-exist.md', 'evidence path does not exist'],
    ]) {
      const changed = clone(audit)
      changed.operations[0].evidence = [{ kind: 'test', path }]
      const { errors } = await validateArchitectureAudit(changed, { repositoryRoot, discovered })
      expect(
        errors.some((error) => error.includes(expected)),
        `${path} -> ${errors.join(' | ')}`
      ).toBe(true)
    }
  })

  test('rejects a persistence parity inventory that disagrees with its rows', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const changed = clone(audit)
    changed.persistenceParityInventory = [
      ...changed.persistenceParityInventory.filter((id) => id !== 'PERSIST-CATALOG'),
      'PERSIST-NOT-A-ROW',
    ]
    const { errors } = await validateArchitectureAudit(changed, { repositoryRoot, discovered })
    expect(errors).toContain(
      'persistence parity inventory drifted from the persistence parity rows'
    )
  })

  test('surfaces every served route that has no SDK operation binding', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const { errors, warnings } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered,
    })
    expect(errors).toEqual([])
    const warning = warnings.find((entry) => entry.includes('no SDK operation binding'))
    expect(warning).toBeDefined()
    for (const route of unboundRoutes) {
      expect(warning, route).toContain(route)
    }
    expect(warning.match(/(GET|POST) /g)).toHaveLength(unboundRoutes.length)
  })

  test('pins the capability bindings that no profile ever supplies', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const bindings = await discoverCapabilityBindings(fileURLToPath(repositoryRoot))
    expect(
      bindings.defaults.filter((entry) => entry.disabled).map((entry) => entry.option)
    ).toEqual(disabledCapabilityOptions)
    for (const [profile, expected] of Object.entries(unboundCapabilities)) {
      expect(bindings.profiles[profile].unbound, profile).toEqual(expected)
      // Every capability that defaults to an unavailable implementation is
      // either bound by the profile or explicitly left at that default.
      const accounted = new Set([
        ...bindings.profiles[profile].bound,
        ...bindings.profiles[profile].unbound,
      ])
      for (const option of disabledCapabilityOptions) {
        expect(accounted.has(option), `${profile}: ${option}`).toBe(true)
      }
    }
    const { warnings } = await validateArchitectureAudit(audit, { repositoryRoot, discovered })
    expect(warnings.some((entry) => entry.includes('never binds 2 capability binding(s)'))).toBe(
      true
    )
  })

  test('does not read a type member or a member access as a capability binding', () => {
    expect(
      bindsCapabilityOption(
        'readonly executionAcceptanceService: SomeType',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption('composition.executionAcceptanceService', 'executionAcceptanceService')
    ).toBe(false)
    expect(
      bindsCapabilityOption('options.executionAcceptanceService', 'executionAcceptanceService')
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        '{\n  executionAcceptanceService: composition.x,\n}',
        'executionAcceptanceService'
      )
    ).toBe(true)
    expect(
      bindsCapabilityOption('{\n  executionAcceptanceService,\n}', 'executionAcceptanceService')
    ).toBe(true)
  })

  test('reports a profile pair that shares one composition source digest', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const { warnings } = await validateArchitectureAudit(audit, { repositoryRoot, discovered })
    const warning = warnings.find((entry) => entry.includes('share one composition source digest'))
    expect(warning).toBeDefined()
    expect(warning).toContain('hosted-simple')
    expect(warning).toContain('local')
  })

  test('reports a workspace version that the Bun lockfile does not record', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const drifted = clone(discovered)
    drifted.packages[0].lockVersion = '0.0.0-drift'
    const { warnings } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: drifted,
    })
    expect(
      warnings.some((entry) =>
        entry.includes('workspace package versions drifted from the Bun lockfile')
      )
    ).toBe(true)
  })

  test('measures the migration registry of both persistence dialects', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const { postgres, sqlite } = discovered.migrationInventory
    expect(postgres.sqlFiles).toBe(postgres.journalEntries)
    expect(postgres.sqlFiles).toBeGreaterThan(0)
    expect(postgres.lastSqlFile).toMatch(/^\d{4}_.*\.sql$/)
    expect(postgres.lastJournalTag).toMatch(/^\d{4}_.*$/)
    expect(sqlite.schemaVersion).toBe(sqlite.versions.length)
    expect(sqlite.versions).toEqual([...sqlite.versions].toSorted((left, right) => left - right))

    const { errors, warnings } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered,
    })
    expect(errors).toEqual([])
    expect(warnings.some((entry) => entry.includes('measured migration inventory'))).toBe(true)
  })

  test('rejects a PostgreSQL migration registry whose files and journal disagree', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const drifted = clone(discovered)
    drifted.migrationInventory.postgres.sqlFiles =
      drifted.migrationInventory.postgres.journalEntries + 1
    const { errors } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: drifted,
    })
    expect(errors.some((entry) => entry.includes('PostgreSQL migration registry drifted'))).toBe(
      true
    )
  })
})
