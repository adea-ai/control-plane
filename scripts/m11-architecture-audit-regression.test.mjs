import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  bindsCapabilityOption,
  discoverArchitecture,
  discoverCapabilityBindings,
  discoverControllerRoutes,
  discoverPublicOperations,
  discoverVersioningDefaults,
  evidencePathError,
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

/**
 * A synthetic repository root that contains one symlink pointing at a
 * synthetic target outside that root, one ordinary in-tree file, one symlink
 * that stays inside the root, and one symlink that cannot be resolved.
 *
 * The external target is created here and holds no real content, so the check
 * never reads a sensitive file: it only resolves paths and asks whether they
 * land inside the root.
 */
async function createEvidenceSymlinkFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-evidence-symlink-'))
  const root = join(directory, 'repository')
  const outside = join(directory, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'external-target.md'), 'synthetic external target\n')
  await writeFile(join(root, 'ordinary.md'), 'ordinary in-tree evidence\n')
  const link = join(root, 'external-target.md')
  await symlink(join(outside, 'external-target.md'), link)
  await symlink(join(root, 'ordinary.md'), join(root, 'in-tree-link.md'))
  await symlink(join(root, 'loop.md'), join(root, 'loop.md'))
  return { directory, root, link }
}

/**
 * Two synthetic checkout roots whose matching files have the same relative
 * path, the same byte length and the same modification time, but different
 * contents: the first root binds a capability, the second does not.
 *
 * The two roots therefore have to be parsed separately. A parse cache keyed by
 * the relative path would hand the second root the first root's answer.
 */
async function createTwoRootBindingFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-two-root-binding-'))
  const rootA = join(directory, 'checkout-a')
  const rootB = join(directory, 'checkout-b')
  const binds = 'const options = { executionAcceptanceService: composition.x }\n'
  const undefinedPrefix = 'const options = { executionAcceptanceService: undefined'
  const undefinedSuffix = ' }\n'
  // Pad the non-binding form so both files are exactly the same length.
  const doesNotBind = `${undefinedPrefix}${' '.repeat(
    binds.length - undefinedPrefix.length - undefinedSuffix.length
  )}${undefinedSuffix}`
  // The two files must be indistinguishable by size and timestamp.
  expect(Buffer.byteLength(binds)).toBe(Buffer.byteLength(doesNotBind))
  const timestamp = new Date('2026-10-21T00:00:00.000Z')
  const moduleSource =
    'useValue: options.executionAcceptanceService ?? new UnavailableExecutionAcceptanceService()\n'
  const sources = [
    'apps/control-api/src/app.module.ts',
    'apps/control-api/src/index.ts',
    'apps/control-api/src/cloud-composition.ts',
    'apps/hosted-control-plane/src/index.ts',
    'apps/hosted-control-plane/src/composition.ts',
    'apps/local-control-plane/src/index.ts',
    'apps/local-control-plane/src/composition.ts',
  ]
  for (const [root, content] of [
    [rootA, binds],
    [rootB, doesNotBind],
  ]) {
    for (const source of sources) {
      const target = join(root, source)
      await mkdir(dirname(target), { recursive: true })
      // The module that declares the defaults is identical in both roots.
      await writeFile(
        target,
        source === 'apps/control-api/src/app.module.ts' ? moduleSource : content
      )
      await utimes(target, timestamp, timestamp)
    }
  }
  return { directory, rootA, rootB, binds, doesNotBind, moduleSource, sources, timestamp }
}

/**
 * Rewrites the fixture's sources with the same byte length and the same
 * modification time, so only the contents differ.
 */
