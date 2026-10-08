import { parse } from 'acorn'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { test } from 'bun:test'
import { Glob } from 'bun'
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

// The fleet upgrade rewrites the runtime pin on every release; tests assert
// the caller pins stay consistent with the configured ref, not a hardcoded
// version.
const runtimeRef =
  (await readFile(new URL('../.github/code-foundry.yml', import.meta.url), 'utf8')).match(
    /^runtime_ref: (\S+)$/m
  )?.[1] ?? ''

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
  .toSorted()
const publicPackages = new Set([
  'contracts',
  'control-sdk',
  'runtime-gateway-protocol',
  'telemetry',
  'tool-sdk',
  'runtime-sdk',
])

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
}

test('pins the required Node and Bun toolchain', async () => {
  const manifest = await readJson('package.json')
  const testTsconfig = await readJson('tsconfig.json')

  assert.equal(manifest.packageManager, 'bun@1.4.2')
  assert.equal(manifest.engines.node, '24.21.0')
  assert.equal(manifest.engines.bun, '>=1.4.0 <2')
  assert.match(
    await readFile(new URL('../.mise.toml', import.meta.url), 'utf8'),
    /node = "24\.21\.0"/
  )
  assert.equal(
    (await readFile(new URL('../.bun-version', import.meta.url), 'utf8')).trim(),
    '1.4.2'
  )
  assert.equal(testTsconfig.extends, './tsconfig.base.json')
  assert.equal(testTsconfig.compilerOptions.experimentalDecorators, true)
  assert.equal(testTsconfig.compilerOptions.emitDecoratorMetadata, true)
})

