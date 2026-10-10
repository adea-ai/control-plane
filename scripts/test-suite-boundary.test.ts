import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const root = resolve(import.meta.dir, '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const desktopPackageJson = JSON.parse(
  readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')
) as { version: string }

describe('test suite boundaries', () => {
  test('installs locked Playwright before downloading browsers for the Start host', () => {
    const workflow = Bun.YAML.parse(
      readFileSync(resolve(root, '.github/workflows/tanstack-start.yml'), 'utf8')
    ) as {
      jobs: { verify: { steps: { run?: string; id?: string; wait?: string[] }[] } }
    }
    const steps = workflow.jobs.verify.steps
    const dependencies = steps.findIndex((step) => step.run === 'bun install --frozen-lockfile')
    const browser = steps.findIndex((step) => step.id === 'playwright-install')
    const suite = steps.findIndex((step) => step.run?.includes('start:test:local'))
    const join = steps.findIndex((step) => step.wait?.includes('playwright-install'))

    expect(dependencies).toBeGreaterThanOrEqual(0)
    expect(browser).toBeGreaterThan(dependencies)
    expect(join).toBeGreaterThan(browser)
    expect(suite).toBeGreaterThan(join)
  })

  test('exposes Code Foundry entry points for every test category', () => {
    expect(packageJson.scripts.test).toBe('bun run test:unit')
    expect(packageJson.scripts['test:unit']).toContain('turbo run test')
    expect(packageJson.scripts['test:unit']).toContain('bun run test:coverage')
    expect(packageJson.scripts['test:integration']).toBe('bun scripts/test-integration.mjs')
    const integrationRunner = readFileSync(resolve(root, 'scripts/test-integration.mjs'), 'utf8')
    expect(integrationRunner).toContain('DATABASE_MIGRATION_URL')
    expect(integrationRunner).toContain("spawnSync('docker'")
    expect(integrationRunner).toContain("'compose'")
    // The package and route-flow locations live in the inventory module the runner imports.
    const integrationInventory = readFileSync(
      resolve(root, 'scripts/integration-inventory.mjs'),
      'utf8'
    )
    expect(integrationRunner).toContain("from './integration-inventory.mjs'")
    expect(integrationInventory).toContain("'tests', 'integration'")
    expect(integrationInventory).toContain("'apps', 'web', 'test', 'integration'")
    expect(packageJson.scripts['test:e2e']).toContain('playwright')
    // The Dev View chunk budget is a documented-raise ratchet, not a silent
    // dial: the check script carries the raise rationale, and this pin makes
    // any further raise a deliberate test edit.
    expect(packageJson.scripts['test:bundle:dev-view']).toContain(
      'node scripts/check-dev-view-bundle.mjs'
    )
    const bundleCheck = readFileSync(resolve(root, 'scripts/check-dev-view-bundle.mjs'), 'utf8')
    expect(bundleCheck).toContain('112 * 1024')
    expect(bundleCheck).toContain('34 * 1024')
    expect(bundleCheck).not.toContain('70 * 1024')
    // The visual pixel lane is a durable gate: the CI workflow must keep
    // running the workstation command against the committed baselines, and the
    // route/asset gate must keep booting the production build.
    expect(packageJson.scripts['test:e2e:visual']).toContain('conventional-workspace.spec.ts')
    const visualLane = readFileSync(resolve(root, '.github/workflows/visual-lane.yml'), 'utf8')
    expect(visualLane).toContain('bun run test:e2e:visual')
    expect(visualLane).toContain('mcr.microsoft.com/playwright:v1.63.0-noble')
    const startHostLane = readFileSync(
      resolve(root, '.github/workflows/tanstack-start.yml'),
      'utf8'
    )
    expect(startHostLane).toContain('start:check-routes')
    const playwrightConfig = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8')
    expect(playwrightConfig).toContain("'--use-angle=metal'")
    expect(playwrightConfig).toContain('const headless = process.env.PLAYWRIGHT_HEADLESS')
    expect(playwrightConfig).toContain('headless,')
    expect(packageJson.scripts.release).toBeUndefined()
    expect(packageJson.scripts['test:smoke']).toBeUndefined()
    expect(packageJson.scripts['native:smoke']).toBeUndefined()
  })

  test('executes inventory and settings product coverage in the normal E2E shard', () => {
    const runner = readFileSync(resolve(root, 'scripts/e2e-playwright.mjs'), 'utf8').replace(
      "import { spawnSync } from 'node:child_process'",
      ''
    )
    for (const [index, total] of [
      [1, 1],
      [2, 2],
    ]) {
      const calls: { command: string; args: string[] }[] = []
      runInNewContext(runner, {
        spawnSync: (command: string, args: string[]) => {
          calls.push({ command, args })
          return { status: 0 }
        },
        process: { env: { E2E_SHARD_INDEX: String(index), E2E_TOTAL_SHARDS: String(total) } },
        console,
      })
      const product = calls.find(
        ({ command, args }) =>
          command === 'playwright' && args.includes('apps/web/e2e/runtime-inventory.spec.ts')
      )
      expect(product).toBeDefined()
      expect(product!.args).toContain('apps/web/e2e/workspace-settings.spec.ts')
      if (total! > 1) {
        expect(product!.args).toContain('--shard')
        expect(product!.args).toContain(`${index}/${total}`)
      }
    }
  })

  test('keeps the cross-product session journeys (#1223) in the normal E2E shard', () => {
    const runner = readFileSync(resolve(root, 'scripts/e2e-playwright.mjs'), 'utf8').replace(
      "import { spawnSync } from 'node:child_process'",
      ''
    )
    const calls: { command: string; args: string[] }[] = []
    runInNewContext(runner, {
      spawnSync: (command: string, args: string[]) => {
        calls.push({ command, args })
        return { status: 0 }
      },
      process: { env: {} },
      console,
    })
    const journeys = calls.find(
      ({ command, args }) =>
        command === 'playwright' && args.includes('apps/web/e2e/chat-continuity.spec.ts')
    )
    expect(journeys).toBeDefined()
    expect(journeys!.args).toContain('apps/web/e2e/workspace-project-placement.spec.ts')
  })

  test('keeps the workspace creation-draft browser specs in the normal E2E shard exactly once', () => {
    const runner = readFileSync(resolve(root, 'scripts/e2e-playwright.mjs'), 'utf8').replace(
      "import { spawnSync } from 'node:child_process'",
      ''
    )
    const calls: { command: string; args: string[] }[] = []
    runInNewContext(runner, {
      spawnSync: (command: string, args: string[]) => {
        calls.push({ command, args })
        return { status: 0 }
      },
      process: { env: {} },
      console,
    })
    const suite = calls.find(
      ({ command, args }) =>
        command === 'playwright' && args.includes('apps/web/e2e/workspace-nav.spec.ts')
    )
    expect(suite).toBeDefined()
    for (const spec of [
      'apps/web/e2e/workspace-nav.spec.ts',
      'apps/web/e2e/workspace-creation-owner.spec.ts',
    ]) {
      expect(suite!.args.filter((arg) => arg === spec)).toHaveLength(1)
    }
  })

  test('pins the named M12 evidence lanes (#426) to durable harnesses', () => {
    // #426 requires named packaged/perf/security/soak evidence commands; the
    // release report cites these exact entry points, so package.json cannot
    // rename or drop them silently. This is the documented-raise surface for
    // them (package.json itself carries no comments).
    expect(packageJson.scripts['test:packaged']).toBe('bun scripts/test-dev-runtime-packaged.mjs')
    expect(packageJson.scripts['test:packaged:owner-journey']).toBe(
      'bun apps/desktop/shell/scripts/packaged-owner-journey.ts'
    )
    expect(
      existsSync(resolve(root, 'apps/desktop/shell/scripts/packaged-owner-journey.ts'))
    ).toBeTrue()
    // The umbrella names stay stable while the Dev Runtime lanes own the
    // harnesses: perf and soak delegate to the dev-runtime lane scripts, so
    // round counts (ADEA_DEV_RUNTIME_SOAK_ROUNDS) and budgets stay defined in
    // exactly one place.
    expect(packageJson.scripts['test:perf']).toBe('bun run test:performance:dev-runtime')
    expect(packageJson.scripts['test:soak']).toBe('bun run test:soak:dev-runtime')
    // Soak stays a bounded loop: rounds are parameterized through the
    // environment (default 20, hard-capped), the first failing round exits
    // nonzero, and every run retains its lane summary artifact.
    const soak = readFileSync(resolve(root, 'scripts/test-dev-runtime-soak.mjs'), 'utf8')
    expect(soak).toContain('ADEA_DEV_RUNTIME_SOAK_ROUNDS ?? 20')
    expect(soak).toContain('rounds > 1000')
    expect(soak).toContain("writeLaneSummary('soak'")
    // The #424 scale lane is a named durable harness: it seeds the production
    // registrar seams at 100 sessions / 1,000 processes and pins the issue's
    // measured budgets (one fixed-argv ps per pull within the named PID cap,
    // the 16 ms UI-task pipeline budget, the named 720-point metrics cap).
    // The budgets live in exactly one place, so relaxing one is a deliberate
    // edit to the harness plus this pin.
    expect(packageJson.scripts['test:scale']).toBe('bun run test:scale:dev-runtime')
    const scale = readFileSync(resolve(root, 'scripts/test-dev-runtime-scale.mjs'), 'utf8')
    expect(scale).toContain("writeLaneSummary('scale'")
    expect(scale).toContain('SAMPLE_MAX_PIDS')
    expect(scale).toContain('MAX_POINTS_PER_OWNER')
    expect(scale).toContain('HISTORY_WINDOW_MS')
    expect(scale).toContain('PULL_BUDGET_MS = 16')
    // The umbrella security entry runs the three desktop boundary scanners
    // (PKCE/callback, IPC surface, loopback origin) directly. There is no
    // scripts/security-* helper today; if one lands it must be wired into
    // this entry — an unwired file fails the sweep below.
    expect(packageJson.scripts['test:security']).toBe(
      'bun test scripts/desktop-auth-boundary.test.ts scripts/desktop-ipc-boundary.test.ts scripts/desktop-origin-boundary.test.ts'
    )
    const unwiredSecurity = readdirSync(resolve(root, 'scripts')).filter(
      (entry) =>
        /^security-.+\.mjs$/.test(entry) && !packageJson.scripts['test:security']?.includes(entry)
    )
    expect(unwiredSecurity).toEqual([])
  })

  test('enforces the repository coverage goal on durable core code', () => {
    expect(packageJson.scripts['test:coverage']).toBe(
      'bun test packages/auth/tests/unit packages/db/tests/unit packages/types/tests/execution-location.test.ts packages/types/tests/migration-snapshot.test.ts scripts/*.test.ts --coverage'
    )

    const bunfig = readFileSync(resolve(root, 'bunfig.toml'), 'utf8')
    expect(bunfig).toContain('coverageThreshold = { line = 0.8, function = 0.8 }')
    expect(bunfig).toContain('coverageSkipTestFiles = true')
    // The aggregate must measure this lane's own scope: generated build output
    // and desktop-shell sources (covered by the desktop suite, only imported
    // here by boundary scanners) would make the gate count unexecuted
    // darwin-only branches on Linux and drift under the threshold.
    expect(bunfig).toContain('coveragePathIgnorePatterns = ["**/dist/**", "apps/desktop/**"]')
    expect(bunfig).toContain('coverageReporter = ["text", "lcov"]')
    expect(bunfig).toContain('coverageDir = "coverage"')

    const codeFoundry = readFileSync(resolve(root, '.github/code-foundry.yml'), 'utf8')
    expect(codeFoundry).toContain('coverage_minimum: 80')
  })

  test('runs the database-backed integration category in the Neon lane', () => {
    const neonWorkflow = readFileSync(resolve(root, '.github/workflows/neon_workflow.yml'), 'utf8')
    expect(neonWorkflow).toContain('bun run test:integration')
    expect(neonWorkflow).not.toContain('packages/db test:integration')
    expect(neonWorkflow).not.toContain('packages/auth test:integration')
  })

  test('partitions the integration inventory explicitly instead of delegating to Bun --shard', () => {
    const runner = readFileSync(resolve(root, 'scripts/test-integration.mjs'), 'utf8')
    expect(runner).toContain("from './integration-inventory.mjs'")
    expect(runner).not.toContain('--shard=')
    expect(runner).toContain('...plan.packageFiles')
    expect(runner).toContain('plan.routeFiles.length > 0')
  })

  test('builds desktop releases entirely on GitHub-hosted runners', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release-assets.yml'), 'utf8')
    expect(workflow).not.toContain('self-hosted')
    expect(workflow).not.toContain('self_hosted')
    expect(workflow).not.toContain('CI_BILLING_PAUSED')
    expect(workflow).not.toContain('cargo-xwin')
    expect(workflow).not.toContain('CI_BILLING_GATE_BACKUP')
    // Bash-syntax steps must not fall back to the Windows default shell.
    expect(workflow).toContain('defaults:')
    expect(workflow).toContain('shell: bash')
    // The Electrobun lane ships macOS ARM64. Windows and Linux stable
    // packaging has no CI-verified installer story yet and stays out of the
    // matrix instead of shipping unverified archives.
    expect(workflow).toContain('runs-on: macos-14')
    expect(workflow).not.toContain('runner: ubuntu-24.04')
    expect(workflow).not.toContain('runner: windows-latest')
    expect(workflow).toContain('node scripts/release-notes.mjs')
    expect(workflow).toContain('bun run --cwd packages/types build')
    expect(workflow).toContain('bun run shell:client:build')
    const releaseVersionStep = workflow.indexOf('name: Set desktop version from release tag')
    const installDependenciesStep = workflow.indexOf('name: Install dependencies')
    const installShellDependenciesStep = workflow.indexOf('name: Install shell dependencies')
    const buildBundleStep = workflow.indexOf('name: Build shell bundle (unsigned, stable)')
    expect(releaseVersionStep).toBeGreaterThan(workflow.indexOf('name: Checkout release'))
    expect(installDependenciesStep).toBeLessThan(installShellDependenciesStep)
    expect(installShellDependenciesStep).toBeLessThan(releaseVersionStep)
    expect(releaseVersionStep).toBeLessThan(buildBundleStep)
    expect(workflow).toContain("if: ${{ needs.validate-release.outputs.release_version != '' }}")
    expect(workflow).toContain(
      'RELEASE_VERSION: ${{ needs.validate-release.outputs.release_version }}'
    )
    expect(workflow).toContain('node scripts/set-desktop-release-version.mjs "$RELEASE_VERSION"')
    expect(workflow).toContain('packaged_version')
    expect(workflow).toContain(
      'node ../../../scripts/check-desktop-payload-version.mjs "$payload" "$RELEASE_VERSION"'
    )
    expect(workflow).not.toContain('readFileSync(process.argv[1], "utf8")')
    const electrobunConfig = readFileSync(
      resolve(root, 'apps/desktop/shell/electrobun.config.ts'),
      'utf8'
    )
    expect(electrobunConfig).toContain("import desktopPackage from '../package.json'")
    expect(electrobunConfig).toContain('version: desktopPackage.version')
    // Release bundles build in stable mode; the default dev env only ever
    // produces build/dev-* bundles, which must never reach a release.
    expect(workflow).toContain('bunx --bun electrobun build --env=stable')
    // The supervised terminal sidecar is a bundled component: the release
    // build must stage its bundle before electrobun's copy stage picks it up
    // (apps/desktop/scripts/shell.mjs is the dev-side source of truth), and
    // the verify gate must assert the staged artifact reached the payload —
    // without it the packaged shell boots truthfully without supervision.
    expect(workflow).toContain('bun build src/dev-runtime/terminal/sidecar/entry.ts')
    expect(workflow).toContain(
      "grep -qx 'Adea.app/Contents/Resources/app/dev-runtime-sidecar/entry.js'"
    )
    expect(workflow).toContain('apps/desktop/shell/artifacts/')
    // The payload must keep rejecting Electrobun's own unsigned
    // `*-update.json`; the update channel is the signed `latest.json` this
    // lane publishes beside the archives, so the gate is the contract rather
    // than any TODO marker.
    expect(workflow).toContain('The bundle payload must not carry an updater manifest')
    // A failed shell build fails the lane; no retry-and-continue pattern may
    // soften it back into shipping asset-free releases.
    expect(workflow).not.toContain('continue-on-error')
    expect(workflow).not.toContain('Retry desktop bundle build')
    // The verify gate asserts the bundle structure, not just an asset count.
    expect(workflow).toContain('Chromium Embedded Framework.framework/Chromium Embedded Framework')
    expect(workflow).toContain('Adea.app/Contents/Resources/app/client/index.html')
    expect(workflow).toContain('Adea.app/Contents/Resources/AppIcon.icns')
    expect(workflow).toContain('Verify the signed update feed is published')
    // The Rust lane is gone: no tauri action, signing secrets, or updater
    // channel may come back. The lane publishes and signs the latest.json
    // feed, but it must not poll it (the shell does that at runtime).
    expect(workflow).not.toContain('tauri')
    expect(workflow).not.toContain('cargo')
    expect(workflow).not.toContain('Verify updater channel')
    expect(workflow).not.toContain('releases/latest/download/latest.json')
    expect(workflow).not.toContain('r2.cloudflarestorage.com')
    expect(workflow).not.toContain('updates.adea.dev')
    expect(workflow).not.toContain('name: desktop-updater-pages')
    expect(workflow).not.toContain('deploy-pages')
    expect(workflow).not.toContain('name: github-pages')
    expect(workflow).not.toContain('brew install awscli')
    expect(workflow).not.toContain('release-runner')
    expect(existsSync(resolve(root, '.github/release-runner'))).toBeFalse()
    expect(existsSync(resolve(root, 'scripts/manual-release.mjs'))).toBeFalse()
    expect(existsSync(resolve(root, 'scripts/release-runners.mjs'))).toBeFalse()
    expect(existsSync(resolve(root, 'scripts/native-smoke.mjs'))).toBeFalse()
  })

  test('verifies dev release assets when canonical release notes are skipped', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release-assets.yml'), 'utf8')
    const verifyAssetsJob = workflow.slice(workflow.indexOf('\n  verify-assets:\n'))
    const guard = verifyAssetsJob.match(/^    if: \$\{\{ (.+) \}\}$/m)?.[1] ?? ''
    const javascriptGuard = guard.replaceAll(
      'needs.publish-release-notes',
      "needs['publish-release-notes']"
    )
    const hasStatusCheck = /\b(?:always|cancelled|failure|success)\s*\(/.test(javascriptGuard)
    const effectiveGuard = hasStatusCheck ? javascriptGuard : `success() && (${javascriptGuard})`
    const shouldVerify = (
      eventTag: string,
      inputTag: string,
      desktopResult: string,
      notesResult: string,
      isCancelled: boolean
    ) =>
      runInNewContext(effectiveGuard, {
        cancelled: () => isCancelled,
        github: { event: { release: { tag_name: eventTag } } },
        inputs: { tag: inputTag },
        needs: {
          'validate-release': { result: 'success' },
          desktop: { result: desktopResult },
          'publish-release-notes': { result: notesResult },
        },
        success: () => desktopResult === 'success' && notesResult === 'success',
      })

    // GitHub injects success() unless a status-check function is present. The
    // simulated success() is false when the Dev-only notes job is skipped.
    // Explicit !cancelled() permits that case without admitting failed or
    // cancelled releases.
    expect(shouldVerify('', 'v1.43.0-dev.47', 'success', 'skipped', false)).toBe(true)
    expect(shouldVerify('v1.43.0', '', 'success', 'success', false)).toBe(true)
    expect(shouldVerify('', 'v1.43.0-dev.47', 'failure', 'skipped', false)).toBe(false)
    expect(shouldVerify('', 'v1.43.0-dev.47', 'success', 'skipped', true)).toBe(false)
    expect(shouldVerify('', 'v1.43.0-dev.47', 'success', 'failure', false)).toBe(false)
    expect(shouldVerify('', '', 'success', 'skipped', false)).toBe(false)
  })

  test('dispatches the desktop asset lane for dev releases created with GITHUB_TOKEN', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/dev-build.yml'), 'utf8')
    expect(workflow).toContain('permissions:')
    expect(workflow).toContain('actions: write')
    expect(workflow).toContain('contents: write')
    const releaseCreate = workflow.indexOf('gh release create "$tag"')
    const assetDispatch = workflow.indexOf('gh workflow run release-assets.yml')
    expect(releaseCreate).toBeGreaterThanOrEqual(0)
    expect(assetDispatch).toBeGreaterThan(releaseCreate)
    expect(workflow).toContain('--ref main')
    expect(workflow).toContain('-f tag="$tag"')
    // Re-running a dev job should repair a release left without its signed
    // manifest or platform archive instead of treating the tag as complete.
    expect(workflow).toContain('latest.json')
    expect(workflow).toContain('Adea-${tag}-macos-arm64.app.tar.zst')
  })

  test('anchors dev release versions to the checked-out desktop source', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/dev-build.yml'), 'utf8')
    const checkout = workflow.indexOf('name: Check out the source version')
    const publish = workflow.indexOf('name: Publish the dev pre-release')

    expect(checkout).toBeGreaterThanOrEqual(0)
    expect(publish).toBeGreaterThan(checkout)
    expect(workflow).toContain('ref: ${{ github.sha }}')
    expect(workflow).toContain('apps/desktop/package.json')
    expect(workflow).toContain('tag="v${base}-dev.${RUN_NUMBER}"')
    expect(workflow).not.toContain('repos/$repo/releases/latest')
    expect(workflow).not.toContain('cat apps/desktop/package.json')

    const versionAssignment = workflow.match(
      /base="\$\(\s*jq -er '([\s\S]*?)'\s+apps\/desktop\/package\.json\s*\)"/
    )
    expect(versionAssignment).not.toBeNull()
    const versionFilter = versionAssignment![1]
    const fromFixture = (version: unknown) =>
      execFileSync('jq', ['-er', versionFilter], {
        input: JSON.stringify({ version }),
        encoding: 'utf8',
      }).trim()

    expect(fromFixture('0.66.1')).toBe('0.66.1')
    expect(fromFixture('0.80.0')).toBe('0.80.0')
    for (const invalidVersion of ['0.80.0-dev.33', 'not-semver', '0.0.0', 17]) {
      expect(() => fromFixture(invalidVersion)).toThrow()
    }

    const extractedVersion = execFileSync(
      'jq',
      ['-er', versionFilter, resolve(root, 'apps/desktop/package.json')],
      { encoding: 'utf8' }
    ).trim()
    expect(extractedVersion).toBe(desktopPackageJson.version)
    expect(extractedVersion).toMatch(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
    expect(extractedVersion).not.toBe('0.0.0')
    expect(`v${extractedVersion}-dev.17`).toMatch(/^v[0-9]+\.[0-9]+\.[0-9]+-dev\.17$/)
  })

  test('keeps the Electrobun icon source the release lane builds from', () => {
    // Hutch converts `apps/desktop/shell/icon.iconset` into the bundle's
    // AppIcon.icns while packing, so the icon reaches the app archive and the
    // disk image instead of being stamped onto the bundle after packing.
    // Removing the iconset silently ships an icon-less bundle again.
    const iconset = resolve(root, 'apps/desktop/shell/icon.iconset')
    expect(existsSync(iconset)).toBeTrue()
    expect(existsSync(resolve(iconset, 'icon_512x512@2x.png'))).toBeTrue()
    // The old post-build stamp workaround must not come back: it cannot reach
    // the already-packed artifacts.
    const shellScript = readFileSync(resolve(root, 'apps/desktop/scripts/shell.mjs'), 'utf8')
    expect(shellScript).not.toContain('stampAppIcons')
  })

  test('keeps one canonical changelog and versions every private workspace in lockstep', () => {
    const releaseConfig = JSON.parse(
      readFileSync(resolve(root, 'release-please-config.json'), 'utf8')
    )
    const extraFiles = new Set(
      releaseConfig['extra-files'].map((entry: { path: string }) => entry.path)
    )

    // The previous Rust crate's Cargo manifests are gone; a release-please
    // updater that still points at them would silently stop versioning a file.
    expect([...extraFiles].filter((path: string) => path.includes('src-tauri'))).toEqual([])
    expect([...extraFiles].filter((path: string) => /Cargo\.(toml|lock)$/.test(path))).toEqual([])

    for (const workspaceGroup of ['apps', 'packages']) {
      for (const workspace of readdirSync(resolve(root, workspaceGroup))) {
        const packagePath = `${workspaceGroup}/${workspace}/package.json`
        if (!existsSync(resolve(root, packagePath))) continue
        expect(extraFiles.has(packagePath)).toBeTrue()
        expect(existsSync(resolve(root, workspaceGroup, workspace, 'CHANGELOG.md'))).toBeFalse()
      }
    }
  })
})
