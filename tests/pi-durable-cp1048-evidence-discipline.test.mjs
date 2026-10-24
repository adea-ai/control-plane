import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

const root = fileURLToPath(new URL('..', import.meta.url))
const ledgerRelative = 'docs/pi-durable-cp1204-1048-acceptance-ledger.md'
const mapRelative = 'docs/profile-recovery-acceptance-map.md'
const scopeHeading = '## The current published scope'

function git(args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function gitAvailable() {
  try {
    git(['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

function hasCommit(sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

function onMainBranch() {
  try {
    const branch = git(['symbolic-ref', '--short', 'HEAD']).trim()
    return branch === 'main' || branch === 'master'
  } catch {
    return false
  }
}

/**
 * The commit that last carried this ledger. The published scope is anchored
 * there, so the check stays true after the pull request merges, when `main`
 * carries work this pull request never touched.
 */
function lastCommitTouching(relativePath) {
  try {
    const sha = git(['log', '-1', '--format=%H', '--', relativePath]).trim()
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

function scopeBetween(from, to) {
  const output = git(['diff', '--name-status', from, to]).trim()
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

  test.skipIf(!baseReady || onMainBranch())(
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
