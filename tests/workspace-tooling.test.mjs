import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkBoundaries, specifiers, workspaces } from '../scripts/workspace-boundaries.mjs'
import { buildTasks } from '../scripts/orch-graph.mjs'

test('boundary parser retains type-only imports, re-exports and import types', () => {
  expect(
    specifiers(`import type { X } from 'a'; export type { Y } from 'b';
    type Z = import('c').Z; const d = import('d'); const e = require('e');
    const f = require.resolve('f'); import g = require('g');`)
  ).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  expect(() => specifiers('import {')).toThrow()
})

test('boundary guard rejects undeclared type-only and cross-package imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-boundary-'))
  const source = join(root, 'packages/a/src')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(root, 'packages/a/package.json'),
    JSON.stringify({ name: '@test/a', dependencies: { declared: '1' } })
  )
  const file = join(source, 'index.ts')
  try {
    writeFileSync(
      file,
      "import type { A } from 'declared/subpath'; import { readFile } from 'node:fs';"
    )
    expect(checkBoundaries(root).errors).toEqual([])
    writeFileSync(file, "import type { A } from 'undeclared';")
    expect(checkBoundaries(root).errors).toHaveLength(1)
    writeFileSync(file, "export type { A } from '../../other/src/index.js';")
    expect(checkBoundaries(root).errors[0]).toContain('leaves @test/a')
    writeFileSync(file, 'import {')
    expect(checkBoundaries(root).errors[0]).toContain('cannot parse imports')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('workspace graph preserves upstream builds, integration ordering and emitted outputs', () => {
  const root = resolve(import.meta.dir, '..')
  const packages = workspaces(root)
  const names = new Set(packages.map((p) => p.manifest.name))
  const tasks = buildTasks(root, 'test-toolchain')
  for (const { dir, manifest } of packages) {
    const short = manifest.name.replace('@control-plane/', '')
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    }).filter((name) => names.has(name))
    for (const operation of ['build', 'typecheck', 'test', 'test:integration', 'openapi:check']) {
      if (!manifest.scripts?.[operation]) continue
      const task = tasks[`orch:${short}:${operation}`]
      const expected = dependencyNames.map(
        (name) => `orch:${name.replace('@control-plane/', '')}:build`
      )
      if (short === 'database' && operation === 'test:integration')
        expected.push('orch:database:build')
      expect(task.dependsOn.toSorted()).toEqual(['orch:toolchain', ...expected].toSorted())
      if (operation === 'build') {
        expect(task.cache.output).toEqual([`${dir.slice(root.length + 1)}/dist/**`])
        expect(task.command).toContain('ORCH_TOOLCHAIN=test-toolchain')
        expect(manifest.scripts.build).toBe('tsc -p tsconfig.json')
      }
      if (operation === 'test:integration') expect(task.cache).toBe(false)
    }
    expect(manifest.scripts.typecheck).toBe('bun check -p tsconfig.json')
  }
  expect(tasks['orch:build'].dependsOn).toHaveLength(packages.length)
  expect(tasks['orch:build:published'].dependsOn).toHaveLength(6)
  expect(readFileSync(join(root, 'infrastructure/containers/Dockerfile'), 'utf8')).toContain(
    'vite.config.ts'
  )
})
