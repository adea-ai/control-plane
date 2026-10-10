import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ACCEPTANCE_IDS,
  CommandError,
  gitCheckout,
  MAX_EVIDENCE_BYTES,
  openAuthorizedCheckout,
  parseJunit,
  REQUIRED_IDS,
  REQUIREMENT_IDS,
  repositoryIo,
  runCommand,
  STATUS,
  validateEvidenceManifest,
} from './evidence-manifest.mjs'

const root = resolve(import.meta.dir, '..')
const SHA = '1'.repeat(40)
const ROOT = '9'.repeat(40)
const OTHER_SHA = '2'.repeat(40)
const CONTRACT = 'pi-durable-2026-10'
const EXECUTION_SCHEMA = 'adea.evidence.execution.v1'
const CANDIDATE_SCHEMA = 'adea.evidence.candidate.v1'
const TEST_PATH = 'scripts/evidence-manifest.test.ts'
const TEST_TITLE = 'validates every mapped id'
const testRef = { kind: 'test-reference', repository: 'adea', path: TEST_PATH, name: TEST_TITLE }
const criterionA01 = {
  text: 'the designated lead is the only lead',
  tests: [{ repository: 'adea', path: TEST_PATH, name: TEST_TITLE }],
}

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A local checkout fake: committed blobs keyed by `<sha>:<path>`. */
function checkoutFake({ commits = [SHA], roots = { [SHA]: [ROOT] }, blobs = {} } = {}) {
  return {
    commitExists: (sha) => commits.includes(sha),
    rootCommits: (sha) => roots[sha] ?? [],
    blobAtSha: (sha, path) => {
      const blob = blobs[`${sha}:${path}`]
      if (blob === undefined) return null
      const bytes = Buffer.from(blob.content ?? '')
      return {
        regular: blob.regular ?? true,
        mode: blob.regular === false ? '120000' : '100644',
        size: blob.size ?? bytes.length,
        bytes: () => bytes,
      }
    },
  }
}

const testBlobs = () => ({
  [`${SHA}:${TEST_PATH}`]: { content: `test('${TEST_TITLE}', () => {})` },
})

/** I/O fake: `checkouts` by repository key, `working` files by repo-relative path. */
function fixtureIo({
  checkouts = { adea: checkoutFake({ blobs: testBlobs() }) },
  working = {},
} = {}) {
  return {
    checkout: (repository) => checkouts[repository] ?? null,
    workingFile: (path) => {
      const file = working[path]
      if (file === undefined) return null
      if (file.outside) return { outside: true }
      const bytes = Buffer.from(file.content ?? '')
      return { regular: file.regular ?? true, size: file.size ?? bytes.length, bytes: () => bytes }
    },
  }
}