test('defines root quality and build commands', async () => {
  const manifest = await readJson('package.json')

  for (const script of [
    'build',
    'dev',
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
  assert.match(manifest.scripts['requirements:check'], /--check-issues/)
  assert.match(manifest.scripts['db:check'], /packages\/database/)
  assert.match(manifest.scripts['test:unit'], /--coverage/)
  assert.match(manifest.scripts.test, /--parallel/)
})

test('schedules every discovered integration file through a package or repository command', async () => {
  const integration = await discoverTestFiles('integration')
  for (const path of integration) {
    if (path.startsWith('tests/')) {
      const runner = await readFile(
        new URL('../scripts/run-integration-tests.mjs', import.meta.url),
        'utf8'
      )
      const unsharded = runner.slice(
        runner.indexOf('if (integrationShard === null) {'),
        runner.indexOf('} else {', runner.indexOf('if (integrationShard === null) {'))
      )
      assert.ok(
        unsharded.includes(`'./${path}'`),
        `${path} is not selected by the unsharded repository runner`
      )
      continue
    }
    const [kind, name, ...relativeParts] = path.split('/')
    const manifest = await readJson(`${kind}/${name}/package.json`)
    const command = manifest.scripts['test:integration']
    assert.equal(typeof command, 'string', `${path} has no executable integration command`)
    assert.match(command, /^bun test /)
    assert.match(command, /--timeout 30000/)
    const patterns = command.split(/\s+/).filter((token) => token.endsWith('.test.mjs'))
    assert.ok(
      patterns.some((pattern) => new Glob(pattern).match(relativeParts.join('/'))),
      `${path} is not selected by its package integration command`
    )
  }
})

test('repository memory fixtures use declared workspace dependencies', async () => {
  const manifest = await readJson('package.json')
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  for (const path of [
    'tests/memory-process-loss.integration.test.mjs',
    'tests/fixtures/memory-root-process-loss.mjs',
  ]) {
    const source = parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), {
      ecmaVersion: 'latest',
      sourceType: 'module',
    })
    for (const declaration of source.body.filter((node) => node.type === 'ImportDeclaration')) {
      const name = declaration.source.value
      if (!name.startsWith('@control-plane/')) continue
      const packageName = name.split('/').slice(0, 2).join('/')
      assert.equal(
        dependencies[packageName],
        'workspace:*',
        `${path} imports undeclared ${packageName}`
      )
    }
  }
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
  assert.ok(
    !unit.includes('packages/database/src/memory-provenance-retention.integration.test.mjs')
  )
  assert.ok(!unit.includes('packages/testing/src/postgres.integration.test.mjs'))
  assert.ok(!unit.includes('tests/memory-process-loss.integration.test.mjs'))
  assert.deepEqual(integration, [
    'apps/control-api/src/budget-admission.integration.test.mjs',
    'apps/control-api/src/marketplace-installation.integration.test.mjs',
    'apps/control-api/src/validation-replay.integration.test.mjs',
    'apps/hosted-control-plane/src/hosted-graph-cancellation.integration.test.mjs',
    'apps/hosted-control-plane/src/hosted-graph.integration.test.mjs',
    'apps/hosted-control-plane/src/hosted-http.integration.test.mjs',
    'apps/hosted-control-plane/src/reconciliation-metrics.integration.test.mjs',
    'apps/hosted-control-plane/src/reconciliation-projection.integration.test.mjs',
    'apps/workflow-worker/src/runtime-budget-admission.integration.test.mjs',
    'packages/database/src/admission-rollout-admin.integration.test.mjs',
    'packages/database/src/budget-admission.integration.test.mjs',
    'packages/database/src/credential-vault-repository.integration.test.mjs',
    'packages/database/src/delegation-reference.integration.test.mjs',
    'packages/database/src/graph-definition-repository.integration.test.mjs',
    'packages/database/src/hosted-graph-operations.integration.test.mjs',
    'packages/database/src/integration.test.mjs',
    'packages/database/src/memory-provenance-retention.integration.test.mjs',
    'packages/database/src/model-selection-repository.integration.test.mjs',
    'packages/database/src/project-state-initialization.integration.test.mjs',
    'packages/database/src/retention-ancestry.integration.test.mjs',
    'packages/database/src/retention-claim-budget.integration.test.mjs',
    'packages/database/src/retention-claim-lock-order.integration.test.mjs',
    'packages/database/src/retention-hold-activation.integration.test.mjs',
    'packages/database/src/retention-hold-operator.integration.test.mjs',
    'packages/database/src/retention-hold-owner-activation.integration.test.mjs',
    'packages/database/src/retention-hold-repository.integration.test.mjs',
    'packages/database/src/retention-reference-windows.integration.test.mjs',
    'packages/database/src/runtime-node-identity-repository.integration.test.mjs',
    'packages/database/src/tool-repositories.integration.test.mjs',
    'packages/database/src/usage-store.integration.test.mjs',
    'packages/database/src/workspace-catalog.integration.test.mjs',
    'packages/database/src/workspace-execution-scope.integration.test.mjs',
    'packages/langgraph-adapter/src/postgres-checkpointer.integration.test.mjs',
    'packages/profile-portability/src/postgres.integration.test.mjs',
    'packages/testing/src/postgres.integration.test.mjs',
    'tests/memory-process-loss.integration.test.mjs',
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
    'tests/m11-consistency-metric-wiring.test.mjs',
    'tests/m11-context-authoring-composition.test.mjs',
    'tests/m11-context-composition.test.mjs',
    'tests/m11-context-transport-e2e.test.mjs',
    'tests/m11-local-native-terminal-usage.test.mjs',
    'tests/m11-standalone-e2e.test.mjs',
    'tests/pi-durable-child-host.test.mjs',
    'tests/pi-durable-delegation-recovery.test.mjs',
    'tests/pi-durable-canonical-authority.test.mjs',
    'tests/pi-durable-execution-model-composition.test.mjs',
    'tests/pi-durable-governed-child-composition.test.mjs',
    'tests/pi-durable-workspace-scope.test.mjs',
    'tests/service-lifecycle-e2e.test.mjs',
  ])
  const manifest = await readJson('package.json')
  assert.match(
    manifest.scripts['test:m11-standalone'],
    /tests\/m11-local-native-terminal-usage\.test\.mjs/
  )
  assert.deepEqual(smoke, [
    'tests/agent-skill-library.test.mjs',
    'tests/atomic-clause-ledger.test.mjs',
    'tests/canonical-source-lineage.test.mjs',
    'tests/container-promotion.test.mjs',
    'tests/foundation.test.mjs',
    'tests/infrastructure.test.mjs',
    'tests/integration-shards.test.mjs',
    'tests/integration-runner-lifecycle.test.mjs',
    'tests/hosted-compose-lifecycle.test.mjs',
    'tests/hosted-graph-qualification.test.mjs',
    'tests/m11-admission-rollout-admin.test.mjs',
    'tests/m11-acp-installation.test.mjs',
    'tests/m11-architecture-audit.test.mjs',
    'tests/m11-context-command-contract.test.mjs',
    'tests/m11-graph-composition.test.mjs',
    'tests/m11-managed-graph-runtime.test.mjs',
    'tests/m11-injection-eval.test.mjs',
    'tests/m11-native-packaging.test.mjs',
    'tests/managed-pi-docker-packaging.test.mjs',
    'tests/managed-pi-version-preflight.test.mjs',
    'tests/m11-prd-principle-crosswalk.test.mjs',
    'tests/m11-requirements-ledger.test.mjs',
    'tests/m11-reconciliation-parity.test.mjs',
    'tests/cp1-embedded-durable-execution.test.mjs',
    'tests/m11-security-probes.test.mjs',
    'tests/m11-sqlite-benchmark.test.mjs',
    'tests/neon-workflow.test.mjs',
    'tests/skill-library.test.mjs',
    'tests/m11-recovery-rpo-rto.test.mjs',
    'tests/m11-retention-apply-cli.test.mjs',
    'tests/m11-retention-class-registry.test.mjs',
    'tests/m11-retention-hold-operator.test.mjs',
    'tests/m11-retention-restore-reapply.test.mjs',
    'tests/railway-production-plan.test.mjs',
    'tests/repository.test.mjs',
    'tests/restate-identity.test.mjs',
  ])
  const inventory = await discoverTestInventory()
  const owned = [...unit, ...integration, ...e2e, ...smoke]
  assert.equal(new Set(owned).size, owned.length)
  assert.deepEqual(
    inventory.map(({ path }) => path),
    [...owned].toSorted()
  )
  assert.ok(
    inventory.every(({ primaryLane }) =>
      ['unit', 'integration', 'e2e', 'smoke'].includes(primaryLane)
    )
  )
})

