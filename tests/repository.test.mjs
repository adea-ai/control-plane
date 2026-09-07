import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import { test } from 'bun:test'
import {
  assertCoverageGoal,
  parseCoverageMinimum,
  summarizeLcov,
} from '../scripts/check-coverage.mjs'
import {
  discoverTestFiles,
  discoverTestInventory,
  normalizedBunTestArguments,
} from '../scripts/run-bun-test-group.mjs'

const apps = [
  'control-api',
  'workflow-worker',
  'runtime-worker',
  'runtime-gateway',
  'tool-gateway',
  'local-control-plane',
]
const packages = readdirSync(new URL('../packages/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map(({ name }) => name)
  .sort()
const publicPackages = new Set(['contracts', 'control-sdk', 'runtime-gateway-protocol'])

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
}

test('pins the required Node and Bun toolchain', async () => {
  const manifest = await readJson('package.json')
  const testTsconfig = await readJson('tsconfig.json')

  assert.equal(manifest.packageManager, 'bun@1.4.0')
  assert.equal(manifest.engines.node, '>=24 <25')
  assert.equal(manifest.engines.bun, '>=1.4.0 <2')
  assert.equal(
    (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim(),
    '24.18.0'
  )
  assert.equal(
    (await readFile(new URL('../.bun-version', import.meta.url), 'utf8')).trim(),
    '1.4.0'
  )
  assert.equal(testTsconfig.extends, './tsconfig.base.json')
  assert.equal(testTsconfig.compilerOptions.experimentalDecorators, true)
  assert.equal(testTsconfig.compilerOptions.emitDecoratorMetadata, true)
})

test('defines root quality and build commands', async () => {
  const manifest = await readJson('package.json')

  for (const script of [
    'build',
    'type-check',
    'lint',
    'test',
    'test:unit',
    'test:integration',
    'test:e2e',
    'test:smoke',
    'test:foundation',
    'test:coverage',
    'format',
    'format:check',
    'check:boundaries',
    'db:check',
    'requirements:check',
    'architecture:check',
  ]) {
    assert.equal(typeof manifest.scripts[script], 'string', `${script} must be defined`)
  }

  assert.match(manifest.scripts['type-check'], /turbo run build openapi:check/)
  assert.match(manifest.scripts['type-check'], /bun run db:check/)
  assert.match(manifest.scripts['db:check'], /packages\/database/)
  assert.match(manifest.scripts['test:unit'], /--coverage/)
  assert.match(manifest.scripts.test, /--parallel/)
})

test('configures an uploadable Code Foundry coverage report', async () => {
  const bunfig = await readFile(new URL('../bunfig.toml', import.meta.url), 'utf8')
  const manifest = await readJson('package.json')
  const codeFoundry = await readFile(
    new URL('../.github/code-foundry.yml', import.meta.url),
    'utf8'
  )

  assert.match(bunfig, /coverageSkipTestFiles\s*=\s*true/)
  assert.match(bunfig, /coverageReporter\s*=\s*\["text",\s*"lcov"\]/)
  assert.match(bunfig, /coverageDir\s*=\s*"coverage"/)
  assert.match(bunfig, /coveragePathIgnorePatterns\s*=\s*\[[^\]]*dist/s)
  assert.match(manifest.scripts['test:unit'], /--coverage/)
  assert.match(codeFoundry, /^coverage_minimum: 80$/m)
})

test('discovers disjoint Bun test groups for Code Foundry', async () => {
  const unit = await discoverTestFiles('unit')
  const integration = await discoverTestFiles('integration')
  const e2e = await discoverTestFiles('e2e')
  const smoke = await discoverTestFiles('smoke')

  assert.ok(unit.includes('apps/control-api/src/application.test.mjs'))
  assert.ok(unit.includes('packages/database/src/index.test.mjs'))
  assert.ok(unit.includes('packages/production-readiness/src/deployment.test.mjs'))
  assert.ok(unit.includes('packages/production-readiness/src/load-testing.test.mjs'))
  assert.ok(!unit.includes('packages/database/src/integration.test.mjs'))
  assert.ok(!unit.includes('packages/testing/src/postgres.integration.test.mjs'))
  assert.deepEqual(integration, [
    'packages/database/src/integration.test.mjs',
    'packages/langgraph-adapter/src/postgres-checkpointer.integration.test.mjs',
    'packages/profile-portability/src/postgres.integration.test.mjs',
    'packages/testing/src/postgres.integration.test.mjs',
  ])
  const portabilityManifest = await readJson('packages/profile-portability/package.json')
  assert.match(
    portabilityManifest.scripts['test:integration'],
    /src\/postgres\.integration\.test\.mjs/
  )
  assert.deepEqual(e2e, [
    'tests/m2-core-domain.test.mjs',
    'tests/m3-durable-execution.test.mjs',
    'tests/m4-runtime-fabric.test.mjs',
    'tests/m5-runtime-gateway.test.mjs',
    'tests/m6-runtime-adapters.test.mjs',
    'tests/m7-tools-models-sandboxes.test.mjs',
    'tests/m8-multi-agent-orchestration.test.mjs',
    'tests/m9-cloud-certification.test.mjs',
    'tests/m9-production-hardening.test.mjs',
    'tests/m10-portability-conformance.test.mjs',
    'tests/m10-operability.test.mjs',
    'tests/m11-standalone-e2e.test.mjs',
  ])
  assert.deepEqual(smoke, [
    'tests/foundation.test.mjs',
    'tests/infrastructure.test.mjs',
    'tests/m11-architecture-audit.test.mjs',
    'tests/m11-requirements-ledger.test.mjs',
    'tests/repository.test.mjs',
  ])
  const inventory = await discoverTestInventory()
  const owned = [...unit, ...integration, ...e2e, ...smoke]
  assert.equal(new Set(owned).size, owned.length)
  assert.deepEqual(
    inventory.map(({ path }) => path),
    [...owned].sort()
  )
  assert.ok(
    inventory.every(({ primaryLane }) =>
      ['unit', 'integration', 'e2e', 'smoke'].includes(primaryLane)
    )
  )
})

test('enforces deterministic Bun seeds and forbids automatic retries', () => {
  assert.deepEqual(normalizedBunTestArguments(['--timeout', '30000']), [
    '--randomize',
    '--seed',
    '1104',
    '--timeout',
    '30000',
  ])
  assert.deepEqual(normalizedBunTestArguments(['--seed=42', '--randomize']), [
    '--seed=42',
    '--randomize',
  ])
  assert.throws(() => normalizedBunTestArguments(['--retry', '1']), /automatic retries/i)
  assert.throws(() => normalizedBunTestArguments(['--rerun-each=2']), /automatic retries/i)
})

test('enforces aggregate line and function coverage from LCOV', () => {
  const summary = summarizeLcov(`
TN:
SF:first.ts
FNF:8
FNH:7
LF:10
LH:8
end_of_record
SF:second.ts
FNF:2
FNH:1
LF:10
LH:9
end_of_record
`)

  assert.deepEqual(summary, { functions: 80, lines: 85 })
  assert.doesNotThrow(() => assertCoverageGoal(summary, 80))
  assert.throws(() => assertCoverageGoal(summary, 81), /functions coverage 80\.00%/)
  assert.throws(() => assertCoverageGoal(summarizeLcov('TN:\n'), 80), /coverage 0\.00%/)
  assert.equal(parseCoverageMinimum('coverage_minimum: 80\n'), 80)
  assert.throws(() => parseCoverageMinimum('features: all\n'), /not configured/)
})

test('configures the Code Foundry CI baseline for the public staging-release repository', async () => {
  const config = await readFile(new URL('../.github/code-foundry.yml', import.meta.url), 'utf8')

  assert.match(config, /^features: all$/m)
  assert.match(config, /^license: apache-2\.0$/m)
  assert.match(config, /^git_workflow: staging-release$/m)
  assert.match(config, /^release_merge_strategy: rebase$/m)
  assert.match(config, /^codeql: auto$/m)
  assert.match(config, /^dependency_review: auto$/m)
  assert.match(config, /^opencode_security: true$/m)
  assert.match(config, /^staging_validation_mode: audit$/m)
  assert.match(config, /^runtime_ref: v1\.3\.1$/m)
  for (const runner of [
    'runner',
    'ci_runner',
    'test_runner',
    'unit_runner',
    'security_runner',
    'codeql_runner',
    'pr_runner',
    'release_runner',
  ]) {
    assert.match(config, new RegExp(`^${runner}: ubuntu-latest$`, 'm'))
  }
})

test('emits the required gate contexts and documents the staging-release policy', async () => {
  const [config, contributing, ci, foundation, productionReadiness] = await Promise.all([
    readFile(new URL('../.github/code-foundry.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/CONTRIBUTING.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/ci.md', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/foundation-acceptance.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/m9-production-readiness.yml', import.meta.url), 'utf8'),
  ])

  assert.match(config, /^merge_strategy: rebase$/m)
  assert.match(foundation, /^\s{4}name: Foundation Acceptance \/ Gate$/m)
  assert.match(productionReadiness, /^\s{4}name: M9 Production Readiness \/ Gate$/m)
  assert.match(contributing, /feature PRs land on `staging` with squash merges/)
  assert.match(ci, /Feature branches must squash into `staging`/)
  assert.doesNotMatch(contributing, /feature PRs land on `main` with rebase merges/)
})

test('generates the staging-release Code Foundry callers with parallel validation', async () => {
  const validation = await readFile(
    new URL('../.github/workflows/validation.yml', import.meta.url),
    'utf8'
  )
  const release = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8'
  )
  const draftPr = await readFile(
    new URL('../.github/workflows/draft-pr.yml', import.meta.url),
    'utf8'
  )
  const dependabot = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')

  assert.match(
    validation,
    /uses: 0xPlayerOne\/code-foundry\/\.github\/workflows\/validation\.yml@v1\.3\.1/
  )
  assert.equal((validation.match(/if: vars\.CI_BILLING_PAUSED != 'true'/g) ?? []).length, 2)
  assert.match(validation, /cancel-in-progress: true/)
  assert.doesNotMatch(validation, /ubuntu-slim/)
  assert.match(validation, /branches: \[main, staging\]/)
  assert.match(validation, /validation mode/)
  assert.match(validation, /mode: \$\{\{ needs\.mode\.outputs\.mode \}\}/)
  assert.match(release, /release\.yml@v1\.3\.1/)
  assert.match(release, /release-while-paused:/)
  assert.match(release, /billing-pause-bypass:/)
  assert.match(draftPr, /if: vars\.CI_BILLING_PAUSED != 'true'/)
  assert.match(draftPr, /base: staging/)
  assert.equal((dependabot.match(/target-branch: staging/g) ?? []).length, 2)

  const releasePr = await readFile(
    new URL('../.github/workflows/release-pr.yml', import.meta.url),
    'utf8'
  )
  assert.match(releasePr, /branches: \[staging\]/)
  assert.match(releasePr, /release-pr\.yml@v1\.3\.1/)
  const opencodeSecurity = await readFile(
    new URL('../.github/workflows/opencode-security.yml', import.meta.url),
    'utf8'
  )
  assert.match(opencodeSecurity, /OpenCode Security \/ Scan/)
  assert.match(opencodeSecurity, /OPENCODE_API_KEY/)
  assert.match(opencodeSecurity, /137698ef3545204af8fad00fc8bd64d663c8122e/)
})

test('documents required, public-repository, and future CI gates', async () => {
  const documentation = await readFile(new URL('../docs/ci.md', import.meta.url), 'utf8')

  assert.match(documentation, /Validation \/ Gate/)
  assert.match(documentation, /required/i)
  assert.match(documentation, /CodeQL.*enabled/is)
  assert.match(documentation, /Dependency Review.*enabled/is)
  assert.match(documentation, /parallel/i)
  assert.match(documentation, /OpenAPI/i)
  assert.match(documentation, /migration/i)
  assert.match(documentation, /E2E/i)
  assert.match(documentation, /deploy/i)
})

test('retains immutable load, recovery, and container evidence artifacts', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/m9-production-readiness.yml', import.meta.url),
    'utf8'
  )

  assert.equal(
    (
      workflow.match(/uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g) ??
      []
    ).length,
    3
  )
  assert.equal((workflow.match(/retention-days: 30/g) ?? []).length, 3)
  assert.match(workflow, /name: m11-load-\$\{\{ github\.sha \}\}/)
  assert.match(workflow, /name: m11-recovery-\$\{\{ github\.sha \}\}/)
  assert.match(workflow, /name: m11-containers-\$\{\{ github\.sha \}\}/)
  assert.match(workflow, /if-no-files-found: error/)
})

test('provides a documented isolated integration-test runner', async () => {
  const runner = await readFile(
    new URL('../scripts/run-integration-tests.mjs', import.meta.url),
    'utf8'
  )
  const documentation = await readFile(new URL('../docs/testing.md', import.meta.url), 'utf8')
  const sharedPostgresSuite = await readFile(
    new URL('../packages/testing/src/postgres.integration.test.mjs', import.meta.url),
    'utf8'
  )
  const database = await readJson('packages/database/package.json')
  const testing = await readJson('packages/testing/package.json')

  assert.match(runner, /docker compose/)
  assert.match(runner, /RUN_DATABASE_INTEGRATION/)
  assert.match(runner, /SELECT 1/)
  assert.match(runner, /database system is accepting SQL connections/)
  assert.match(runner, /'test:integration', '--concurrency=1'/)
  assert.match(runner, /'stop', '--timeout', '60', 'postgres'/)
  assert.match(database.scripts['test:integration'], /--timeout 30000/)
  assert.match(testing.scripts['test:integration'], /--timeout 30000/)
  assert.match(sharedPostgresSuite, /30_000/)
  assert.doesNotMatch(sharedPostgresSuite, /15_000/)
  assert.match(documentation, /bun run test:foundation/)
  assert.match(documentation, /unit/i)
  assert.match(documentation, /integration/i)
  assert.match(documentation, /contract/i)
  assert.match(documentation, /failure-injection/i)
  assert.match(documentation, /end-to-end/i)
  assert.match(documentation, /80%/)
  assert.match(documentation, /LCOV/)
  assert.match(documentation, /parallel/i)
})

test('scaffolds every application with an executable placeholder target', async () => {
  for (const app of apps) {
    const manifest = await readJson(`apps/${app}/package.json`)
    const source = await readFile(new URL(`../apps/${app}/src/index.ts`, import.meta.url), 'utf8')

    assert.equal(manifest.name, `@control-plane/${app}`)
    assert.equal(manifest.private, true)
    assert.equal(manifest.browser, false)
    assert.equal(manifest.engines.node, '>=24 <25')
    assert.equal(typeof manifest.scripts.build, 'string')
    assert.equal(typeof manifest.scripts.start, 'string')
    assert.equal(typeof manifest.scripts.lint, 'string')
    assert.equal(typeof manifest.scripts.test, 'string')
    assert.match(source, /serviceName/)
    assert.match(source, /bootstrapService/)
  }
})

test('scaffolds every package with an explicit private or publishable server-only surface', async () => {
  const releaseManifest = await readJson('.release-please-manifest.json')

  for (const packageName of packages) {
    const manifest = await readJson(`packages/${packageName}/package.json`)

    assert.equal(
      manifest.name,
      packageName === 'control-sdk' ? '@control-plane/sdk' : `@control-plane/${packageName}`
    )
    if (publicPackages.has(packageName)) {
      assert.equal(manifest.private, undefined)
      assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
      assert.equal(manifest.version, releaseManifest[`packages/${packageName}`])
      assert.equal(manifest.license, 'Apache-2.0')
      assert.deepEqual(manifest.publishConfig, { access: 'public', provenance: true })
    } else {
      assert.equal(manifest.private, true)
    }
    assert.equal(manifest.browser, false)
    assert.ok(manifest.files.includes('dist'))
    if (packageName === 'control-sdk') assert.ok(manifest.files.includes('openapi'))
    assert.ok(Object.hasOwn(manifest.exports, '.'))
    if (packageName === 'database') {
      assert.ok(Object.hasOwn(manifest.exports, './migration'))
      assert.ok(Object.hasOwn(manifest.exports, './testing'))
    }
    if (packageName === 'testing') assert.ok(Object.hasOwn(manifest.exports, './postgres'))
    if (packageName === 'control-sdk') assert.ok(Object.hasOwn(manifest.exports, './testing'))
    assert.equal(manifest.exports['.'].types, './dist/index.d.ts')
    assert.equal(manifest.exports['.'].node, './dist/index.js')
    assert.equal(manifest.exports['.'].default, './dist/index.js')
    assert.equal(typeof manifest.scripts.build, 'string')
    assert.equal(typeof manifest.scripts.lint, 'string')
    assert.equal(typeof manifest.scripts.test, 'string')
  }
})

test('tracks every workspace for coordinated stable release automation', async () => {
  const config = await readJson('release-please-config.json')
  const manifest = await readJson('.release-please-manifest.json')

  assert.equal(config['bump-minor-pre-major'], true)
  for (const [path, packageName] of [
    ['.', 'workspace'],
    ...apps.map((app) => [`apps/${app}`, app]),
    ...packages.map((packageName) => [
      `packages/${packageName}`,
      packageName === 'control-sdk' ? 'sdk' : packageName,
    ]),
  ]) {
    assert.equal(config.packages[path]['package-name'], `@control-plane/${packageName}`)
    assert.match(manifest[path], /^\d+\.\d+\.\d+$/)
  }
})

test('configures strict TypeScript and dependency-boundary checks', async () => {
  const tsconfig = await readJson('tsconfig.base.json')
  const manifest = await readJson('package.json')
  const oxlintConfig = await readFile(new URL('../.oxlintrc.json', import.meta.url), 'utf8')

  assert.equal(tsconfig.compilerOptions.strict, true)
  assert.equal(tsconfig.compilerOptions.noImplicitReturns, true)
  assert.equal(tsconfig.compilerOptions.noPropertyAccessFromIndexSignature, true)
  assert.equal(tsconfig.compilerOptions.noUncheckedSideEffectImports, true)
  assert.equal(tsconfig.compilerOptions.allowUnreachableCode, false)
  assert.equal(tsconfig.compilerOptions.allowUnusedLabels, false)
  assert.match(manifest.scripts['check:boundaries'], /turbo boundaries/)
  for (const prohibited of [
    '@langchain/langgraph',
    '@modelcontextprotocol',
    '@temporalio',
    '@e2b',
    'litellm',
    'pi-ai',
  ]) {
    assert.match(oxlintConfig, new RegExp(prohibited.replaceAll('/', '\\/')))
  }
})

test('keeps observability vendor SDKs behind the telemetry package boundary', async () => {
  const vendorPattern = /@opentelemetry|@sentry/

  for (const packageName of [
    'domain',
    'contracts',
    'events',
    'execution-plan',
    'runtime-sdk',
    'tool-sdk',
    'policy',
    'context',
  ]) {
    const manifest = await readFile(
      new URL(`../packages/${packageName}/package.json`, import.meta.url),
      'utf8'
    )
    const source = await readFile(
      new URL(`../packages/${packageName}/src/index.ts`, import.meta.url),
      'utf8'
    )

    assert.doesNotMatch(manifest, vendorPattern)
    assert.doesNotMatch(source, vendorPattern)
  }
})

function runOxlint(cwd, fixture) {
  return spawnSync('bun', ['x', 'oxlint', fileURLToPath(fixture)], {
    cwd,
    encoding: 'utf8',
  })
}

test('rejects database contracts in Control API controllers', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const fixture = new URL(
    '../apps/control-api/src/system/database-contract.boundary-test.controller.ts',
    import.meta.url
  )
  await writeFile(fixture, 'import "@control-plane/database";\n')

  try {
    const result = runOxlint(cwd, fixture)

    assert.equal(result.status, 1)
    assert.match(result.stdout, /no-restricted-imports/)
  } finally {
    await unlink(fixture)
  }
}, 60_000)

test('rejects live database imports from core packages', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const fixture = new URL(
    '../packages/domain/src/database-import.boundary-test.ts',
    import.meta.url
  )
  await writeFile(fixture, 'import "@control-plane/database";\n')

  try {
    const result = runOxlint(cwd, fixture)

    assert.equal(result.status, 1)
    assert.match(result.stdout, /no-restricted-imports/)
  } finally {
    await unlink(fixture)
  }
}, 60_000)

test('rejects concrete vendor imports from core packages', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const fixture = new URL('../packages/domain/src/vendor-import.boundary-test.ts', import.meta.url)
  await writeFile(fixture, 'import "@temporalio/client";\n')

  try {
    const result = runOxlint(cwd, fixture)

    assert.equal(result.status, 1)
    assert.match(result.stdout, /no-restricted-imports/)
  } finally {
    await unlink(fixture)
  }
}, 60_000)