function junit(titles, failing = []) {
  const cases = titles
    .map((title) =>
      failing.includes(title)
        ? `    <testcase name="${title}" classname="" time="0.1"><failure message="boom"/></testcase>`
        : `    <testcase name="${title}" classname="" time="0.1" />`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n  <testsuite name="x">\n${cases}\n  </testsuite>\n</testsuites>\n`
}

/** One execution envelope: the run's record and its JUnit document, bound to a repository and revision. */
function runFor(
  prefix,
  {
    titles = [TEST_TITLE],
    failing = [],
    file = TEST_PATH,
    ids = ['A01'],
    repository = 'adea',
    executedAtHead = SHA,
    envelope: overrides = {},
  } = {}
) {
  const envelope = Buffer.from(
    JSON.stringify({
      schema: EXECUTION_SCHEMA,
      repository,
      sourceSha: SHA,
      executedAtHead,
      file,
      command: `bun test ${file}`,
      exitCode: 0,
      status: 'passed',
      summary: { pass: titles.length - failing.length, fail: failing.length },
      ids,
      junit: junit(titles, failing),
      ...overrides,
    })
  )
  return {
    files: { [`${prefix}.json`]: { content: envelope } },
    ref: {
      kind: 'execution-reference',
      repository,
      path: `${prefix}.json`,
      sha256: sha256Of(envelope),
    },
  }
}

/** One candidate envelope: the candidate build's run of one repository's test file, pinned by sources. */
function candidateFor(
  prefix,
  {
    id = 'A01',
    sources = { adea: SHA },
    contractVersion = CONTRACT,
    channel = 'packaged',
    repository = 'adea',
    file = TEST_PATH,
    titles = [TEST_TITLE],
    failing = [],
    envelope: overrides = {},
  } = {}
) {
  const envelope = Buffer.from(
    JSON.stringify({
      schema: CANDIDATE_SCHEMA,
      candidateId: prefix,
      channel,
      contractVersion,
      repository,
      file,
      sources,
      ids: [id],
      exitCode: 0,
      status: 'passed',
      summary: { pass: titles.length - failing.length, fail: failing.length },
      junit: junit(titles, failing),
      ...overrides,
    })
  )
  return {
    files: { [`${prefix}.json`]: { content: envelope } },
    ref: { kind: 'candidate-reference', path: `${prefix}.json`, sha256: sha256Of(envelope) },
  }
}

const ADEA = { name: 'adea-ai/adea', rootCommit: ROOT, sourceSha: SHA }

function manifest(entries = [], overrides = {}) {
  return {
    schemaVersion: 1,
    issue: 1225,
    parent: 1183,
    repositories: { adea: ADEA },
    compatibility: { contractVersions: [CONTRACT] },
    entries,
    ...overrides,
  }
}

/** A complete A01: one runner-verified test and one passing run, with working files. */
function completeA01({ overrides = {}, run = runFor('artifacts/a01-run'), extra = {} } = {}) {
  return {
    io: fixtureIo({ working: { ...run.files, ...extra } }),
    entry: {
      id: 'A01',
      coverage: 'complete',
      criteria: [criterionA01],
      repoEvidence: [testRef, run.ref],
      candidateEvidence: [],
      ...overrides,
    },
  }
}

const statusOf = (report, id) => report.results.find((result) => result.id === id)

describe('evidence manifest id universe', () => {
  test('covers the 24 requirements and A01–A40 named by #1225', () => {
    expect(REQUIREMENT_IDS).toHaveLength(24)
    expect(ACCEPTANCE_IDS).toHaveLength(40)
    expect(REQUIRED_IDS).toHaveLength(64)
  })
})

describe('schema and repository identity', () => {
  test('rejects unknown, duplicate, and malformed entries', () => {
    const io = fixtureIo()
    const { entry } = completeA01()
    expect(validateEvidenceManifest(manifest([{ ...entry, id: 'A41' }]), io).schemaErrors).toEqual([
      'unknown id A41',
    ])
    expect(validateEvidenceManifest(manifest([entry, entry]), io).schemaErrors).toEqual([
      'duplicate entry A01',
    ])
    expect(validateEvidenceManifest(manifest([{ id: 'A01' }]), io).schemaErrors[0]).toContain(
      'must list repoEvidence'
    )
  })

  test('coverage must be explicit; partial lists gaps; complete lists criteria and no gaps', () => {
    const io = fixtureIo()
    const { entry } = completeA01()
    const { coverage: _omitted, ...bare } = entry
    expect(validateEvidenceManifest(manifest([bare]), io).schemaErrors).toEqual([
      'A01 coverage must be complete or partial',
    ])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, coverage: 'partial', gaps: [] }]), io)
        .schemaErrors
    ).toEqual(['A01 partial coverage must list gaps'])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, criteria: undefined }]), io).schemaErrors
    ).toEqual(['A01 complete coverage must list criteria'])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, gaps: ['x'] }]), io).schemaErrors
    ).toEqual(['A01 complete coverage must not list gaps'])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, criteria: [{ text: 'x', tests: [] }] }]), io)
        .schemaErrors
    ).toEqual(['A01 criterion must name text and at least one test {repository, path, name}'])
  })

  test('references must name a declared repository; source references are validated the same way', () => {
    const io = fixtureIo()
    const { entry } = completeA01()
    expect(
      validateEvidenceManifest(
        manifest([{ ...entry, repoEvidence: [{ ...testRef, repository: 'ghost' }] }]),
        io
      ).schemaErrors
    ).toEqual(['A01 references unknown repository ghost'])
    // A declared-looking source reference to an undeclared repository must fail closed, not throw.
    const partial = {
      id: 'A02',
      coverage: 'partial',
      gaps: ['x'],
      repoEvidence: [],
      candidateEvidence: [],
      sourceReferences: [{ repository: 'ghost', path: TEST_PATH }],
    }
    expect(validateEvidenceManifest(manifest([partial]), io).schemaErrors).toEqual([
      'A02 source reference must name a declared repository and path',
    ])
  })

  test('the home repository must include a root that the checkout actually contains', () => {
    const wrongRoot = fixtureIo({
      checkouts: { adea: checkoutFake({ roots: { [SHA]: [OTHER_SHA] } }) },
    })
    expect(validateEvidenceManifest(manifest([]), wrongRoot).schemaErrors).toEqual([
      `local checkout for adea is not adea-ai/adea (root ${ROOT} absent)`,
    ])
    const missing = fixtureIo({ checkouts: { adea: checkoutFake({ commits: [] }) } })
    expect(validateEvidenceManifest(manifest([]), missing).schemaErrors).toEqual([
      `adea sourceSha ${SHA} is not a commit in its local checkout`,
    ])
    expect(
      validateEvidenceManifest(
        manifest([], { repositories: { adea: { ...ADEA, sourceSha: 'abc' } } }),
        fixtureIo()
      ).ok
    ).toBe(false)
  })
})

describe('repository evidence: declarations, executions, and receipts', () => {
  test('a declaration alone is pending when partial and invalid when complete', () => {
    const io = fixtureIo()
    const partial = {
      id: 'A01',
      coverage: 'partial',
      gaps: ['no run'],
      repoEvidence: [testRef],
      candidateEvidence: [],
    }
    const report = validateEvidenceManifest(manifest([partial]), io)
    expect(statusOf(report, 'A01')).toMatchObject({
      status: STATUS.pending,
      reasons: ['declaration only, no execution-reference', 'gap: no run'],
    })
    expect(report.ok).toBe(true)
    const complete = {
      id: 'A01',
      coverage: 'complete',
      criteria: [criterionA01],
      repoEvidence: [testRef],
      candidateEvidence: [],
    }
    expect(statusOf(validateEvidenceManifest(manifest([complete]), io), 'A01')).toMatchObject({
      status: STATUS.invalid,
      reasons: ['complete coverage requires an execution-reference'],
    })
  })

  test('a declared title must exist as a regular, bounded file at the pinned revision', () => {
    const { entry } = completeA01()
    const cases = [
      [fixtureIo({ checkouts: { adea: checkoutFake({ blobs: {} }) } }), 'does not exist at'],
      [
        fixtureIo({
          checkouts: {
            adea: checkoutFake({
              blobs: { [`${SHA}:${TEST_PATH}`]: { content: 'x', regular: false } },
            }),
          },
        }),
        'is not a regular file',
      ],
      [
        fixtureIo({
          checkouts: {
            adea: checkoutFake({
              blobs: { [`${SHA}:${TEST_PATH}`]: { content: 'x', size: MAX_EVIDENCE_BYTES + 1 } },
            }),
          },
        }),
        'exceeds',
      ],
      [
        fixtureIo({
          checkouts: {
            adea: checkoutFake({
              blobs: { [`${SHA}:${TEST_PATH}`]: { content: "test('other', () => {})" } },
            }),
          },
        }),
        'is not declared',
      ],
    ]
    for (const [badIo, message] of cases) {
      const report = validateEvidenceManifest(manifest([entry]), badIo)
      expect(statusOf(report, 'A01').reasons[0]).toContain(message)
    }
  })

  test('an execution must be exact: pinned revision, exit code 0, status passed, and the claimed repository', () => {
    const cases = [
      [{ executedAtHead: OTHER_SHA }, 'is not the pinned'],
      [{ envelope: { exitCode: 1 } }, 'exit code is 1, not 0'],
      [{ envelope: { status: 'failed' } }, 'status is failed'],
      [{ envelope: { repository: 'control-plane' } }, 'names repository control-plane'],
      [{ envelope: { sourceSha: OTHER_SHA } }, `pins ${OTHER_SHA}`],
      [{ envelope: { ids: ['A02'] } }, 'does not list A01'],
    ]
    for (const [options, message] of cases) {
      const run = runFor('artifacts/a01-run', options)
      const { entry, io } = completeA01({ run })
      expect(statusOf(validateEvidenceManifest(manifest([entry]), io), 'A01').reasons[0]).toContain(
        message
      )
    }
  })

  test('the envelope must match its claimed summary, pin its hash, and list the title as passing', () => {
    const { entry, io } = completeA01()
    const tamperedHash = {
      ...entry,
      repoEvidence: [testRef, { ...entry.repoEvidence[1], sha256: '0'.repeat(64) }],
    }
    expect(
      statusOf(validateEvidenceManifest(manifest([tamperedHash]), io), 'A01').reasons[0]
    ).toContain('does not match sha256')

    const miscounted = runFor('artifacts/a01-run', { envelope: { summary: { pass: 2, fail: 0 } } })
    const { entry: e2, io: io2 } = completeA01({ run: miscounted })
    expect(statusOf(validateEvidenceManifest(manifest([e2]), io2), 'A01').reasons[0]).toContain(
      'do not match its summary'
    )

    const failing = runFor('artifacts/a01-run', { failing: [TEST_TITLE] })
    const { entry: e3, io: io3 } = completeA01({ run: failing })
    expect(statusOf(validateEvidenceManifest(manifest([e3]), io3), 'A01').reasons).toEqual([
      'no test-reference is a passing title in its receipt',
    ])
  })

  test('two runs of one file must agree: a passing run cannot hide a failing title', () => {
    const passing = runFor('artifacts/a01-run-1')
    const failing = runFor('artifacts/a01-run-2', { failing: [TEST_TITLE] })
    const { entry, io } = completeA01({ run: passing, extra: failing.files })
    const twoRuns = { ...entry, repoEvidence: [testRef, failing.ref, passing.ref] }
    expect(statusOf(validateEvidenceManifest(manifest([twoRuns]), io), 'A01').reasons).toEqual([
      'no test-reference is a passing title in its receipt',
    ])
  })
})

describe('complete and partial coverage', () => {
  test('a complete entry is repo-verified only when every declared test passed and each criterion is evidenced', () => {
    const { entry, io } = completeA01()
    expect(statusOf(validateEvidenceManifest(manifest([entry]), io), 'A01').status).toBe(
      STATUS.repoVerified
    )

    const declaredOnly = {
      ...entry,
      repoEvidence: [...entry.repoEvidence, { ...testRef, name: 'declared but never run' }],
    }
    const withDeclared = {
      checkout: () =>
        checkoutFake({
          blobs: {
            [`${SHA}:${TEST_PATH}`]: {
              content: `test('${TEST_TITLE}', () => {})\ntest('declared but never run', () => {})`,
            },
          },
        }),
      workingFile: io.workingFile,
    }
    expect(
      statusOf(validateEvidenceManifest(manifest([declaredOnly]), withDeclared), 'A01').reasons
    ).toEqual([
      `test-reference is not a passing title in its receipt: adea:${TEST_PATH} "declared but never run"`,
    ])

    const unevidenced = {
      ...entry,
      criteria: [
        {
          text: 'a criterion no test covers',
          tests: [{ repository: 'adea', path: TEST_PATH, name: 'missing' }],
        },
      ],
    }
    expect(statusOf(validateEvidenceManifest(manifest([unevidenced]), io), 'A01').reasons).toEqual([
      'criterion not evidenced by runner-verified tests: a criterion no test covers',
    ])
  })

  test('a partial entry stays pending, counts runner-verified and source-only titles, and cannot carry candidates', () => {
    const { entry, io } = completeA01()
    const partial = {
      ...entry,
      coverage: 'partial',
      criteria: undefined,
      gaps: ['not all criteria covered'],
    }
    expect(statusOf(validateEvidenceManifest(manifest([partial]), io), 'A01')).toMatchObject({
      status: STATUS.pending,
      reasons: [
        'runner-verified titles: 1, source-text-only titles: 0 (weaker)',
        'gap: not all criteria covered',
      ],
    })
    const withCandidate = {
      ...partial,
      candidateEvidence: [{ kind: 'candidate-reference', path: 'x.json', sha256: '0'.repeat(64) }],
    }
    expect(
      statusOf(validateEvidenceManifest(manifest([withCandidate]), io), 'A01').reasons
    ).toEqual(['partial coverage cannot carry candidate evidence'])
  })
})

describe('candidate records', () => {
  test('a candidate is compatible only with the pinned sources, a listed contract, exit 0, and an all-passing receipt', () => {
    const cand = candidateFor('artifacts/pkg-1')
    const { entry, io } = completeA01({ extra: cand.files })
    const withCandidate = { ...entry, candidateEvidence: [cand.ref] }
    expect(statusOf(validateEvidenceManifest(manifest([withCandidate]), io), 'A01').status).toBe(
      STATUS.candidateCompatible
    )

    const cases = [
      [
        candidateFor('artifacts/pkg-1', { sources: { adea: OTHER_SHA } }),
        'does not declare sources.adea',
      ],
      [
        candidateFor('artifacts/pkg-1', { contractVersion: 'pi-durable-2025-01' }),
        'is not compatible',
      ],
      [candidateFor('artifacts/pkg-1', { envelope: { exitCode: 1 } }), 'exit code is 1'],
      [
        candidateFor('artifacts/pkg-1', { failing: [TEST_TITLE] }),
        'test result is not all passing',
      ],
      [candidateFor('artifacts/pkg-1', { channel: 'staging' }), 'is not packaged or deployed'],
    ]
    for (const [bad, message] of cases) {
      const { entry: e, io: i } = completeA01({ extra: bad.files })
      const report = validateEvidenceManifest(manifest([{ ...e, candidateEvidence: [bad.ref] }]), i)
      expect(statusOf(report, 'A01').reasons[0]).toContain(message)
      expect(report.ok).toBe(false)
    }
  })
})

describe('bounded reads and provenance on real git and working files', () => {
  test('committed blobs: regular files read, symlinks and oversized blobs are not regular or are bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-io-'))
    try {
      const repo = join(dir, 'repo')
      mkdirSync(repo)
      const git = (args) =>
        spawnSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'f',
            GIT_AUTHOR_EMAIL: 'f@example.invalid',
            GIT_COMMITTER_NAME: 'f',
            GIT_COMMITTER_EMAIL: 'f@example.invalid',
          },
        })
      git(['init', '-q'])
      writeFileSync(join(repo, 'a.test.ts'), "test('committed', () => {})\n")
      writeFileSync(join(repo, 'big.test.ts'), 'x'.repeat(MAX_EVIDENCE_BYTES + 1))
      symlinkSync(join(dir, 'outside.test.ts'), join(repo, 'link.test.ts'))
      git(['add', '-A'])
      git(['commit', '-q', '-m', 'fixture'])
      const sha = git(['rev-parse', 'HEAD']).stdout.trim()
      const rootSha = git(['rev-list', '--max-parents=0', sha]).stdout.trim()
      const checkout = repositoryIo({ adea: repo }).checkout('adea')
      expect(checkout.commitExists(sha)).toBe(true)
      expect(checkout.commitExists('5'.repeat(40))).toBe(false)
      expect(checkout.rootCommits(sha)).toEqual([rootSha])
      expect(checkout.blobAtSha(sha, 'a.test.ts')).toMatchObject({ regular: true })
      expect(checkout.blobAtSha(sha, 'link.test.ts')).toMatchObject({ regular: false })
      expect(checkout.blobAtSha(sha, 'big.test.ts').size).toBeGreaterThan(MAX_EVIDENCE_BYTES)
      expect(checkout.blobAtSha(sha, 'missing.test.ts')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('working files: outside symlinks, directories, oversized files, and missing files are refused before any read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-work-'))
    try {
      const home = join(dir, 'home')
      const outside = join(dir, 'outside')
      mkdirSync(join(home, 'sub'), { recursive: true })
      mkdirSync(outside)
      writeFileSync(join(home, 'run.json'), '{}')
      writeFileSync(join(home, 'big.json'), 'x'.repeat(MAX_EVIDENCE_BYTES + 1))
      writeFileSync(join(outside, 'secret.json'), '{}')
      symlinkSync(join(outside, 'secret.json'), join(home, 'escape.json'))
      symlinkSync(join(home, 'run.json'), join(home, 'inside.json'))
      const io = repositoryIo({ adea: home })
      expect(io.workingFile('run.json')).toMatchObject({ regular: true, size: 2 })
      expect(io.workingFile('inside.json')).toMatchObject({ regular: true })
      expect(io.workingFile('escape.json')).toEqual({ outside: true })
      expect(io.workingFile('sub')).toMatchObject({ regular: false })
      expect(io.workingFile('big.json').size).toBeGreaterThan(MAX_EVIDENCE_BYTES)
      expect(io.workingFile('missing.json')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('each repository key reads only its own mapped checkout, and the home key is required', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-multi-'))
    try {
      const make = (name) => {
        const repo = join(dir, name)
        mkdirSync(repo)
        spawnSync('git', ['init', '-q'], { cwd: repo })
        writeFileSync(join(repo, 'x.test.ts'), name)
        spawnSync('git', ['add', '-A'], { cwd: repo })
        spawnSync(
          'git',
          ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-q', '-m', name],
          { cwd: repo }
        )
        return {
          repo,
          sha: spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: repo,
            encoding: 'utf8',
          }).stdout.trim(),
        }
      }
      const a = make('adea')
      const b = make('cp')
      const io = repositoryIo({ adea: a.repo, 'control-plane': b.repo })
      expect(io.checkout('adea').commitExists(a.sha)).toBe(true)
      expect(io.checkout('adea').commitExists(b.sha)).toBe(false)
      expect(io.checkout('control-plane').commitExists(b.sha)).toBe(true)
      expect(io.checkout('unmapped')).toBeNull()
      expect(() => repositoryIo({ 'control-plane': dir })).toThrow('repository mapping needs adea')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Run a command that must fail, and return its error. Throws if it succeeds. */
const failureOf = (run) => {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the command to fail')
}

describe('bounded git subprocesses (fail closed)', () => {
  const fakeDirs = []
  // A stand-in git: a shell script with the given body. Every fake is removed after the block.
  const fakeGit = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-fake-git-'))
    fakeDirs.push(dir)
    const path = join(dir, 'git')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }
  afterAll(() => {
    for (const dir of fakeDirs) rmSync(dir, { recursive: true, force: true })
  })
  const committed = JSON.parse(
    readFileSync(resolve(root, 'docs/plans/m18-evidence-manifest.json'), 'utf8')
  )
  const { sourceSha: pin, rootCommit } = committed.repositories.adea
  // An `ls-tree -l -z` entry for the requested path: a five-byte regular blob.
  const LISTING = 'printf \'100644 blob 0000000000000000000000000000000000000000 5\\t%s\\0\' "$6"'

  test('a command that succeeds returns its output', () => {
    expect(
      runCommand(process.execPath, ['-e', "process.stdout.write('ok')"], { timeoutMs: 20_000 })
    ).toBe('ok')
  })

  test('a nonzero exit keeps its status and stderr', () => {
    const error = failureOf(() =>
      runCommand(process.execPath, ['-e', "process.stderr.write('boom'); process.exit(3)"], {
        timeoutMs: 20_000,
      })
    )
    expect(error).toBeInstanceOf(CommandError)
    expect(error.code).toBe('nonzero')
    expect(error.status).toBe(3)
    expect(error.stderr).toContain('boom')
  })

  test('a command past its deadline is killed and reported as a timeout', () => {
    const started = Date.now()
    const error = failureOf(() =>
      runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 })
    )
    expect(error.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  test('a grandchild that holds the output open cannot keep the call past its deadline', () => {
    const script =
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit' }); setTimeout(() => {}, 60000)"
    const started = Date.now()
    const error = failureOf(() => runCommand(process.execPath, ['-e', script], { timeoutMs: 300 }))
    expect(error.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(6_000)
  })

  test('a command that cannot start is a spawn error', () => {
    const error = failureOf(() =>
      runCommand('adea-evidence-no-such-command', ['status'], { timeoutMs: 5_000 })
    )
    expect(error.code).toBe('spawn')
  })

  test('output beyond the limit is refused, not truncated', () => {
    const error = failureOf(() =>
      runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], {
        timeoutMs: 20_000,
        maxBuffer: 1024,
      })
    )
    expect(error.code).toBe('output')
  })

  test('an absent commit is false, but a failed read is an error', () => {
    const absent = fakeGit('echo "fatal: Not a valid object name $2" >&2\nexit 128')
    expect(gitCheckout(root, { git: absent }).commitExists(pin)).toBe(false)
    const failing = fakeGit('echo "fatal: could not fetch" >&2\nexit 2')
    expect(failureOf(() => gitCheckout(root, { git: failing }).commitExists(pin)).code).toBe(
      'nonzero'
    )
  })

  test('a hung git step fails closed within its deadline', () => {
    const hung = fakeGit('exec sleep 30')
    const started = Date.now()
    expect(
      failureOf(() => gitCheckout(root, { git: hung, timeoutMs: 300 }).commitExists(pin)).code
    ).toBe('timeout')
    expect(
      failureOf(() => gitCheckout(root, { git: hung, timeoutMs: 300 }).rootCommits(pin)).code
    ).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  test('a failed blob read is an error, not a missing file', () => {
    const git = fakeGit(
      `case "$1" in\n  ls-tree) ${LISTING} ;;\n  cat-file) echo "fatal: could not fetch blob" >&2; exit 2 ;;\n  *) exit 2 ;;\nesac`
    )
    const blob = gitCheckout(root, { git }).blobAtSha(pin, 'example.test.ts')
    expect(blob).toMatchObject({ regular: true, size: 5 })
    expect(failureOf(() => blob.bytes()).code).toBe('nonzero')
  })

  test('validation reports a failed git read as a schema error, never as a pass', () => {
    const git = fakeGit(
      `case "$1" in\n  cat-file) if [ "$2" = "-e" ]; then exit 0; fi; echo "fatal: could not fetch blob" >&2; exit 2 ;;\n  rev-list) echo ${rootCommit} ;;\n  ls-tree) ${LISTING} ;;\n  *) exit 2 ;;\nesac`
    )
    const io = { ...repositoryIo({ adea: root }), checkout: () => gitCheckout(root, { git }) }
    const report = validateEvidenceManifest(committed, io)
    expect(report.ok).toBe(false)
    expect(report.results).toEqual([])
    expect(report.schemaErrors[0]).toMatch(/^git read failed \(nonzero\)/)
  })

  test('a failed authorized read removes its temporary clone before it throws', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-evidence-scratch-'))
    try {
      const error = failureOf(() =>
        openAuthorizedCheckout(
          { name: 'adea-ai/adea', rootCommit, sourceSha: pin },
          { remoteBase: 'file:///adea-evidence-no-such-base/', scratch }
        )
      )
      expect(error.message).toContain('cannot read')
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('a hung authorized read is bounded and removes its temporary clone', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-evidence-scratch-'))
    try {
      const hung = fakeGit('exec sleep 30')
      const started = Date.now()
      const error = failureOf(() =>
        openAuthorizedCheckout(
          { name: 'adea-ai/adea', rootCommit, sourceSha: pin },
          { git: hung, timeoutMs: 300, scratch }
        )
      )
      expect(error.message).toContain('timed out after 300 ms')
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('committed manifest at its pinned commit (authorized read)', () => {
  const committed = JSON.parse(
    readFileSync(resolve(root, 'docs/plans/m18-evidence-manifest.json'), 'utf8')
  )
  const { name, rootCommit, sourceSha: pin } = committed.repositories.adea
  // The production reader: the local checkout when it proves the pin, otherwise a bounded
  // authorized read of the pinned commit from the declared repository. Never a skip.
  const openIo = (declared) => repositoryIo({ adea: root }, { manifest: declared, authorized: {} })

  test('the committed manifest validates through the real-git path at any checkout depth', () => {
    const io = openIo(committed)
    try {
      const report = validateEvidenceManifest(committed, io)
      expect(report.schemaErrors).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.counts[STATUS.invalid]).toBe(0)
      expect(report.counts[STATUS.candidateCompatible]).toBe(0)
      expect(report.counts[STATUS.pending]).toBe(REQUIRED_IDS.length)
      expect(io.sources().adea).toMatch(/^(local|authorized)/)
    } finally {
      io.close()
    }
  }, 180_000)

  test('a different immutable root is refused by the identity check', () => {
    const wrongRoot = '7'.repeat(40)
    const mutated = {
      ...committed,
      repositories: { adea: { ...committed.repositories.adea, rootCommit: wrongRoot } },
    }
    const io = openIo(mutated)
    try {
      const report = validateEvidenceManifest(mutated, io)
      expect(report.schemaErrors).toEqual([
        `local checkout for adea is not adea-ai/adea (root ${wrongRoot} absent)`,
      ])
      expect(report.ok).toBe(false)
    } finally {
      io.close()
    }
  }, 180_000)

  test('the pinned commit cannot be read from another repository or from an unknown revision', () => {
    expect(() =>
      openAuthorizedCheckout({ name: 'adea-ai/control-plane', rootCommit, sourceSha: pin })
    ).toThrow('cannot read')
    expect(() => openAuthorizedCheckout({ name, rootCommit, sourceSha: '1'.repeat(40) })).toThrow(
      'cannot read'
    )
    expect(rootCommit).toBe('663f2bd9133cd8bd3b4576224eb1caabf96cc34b')
  }, 180_000)

  test('evidence pinned to another revision is refused by its own envelopes', () => {
    const older = '34e173df7bf4654d53e2b4daed5ff41239cafd8b'
    const mutated = {
      ...committed,
      repositories: { adea: { ...committed.repositories.adea, sourceSha: older } },
    }
    const io = openIo(mutated)
    try {
      const report = validateEvidenceManifest(mutated, io)
      expect(report.schemaErrors).toEqual([])
      expect(report.ok).toBe(false)
      expect(
        report.results.some((result) =>
          result.reasons.some((reason) =>
            reason.includes(`execution envelope pins ${pin}, adea pins ${older}`)
          )
        )
      ).toBe(true)
    } finally {
      io.close()
    }
  }, 180_000)
})

// Stand-ins for the declared remote and the shallow clone the blind spot describes.
const gitIn = (cwd, args) => {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', ...args],
    {
      cwd,
      encoding: 'utf8',
    }
  )
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}
// The pinned tip and no history beyond it, cloned from the source's remote base.
const shallowClone = ({ base, remoteBase }, label) => {
  const local = join(base, label)
  const result = spawnSync(
    'git',
    ['clone', '-q', '--depth', '1', `${remoteBase}fixture/adea.git`, local],
    {
      encoding: 'utf8',
    }
  )
  if (result.status !== 0) throw new Error(`clone failed: ${result.stderr}`)
  return local
}
const declaration = (commits, overrides = {}) => ({
  name: 'fixture/adea',
  rootCommit: commits[0],
  sourceSha: commits[2],
  ...overrides,
})

describe('shallow checkout with the pinned root absent', () => {
  const dirs = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  // A source repository standing in for the declared remote: three commits, the first being the
  // root. Partial and by-SHA uploads are enabled, as they are on the declared remote.
  const source = () => {
    const base = mkdtempSync(join(tmpdir(), 'adea-evidence-source-'))
    dirs.push(base)
    const work = join(base, 'work')
    mkdirSync(work)
    gitIn(work, ['init', '-q'])
    const commits = ['one', 'two', 'three'].map((body) => {
      writeFileSync(join(work, 'x.test.ts'), `test('${body}', () => {})\n`)
      gitIn(work, ['add', '-A'])
      gitIn(work, ['commit', '-q', '-m', body])
      return gitIn(work, ['rev-parse', 'HEAD'])
    })
    mkdirSync(join(base, 'remote', 'fixture'), { recursive: true })
    const remote = join(base, 'remote', 'fixture', 'adea.git')
    gitIn(base, ['clone', '-q', '--bare', work, remote])
    gitIn(remote, ['config', 'uploadpack.allowFilter', 'true'])
    gitIn(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    return { base, commits, remoteBase: `file://${join(base, 'remote')}/` }
  }

  test('a shallow clone cannot prove the pinned root locally', () => {
    const src = source()
    const io = repositoryIo({ adea: shallowClone(src, 'shallow') })
    const checkout = io.checkout('adea')
    expect(checkout.commitExists(src.commits[2])).toBe(true)
    expect(checkout.rootCommits(src.commits[2])).not.toContain(src.commits[0])
  })

  test('the authorized read proves the root and binds blobs to the pinned commit', () => {
    const src = source()
    const io = repositoryIo(
      { adea: shallowClone(src, 'shallow') },
      {
        manifest: { repositories: { adea: declaration(src.commits) } },
        authorized: { remoteBase: src.remoteBase },
      }
    )
    try {
      const checkout = io.checkout('adea')
      expect(checkout.rootCommits(src.commits[2])).toEqual([src.commits[0]])
      expect(checkout.commitExists(src.commits[2])).toBe(true)
      expect(checkout.commitExists(src.commits[1])).toBe(false)
      const blob = checkout.blobAtSha(src.commits[2], 'x.test.ts')
      expect(blob.bytes().toString('utf8')).toContain("test('three'")
      expect(() => checkout.blobAtSha(src.commits[1], 'x.test.ts')).toThrow('answers only for')
      expect(io.sources().adea).toBe('authorized (depth 256, history complete)')
    } finally {
      io.close()
    }
  })

  test('the read deepens in bounded steps until the root is reached', () => {
    const src = source()
    const session = openAuthorizedCheckout(declaration(src.commits), {
      remoteBase: src.remoteBase,
      depthSteps: [1, 3],
    })
    try {
      expect(session.depth).toBe(3)
      expect(session.found).toBe(true)
      expect(session.checkout.rootCommits(src.commits[2])).toEqual([src.commits[0]])
    } finally {
      session.close()
    }
  })

  test('a root the pin does not have, or a root with parents, is not proven', () => {
    const src = source()
    for (const [label, rootCommit] of [
      ['absent', '5'.repeat(40)],
      ['with-parents', src.commits[1]],
    ]) {
      const io = repositoryIo(
        { adea: shallowClone(src, `shallow-${label}`) },
        {
          manifest: { repositories: { adea: declaration(src.commits, { rootCommit }) } },
          authorized: { remoteBase: src.remoteBase },
        }
      )
      try {
        expect(io.checkout('adea').rootCommits(src.commits[2])).toEqual([src.commits[0]])
        expect(io.checkout('adea').rootCommits(src.commits[2])).not.toContain(rootCommit)
      } finally {
        io.close()
      }
    }
  })

  test('an unknown pinned commit fails the authorized read explicitly', () => {
    const src = source()
    expect(() =>
      openAuthorizedCheckout(declaration(src.commits, { sourceSha: '1'.repeat(40) }), {
        remoteBase: src.remoteBase,
      })
    ).toThrow('cannot read')
  })

  test('the depth bound is enforced and reported', () => {
    const src = source()
    expect(() =>
      openAuthorizedCheckout(declaration(src.commits), {
        remoteBase: src.remoteBase,
        depthSteps: [1],
      })
    ).toThrow('depth 1')
  })
})