test('M9 live requirements validation has scoped authenticated issue reads', async () => {
  const workflow = await readFile('.github/workflows/m9-production-readiness.yml', 'utf8')
  assert.match(workflow, /core:\n[\s\S]*?permissions:\n\s+contents: read\n\s+issues: read/)
  assert.match(workflow, /run: bun run type-check\n\s+env:\n\s+GH_TOKEN: \$\{\{ github.token \}\}/)
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

test('preserves a failed lane budget status when coverage passes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-lane-budget-'))
  await Promise.all([
    mkdir(join(root, '.github'), { recursive: true }),
    mkdir(join(root, 'apps', 'fixture'), { recursive: true }),
    mkdir(join(root, 'packages'), { recursive: true }),
    mkdir(join(root, 'scripts'), { recursive: true }),
  ])

  try {
    await Promise.all([
      copyFile(
        new URL('../scripts/run-bun-test-group.mjs', import.meta.url),
        join(root, 'scripts', 'run-bun-test-group.mjs')
      ),
      copyFile(
        new URL('../scripts/check-budgets.mjs', import.meta.url),
        join(root, 'scripts', 'check-budgets.mjs')
      ),
      copyFile(
        new URL('../scripts/check-coverage.mjs', import.meta.url),
        join(root, 'scripts', 'check-coverage.mjs')
      ),
      writeFile(
        join(root, 'apps', 'fixture', 'fixture.mjs'),
        'export const fixture = () => true\n'
      ),
      writeFile(
        join(root, 'apps', 'fixture', 'fixture.test.mjs'),
        "import { expect, test } from 'bun:test'\nimport { fixture } from './fixture.mjs'\ntest('fixture passes', () => expect(fixture()).toBe(true))\n"
      ),
      writeFile(
        join(root, 'budgets.json'),
        JSON.stringify({
          schemaVersion: 1,
          lanes: { unit: { ceilingSeconds: -1, baselineSeconds: 0 } },
        })
      ),
      writeFile(join(root, '.github', 'code-foundry.yml'), 'coverage_minimum: 0\n'),
      writeFile(
        join(root, 'bunfig.toml'),
        '[test]\ncoverageReporter = ["text", "lcov"]\ncoverageDir = "coverage"\n'
      ),
    ])

    const result = spawnSync(
      process.execPath,
      ['scripts/run-bun-test-group.mjs', 'unit', '--coverage'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, BUDGETS_FILE: join(root, 'budgets.json'), CI: 'true' },
      }
    )
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.status, 1, output)
    assert.match(output, /BUDGET EXCEEDED/)
    assert.match(output, /Coverage goal met/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('runs recalibration from any checkout with a configurable output directory', async () => {
  const script = await readFile(
    new URL('../docs/evals/recalibration/run-recalibration.mts', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(script, /from ['"]\/Users\//)
  assert.match(script, /\.\.\/\.\.\/\.\.\/packages\/production-readiness/)
  assert.match(script, /RECALIBRATION_OUTPUT_DIR/)

  const outputDirectory = await mkdtemp(join(tmpdir(), 'control-plane-recalibration-'))
  try {
    const result = spawnSync(process.execPath, ['docs/evals/recalibration/run-recalibration.mts'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, RECALIBRATION_OUTPUT_DIR: outputDirectory },
    })

    assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    assert.equal((await readdir(join(outputDirectory, 'sealed'))).length, 8)
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(join(outputDirectory, 'verdicts.json'), 'utf8'))),
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']
    )
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
}, 30_000)

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

test('configures the Code Foundry CI baseline for the public direct-workflow repository', async () => {
  const config = await readFile(new URL('../.github/code-foundry.yml', import.meta.url), 'utf8')

  assert.match(config, /^features: validation,release,draft-pr$/m)
  assert.match(config, /^dependency_updater: renovate$/m)
  assert.match(config, /^license: apache-2\.0$/m)
  assert.match(config, /^git_workflow: direct$/m)
  assert.match(config, /^release_merge_strategy: squash$/m)
  assert.match(config, /^codeql: auto$/m)
  assert.match(config, /^dependency_review: auto$/m)
  assert.doesNotMatch(config, /^opencode_security:/m)
  assert.doesNotMatch(config, /^staging_validation_mode:/m)
  assert.match(config, /^runtime_ref: v\d+\.\d+\.\d+$/m)
  for (const runner of ['runner', 'security_runner', 'pr_runner', 'release_runner']) {
    assert.match(config, new RegExp(`^${runner}: ubuntu-slim$`, 'm'))
  }
  // The CI lane carries the oxlint step, whose allocator pool aborts on
  // ubuntu-slim; it pins a standard runner instead.
  assert.match(config, /^ci_runner: ubuntu-latest$/m)
  assert.match(config, /^test_runner: ubuntu-latest$/m)
  assert.match(config, /^unit_runner: ubuntu-latest$/m)
  assert.match(config, /^codeql_runner: ubuntu-latest$/m)
})

test('emits the required gate contexts and documents the direct-workflow policy', async () => {
  const [config, contributing, ci, foundation, productionReadiness] = await Promise.all([
    readFile(new URL('../.github/code-foundry.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/CONTRIBUTING.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/ci.md', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/foundation-acceptance.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/m9-production-readiness.yml', import.meta.url), 'utf8'),
  ])

  assert.match(config, /^merge_strategy: squash$/m)
  assert.match(foundation, /^\s{4}name: Foundation Acceptance \/ Gate$/m)
  assert.match(productionReadiness, /^\s{4}name: M9 Production Readiness \/ Gate$/m)
  assert.match(contributing, /\| Working branch\s+\| `main`\s+\| Squash/)
  assert.match(ci, /Feature branches and Release Please version pull requests must squash into/)
  assert.doesNotMatch(contributing, /feature PRs land on `staging` with squash merges/)
  assert.doesNotMatch(contributing, /(?:from|targeting|at) `staging`/)
  assert.match(contributing, /Branch from `main` and target pull requests at `main`/)
  assert.match(contributing, /Draft pull requests do not start validation/)
})

test('reruns every required pull-request gate after ready-PR updates', async () => {
  const workflows = await Promise.all(
    [
      'foundation-acceptance.yml',
      'm9-production-readiness.yml',
      'm10-operability.yml',
      'review-policy.yml',
    ].map((name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'))
  )

  for (const workflow of workflows) {
    assert.match(workflow, /types: \[ready_for_review, synchronize\]/)
  }
})

test('generates the direct-workflow Code Foundry callers with parallel validation', async () => {
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

  assert.match(
    validation,
    new RegExp(
      `uses: 0xPlayerOne\\/code-foundry\\/\\.github\\/workflows\\/validation\\.yml@${runtimeRef}`
    )
  )
  assert.equal((validation.match(/vars\.CI_BILLING_PAUSED != 'true'/g) ?? []).length, 3)
  // v1.44.x cancels only superseded pull-request runs; push runs queue so a
  // cancellation can never drop default-branch analysis.
  assert.match(validation, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/)
  assert.match(validation, /codeql-runner: ubuntu-latest/)
  assert.match(validation, /unit-runner: ubuntu-latest/)
  const audit = await readFile(
    new URL('../.github/workflows/validation-audit.yml', import.meta.url),
    'utf8'
  )
  assert.match(audit, /unit-runner: ubuntu-latest/)
  assert.match(validation, /branches: \[main\]/)
  assert.match(validation, /ready_for_review/)
  assert.doesNotMatch(validation, /(?:opened|reopened)/)
  assert.match(validation, /synchronize/)
  assert.match(validation, /validation mode/)
  assert.match(validation, /mode: \$\{\{ needs\.mode\.outputs\.mode \}\}/)
  assert.match(release, new RegExp(`release\\.yml@${runtimeRef}`))
  assert.match(release, /release-while-paused:/)
  assert.match(release, /billing-pause-bypass:/)
  assert.match(draftPr, /if: vars\.CI_BILLING_PAUSED != 'true'/)
  assert.match(draftPr, /base: main/)
  // The direct workflow has no staging promotion caller: release-pr.yml must be gone.
  const callerWorkflows = readdirSync(new URL('../.github/workflows/', import.meta.url))
  assert(!callerWorkflows.includes('release-pr.yml'))
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

test('promotes scan-attested container digests to Railway production', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/container-promotion.yml', import.meta.url),
    'utf8'
  )
  const promotionClient = await readFile(
    new URL('../scripts/promote-railway-images.mjs', import.meta.url),
    'utf8'
  )

  assert.match(workflow, /release:\n\s+types: \[published\]/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /packages: write/)
  assert.match(workflow, /attestations: write/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /control-api/)
  assert.match(workflow, /workflow-worker/)
  assert.match(workflow, /Scan the immutable image/)
  assert.match(workflow, /docker push/)
  assert.ok(workflow.includes("sed -n 's/.*digest: \\(sha256:[0-9a-f]\\{64\\}\\).*/\\1/p'"))
  assert.ok(
    workflow.indexOf('Scan the immutable image') < workflow.indexOf('docker push'),
    'the image must pass Trivy before it is published'
  )
  assert.match(
    workflow,
    /actions\/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8/
  )
  assert.match(workflow, /create-storage-record: false/)
  assert.doesNotMatch(workflow, /artifact-metadata: write/)
  assert.match(workflow, /RAILWAY_PRODUCTION_TOKEN: \$\{\{ secrets\.RAILWAY_PRODUCTION_TOKEN \}\}/)
  assert.match(workflow, /test "\$GITHUB_REF_TYPE" = tag/)
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'workspace-v'\)/)
  assert.match(workflow, /test "\$PRERELEASE" = false/)
  assert.match(workflow, /\^workspace-v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/)
  assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/)
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" "origin\/\$DEFAULT_BRANCH"/)
  assert.match(
    workflow,
    /RELEASE_NAME: \$\{\{ github\.event\.release\.tag_name \|\| github\.ref_name \}\}/
  )
  assert.match(workflow, /--arg release "\$RELEASE_NAME"/)
  assert.match(workflow, /bun scripts\/promote-railway-images\.mjs promotion-\*\.json/)
  assert.doesNotMatch(workflow, /packages\/container\/.*visibility=public/)
  assert.doesNotMatch(workflow, /npm install --global @railway\/cli/)
  assert.match(promotionClient, /Bun\.spawn\(\['docker', 'pull', reference\]/)
  assert.match(promotionClient, /Project-Access-Token/)
  assert.match(promotionClient, /Authorization: `Bearer \$\{workspaceToken\}`/)
  assert.match(workflow, /RAILWAY_WORKSPACE_TOKEN: \$\{\{ secrets\.RAILWAY_WORKSPACE_TOKEN \}\}/)
  assert.match(promotionClient, /ServiceConnectInput/)
  assert.match(promotionClient, /serviceDisconnect/)
  assert.match(promotionClient, /deploymentRollback/)
  assert.match(promotionClient, /deploymentRemove/)
  assert.match(promotionClient, /canRollback/)
  assert.match(promotionClient, /assertMutationSucceeded/)
  assert.match(promotionClient, /reconcilePriorState/)
  assert.match(promotionClient, /knownDeploymentIds/)
  assert.match(promotionClient, /stableChecks >= 3/)
  assert.match(promotionClient, /deploymentStopped === false/)
  assert.match(workflow, /timeout-minutes: 60/)
  assert.match(workflow, /no-cache: true/)
  // The promoted image bakes its source commit so /health metadata stays
  // truthful without service-level variable pinning (#584 provenance audit).
  assert.match(workflow, /SOURCE_SHA: \$\{\{ github\.sha \}\}/)
  const dockerfile = await readFile(
    new URL('../infrastructure/containers/Dockerfile', import.meta.url),
    'utf8'
  )
  assert.match(dockerfile, /ARG COMMIT_SHA/)
  assert.match(dockerfile, /COMMIT_SHA=\$\{COMMIT_SHA\}/)
  const bake = await readFile(
    new URL('../infrastructure/containers/docker-bake.hcl', import.meta.url),
    'utf8'
  )
  assert.match(bake, /COMMIT_SHA = "\$\{SOURCE_SHA\}"/)
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
  // The sharded remote lane survives Neon pooler connection drops: a raised
  // per-test ceiling plus one fresh-process retry per file, and the ceiling
  // reaches suites whose explicit bun test() timeouts override the CLI flag
  // through INTEGRATION_TEST_TIMEOUT_MS.
  assert.match(runner, /remoteDatabase \? '120000' : '30000'/)
  assert.match(runner, /retrying once before failing the shard/)
  assert.match(runner, /INTEGRATION_TEST_TIMEOUT_MS: remoteDatabase \? '120000' : undefined/)
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

test('Neon slice failure does not rerun successful database work', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/neon_workflow.yml', import.meta.url),
    'utf8'
  )
  const slice = workflow
    .split("- name: Verify migrations and this shard's integration slice")[1]
    ?.split('- name: Find exact preview branch for cleanup')[0]
  const body = slice?.split('run: |\n')[1]
  assert.ok(body, 'Neon integration slice command is required')
  const script = body
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
    .replaceAll('${{ matrix.shard }}', '1')
  const directory = await mkdtemp(join(tmpdir(), 'neon-slice-failure-'))
  const log = join(directory, 'invocations')
  try {
    await writeFile(
      join(directory, 'bun'),
      '#!/bin/sh\ncase "$*" in\n  "scripts/run-integration-tests.mjs --shard=1") printf "slice\\n" >> "$NEON_SLICE_FIXTURE_LOG"; exit 1 ;;\n  *) exit 0 ;;\nesac\n',
      { mode: 0o700 }
    )
    const result = spawnSync('/bin/bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: { PATH: `${directory}:/usr/bin:/bin`, NEON_SLICE_FIXTURE_LOG: log },
    })
    assert.equal(result.status, 1, 'The failed slice must remain a failed check')
    assert.equal(
      await readFile(log, 'utf8'),
      'slice\n',
      'Do not rerun the whole slice after its drill fails'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('isolates credentialed Neon validation from pull-request source', async () => {
  const neonWorkflow = await readFile(
    new URL('../.github/workflows/neon_workflow.yml', import.meta.url),
    'utf8'
  )
  const pullRequestWorkflow = await readFile(
    new URL('../.github/workflows/postgres-pull-request.yml', import.meta.url),
    'utf8'
  )
  const validationWorkflow = await readFile(
    new URL('../.github/workflows/validation.yml', import.meta.url),
    'utf8'
  )
  const validationJob = validationWorkflow.split('  validation:\n')[1]?.split('\n  # CodeQL')[0]

  const events = neonWorkflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1]?.trimEnd()
  assert.match(
    events,
    /^  push:\n    branches:\n      - main\n[\s\S]*  repository_dispatch:\n    types: \[neon-preview-cleanup\]$/
  )
  assert.doesNotMatch(events, /\n  workflow_dispatch:/)
  assert.doesNotMatch(events, /pull_request/)
  const verificationJob = neonWorkflow
    .split('  verify_neon_preview:')[1]
    ?.split('  cleanup_completed_preview:')[0]
  assert.match(verificationJob, /github\.event_name == 'push' && !cancelled\(\)/)
  const cleanupJob = neonWorkflow.split('  cleanup_completed_preview:')[1]
  assert.match(
    cleanupJob,
    /if: github\.event_name == 'repository_dispatch' && github\.ref == 'refs\/heads\/main'/
  )
  assert.doesNotMatch(cleanupJob, /create-branch-action|bun install|bun run build|db:migrate/)
  assert.match(neonWorkflow, /NEON_CI_ADMIN_PASSWORD/)
  assert.match(neonWorkflow, /DATABASE_ADMIN_PASSWORD/)
  assert.match(neonWorkflow, /control_plane_admin/)
  assert.match(neonWorkflow, /"DATABASE_ADMIN_URL=" \+ adminUrl/)
  assert.match(neonWorkflow, /preview\/main-/)
  assert.match(neonWorkflow, /expires_at: \$\{\{ env\.EXPIRES_AT \}\}/)
  assert.doesNotMatch(pullRequestWorkflow, /\$\{\{[^}]*\bsecrets\b|^\s*secrets\s*:/m)
  assert.match(pullRequestWorkflow, /RUN_M10_POSTGRES_CONFORMANCE/)
  assert.match(pullRequestWorkflow, /bun run test:integration/)
  assert.ok(validationJob)
  assert.match(validationJob, /uses: 0xPlayerOne\/code-foundry/)
  // The reusable-workflow call forwards exactly two sanctioned secrets
  // (TURBO_TOKEN, NEXTAUTH_SECRET); any other secrets reference is a leak.
  const secretRefs = validationJob.match(/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/g) ?? []
  for (const ref of secretRefs) {
    assert.match(ref, /secrets\.(TURBO_TOKEN|NEXTAUTH_SECRET)\b/)
  }
})

test('scaffolds every application with an executable placeholder target', async () => {
  for (const app of apps) {
    const manifest = await readJson(`apps/${app}/package.json`)
    const source = await readFile(new URL(`../apps/${app}/src/index.ts`, import.meta.url), 'utf8')

    assert.equal(manifest.name, `@control-plane/${app}`)
    assert.equal(manifest.private, true)
    assert.equal(manifest.browser, false)
    assert.equal(manifest.engines.node, '24.21.0')
    assert.equal(typeof manifest.scripts.build, 'string')
    assert.equal(typeof manifest.scripts.dev, 'string')
    assert.equal(manifest.scripts.dev, 'bun --watch src/start.ts')
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
    ...packages.map((workspacePackageName) => [
      `packages/${workspacePackageName}`,
      workspacePackageName === 'control-sdk' ? 'sdk' : workspacePackageName,
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

test('uses Renovate with grouped draft batches and sync-managed holds', async () => {
  assert(
    !existsSync(new URL('../.github/dependabot.yml', import.meta.url)),
    'Dependabot must not race the managed Renovate updater'
  )
  const renovate = JSON.parse(await readFile(new URL('../renovate.json', import.meta.url), 'utf8'))
  assert(
    (renovate.extends ?? []).includes('config:recommended'),
    'every ecosystem stays covered by the recommended preset'
  )
  assert.equal(renovate.draftPR, true, 'every dependency PR must open as a draft')
  const nonMajor = renovate.packageRules.find(
    (rule) => rule.groupName === 'external non-major dependencies'
  )
  const major = renovate.packageRules.find(
    (rule) => rule.groupName === 'external major dependencies'
  )
  assert(nonMajor, 'non-major updates must ride one grouped PR')
  assert.deepEqual(nonMajor.matchUpdateTypes, ['patch', 'minor', 'pin', 'digest'])
  assert(major, 'major bumps must share one grouped PR')
  assert.deepEqual(major.matchUpdateTypes, ['major'])
  const pinHold = renovate.packageRules.find((rule) =>
    (rule.matchPackageNames ?? []).some((name) => name.startsWith('/^0xPlayerOne\\/code-foundry/'))
  )
  assert.equal(
    pinHold?.enabled,
    false,
    'Sync-managed Code Foundry pins must be excluded from dependency updates'
  )
  assert.equal('automerge' in renovate, false, 'dependency PRs must never automerge')
  assert(
    renovate.packageRules.every((rule) => !('automerge' in rule)),
    'dependency PRs must never automerge'
  )
})
