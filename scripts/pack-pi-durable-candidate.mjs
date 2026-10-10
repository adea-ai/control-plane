import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Local candidate evidence only. No registry publication, dependency edits or build.
// Run the package builds first, then pass an isolated output directory.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = process.argv[2] && resolve(process.argv[2])
if (!output || output === root || output.startsWith(`${root}/`))
  throw new Error('Provide an isolated candidate output directory outside the repository')
await mkdir(output, { recursive: true })
const sources = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    cwd: root,
    encoding: 'utf8',
  }
)
  .split('\0')
  .filter(Boolean)
  .toSorted()
const sourceHash = createHash('sha256')
for (const path of sources) {
  sourceHash
    .update(path)
    .update('\0')
    .update(await readFile(join(root, path)))
    .update('\0')
}
const artifacts = []
// Same manifest/import rewrite as scripts/publish-packages.mjs, with no registry
// query or publication. Versions are real candidate manifest versions, not invented.
async function rewriteDist(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await rewriteDist(path)
    else if (/\.(js|d\.ts|cjs|mjs)$/.test(entry.name)) {
      const source = await readFile(path, 'utf8')
      await writeFile(path, source.replaceAll('@control-plane/', '@adea-ai/'))
    }
  }
}
for (const [directory, archive] of [
  ['contracts', 'contracts.tgz'],
  ['runtime-sdk', 'runtime-sdk.tgz'],
  ['control-sdk', 'sdk.tgz'],
]) {
  const packageRoot = join(root, 'packages', directory)
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  await readFile(join(packageRoot, 'dist/index.js'))
  await readFile(join(packageRoot, 'dist/index.d.ts'))
  const stage = await mkdtemp(join(tmpdir(), 'pi-durable-candidate-pack-'))
  try {
    for (const path of manifest.files)
      await cp(join(packageRoot, path), join(stage, path), { recursive: true })
    const staged = structuredClone(manifest)
    staged.name = staged.name.replace('@control-plane/', '@adea-ai/')
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!staged[section]) continue
      const rewritten = {}
      for (const [name, range] of Object.entries(staged[section])) {
        const mapped = name.replace('@control-plane/', '@adea-ai/')
        rewritten[mapped] = range.startsWith('workspace:')
          ? `^${JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version}`
          : range
      }
      staged[section] = rewritten
    }
    await rewriteDist(join(stage, 'dist'))
    await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'))
    await writeFile(join(stage, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`)
    execFileSync('bun', ['pm', 'pack', '--filename', join(output, archive)], {
      cwd: stage,
      stdio: 'pipe',
    })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  const bytes = await readFile(join(output, archive))
  artifacts.push({
    name: manifest.name.replace('@control-plane/', '@adea-ai/'),
    version: manifest.version,
    archive,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
const evidence = {
  schemaVersion: 'pi-durable-candidate-artifacts/v1',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDigest: `sha256:${sourceHash.digest('hex')}`,
  sourceFiles: sources.length,
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0,
  artifacts,
  qualification: 'Locally built candidate. Not a registry release or live-provider qualification.',
}
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(JSON.stringify(evidence))
