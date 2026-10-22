// Historical provider-contract regressions use an immutable retired fixture.
// Active database qualification is covered by infrastructure.test.mjs.
import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  appendFileSync,
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
import { isNeonProofRelevantPath } from '../.github/scripts/neon-migration-gate.mjs'
import { verifyNeonMigratorDdl } from '../packages/database/scripts/neon-ddl-probe.mjs'

const workflow = readFileSync(
  new URL('./fixtures/retired-neon-workflow.yml', import.meta.url),
  'utf8'
)
const pullRequestWorkflow = readFileSync(
  new URL('../.github/workflows/postgres-pull-request.yml', import.meta.url),
  'utf8'
)
const script = workflow.split("node <<'NODE'\n")[1]?.split('\n          NODE')[0]
const cleanupScript = workflow.split("node <<'CLEANUP'\n")[1]?.split('\n          CLEANUP')[0]
const verifyAbsenceScript = workflow.split("node <<'VERIFY'\n")[1]?.split('\n          VERIFY')[0]
const migrationGateScript = fileURLToPath(
  new URL('../.github/scripts/neon-migration-gate.mjs', import.meta.url)
)
const migrationGateSource = readFileSync(migrationGateScript, 'utf8')
const neonCompatibilitySource = readFileSync(
  new URL('../packages/database/scripts/verify-neon-provider-compatibility.mjs', import.meta.url),
  'utf8'
)
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const realNode = execFileSync('which', ['node'], { encoding: 'utf8' }).trim()
const neonCompatibilityStep = 'Verify Neon provider compatibility'
const branchCreateStep = 'Create Neon branch'
const cleanupLookupStep = 'Find exact preview branch for cleanup'
const deleteBranchStep = 'Delete Neon branch'
const absenceStep = 'Verify Neon branch absence'
const budgetStep = 'Enforce five-minute Neon verification budget'
const migrationVerifyStep = "Verify migrations and this shard's integration slice"
const conformanceStep = 'Verify cross-profile conformance matrix (Postgres)'
const hostedGraphStep = 'Verify Hosted PostgreSQL and Restate graph'

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
    jobs: [
      {
        name: 'Verify Neon provider compatibility',
        status: 'completed',
        conclusion: 'success',
        steps: [
          branchCreateStep,
          neonCompatibilityStep,
          cleanupLookupStep,
          deleteBranchStep,
          absenceStep,
          budgetStep,
        ].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
      },
    ],
  }
}

function legacyVerifiedJobs() {
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
        ...(shard === 3
          ? [{ name: hostedGraphStep, status: 'completed', conclusion: 'success' }]
          : []),
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
  intermediateCommits = [],
  pushBefore = 'parent',
  baselineMode = 'ancestor',
  response = undefined,
  parentResponse = undefined,
  jobsResponses = undefined,
  failQuery = false,
  failJobs = false,
  failDiff = false,
  headMessage = 'fix: update docs',
} = {}) {
  const resourceLedger = process.env.M11_RESOURCE_LEDGER
  if (resourceLedger) {
    appendFileSync(
      resourceLedger,
      JSON.stringify({
        owner: 'Neon migration gate tests',
        prefix: 'neon-migration-gate-',
        state: 'planned',
      }) + '\n'
    )
  }
  const directory = mkdtempSync(join(tmpdir(), 'neon-migration-gate-'))
  if (resourceLedger) {
    appendFileSync(
      resourceLedger,
      JSON.stringify({ owner: 'Neon migration gate tests', directory, state: 'created' }) + '\n'
    )
  }
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

    for (const commit of intermediateCommits) {
      for (const relativePath of commit.changedPaths ?? []) {
        writeGateFile(repository, relativePath, commit.changedFiles?.[relativePath] ?? 'changed\n')
      }
      runGateGit(repository, ['add', '--all'])
      runGateGit(repository, ['commit', '--quiet', '-m', commit.message ?? 'intermediate'])
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
    const parent = runGateGit(repository, ['rev-parse', 'HEAD^'])

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
  process.stdout.write(args.includes('head_sha=') ? process.env.GH_PARENT_RESPONSE : process.env.GH_RESPONSE)
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
    const parentResponseBody =
      typeof parentResponse === 'function'
        ? parentResponse({ baseline, head, parent })
        : (parentResponse ?? { workflow_runs: [successfulRun(parent, { id: 43 })] })
    const jobsResponseBody = jobsResponses ?? { 42: verifiedJobs(), 43: verifiedJobs() }
    const result = spawnSync(realNode, [migrationGateScript], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_SHA: head,
        GITHUB_EVENT_BEFORE:
          pushBefore === 'parent'
            ? runGateGit(repository, ['rev-parse', 'HEAD^'])
            : pushBefore === 'baseline'
              ? mainBase
              : pushBefore,
        GH_CALL_LOG: ghCallLog,
        GH_FAIL_QUERY: failQuery ? '1' : '',
        GH_FAIL_JOBS: failJobs ? '1' : '',
        GH_RESPONSE: JSON.stringify(responseBody),
        GH_PARENT_RESPONSE: JSON.stringify(parentResponseBody),
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
    if (resourceLedger) {
      appendFileSync(
        resourceLedger,
        JSON.stringify({ owner: 'Neon migration gate tests', directory, state: 'removed' }) + '\n'
      )
    }
  }
}

function workflowEvents(source) {
  return source.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1]?.trimEnd()
}

