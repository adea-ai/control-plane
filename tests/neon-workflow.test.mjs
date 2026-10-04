import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { isMigrationRelevantPath } from '../.github/scripts/neon-migration-gate.mjs'

const workflow = readFileSync(
  new URL('../.github/workflows/neon_workflow.yml', import.meta.url),
  'utf8'
)
const pullRequestWorkflow = readFileSync(
  new URL('../.github/workflows/postgres-pull-request.yml', import.meta.url),
  'utf8'
)
const script = workflow.split("node <<'NODE'\n")[1]?.split('\n          NODE')[0]
const cleanupScript = workflow.split("node <<'CLEANUP'\n")[1]?.split('\n          CLEANUP')[0]
const migrationGateScript = fileURLToPath(
  new URL('../.github/scripts/neon-migration-gate.mjs', import.meta.url)
)
const migrationGateSource = readFileSync(migrationGateScript, 'utf8')
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const realNode = execFileSync('which', ['node'], { encoding: 'utf8' }).trim()
const migrationVerifyStep = "Verify migrations and this shard's integration slice"
const conformanceStep = 'Verify cross-profile conformance matrix (Postgres)'

function runGateGit(repository, args) {
  const result = spawnSync(realGit, args, { cwd: repository, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function writeGateFile(repository, relativePath, value) {
  const path = join(repository, ...relativePath.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function verifiedJobs() {
  return {
    jobs: [1, 2, 3].map((shard) => ({
      name: `Verify Neon shard ${shard} (migrations and integration slice)`,
      status: 'completed',
      conclusion: 'success',
      steps: [
        ...(shard === 1
          ? [{ name: conformanceStep, status: 'completed', conclusion: 'success' }]
          : []),
        { name: migrationVerifyStep, status: 'completed', conclusion: 'success' },
      ],
    })),
  }
}

function successfulRun(headSha, overrides = {}) {
  return {
    id: 42,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    event: 'push',
    head_sha: headSha,
    ...overrides,
  }
}

function runMigrationGate({
  changedPaths = ['docs/notes.md'],
  renamePaths = [],
  baseFiles = {},
  changedFiles = {},
  baselineMode = 'ancestor',
  response = undefined,
  jobsResponses = undefined,
  failQuery = false,
  failJobs = false,
  failDiff = false,
  headMessage = 'fix: update docs',
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'neon-migration-gate-'))
  const repository = join(directory, 'repository')
  const fakeBin = join(directory, 'bin')
  const outputPath = join(directory, 'github-output')
  const ghCallLog = join(directory, 'gh-call')
  mkdirSync(repository)
  mkdirSync(fakeBin)
  writeFileSync(outputPath, '')

  try {
    runGateGit(repository, ['init', '--quiet', '--initial-branch=main'])
    runGateGit(repository, ['config', 'user.name', 'Neon Gate Test'])
    runGateGit(repository, ['config', 'user.email', 'neon-gate-test@example.invalid'])
    runGateGit(repository, ['config', 'commit.gpgsign', 'false'])
    runGateGit(repository, ['config', 'core.hooksPath', '/dev/null'])
    writeGateFile(repository, 'README.md', 'base\n')
    for (const [relativePath, contents] of Object.entries(baseFiles)) {
      writeGateFile(repository, relativePath, contents)
    }
    runGateGit(repository, ['add', '--all'])
    runGateGit(repository, ['commit', '--quiet', '-m', 'base'])
    const mainBase = runGateGit(repository, ['rev-parse', 'HEAD'])
    let baseline = mainBase

    if (baselineMode === 'non-ancestor') {
      runGateGit(repository, ['checkout', '--quiet', '--orphan', 'baseline'])
      runGateGit(repository, ['rm', '--quiet', '--force', '-r', '.'])
      writeGateFile(repository, 'BASELINE.md', 'unrelated history\n')
      runGateGit(repository, ['add', '--all'])
      runGateGit(repository, ['commit', '--quiet', '-m', 'unrelated baseline'])
      baseline = runGateGit(repository, ['rev-parse', 'HEAD'])
      runGateGit(repository, ['checkout', '--quiet', 'main'])
    }

    for (const relativePath of changedPaths) {
      writeGateFile(repository, relativePath, changedFiles[relativePath] ?? 'changed\n')
    }
    for (const { from, to } of renamePaths) {
      runGateGit(repository, ['mv', from, to])
    }
    runGateGit(repository, ['add', '--all'])
    runGateGit(repository, ['commit', '--quiet', '--allow-empty', '-m', headMessage])
    const head = runGateGit(repository, ['rev-parse', 'HEAD'])

    const fakeGh = join(fakeBin, 'gh')
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2).join(' ')
appendFileSync(process.env.GH_CALL_LOG, args + '\\n')
const isJobsRequest = /\\/actions\\/runs\\/(\\d+)\\/jobs\\?/.exec(args)
if (isJobsRequest) {
  if (process.env.GH_FAIL_JOBS === '1') process.exit(18)
  const response = JSON.parse(process.env.GH_JOBS_RESPONSES)[isJobsRequest[1]]
  if (response === undefined || response === null) process.exit(19)
  process.stdout.write(typeof response === 'string' ? response : JSON.stringify(response))
} else {
  if (process.env.GH_FAIL_QUERY === '1') process.exit(17)
  process.stdout.write(process.env.GH_RESPONSE)
}
`
    )
    chmodSync(fakeGh, 0o755)

    if (failDiff) {
      const fakeGit = join(fakeBin, 'git')
      writeFileSync(
        fakeGit,
        '#!/bin/sh\nif [ "$1" = "diff" ]; then exit 2; fi\nexec "$GIT_REAL" "$@"\n'
      )
      chmodSync(fakeGit, 0o755)
    }

    const responseBody =
      typeof response === 'function'
        ? response({ baseline, head })
        : (response ?? { workflow_runs: [successfulRun(baseline)] })
    const jobsResponseBody = jobsResponses ?? { 42: verifiedJobs() }
    const result = spawnSync(realNode, [migrationGateScript], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_SHA: head,
        GH_CALL_LOG: ghCallLog,
        GH_FAIL_QUERY: failQuery ? '1' : '',
        GH_FAIL_JOBS: failJobs ? '1' : '',
        GH_RESPONSE: JSON.stringify(responseBody),
        GH_JOBS_RESPONSES: JSON.stringify(jobsResponseBody),
        GIT_REAL: realGit,
        GH_TOKEN: 'synthetic-token',
        REPOSITORY: 'adea-ai/control-plane',
      },
    })

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      output: readFileSync(outputPath, 'utf8'),
      ghCall: existsSync(ghCallLog) ? readFileSync(ghCallLog, 'utf8') : '',
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function workflowEvents(source) {
  return source.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1]?.trimEnd()
}

async function findCleanupBranch(responses, overrides = {}, observed = {}) {
  const requests = []
  const writes = []
  const waits = []
  Object.assign(observed, { requests, writes, waits })
  let index = 0
  await runInNewContext(cleanupScript, {
    URL,
    AbortSignal,
    process: {
      env: {
        NEON_API_KEY: 'synthetic-key',
        NEON_PROJECT_ID: 'synthetic-project-123',
        SHARD: '1',
        GITHUB_RUN_ID: '404',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_OUTPUT: '/synthetic/output',
        ...overrides,
      },
    },
    require: () => ({ appendFileSync: (path, value) => writes.push({ path, value }) }),
    fetch: async (url, options) => {
      requests.push({ url: String(url), options })
      const response = responses[Math.min(index++, responses.length - 1)]
      if (response instanceof Error) throw response
      return {
        status: response.status ?? 200,
        json: async () => {
          if (response.jsonError) throw response.jsonError
          return response.body
        },
      }
    },
    setTimeout: (callback, milliseconds) => {
      waits.push(milliseconds)
      callback()
    },
    console: { log: () => {} },
  })
  return { requests, writes, waits }
}

const previewBranch = {
  id: 'br-synthetic-preview',
  name: 'preview/main-404-1-s1',
  project_id: 'synthetic-project-123',
  parent_id: 'br-synthetic-parent',
  primary: false,
  default: false,
  protected: false,
}

describe('Neon preview cleanup lookup', () => {
  test('runs Neon credentialed validation only on main pushes', () => {
    expect(workflowEvents(workflow)).toBe('  push:\n    branches:\n      - main')
    expect(workflow).toContain('preview/main-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}')
    expect(workflow).toContain(
      'name=preview/main-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-s${{ matrix.shard }}'
    )
    expect(workflow).toContain("date -u --date '+1 day'")
    expect(workflow).toContain("if: always() && steps.create_neon_branch.outcome == 'success'")
  })

  test('partitions the suite across per-shard branches with the long pole on shard 1', () => {
    expect(workflow).toContain('fail-fast: false')
    expect(workflow).toContain('shard: [1, 2, 3]')
    expect(workflow).toContain('timeout-minutes: 45')
    expect(workflow).toContain('bun scripts/run-integration-tests.mjs --shard=${{ matrix.shard }}')
    const conformance = workflow.split('      - name: Verify cross-profile conformance matrix')[1]
    expect(conformance).toContain(
      "if: steps.credentials.outputs.available == 'true' && matrix.shard == 1"
    )
    expect(workflow).toContain('SHARD: ${{ matrix.shard }}')
  })

  test('runs the integration slice once while preserving a failed verify step', () => {
    const step = workflow
      .split("      - name: Verify migrations and this shard's integration slice")[1]
      ?.split('\n      - name:')[0]
    expect(step).not.toContain('if bun scripts/run-integration-tests.mjs')
    expect(step).not.toContain('retrying once for a transient Neon connection drop')
    expect(
      (
        step.match(/bun scripts\/run-integration-tests\.mjs --shard=\$\{\{ matrix\.shard \}\}/g) ??
        []
      ).length
    ).toBe(1)
    // The runner owns per-file retries; the workflow invokes each command once.
    expect((step.match(/db:migrate/g) ?? []).length).toBe(1)
  })

  test('keeps database credentials out of dependency installation, builds, and cleanup', () => {
    const urlSetupIndex = workflow.indexOf('      - name: Build restricted database URLs')
    expect(workflow.indexOf('run: bun install --frozen-lockfile')).toBeLessThan(urlSetupIndex)
    expect(workflow.indexOf('run: bun run build')).toBeLessThan(urlSetupIndex)

    const cleanup = workflow.split('      - name: Find exact preview branch for cleanup')[1]
    const deleteBranch = workflow.split('      - name: Delete Neon branch')[1]
    expect(cleanup).toBeString()
    expect(deleteBranch).toBeString()
    for (const name of [
      'DATABASE_URL',
      'DATABASE_URL_UNPOOLED',
      'DATABASE_MIGRATION_URL',
      'DATABASE_ADMIN_URL',
    ]) {
      expect(cleanup.split('      - name: Delete Neon branch')[0]).toContain(`${name}: ''`)
      expect(deleteBranch).toContain(`${name}: ''`)
    }
  })

  test('runs pull-request PostgreSQL checks with local credentials and no secret references', () => {
    expect(workflowEvents(pullRequestWorkflow)).toBe(
      '  pull_request:\n    branches:\n      - main\n    types:\n      - opened\n      - reopened\n      - synchronize\n      - ready_for_review'
    )
    expect(pullRequestWorkflow).toContain('local-admin-only')
    expect(pullRequestWorkflow).toContain('RUN_M10_POSTGRES_CONFORMANCE')
    expect(pullRequestWorkflow).toContain('bun run test:integration')
    expect(pullRequestWorkflow).toContain('docker compose up -d --wait postgres')
    expect(pullRequestWorkflow.indexOf('docker compose up -d --wait postgres')).toBeLessThan(
      pullRequestWorkflow.indexOf('bun --cwd=packages/database run db:migrate')
    )
    expect(pullRequestWorkflow).not.toMatch(/\$\{\{[^}]*\bsecrets\b|^\s*secrets\s*:/m)
  })

  test('scopes test database ownership setup to the freshly resolved preview administrator', () => {
    const setup = workflow
      .split('      - name: Prepare isolated preview database ownership')[1]
      ?.split("      - name: Verify migrations and this shard's integration slice")[0]
    expect(setup).toContain('DATABASE_ADMIN_URL: ${{ steps.create_neon_branch.outputs.db_url }}')
    expect(setup).toContain(
      'PREVIEW_DATABASE_HOST: ${{ steps.create_neon_branch.outputs.db_host }}'
    )
    expect(setup).toContain('url.hostname !== process.env.PREVIEW_DATABASE_HOST')
    expect(setup).toContain('url.username !== "neondb_owner"')
    expect(setup).toContain('GRANT control_plane_migrator TO neondb_owner WITH SET TRUE')
    expect(setup).not.toContain('GRANT control_plane_app')
  })
  test('treats a successfully verified absent preview as a no-op', async () => {
    expect(cleanupScript).toBeString()
    const result = await findCleanupBranch([{ body: { branches: [] } }])
    expect(result.writes).toEqual([])
    expect(result.requests).toHaveLength(1)
    expect(workflow).toContain("if: always() && steps.cleanup_branch.outputs.branch_id != ''")
    expect(workflow).toContain('branch: ${{ steps.cleanup_branch.outputs.branch_id }}')
  })

  test('matches the exact name across pagination and exports only a validated branch ID', async () => {
    const result = await findCleanupBranch([
      {
        body: {
          branches: [{ ...previewBranch, name: `${previewBranch.name}-other` }],
          pagination: { next: 'next/page' },
        },
      },
      { body: { branches: [previewBranch] } },
    ])
    expect(result.writes).toEqual([
      { path: '/synthetic/output', value: 'branch_id=br-synthetic-preview\n' },
    ])
    expect(new URL(result.requests[1].url).searchParams.get('cursor')).toBe('next/page')
    for (const request of result.requests) {
      expect(new URL(request.url).origin).toBe('https://console.neon.tech')
      expect(request.options.redirect).toBe('error')
      expect(request.options.headers.Authorization).toBe('Bearer synthetic-key')
    }
  })

  test('recovers a transient connection reset with bounded retries of the same lookup', async () => {
    const result = await findCleanupBranch([
      new TypeError('fetch failed: synthetic reset'),
      new TypeError('fetch failed: synthetic reset'),
      { body: { branches: [previewBranch] } },
    ])
    expect(result.requests).toHaveLength(3)
    expect(new Set(result.requests.map(({ url }) => url)).size).toBe(1)
    expect(result.waits).toEqual([500, 1000])
    expect(result.writes).toEqual([
      { path: '/synthetic/output', value: 'branch_id=br-synthetic-preview\n' },
    ])
  })

  test('retries a connection reset while reading the response body', async () => {
    const result = await findCleanupBranch([
      { jsonError: new TypeError('response body terminated') },
      { body: { branches: [previewBranch] } },
    ])
    expect(result.requests).toHaveLength(2)
    expect(result.requests[0].url).toBe(result.requests[1].url)
    expect(result.waits).toEqual([500])
    expect(result.writes).toHaveLength(1)
  })

  test('refuses to retry malformed JSON even if a later response would be valid', async () => {
    const observed = {}
    await expect(
      findCleanupBranch(
        [
          { jsonError: new SyntaxError('synthetic malformed JSON') },
          { body: { branches: [previewBranch] } },
        ],
        {},
        observed
      )
    ).rejects.toThrow('Invalid Neon branch listing')
    expect(observed.requests).toHaveLength(1)
    expect(observed.waits).toEqual([])
    expect(observed.writes).toEqual([])
  })

  test('retries only transient HTTP responses without treating them as absence', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const result = await findCleanupBranch([{ status }, { body: { branches: [previewBranch] } }])
      expect(result.requests).toHaveLength(2)
      expect(result.waits).toEqual([500])
      expect(result.writes).toHaveLength(1)
    }
    for (const status of [400, 401, 403, 404]) {
      const observed = {}
      await expect(findCleanupBranch([{ status }], {}, observed)).rejects.toThrow(
        `Neon cleanup lookup failed: HTTP ${status}`
      )
      expect(observed.requests).toHaveLength(1)
      expect(observed.waits).toEqual([])
      expect(observed.writes).toEqual([])
    }
  })

  test('fails closed after three transport failures without exposing the underlying error', async () => {
    const observed = {}
    await expect(
      findCleanupBranch([new TypeError('synthetic private transport detail')], {}, observed)
    ).rejects.toThrow('Neon cleanup lookup failed: transport error')
    expect(observed.requests).toHaveLength(3)
    expect(observed.waits).toEqual([500, 1000])
    expect(observed.writes).toEqual([])
  })

  test('bounds repeated server errors and refuses to retry invalid branch metadata', async () => {
    const exhausted = {}
    await expect(findCleanupBranch([{ status: 503 }], {}, exhausted)).rejects.toThrow(
      'Neon cleanup lookup failed: HTTP 503'
    )
    expect(exhausted.requests).toHaveLength(3)
    expect(exhausted.waits).toEqual([500, 1000])
    expect(exhausted.writes).toEqual([])
    const invalid = {}
    await expect(
      findCleanupBranch(
        [
          { body: { branches: [{ ...previewBranch, protected: true }] } },
          { body: { branches: [previewBranch] } },
        ],
        {},
        invalid
      )
    ).rejects.toThrow('Unsafe or ambiguous Neon cleanup target')
    expect(invalid.requests).toHaveLength(1)
    expect(invalid.waits).toEqual([])
    expect(invalid.writes).toEqual([])
    expect(workflow).toContain('timeout-minutes: 12')
  })

  test('retries the current pagination page without discarding previously validated entries', async () => {
    const result = await findCleanupBranch([
      { body: { branches: [previewBranch], pagination: { next: 'next/page' } } },
      new TypeError('fetch failed'),
      { body: { branches: [] } },
    ])
    expect(result.requests).toHaveLength(3)
    expect(result.requests[1].url).toBe(result.requests[2].url)
    expect(new URL(result.requests[2].url).searchParams.get('cursor')).toBe('next/page')
    expect(result.writes).toHaveLength(1)
  })

  test('does not turn API failures or malformed listings into successful absence', async () => {
    for (const response of [
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { status: 429 },
      { status: 500 },
      { body: {} },
      { body: { branches: [null] } },
      { body: { branches: [], pagination: { next: 1 } } },
      { body: { branches: [], pagination: 'invalid' } },
      new Error('synthetic network failure'),
    ]) {
      await expect(findCleanupBranch([response])).rejects.toThrow()
    }
  })

  test('rejects unsafe or ambiguous targets and pagination loops', async () => {
    for (const override of [
      { id: 'br-invalid\nother=output' },
      { project_id: 'another-project' },
      { parent_id: undefined },
      { primary: true },
      { default: true },
      { protected: true },
    ]) {
      await expect(
        findCleanupBranch([{ body: { branches: [{ ...previewBranch, ...override }] } }])
      ).rejects.toThrow()
    }
    await expect(
      findCleanupBranch([{ body: { branches: [previewBranch, previewBranch] } }])
    ).rejects.toThrow()
    await expect(
      findCleanupBranch([
        { body: { branches: [], pagination: { next: 'same' } } },
        { body: { branches: [], pagination: { next: 'same' } } },
      ])
    ).rejects.toThrow()
  })

  test('rejects missing credentials and malformed scope before fetching', async () => {
    for (const override of [
      { NEON_API_KEY: '' },
      { NEON_PROJECT_ID: '../other' },
      { SHARD: '' },
      { SHARD: 'x' },
      { SHARD: '1 ' },
      { GITHUB_RUN_ID: '0' },
      { GITHUB_RUN_ATTEMPT: '0' },
      { GITHUB_RUN_ID: '404/other' },
      { GITHUB_OUTPUT: '' },
    ]) {
      await expect(findCleanupBranch([], override)).rejects.toThrow(
        'Neon cleanup inputs are unavailable or invalid'
      )
    }
  })

  test('requires a complete listing even after finding a target', async () => {
    await expect(
      findCleanupBranch([
        { body: { branches: [previewBranch], pagination: { next: 'next' } } },
        { status: 500 },
      ])
    ).rejects.toThrow('Neon cleanup lookup failed: HTTP 500')
    await expect(
      findCleanupBranch(
        Array.from({ length: 20 }, (_, index) => ({
          body: { branches: [], pagination: { next: `page-${index}` } },
        }))
      )
    ).rejects.toThrow('Neon branch lookup exceeded pagination limit')
  })
})

function execute(overrides = {}) {
  const writes = []
  const masks = []
  const env = {
    DATABASE_HOST: 'direct.example.invalid',
    DATABASE_HOST_POOLED: 'pool.example.invalid',
    DATABASE_APP_PASSWORD: 'synthetic@app:password',
    DATABASE_MIGRATION_PASSWORD: 'synthetic/migration?password',
    DATABASE_ADMIN_PASSWORD: 'synthetic/admin?password',
    GITHUB_ENV: '/synthetic/github-env',
    ...overrides,
  }
  runInNewContext(script, {
    URL,
    process: { env },
    require: (name) => {
      expect(name).toBe('node:fs')
      return { appendFileSync: (path, value) => writes.push({ path, value }) }
    },
    console: { log: (value) => masks.push(value) },
  })
  return { writes, masks }
}

describe('Neon restricted connection workflow', () => {
  test('exports distinct pooled and direct app connections without elevating their role', () => {
    expect(script).toBeString()
    const { writes, masks } = execute()
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('/synthetic/github-env')
    const values = Object.fromEntries(
      writes[0].value
        .trim()
        .split('\n')
        .map((line) => {
          const split = line.indexOf('=')
          return [line.slice(0, split), line.slice(split + 1)]
        })
    )
    for (const [name, host, role, password] of [
      ['DATABASE_URL', 'pool.example.invalid', 'control_plane_app', 'synthetic@app:password'],
      [
        'DATABASE_URL_UNPOOLED',
        'direct.example.invalid',
        'control_plane_app',
        'synthetic@app:password',
      ],
      [
        'DATABASE_MIGRATION_URL',
        'direct.example.invalid',
        'control_plane_migrator',
        'synthetic/migration?password',
      ],
      [
        'DATABASE_ADMIN_URL',
        'direct.example.invalid',
        'control_plane_admin',
        'synthetic/admin?password',
      ],
    ]) {
      const url = new URL(values[name])
      expect(url.hostname).toBe(host)
      expect(url.username).toBe(role)
      expect(decodeURIComponent(url.password)).toBe(password)
      expect(url.searchParams.get('sslmode')).toBe('require')
      expect(masks).toContain(`::add-mask::${values[name]}`)
    }
    expect(masks).toHaveLength(4)
  })

  test('fails closed when required connection inputs are absent', () => {
    for (const name of [
      'DATABASE_HOST',
      'DATABASE_HOST_POOLED',
      'DATABASE_APP_PASSWORD',
      'DATABASE_MIGRATION_PASSWORD',
      'DATABASE_ADMIN_PASSWORD',
      'GITHUB_ENV',
    ]) {
      expect(() => execute({ [name]: undefined })).toThrow(
        'Neon migration connection inputs are unavailable'
      )
    }
  })
})

describe('Neon trusted-main migration gating', () => {
  test('the shard matrix skips only an explicit successful classifier skip', () => {
    const verifyJob = workflow.split('\n  verify_neon_preview:\n')[1]
    const conditionBlock = verifyJob.match(/^    if:\s*>-\n((?:      .*\n?)+)/m)?.[1]
    const condition = conditionBlock?.replace(/\s+/g, ' ').trim()
    expect(condition).toBeDefined()
    expect(workflow).toContain('node .github/scripts/neon-migration-gate.mjs')

    const scenarios = [
      { result: 'success', verify: 'false', cancelled: false, expected: false },
      { result: 'success', verify: 'true', cancelled: false, expected: true },
      { result: 'success', verify: '', cancelled: false, expected: true },
      { result: 'failure', verify: 'false', cancelled: false, expected: true },
      { result: 'skipped', verify: 'false', cancelled: false, expected: true },
      { result: 'success', verify: 'false', cancelled: true, expected: false },
    ]
    for (const { result, verify, cancelled, expected } of scenarios) {
      expect(
        runInNewContext(condition, {
          cancelled: () => cancelled,
          needs: { changes: { result, outputs: { verify } } },
        })
      ).toBe(expected)
    }
  })

  test('reads a successful workflow_runs baseline and skips only unrelated changes', () => {
    const result = runMigrationGate({ changedPaths: ['docs/notes.md'] })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=false\n')
    expect(result.ghCall).toContain(
      'repos/adea-ai/control-plane/actions/workflows/neon_workflow.yml/runs?branch=main&event=push&status=success&per_page=25'
    )
    expect(result.ghCall).toContain('/actions/runs/42/jobs?filter=latest&per_page=100')
  }, 30_000)

  test('requires a recent completed successful main push as the baseline candidate', () => {
    for (const response of [
      { workflow_runs: [] },
      ({ baseline }) => ({
        workflow_runs: [successfulRun(baseline, { event: 'workflow_dispatch' })],
      }),
      ({ baseline }) => ({
        workflow_runs: [successfulRun(baseline, { head_branch: 'topic' })],
      }),
      ({ baseline }) => ({
        workflow_runs: [successfulRun(baseline, { run_attempt: undefined })],
      }),
    ]) {
      const result = runMigrationGate({ response, jobsResponses: {} })
      expect(result.status).toBe(0)
      expect(result.output).toBe('verify=true\n')
    }
  }, 30_000)

  test('fails open when baseline or job APIs fail or have unexpected response shapes', () => {
    for (const options of [
      { failQuery: true },
      { response: { runs: [{ head_sha: '0'.repeat(40) }] } },
      { failJobs: true },
      { jobsResponses: { 42: { runs: [] } } },
    ]) {
      const result = runMigrationGate(options)
      expect(result.status).toBe(0)
      expect(result.output).toBe('verify=true\n')
    }
  }, 30_000)

  test('rejects green workflow runs whose actual shard verification did not succeed', () => {
    const skippedJobs = { jobs: [] }
    const unavailableJobs = verifiedJobs()
    unavailableJobs.jobs[0].steps.find((step) => step.name === migrationVerifyStep).conclusion =
      'skipped'
    const missingShardJobs = verifiedJobs()
    missingShardJobs.jobs.pop()
    const failedIntegrationJobs = verifiedJobs()
    failedIntegrationJobs.jobs[2].steps.find(
      (step) => step.name === migrationVerifyStep
    ).conclusion = 'failure'
    const failedConformanceJobs = verifiedJobs()
    failedConformanceJobs.jobs[0].steps.find((step) => step.name === conformanceStep).conclusion =
      'skipped'
    const duplicateShardJobs = verifiedJobs()
    duplicateShardJobs.jobs.push({ ...duplicateShardJobs.jobs[0] })

    for (const jobs of [
      skippedJobs,
      unavailableJobs,
      missingShardJobs,
      failedIntegrationJobs,
      failedConformanceJobs,
      duplicateShardJobs,
    ]) {
      const result = runMigrationGate({ jobsResponses: { 42: jobs } })
      expect(result.status).toBe(0)
      expect(result.output).toBe('verify=true\n')
    }
  }, 60_000)

  test('finds an actual verified baseline below recent successful runs that skipped shards', () => {
    const result = runMigrationGate({
      response: ({ baseline, head }) => ({
        workflow_runs: [successfulRun(head, { id: 43 }), successfulRun(baseline, { id: 42 })],
      }),
      jobsResponses: {
        43: { jobs: [] },
        42: verifiedJobs(),
      },
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=false\n')
    expect(result.ghCall).toContain('/actions/runs/43/jobs?filter=latest&per_page=100')
    expect(result.ghCall).toContain('/actions/runs/42/jobs?filter=latest&per_page=100')
  }, 30_000)

  test('bounds the verification-baseline scan to 25 recent successful runs', () => {
    const result = runMigrationGate({
      response: ({ baseline }) => ({
        workflow_runs: Array.from({ length: 26 }, (_, index) =>
          successfulRun(baseline, { id: 100 + index })
        ),
      }),
      jobsResponses: Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [
          String(100 + index),
          index === 25 ? verifiedJobs() : { jobs: [] },
        ])
      ),
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=true\n')
    expect(result.ghCall.match(/\/actions\/runs\/\d+\/jobs\?/g)).toHaveLength(25)
  }, 30_000)

  test('fails open when the baseline is not an ancestor or the diff cannot be read', () => {
    for (const options of [{ baselineMode: 'non-ancestor' }, { failDiff: true }]) {
      const result = runMigrationGate(options)
      expect(result.status).toBe(0)
      expect(result.output).toBe('verify=true\n')
    }
  }, 30_000)

  test('treats a relevant file renamed outside the included trees as relevant', () => {
    const result = runMigrationGate({
      baseFiles: { 'packages/database/src/schema.ts': 'unchanged content\n' },
      renamePaths: [{ from: 'packages/database/src/schema.ts', to: 'docs/schema-notes.md' }],
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=true\n')
  }, 30_000)

  test('runs for migration, integration, conformance, and toolchain inputs', () => {
    for (const changedPath of [
      '.github/actions/checkout/action.yml',
      'apps/control-api/src/server.ts',
      'packages/database/src/schema.ts',
      'scripts/integration-shards.mjs',
      'scripts/run-cloud-remote-drill.mjs',
      'scripts/run-integration-tests.mjs',
      'tests/cp1-embedded-durable-execution.test.mjs',
      'tests/integration-shards.test.mjs',
      '.mise.toml',
      '.github/code-foundry.yml',
      '.github/workflows/neon_workflow.yml',
      '.github/scripts/neon-migration-gate.mjs',
      '.bun-version',
      '.node-version',
      '.npmrc',
      '.release-please-manifest.json',
      '.tool-versions',
      'bun.lock',
      'bunfig.toml',
      'package.json',
      'turbo.json',
      'tsconfig.json',
    ]) {
      expect(isMigrationRelevantPath(changedPath)).toBe(true)
    }
    expect(isMigrationRelevantPath('docs/notes.md')).toBe(false)
    expect(isMigrationRelevantPath('scripts/run-postgres-restore-drill.mjs')).toBe(false)
  })

  test('a Release Please commit with migration-relevant changes still runs verification', () => {
    const result = runMigrationGate({
      changedPaths: ['packages/database/src/schema.ts'],
      headMessage: 'chore(main): release 1.71.2',
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=true\n')
  }, 30_000)

  test('skips a Release Please commit only when a successful baseline proves metadata-only changes', () => {
    const result = runMigrationGate({
      baseFiles: {
        'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }),
        '.release-please-manifest.json': JSON.stringify({ '.': '1.0.0' }),
        'CHANGELOG.md': '# Changelog\n\nPrevious release.\n',
      },
      changedPaths: ['package.json', '.release-please-manifest.json', 'CHANGELOG.md'],
      changedFiles: {
        'package.json': JSON.stringify({ name: 'fixture', version: '1.0.1', private: true }),
        '.release-please-manifest.json': JSON.stringify({ '.': '1.0.1' }),
        'CHANGELOG.md': '# Changelog\n\nNew release.\n',
      },
      headMessage: 'chore(main): release 1.0.1 (#1)',
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=false\n')
  }, 30_000)

  test('the workflow checks out full history for baseline ancestry and diffing', () => {
    expect(workflow).toContain('fetch-depth: 0')
    expect(migrationGateSource).toContain('merge-base')
    expect(migrationGateSource).toContain('.workflow_runs')
  })
})
