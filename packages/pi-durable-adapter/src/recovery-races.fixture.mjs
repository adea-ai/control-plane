// Child-process tests must read current workspace sources even when dist is stale.
// Bun's test runner omits its --tsconfig-override flag from process.execArgv.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function writeRecoverySourceOverride(directory) {
  const packages = fileURLToPath(new URL('../../', import.meta.url))
  const paths = {}
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDirectory = join(packages, entry.name)
    const manifest = join(packageDirectory, 'package.json')
    if (!existsSync(manifest)) continue
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
    if (!metadata.name?.startsWith('@control-plane/')) continue
    for (const [subpath, conditions] of Object.entries(metadata.exports ?? {})) {
      const target =
        typeof conditions === 'string' ? conditions : (conditions.default ?? conditions.node)
      if (typeof target !== 'string' || !target.startsWith('./dist/') || !target.endsWith('.js'))
        continue
      const source = join(
        packageDirectory,
        target.replace('./dist/', 'src/').replace(/\.js$/, '.ts')
      )
      if (!existsSync(source)) continue
      const specifier = subpath === '.' ? metadata.name : `${metadata.name}/${subpath.slice(2)}`
      paths[specifier] = [source]
    }
  }
  const filename = join(directory, 'workspace-source.tsconfig.json')
  writeFileSync(
    filename,
    JSON.stringify({
      extends: join(packages, '..', 'tsconfig.base.json'),
      compilerOptions: { paths },
    })
  )
  return filename
}