describe('parseJunit', () => {
  test('separates passing and failing testcases, unescapes names, and counts duplicates per testcase', () => {
    const parsed = parseJunit(`<testsuites><testsuite>
      <testcase name="ok &amp; fine" time="0.1" />
      <testcase name="it&apos;s &quot;quoted&quot; &gt; x" time="0.1"></testcase>
      <testcase name="broken" time="0.1"><failure message="x"/></testcase>
      <testcase name="errored" time="0.1"><error message="x"/></testcase>
      <testcase name="same" time="0.1" />
      <testcase name="same" time="0.1" />
    </testsuite></testsuites>`)
    expect([...parsed.passed].toSorted()).toEqual(['it\'s "quoted" > x', 'ok & fine', 'same'])
    expect([...parsed.failed].toSorted()).toEqual(['broken', 'errored'])
    expect([parsed.passCount, parsed.failCount]).toEqual([4, 2])
    expect(parseJunit('<testsuites></testsuites>')).toBeNull()
  })
})

describe('cross-repository identity', () => {
  const OTHER_ROOT = '8'.repeat(40)
  const manifestWithControlPlane = (entries) =>
    manifest(entries, {
      repositories: {
        adea: ADEA,
        'control-plane': {
          name: 'adea-ai/control-plane',
          rootCommit: OTHER_ROOT,
          sourceSha: OTHER_SHA,
        },
      },
    })
  const controlPlane = (blobs) =>
    checkoutFake({ commits: [OTHER_SHA], roots: { [OTHER_SHA]: [OTHER_ROOT] }, blobs })

  test('a passing receipt in one repository never verifies the same path and title in another', () => {
    const run = runFor('artifacts/a01-run')
    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({ blobs: testBlobs() }),
        'control-plane': controlPlane({
          [`${OTHER_SHA}:${TEST_PATH}`]: { content: `test('${TEST_TITLE}', () => {})` },
        }),
      },
      working: run.files,
    })
    const crossTest = {
      kind: 'test-reference',
      repository: 'control-plane',
      path: TEST_PATH,
      name: TEST_TITLE,
    }
    const entry = {
      id: 'A01',
      coverage: 'complete',
      criteria: [
        {
          text: 'the control-plane copy is evidenced',
          tests: [{ repository: 'control-plane', path: TEST_PATH, name: TEST_TITLE }],
        },
      ],
      repoEvidence: [testRef, crossTest, run.ref],
      candidateEvidence: [],
    }
    const report = validateEvidenceManifest(manifestWithControlPlane([entry]), io)
    expect(statusOf(report, 'A01').reasons).toEqual([
      `test-reference is not a passing title in its receipt: control-plane:${TEST_PATH} "${TEST_TITLE}"`,
      'criterion not evidenced by runner-verified tests: the control-plane copy is evidenced',
    ])
    expect(report.ok).toBe(false)
  })

  test('a candidate must pin the source of every repository an id cites, including source references', () => {
    const run = runFor('artifacts/a01-run')
    const candidate = candidateFor('pkg-1')
    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({ blobs: testBlobs() }),
        'control-plane': controlPlane({ [`${OTHER_SHA}:src/source.ts`]: { content: 'export {}' } }),
      },
      working: { ...run.files, ...candidate.files },
    })
    const entry = {
      id: 'A01',
      coverage: 'complete',
      criteria: [criterionA01],
      repoEvidence: [testRef, run.ref],
      sourceReferences: [{ repository: 'control-plane', path: 'src/source.ts' }],
      candidateEvidence: [candidate.ref],
    }
    const report = validateEvidenceManifest(manifestWithControlPlane([entry]), io)
    expect(statusOf(report, 'A01').reasons).toEqual([
      `candidate pkg-1 does not declare sources.control-plane = ${OTHER_SHA}`,
    ])
    expect(report.ok).toBe(false)
  })

  test('an envelope copied from another repository cannot back this repository’s execution', () => {
    const run = runFor('artifacts/a01-run')
    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({ blobs: testBlobs() }),
        'control-plane': controlPlane({
          [`${OTHER_SHA}:${TEST_PATH}`]: { content: `test('${TEST_TITLE}', () => {})` },
        }),
      },
      working: run.files,
    })
    const entry = {
      id: 'A01',
      coverage: 'complete',
      criteria: [
        {
          text: 'the control-plane copy is evidenced',
          tests: [{ repository: 'control-plane', path: TEST_PATH, name: TEST_TITLE }],
        },
      ],
      repoEvidence: [
        { kind: 'test-reference', repository: 'control-plane', path: TEST_PATH, name: TEST_TITLE },
        { ...run.ref, repository: 'control-plane' },
      ],
      candidateEvidence: [],
    }
    const report = validateEvidenceManifest(manifestWithControlPlane([entry]), io)
    expect(statusOf(report, 'A01').reasons).toEqual([
      'execution envelope names repository adea, reference names control-plane',
    ])
    expect(report.ok).toBe(false)
  })

  test('a candidate covers a criterion only through its own repository and file', () => {
    const run = runFor('artifacts/a01-run')
    const own = candidateFor('pkg-adea', { sources: { adea: SHA, 'control-plane': OTHER_SHA } })
    const other = candidateFor('pkg-cp', {
      sources: { adea: SHA, 'control-plane': OTHER_SHA },
      repository: 'control-plane',
    })
    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({ blobs: testBlobs() }),
        'control-plane': controlPlane({
          [`${OTHER_SHA}:src/source.ts`]: { content: 'export {}' },
        }),
      },
      working: { ...run.files, ...own.files, ...other.files },
    })
    const entry = {
      id: 'A01',
      coverage: 'complete',
      criteria: [criterionA01],
      repoEvidence: [testRef, run.ref],
      sourceReferences: [{ repository: 'control-plane', path: 'src/source.ts' }],
      candidateEvidence: [],
    }
    const covered = validateEvidenceManifest(
      manifestWithControlPlane([{ ...entry, candidateEvidence: [own.ref] }]),
      io
    )
    expect(statusOf(covered, 'A01').status).toBe(STATUS.candidateCompatible)

    const uncovered = validateEvidenceManifest(
      manifestWithControlPlane([{ ...entry, candidateEvidence: [other.ref] }]),
      io
    )
    expect(statusOf(uncovered, 'A01')).toMatchObject({
      status: STATUS.repoVerified,
      reasons: [
        `candidate evidence does not cover criterion test adea:${TEST_PATH} "${TEST_TITLE}"`,
      ],
    })
  })
})
