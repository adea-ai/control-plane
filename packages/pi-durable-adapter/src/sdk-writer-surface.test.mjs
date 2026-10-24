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
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// C1 drift test. Source text only: it reads a temporary copy of the installed SDK (compat patch applied
// there if absent), opens no database and starts nothing. If the SDK, or the compat patch, adds or
// removes a place that mutates the native store, this fails and the new write site must be classified.
const here = dirname(fileURLToPath(import.meta.url))
const adapterRoot = resolve(here, '..')
const repoRoot = resolve(adapterRoot, '../..')
// The install layout differs between installs (a per-package symlink locally, a hoisted root hosted), so the
// SDK is found through module resolution rather than a fixed node_modules path.
function installedSdkRoot() {
  let directory = dirname(createRequire(import.meta.url).resolve('@earendil-works/pi-durable'))
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error('installed pi-durable package root not found')
    directory = parent
  }
  return realpathSync(directory)
}
const installed = installedSdkRoot()
const compatPatch = join(repoRoot, 'patches/@earendil-works%2Fpi-durable@1.1.0.patch')
const scratchBase = join(adapterRoot, 'node_modules/.sdk-writer-surface-test')

let root
let pkgRoot
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
  pkgRoot = pkg
  dist = join(pkg, 'dist')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

// --- Scanner -------------------------------------------------------------------------------------
// Supported inputs, stated so that anything else fails closed instead of going unscanned:
//   - Scanned: `.js` ES modules (the SDK's compiled output), any case of the extension.
//   - Ignored as non-executable data: declarations (`.d.ts`, `.d.mts`, `.d.cts`), `.map`, `.md`, `.json` and the
//     package manager's empty `.bun-tag-<hash>` marker.
//   - Anything else, including `.mjs`, `.cjs`, `.jsx`, `.ts` (non-declaration), `.tsx`, `.wasm`, `.node`
//     and extensionless files, is UNSUPPORTED: the inventory test fails and the file must be classified.
// This is a small heuristic tokenizer, not a JavaScript parser. It finds string and template literals (skipping
// comments and regular expressions by a preceding-token heuristic) and calls to run/exec/prepare/get/all.
// What it detects: SQL statements held in one string literal ('...', "..." or `...`, any case, JS escapes decoded)
// that start with a mutating verb, a mutating phrase anywhere else inside a literal (multi-statement or CTE
// strings), and SQL call sites on database-like receivers (transaction, executor, tx, trx, connection, conn, db,
// database, adapter, sql, super) whose first argument is not one plain literal. A literal is plain only when it has
// no `${...}` interpolation and no \x, \u or octal escape and nothing follows it but `,` or `)`; variables,
// concatenation, interpolated templates and escaped SQL are all reported as non-literal and pinned by site.
// Limits, not covered: the content of non-literal SQL is not read (the site is pinned, a reviewer classifies it),
// receivers with other names are not recognized, mutating verbs inside comments are ignored by design, and files
// outside the package are not scanned. A source the tokenizer cannot parse to the end throws, so syntax the scanner
// does not understand fails closed.
const SCANNED_EXTENSION = /\.js$/i
// `.bun-tag-<hash>` is the empty marker file the package manager leaves in an installed package directory.
const DATA_EXTENSION = /(?:\.d\.[cm]?ts|\.map|\.md|\.json)$|^\.bun-tag-[0-9a-f]+$/i
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.name === 'node_modules' || entry.name === '.git'
      ? []
      : entry.isDirectory()
        ? walk(join(directory, entry.name))
        : [join(directory, entry.name)]
  )
function inventory(rootDirectory) {
  const scanned = []
  const ignored = []
  const unsupported = []
  for (const path of walk(rootDirectory).toSorted()) {
    const name = relative(rootDirectory, path)
    if (DATA_EXTENSION.test(name)) ignored.push(name)
    else if (SCANNED_EXTENSION.test(name)) scanned.push(name)
    else unsupported.push(name)
  }
  return { scanned, ignored, unsupported }
}
const files = (directory) => walk(directory).filter((path) => SCANNED_EXTENSION.test(path))
const text = (path) => readFileSync(path, 'utf8')

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^')
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'void',
  'delete',
  'throw',
  'new',
  'else',
  'do',
  'instanceof',
  'yield',
  'await',
])
const CALL_RECEIVER =
  /\b(?:transaction|executor|tx|trx|connection|conn|db|database|adapter|sql|super)\s*$/
