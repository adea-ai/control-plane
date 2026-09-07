import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Publishes the stable, deployment-neutral packages to the public npm registry
// under the @adea-ai scope (the npm org that already exists for the product
// family). Workspace names stay @control-plane/*; the mapping below is applied
// to the staged manifest and to any @control-plane/* dependency names so the
// published tarballs are self-consistent under @adea-ai/*.
//
// All six packages are Zod-only (telemetry's provider SDKs are optional peer
// deps) and contain no infrastructure, deployment, or credential code; that is
// what makes public publishing safe. Never add an adapter, app, or
// infrastructure package to PUBLISH_PACKAGES.
//
// The npm `adea` org must exist and NPM_TOKEN must be an automation token
// with publish rights on it. Versions come from each package.json
// (release-please lockstep); already-published versions are skipped, so the
// script is safe to re-run and runs on every main push touching these paths.

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

const PUBLIC_SCOPE = '@adea-ai'

const PUBLISH_PACKAGES = [
  'packages/contracts',
  'packages/runtime-gateway-protocol',
  'packages/control-sdk',
  'packages/telemetry',
  'packages/tool-sdk',
  'packages/runtime-sdk',
]

function publicName(workspaceName) {
  return `${PUBLIC_SCOPE}/${workspaceName.split('/').pop()}`
}

function sh(args, cwd, extraEnv) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  if (result.error) throw result.error
  return result
}

async function publishedVersion(name) {
  const result = sh(['npm', 'view', `${name}`, 'version'], repoRoot)
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

async function rewriteSection(section, workspaceName) {
  const rewritten = {}
  for (const [dep, range] of Object.entries(section ?? {})) {
    const mappedDep = dep.startsWith('@control-plane/') ? publicName(dep) : dep
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      try {
        const depManifest = JSON.parse(
          await readFile(join(repoRoot, 'node_modules', dep, 'package.json'), 'utf8')
        )
        rewritten[mappedDep] = `^${depManifest.version}`
      } catch {
        throw new Error(`[publish] cannot resolve ${range} for ${dep} in ${workspaceName}`)
      }
    } else {
      rewritten[mappedDep] = range
    }
  }
  return rewritten
}

for (const relative of PUBLISH_PACKAGES) {
  const source = resolve(repoRoot, relative)
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const { name, version } = manifest
  if (manifest.private) {
    throw new Error(`[publish] refusing to publish ${name}: remove "private": true first`)
  }
  const publishedAs = publicName(name)
  if (await publishedVersion(publishedAs).then((v) => v === version)) {
    console.log(`[publish] ${publishedAs}@${version} already published; skipping.`)
    continue
  }
  // Stage an isolated copy with workspace: ranges resolved to their locked
  // versions and @control-plane/* dependency names mapped to @adea-ai/*, so
  // the published tarball has no workspace: protocol leftovers and no
  // references to the workspace scope.
  const stage = await mkdtemp(join(tmpdir(), 'control-plane-publish-'))
  await cp(source, join(stage, 'package'), { recursive: true })
  const stagedManifestPath = join(stage, 'package', 'package.json')
  const staged = JSON.parse(await readFile(stagedManifestPath, 'utf8'))
  staged.name = publishedAs
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    staged[section] = await rewriteSection(staged[section], name)
  }
  await writeFile(stagedManifestPath, `${JSON.stringify(staged, null, 2)}\n`)
  // Ship the repository license inside the tarball so registry consumers and
  // license scanners see it without visiting the repository.
  await cp(join(repoRoot, 'LICENSE'), join(stage, 'package', 'LICENSE'))
  console.log(`[publish] publishing ${publishedAs}@${version}...`)
  const result = sh(['npm', 'publish', '--access', 'public'], join(stage, 'package'))
  await rm(stage, { recursive: true, force: true })
  if (result.status !== 0) {
    // Tolerate publish races: concurrent lanes may both pass the version
    // check, then exactly one wins the PUT. A 403 overwrite for the version
    // we wanted is convergence, not failure. Registry reads lag writes by
    // seconds, so retry the version check before concluding anything.
    const output = `${result.stdout ?? ''}
${result.stderr ?? ''}`
    if (output.includes('cannot publish over the previously published versions')) {
      let converged = false
      for (let attempt = 1; attempt <= 6 && !converged; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10_000))
        converged = (await publishedVersion(publishedAs)) === version
      }
      if (converged) {
        console.log(`[publish] ${publishedAs}@${version} won by a concurrent lane; continuing.`)
        continue
      }
    }
    console.error(result.stdout, result.stderr)
    throw new Error(`[publish] failed for ${publishedAs}@${version}`)
  }
  console.log(`[publish] published ${publishedAs}@${version}.`)
}
