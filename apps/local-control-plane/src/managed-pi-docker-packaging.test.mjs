import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'

const readRepositoryFile = (path) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')

test('Simple managed Pi packaging is opt-in, pinned, and keeps credentials external', async () => {
  const [
    defaultCompose,
    managedPiCompose,
    certificationCompose,
    dockerfile,
    piPackage,
    certificationScript,
    managedPiEntrypoint,
    managedPiConfigSync,
    managedPiVersionPreflight,
    runbook,
  ] = await Promise.all([
    readRepositoryFile('infrastructure/compose/compose.yaml'),
    readRepositoryFile('infrastructure/compose/compose.managed-pi.yaml'),
    readRepositoryFile('infrastructure/compose/compose.native-pi-test.yaml'),
    readRepositoryFile('infrastructure/containers/Dockerfile.hosted'),
    readRepositoryFile('infrastructure/containers/managed-pi/package.json'),
    readRepositoryFile('scripts/certify-m11-managed-pi.mjs'),
    readRepositoryFile('infrastructure/containers/managed-pi-entrypoint.sh'),
    readRepositoryFile('infrastructure/containers/managed-pi/sync-agent-config.mjs'),
    readRepositoryFile('infrastructure/containers/managed-pi/version-preflight.mjs'),
    readRepositoryFile('infrastructure/compose/README.md'),
  ])
  const packageManifest = JSON.parse(piPackage)
  const simpleBlock = defaultCompose.slice(
    defaultCompose.indexOf('  control-plane-simple:'),
    defaultCompose.indexOf('\n  postgres:')
  )
  const managedPiBlock = managedPiCompose.slice(managedPiCompose.indexOf('  control-plane-simple:'))
  assert.doesNotMatch(simpleBlock, /CONTROL_PLANE_LOCAL_RUNTIME|MANAGED_PI|pi-agent/)
  assert.match(managedPiBlock, /target:\s*runtime-managed-pi/)
  assert.match(managedPiBlock, /CONTROL_PLANE_LOCAL_RUNTIME:\s*managed-pi/)
  assert.match(managedPiBlock, /CONTROL_PLANE_MANAGED_PI_EXECUTABLE:\s*\/usr\/local\/bin\/pi/)
  assert.match(managedPiBlock, /CONTROL_PLANE_MANAGED_PI_PROVIDER:\s*\$\{[^}]+:\?[^}]+\}/)
  assert.match(managedPiBlock, /CONTROL_PLANE_MANAGED_PI_DATA_RESIDENCY:\s*\$\{[^}]+:\?[^}]+\}/)
  assert.match(
    managedPiBlock,
    /CONTROL_PLANE_PI_AGENT_CONFIG_DIRECTORY:\s*\/run\/control-plane\/pi-agent-config/
  )
  assert.match(managedPiBlock, /PI_CODING_AGENT_DIR:\s*\/var\/lib\/control-plane\/pi-agent/)
  assert.match(managedPiBlock, /source:\s*\$\{CONTROL_PLANE_PI_AGENT_DIRECTORY:\?[^}]+\}/)
  assert.match(
    managedPiBlock,
    /target:\s*\/run\/control-plane\/pi-agent-config\s*\n\s+read_only:\s*true/
  )
  assert.equal(packageManifest.dependencies['@earendil-works/pi-coding-agent'], '0.84.2')
  assert.equal(packageManifest.overrides.undici, '8.10.2')
  assert.match(
    dockerfile,
    /^FROM node:24\.21\.0-bookworm-slim@sha256:[a-f0-9]{64} AS node-runtime$/m
  )
  assert.match(
    dockerfile,
    /COPY --from=dependencies \/etc\/ssl\/certs\/ca-certificates\.crt \/etc\/ssl\/certs\/ca-certificates\.crt/
  )
  assert.match(dockerfile, /FROM node-runtime AS runtime-managed-pi\b/)
  assert.match(dockerfile, /FROM runtime-managed-pi AS runtime-managed-pi-certification\b/)
  assert.match(
    dockerfile,
    /bun install --cwd \/opt\/managed-pi --frozen-lockfile --production --ignore-scripts/
  )
  assert.match(dockerfile, /COPY --chown=1000:1000 scripts\/ \/workspace\/scripts\//)
  assert.match(dockerfile, /COPY --chown=1000:1000 tests\/ \/workspace\/tests\//)
  assert.match(
    dockerfile,
    /COPY infrastructure\/containers\/managed-pi-entrypoint\.sh \/usr\/local\/bin\/managed-pi-entrypoint/
  )
  assert.match(
    dockerfile,
    /COPY infrastructure\/containers\/managed-pi\/sync-agent-config\.mjs \/usr\/local\/bin\/sync-managed-pi-config\.mjs/
  )
  assert.match(
    dockerfile,
    /COPY infrastructure\/containers\/managed-pi\/version-preflight\.mjs \/usr\/local\/lib\/control-plane\/managed-pi-version-preflight\.mjs/
  )
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/managed-pi-entrypoint"\]/)
  assert.match(
    dockerfile,
    /chmod .*\/usr\/local\/lib\/control-plane\/managed-pi-version-preflight\.mjs/
  )
  assert.match(managedPiEntrypoint, /sync-managed-pi-config\.mjs/)
  assert.match(managedPiEntrypoint, /exec \/usr\/local\/bin\/control-plane-entrypoint/)
  assert.match(
    managedPiEntrypoint,
    /env -i PATH="\$PATH" PI_CODING_AGENT_DIR="\$PI_CODING_AGENT_DIR"/
  )
  assert.match(managedPiEntrypoint, /CONTROL_PLANE_MANAGED_PI_EXECUTABLE/)
  assert.ok(
    managedPiEntrypoint.indexOf('sync-managed-pi-config.mjs') <
      managedPiEntrypoint.indexOf('managed-pi-version-preflight.mjs') &&
      managedPiEntrypoint.indexOf('managed-pi-version-preflight.mjs') <
        managedPiEntrypoint.indexOf('exec /usr/local/bin/control-plane-entrypoint'),
    'startup must sync config, preflight Pi, then start Control Plane'
  )
  assert.match(managedPiVersionPreflight, /PINNED_PI_VERSION = '0\.84\.2'/)
  assert.match(managedPiVersionPreflight, /PI_VERSION_PREFLIGHT_TIMEOUT_MS = 30_000/)
  assert.match(managedPiVersionPreflight, /PI_VERSION_PREFLIGHT_MAX_OUTPUT_BYTES = 16_384/)
  assert.match(managedPiVersionPreflight, /PI_CODING_AGENT_DIR: agentDirectory/)
  assert.match(managedPiVersionPreflight, /PATH: pathValue/)
  assert.match(managedPiVersionPreflight, /process\.stderr\.write\(`\$\{result\.code\}\\n`\)/)
  assert.match(managedPiConfigSync, /auth\.json.*models\.json.*settings\.json/)
  assert.match(managedPiConfigSync, /isSymbolicLink\(\)/)
  assert.match(managedPiConfigSync, /isFile\(\)/)
  assert.match(managedPiConfigSync, /isDirectory\(\)/)
  assert.match(managedPiConfigSync, /mode & 0o077/)
  assert.match(managedPiConfigSync, /0o600/)
  assert.match(managedPiConfigSync, /unlink/)
  assert.match(certificationCompose, /profiles:\s*\[native-pi-test\]/)
  assert.match(
    certificationCompose,
    /M11_REAL_PI_DURABLE_EXECUTION:\s*\$\{M11_REAL_PI_DURABLE_EXECUTION:-embedded-sqlite\}/
  )
  assert.match(certificationCompose, /network_mode:\s*none/)
  assert.match(certificationCompose, /read_only:\s*true/)
  assert.match(certificationCompose, /\/var\/lib\/control-plane:rw/)
  assert.match(certificationCompose, /target: runtime-managed-pi-certification/)
  assert.match(runbook, /compose\.managed-pi\.yaml/)
  assert.match(runbook, /M11 real-Pi Docker certification/)
  assert.match(runbook, /M11_REAL_PI_DURABLE_EXECUTION=restate/)
  assert.match(runbook, /recreat.*synchroniz/i)
  assert.match(runbook, /runtime copy.*overwritten/i)
  assert.match(runbook, /OAuth/i)
  assert.match(
    certificationScript,
    /const durableExecution = process\.env\.M11_REAL_PI_DURABLE_EXECUTION/
  )
  assert.match(
    certificationScript,
    /durableExecution === 'embedded-sqlite' \|\| durableExecution === 'restate'/
  )
  assert.match(certificationScript, /join\(agentSourceDirectory, 'auth\.json'\)/)
  assert.match(certificationScript, /sync-managed-pi-config\.mjs/)
  assert.match(certificationScript, /managed-pi-version-preflight\.mjs/)
  assert.match(certificationScript, /timeout: 32_000/)
  assert.match(runbook, /30-second Pi version preflight/i)
  assert.doesNotMatch(certificationScript, /apiKey: 'fixture-only'/)
  assert.match(
    certificationScript,
    /const localTestPattern = `runs the packaged managed Pi RPC client through Local \$\{durableExecution\}`/
  )
  assert.match(
    certificationScript,
    /workflow: durableExecution === 'restate' \? 'local-restate' : 'embedded-sqlite'/
  )
  assert.doesNotMatch(
    `${managedPiCompose}\n${certificationCompose}`,
    /(?:OPENAI|ANTHROPIC|GOOGLE)_API_KEY:/
  )
  assert.doesNotMatch(dockerfile, /(?:OPENAI|ANTHROPIC|GOOGLE)_API_KEY/)
})

