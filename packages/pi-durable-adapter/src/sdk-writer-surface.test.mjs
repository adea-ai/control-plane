import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// C1 drift test. Source text only: it reads a temporary copy of the installed SDK (compat patch applied
// there if absent), opens no database and starts nothing. If the SDK, or the compat patch, adds or
// removes a place that mutates the native store, this fails and the new write site must be classified.
const here = dirname(fileURLToPath(import.meta.url))
const adapterRoot = resolve(here, '..')
const repoRoot = resolve(adapterRoot, '../..')
const installed = realpathSync(join(adapterRoot, 'node_modules/@earendil-works/pi-durable'))
const compatPatch = join(repoRoot, 'patches/@earendil-works%2Fpi-durable@1.1.0.patch')
const scratchBase = join(adapterRoot, 'node_modules/.sdk-writer-surface-test')

let root
let dist
beforeAll(() => {
  mkdirSync(scratchBase, { recursive: true })
  root = mkdtempSync(join(scratchBase, 'sdk-'))
  const pkg = join(root, 'pi-durable')
  cpSync(installed, pkg, { recursive: true, dereference: true })
  execFileSync('git', ['init', '-q'], { cwd: pkg })
  if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js'))) {
    execFileSync('git', ['apply', compatPatch], { cwd: pkg })
    if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js')))
      throw new Error('compatibility patch did not apply to the copy')
  }
  dist = join(pkg, 'dist')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : entry.name.endsWith('.js')
        ? [join(directory, entry.name)]
        : []
  )
}
const text = (path) => readFileSync(path, 'utf8')
const SQL =
  /(["`])\s*(INSERT(?: OR IGNORE)?\s+INTO|UPDATE|DELETE\s+FROM|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b([^"`]*)\1/g
function statements(source) {
  return [...source.matchAll(SQL)].map((match) => {
    const verb = match[2].replace(/\s+/g, ' ')
    const rest = match[3].trim().split(/\s+/)
    const target =
      verb === 'UPDATE' ? rest[0] : /INTO|FROM/.test(verb) ? rest[0] : rest.slice(0, 3).join(' ')
    return `${verb} ${target ?? ''}`.trim()
  })
}
const counted = (list) => {
  const counts = {}
  for (const item of list) counts[item] = (counts[item] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)))
}

describe('SDK native-store write surface (C1), pinned from installed source text', () => {
  test('SQL that mutates data appears only in storage.js, migrations.js and node.js', () => {
    const sqlFiles = files(dist)
      .filter((path) => statements(text(path)).length > 0)
      .map((path) => relative(dist, path))
      .toSorted()
    expect(sqlFiles).toEqual([
      'storage/sqlite/migrations.js',
      'storage/sqlite/node.js',
      'storage/sqlite/storage.js',
    ])
  })

  test('storage.js data writes are exactly the commit paths below', () => {
    const writes = statements(text(join(dist, 'storage/sqlite/storage.js')))
    expect(counted(writes)).toEqual({
      'DELETE FROM document_revisions': 2,
      'INSERT INTO conversations': 1,
      'INSERT INTO document_revisions': 1,
      'INSERT INTO documents': 1,
      'INSERT INTO entries': 1,
      'INSERT INTO submissions': 1,
      'INSERT INTO tasks': 1,
      'INSERT OR IGNORE INTO record_ids': 1,
      'UPDATE documents': 1,
      'UPDATE durable_metadata': 1,
    })
  })

  test('node.js only controls transactions and pragmas', () => {
    const control = statements(text(join(dist, 'storage/sqlite/node.js')))
    expect(counted(control)).toEqual({
      'BEGIN IMMEDIATE': 2,
      COMMIT: 2,
      'PRAGMA journal_mode = WAL': 1,
      'PRAGMA synchronous = NORMAL': 1,
      'PRAGMA wal_autocheckpoint = ${checkpointPages}': 1,
      'PRAGMA wal_checkpoint(TRUNCATE)': 1,
      ROLLBACK: 2,
    })
  })

  test('migrations only create schema and the singleton rows', () => {
    const verbs = counted(
      statements(text(join(dist, 'storage/sqlite/migrations.js'))).map((s) => s.split(' ')[0])
    )
    expect(Object.keys(verbs).toSorted()).toEqual(['CREATE', 'INSERT', 'UPDATE'])
  })

  test('only the SQLite adapter imports node:sqlite, and it exposes a single write choke point', () => {
    const importers = files(dist)
      .filter((path) => /(?:from|import)\s*\(?\s*["']node:sqlite["']/.test(text(path)))
      .map((path) => relative(dist, path))
      .toSorted()
    expect(importers).toEqual(['storage/sqlite/node.js'])
    const storage = text(join(dist, 'storage/sqlite/storage.js'))
    // Both entry points funnel through commit(), the only function that applies table and document writes.
    expect(storage.match(/\basync commit\(/g)).toHaveLength(1)
    expect(storage.match(/\bapplyTableWrite\(/g)?.length).toBeGreaterThan(0)
    expect(storage).toMatch(/async commitGuarded\([^)]*\)\s*\{[\s\S]{0,400}return this\.commit\(/)
  })

  test('the JSONL backend is a separate, unclassified filesystem writer surface', () => {
    const calls = []
    for (const path of files(join(dist, 'storage/jsonl')))
      for (const match of text(path).matchAll(
        /\bfs\.(writeFile|appendFile|rename|mkdir|unlink|rm|truncate|remove|mkdirp)\(/g
      ))
        calls.push(`${relative(dist, path)}: ${match[1]}`)
    // Pinned so a change is noticed. C6 treats this backend as `fence: unsupported` until it is classified.
    expect(counted(calls)).toEqual({
      'storage/jsonl/storage.js: appendFile': 2,
      'storage/jsonl/storage.js: remove': 2,
      'storage/jsonl/storage.js: writeFile': 1,
    })
  })
})
