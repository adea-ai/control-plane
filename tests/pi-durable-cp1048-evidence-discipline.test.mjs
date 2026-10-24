import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The CP #1048 acceptance ledger publishes the exact scope of the pull
// request: the base it was cut from, every path the pull request touches, and
// whether each path was added or modified. The advisory that produced this
// file found that nothing in the repository checked that publication against
// the repository, so the published scope could drift from the code without any
// lane failing.
//
// These checks are document-internal plus git-derived. The document-internal
// ones always run. The git-derived ones need the base commit in the object
// store; a shallow clone does not carry it, so those parts skip rather than
// fail closed on a missing object.
//
// Two git-derived checks compare the published list with a diff from the base.
// The anchor check compares it with the diff to the last commit that carried
// the ledger, and holds on every descendant of that commit. The whole-scope
// check compares it with the diff to HEAD, which is only true of the branch
// that carries the ledger work: once the ledger is on main, an unrelated later
// branch (or a detached checkout of one) accumulates paths the ledger never
// published, and the historical ledger must not be rewritten to list them. So
// the whole-scope check is enforced exactly when this branch carries the ledger
// (it adds or changes it relative to the merge-base with the default branch),
// and also when that cannot be told (no default branch ref, no merge-base),
// where the strict comparison is kept. Branch names and detached state do not
// decide it.

const root = fileURLToPath(new URL('..', import.meta.url))
const ledgerRelative = 'docs/pi-durable-cp1204-1048-acceptance-ledger.md'
const mapRelative = 'docs/profile-recovery-acceptance-map.md'
const scopeHeading = '## The current published scope'