const SQL_METHODS = new Set(['run', 'exec', 'prepare', 'get', 'all'])
const IDENTIFIER = /[A-Za-z0-9_$]/

// Tokenizes JS enough to find string literals and SQL-method calls while skipping comments and regex literals.
function tokenize(source, name) {
  const literals = []
  const calls = []
  let i = 0
  const fail = (what) => {
    throw new Error(`writer-surface scanner cannot parse ${what} in ${name} at offset ${i}`)
  }
  function string(quote) {
    const start = i
    let interpolated = false
    i += 1
    while (true) {
      if (i >= source.length) fail('an unterminated string')
      const c = source[i]
      if (c === '\\') i += 2
      else if (c === quote) break
      else if (quote !== '`' && c === '\n') fail('a newline inside a string')
      else if (quote === '`' && c === '$' && source[i + 1] === '{') {
        i += 2
        interpolated = true
        code(true)
      } else i += 1
    }
    literals.push({ quote, start, end: i, interpolated, text: source.slice(start + 1, i) })
    i += 1
  }
  function regex() {
    i += 1
    let inClass = false
    while (true) {
      if (i >= source.length || source[i] === '\n') fail('an unterminated regular expression')
      const c = source[i]
      if (c === '\\') i += 1
      else if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      i += 1
    }
    i += 1
  }
  function code(inInterpolation) {
    let depth = 0
    let previous = ''
    let word = ''
    while (i < source.length) {
      const c = source[i]
      const pair = source.slice(i, i + 2)
      if (/\s/.test(c)) i += 1
      else if (pair === '//') {
        while (i < source.length && source[i] !== '\n') i += 1
      } else if (pair === '/*') {
        const close = source.indexOf('*/', i + 2)
        if (close === -1) fail('an unterminated comment')
        i = close + 2
      } else if (c === '"' || c === "'" || c === '`') {
        string(c)
        previous = c
        word = ''
      } else if (c === '/') {
        if (previous === '' || REGEX_PRECEDERS.has(previous) || REGEX_KEYWORDS.has(word)) regex()
        else i += 1
        previous = '/'
        word = ''
      } else if (c === '{') {
        depth += 1
        i += 1
        previous = c
        word = ''
      } else if (c === '}') {
        i += 1
        if (depth === 0) {
          if (inInterpolation) return
          fail('an unmatched closing brace')
        }
        depth -= 1
        previous = c
        word = ''
      } else if (IDENTIFIER.test(c)) {
        let end = i
        while (end < source.length && IDENTIFIER.test(source[end])) end += 1
        word = source.slice(i, end)
        const afterWord = source.slice(end).match(/^\s*\(\s*/)
        if (SQL_METHODS.has(word) && source[i - 1] === '.' && afterWord !== null)
          if (CALL_RECEIVER.test(source.slice(Math.max(0, i - 40), i - 1)))
            calls.push({ method: word, argStart: end + afterWord[0].length })
        i = end
        previous = 'a'
      } else {
        previous = c
        word = ''
        i += 1
      }
    }
    if (inInterpolation) fail('an unterminated template interpolation')
  }
  code(false)
  return { literals, calls }
}

// A literal is a statement when it has a full statement shape (any case), or when it is the first argument of a SQL
// call and starts with any mutating or transaction verb. The second rule keeps bare words such as a `"commit"`
// type tag out of the list, while a lowercase `run('commit')` is still seen.
const MUTATING_START =
  /^\s*(INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|REINDEX|ATTACH|DETACH)\b([\s\S]*)$/i
const STATEMENT_SHAPE =
  /^\s*(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO\s+\S|REPLACE\s+INTO\s+\S|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\s+\S|CREATE\s+(?:(?:TEMP|TEMPORARY|UNIQUE|VIRTUAL)\s+)*(?:TABLE|INDEX|VIEW|TRIGGER)\b|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b|ALTER\s+TABLE\b|PRAGMA\s+\w|ATTACH\s+\S|DETACH\s+\S|VACUUM\b|REINDEX\b|SAVEPOINT\s+\S|RELEASE\s+\S)/i
const MUTATING_ANYWHERE =
  /\b(?:INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE\s+\S+\s+SET|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)|ATTACH\s+DATABASE|VACUUM\s+INTO)\b/i