async function findCleanupBranch(responses, overrides = {}, observed = {}) {
  const requests = []
  const writes = []
  const waits = []
  const messages = []
  Object.assign(observed, { requests, writes, waits, messages })
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
        NEON_CREATE_OUTCOME: 'success',
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
    console: { log: (value) => messages.push(value) },
  })
  return { requests, writes, waits, messages }
}

const manualCleanupInputs = {
  NEON_CLEANUP_MODE: 'completed-run',
  NEON_CLEANUP_RUN_ID: '404',
  NEON_CLEANUP_RUN_ATTEMPT: '1',
  NEON_CLEANUP_HEAD_SHA: 'a'.repeat(40),
  GH_TOKEN: 'synthetic-github-token',
  GITHUB_REPOSITORY: 'adea-ai/control-plane',
}

function cleanupOwner(overrides = {}) {
  return {
    ...successfulRun(manualCleanupInputs.NEON_CLEANUP_HEAD_SHA),
    id: 404,
    path: '.github/workflows/neon_workflow.yml',
    repository: { full_name: 'adea-ai/control-plane' },
    ...overrides,
  }
}

function cleanupOwnerJobs(overrides = {}) {
  const { jobName = 'Verify Neon provider compatibility', ...responseOverrides } = overrides
  return {
    total_count: 1,
    jobs: [
      {
        name: jobName,
        status: 'completed',
        steps: [{ name: 'Create Neon branch', status: 'completed', conclusion: 'failure' }],
      },
    ],
    ...responseOverrides,
  }
}

