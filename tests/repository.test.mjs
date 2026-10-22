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
import { join, relative } from 'node:path'
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
import { buildTasks } from '../scripts/orch-graph.mjs'
import { expectedId } from '../scripts/orch-toolchain.mjs'
import { workspaces } from '../scripts/workspace-boundaries.mjs'
import { INTEGRATION_SHARDS } from '../scripts/integration-shards.mjs'

// The fleet upgrade rewrites the runtime pin on every release; tests assert
// the caller pins stay consistent with the configured ref, not a hardcoded
// version.
const runtimeRef =
  (await readFile(new URL('../.github/code-foundry.yml', import.meta.url), 'utf8')).match(
    /^runtime_ref: (\S+)$/m
  )?.[1] ?? ''
const sharedValidationRef = runtimeRef

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

  assert.equal(manifest.packageManager, 'bun@1.4.3')
  assert.equal(manifest.engines.node, '24.21.0')
  assert.equal(manifest.engines.bun, '>=1.4.0 <2')
  assert.match(
    await readFile(new URL('../.mise.toml', import.meta.url), 'utf8'),
    /node = "24\.21\.0"/
  )
  assert.equal(
    (await readFile(new URL('../.bun-version', import.meta.url), 'utf8')).trim(),
    '1.4.3'
  )
  assert.equal(testTsconfig.extends, './tsconfig.base.json')
  assert.equal(testTsconfig.compilerOptions.experimentalDecorators, true)
  assert.equal(testTsconfig.compilerOptions.emitDecoratorMetadata, true)
})

test('the declared toolchain agrees with the files continuous integration installs from', async () => {
  const manifest = await readJson('package.json')
  const mise = await readFile(new URL('../.mise.toml', import.meta.url), 'utf8')
  const bunVersion = (await readFile(new URL('../.bun-version', import.meta.url), 'utf8')).trim()
  const nodeVersion = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim()

  // One toolchain, named by every surface that carries it: the mise tool, the file the
  // continuous integration installs the runtime from, and the engine a consumer resolves
  // against. The node engine is one exact version rather than a range, because the range
  // a consumer resolves against is not the version the lanes run.
  const miseTool = (tool) => new RegExp(`^${tool} = "([^"]+)"$`, 'm').exec(mise)?.[1]
  assert.equal(miseTool('node'), nodeVersion)
  assert.equal(miseTool('bun'), bunVersion)
  assert.equal(nodeVersion, manifest.engines.node)
  assert.equal(bunVersion, manifest.packageManager.replace(/^bun@/, ''))
  assert.match(manifest.engines.node, /^\d+\.\d+\.\d+$/)

  // The declared bun engine admits the pinned runtime, so the floor a consumer resolves
  // against does not exclude the version the repository runs. The comparison decides on the
  // first component that differs, so a same-major comparison is decided by the minor or
  // the patch component and not by the major one alone.
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index]
    }
    return 0
  }
  const admits = (range, candidate) => {
    const match = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?\s+<(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range)
    if (!match) return undefined
    const lower = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
    const upper = [Number(match[4]), Number(match[5] ?? 0), Number(match[6] ?? 0)]
    return compare(candidate, lower) >= 0 && compare(candidate, upper) < 0
  }

  // The boundaries that a comparison reading only the major component decides wrongly:
  // a version below the same-major lower bound is refused, and a version inside the
  // same-major range is admitted.
  assert.equal(
    admits('>=1.4.0 <1.5.0', [1, 3, 0]),
    false,
    'a version below the lower bound is refused'
  )
  assert.equal(admits('>=1.4.0 <1.5.0', [1, 4, 0]), true, 'the lower bound itself is admitted')
  assert.equal(admits('>=1.4.0 <1.5.0', [1, 4, 3]), true, 'a version inside the range is admitted')
  assert.equal(admits('>=1.4.0 <1.5.0', [1, 5, 0]), false, 'the upper bound is refused')
  assert.equal(
    admits('>=1.4.0 <1.5.0', [1, 5, 1]),
    false,
    'a version above the upper bound is refused'
  )
  assert.equal(
    admits('>=1.4.0 <2', [1, 3, 0]),
    false,
    'a version below the declared lower bound is refused'
  )
  assert.equal(admits('>=1.4.0 <2', [1, 4, 3]), true, 'the pinned runtime is admitted')

  const pinned = bunVersion.split('.').map(Number)
  assert.ok(
    admits(manifest.engines.bun, pinned),
    `engines.bun ${manifest.engines.bun} must admit the pinned bun ${bunVersion}`
  )

  // The versions pinned here are the versions the lanes install, so the contract is the
  // one continuous integration enforces rather than a declaration nothing reads.
  const installing = { bun: [], node: [] }
  for (const file of readdirSync(new URL('../.github/workflows/', import.meta.url))) {
    if (!file.endsWith('.yml')) continue
    const workflow = await readFile(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      'utf8'
    )
    if (/node-version-file:\s*\.node-version/.test(workflow)) installing.node.push(file)
    if (/bun-version-file:\s*\.bun-version/.test(workflow)) installing.bun.push(file)
  }
  assert.ok(installing.node.length > 0, 'a workflow must install node from .node-version')
  assert.ok(installing.bun.length > 0, 'a workflow must install bun from .bun-version')
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
    'check:digest-writers',
  ]) {
    assert.equal(typeof manifest.scripts[script], 'string', `${script} must be defined`)
  }

  assert.match(manifest.scripts['type-check'], /vp run orch:check/)
  assert.match(manifest.scripts['type-check'], /bun run db:check/)
  assert.match(manifest.scripts['requirements:check'], /--check-issues/)
  assert.match(manifest.scripts['db:check'], /packages\/database/)
  assert.match(manifest.scripts.lint, /bun run check:canonical-ordering/)
  assert.match(manifest.scripts.lint, /bun run check:digest-writers/)
  assert.match(manifest.scripts['test:unit'], /--coverage/)
  assert.match(manifest.scripts.test, /--parallel/)
})