function gitIn(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function git(args) {
  return gitIn(root, args)
}

function gitAvailable() {
  try {
    git(['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

function hasCommit(sha, repo = root) {
  try {
    gitIn(repo, ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

function onMainBranch(repo = root) {
  try {
    const branch = gitIn(repo, ['symbolic-ref', '--short', 'HEAD']).trim()
    return branch === 'main' || branch === 'master'
  } catch {
    return false
  }
}

/** The default branch tip, from the first of these refs that exists, or null when none does. */
function defaultBranchRef(repo = root) {
  for (const ref of [
    'refs/remotes/origin/main',
    'refs/heads/main',
    'refs/remotes/origin/master',
    'refs/heads/master',
  ]) {
    try {
      gitIn(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return ref
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * True when this checkout carries the ledger work: the ledger is absent from the merge-base with the default
 * branch, or differs from it. Also true when that cannot be determined, so an unreadable history keeps the strict check.
 */
function carriesLedgerWork(ledgerPath, repo = root) {
  const main = defaultBranchRef(repo)
  if (main === null) return true
  let mergeBase
  try {
    mergeBase = gitIn(repo, ['merge-base', main, 'HEAD']).trim()
  } catch {
    return true
  }
  const blobAt = (revision) => {
    try {
      return gitIn(repo, ['rev-parse', '--verify', '--quiet', `${revision}:${ledgerPath}`]).trim()
    } catch {
      return null
    }
  }
  const carried = blobAt(mergeBase)
  return carried === null || carried !== blobAt('HEAD')
}

/** Whether the whole-scope comparison applies: the base is known, and this checkout carries the ledger work. */
function wholeScopeEnforcedFor(baseSha, ledgerPath, repo = root) {
  return (
    baseSha !== null &&
    hasCommit(baseSha, repo) &&
    !onMainBranch(repo) &&
    carriesLedgerWork(ledgerPath, repo)
  )
}

/**
 * The commit that last carried this ledger. The published scope is anchored
 * there, so the check stays true after the pull request merges, when `main`
 * carries work this pull request never touched.
 */
function lastCommitTouching(relativePath, repo = root) {
  try {
    const sha = gitIn(repo, ['log', '-1', '--format=%H', '--', relativePath]).trim()
    return sha === '' ? null : sha
  } catch {
    return null
  }
}

function scopeSection(markdown) {
  const start = markdown.indexOf(scopeHeading)
  if (start === -1) throw new Error(`${ledgerRelative} has no "${scopeHeading}" section`)
  const body = markdown.slice(start + scopeHeading.length)
  const end = body.search(/\n## /)
  return end === -1 ? body : body.slice(0, end)
}

function listedPaths(section) {
  const block = section.match(/```text\n([\s\S]*?)```/)
  if (!block) throw new Error('the published scope section has no path list')
  return block[1]
    .split('\n')
    .map((line) => line.match(/^([AMD])\s+(\S+)\s*$/))
    .filter((match) => match !== null)
    .map((match) => ({ status: match[1], path: match[2] }))
}

function scopeBetween(from, to, repo = root) {
  const output = gitIn(repo, ['diff', '--name-status', from, to]).trim()
  if (output === '') return []
  return output.split('\n').map((line) => {
    const [status, path] = line.split('\t')
    return { status, path }
  })
}

/** Parse unquoted, NUL-terminated `git ls-tree -r -z --full-tree` records. */
function parseGitTree(output) {
  const objects = new Map()
  if (output === '') return objects
  if (!output.endsWith('\0')) throw new Error('Git tree output is not NUL-terminated')
  const paths = new Set()
  for (const record of output.slice(0, -1).split('\0')) {
    const match = record.match(
      /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/
    )
    if (!match) throw new Error('Malformed Git tree record')
    const [, mode, type, objectId, path] = match
    if ((mode === '160000') !== (type === 'commit'))
      throw new Error('Invalid Git tree object mode/type')
    if (path.split('/').some((part) => part === '' || part === '.' || part === '..'))
      throw new Error('Invalid Git tree path')
    if (paths.has(path)) throw new Error(`Duplicate Git tree path: ${path}`)
    paths.add(path)
    // Preserve Git's path/object semantics for files, symlinks and gitlinks.
    objects.set(path, objectId)
  }
  return objects
}

function objectAt(tree, path) {
  const objectId = tree.get(path)
  if (objectId === undefined) throw new Error(`Git tree has no object at: ${path}`)
  return objectId
}

const ledger = await readFile(join(root, ledgerRelative), 'utf8')
const section = scopeSection(ledger)
const base = section.match(/base `([0-9a-f]{40})`/)?.[1] ?? null
const stated = section.match(/\*\*(\d+) paths: (\d+) added, (\d+) modified\*\*/)
const listed = listedPaths(section)
const areaRows = [
  ...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm),
].map((match) => ({
  area: match[1],
  added: Number(match[2]),
  modified: Number(match[3]),
  total: Number(match[4]),
}))
const gitReady = gitAvailable()
const baseReady = gitReady && base !== null && hasCommit(base)
const anchor = baseReady ? lastCommitTouching(ledgerRelative) : null
const anchorReady = anchor !== null && hasCommit(anchor)
const wholeScopeEnforced = wholeScopeEnforcedFor(base, ledgerRelative)

describe('the CP #1048 published scope ledger', () => {
  test('states a base commit and a scope total that match the published path list', () => {
    expect(base).toMatch(/^[0-9a-f]{40}$/)
    expect(stated).not.toBeNull()
    const [, total, added, modified] = stated
    expect(listed).toHaveLength(Number(total))
    expect(listed.filter((entry) => entry.status === 'A')).toHaveLength(Number(added))
    expect(listed.filter((entry) => entry.status === 'M')).toHaveLength(Number(modified))
    expect(listed.filter((entry) => entry.status === 'D')).toHaveLength(0)
  })

  test('the area table sums to the stated scope totals', () => {
    expect(areaRows.length).toBeGreaterThan(0)
    expect(areaRows.reduce((sum, row) => sum + row.added, 0)).toBe(Number(stated[2]))
    expect(areaRows.reduce((sum, row) => sum + row.modified, 0)).toBe(Number(stated[3]))
    expect(areaRows.reduce((sum, row) => sum + row.total, 0)).toBe(Number(stated[1]))
    for (const row of areaRows) expect(row.total).toBe(row.added + row.modified)
  })

  test('the published path list is sorted and free of duplicates', () => {
    const paths = listed.map((entry) => entry.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toEqual([...paths].toSorted())
  })

  test('every published path exists in the tree', () => {
    for (const entry of listed) {
      expect({ path: entry.path, exists: existsSync(join(root, entry.path)) }).toEqual({
        path: entry.path,
        exists: true,
      })
    }
  })

  test.skipIf(!baseReady)('every published path is classified against the base tree', () => {
    const baseTree = parseGitTree(git(['ls-tree', '-r', '-z', '--full-tree', base]))
    const headTree = parseGitTree(git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD']))
    for (const entry of listed) {
      const presentAtBase = baseTree.has(entry.path)
      if (entry.status === 'A') {
        expect({ path: entry.path, presentAtBase }).toEqual({
          path: entry.path,
          presentAtBase: false,
        })
      } else {
        expect({ path: entry.path, presentAtBase }).toEqual({
          path: entry.path,
          presentAtBase: true,
        })
        expect(objectAt(baseTree, entry.path)).not.toBe(objectAt(headTree, entry.path))
      }
    }
  })

  test.skipIf(!anchorReady)('the published path list is the scope the ledger documents', () => {
    const documented = scopeBetween(base, anchor)
    const published = listed.map((entry) => `${entry.status} ${entry.path}`).toSorted()
    expect(documented.map((entry) => `${entry.status} ${entry.path}`).toSorted()).toEqual(published)
  })

  test.skipIf(!wholeScopeEnforced)(
    'the published path list is the whole scope of this branch',
    () => {
      const documented = scopeBetween(base, 'HEAD')
      const published = listed.map((entry) => `${entry.status} ${entry.path}`).toSorted()
      expect(documented.map((entry) => `${entry.status} ${entry.path}`).toSorted()).toEqual(
        published
      )
    }
  )
})

/** A throwaway repository, so the scope gate can be exercised on history shaped like each real situation. */
function temporaryRepository(callback) {
  const repo = mkdtempSync(join(tmpdir(), 'cp1048-scope-'))
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  const author = ['-c', 'user.name=scope-test', '-c', 'user.email=scope-test@example.invalid']
  const run = (...args) => gitIn(repo, [...author, '-c', 'commit.gpgsign=false', ...args])
  const commit = (files, message) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), body)
    }
    run('add', '--all')
    run('commit', '-q', '-m', message)
    return run('rev-parse', 'HEAD').trim()
  }
  try {
    return callback({ repo, run, commit })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

const sampleLedgerPath = 'docs/ledger.md'
function sampleLedger(entries, extra = '') {
  return `# Ledger\n\n${scopeHeading}\n\n\`\`\`text\n${entries.join('\n')}\n\`\`\`\n${extra}`
}

/** What the real tests above decide, on a temporary repository at its current HEAD. */
function gateAt(repo, baseSha) {
  const published = listedPaths(
    scopeSection(readFileSync(join(repo, sampleLedgerPath), 'utf8'))
  ).map((entry) => `${entry.status} ${entry.path}`)
  const toList = (entries) => entries.map((entry) => `${entry.status} ${entry.path}`).toSorted()
  const anchorSha = lastCommitTouching(sampleLedgerPath, repo)
  return {
    enforced: wholeScopeEnforcedFor(baseSha, sampleLedgerPath, repo),
    // The strict comparison: published against the whole diff from the base to HEAD.
    missing: toList(scopeBetween(baseSha, 'HEAD', repo)).filter(
      (line) => !published.includes(line)
    ),
    surplus: published.filter(
      (line) => !toList(scopeBetween(baseSha, 'HEAD', repo)).includes(line)
    ),
    // The anchor comparison: published against the diff to the last commit that carried the ledger.
    anchorMatches:
      JSON.stringify(toList(scopeBetween(baseSha, anchorSha, repo))) ===
      JSON.stringify([...published].toSorted()),
  }
}

describe('the CP #1048 whole-scope gate on temporary repositories', () => {
  const ledgerAdding = (paths) => [...paths.map((path) => `A ${path}`), `A ${sampleLedgerPath}`]

  test('original ledger work is enforced and holds, on a branch and on its detached checkout', () => {
    temporaryRepository(({ run, commit, repo }) => {
      const start = commit({ 'README.md': 'base\n' }, 'base')
      run('branch', '-M', 'main')
      run('checkout', '-q', '-b', 'feature')
      commit(
        {
          'a.txt': 'a\n',
          'b.txt': 'b\n',
          [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt', 'b.txt'])),
        },
        'ledger work'
      )
      expect(gateAt(repo, start)).toEqual({
        enforced: true,
        missing: [],
        surplus: [],
        anchorMatches: true,
      })
      run('checkout', '-q', '--detach', 'HEAD')
      expect(onMainBranch(repo)).toBe(false)
      expect(gateAt(repo, start)).toEqual({
        enforced: true,
        missing: [],
        surplus: [],
        anchorMatches: true,
      })
    })
  })

  test('an unrelated descendant branch of the merged ledger work is not held to the historical list, but the anchor check still verifies it', () => {
    temporaryRepository(({ run, commit, repo }) => {
      const start = commit({ 'README.md': 'base\n' }, 'base')
      run('branch', '-M', 'main')
      // The ledger work lands on main as one squash commit, then main moves on.
      commit(
        {
          'a.txt': 'a\n',
          'b.txt': 'b\n',
          [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt', 'b.txt'])),
        },
        'ledger work (#1)'
      )
      commit({ 'later-on-main.txt': 'x\n' }, 'other merged work (#2)')
      run('checkout', '-q', '-b', 'unrelated')
      commit({ 'unrelated.txt': 'u\n' }, 'unrelated branch work')
      const onBranch = gateAt(repo, start)
      expect(onBranch.enforced).toBe(false)
      expect(onBranch.anchorMatches).toBe(true)
      // The strict comparison would have failed this branch, which is the regression being fixed.
      expect(onBranch.missing).toEqual(['A later-on-main.txt', 'A unrelated.txt'])

      run('checkout', '-q', '--detach', 'HEAD')
      const detached = gateAt(repo, start)
      expect(detached.enforced).toBe(false)
      expect(detached.anchorMatches).toBe(true)
    })
  })

  test('a detached checkout of main itself is not held to the historical list either', () => {
    temporaryRepository(({ run, commit, repo }) => {
      const start = commit({ 'README.md': 'base\n' }, 'base')
      run('branch', '-M', 'main')
      commit(
        { 'a.txt': 'a\n', [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt'])) },
        'ledger work (#1)'
      )
      commit({ 'later.txt': 'x\n' }, 'later (#2)')
      run('checkout', '-q', '--detach', 'main')
      expect(onMainBranch(repo)).toBe(false)
      expect(gateAt(repo, start).enforced).toBe(false)
    })
  })

  test('a true omitted path fails: unregistered files in the ledger work, a later unregistered commit, and a changed ledger on a descendant', () => {
    temporaryRepository(({ run, commit, repo }) => {
      const start = commit({ 'README.md': 'base\n' }, 'base')
      run('branch', '-M', 'main')
      run('checkout', '-q', '-b', 'feature')
      commit(
        {
          'a.txt': 'a\n',
          'b.txt': 'b\n',
          [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt'])),
        },
        'ledger work that forgets b.txt'
      )
      expect(gateAt(repo, start)).toMatchObject({
        enforced: true,
        missing: ['A b.txt'],
        surplus: [],
      })

      // The same on its detached checkout: detaching does not skip the check.
      run('checkout', '-q', '--detach', 'HEAD')
      expect(gateAt(repo, start)).toMatchObject({ enforced: true, missing: ['A b.txt'] })

      // A later commit on the branch that carries the ledger adds a file without registering it.
      run('checkout', '-q', 'feature')
      commit(
        { 'b.txt': 'b\n', [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt', 'b.txt'])) },
        'register b'
      )
      expect(gateAt(repo, start)).toMatchObject({ enforced: true, missing: [], surplus: [] })
      commit({ 'c.txt': 'c\n' }, 'adds c.txt without registering it')
      expect(gateAt(repo, start)).toMatchObject({ enforced: true, missing: ['A c.txt'] })
    })

    temporaryRepository(({ run, commit, repo }) => {
      // Ledger already on main; a descendant that CHANGES the ledger is enforced again, and a forgotten path fails.
      const start = commit({ 'README.md': 'base\n' }, 'base')
      run('branch', '-M', 'main')
      commit(
        { 'a.txt': 'a\n', [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt'])) },
        'ledger work (#1)'
      )
      run('checkout', '-q', '-b', 'edits-ledger')
      commit(
        { 'd.txt': 'd\n', [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt']), 'edited\n') },
        'edits ledger, adds d.txt'
      )
      expect(gateAt(repo, start)).toMatchObject({ enforced: true, missing: ['A d.txt'] })
      commit(
        { [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt', 'd.txt']), 'edited\n') },
        'registers d.txt'
      )
      expect(gateAt(repo, start)).toMatchObject({
        enforced: true,
        missing: [],
        surplus: [],
        anchorMatches: true,
      })
    })
  })

  test('without a default branch ref the strict comparison is kept', () => {
    temporaryRepository(({ run, commit, repo }) => {
      const start = commit({ 'README.md': 'base\n' }, 'base')
      run('branch', '-M', 'trunk')
      commit(
        { 'a.txt': 'a\n', [sampleLedgerPath]: sampleLedger(ledgerAdding(['a.txt'])) },
        'ledger work (#1)'
      )
      commit({ 'later.txt': 'x\n' }, 'later (#2)')
      expect(defaultBranchRef(repo)).toBeNull()
      expect(gateAt(repo, start)).toMatchObject({ enforced: true, missing: ['A later.txt'] })
    })
  })
})

describe('the CP #1048 evidence head discipline', () => {
  test('the published scope section names no head other than its stable base', () => {
    const named = [...new Set([...section.matchAll(/\b[0-9a-f]{40}\b/g)].map((match) => match[0]))]
    expect(named).toEqual([base])
  })

  test('the acceptance map never presents a commit id as the pull-request head', async () => {
    const map = await readFile(join(root, mapRelative), 'utf8')
    expect(map).not.toMatch(/PR head\s+`[0-9a-f]{40}`/)
  })
})

describe('the CP #1048 batched Git object inventory', () => {
  const first = 'a'.repeat(40)
  const second = 'b'.repeat(40)

  test('parses complete blob paths, executable files and symlinks without quoting or splitting filenames', () => {
    const tree = parseGitTree(
      `100644 blob ${first}\tordinary.txt\0` +
        `100755 blob ${second}\tnested/executable\0` +
        `120000 blob ${first}\tpath with\ttab and\nnewline\0` +
        `160000 commit ${second}\tnested-gitlink\0`
    )
    expect([...tree]).toEqual([
      ['ordinary.txt', first],
      ['nested/executable', second],
      ['path with\ttab and\nnewline', first],
      ['nested-gitlink', second],
    ])
    expect(objectAt(tree, 'nested-gitlink')).toBe(second)
    expect(parseGitTree('').size).toBe(0)
  })

  test('missing paths fail rather than becoming unequal undefined values', () => {
    const tree = parseGitTree(`100644 blob ${first}\tpresent.txt\0`)
    expect(objectAt(tree, 'present.txt')).toBe(first)
    expect(tree.has('absent.txt')).toBe(false)
    expect(() => objectAt(tree, 'absent.txt')).toThrow('Git tree has no object at: absent.txt')
  })

  test('rejects malformed, truncated, duplicate and invalid mode/type or path records', () => {
    for (const output of [
      `100644 blob ${first}\tunterminated`,
      '\0',
      `100644 blob not-an-object-id\tfile\0`,
      `100644 blob ${first} no-tab\0`,
      `100644 blob ${first}\t\0`,
      `040000 tree ${first}\tdirectory\0`,
      `160000 blob ${first}\twrong-mode\0`,
      `100644 commit ${first}\twrong-type\0`,
      `100644 blob ${first}\tduplicate\u0000100755 blob ${second}\tduplicate\0`,
      `100644 blob ${first}\t/absolute\0`,
      `100644 blob ${first}\tnested/../escape\0`,
      `100644 blob ${first}\tnested//empty\0`,
    ])
      expect(() => parseGitTree(output)).toThrow()
  })
})