async function rewriteFixtureSources(fixture, root, content) {
  for (const source of fixture.sources) {
    const target = join(root, source)
    await writeFile(
      target,
      source === 'apps/control-api/src/app.module.ts' ? fixture.moduleSource : content
    )
    await utimes(target, fixture.timestamp, fixture.timestamp)
  }
}

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

  test('rejects an in-tree evidence symlink that points outside the repository', async () => {
    const fixture = await createEvidenceSymlinkFixture()
    try {
      // The symlink is lexically inside the repository, so a containment check
      // on resolved paths alone would accept it and let an in-tree path cite a
      // file anywhere on the host.
      expect(relative(fixture.root, fixture.link)).not.toStartWith('..')
      expect(await evidencePathError(fixture.root, 'external-target.md')).toBe(
        'evidence path escapes the repository'
      )

      // The same escape is rejected end to end, through the audit validator.
      const discovered = await discoverArchitecture(repositoryRoot)
      const changed = clone(audit)
      changed.operations[0].evidence = [{ kind: 'test', path: 'external-target.md' }]
      const { errors } = await validateArchitectureAudit(changed, {
        repositoryRoot: pathToFileURL(fixture.root),
        discovered,
      })
      expect(
        errors.some((error) => error.includes('evidence path escapes the repository')),
        errors.join(' | ')
      ).toBe(true)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('keeps accepting ordinary in-tree evidence', async () => {
    const fixture = await createEvidenceSymlinkFixture()
    try {
      // A regular in-tree file is citable.
      expect(await evidencePathError(fixture.root, 'ordinary.md')).toBeUndefined()
      // A symlink that stays inside the repository is still citable.
      expect(await evidencePathError(fixture.root, 'in-tree-link.md')).toBeUndefined()
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('rejects an evidence path that cannot be resolved', async () => {
    const fixture = await createEvidenceSymlinkFixture()
    try {
      expect(await evidencePathError(fixture.root, 'loop.md')).toBe(
        'evidence path could not be resolved'
      )
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('parses two checkout roots separately when their files share a path, size and time', async () => {
    const fixture = await createTwoRootBindingFixture()
    try {
      const first = await discoverCapabilityBindings(fixture.rootA)
      const second = await discoverCapabilityBindings(fixture.rootB)
      // The first root binds the capability, the second does not. The matching
      // files have the same relative path, the same byte length and the same
      // modification time, so a parse cache keyed by the relative path would
      // report the second root with the first root's answer.
      expect(first.profiles.cloud.bound).toContain('executionAcceptanceService')
      expect(second.profiles.cloud.bound).not.toContain('executionAcceptanceService')
      expect(second.profiles.cloud.unbound).toContain('executionAcceptanceService')
      // Auditing the first root again returns the first root's answer, so the
      // second root did not overwrite the first root's cache entry.
      const firstAgain = await discoverCapabilityBindings(fixture.rootA)
      expect(firstAgain.profiles.cloud.bound).toContain('executionAcceptanceService')
      expect(firstAgain.profiles.cloud.unbound).not.toContain('executionAcceptanceService')
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('re-parses a source whose contents change while its size and time do not', async () => {
    const fixture = await createTwoRootBindingFixture()
    try {
      const first = await discoverCapabilityBindings(fixture.rootA)
      expect(first.profiles.cloud.bound).toContain('executionAcceptanceService')
      // The same paths are rewritten with the same byte length and the same
      // modification time, so only the contents identify the change.
      await rewriteFixtureSources(fixture, fixture.rootA, fixture.doesNotBind)
      const second = await discoverCapabilityBindings(fixture.rootA)
      expect(second.profiles.cloud.bound).not.toContain('executionAcceptanceService')
      expect(second.profiles.cloud.unbound).toContain('executionAcceptanceService')
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('documents the conservative first-declaration rule for a shadowed shorthand', () => {
    // A shorthand property binds the variable it names. The detector resolves
    // that variable by taking the first declaration of the name anywhere in the
    // file, so the answer follows file order rather than lexical scope.
    //
    // This is exact for the admitted profile sources, where every capability
    // name is declared once and that declaration encloses the shorthand site.
    // It is not exact in general, and the two cases below show the limit: the
    // inner shorthand binds `undefined` in both, yet the rule answers from the
    // first declaration either way. The rule is pinned here so the limit stays
    // visible and any change to it is deliberate.
    const shadowedUndefinedFirst = [
      'function bind() {',
      '  const executionAcceptanceService = undefined',
      '  return { executionAcceptanceService }',
      '}',
      'const executionAcceptanceService = composition.executionAcceptanceService',
    ].join('\n')
    const shadowedRealFirst = [
      'const executionAcceptanceService = composition.executionAcceptanceService',
      'function bind() {',
      '  const executionAcceptanceService = undefined',
      '  return { executionAcceptanceService }',
      '}',
    ].join('\n')
    expect(bindsCapabilityOption(shadowedUndefinedFirst, 'executionAcceptanceService')).toBe(false)
    expect(bindsCapabilityOption(shadowedRealFirst, 'executionAcceptanceService')).toBe(true)
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

  test('rejects a core package that directly requires a deployment implementation', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const core = discovered.packages.find((entry) => entry.name === '@control-plane/domain')
    expect(core).toBeDefined()
    const withDeployment = {
      ...discovered,
      packages: discovered.packages.map((entry) =>
        entry.name === '@control-plane/domain'
          ? { ...entry, externalDependencies: [...entry.externalDependencies, 'postgres'] }
          : entry
      ),
    }
    const { errors } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: withDeployment,
    })
    expect(errors).toContain(
      '@control-plane/domain: core package depends on deployment implementation postgres'
    )
  })

  test('does not read a development dependency as a deployment implementation', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const core = discovered.packages.find((entry) => entry.name === '@control-plane/domain')
    expect(core).toBeDefined()
    const withDevelopment = {
      ...discovered,
      packages: discovered.packages.map((entry) =>
        entry.name === '@control-plane/domain'
          ? {
              ...entry,
              developmentExternalDependencies: [
                ...entry.developmentExternalDependencies,
                'postgres',
              ],
            }
          : entry
      ),
    }
    const { errors } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: withDevelopment,
    })
    // A development dependency is not shipped with the package, so it is not a
    // dependency of the core.
    expect(
      errors.some((error) => error.includes('core package depends on deployment implementation'))
    ).toBe(false)
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

  test('pins the number of capability bindings each profile supplies', async () => {
    const bindings = await discoverCapabilityBindings(fileURLToPath(repositoryRoot))
    // The detector only reads runtime object-literal bindings, so these counts
    // are the measured profile bindings and not a name-only match.
    expect(bindings.profiles.cloud.bound).toHaveLength(20)
    expect(bindings.profiles['hosted-server'].bound).toHaveLength(13)
    expect(bindings.profiles['hosted-simple'].bound).toHaveLength(16)
    expect(bindings.profiles.local.bound).toHaveLength(16)
    for (const profile of Object.keys(bindings.profiles)) {
      const { bound, unbound } = bindings.profiles[profile]
      expect(new Set([...bound, ...unbound]).size, profile).toBe(bound.length + unbound.length)
    }
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

  test('does not read a commented binding as a capability binding', () => {
    // The example the review reported: a commented example reads as a binding
    // under a name-only scan, which conceals the unavailable default.
    expect(
      bindsCapabilityOption(
        '// example: { executionAcceptanceService: adapter }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        '/*\n * { executionAcceptanceService: adapter }\n */',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'const options = {\n  // executionAcceptanceService: adapter\n  modelConnectionService: x,\n}',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'const options = {\n  /* executionAcceptanceService: adapter */\n  modelConnectionService: x,\n}',
        'executionAcceptanceService'
      )
    ).toBe(false)
    // A comment next to a real binding does not hide the real binding either.
    expect(
      bindsCapabilityOption(
        'const options = {\n  // executionAcceptanceService: adapter\n  executionAcceptanceService: composition.x,\n}',
        'executionAcceptanceService'
      )
    ).toBe(true)
  })

  test('does not read a type-only declaration as a capability binding', () => {
    expect(
      bindsCapabilityOption(
        'type Options = { executionAcceptanceService: Service }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'interface Options { executionAcceptanceService: Service }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'interface Options { readonly executionAcceptanceService?: Service }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'export interface Options {\n  readonly executionAcceptanceService?: Service\n}',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'class Composition { readonly executionAcceptanceService: Service }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'type Options = { executionAcceptanceService: Service }\nconst options = { executionAcceptanceService: composition.x }',
        'executionAcceptanceService'
      )
    ).toBe(true)
  })

  test('does not read an explicit undefined binding as a capability binding', () => {
    expect(
      bindsCapabilityOption(
        '{ executionAcceptanceService: undefined }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'const options = { executionAcceptanceService: undefined }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption('{ executionAcceptanceService: void 0 }', 'executionAcceptanceService')
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        'const executionAcceptanceService = undefined\nconst options = { executionAcceptanceService }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    expect(
      bindsCapabilityOption(
        '{ executionAcceptanceService: condition ? undefined : undefined }',
        'executionAcceptanceService'
      )
    ).toBe(false)
    // An undefined that falls back to a real value still binds that value.
    expect(
      bindsCapabilityOption(
        '{ executionAcceptanceService: undefined ?? composition.x }',
        'executionAcceptanceService'
      )
    ).toBe(true)
  })

  test('keeps reading real runtime object and shorthand bindings', () => {
    expect(
      bindsCapabilityOption(
        'const options = { executionAcceptanceService: composition.executionAcceptanceService }',
        'executionAcceptanceService'
      )
    ).toBe(true)
    expect(
      bindsCapabilityOption(
        'const options = { executionAcceptanceService }',
        'executionAcceptanceService'
      )
    ).toBe(true)
    expect(
      bindsCapabilityOption(
        'const executionAcceptanceService = composition.executionAcceptanceService\nconst options = { executionAcceptanceService }',
        'executionAcceptanceService'
      )
    ).toBe(true)
    expect(
      bindsCapabilityOption(
        'const options = {\n  ...(runtimeTransport === undefined ? {} : { executionAcceptanceService: runtimeTransport }),\n}',
        'executionAcceptanceService'
      )
    ).toBe(true)
    expect(
      bindsCapabilityOption(
        "const options = { 'executionAcceptanceService': composition.x }",
        'executionAcceptanceService'
      )
    ).toBe(true)
  })

  test('does not let a comment conceal a missing default in a real profile source', async () => {
    const bindings = await discoverCapabilityBindings(fileURLToPath(repositoryRoot))
    const cloud = bindings.profiles.cloud
    // The cloud profile binds no tool-effect-recovery implementation, so the
    // Control API serves it from its unavailable default.
    expect(cloud.unbound).toContain('toolEffectRecoveryService')
    expect(cloud.bound).not.toContain('toolEffectRecoveryService')

    const source = await readFile(
      new URL('../apps/control-api/src/index.ts', import.meta.url),
      'utf8'
    )
    const doctored = `${source}\n// toolEffectRecoveryService: composition.toolEffectRecoveryService\n`
    expect(bindsCapabilityOption(doctored, 'toolEffectRecoveryService')).toBe(false)
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