test('schedules every discovered integration file through a package command or shard', async () => {
  const integration = await discoverTestFiles('integration')
  for (const path of integration) {
    if (path.startsWith('tests/')) {
      const scheduled = INTEGRATION_SHARDS.flatMap(({ groups }) =>
        groups.filter(
          ({ package: packageName, files }) => packageName === '.' && files.includes(`./${path}`)
        )
      )
      assert.equal(scheduled.length, 1, `${path} must have exactly one verified shard owner`)
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
    'apps/hosted-control-plane/src/hosted-graph-legacy-fence.integration.test.mjs',
    'apps/hosted-control-plane/src/hosted-graph.integration.test.mjs',
    'apps/hosted-control-plane/src/hosted-http.integration.test.mjs',
    'apps/hosted-control-plane/src/reconciliation-metrics.integration.test.mjs',
    'apps/hosted-control-plane/src/reconciliation-projection.integration.test.mjs',
    'apps/runtime-gateway/src/runtime-node-credential-binding.integration.test.mjs',
    'apps/workflow-worker/src/child-runtime-budget-admission.integration.test.mjs',
    'apps/workflow-worker/src/remote-runtime-waiter.integration.test.mjs',
    'apps/workflow-worker/src/runtime-budget-admission.integration.test.mjs',
    'packages/database/src/admission-rollout-admin.integration.test.mjs',
    'packages/database/src/budget-admission.integration.test.mjs',
    'packages/database/src/child-budget-admission.integration.test.mjs',
    'packages/database/src/credential-vault-repository.integration.test.mjs',
    'packages/database/src/delegation-reference.integration.test.mjs',
    'packages/database/src/execution-event-repository.integration.test.mjs',
    'packages/database/src/fresh-schema-bootstrap.integration.test.mjs',
    'packages/database/src/graph-definition-repository.integration.test.mjs',
    'packages/database/src/hosted-graph-operations.integration.test.mjs',
    'packages/database/src/integration.test.mjs',
    'packages/database/src/legacy-drain-fence-repository.integration.test.mjs',
    'packages/database/src/memory-provenance-retention.integration.test.mjs',
    'packages/database/src/migrator-ddl-probe.integration.test.mjs',
    'packages/database/src/model-selection-repository.integration.test.mjs',
    'packages/database/src/operations-measurements.integration.test.mjs',
    'packages/database/src/pool-teardown.integration.test.mjs',
    'packages/database/src/project-state-initialization.integration.test.mjs',
    'packages/database/src/retention-ancestry.integration.test.mjs',
    'packages/database/src/retention-claim-budget.integration.test.mjs',
    'packages/database/src/retention-claim-lock-order.integration.test.mjs',
    'packages/database/src/retention-hold-activation.integration.test.mjs',
    'packages/database/src/retention-hold-operator.integration.test.mjs',
    'packages/database/src/retention-hold-owner-activation.integration.test.mjs',
    'packages/database/src/retention-hold-repository.integration.test.mjs',
    'packages/database/src/retention-reference-windows.integration.test.mjs',
    'packages/database/src/runtime-node-credential-binding.integration.test.mjs',
    'packages/database/src/runtime-node-credential-restricted.integration.test.mjs',
    'packages/database/src/runtime-node-identity-repository.integration.test.mjs',
    'packages/database/src/scoped-migrations.integration.test.mjs',
    'packages/database/src/tool-repositories.integration.test.mjs',
    'packages/database/src/usage-store.integration.test.mjs',
    'packages/database/src/workspace-catalog.integration.test.mjs',
    'packages/database/src/workspace-execution-scope-version-pairing.integration.test.mjs',
    'packages/database/src/workspace-execution-scope.integration.test.mjs',
    'packages/langgraph-adapter/src/postgres-checkpointer.integration.test.mjs',
    'packages/profile-portability/src/postgres.integration.test.mjs',
    'packages/testing/src/postgres.integration.test.mjs',
    'tests/acp-remote-device-postgres.integration.test.mjs',
    'tests/child-progress-scanner.integration.test.mjs',
    'tests/child-progress-sqlite-feed-replay.integration.test.mjs',
    'tests/langgraph-retirement-inventory-pg.integration.test.mjs',
    'tests/langgraph-retirement-status-adapter.integration.test.mjs',
    'tests/memory-process-loss.integration.test.mjs',
    'tests/runtime-node-credential-revocation.integration.test.mjs',
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
    'tests/child-progress-two-siblings-composition.test.mjs',
    'tests/child-runtime-budget-admission.test.mjs',
    'tests/pi-child-continuation-sqlite.test.mjs',
    'tests/pi-durable-child-host.test.mjs',
    'tests/pi-durable-child-mapping-recovery.test.mjs',
    'tests/delegation-receipt-retention-restart.test.mjs',
    'tests/delegation-interaction-publication-restart.test.mjs',
    'tests/pi-durable-delegation-recovery.test.mjs',
    'tests/pi-durable-canonical-authority.test.mjs',
    'tests/pi-durable-production-child-composition.test.mjs',
    'tests/pi-durable-production-child-bridge-recovery.test.mjs',
    'tests/pi-durable-execution-model-composition.test.mjs',
    'tests/pi-durable-governed-child-composition.test.mjs',
    'tests/pi-durable-compaction-governed-dispatch.test.mjs',
    'tests/pi-durable-governed-publisher-regression.test.mjs',
    'tests/j1-unfinished-child-process-restart.test.mjs',
    'tests/j1-native-child-store-restart.test.mjs',
    'tests/pi-durable-workspace-scope.test.mjs',
    'tests/pi-production-management-authority.test.mjs',
    'tests/pi-production-management-forwarding.test.mjs',
    'tests/pi-production-runtime-startup.test.mjs',
    'tests/pi-production-factory.test.mjs',
    'tests/profile-recovery-pi-lead-restart.test.mjs',
    'tests/pi-byo-model-authority.test.mjs',
    'tests/service-lifecycle-e2e.test.mjs',
    'tests/acp-remote-shared-provider.test.mjs',
    'tests/acp-remote-device-retention.test.mjs',
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
    'tests/docker-pull-backoff.test.mjs',
    'tests/digest-writer-guard.test.mjs',
    'tests/e2e-shards.test.mjs',
    'tests/foundation.test.mjs',
    'tests/infrastructure.test.mjs',
    'tests/integration-shards.test.mjs',
    'tests/integration-runner-lifecycle.test.mjs',
    'tests/hosted-compose-lifecycle.test.mjs',
    'tests/hosted-graph-qualification.test.mjs',
    'tests/langgraph-retirement-inventory.test.mjs',
    'tests/langgraph-retirement-status-adapter.test.mjs',
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
    'tests/skill-library.test.mjs',
    'tests/m11-recovery-rpo-rto.test.mjs',
    'tests/m11-retention-apply-cli.test.mjs',
    'tests/m11-retention-class-registry.test.mjs',
    'tests/m11-retention-hold-operator.test.mjs',
    'tests/m11-retention-restore-reapply.test.mjs',
    'tests/railway-production-plan.test.mjs',
    'tests/release-pr-readiness.test.mjs',
    'tests/replacement-compatibility.test.mjs',
    'tests/repository.test.mjs',
    'tests/task-cache-qualification.test.mjs',
    'tests/workspace-tooling.test.mjs',
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
      `uses: 0xPlayerOne\\/code-foundry\\/\\.github\\/workflows\\/validation\\.yml@${sharedValidationRef}(?:\\s|$)`
    )
  )
  assert.match(validation, new RegExp(`runtime-ref: ${runtimeRef}\\s*$`, 'm'))
  const validationJob = validation
    .split('\n  validation_runtime:\n')[1]
    .split('\n  postgres_qualification:')[0]
  const callerPermissions = validationJob.match(/permissions:\n((?:      [a-z-]+: [a-z]+\n)+)/)?.[1]
  assert.ok(callerPermissions, 'validation caller must declare its permission set')
  assert.deepEqual(
    callerPermissions
      .trim()
      .split('\n')
      .map((permission) => permission.trim())
      .toSorted(),
    [
      'actions: read',
      'contents: read',
      'issues: read',
      'packages: read',
      'security-events: write',
    ].toSorted()
  )
  assert.equal((validation.match(/vars\.CI_BILLING_PAUSED != 'true'/g) ?? []).length, 5)
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
  assert.match(runner, /'--concurrency=1', 'orch:test:integration'/)
  assert.match(runner, /async function runLocalIntegrationShards/)
  assert.match(runner, /INTEGRATION_SHARD_IDS\.map\(async \(shard\)/)
  assert.match(runner, /Local PostgreSQL integration shard .* starting/)
  assert.match(runner, /One or more local PostgreSQL integration shards failed/)
  assert.match(runner, /files remain serial within each shard/)
  assert.match(runner, /'stop', '--timeout', '60', 'postgres'/)
  // The sharded lane streams every file once and retains only bounded
  // diagnostics; explicit test timeouts still scale for remote execution.
  assert.match(runner, /remoteDatabase \? '120000' : '30000'/)
  assert.match(runner, /MAX_OUTPUT_TAIL_BYTES = 16 \* 1024/)
  assert.match(runner, /appendBoundedOutputTail/)
  assert.match(runner, /process\.stdout\.write\(chunk\)/)
  assert.match(runner, /process\.stderr\.write\(chunk\)/)
  assert.match(runner, /await runIntegrationFileStreaming/)
  assert.doesNotMatch(runner, /isRetryablePostgreSQLConnectionFailure/)
  assert.doesNotMatch(runner, /retrying it once/)
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
  assert.match(documentation, /no automatic file or slice rerun/)
  assert.match(documentation, /end-to-end/i)
  assert.match(documentation, /80%/)
  assert.match(documentation, /LCOV/)
  assert.match(documentation, /parallel/i)
})

test('the canonical validation job keeps the doctor contract and fails closed', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/validation.yml', import.meta.url),
    'utf8'
  )
  // Code Foundry 1.45.2 and 1.47.1 doctor both require this caller shape.
  assert.match(workflow, /^  validation:\n    name: Validation/m)
  const gate = workflow.split('\n  validation:\n')[1]?.split('\n  default-branch-codeql:')[0]
  assert.ok(gate)
  assert.match(gate, /^    name: Validation \/ Gate$/m)
  assert.equal((workflow.match(/^    name: Validation \/ Gate$/gm) ?? []).length, 1)
  assert.match(gate, /always\(\)/)
  assert.match(gate, /github\.event\.pull_request\.draft == false/)
  assert.match(gate, /permissions: \{\}/)
  assert.doesNotMatch(gate, /continue-on-error/)
  const script = gate.match(/        run: \|\n((?:          .*(?:\n|$))+)/)?.[1]
  assert.ok(script, 'the aggregate must execute its fail-closed result check')
  const results = ['success', 'failure', 'cancelled', 'skipped', '', 'unknown']
  for (const mode of results) {
    for (const validation of results) {
      for (const postgres of results) {
        const result = spawnSync('bash', ['-e', '-c', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            MODE_RESULT: mode,
            VALIDATION_RESULT: validation,
            POSTGRES_RESULT: postgres,
          },
        })
        assert.equal(
          result.status,
          mode === 'success' && validation === 'success' && postgres === 'success' ? 0 : 1,
          `mode=${mode} validation=${validation} postgres=${postgres}: ${result.stderr}`
        )
      }
    }
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
  assert.match(manifest.scripts['check:boundaries'], /bun scripts\/workspace-boundaries\.mjs/)
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

// The workspaces that carry no TypeScript project, and so are not checked by the
// pinned checker. Every entry has to say why, and the guard verifies each reason
// against the workspace itself, so a project cannot be taken out of the check by
// listing it here. The list is empty: every workspace in this repository holds
// TypeScript sources and a tsconfig project.
const nonTypeScriptWorkspaces = new Map()

// The invocation a checked project's typecheck script must be: the pinned Bun
// checker over that project's own tsconfig project, and nothing else. The `bun` in
// it is the pinned binary because every check task waits for the toolchain identity
// task, which verifies the node and bun bytes the tasks actually run. The form is
// exact so that a script which reaches the checker by another route, or reaches it
// over another project, is reported rather than accepted.
const pinnedCheckerInvocation = 'bun check -p tsconfig.json'

/** The TypeScript sources a workspace holds, relative to the workspace. */
const typeScriptSources = (directory) => {
  const source = join(directory, 'src')
  if (!existsSync(source)) return []
  return readdirSync(source, { withFileTypes: true, recursive: true })
    .filter((item) => item.isFile() && item.name.endsWith('.ts'))
    .map((item) => relative(directory, join(item.parentPath, item.name)))
}

/**
 * The declaration a workspace publishes for its consumers: the `types` entry, the
 * `exports["."].types` entry, or the `.d.ts` beside its `main`. This is the file a
 * consumer's checker resolves, so it is the file the build has to produce.
 */
const publishedDeclaration = (manifest) => {
  const exported = manifest.exports?.['.']
  if (typeof manifest.types === 'string') return manifest.types
  if (typeof exported?.types === 'string') return exported.types
  if (typeof manifest.main === 'string' && manifest.main.endsWith('.js')) {
    return `${manifest.main.slice(0, -3)}.d.ts`
  }
  return undefined
}

/**
 * The workspaces that are excluded from the check, and why that exclusion is not
 * honest. A workspace may only be excluded while it really carries no TypeScript
 * project, so the exclusion list cannot be used to hide one.
 */
const exclusionViolations = (workspacePackages, exclusions) => {
  const violations = []
  const byName = new Map(workspacePackages.map((entry) => [entry.manifest.name, entry]))
  for (const [name, reason] of exclusions) {
    const entry = byName.get(name)
    if (!entry) {
      violations.push(`${name} is excluded from the type checker but is not a workspace`)
      continue
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      violations.push(`${name} is excluded from the type checker without a reason`)
    }
    if (existsSync(join(entry.dir, 'tsconfig.json'))) {
      violations.push(`${name} is excluded from the type checker but holds a tsconfig project`)
    }
    if (typeScriptSources(entry.dir).length > 0) {
      violations.push(`${name} is excluded from the type checker but holds TypeScript sources`)
    }
  }
  return violations
}

/**
 * The contract every checked project must satisfy: the project declares a
 * typecheck script, that script really invokes the pinned checker, and the check
 * graph runs it, under the pinned toolchain, after the builds its workspace
 * dependencies need.
 *
 * The expected projects are enumerated from the workspace layout and the explicit
 * exclusion list, never from the manifests' own scripts, so a project whose script
 * was removed or renamed is still expected and this reports it.
 */
const checkerContractViolations = (root, workspacePackages, tasks, exclusions) => {
  const violations = []
  const byName = new Map(workspacePackages.map((entry) => [entry.manifest.name, entry]))
  for (const entry of workspacePackages) {
    const name = entry.manifest.name
    const short = name.replace('@control-plane/', '')
    if (exclusions.has(name)) continue
    const script = entry.manifest.scripts?.typecheck
    if (typeof script !== 'string') {
      violations.push(`${short} must declare a typecheck script`)
    } else if (script.trim() !== pinnedCheckerInvocation) {
      violations.push(
        `${short}'s typecheck script must invoke the pinned checker as "${pinnedCheckerInvocation}", not "${script}"`
      )
    }
    const task = tasks[`orch:${short}:typecheck`]
    if (!task) {
      violations.push(`${short} must have a typecheck task in the check graph`)
      continue
    }
    const directory = relative(root, entry.dir).replaceAll('\\', '/')
    if (!task.command.endsWith(`bun run --cwd ${directory} typecheck`)) {
      violations.push(`${short}'s typecheck task must run that project's own typecheck script`)
    }
    if (!task.dependsOn.includes('orch:toolchain')) {
      violations.push(`${short}'s check must wait for the pinned toolchain identity`)
    }
    const dependencies = Object.keys({
      ...entry.manifest.dependencies,
      ...entry.manifest.devDependencies,
      ...entry.manifest.peerDependencies,
      ...entry.manifest.optionalDependencies,
    }).filter((dependency) => byName.has(dependency))
    for (const dependency of dependencies) {
      const dependencyShort = byName.get(dependency).manifest.name.replace('@control-plane/', '')
      if (!task.dependsOn.includes(`orch:${dependencyShort}:build`)) {
        violations.push(
          `${short}'s check must wait for ${dependencyShort}'s build, so its generated declarations exist`
        )
      }
    }
  }
  return violations
}

test('the Bun type checker covers every TypeScript project, and it is not vacuous', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const workspacePackages = workspaces(root)
  const tasks = buildTasks(root, expectedId(root))

  // The expected checked projects are enumerated from the workspace layout and
  // the explicit exclusion list, not from the manifests' own typecheck scripts, so
  // a project that loses or renames its script is still expected to be checked.
  assert.deepEqual(
    exclusionViolations(workspacePackages, nonTypeScriptWorkspaces),
    [],
    'every workspace excluded from the type checker must really hold no TypeScript project'
  )
  const violations = checkerContractViolations(
    root,
    workspacePackages,
    tasks,
    nonTypeScriptWorkspaces
  )
  assert.deepEqual(violations, [], violations.join('; '))

  for (const entry of workspacePackages) {
    if (nonTypeScriptWorkspaces.has(entry.manifest.name)) continue
    const short = entry.manifest.name.replace('@control-plane/', '')
    // The project must be a TypeScript project in fact, or it has to be declared
    // as an exclusion with its reason.
    assert.ok(
      existsSync(join(entry.dir, 'tsconfig.json')),
      `${short} must hold a tsconfig project, or be declared an exclusion with its reason`
    )
    const sources = typeScriptSources(entry.dir)
    assert.ok(sources.length > 0, `${short} must hold TypeScript sources`)
    // The project must inherit the shared base, whose file set each package names
    // in its own include. The repository's root project names no files, so a
    // package that inherited it would pull its whole directory into the check
    // instead of the sources its include names.
    const project = await readJson(join(relative(root, entry.dir), 'tsconfig.json'))
    assert.match(
      String(project.extends ?? ''),
      /tsconfig\.base\.json$/,
      `${short} must extend the shared base, not a project that names no files`
    )
    // The project must not be vacuous either: the files its include names have to be
    // the package's own sources, or the checker would have nothing to read and would
    // report success for a package it never looked at.
    const include = Array.isArray(project.include) ? project.include : []
    assert.ok(
      sources.some((source) => include.some((pattern) => new Glob(pattern).match(source))),
      `${short}'s checked project must name at least one of its own sources`
    )
  }

  // The infrastructure project is checked by the root manifest rather than by a
  // workspace, so its invocation is asserted here.
  const rootManifest = await readJson('package.json')
  assert.equal(
    rootManifest.scripts['infra:typecheck'],
    'bun check -p tsconfig.infra.json',
    'the infrastructure project must be checked by the pinned checker'
  )

  // The aggregate the repository's own type check runs must build first, so the
  // declarations exist, and must include the openapi check.
  assert.deepEqual([...tasks['orch:check'].dependsOn].toSorted(), [
    'orch:build',
    'orch:openapi:check',
    'orch:typecheck',
  ])

  // The checker must not be vacuous: an intentional type error in an isolated
  // disposable project, checked under this repository's own base configuration, has
  // to fail the command, and a clean project has to pass it, so the failure below
  // means something. The disposable project lives outside the repository and is
  // removed afterwards, so no file in the tree is ever written.
  const disposable = await mkdtemp(join(tmpdir(), 'control-plane-typecheck-probe-'))
  const probeFile = join(disposable, 'probe.ts')
  const probeProject = join(disposable, 'tsconfig.json')
  try {
    await writeFile(join(disposable, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(
      probeProject,
      JSON.stringify({
        extends: join(root, 'tsconfig.base.json'),
        compilerOptions: {
          noEmit: true,
          typeRoots: [join(root, 'node_modules', '@types')],
        },
        include: ['probe.ts'],
      })
    )
    const runCheck = () =>
      spawnSync(process.execPath, ['check', '-p', probeProject], {
        cwd: disposable,
        encoding: 'utf8',
      })

    await writeFile(probeFile, 'export const cp1233TypecheckProbe: number = 1\n')
    const clean = runCheck()
    assert.equal(clean.status, 0, 'the clean disposable project must typecheck')

    await writeFile(probeFile, "export const cp1233TypecheckProbe: number = 'not a number'\n")
    const failed = runCheck()
    assert.notEqual(failed.status, 0, 'the checker must fail on an intentional type error')
    assert.match(
      `${failed.stdout}\n${failed.stderr}`,
      /probe\.ts/,
      'the failure must name the file that carries the intentional error'
    )
  } finally {
    await rm(disposable, { recursive: true, force: true })
  }
  assert.equal(existsSync(disposable), false, 'the disposable check must leave nothing behind')
})

test('the generated declarations the checker resolves are the ones the build produces', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const tasks = buildTasks(root, expectedId(root))
  const workspacePackages = workspaces(root)

  for (const entry of workspacePackages) {
    const short = entry.manifest.name.replace('@control-plane/', '')
    const declaration = publishedDeclaration(entry.manifest)
    assert.ok(
      declaration,
      `${short} must publish a declaration for its consumers, or name no types at all`
    )
    // The declaration has to be a build output, not a source: a declaration that
    // pointed into src/ would be checked as if it were the built shape, and a
    // consumer would resolve a shape the build never produced.
    const project = await readJson(join(relative(root, entry.dir), 'tsconfig.json'))
    const outDir = project.compilerOptions?.outDir
    assert.ok(outDir, `${short}'s project must declare the directory its build writes to`)
    const published = relative(entry.dir, join(entry.dir, declaration)).replaceAll('\\', '/')
    assert.ok(
      published.startsWith(`${outDir}/`),
      `${short} publishes ${published}, which is outside the ${outDir} its build writes to`
    )
    // The build task has to produce that directory, and the check has to wait for
    // it, or the checker resolves a declaration that is absent or stale.
    const build = tasks[`orch:${short}:build`]
    assert.ok(build, `${short} must have a build task in the check graph`)
    assert.ok(
      (build.cache?.output ?? []).includes(
        `${relative(root, entry.dir).replaceAll('\\', '/')}/${outDir}/**`
      ),
      `${short}'s build task must produce the ${outDir} its declaration is published from`
    )
  }

  // The consumers resolve those declarations through the workspace links, so every
  // workspace dependency has to be resolvable from the consumer that declares it.
  // Node resolution walks the consumer's own node_modules and then each ancestor's,
  // so a link anywhere on that path is enough.
  const byName = new Map(workspacePackages.map((entry) => [entry.manifest.name, entry]))
  const resolvable = (consumer, dependency) => {
    let directory = consumer.dir
    for (;;) {
      if (existsSync(join(directory, 'node_modules', dependency))) return true
      const parent = join(directory, '..')
      if (parent === directory) return false
      directory = parent
    }
  }
  for (const entry of workspacePackages) {
    const short = entry.manifest.name.replace('@control-plane/', '')
    const dependencies = new Set()
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(entry.manifest[field] ?? {})) {
        if (byName.has(name)) dependencies.add(name)
      }
    }
    for (const dependency of dependencies) {
      assert.ok(
        resolvable(entry, dependency),
        `${short} must resolve ${dependency} from its own node_modules or an ancestor's, or it cannot read its declaration`
      )
    }
  }
})

