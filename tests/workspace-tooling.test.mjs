import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkBoundaries, specifiers, workspaces } from '../scripts/workspace-boundaries.mjs'
import { buildTasks } from '../scripts/orch-graph.mjs'

test('accepted foundation toolchain matches the current pinned binaries and package manager', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const milestone = JSON.parse(readFileSync(join(root, 'docs/m1-foundation.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  expect(milestone.toolchain.node).toBe(readFileSync(join(root, '.node-version'), 'utf8').trim())
  expect(milestone.toolchain.bun).toBe(readFileSync(join(root, '.bun-version'), 'utf8').trim())
  expect(manifest.packageManager).toBe(`bun@${milestone.toolchain.bun}`)
})

test('foundation verify-only retains toolchain and accepted-history refusals', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-foundation-verifier-'))
  const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'scripts/run-foundation-acceptance.mjs'),
      readFileSync(new URL('../scripts/run-foundation-acceptance.mjs', import.meta.url))
    )
    writeFileSync(join(root, 'README.md'), 'disposable accepted foundation\n')
    for (const args of [
      ['init', '-q'],
      ['add', 'README.md'],
      [
        '-c',
        'user.name=Foundation Test',
        '-c',
        'user.email=foundation@example.invalid',
        'commit',
        '-qm',
        'accepted fixture',
      ],
    ]) {
      expect(run('git', args).status).toBe(0)
    }
    const accepted = run('git', ['rev-parse', 'HEAD']).stdout.trim()
    const milestone = {
      toolchain: { node: '24.21.0', bun: '1.4.4' },
      dependencies: Array.from({ length: 8 }, (_, index) => ({
        issue: index + 1,
        commit: accepted,
      })),
    }
    const reset = () => {
      writeFileSync(join(root, '.node-version'), '24.21.0\n')
      writeFileSync(join(root, '.bun-version'), '1.4.4\n')
      writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.4' }))
      writeFileSync(join(root, 'docs/m1-foundation.json'), JSON.stringify(milestone))
    }
    const verify = () => run('node', ['scripts/run-foundation-acceptance.mjs', '--verify-only'])
    reset()
    expect(verify().status).toBe(0)
    for (const [path, value, message] of [
      ['.bun-version', '1.4.3\n', 'Pinned Bun version drifted.'],
      ['.node-version', '24.20.0\n', 'Pinned Node version drifted.'],
      [
        'package.json',
        JSON.stringify({ packageManager: 'bun@1.4.3' }),
        'packageManager does not match the accepted Bun version.',
      ],
    ]) {
      reset()
      writeFileSync(join(root, path), value)
      const result = verify()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(message)
    }
    reset()
    milestone.dependencies[7].commit = '0'.repeat(40)
    writeFileSync(join(root, 'docs/m1-foundation.json'), JSON.stringify(milestone))
    const missingAncestor = verify()
    expect(missingAncestor.status).not.toBe(0)
    expect(missingAncestor.stderr).toContain(
      'M1 dependency issue 8 is not present in the current history.'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
    writeFileSync(file, "import './index.js';")
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

test('boundary parser enforces createRequire aliases and import.meta.resolve', () => {
  const forms = [
    "import { createRequire } from 'node:module'; createRequire(import.meta.url)('undeclared')",
    "import { createRequire as makeRequire } from 'node:module'; const requireFromAdapter = makeRequire(import.meta.url); requireFromAdapter('undeclared')",
    "import * as Module from 'node:module'; const first = Module.createRequire(import.meta.url); const second = first; second.resolve('undeclared')",
    "import.meta.resolve('undeclared')",
    "import { createRequire } from 'node:module'; createRequire(import.meta.resolve('./index.js'))('undeclared')",
    "import { createRequire } from 'node:module'; const localRequire = createRequire(import.meta.resolve('./index.js')); localRequire('undeclared')",
  ]
  const root = mkdtempSync(join(tmpdir(), 'cp-require-boundary-'))
  const directory = join(root, 'packages/a/src')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(root, 'packages/a/package.json'), JSON.stringify({ name: '@test/a' }))
  try {
    for (const source of forms) {
      expect(specifiers(source)).toContain('undeclared')
      writeFileSync(join(directory, 'index.mjs'), source)
      expect(checkBoundaries(root).errors).toHaveLength(1)
      expect(checkBoundaries(root).errors[0]).toContain('undeclared dependency undeclared')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('integration tasks retain the complete database and timeout environment', () => {
  // Vite+ uncached commands receive the full caller environment. Database URLs
  // and runner timeout budgets are therefore not restricted to a cache whitelist.
  for (const [name, task] of Object.entries(
    buildTasks(resolve(import.meta.dir, '..'), 'fixture-toolchain')
  )) {
    if (!name.endsWith(':test:integration') || name === 'orch:test:integration') continue
    expect(task.cache, name).toBe(false)
    expect(task.command, name).toContain('bun run --cwd')
  }
  expect(
    buildTasks(resolve(import.meta.dir, '..'), 'fixture-toolchain')[
      'orch:database:test:integration'
    ].dependsOn
  ).toContain('orch:database:build')
})

test('dependency-anchored require counts the declared anchor, not its transitives', () => {
  expect(
    specifiers(
      "import { createRequire } from 'node:module'; const other = createRequire(import.meta.resolve('declared')); other.resolve('transitive')"
    )
  ).toEqual(['node:module', 'declared'])
})

test('runtime identity fingerprints executable bytes behind transparent launchers', async () => {
  const { identity } = await import('../scripts/orch-toolchain.mjs')
  const { chmodSync, symlinkSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'cp-runtime-identity-'))
  const direct = join(root, 'direct')
  const wrapped = join(root, 'wrapped')
  for (const directory of [direct, wrapped]) mkdirSync(directory)
  try {
    for (const name of ['node', 'bun']) {
      symlinkSync(process.execPath, join(direct, name))
      const launcher = join(wrapped, name)
      writeFileSync(
        launcher,
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`
      )
      chmodSync(launcher, 0o755)
    }
    const a = identity({ root, searchPath: direct })
    const b = identity({ root, searchPath: wrapped })
    expect(b).toEqual(a)
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
    expect(b.bun.sha256).toBe(digest)
    expect(b.node.sha256).toBe(digest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
