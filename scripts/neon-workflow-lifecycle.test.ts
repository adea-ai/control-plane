import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const workflowText = readFileSync(resolve(root, '.github/workflows/neon_workflow.yml'), 'utf8')

type Step = {
  name?: string
  id?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
  uses?: string
  run?: string
}
type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  'timeout-minutes'?: number
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> }
  steps: Step[]
}
const workflow = Bun.YAML.parse(workflowText) as {
  on: { pull_request: { types: string[] } }
  permissions?: unknown
  concurrency: { 'cancel-in-progress': string }
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
const stepNamed = (job: Job, name: string) => {
  const step = job.steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`missing step: ${name}`)
  return step
}

describe('Neon branch lifecycle workflow', () => {
  test('keeps the required check name on one fail-closed gate over setup and both legs', () => {
    const named = Object.entries(jobs).filter(([, job]) => job.name === 'Migrate Neon Branch')
    expect(named.map(([id]) => id)).toEqual(['migrate_gate'])
    expect(Object.values(jobs).some((job) => job.name?.startsWith('Migrate Neon Branch ('))).toBe(
      false
    )

    const gate = jobs.migrate_gate!
    expect([...(gate.needs as string[])].toSorted()).toEqual(['create_neon_branch', 'setup'])
    expect(gate.if).toContain('always()')
    expect(gate.if).toContain('github.event.pull_request.draft == false')
    expect(gate.if).toContain("github.event.action == 'ready_for_review'")
    const check = stepNamed(gate, 'Require setup and both shards to succeed').run ?? ''
    expect(check).toContain('test "$SETUP_RESULT" = success')
    expect(check).toContain('test "$SHARDS_RESULT" = success')
  })

  test('runs two static legs under the unchanged 35-minute cap', () => {
    const shards = jobs.create_neon_branch!
    expect(shards.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
    expect(shards['timeout-minutes']).toBe(35)
    expect(shards.name).toBe('Migrate Neon Shard (${{ matrix.shard }}/2)')
    expect(jobs.migrate_gate!['timeout-minutes']).toBe(5)
  })

  test('gives each leg its own preview branch and its own shard of the inventory', () => {
    const create = stepNamed(jobs.create_neon_branch!, 'Create Neon branch')
    expect(create.with?.branch_name).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}-s${{ matrix.shard }}'
    )
    const verify = stepNamed(jobs.create_neon_branch!, 'Verify migrations and transactions')
    expect(verify.env?.ADEA_INTEGRATION_SHARD).toBe('${{ matrix.shard }}/2')
    expect(verify.run).toContain('bun run test:integration')
  })

  test('keeps the restricted application and migration roles and the secret set unchanged', () => {
    expect(workflowText).toContain('"adea_dev_app"')
    expect(workflowText).toContain('"adea_dev_migration"')
    const secrets = [...workflowText.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1])
    expect([...new Set(secrets)].toSorted()).toEqual([
      'NEON_API_KEY',
      'NEON_CI_APP_PASSWORD',
      'NEON_CI_MIGRATION_PASSWORD',
    ])
    expect(workflow.permissions).toEqual({})
  })

  test('pins the create and delete actions to the reviewed commits', () => {
    expect(workflowText).toContain(
      'neondatabase/create-branch-action@72ed4f69a12b6be9c16aebfad893f6a21e9aba8b # v6.4.0'
    )
    expect(workflowText).toContain(
      'neondatabase/delete-branch-action@4468d825d5a88ef4012f1705a82f02ec3072f776 # v3.2.1'
    )
  })

  test('cleans up both shard branches and the legacy branch, skipping names that do not exist', () => {
    const cleanup = jobs.delete_neon_branch!
    expect(cleanup['timeout-minutes']).toBe(10)
    const lookup = stepNamed(cleanup, "Resolve this pull request's Neon branches")
    expect(lookup.env?.LEGACY_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}'
    )
    expect(lookup.env?.SHARD_1_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}-s1'
    )
    expect(lookup.env?.SHARD_2_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}-s2'
    )
    expect(lookup.run).toContain('`legacy=${idFor(LEGACY_BRANCH)}')
    expect(lookup.run).toContain('shard_1=${idFor(SHARD_1_BRANCH)}')
    expect(lookup.run).toContain('shard_2=${idFor(SHARD_2_BRANCH)}')

    const deletes = cleanup.steps.filter((step) =>
      step.uses?.startsWith('neondatabase/delete-branch')
    )
    expect(deletes.map((step) => step.with?.branch_id)).toEqual([
      '${{ steps.resolve.outputs.legacy }}',
      '${{ steps.resolve.outputs.shard_1 }}',
      '${{ steps.resolve.outputs.shard_2 }}',
    ])
    for (const step of deletes) {
      expect(step.with?.branch).toBeUndefined()
      expect(step.if).toContain("!cancelled() && github.event.action == 'closed'")
      expect(step.if).toContain("!= ''")
    }
  })
})