async function verifyCleanupAbsence(responses, overrides = {}, observed = {}) {
  const requests = []
  const waits = []
  const messages = []
  Object.assign(observed, { requests, waits, messages })
  let index = 0
  await runInNewContext(verifyAbsenceScript, {
    AbortSignal,
    process: {
      env: {
        NEON_API_KEY: 'synthetic-key',
        NEON_PROJECT_ID: 'synthetic-project-123',
        TARGET_BRANCH_ID: 'br-synthetic-preview',
        ...overrides,
      },
    },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options })
      const response = responses[Math.min(index++, responses.length - 1)]
      if (response instanceof Error) throw response
      return { status: response.status, body: { cancel: async () => {} } }
    },
    setTimeout: (callback, milliseconds) => {
      waits.push(milliseconds)
      callback()
    },
    console: { log: (value) => messages.push(value) },
  })
  return { requests, waits, messages }
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
  test('cleanup dispatch uses the protected default workflow and drops unused token scope', () => {
    expect(workflowEvents(workflow)).toBe(
      '  push:\n    branches:\n      - main\n  repository_dispatch:\n    types: [neon-preview-cleanup]'
    )
    const cleanupJob = workflow.split('  cleanup_completed_preview:')[1]
    expect(cleanupJob).toContain(
      "if: github.event_name == 'repository_dispatch' && github.ref == 'refs/heads/main'"
    )
    expect(cleanupJob).toContain('NEON_CLEANUP_MODE: completed-run')
    expect(cleanupJob).toContain(
      'NEON_CLEANUP_RUN_ID: ${{ github.event.client_payload.cleanup_run_id }}'
    )
    expect(cleanupJob).toContain('actions: read')
    expect(cleanupJob).not.toContain('contents: read')
  })

  test('an empty completed-run cleanup payload never falls back to current-run ownership', async () => {
    const observed = {}
    await expect(
      findCleanupBranch(
        [{ body: { branches: [previewBranch] } }],
        {
          NEON_CLEANUP_MODE: 'completed-run',
        },
        observed
      )
    ).rejects.toThrow('cleanup inputs are unavailable or invalid')
    expect(observed.requests).toEqual([])
    expect(observed.writes).toEqual([])
  })
  test('queues main runs and looks for the exact branch after an unacknowledged creation', async () => {
    expect(workflow).toContain('cancel-in-progress: false')
    const group = workflow.match(/^  group: \$\{\{(.*)\}\}/m)?.[1]
    expect(runInNewContext(group, { github: { event_name: 'push' } })).toBe('neon-main-preview')
    expect(runInNewContext(group, { github: { event_name: 'repository_dispatch' } })).toBe(
      'neon-completed-preview-cleanup'
    )
    expect(workflow).toContain("if: always() && steps.preview_branch.outputs.name != ''")
    const result = await findCleanupBranch([{ body: { branches: [previewBranch] } }], {
      NEON_CREATE_OUTCOME: 'failure',
    })
    expect(result.writes).toEqual([
      { path: '/synthetic/output', value: 'branch_id=br-synthetic-preview\n' },
    ])
  })

  test('a lost creation acknowledgement cannot classify a missing branch as settled cleanup', async () => {
    const observed = {}
    await expect(
      findCleanupBranch([{ body: { branches: [] } }], { NEON_CREATE_OUTCOME: 'failure' }, observed)
    ).rejects.toThrow('Neon creation outcome is unconfirmed')
    expect(observed.writes).toEqual([])
  })

  test('runs Neon creation only on main pushes and fences cleanup dispatch to main', () => {
    expect(workflowEvents(workflow)).toContain('  push:\n    branches:\n      - main\n')
    expect(workflowEvents(workflow)).toContain(
      '  repository_dispatch:\n    types: [neon-preview-cleanup]'
    )
    expect(workflowEvents(workflow)).not.toContain('pull_request')
    const creationJob = workflow
      .split('  verify_neon_preview:')[1]
      ?.split('  cleanup_completed_preview:')[0]
    expect(creationJob).toContain("github.event_name == 'push' && !cancelled()")
    const cleanupJob = workflow.split('  cleanup_completed_preview:')[1]
    expect(cleanupJob).toContain(
      "if: github.event_name == 'repository_dispatch' && github.ref == 'refs/heads/main'"
    )
    expect(cleanupJob).not.toMatch(/create-branch-action|bun install|bun run build|db:migrate/)
    expect(cleanupJob).toContain('run: *find_owned_preview_branch')
    expect(cleanupJob).toContain('run: *verify_owned_preview_absence')
    expect(workflow).toContain('preview/main-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}')
    expect(workflow).toContain('name=preview/main-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-s1')
    expect(workflow).toContain("SHARD: '1'")
    expect(workflow).toContain("date -u --date '+1 day'")
    expect(workflow).toContain("if: always() && steps.preview_branch.outputs.name != ''")
  })

  test('manual cleanup resolves the recorded completed creator before querying Neon', async () => {
    const result = await findCleanupBranch(
      [
        { body: cleanupOwner() },
        { body: cleanupOwnerJobs() },
        { body: { branches: [previewBranch] } },
      ],
      manualCleanupInputs
    )
    expect(result.requests.map(({ url }) => url)).toEqual([
      'https://api.github.com/repos/adea-ai/control-plane/actions/runs/404',
      'https://api.github.com/repos/adea-ai/control-plane/actions/runs/404/attempts/1/jobs?per_page=100',
      'https://console.neon.tech/api/v2/projects/synthetic-project-123/branches?search=preview%2Fmain-404-1-s1&limit=1000',
    ])
    expect(result.requests[0].options.headers.Authorization).toBe('Bearer synthetic-github-token')
    expect(result.requests[2].options.headers.Authorization).toBe('Bearer synthetic-key')
    expect(result.writes[0].value).toBe('branch_id=br-synthetic-preview\n')
  })

  test('manual cleanup still resolves legacy shard 2 owners and branch suffixes', async () => {
    const result = await findCleanupBranch(
      [
        { body: cleanupOwner() },
        {
          body: cleanupOwnerJobs({
            jobName: 'Verify Neon shard 2 (migrations and integration slice)',
          }),
        },
        {
          body: {
            branches: [{ ...previewBranch, name: 'preview/main-404-1-s2' }],
          },
        },
      ],
      { ...manualCleanupInputs, SHARD: '2' }
    )
    expect(result.requests[2].url).toContain('search=preview%2Fmain-404-1-s2')
    expect(result.writes).toEqual([
      { path: '/synthetic/output', value: 'branch_id=br-synthetic-preview\n' },
    ])
  })

  test('manual cleanup refuses wrong or live owners before any Neon request', async () => {
    for (const overrides of [
      { id: 405 },
      { run_attempt: 2 },
      { event: 'pull_request' },
      { head_branch: 'topic' },
      { head_sha: 'b'.repeat(40) },
      { status: 'in_progress' },
      { path: '.github/workflows/other.yml' },
      { repository: { full_name: 'other/repo' } },
    ]) {
      const observed = {}
      await expect(
        findCleanupBranch([{ body: cleanupOwner(overrides) }], manualCleanupInputs, observed)
      ).rejects.toThrow('recorded completed trusted-main run')
      expect(observed.requests).toHaveLength(1)
      expect(observed.writes).toEqual([])
    }
  })

  test('manual cleanup refuses incomplete, ambiguous or live creator jobs', async () => {
    const job = cleanupOwnerJobs().jobs[0]
    for (const result of [
      cleanupOwnerJobs({ total_count: 2 }),
      cleanupOwnerJobs({ total_count: 0, jobs: [] }),
      cleanupOwnerJobs({ total_count: 2, jobs: [job, job] }),
      cleanupOwnerJobs({ jobs: [{ ...job, status: 'in_progress' }] }),
      cleanupOwnerJobs({ jobs: [{ ...job, steps: [] }] }),
      cleanupOwnerJobs({ jobs: [{ ...job, steps: [job.steps[0], job.steps[0]] }] }),
      cleanupOwnerJobs({ jobs: [{ ...job, steps: [{ ...job.steps[0], status: 'in_progress' }] }] }),
    ]) {
      const observed = {}
      await expect(
        findCleanupBranch(
          [{ body: cleanupOwner() }, { body: result }],
          manualCleanupInputs,
          observed
        )
      ).rejects.toThrow(/owner jobs are incomplete|creator is not terminal and unique/)
      expect(observed.requests).toHaveLength(2)
      expect(observed.writes).toEqual([])
    }
  })

  test('manual cleanup refuses partial inputs and owner API failures', async () => {
    for (const overrides of [
      { NEON_CLEANUP_RUN_ATTEMPT: '' },
      { NEON_CLEANUP_HEAD_SHA: '' },
      { GH_TOKEN: '' },
    ]) {
      const observed = {}
      await expect(
        findCleanupBranch([], { ...manualCleanupInputs, ...overrides }, observed)
      ).rejects.toThrow()
      expect(observed.requests).toEqual([])
    }
    for (const response of [{ status: 403 }, new Error('synthetic transport')]) {
      const observed = {}
      await expect(findCleanupBranch([response], manualCleanupInputs, observed)).rejects.toThrow(
        'owner lookup failed'
      )
      expect(observed.requests).toHaveLength(1)
      expect(observed.writes).toEqual([])
    }
  })

  test('manual absence observation preserves the unknown creation acknowledgement', async () => {
    const result = await findCleanupBranch(
      [{ body: cleanupOwner() }, { body: cleanupOwnerJobs() }, { body: { branches: [] } }],
      manualCleanupInputs
    )
    expect(result.writes).toEqual([])
    expect(result.messages).toEqual([
      'No matching preview observed after terminal creator; original creation acknowledgement remains unknown.',
    ])
  })

  test('deletion verification requires a branch metadata 404', async () => {
    const result = await verifyCleanupAbsence([{ status: 200 }, { status: 404 }])
    expect(result.requests).toHaveLength(2)
    expect(result.requests[0].url).toBe(
      'https://console.neon.tech/api/v2/projects/synthetic-project-123/branches/br-synthetic-preview'
    )
    expect(result.requests[0].options.redirect).toBe('error')
    expect(result.waits).toEqual([500])
    expect(result.messages).toEqual([
      'Verified preview branch metadata is absent: br-synthetic-preview',
    ])
  })

  test('deletion verification refuses authorization failure and caps unresolved retries', async () => {
    for (const response of [{ status: 401 }, { status: 200 }, new Error('synthetic transport')]) {
      const observed = {}
      await expect(verifyCleanupAbsence([response], {}, observed)).rejects.toThrow(
        'deletion is not confirmed'
      )
      expect(observed.requests).toHaveLength(response.status === 401 ? 1 : 3)
      expect(observed.waits).toEqual(response.status === 401 ? [] : [500, 1000])
      expect(observed.messages).toEqual([])
    }
  })

  test('deletion verification rejects malformed identifiers without making requests', async () => {
    const observed = {}
    await expect(
      verifyCleanupAbsence([], { TARGET_BRANCH_ID: '../protected' }, observed)
    ).rejects.toThrow('Invalid Neon deletion verification inputs')
    expect(observed.requests).toEqual([])
  })

  test('keeps Neon to one bounded provider proof while portable coverage remains local', () => {
    expect(workflow).not.toContain('matrix:')
    expect(workflow).not.toContain('bun scripts/run-integration-tests.mjs')
    expect(workflow).not.toContain('db:migrate')
    expect(workflow).not.toContain('bun run build')
    expect(workflow).not.toContain('RUN_M10_POSTGRES_CONFORMANCE')
    expect(workflow).toContain('timeout-minutes: 15')
    expect(workflow).not.toContain('timeout-minutes: 20')
    expect(workflow).toContain(
      'timeout --signal=TERM --kill-after=5s 90s bun --cwd=packages/database scripts/verify-neon-provider-compatibility.mjs'
    )
    const proof = workflow
      .split(`      - name: ${neonCompatibilityStep}`)[1]
      ?.split('\n      - name:')[0]
    expect(proof).toContain('timeout-minutes: 2')
    expect(workflow.indexOf('Start Neon verification budget')).toBeLessThan(
      workflow.indexOf('Create Neon branch')
    )
    expect(workflow.indexOf('Install dependencies')).toBeLessThan(
      workflow.indexOf('Create Neon branch')
    )
    expect(workflow).toContain('timeout-minutes: 5')
    expect(workflow.indexOf('Verify Neon branch absence')).toBeLessThan(
      workflow.indexOf(budgetStep)
    )
    expect(workflow).toContain('elapsed > 300')
    expect(workflow).toContain('test -n "$DATABASE_MIGRATION_PASSWORD"')
    expect(workflow).toContain('[[ "$NEON_PROJECT_ID" =~ ^[a-z0-9-]{1,60}$ ]]')
    expect(workflow).not.toContain('NEON_CI_ADMIN_PASSWORD')
    expect(neonCompatibilitySource).toContain("role: 'control_plane_app'")
    expect(neonCompatibilitySource).toContain("role: 'control_plane_migrator'")
    expect(neonCompatibilitySource).toContain("url.searchParams.get('sslmode')")
    expect(neonCompatibilitySource).toContain('pooler\\.')
    expect(neonCompatibilitySource).toContain('verifyNeonMigratorDdl(sql)')
  })

  test('keeps database credentials out of dependency installation and cleanup', () => {
    const urlSetupIndex = workflow.indexOf('      - name: Build restricted database URLs')
    expect(workflow.indexOf('run: bun install --frozen-lockfile')).toBeLessThan(urlSetupIndex)

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
    expect(workflowEvents(pullRequestWorkflow)).toBe('  workflow_call: {}')
    expect(pullRequestWorkflow).toContain('local-admin-only')
    expect(pullRequestWorkflow).toContain('RUN_M10_POSTGRES_CONFORMANCE')
    expect(pullRequestWorkflow).toContain('bun test tests/cp1-embedded-durable-execution.test.mjs')
    expect(
      pullRequestWorkflow.split('bash scripts/run-hosted-graph-qualification.sh')
    ).toHaveLength(2)
    expect(pullRequestWorkflow).not.toContain('bun run test:integration')
    expect(pullRequestWorkflow).toContain('docker compose up -d --wait postgres')
    expect(pullRequestWorkflow.indexOf('docker compose up -d --wait postgres')).toBeLessThan(
      pullRequestWorkflow.indexOf('bun --cwd=packages/database run db:migrate')
    )
    expect(pullRequestWorkflow).toContain(
      'COMPOSE_PROJECT_NAME: control-plane-pr-${{ github.run_id }}-${{ github.run_attempt }}'
    )
    const cleanup = pullRequestWorkflow.split('      - name: Remove owned PostgreSQL fixture')[1]
    expect(cleanup).toContain('if: always()')
    expect(cleanup).toContain('timeout-minutes: 3')
    expect(cleanup).toContain('docker compose down --volumes --remove-orphans --timeout 60')
    expect(pullRequestWorkflow).not.toMatch(/\$\{\{[^}]*\bsecrets\b|^\s*secrets\s*:/m)
  })

  test('uses restricted runtime and migrator URLs without an admin role or grants', () => {
    const setup = workflow
      .split('      - name: Build restricted database URLs')[1]
      ?.split(`      - name: ${neonCompatibilityStep}`)[0]
    expect(setup).toContain('control_plane_app')
    expect(setup).toContain('control_plane_migrator')
    expect(setup).toContain('DATABASE_URL_UNPOOLED')
    expect(setup).not.toContain('control_plane_admin')
    expect(setup).not.toContain('GRANT ')
    expect(setup).not.toContain('DATABASE_ADMIN_PASSWORD')
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
    expect(workflow).toContain('timeout-minutes: 5')
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
    ]) {
      const url = new URL(values[name])
      expect(url.hostname).toBe(host)
      expect(url.username).toBe(role)
      expect(decodeURIComponent(url.password)).toBe(password)
      expect(url.searchParams.get('sslmode')).toBe('require')
      expect(masks).toContain(`::add-mask::${values[name]}`)
    }
    expect(masks).toHaveLength(3)
  })

  test('fails closed when required connection inputs are absent', () => {
    for (const name of [
      'DATABASE_HOST',
      'DATABASE_HOST_POOLED',
      'DATABASE_APP_PASSWORD',
      'DATABASE_MIGRATION_PASSWORD',
      'GITHUB_ENV',
    ]) {
      expect(() => execute({ [name]: undefined })).toThrow(
        'Neon compatibility connection inputs are unavailable'
      )
    }
  })

  test.each([
    ['existing', true],
    ['newly created', false],
  ])(
    'the migration role probes the %s app schema and removes only probe-owned objects',
    async (_label, schemaExists) => {
      const statements = []
      let transactions = 0
      const sql = {
        begin: async (operation) => {
          transactions += 1
          return operation({
            unsafe: async (query, values) => {
              statements.push({ query, values })
              if (query === "SELECT to_regnamespace('app') IS NOT NULL AS schema_exists")
                return [{ schema_exists: schemaExists }]
              return query.startsWith('SELECT') ? [{ marker: 'ok' }] : []
            },
          })
        },
      }

      await verifyNeonMigratorDdl(sql)

      expect(transactions).toBe(1)
      expect(statements).toHaveLength(schemaExists ? 5 : 7)
      const tableIndex = schemaExists ? 1 : 2
      const table = statements[tableIndex].query.match(/app\.(cp_neon_probe_[a-f0-9]{16})/)?.[1]
      expect(table).toBeDefined()
      expect(statements.map(({ query }) => query)).toEqual([
        "SELECT to_regnamespace('app') IS NOT NULL AS schema_exists",
        ...(!schemaExists ? ['CREATE SCHEMA app'] : []),
        `CREATE TABLE app.${table} (id integer PRIMARY KEY, marker text NOT NULL)`,
        `INSERT INTO app.${table} (id, marker) VALUES ($1, $2)`,
        `SELECT marker FROM app.${table} WHERE id = $1`,
        `DROP TABLE app.${table}`,
        ...(!schemaExists ? ['DROP SCHEMA app'] : []),
      ])
      const tableStatements = statements.slice(tableIndex, tableIndex + 4)
      expect(tableStatements.every(({ query }) => query.includes(`app.${table}`))).toBe(true)
      expect(tableStatements[1].values).toEqual([1, 'ok'])
      expect(tableStatements[2].values).toEqual([1])
    }
  )
})

