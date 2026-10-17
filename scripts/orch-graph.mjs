import { relative } from 'node:path'
import { workspaces } from './workspace-boundaries.mjs'

const scripts = ['build', 'typecheck', 'lint', 'test', 'test:integration', 'openapi:check', 'dev']
const globalInputs = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig*.json',
  '.oxlintrc.json',
  '.oxfmtrc.json',
  'scripts/orch-graph.mjs',
  'scripts/orch-toolchain.mjs',
  'scripts/workspace-boundaries.mjs',
  'patches/**',
]
const group = (dependsOn) => ({ command: 'node -e 0', dependsOn, cache: false })

export function buildTasks(root, toolchain) {
  const packages = workspaces(root).map(({ dir, manifest }) => ({
    dir: relative(root, dir).replaceAll('\\', '/'),
    name: manifest.name,
    short: manifest.name.replace('@control-plane/', ''),
    manifest,
  }))
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const dependencies = (pkg) =>
    Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
      ...pkg.manifest.peerDependencies,
      ...pkg.manifest.optionalDependencies,
    }).filter((name) => byName.has(name))
  const upstream = (pkg, seen = new Set()) => {
    for (const name of dependencies(pkg)) {
      if (seen.has(name)) continue
      seen.add(name)
      upstream(byName.get(name), seen)
    }
    return [...seen].map((name) => byName.get(name))
  }
  const taskName = (pkg, script) => `orch:${pkg.short}:${script}`
  const tasks = {
    'orch:toolchain': {
      command: `node scripts/orch-toolchain.mjs --expect ${toolchain}`,
      cache: false,
    },
  }
  for (const script of scripts) {
    const names = []
    for (const pkg of packages.filter((p) => p.manifest.scripts?.[script])) {
      const name = taskName(pkg, script)
      names.push(name)
      const prerequisiteBuilds = [
        'build',
        'typecheck',
        'test',
        'test:integration',
        'openapi:check',
      ].includes(script)
        ? dependencies(pkg).map((dep) => taskName(byName.get(dep), 'build'))
        : []
      if (pkg.short === 'database' && script === 'test:integration')
        prerequisiteBuilds.push(taskName(pkg, 'build'))
      const uncached = script === 'dev' || script === 'test:integration' || script === 'test'
      // Tests retain their full environment and remain uncached: grouped root test
      // runners own selection and coverage, and integration requires live services.
      tasks[name] = {
        command: `${uncached ? '' : `ORCH_TOOLCHAIN=${toolchain} env -u FORCE_COLOR `}bun run --cwd ${pkg.dir} ${script}`,
        dependsOn: ['orch:toolchain', ...prerequisiteBuilds],
        cache: uncached
          ? false
          : {
              input: [
                { auto: true },
                ...globalInputs,
                `${pkg.dir}/**`,
                `!${pkg.dir}/dist/**`,
                `!${pkg.dir}/node_modules/**`,
                `!${pkg.dir}/coverage/**`,
                `!${pkg.dir}/.vite/**`,
                ...upstream(pkg).flatMap((dep) => [
                  `${dep.dir}/src/**`,
                  `${dep.dir}/dist/**`,
                  `${dep.dir}/package.json`,
                  `${dep.dir}/tsconfig*.json`,
                ]),
                '!node_modules',
                '!node_modules/.vite-temp',
                '!node_modules/.vite-temp/**',
              ],
              ...(script === 'build' ? { output: [`${pkg.dir}/dist/**`] } : {}),
            },
      }
    }
    tasks[`orch:${script}`] = group(names)
  }
  const buildSet = (names) =>
    names.map((name) => {
      const pkg = byName.get(name)
      if (!pkg) throw new Error(`Unknown build selection: ${name}`)
      return taskName(pkg, 'build')
    })
  tasks['orch:build:published'] = group(
    buildSet([
      '@control-plane/contracts',
      '@control-plane/runtime-gateway-protocol',
      '@control-plane/sdk',
      '@control-plane/telemetry',
      '@control-plane/tool-sdk',
      '@control-plane/runtime-sdk',
    ])
  )
  tasks['orch:build:integration-roots'] = group(
    buildSet(['@control-plane/runtime-gateway', '@control-plane/control-api'])
  )
  tasks['orch:check'] = group(['orch:build', 'orch:typecheck', 'orch:openapi:check'])
  return tasks
}