test('a project that loses, renames, or neuters its typecheck script fails the checker contract', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const workspacePackages = workspaces(root)

  // The contract is applied to a disposable copy of the workspace, so the mutation
  // is made on real manifests and the real check graph is built from them, while
  // the repository's own tree is never written.
  const fixture = await mkdtemp(join(tmpdir(), 'control-plane-typecheck-contract-'))
  try {
    for (const entry of workspacePackages) {
      const directory = join(fixture, relative(root, entry.dir))
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify(entry.manifest, null, 2))
    }
    const required = '@control-plane/tool-sdk'
    const short = 'tool-sdk'
    const original = workspacePackages.find((entry) => entry.manifest.name === required)
    assert.ok(original, 'the regression needs a project the repository checks')
    const originalScript = original.manifest.scripts.typecheck
    assert.equal(
      originalScript,
      pinnedCheckerInvocation,
      'the regression needs a project whose typecheck script invokes the pinned checker'
    )

    const contractFor = async (mutate) => {
      const manifestPath = join(fixture, relative(root, original.dir), 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      mutate(manifest.scripts)
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
      const entries = workspaces(fixture)
      const tasks = buildTasks(fixture, 'fixture-toolchain')
      return checkerContractViolations(fixture, entries, tasks, new Map())
    }

    // The control: the copy of the workspace satisfies the contract as it stands.
    assert.deepEqual(
      await contractFor(() => {}),
      [],
      'the workspace must satisfy the checker contract'
    )

    // The script removed: the project is still expected, so the contract must say so.
    assert.deepEqual(
      await contractFor((scripts) => delete scripts.typecheck),
      [
        `${short} must declare a typecheck script`,
        `${short} must have a typecheck task in the check graph`,
      ],
      'a project that loses its typecheck script must fail the contract'
    )

    // The script renamed: the project is still expected under its own name.
    assert.deepEqual(
      await contractFor((scripts) => {
        scripts.typechecks = scripts.typecheck
        delete scripts.typecheck
      }),
      [
        `${short} must declare a typecheck script`,
        `${short} must have a typecheck task in the check graph`,
      ],
      'a project that renames its typecheck script must fail the contract'
    )

    // A script that does nothing: the task exists, but the checker does not run.
    assert.deepEqual(
      await contractFor((scripts) => {
        scripts.typecheck = 'node -e 0'
      }),
      [
        `${short}'s typecheck script must invoke the pinned checker as "${pinnedCheckerInvocation}", not "node -e 0"`,
      ],
      'a project whose typecheck script does nothing must fail the contract'
    )

    // A script that checks with another compiler.
    assert.deepEqual(
      await contractFor((scripts) => {
        scripts.typecheck = 'tsc -p tsconfig.json'
      }),
      [
        `${short}'s typecheck script must invoke the pinned checker as "${pinnedCheckerInvocation}", not "tsc -p tsconfig.json"`,
      ],
      'a project that checks with another compiler must fail the contract'
    )

    // A script that checks the wrong project: the checker runs, but not over this
    // project's own sources.
    assert.deepEqual(
      await contractFor((scripts) => {
        scripts.typecheck = 'bun check -p tsconfig.base.json'
      }),
      [
        `${short}'s typecheck script must invoke the pinned checker as "${pinnedCheckerInvocation}", not "bun check -p tsconfig.base.json"`,
      ],
      'a project that checks another project must fail the contract'
    )

    // The exclusion list is the one way a project could leave the check, so it is
    // held to the same standard: a project that holds TypeScript cannot be
    // excluded from the check by naming it.
    assert.deepEqual(
      exclusionViolations(workspacePackages, new Map([[required, 'not a TypeScript project']])),
      [
        `${required} is excluded from the type checker but holds a tsconfig project`,
        `${required} is excluded from the type checker but holds TypeScript sources`,
      ],
      'an exclusion cannot hide a project that holds TypeScript'
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
  assert.equal(existsSync(fixture), false, 'the disposable fixture must leave nothing behind')
})
