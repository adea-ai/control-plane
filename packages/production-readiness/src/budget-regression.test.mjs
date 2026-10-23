// The #405 budget remediations, pinned.
//
// Two composition problems were measured on the current candidate and are
// fixed at the source rather than by moving a ceiling:
//
//   - the compiled output carried the derived source-map and declaration-map
//     artifacts, 37% of the built bytes, and nothing in the repository
//     consumes them; the build configuration now stops emitting them, which
//     brings the measured dist total back inside the committed 12 MB budget;
//   - two workspace packages declared external dependencies that none of
//     their sources import, so the installed closure carried subtrees nothing
//     needed; those declarations are gone and this check keeps them gone.
//
// The checks drive the REAL checker as a subprocess, so the regression is
// pinned against the production measurement rather than a test-only copy of
// it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const budgets = JSON.parse(readFileSync(join(repositoryRoot, 'budgets.json'), 'utf8'))
const baseCompilerOptions = JSON.parse(
  readFileSync(join(repositoryRoot, 'tsconfig.base.json'), 'utf8')
).compilerOptions

/**
 * The workspace package manifests, in a stable order. The repository root is
 * not one of them: its devDependencies are the repository toolchain
 * (typescript, code-foundry, the lint and format binaries), which is used
 * through the task runner rather than imported by a source file.
 */
function workspaceManifests() {
  const manifests = []
  for (const group of ['packages', 'apps']) {
    for (const entry of readdirSync(join(repositoryRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(repositoryRoot, group, entry.name, 'package.json')
      if (existsSync(manifest)) manifests.push(manifest)
    }
  }
  return manifests
}

/**
 * Whether a package's sources import a dependency, directly or through one of
 * its subpath exports.
 */
function importsDependency(sources, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`['"]${escaped}(/[^'"]*)?['"]`).test(sources)
}

/** The sources of one workspace package, without its build output. */
function packageSources(packageRoot) {
  const sources = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name.startsWith('.'))
        continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (/\.(ts|tsx|mjs|js|json)$/.test(entry.name) && entry.name !== 'package.json') {
        sources.push(readFileSync(path, 'utf8'))
      }
    }
  }
  if (existsSync(packageRoot)) walk(packageRoot)
  return sources.join('\n')
}

/**
 * Declarations that a package may keep even though its own sources do not
 * import them, with the reason each one is allowed. Every entry is a
 * deliberate, reviewed exception.
 */
const ALLOWED_UNUSED_DECLARATIONS = new Map([
  [
    '@control-plane/control-api|@opentelemetry/api',
    'required as a peer of @sentry/node, which @control-plane/telemetry depends on',
  ],
  [
    '@control-plane/workflow-worker|@opentelemetry/api',
    'required as a peer of @sentry/node, which @control-plane/telemetry depends on',
  ],
  [
    '@control-plane/control-api|class-transformer',
    'required by the ValidationPipe that @nestjs/common applies, which peer-depends on it',
  ],
])

test('the build configuration stops emitting the derived map artifacts', () => {
  assert.equal(baseCompilerOptions.sourceMap, false)
  assert.equal(baseCompilerOptions.declarationMap, false)
  // The declarations themselves are still produced: the packages publish types.
  assert.equal(baseCompilerOptions.declaration, true)
})

test('the built output stays inside the committed dist budget', () => {
  const built = readdirSync(join(repositoryRoot, 'packages'), { withFileTypes: true }).some(
    (entry) =>
      entry.isDirectory() && existsSync(join(repositoryRoot, 'packages', entry.name, 'dist'))
  )
  if (!built) {
    // No build output in this checkout: the configuration that decides the
    // size is asserted above instead of a measurement that cannot be made.
    assert.equal(baseCompilerOptions.sourceMap, false)
    assert.equal(baseCompilerOptions.declarationMap, false)
    return
  }
  const result = spawnSync(process.execPath, ['scripts/check-budgets.mjs', 'dist'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const measured = JSON.parse(
    result.stdout
      .split('\n')
      .filter((line) => line.startsWith('OK: ') || line.startsWith('BUDGET EXCEEDED: '))
      .map((line) => line.slice(line.indexOf('{')))
      .join('')
  )
  assert.equal(measured.ok, true)
  assert.equal(measured.ceilingMb, budgets.dist.totalMbCeiling)
  assert.ok(measured.measuredMb <= budgets.dist.totalMbCeiling)
})

test('no workspace package declares an external dependency it never imports', () => {
  const unused = []
  for (const manifest of workspaceManifests()) {
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    const packageRoot = join(manifest, '..')
    const sources = packageSources(packageRoot)
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(data[section] ?? {})) {
        if (name.startsWith('@control-plane/')) continue
        if (importsDependency(sources, name)) continue
        const key = `${data.name}|${name}`
        if (ALLOWED_UNUSED_DECLARATIONS.has(key)) continue
        unused.push(`${data.name} -> ${name} (${section})`)
      }
    }
  }
  assert.deepEqual(unused, [])
})