type Event = { action: string; draft: boolean }

// Evaluates the expression subset these conditions use. GitHub's single-quoted strings and
// operators are valid JavaScript once the context names are bound to the event.
function evaluate(source: string, event: Event) {
  const script = source
    .replaceAll('always()', 'true')
    .replaceAll('github.event.pull_request.draft', 'draft')
    .replaceAll('github.event.action', 'action')
  return Boolean(new Function('action', 'draft', `return (${script})`)(event.action, event.draft))
}

// Mirrors the runner for job-level conditions: a job starts when its condition holds and every
// job it needs succeeded. Only always() lets a skipped dependency leave a job running.
const jobOrder = ['setup', 'create_neon_branch', 'migrate_gate', 'delete_neon_branch']
function jobsThatRun(event: Event) {
  const ran = new Map<string, boolean>()
  for (const id of jobOrder) {
    const job = jobs[id]!
    const dependenciesRan = [job.needs ?? []].flat().every((need) => ran.get(need) === true)
    const condition = job.if === undefined || evaluate(job.if, event)
    const bypassesDependencies = job.if?.includes('always()') === true
    ran.set(id, condition && (dependenciesRan || bypassesDependencies))
  }
  return Object.fromEntries(jobOrder.map((id) => [id, ran.get(id)]))
}

// A pull_request event starts the workflow only when its action is listed under `types`; then the
// job conditions decide which jobs run.
function lifecycle(event: Event) {
  const started = workflow.on.pull_request.types.includes(event.action)
  const idle = Object.fromEntries(jobOrder.map((id) => [id, false]))
  return { started, jobs: started ? jobsThatRun(event) : idle }
}

describe('Neon branch lifecycle triggers', () => {
  test('starts only on the actions that may run heavy validation', () => {
    expect([...workflow.on.pull_request.types].toSorted()).toEqual([
      'closed',
      'ready_for_review',
      'synchronize',
    ])
  })

  test('opened and reopened never start the workflow, so Draft Guard can convert them first', () => {
    for (const action of ['opened', 'reopened']) {
      for (const draft of [true, false]) {
        expect(lifecycle({ action, draft }).started).toBe(false)
      }
    }
  })

  test('a ready pull request runs both shards and the gate on ready_for_review and each push', () => {
    for (const action of ['ready_for_review', 'synchronize']) {
      expect(lifecycle({ action, draft: false })).toEqual({
        started: true,
        jobs: {
          setup: true,
          create_neon_branch: true,
          migrate_gate: true,
          delete_neon_branch: true,
        },
      })
    }
  })

  test('draft pushes start the workflow but run no job, so no migration runs', () => {
    expect(lifecycle({ action: 'synchronize', draft: true })).toEqual({
      started: true,
      jobs: {
        setup: false,
        create_neon_branch: false,
        migrate_gate: false,
        delete_neon_branch: false,
      },
    })
  })

  test('closed pull requests only clean up, whether or not they were drafts', () => {
    for (const draft of [true, false]) {
      expect(lifecycle({ action: 'closed', draft })).toEqual({
        started: true,
        jobs: {
          setup: true,
          create_neon_branch: false,
          migrate_gate: false,
          delete_neon_branch: true,
        },
      })
    }
  })

  test('only closed events bypass cancel-in-progress', () => {
    const cancel = workflow.concurrency['cancel-in-progress'].replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    expect(evaluate(cancel, { action: 'closed', draft: false })).toBe(false)
    for (const action of ['ready_for_review', 'synchronize']) {
      expect(evaluate(cancel, { action, draft: false })).toBe(true)
    }
  })
})