test('managed Pi config sync rotates and removes copied credentials without exposing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-pi-config-sync-'))
  const source = join(directory, 'source')
  const runtime = join(directory, 'runtime')
  const outsideFile = join(directory, 'outside.json')
  const script = fileURLToPath(
    new URL('../../../infrastructure/containers/managed-pi/sync-agent-config.mjs', import.meta.url)
  )
  const runSync = () =>
    spawnSync('node', [script, source, runtime], {
      encoding: 'utf8',
      timeout: 15000,
    })

  try {
    await mkdir(source, { mode: 0o700 })
    await chmod(source, 0o700)
    await mkdir(runtime, { mode: 0o700 })
    await chmod(runtime, 0o700)
    await writeFile(
      join(source, 'auth.json'),
      '{"fixture":{"type":"api_key","key":"fixture-only"}}',
      {
        mode: 0o600,
      }
    )
    await writeFile(join(source, 'models.json'), '{"fixture":true}', { mode: 0o600 })
    await writeFile(join(source, 'ignored.json'), '{"unmanaged":true}', { mode: 0o600 })
    await writeFile(join(runtime, 'runtime-state.json'), '{"kept":true}', { mode: 0o600 })

    const initial = runSync()
    assert.equal(initial.status, 0, initial.stderr)
    assert.equal(
      await readFile(join(runtime, 'auth.json'), 'utf8'),
      '{"fixture":{"type":"api_key","key":"fixture-only"}}'
    )
    assert.equal((await lstat(join(runtime, 'auth.json'))).mode & 0o777, 0o600)
    assert.equal(await readFile(join(runtime, 'runtime-state.json'), 'utf8'), '{"kept":true}')
    await assert.rejects(readFile(join(runtime, 'ignored.json')), { code: 'ENOENT' })

    await writeFile(
      join(source, 'auth.json'),
      '{"fixture":{"type":"api_key","key":"rotated-fixture"}}',
      {
        mode: 0o600,
      }
    )
    const rotated = runSync()
    assert.equal(rotated.status, 0, rotated.stderr)
    assert.match(await readFile(join(runtime, 'auth.json'), 'utf8'), /rotated-fixture/)

    await unlink(join(source, 'auth.json'))
    const removed = runSync()
    assert.equal(removed.status, 0, removed.stderr)
    await assert.rejects(readFile(join(runtime, 'auth.json')), { code: 'ENOENT' })

    await writeFile(outsideFile, '{"outside":true}', { mode: 0o600 })
    await symlink(outsideFile, join(source, 'settings.json'))
    const linked = runSync()
    assert.notEqual(linked.status, 0)
    assert.match(linked.stderr, /MANAGED_PI_CONFIG_SOURCE_NOT_REGULAR/)
    assert.doesNotMatch(linked.stderr, /fixture-only|rotated-fixture/)
    await unlink(join(source, 'settings.json'))

    await symlink(outsideFile, join(runtime, 'settings.json'))
    const linkedDestination = runSync()
    assert.notEqual(linkedDestination.status, 0)
    assert.match(linkedDestination.stderr, /MANAGED_PI_RUNTIME_CONFIG_NOT_REGULAR/)
    assert.doesNotMatch(linkedDestination.stderr, /fixture-only|rotated-fixture/)
    await unlink(join(runtime, 'settings.json'))

    await chmod(runtime, 0o755)
    const exposedRuntime = runSync()
    assert.notEqual(exposedRuntime.status, 0)
    assert.match(exposedRuntime.stderr, /MANAGED_PI_RUNTIME_DIRECTORY_NOT_PRIVATE/)
    assert.doesNotMatch(exposedRuntime.stderr, /fixture-only|rotated-fixture/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