describe('Neon trusted-main migration gating', () => {
  test('the compatibility proof job skips only an explicit successful classifier skip', () => {
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
    for (const event of ['push', 'repository_dispatch']) {
      for (const { result, verify, cancelled, expected } of scenarios) {
        expect(
          runInNewContext(condition, {
            github: { event_name: event },
            cancelled: () => cancelled,
            needs: { changes: { result, outputs: { verify } } },
          })
        ).toBe(event === 'push' && expected)
      }
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

  test('a version-only push skips on its own parent diff even with a stale anchor', () => {
    const result = runMigrationGate({
      // The anchor race fixture: the verified baseline predates the feature
      // commit, and the head commit only bumps release metadata on top of it.
      baseFiles: {
        'package.json': '{"name":"pkg","version":"1.0.0"}\n',
        '.release-please-manifest.json': '{"pkg":"1.0.0"}\n',
        'packages/database/CHANGELOG.md': 'changelog\n',
      },
      intermediateCommits: [
        {
          changedPaths: ['apps/api/migrations/0002-feature.sql'],
          message: 'feat: add migration',
        },
      ],
      changedPaths: ['.release-please-manifest.json', 'CHANGELOG.md', 'package.json'],
      changedFiles: {
        'package.json': '{"name":"pkg","version":"1.0.1"}\n',
        '.release-please-manifest.json': '{"pkg":"1.0.1"}\n',
      },
      response: ({ baseline }) => ({ workflow_runs: [successfulRun(baseline)] }),
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=false\n')
    expect(result.stdout).toContain(
      'pushed commit changes release metadata without changing Neon-proof-relevant content'
    )
    // Query exact-parent verification without consulting the stale listing.
    expect(result.ghCall).toContain('head_sha=')
    expect(result.ghCall).toContain('/actions/runs/43/jobs?filter=latest&per_page=100')
    expect(result.ghCall).not.toContain('status=success&per_page=25')
  }, 30_000)

  test('a multi-commit push ending in release metadata still verifies its migration', () => {
    const result = runMigrationGate({
      pushBefore: 'baseline',
      baseFiles: { 'package.json': '{"name":"pkg","version":"1.0.0"}\n' },
      intermediateCommits: [{ changedPaths: ['packages/database/migrations/0002-feature.sql'] }],
      changedPaths: ['package.json'],
      changedFiles: { 'package.json': '{"name":"pkg","version":"1.0.1"}\n' },
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=true\n')
    expect(result.ghCall).toContain('neon_workflow.yml/runs')
  }, 30_000)

  test('release metadata with an unavailable push start falls back to verification', () => {
    for (const pushBefore of ['', 'invalid', '0'.repeat(40)]) {
      const result = runMigrationGate({
        pushBefore,
        baseFiles: { 'package.json': '{"name":"pkg","version":"1.0.0"}\n' },
        changedPaths: ['package.json'],
        changedFiles: { 'package.json': '{"name":"pkg","version":"1.0.1"}\n' },
        failQuery: true,
      })
      expect(result.status).toBe(0)
      expect(result.output).toBe('verify=true\n')
      expect(result.ghCall).toContain('neon_workflow.yml/runs')
    }
  }, 30_000)

  test('release metadata never hides failed or missing parent verification', () => {
    const credentialSkippedJobs = verifiedJobs()
    credentialSkippedJobs.jobs[0].steps.find(
      (step) => step.name === neonCompatibilityStep
    ).conclusion = 'skipped'
    for (const options of [
      { parentResponse: { workflow_runs: [] } },
      { parentResponse: ({ baseline }) => ({ workflow_runs: [successfulRun(baseline)] }) },
      {
        parentResponse: ({ parent }) => ({
          workflow_runs: [successfulRun(parent, { conclusion: 'failure' })],
        }),
      },
      { jobsResponses: { 42: verifiedJobs(), 43: credentialSkippedJobs } },
    ]) {
      const result = runMigrationGate({
        baseFiles: { 'package.json': '{"name":"pkg","version":"1.0.0"}\n' },
        intermediateCommits: [
          { changedPaths: ['packages/database/migrations/0002-unverified.sql'] },
        ],
        changedPaths: ['package.json'],
        changedFiles: { 'package.json': '{"name":"pkg","version":"1.0.1"}\n' },
        ...options,
      })
      expect(result.status).toBe(0)
      expect(result.output).toBe('verify=true\n')
      expect(result.ghCall).toContain('neon_workflow.yml/runs')
    }
  }, 30_000)

  test('release metadata with unrelated docs skips with an accurate notice', () => {
    const result = runMigrationGate({
      baseFiles: { 'package.json': '{"name":"pkg","version":"1.0.0"}\n' },
      changedPaths: ['package.json', 'docs/notes.md'],
      changedFiles: { 'package.json': '{"name":"pkg","version":"1.0.1"}\n' },
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=false\n')
    expect(result.stdout).toContain('without changing Neon-proof-relevant content')
    expect(result.ghCall).toContain('head_sha=')
  }, 30_000)

  test('a version-only push that also carries a migration still verifies', () => {
    const result = runMigrationGate({
      baseFiles: {
        'package.json': '{"name":"pkg","version":"1.0.0"}\n',
        '.release-please-manifest.json': '{"pkg":"1.0.0"}\n',
      },
      changedPaths: ['packages/database/migrations/0003-mixed.sql', 'package.json', 'CHANGELOG.md'],
      changedFiles: {
        'package.json': '{"name":"pkg","version":"1.0.1"}\n',
      },
      response: ({ baseline }) => ({ workflow_runs: [successfulRun(baseline)] }),
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=true\n')
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

  test('requires one complete successful provider proof and cleanup', () => {
    const skippedJobs = { jobs: [] }
    const unavailableProof = verifiedJobs()
    unavailableProof.jobs[0].steps.find((step) => step.name === neonCompatibilityStep).conclusion =
      'skipped'
    const failedProof = verifiedJobs()
    failedProof.jobs[0].steps.find((step) => step.name === neonCompatibilityStep).conclusion =
      'failure'
    const missingCleanup = verifiedJobs()
    missingCleanup.jobs[0].steps = missingCleanup.jobs[0].steps.filter(
      (step) => step.name !== absenceStep
    )
    const failedBudget = verifiedJobs()
    failedBudget.jobs[0].steps.find((step) => step.name === budgetStep).conclusion = 'failure'
    const duplicateJob = verifiedJobs()
    duplicateJob.jobs.push({ ...duplicateJob.jobs[0] })
    const failedLegacyRun = legacyVerifiedJobs()
    failedLegacyRun.jobs[2].steps.find((step) => step.name === migrationVerifyStep).conclusion =
      'failure'

    for (const jobs of [
      skippedJobs,
      unavailableProof,
      failedProof,
      missingCleanup,
      failedBudget,
      duplicateJob,
      failedLegacyRun,
    ]) {
      const result = runMigrationGate({ jobsResponses: { 42: jobs } })
      expect(result.status).toBe(0)
      expect(result.output).toBe('verify=true\n')
    }
  }, 60_000)

  test('accepts historical complete three-shard runs as stronger baselines', () => {
    const result = runMigrationGate({ jobsResponses: { 42: legacyVerifiedJobs() } })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=false\n')
  }, 30_000)

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
      'scripts/run-hosted-graph-qualification.sh',
      'scripts/provision-restate-identity.mjs',
      'scripts/remove-hosted-compose-fixture.mjs',
      'infrastructure/compose/compose.yaml',
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
      'vite.config.ts',
      'scripts/orch-graph.mjs',
      'scripts/orch-toolchain.mjs',
      'scripts/workspace-boundaries.mjs',
      'tsconfig.json',
    ]) {
      expect(isNeonProofRelevantPath(changedPath)).toBe(true)
    }
    expect(isNeonProofRelevantPath('docs/notes.md')).toBe(false)
    expect(isNeonProofRelevantPath('scripts/run-postgres-restore-drill.mjs')).toBe(false)
  })

  test('a Release Please commit with proof-relevant changes still runs verification', () => {
    const result = runMigrationGate({
      changedPaths: ['packages/database/src/schema.ts'],
      headMessage: 'chore(main): release 1.71.2',
    })
    expect(result.status).toBe(0)
    expect(result.output).toBe('verify=true\n')
  }, 30_000)

  test('skips a proven single-commit Release Please push with a verified parent', () => {
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
    expect(workflow).toContain('GITHUB_EVENT_BEFORE: ${{ github.event.before }}')
    expect(migrationGateSource).toContain('merge-base')
    expect(migrationGateSource).toContain('.workflow_runs')
  })
})
