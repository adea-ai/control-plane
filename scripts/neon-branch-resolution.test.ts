import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// The Neon cleanup resolver is inline JavaScript in the delete job of neon_workflow.yml. These tests
// run the exact shipped block offline: fetch is replaced by a scripted stub, nothing reaches Neon,
// and no credentials are used. A branch is reported absent only after every page has been read to
// its end; anything else must fail the job.

const WORKFLOW = `${import.meta.dir}/../.github/workflows/neon_workflow.yml`
const PR = 'feat-x'
const LEGACY = `preview/pr-7-${PR}`
const SHARD_1 = `${LEGACY}-s1`
const SHARD_2 = `${LEGACY}-s2`
const PROJECT = 'proj-test'

const tempRoot = mkdtempSync(join(tmpdir(), 'neon-resolver-'))
afterAll(() => rmSync(tempRoot, { force: true, recursive: true }))

function shippedResolverScript(): string {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const stepIndex = lines.findIndex((line) =>
    line.includes("Resolve this pull request's Neon branches")
  )
  if (stepIndex < 0) throw new Error('resolver step not found')
  const start = lines.findIndex(
    (line, index) => index > stepIndex && line.trim() === "node <<'NODE'"
  )
  const end = lines.findIndex((line, index) => index > start && line === '          NODE')
  if (start < 0 || end < 0) throw new Error('resolver heredoc not found')
  return lines
    .slice(start + 1, end)
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
}

const SCRIPT = shippedResolverScript()

type Page = { status?: number; body?: unknown; raw?: string; reject?: string }
type Run = { status: number; output: string; stderr: string; requests: string[] }

let counter = 0
function run(pages: Page[], overrides: Record<string, string> = {}): Run {
  counter += 1
  const dir = join(tempRoot, `case-${counter}`)
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'resolve.cjs')
  const preload = join(dir, 'stub.cjs')
  const outFile = join(dir, 'github-output.txt')
  const logFile = join(dir, 'requests.json')
  const scenarioFile = join(dir, 'scenario.json')
  writeFileSync(script, SCRIPT)
  writeFileSync(outFile, '')
  writeFileSync(scenarioFile, JSON.stringify(pages))
  writeFileSync(
    preload,
    `const fs = require('node:fs')
const pages = JSON.parse(fs.readFileSync(process.env.SCENARIO_FILE, 'utf8'))
const requests = []
let index = 0
globalThis.fetch = async (url) => {
  requests.push(String(url))
  fs.writeFileSync(process.env.REQUEST_LOG, JSON.stringify(requests))
  const page = pages[index++]
  if (!page) throw new Error('unexpected request beyond the scripted pages')
  if (page.reject) throw new Error(page.reject)
  const status = page.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (page.raw !== undefined ? JSON.parse(page.raw) : page.body),
  }
}
`
  )
  const env = {
    PATH: process.env.PATH ?? '',
    GITHUB_OUTPUT: outFile,
    NEON_API_KEY: 'test-only-key',
    NEON_PROJECT_ID: PROJECT,
    LEGACY_BRANCH: LEGACY,
    SHARD_1_BRANCH: SHARD_1,
    SHARD_2_BRANCH: SHARD_2,
    SCENARIO_FILE: scenarioFile,
    REQUEST_LOG: logFile,
    ...overrides,
  }
  const result = spawnSync('node', ['--require', preload, script], {
    env,
    encoding: 'utf8',
  })
  let requests: string[] = []
  try {
    requests = JSON.parse(readFileSync(logFile, 'utf8')) as string[]
  } catch {
    requests = []
  }
  return {
    output: readFileSync(outFile, 'utf8'),
    requests,
    status: result.status ?? -1,
    stderr: result.stderr,
  }
}

function outputOf(result: Run): Record<string, string> {
  return Object.fromEntries(
    result.output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      })
  )
}

const ALL_EMPTY = { legacy: '', shard_1: '', shard_2: '' }

