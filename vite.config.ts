import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import { buildTasks } from './scripts/orch-graph.mjs'
import { expectedId } from './scripts/orch-toolchain.mjs'

const root = dirname(fileURLToPath(import.meta.url))
export default defineConfig({ run: { tasks: buildTasks(root, expectedId(root)) } })