// Decodes JS string escapes so `'\x44ELETE FROM t'` is classified as the statement it is. An escape sequence that
// cannot be decoded leaves the text as written; the call-site rule below still pins any SQL argument using \x, \u or
// octal escapes.
const ESCAPE =
  /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|\r\n|[\n\r\u2028\u2029]|([\s\S]))/g
const SIMPLE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' }
function decode(raw) {
  try {
    return raw.replace(ESCAPE, (match, braced, unicode, hex, octal, character) => {
      if (braced !== undefined) return String.fromCodePoint(Number.parseInt(braced, 16))
      if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16))
      if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16))
      if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8))
      return character === undefined ? '' : (SIMPLE[character] ?? character)
    })
  } catch {
    return raw
  }
}
const ENCODED_ESCAPE = /\\(?:u|x|[0-7])/

function analyze(source, name) {
  const { literals: tokens, calls } = tokenize(source, name)
  const literals = tokens.map((token) => ({ ...token, raw: token.text, text: decode(token.text) }))
  const statements = []
  const embedded = []
  const sqlArguments = new Set(calls.map((call) => call.argStart))
  for (const literal of literals) {
    const match = literal.text.match(MUTATING_START)
    if (
      match === null ||
      !(sqlArguments.has(literal.start) || STATEMENT_SHAPE.test(literal.text))
    ) {
      if (MUTATING_ANYWHERE.test(literal.text))
        embedded.push(`${name}: ${literal.text.trim().slice(0, 60)}`)
      continue
    }
    const verb = match[1].toUpperCase().replace(/\s+/g, ' ')
    const rest = match[2].trim().split(/\s+/)
    const target =
      verb === 'UPDATE' ? rest[0] : /INTO|FROM/.test(verb) ? rest[0] : rest.slice(0, 3).join(' ')
    statements.push(`${verb} ${target ?? ''}`.trim())
  }
  const nonLiteral = []
  for (const call of calls) {
    const literal = literals.find((candidate) => candidate.start === call.argStart)
    if (literal !== undefined) {
      const next = source.slice(literal.end + 1).match(/^\s*(.)/)
      const closed = next !== null && (next[1] === ',' || next[1] === ')')
      // A literal is only a plain literal when nothing is interpolated or encoded in it: a template with
      // `${...}` or a \x, \u or octal escape can hide the statement from a reader, so it needs a pinned site.
      const plain = !literal.interpolated && !ENCODED_ESCAPE.test(literal.raw)
      if (closed && plain) continue
      if (closed) {
        const kind = literal.interpolated ? 'interpolated' : 'escaped'
        const preview = literal.raw.replace(/\s+/g, ' ').trim().slice(0, 40)
        nonLiteral.push(`${name}: ${call.method}(${kind} ${literal.quote}${preview})`)
        continue
      }
    }
    const expression = source.slice(call.argStart).split(/[,)]/, 1)[0].trim().slice(0, 40)
    nonLiteral.push(`${name}: ${call.method}(${expression})`)
  }
  return { statements, embedded, nonLiteral }
}
const statements = (source) => analyze(source, 'source').statements
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

