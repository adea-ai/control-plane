import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { buildTasks } from '../../../scripts/orch-graph.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const tasks = buildTasks(root, 'fixture-toolchain')

test('integration tasks retain the complete database and timeout environment', () => {
  // Vite+ uncached commands receive the full caller environment. Database URLs
  // and runner timeout budgets are therefore not restricted to a cache whitelist.
  for (const [name, task] of Object.entries(tasks)) {
    if (!name.endsWith(':test:integration') || name === 'orch:test:integration') continue
    expect(task.cache, name).toBe(false)
    expect(task.command, name).toContain('bun run --cwd')
  }
  expect(tasks['orch:database:test:integration'].dependsOn).toContain('orch:database:build')
})