describe('Neon cleanup resolver (shipped workflow block, offline)', () => {
  test('a branch on the second page is found, and the cursor is sent as a query parameter', () => {
    const result = run([
      {
        body: {
          branches: [{ id: 'br-unrelated', name: 'main' }],
          pagination: { next: 'cursor-2' },
        },
      },
      {
        body: {
          branches: [
            { id: 'br-legacy', name: LEGACY },
            { id: 'br-s2', name: SHARD_2 },
          ],
          pagination: {},
        },
      },
    ])
    expect(result.status).toBe(0)
    expect(outputOf(result)).toEqual({ legacy: 'br-legacy', shard_1: '', shard_2: 'br-s2' })
    expect(result.requests).toHaveLength(2)
    expect(new URL(result.requests[0]!).searchParams.has('cursor')).toBe(false)
    expect(new URL(result.requests[1]!).searchParams.get('cursor')).toBe('cursor-2')
  })

  test('a name on a first page and another on the second page are both resolved', () => {
    const result = run([
      { body: { branches: [{ id: 'br-s1', name: SHARD_1 }], pagination: { next: 'c2' } } },
      { body: { branches: [{ id: 'br-legacy', name: LEGACY }], pagination: {} } },
    ])
    expect(result.status).toBe(0)
    expect(outputOf(result)).toEqual({ legacy: 'br-legacy', shard_1: 'br-s1', shard_2: '' })
  })

  test('a genuinely absent branch is reported absent only after every page has been read', () => {
    const result = run([
      { body: { branches: [{ id: 'br-x', name: 'main' }], pagination: { next: 'c2' } } },
      { body: { branches: [{ id: 'br-y', name: 'dev' }], pagination: { next: 'c3' } } },
      { body: { branches: [], pagination: {} } },
    ])
    expect(result.status).toBe(0)
    expect(outputOf(result)).toEqual(ALL_EMPTY)
    expect(result.requests).toHaveLength(3)
  })

  test('a single page with no pagination field is treated as the last page', () => {
    const result = run([{ body: { branches: [{ id: 'br-legacy', name: LEGACY }] } }])
    expect(result.status).toBe(0)
    expect(outputOf(result).legacy).toBe('br-legacy')
    expect(result.requests).toHaveLength(1)
  })

  test('an API error on the first page fails the job and writes no absence', () => {
    const result = run([{ status: 401, body: { message: 'unauthorized' } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Listing Neon branches returned 401')
    expect(result.output).toBe('')
  })

  test('an API error on a later page fails the job even when earlier pages had no match', () => {
    const result = run([
      { body: { branches: [{ id: 'br-x', name: 'main' }], pagination: { next: 'c2' } } },
      { status: 500, body: { message: 'boom' } },
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Listing Neon branches returned 500')
    expect(result.output).toBe('')
  })

  test('a network failure on a later page fails the job and writes no absence', () => {
    const result = run([
      { body: { branches: [], pagination: { next: 'c2' } } },
      { reject: 'socket hang up' },
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('socket hang up')
    expect(result.output).toBe('')
  })

  test('a repeated cursor fails the job instead of looping or claiming absence', () => {
    const result = run([
      { body: { branches: [], pagination: { next: 'same' } } },
      { body: { branches: [], pagination: { next: 'same' } } },
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('repeated a cursor')
    expect(result.output).toBe('')
    expect(result.requests).toHaveLength(2)
  })

  test('an endless sequence of new cursors hits the page bound and fails', () => {
    const pages: Page[] = Array.from({ length: 50 }, (_, index) => ({
      body: { branches: [], pagination: { next: `c${index}` } },
    }))
    const result = run(pages)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('exceeded 50 pages')
    expect(result.output).toBe('')
    expect(result.requests).toHaveLength(50)
  })

  test('a page without a branches array is malformed and fails the job', () => {
    const result = run([{ body: { error: 'nope' } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed page')
    expect(result.output).toBe('')
  })

  test('a non-JSON response fails the job rather than being read as an empty list', () => {
    const result = run([{ raw: '<html>gateway</html>' }])
    expect(result.status).not.toBe(0)
    expect(result.output).toBe('')
  })

  test('a non-string cursor is malformed and fails the job', () => {
    const result = run([{ body: { branches: [], pagination: { next: 5 } } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed cursor')
    expect(result.output).toBe('')
  })

  test('a branch entry without a name fails the job', () => {
    const result = run([{ body: { branches: [{ id: 'br-1' }], pagination: {} } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed branch entry')
  })

  test('a matched branch without an id fails the job', () => {
    const result = run([{ body: { branches: [{ id: '', name: LEGACY }], pagination: {} } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('has no id')
    expect(result.output).toBe('')
  })

  test('matching is exact: prefixes, suffixes and case variants never resolve a requested name', () => {
    const result = run([
      {
        body: {
          branches: [
            { id: 'wrong-prefix', name: `${SHARD_1}-old` },
            { id: 'wrong-case', name: SHARD_1.toUpperCase() },
            { id: 'wrong-trailing', name: `${SHARD_1} ` },
            { id: 'br-right', name: SHARD_1 },
          ],
          pagination: {},
        },
      },
    ])
    expect(result.status).toBe(0)
    expect(outputOf(result)).toEqual({ legacy: '', shard_1: 'br-right', shard_2: '' })
  })

  test('two different branches with the same requested name fail the job as ambiguous', () => {
    const result = run([
      {
        body: {
          branches: [
            { id: 'br-a', name: LEGACY },
            { id: 'br-b', name: LEGACY },
          ],
          pagination: {},
        },
      },
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('matches more than one branch')
    expect(result.output).toBe('')
  })

  test('a repeated identical match across pages is not ambiguous', () => {
    const result = run([
      { body: { branches: [{ id: 'br-legacy', name: LEGACY }], pagination: { next: 'c2' } } },
      { body: { branches: [{ id: 'br-legacy', name: LEGACY }], pagination: {} } },
    ])
    expect(result.status).toBe(0)
    expect(outputOf(result).legacy).toBe('br-legacy')
  })

  test('cursors are sent exactly, including characters that need encoding', () => {
    const cursor = 'a b/c+d=='
    const result = run([
      { body: { branches: [], pagination: { next: cursor } } },
      { body: { branches: [], pagination: {} } },
    ])
    expect(result.status).toBe(0)
    expect(new URL(result.requests[1]!).searchParams.get('cursor')).toBe(cursor)
  })

  test('the requests use the project from the environment and the read endpoint only', () => {
    const result = run([{ body: { branches: [], pagination: {} } }])
    expect(result.status).toBe(0)
    const url = new URL(result.requests[0]!)
    expect(url.origin).toBe('https://console.neon.tech')
    expect(url.pathname).toBe(`/api/v2/projects/${PROJECT}/branches`)
    expect(url.search).toBe('')
  })

  test.each([
    ['a number', 7],
    ['an empty array', []],
    ['a non-empty array', [{}]],
    ['null', null],
    ['a string', 'cursor-2'],
  ])(
    'pagination that is %s is malformed and fails the job, never completing the scan',
    (_label, pagination) => {
      const result = run([{ body: { branches: [{ id: 'br-legacy', name: LEGACY }], pagination } }])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('malformed pagination')
      expect(result.output).toBe('')
    }
  )

  test('a pagination object without next is the last page, as the Neon schema defines', () => {
    const result = run([
      {
        body: {
          branches: [{ id: 'br-legacy', name: LEGACY }],
          pagination: { sort_by: 'updated_at', sort_order: 'desc' },
        },
      },
    ])
    expect(result.status).toBe(0)
    expect(outputOf(result).legacy).toBe('br-legacy')
    expect(result.requests).toHaveLength(1)
  })

  test('next: null is malformed, because the schema defines next as a string that is absent on the last page', () => {
    const result = run([{ body: { branches: [], pagination: { next: null } } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed cursor')
    expect(result.output).toBe('')
  })

  test('an empty-string cursor fails the job', () => {
    const result = run([{ body: { branches: [], pagination: { next: '' } } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed cursor')
    expect(result.output).toBe('')
  })

  test.each([
    ['a newline', 'br-legacy\n'],
    ['a shell command substitution', 'br-$(id)'],
    ['a semicolon', 'br-x;rm'],
    ['a space', 'br-a b'],
    ['an uppercase letter', 'br-Legacy'],
    ['a missing br- prefix', 'legacy-branch'],
    ['a bare prefix', 'br-'],
    ['a trailing hyphen', 'br-x-'],
    ['a double hyphen', 'br--x'],
    ['an overlong id', `br-${'a'.repeat(130)}`],
  ])('a requested branch whose id is %s is refused before anything is written', (_label, id) => {
    const result = run([{ body: { branches: [{ id, name: LEGACY }], pagination: {} } }])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed id')
    expect(result.output).toBe('')
  })

  test('an unsafe id on an unrelated branch is ignored, because it is never written', () => {
    const result = run([
      {
        body: {
          branches: [
            { id: 'not safe; rm -rf /', name: 'unrelated' },
            { id: 'br-legacy', name: LEGACY },
          ],
          pagination: {},
        },
      },
    ])
    expect(result.status).toBe(0)
    expect(outputOf(result).legacy).toBe('br-legacy')
  })
})