describe('C1 scanner coverage and fail-closed behavior', () => {
  const surfaces = () =>
    files(dist).map((path) => ({
      name: relative(dist, path),
      ...analyze(text(path), relative(dist, path)),
    }))

  test('every file in the package is scanned, known data or reported as unsupported (none today)', () => {
    const { scanned, ignored, unsupported } = inventory(pkgRoot)
    expect(unsupported).toEqual([])
    expect(scanned.length).toBeGreaterThan(0)
    expect(scanned.every((name) => name.startsWith('dist/'))).toBe(true)
    expect(ignored.every((name) => DATA_EXTENSION.test(name))).toBe(true)
  })

  test('no mutating phrase is hidden inside a literal that does not start with a statement', () => {
    expect(surfaces().flatMap((surface) => surface.embedded)).toEqual([])
  })

  test('SQL call sites whose argument is not one plain literal are pinned, so a new one must be classified', () => {
    // cloudflare.js is the Durable Object SQL adapter: a separate, unfenced SQLite surface that forwards whatever
    // statement it is given. node.js and migrations.js forward statements built elsewhere. storage.js `get(sql)`
    // and the interpolated `all(...)` templates are SELECTs whose clause lists are assembled from literals; node.js
    // interpolates a numeric PRAGMA value. None is part of the candidate fence; C6 must classify cloudflare.js.
    expect(counted(surfaces().flatMap((surface) => surface.nonLiteral))).toEqual({
      'storage/sqlite/cloudflare.js: all(sql)': 1,
      'storage/sqlite/cloudflare.js: exec(sql)': 5,
      'storage/sqlite/cloudflare.js: get(sql)': 1,
      'storage/sqlite/cloudflare.js: run(sql)': 1,
      'storage/sqlite/migrations.js: exec(statement)': 1,
      'storage/sqlite/node.js: exec(interpolated `PRAGMA wal_autocheckpoint = ${checkpoint)': 1,
      'storage/sqlite/node.js: exec(sql)': 1,
      'storage/sqlite/node.js: prepare(sql)': 1,
      'storage/sqlite/storage.js: all(interpolated `SELECT record FROM conversations WHERE $)': 1,
      'storage/sqlite/storage.js: all(interpolated `SELECT record FROM documents WHERE ${cla)': 1,
      'storage/sqlite/storage.js: all(interpolated `SELECT record FROM entries WHERE ${claus)': 2,
      'storage/sqlite/storage.js: all(interpolated `SELECT record FROM submissions WHERE ${c)': 1,
      'storage/sqlite/storage.js: all(interpolated `SELECT record FROM tasks WHERE ${clauses)': 1,
      'storage/sqlite/storage.js: get(sql)': 1,
    })
  })
})

describe('C1 scanner negative controls (synthetic sources)', () => {
  const run = (source) => analyze(source, 'control.js')

  test('single-quoted, double-quoted and template statements are seen in any case', () => {
    expect(
      run(`
        tx.run('insert into t (a) values (1)');
        tx.run("update t set a = 1");
        tx.run(\`
          Delete From t WHERE a = 1\`);
        tx.exec('insert or replace into t values (1)');
        tx.exec('REPLACE INTO t VALUES (1)');
        db.exec('drop table t');
        db.exec('create table x (a)');
        database.exec('commit');
      `).statements
    ).toEqual([
      'INSERT INTO t',
      'UPDATE t',
      'DELETE FROM t',
      'INSERT OR REPLACE INTO t',
      'REPLACE INTO t',
      'DROP table t',
      'CREATE table x (a)',
      'COMMIT',
    ])
  })

  test('statements holding quotes, escapes and apostrophes in comments or regexes are not confused', () => {
    const analysis = run(`
      // don't break on this apostrophe
      /* nor "this" 'one' */
      const pattern = /['"\`]/g;
      const divided = a / b / c;
      tx.run('delete from t where a = \\'x\\' and b = "y"');
      tx.run(\`update t set a = \${value ? 'x' : "y"} where id = 1\`);
    `)
    expect(analysis.statements).toEqual(['DELETE FROM t', 'UPDATE t'])
    // The quote escapes and \n are plain; the interpolated template needs a pinned site.
    expect(analysis.nonLiteral).toEqual([
      'control.js: run(interpolated `update t set a = ${value ? \'x\' : "y"} wh)',
    ])
  })

  test('mutating phrases inside another literal are reported, not ignored', () => {
    const analysis = run(`
      tx.get('select 1; delete from t');
      tx.get('with x as (select 1) update t set a = 1');
      const prose = "Failed to update the thing";
    `)
    expect(analysis.embedded.map((entry) => entry.split(': ')[1])).toEqual([
      'select 1; delete from t',
      'with x as (select 1) update t set a = 1',
    ])
  })

  test('SQL call sites with variables or concatenation are reported as non-literal', () => {
    const analysis = run(`
      await transaction.run(sql, 1);
      await executor.get(\`select \${x}\`);
      db.exec(a + b);
      tx.run("DEL" + "ETE FROM t");
      database.prepare(sqlFor(kind));
      queue.run(() => 1);
      statement.run(...params);
    `)
    expect(analysis.nonLiteral).toEqual([
      'control.js: run(sql)',
      'control.js: get(interpolated `select ${x})',
      'control.js: exec(a + b)',
      'control.js: run("DEL" + "ETE FROM t")',
      'control.js: prepare(sqlFor(kind)',
    ])
  })

  test('a template that only interpolates, or SQL written with escapes, is not a plain literal', () => {
    const analysis = run(`
      db.exec(\`\${sql}\`);
      db.exec(\`delete from t where id = \${id}\`);
      db.exec('\\x44ELETE FROM t');
      db.exec("\\u0044ROP TABLE t");
      db.exec('\\u{44}ROP TABLE u');
      db.exec('\\104ROP TABLE v');
      db.exec('select 1; \\x64elete from t');
      db.exec('delete from t where a = \\'x\\'\\n');
    `)
    expect(analysis.statements).toEqual([
      'DELETE FROM t',
      'DELETE FROM t',
      'DROP TABLE t',
      'DROP TABLE u',
      'DROP TABLE v',
      'DELETE FROM t',
    ])
    expect(analysis.embedded).toEqual(['control.js: select 1; delete from t'])
    expect(analysis.nonLiteral).toEqual([
      'control.js: exec(interpolated `${sql})',
      'control.js: exec(interpolated `delete from t where id = ${id})',
      "control.js: exec(escaped '\\x44ELETE FROM t)",
      'control.js: exec(escaped "\\u0044ROP TABLE t)',
      "control.js: exec(escaped '\\u{44}ROP TABLE u)",
      "control.js: exec(escaped '\\104ROP TABLE v)",
      "control.js: exec(escaped 'select 1; \\x64elete from t)",
    ])
  })

  test('mutating words inside comments are ignored, which is a stated limit', () => {
    expect(run('/* tx.run("DELETE FROM t") */ // tx.run("DROP TABLE t")').statements).toEqual([])
  })

  test('sources the tokenizer cannot finish parsing throw instead of being skipped', () => {
    for (const source of [
      'tx.run("DELETE FROM t',
      'tx.run(`DELETE FROM t',
      'tx.run(`DELETE ${',
      '/* DELETE FROM t',
      'const r = /unterminated',
      '}',
    ])
      expect(() => run(source)).toThrow(/cannot parse/)
  })

  test('unsupported writer file types are listed, not skipped', () => {
    const base = mkdtempSync(join(scratchBase, 'inventory-'))
    try {
      mkdirSync(join(base, 'dist/storage'), { recursive: true })
      mkdirSync(join(base, 'node_modules/ignored'), { recursive: true })
      for (const name of [
        'dist/a.js',
        'dist/UPPER.JS',
        'dist/a.d.ts',
        'dist/a.js.map',
        'dist/b.cjs',
        'dist/c.mjs',
        'dist/d.ts',
        'dist/e.tsx',
        'dist/f.jsx',
        'dist/g.wasm',
        'dist/h.node',
        'dist/storage/writer',
        'package.json',
        '.bun-tag-93d8e0fc656a2572',
        'node_modules/ignored/x.cjs',
      ])
        writeFileSync(join(base, name), '')
      const found = inventory(base)
      expect(found.scanned).toEqual(['dist/UPPER.JS', 'dist/a.js'])
      expect(found.unsupported).toEqual([
        'dist/b.cjs',
        'dist/c.mjs',
        'dist/d.ts',
        'dist/e.tsx',
        'dist/f.jsx',
        'dist/g.wasm',
        'dist/h.node',
        'dist/storage/writer',
      ])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
