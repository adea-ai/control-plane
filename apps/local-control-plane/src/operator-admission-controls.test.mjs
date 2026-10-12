import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
  assertSqliteWorkflowExecutionReference,
} from '@control-plane/sqlite-persistence'
import {
  EmbeddedExecutionWorkflowDispatcher,
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
import {
  admissionOutcomeNamespace,
  WORKFLOW_ADMISSION_STOPS_NAMESPACE,
  WORKFLOW_EXECUTIONS_NAMESPACE,
  admissionControlledBeforeEnqueue,
  applyAdmissionControlInTransaction,
  assertWorkflowJobAdmissionOpen,
  clearWorkflowAdmissionStop,
  getWorkflowAdmissionStop,
  listWorkflowAdmissionOutcomes,
  setWorkflowAdmissionStop,
} from './operator-admission-controls.ts'

// Deterministic clock: commands are issued at strictly increasing instants so
// the outcome trail has a deterministic order.
const AT = '2026-10-09T12:00:00.000Z'
const LATER = '2026-10-09T12:05:00.000Z'
const PLAN_WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const OTHER_WORKSPACE = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const PROJECT = 'prj_01JABCDEF0123456789ABCDEFG'
const EXE1 = 'exe_01JABCDEF0123456789ABCDEFG'
const EXE2 = 'exe_01HABCDEF0123456789ABCDEFG'
const CMD1 = 'cmd_01JABCDEF0123456789ABCDEFG'
const CMD2 = 'cmd_01HABCDEF0123456789ABCDEFG'
const CMD3 = 'cmd_01GABCDEF0123456789ABCDEFG'
const INTERACTION = 'int_01JABCDEF0123456789ABCDEFG'
const CANARY = 'admission-canary-secret-9411'

const recordId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`

const actor = (overrides = {}) => ({
  kind: 'agent_hq_service',
  principalId: 'svc_admission-controls-test',
  projectIds: [PROJECT],
  scopes: ['operations:admission'],
  workspaceIds: [PLAN_WORKSPACE],
  ...overrides,
})

const stopCommand = (overrides = {}) => ({
  actor: actor(),
  scope: { kind: 'workspace', workspaceId: PLAN_WORKSPACE },
  commandId: CMD1,
  reasonClass: 'incident_response',
  at: AT,
  ...overrides,
})

const resumeCommand = (overrides = {}) => stopCommand({ commandId: CMD2, ...overrides })

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'operator-admission-controls-'))
  const path = join(directory, 'control-plane.sqlite')
  let provider = await open()
  async function open() {
    const next = new SqlitePersistenceProvider({ path })
    await next.migrate()
    return next
  }
  const handle = {
    get provider() {
      return provider
    },
    reopen: async () => {
      provider.close({ checkpoint: true })
      provider = await open()
    },
  }
  try {
    await run(handle)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

/** Minimal stored execution: the gate reads only `correlation.workspaceId`. */
async function seedExecution(persistence, executionId, workspaceId, extra = {}) {
  await persistence.transaction(async (transaction) => {
    await transaction.put({
      namespace: WORKFLOW_EXECUTIONS_NAMESPACE,
      id: recordId(executionId),
      value: {
        executionId,
        state: 'accepted',
        version: 1,
        correlation: { workspaceId, projectId: PROJECT },
        executionPlan: {
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          schemaVersion: 1,
        },
        attemptCount: 0,
        acceptedAt: AT,
        createdAt: AT,
        updatedAt: AT,
        ...extra,
      },
    })
  })
}

/**
 * Full admission stack over the real store: the new-reference guard plus the
 * admission gate, composed exactly as the composition seam wires them.
 */
function controlledJobStore(persistence) {
  return new WorkflowJobStore(persistence, {
    beforeEnqueue: admissionControlledBeforeEnqueue(assertSqliteWorkflowExecutionReference),
  })
}

/**
 * Accepts real executions for the plan fixture so lifecycle submissions carry
 * a valid reference. The context package and plan are stored once and shared.
 */
async function seedLifecycleWorld(persistence, executionIds) {
  const package_ = contextPackageSerializationFixtures.futurePi
  const plan = createExecutionPlanTestFixture({ contextPackage: package_ })
  await new SqliteContextPackageRepository(persistence).put(package_)
  const reference = {
    ...(await new SqliteExecutionPlanRepository(persistence).put(plan)),
    schemaVersion: plan.schemaVersion,
  }
  for (const executionId of executionIds) {
    await new ExecutionLifecycleService(new SqliteExecutionRepository(persistence)).createExecution(
      {
        executionId,
        correlation: plan.correlation,
        executionPlan: reference,
        acceptedAt: AT,
      }
    )
  }
  const inputFor = (executionId) => ({
    executionId,
    workflowId: `wfl_${executionId.slice(4)}`,
    executionPlan: reference,
    deadlineAt: '2026-10-09T13:00:00.000Z',
  })
  return { reference, inputFor }
}

test('authorized stop and resume apply through the real store with audited applied outcomes', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    const stop = await setWorkflowAdmissionStop(control.provider, stopCommand())
    expect(stop.status).toBe('ok')
    expect(stop.outcome).toBe('applied')
    expect(stop.state).toMatchObject({
      status: 'stopped',
      scope: { kind: 'workspace', workspaceId: PLAN_WORKSPACE },
      commandId: CMD1,
      actorPrincipalId: 'svc_admission-controls-test',
      reasonClass: 'incident_response',
    })
    expect(stop.audit).toMatchObject({ action: 'stop', result: 'applied', stateAfter: 'stopped' })
    const resume = await clearWorkflowAdmissionStop(control.provider, resumeCommand({ at: LATER }))
    expect(resume.status).toBe('ok')
    expect(resume.outcome).toBe('applied')
    expect(resume.state).toEqual({
      status: 'open',
      scope: { kind: 'workspace', workspaceId: PLAN_WORKSPACE },
    })
    const outcomes = await listWorkflowAdmissionOutcomes(control.provider, stopCommand().scope, 100)
    expect(outcomes.map((outcome) => [outcome.action, outcome.result])).toEqual([
      ['stop', 'applied'],
      ['resume', 'applied'],
    ])
  })
})

test('gate blocks new workflow-job admission while stopped and passes it after resume', async () => {
  await withProvider(async (control) => {
    const world = await seedLifecycleWorld(control.provider, [EXE1, EXE2])
    const dispatcher = new EmbeddedExecutionWorkflowDispatcher({
      store: controlledJobStore(control.provider),
    })
    await dispatcher.submit(world.inputFor(EXE1))
    expect(
      await control.provider.transaction((transaction) => transaction.list('workflow-jobs'))
    ).toHaveLength(1)

    const stop = await setWorkflowAdmissionStop(control.provider, stopCommand())
    expect(stop.outcome).toBe('applied')
    await expect(dispatcher.submit(world.inputFor(EXE2))).rejects.toThrow(
      'WORKFLOW_ADMISSION_STOPPED'
    )
    const jobs = await control.provider.transaction((transaction) =>
      transaction.list('workflow-jobs')
    )
    expect(jobs).toHaveLength(1)
    expect(JSON.stringify(jobs[0].value)).not.toContain(EXE2)

    const resume = await clearWorkflowAdmissionStop(control.provider, resumeCommand())
    expect(resume.outcome).toBe('applied')
    await dispatcher.submit(world.inputFor(EXE2))
    const admitted = await control.provider.transaction((transaction) =>
      transaction.list('workflow-jobs')
    )
    expect(admitted).toHaveLength(2)
  })
})

test('a stop never masks an invalid execution reference; the reference guard runs first', async () => {
  await withProvider(async (control) => {
    await seedLifecycleWorld(control.provider, [EXE1])
    const store = controlledJobStore(control.provider)
    await setWorkflowAdmissionStop(control.provider, stopCommand())
    // Well-formed reference for an execution that was never stored: the guard
    // rejects it before the gate is consulted.
    await expect(
      store.enqueue({
        workflowKey: EXE2,
        input: {
          executionId: EXE2,
          workflowId: `wfl_${EXE2.slice(4)}`,
          executionPlan: {
            executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
            contentDigest: `sha256:${'a'.repeat(64)}`,
            schemaVersion: 1,
          },
          deadlineAt: '2026-10-09T13:00:00.000Z',
        },
        at: AT,
      })
    ).rejects.toThrow('WORKFLOW_EXECUTION_REFERENCE_INVALID')
    expect(
      await control.provider.transaction((transaction) => transaction.list('workflow-jobs'))
    ).toHaveLength(0)
  })
})

test('mutations without a valid current actor fail closed with no state change and no record', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    // Valid principal, but it does not hold the target workspace.
    await expect(
      setWorkflowAdmissionStop(
        control.provider,
        stopCommand({ actor: actor({ workspaceIds: [OTHER_WORKSPACE] }) })
      )
    ).rejects.toThrow('ADMISSION_CONTROL_SCOPE_FORBIDDEN')
    // Structurally invalid actor document.
    await expect(
      setWorkflowAdmissionStop(control.provider, stopCommand({ actor: { kind: 'usurper' } }))
    ).rejects.toThrow('ADMISSION_CONTROL_COMMAND_INVALID')
    // Transaction-scoped core with an unparseable actor fails closed too.
    await control.provider.transaction(async (transaction) => {
      await expect(
        applyAdmissionControlInTransaction(transaction, 'stop', {
          ...stopCommand(),
          actor: { kind: 'agent_hq_service', principalId: 'nope' },
        })
      ).rejects.toThrow('ADMISSION_CONTROL_ACTOR_INVALID')
    })
    expect(await getWorkflowAdmissionStop(control.provider, stopCommand().scope)).toEqual({
      status: 'open',
      scope: { kind: 'workspace', workspaceId: PLAN_WORKSPACE },
    })
    expect(
      await control.provider.transaction((transaction) =>
        transaction.list(admissionOutcomeNamespace(PLAN_WORKSPACE))
      )
    ).toEqual([])
    // The gate still passes: nothing was stopped by the denied attempts.
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE1,
          input: { executionId: EXE1 },
        })
      ).resolves.toBeUndefined()
    })
  })
})

test('a revoked principal can neither set nor clear a stop from that moment on', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    await setWorkflowAdmissionStop(control.provider, stopCommand())
    // Membership revoked: the resume attempt is denied and the stop stands.
    await expect(
      clearWorkflowAdmissionStop(
        control.provider,
        resumeCommand({ actor: actor({ workspaceIds: [OTHER_WORKSPACE] }) })
      )
    ).rejects.toThrow('ADMISSION_CONTROL_SCOPE_FORBIDDEN')
    expect(await getWorkflowAdmissionStop(control.provider, stopCommand().scope)).toMatchObject({
      status: 'stopped',
    })
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE1,
          input: { executionId: EXE1 },
        })
      ).rejects.toThrow('WORKFLOW_ADMISSION_STOPPED')
    })
  })
})

test('repeated stop and clear are idempotent successes recorded as duplicates', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    const first = await setWorkflowAdmissionStop(control.provider, stopCommand())
    expect(first.outcome).toBe('applied')
    const second = await setWorkflowAdmissionStop(
      control.provider,
      stopCommand({ commandId: CMD2, at: LATER })
    )
    expect(second.outcome).toBe('duplicate')
    expect(second.state).toMatchObject({ status: 'stopped', commandId: CMD1 })
    expect(second.audit).toMatchObject({ action: 'stop', result: 'duplicate', at: LATER })
    // Clearing an already-clear workspace is an idempotent success too, but
    // the caller still has to hold that workspace's authority (cross-workspace
    // denial is proven in its own test).
    const clearWhenOpen = await clearWorkflowAdmissionStop(
      control.provider,
      resumeCommand({
        actor: actor({ workspaceIds: [PLAN_WORKSPACE, OTHER_WORKSPACE] }),
        scope: { kind: 'workspace', workspaceId: OTHER_WORKSPACE },
      })
    )
    expect(clearWhenOpen.outcome).toBe('duplicate')
    expect(clearWhenOpen.state).toMatchObject({ status: 'open' })
    const clear = await clearWorkflowAdmissionStop(control.provider, resumeCommand({ at: LATER }))
    expect(clear.outcome).toBe('applied')
    const clearAgain = await clearWorkflowAdmissionStop(
      control.provider,
      resumeCommand({ commandId: CMD1, at: LATER })
    )
    expect(clearAgain.outcome).toBe('duplicate')
    const outcomes = await listWorkflowAdmissionOutcomes(control.provider, stopCommand().scope, 100)
    expect(outcomes.map((outcome) => [outcome.action, outcome.result])).toEqual([
      ['stop', 'applied'],
      ['stop', 'duplicate'],
      ['resume', 'applied'],
      ['resume', 'duplicate'],
    ])
    expect(await getWorkflowAdmissionStop(control.provider, stopCommand().scope)).toMatchObject({
      status: 'open',
    })
  })
})

test('replayed commands return the original receipt; conflicting reuse of a command id is rejected', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    const original = await setWorkflowAdmissionStop(
      control.provider,
      stopCommand({ reason: 'operator on-call hold' })
    )
    const replay = await setWorkflowAdmissionStop(
      control.provider,
      stopCommand({ at: LATER, reason: 'operator on-call hold' })
    )
    expect(replay.outcome).toBe('replayed')
    expect(replay.audit).toEqual(original.audit)
    expect(replay.audit.at).toBe(AT)
    expect(
      await control.provider.transaction((transaction) =>
        transaction.list(admissionOutcomeNamespace(PLAN_WORKSPACE))
      )
    ).toHaveLength(1)
    // Same command id with different intent is a conflict, never a silent rewrite.
    await expect(
      setWorkflowAdmissionStop(
        control.provider,
        stopCommand({ reasonClass: 'cost_protection', at: LATER })
      )
    ).rejects.toThrow('ADMISSION_CONTROL_COMMAND_CONFLICT')
    // The same holds for resume: apply once, then a divergent replay conflicts.
    const appliedResume = await clearWorkflowAdmissionStop(control.provider, resumeCommand())
    expect(appliedResume.outcome).toBe('applied')
    await expect(
      clearWorkflowAdmissionStop(
        control.provider,
        resumeCommand({ commandId: CMD2, reasonClass: 'cost_protection', at: LATER })
      )
    ).rejects.toThrow('ADMISSION_CONTROL_COMMAND_CONFLICT')
    expect(
      await control.provider.transaction((transaction) =>
        transaction.list(admissionOutcomeNamespace(PLAN_WORKSPACE))
      )
    ).toHaveLength(2)
  })
})

test('an interrupted mutation rolls back the stop and its outcome together', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    await expect(
      control.provider.transaction(async (transaction) => {
        await applyAdmissionControlInTransaction(transaction, 'stop', stopCommand())
        // Simulated crash after the in-transaction writes, before commit.
        throw new Error('SIMULATED_ADMISSION_CRASH')
      })
    ).rejects.toThrow('SIMULATED_ADMISSION_CRASH')
    expect(await getWorkflowAdmissionStop(control.provider, stopCommand().scope)).toMatchObject({
      status: 'open',
    })
    expect(
      await control.provider.transaction((transaction) =>
        transaction.list(admissionOutcomeNamespace(PLAN_WORKSPACE))
      )
    ).toEqual([])
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE1,
          input: { executionId: EXE1 },
        })
      ).resolves.toBeUndefined()
    })
    // The store is clean: a fresh stop after the interrupted attempt applies normally.
    const retry = await setWorkflowAdmissionStop(control.provider, stopCommand({ at: LATER }))
    expect(retry.outcome).toBe('applied')
  })
})

test('a stop survives a restart and keeps blocking admission', async () => {
  await withProvider(async (control) => {
    const world = await seedLifecycleWorld(control.provider, [EXE1, EXE2])
    const dispatcher = new EmbeddedExecutionWorkflowDispatcher({
      store: controlledJobStore(control.provider),
    })
    await dispatcher.submit(world.inputFor(EXE1))
    await setWorkflowAdmissionStop(control.provider, stopCommand())
    await control.reopen()
    expect(await getWorkflowAdmissionStop(control.provider, stopCommand().scope)).toMatchObject({
      status: 'stopped',
      commandId: CMD1,
    })
    // A restart rebuilds the composition: the pre-restart dispatcher still
    // holds the closed provider (SQLITE_CLOSED), so the submission path binds
    // to the reopened store exactly as a fresh boot would — and the committed
    // stop still blocks it.
    const restarted = new EmbeddedExecutionWorkflowDispatcher({
      store: controlledJobStore(control.provider),
    })
    await expect(restarted.submit(world.inputFor(EXE2))).rejects.toThrow(
      'WORKFLOW_ADMISSION_STOPPED'
    )
    const outcomes = await listWorkflowAdmissionOutcomes(control.provider, stopCommand().scope, 100)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ action: 'stop', result: 'applied', commandId: CMD1 })
  })
})

test('an unsupported global scope returns the typed unavailable state with no side effects', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    const global = { kind: 'global' }
    const stopped = await setWorkflowAdmissionStop(control.provider, stopCommand({ scope: global }))
    expect(stopped).toEqual({
      status: 'unavailable',
      reason: 'ADMISSION_STOP_SCOPE_GLOBAL_UNSUPPORTED',
    })
    const resumed = await clearWorkflowAdmissionStop(
      control.provider,
      resumeCommand({ scope: global })
    )
    expect(resumed).toEqual({
      status: 'unavailable',
      reason: 'ADMISSION_STOP_SCOPE_GLOBAL_UNSUPPORTED',
    })
    expect(
      await control.provider.transaction((transaction) =>
        transaction.list(WORKFLOW_ADMISSION_STOPS_NAMESPACE)
      )
    ).toEqual([])
    expect(
      await control.provider.transaction((transaction) =>
        transaction.list(admissionOutcomeNamespace(PLAN_WORKSPACE))
      )
    ).toEqual([])
    // Workspace scoping keeps working beside the unavailable global scope.
    await seedExecution(control.provider, EXE2, OTHER_WORKSPACE)
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE2,
          input: { executionId: EXE2 },
        })
      ).resolves.toBeUndefined()
    })
  })
})

test('outcome records carry no workspace or job secrets', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE, {
      failure: { message: CANARY, failedAt: AT },
      inputEcho: { prompt: CANARY },
    })
    await setWorkflowAdmissionStop(
      control.provider,
      stopCommand({ reason: 'operator on-call hold' })
    )
    await clearWorkflowAdmissionStop(control.provider, resumeCommand())
    const state = await getWorkflowAdmissionStop(control.provider, stopCommand().scope)
    const outcomes = await listWorkflowAdmissionOutcomes(control.provider, stopCommand().scope, 100)
    const serialized = JSON.stringify({ state, outcomes })
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain('prompt')
    // A pasted multiline credential cannot enter the audit trail: control
    // characters are rejected before any write.
    await expect(
      setWorkflowAdmissionStop(
        control.provider,
        stopCommand({ commandId: CMD2, reason: `token ${CANARY}\nsecond line` })
      )
    ).rejects.toThrow('ADMISSION_CONTROL_COMMAND_INVALID')
    // The stored executions row keeps the canary; the control namespaces do not.
    const stopRows = await control.provider.transaction((transaction) =>
      transaction.list(WORKFLOW_ADMISSION_STOPS_NAMESPACE)
    )
    expect(stopRows).toEqual([])
    expect(JSON.stringify(outcomes)).not.toContain(CANARY)
  })
})

test('gate is a pure pass-through when no stop exists and blocks only the stopped workspace', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    await seedExecution(control.provider, EXE2, OTHER_WORKSPACE)
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE1,
          input: { executionId: EXE1 },
        })
      ).resolves.toBeUndefined()
    })
    await setWorkflowAdmissionStop(control.provider, stopCommand())
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE1,
          input: { executionId: EXE1 },
        })
      ).rejects.toThrow('WORKFLOW_ADMISSION_STOPPED')
      // A different workspace is unaffected by the stop.
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE2,
          input: { executionId: EXE2 },
        })
      ).resolves.toBeUndefined()
      // An unresolvable job input passes the gate; the reference guard rejects it.
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, { workflowKey: 'unknown', input: {} })
      ).resolves.toBeUndefined()
      // A corrupt stop record fails closed instead of silently opening admission.
      await transaction.put({
        namespace: WORKFLOW_ADMISSION_STOPS_NAMESPACE,
        id: recordId(`stop:workspace:${OTHER_WORKSPACE}`),
        value: { kind: 'admission-stop', broken: true },
      })
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE2,
          input: { executionId: EXE2 },
        })
      ).rejects.toThrow('ADMISSION_CONTROL_STATE_CORRUPT')
    })
  })
})

async function runCli(args, timeoutMs = 10000) {
  const ledger = process.env['CONTROL_PLANE_LOCAL_RESOURCE_LEDGER']
  if (ledger)
    await appendFile(
      ledger,
      `operator-admission-controls test child planned; owner=root/admission-controls-tests; no ports\n`
    )
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../dist/operator-admission-controls-cli.js', import.meta.url)),
      ...args,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}

const cliCommandDocument = (overrides = {}) => ({
  actor: actor(),
  commandId: CMD1,
  reasonClass: 'incident_response',
  reason: 'operator hold',
  at: AT,
  ...overrides,
})

test('packaged operator command stops and resumes admission with sanitized output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-operator-admission-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
  })
  try {
    await persistence.migrate()
    persistence.close()
    const inputPath = join(directory, 'input.json')
    await writeFile(inputPath, JSON.stringify(cliCommandDocument()), { mode: 0o600 })
    const stop = await runCli([
      '--data-dir',
      directory,
      '--action',
      'stop',
      '--workspace',
      PLAN_WORKSPACE,
      '--input',
      inputPath,
    ])
    expect({ code: stop.code, stderr: stop.stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stop.stdout)).toMatchObject({
      action: 'stop',
      workspaceId: PLAN_WORKSPACE,
      status: 'ok',
      outcome: 'applied',
    })
    // Repeated stop through the CLI with a new command is an idempotent
    // duplicate, not an error.
    const againInputPath = join(directory, 'again-input.json')
    await writeFile(
      againInputPath,
      JSON.stringify(cliCommandDocument({ commandId: CMD3, reasonClass: 'cost_protection' })),
      { mode: 0o600 }
    )
    const again = await runCli([
      '--data-dir',
      directory,
      '--action',
      'stop',
      '--workspace',
      PLAN_WORKSPACE,
      '--input',
      againInputPath,
    ])
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'ok', outcome: 'duplicate' })
    const resumeInputPath = join(directory, 'resume-input.json')
    await writeFile(
      resumeInputPath,
      JSON.stringify(cliCommandDocument({ commandId: CMD2, reasonClass: 'policy_hold' })),
      { mode: 0o600 }
    )
    const resume = await runCli([
      '--data-dir',
      directory,
      '--action',
      'resume',
      '--workspace',
      PLAN_WORKSPACE,
      '--input',
      resumeInputPath,
    ])
    expect(JSON.parse(resume.stdout)).toMatchObject({ action: 'resume', outcome: 'applied' })
    // The denied authority case leaves admission open and fails closed.
    const deniedInputPath = join(directory, 'denied-input.json')
    await writeFile(
      deniedInputPath,
      JSON.stringify(cliCommandDocument({ actor: actor({ workspaceIds: [OTHER_WORKSPACE] }) })),
      { mode: 0o600 }
    )
    const denied = await runCli([
      '--data-dir',
      directory,
      '--action',
      'stop',
      '--workspace',
      PLAN_WORKSPACE,
      '--input',
      deniedInputPath,
    ])
    expect(denied).toEqual({
      code: 1,
      stdout: '',
      stderr: 'LOCAL_OPERATOR_ADMISSION_CONTROLS_FAILED\n',
    })
  } finally {
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

for (const failure of ['input-symlink', 'malformed-input', 'public-data', 'bad-arguments']) {
  test(`packaged operator admission command rejects ${failure} without leaking input`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-operator-admission-'))
    const persistence = new SqlitePersistenceProvider({
      path: join(directory, 'control-plane.sqlite'),
    })
    try {
      await persistence.migrate()
      persistence.close()
      let inputPath = join(directory, 'input.json')
      const document = JSON.stringify(cliCommandDocument())
      await writeFile(inputPath, document, { mode: 0o600 })
      let args = [
        '--data-dir',
        directory,
        '--action',
        'stop',
        '--workspace',
        PLAN_WORKSPACE,
        '--input',
        inputPath,
      ]
      if (failure === 'input-symlink') {
        const link = join(directory, 'linked.json')
        await symlink(inputPath, link)
        args[args.indexOf(inputPath)] = link
        inputPath = link
      } else if (failure === 'malformed-input') {
        await writeFile(inputPath, '{"admission-canary":', { mode: 0o600 })
      } else if (failure === 'public-data') {
        await chmod(directory, 0o755)
      } else if (failure === 'bad-arguments') {
        args = ['--data-dir', directory, '--action', 'restart', '--input', inputPath]
      }
      const outcome = await runCli(args)
      expect(outcome).toEqual({
        code: 1,
        stdout: '',
        stderr: 'LOCAL_OPERATOR_ADMISSION_CONTROLS_FAILED\n',
      })
      if (failure !== 'public-data') await chmod(directory, 0o700)
      expect(outcome.stdout).not.toContain('admission-canary')
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('unrelated corrupt workspace records never break a target workspace gate or audit trail', async () => {
  await withProvider(async (control) => {
    await seedExecution(control.provider, EXE1, PLAN_WORKSPACE)
    await seedExecution(control.provider, EXE2, OTHER_WORKSPACE)
    await setWorkflowAdmissionStop(control.provider, stopCommand())
    await clearWorkflowAdmissionStop(control.provider, resumeCommand({ at: LATER }))
    // Corrupt rows that belong only to OTHER_WORKSPACE: a stop state and an outcome.
    await control.provider.transaction(async (transaction) => {
      await transaction.put({
        namespace: WORKFLOW_ADMISSION_STOPS_NAMESPACE,
        id: recordId(`stop:workspace:${OTHER_WORKSPACE}`),
        value: { corrupt: true },
      })
      await transaction.put({
        namespace: admissionOutcomeNamespace(OTHER_WORKSPACE),
        id: 'r-0000000000000000000000000000000000000000000000000000000000000000',
        value: { corrupt: true },
      })
    })
    // The target workspace still admits, reads its state and lists its full trail.
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE1,
          input: { executionId: EXE1 },
        })
      ).resolves.toBeUndefined()
    })
    expect(await getWorkflowAdmissionStop(control.provider, stopCommand().scope)).toEqual({
      status: 'open',
      scope: { kind: 'workspace', workspaceId: PLAN_WORKSPACE },
    })
    expect(
      (await listWorkflowAdmissionOutcomes(control.provider, stopCommand().scope, 100)).map(
        (outcome) => outcome.action
      )
    ).toEqual(['stop', 'resume'])
    // The corrupt workspace itself still fails closed on both reads.
    await control.provider.transaction(async (transaction) => {
      await expect(
        assertWorkflowJobAdmissionOpen(transaction, {
          workflowKey: EXE2,
          input: { executionId: EXE2 },
        })
      ).rejects.toThrow('ADMISSION_CONTROL_STATE_CORRUPT')
    })
    await expect(
      listWorkflowAdmissionOutcomes(
        control.provider,
        { kind: 'workspace', workspaceId: OTHER_WORKSPACE },
        100
      )
    ).rejects.toThrow('ADMISSION_CONTROL_OUTCOME_CORRUPT')
  })
})

test('workspace-scoped outcome trail pages across the store limit and returns the newest records in order', async () => {
  await withProvider(async (control) => {
    const total = 130
    for (let index = 0; index < total; index += 1) {
      const commandId = `cmd_${String(index).padStart(26, '0')}`
      const at = new Date(Date.parse(AT) + index * 1000).toISOString()
      const command =
        index % 2 === 0 ? stopCommand({ commandId, at }) : resumeCommand({ commandId, at })
      const outcome =
        index % 2 === 0
          ? await setWorkflowAdmissionStop(control.provider, command)
          : await clearWorkflowAdmissionStop(control.provider, command)
      expect(outcome.outcome).toBe('applied')
    }
    const newest = await listWorkflowAdmissionOutcomes(control.provider, stopCommand().scope, 5)
    expect(newest.map((outcome) => outcome.commandId)).toEqual(
      [125, 126, 127, 128, 129].map((index) => `cmd_${String(index).padStart(26, '0')}`)
    )
    const everything = await listWorkflowAdmissionOutcomes(
      control.provider,
      stopCommand().scope,
      500
    )
    expect(everything).toHaveLength(total)
    expect(everything.map((outcome) => outcome.commandId)).toEqual(
      Array.from({ length: total }, (_, index) => `cmd_${String(index).padStart(26, '0')}`)
    )
  })
})

/** Execution-scoped cancellation command, shaped like the accepted control-API envelope. */
function cancelCommand(executionId, commandId, workspaceId = PLAN_WORKSPACE) {
  return {
    workspaceId,
    projectId: PROJECT,
    caller: { servicePrincipalId: 'svc_admission-controls-test' },
    contractVersion: { major: 1, minor: 0 },
    requestId: `req_${commandId.slice(4)}`,
    correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    commandId,
    idempotencyKey: `cancel:${commandId}`,
    payloadHash: 'd'.repeat(64),
    operation: 'execution.cancel',
    issuedAt: AT,
    payload: { executionId },
  }
}

function interactionRequest(executionId) {
  return {
    interactionId: INTERACTION,
    executionId,
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    kind: 'input',
    prompt: { title: 'Approval requested before the stop' },
    allowedActions: ['input'],
    allowedPrincipalIds: ['svc_owner'],
    state: 'responded',
    version: 2,
    requestedAt: AT,
    expiresAt: '2026-10-09T13:00:00.000Z',
    response: {
      responseId: CMD3,
      action: 'input',
      value: { text: 'approved' },
      respondingPrincipalId: 'svc_owner',
      respondedAt: LATER,
    },
  }
}

test('stop gates new admission but leaves cancellation and approval of admitted work deliverable', async () => {
  await withProvider(async (control) => {
    const world = await seedLifecycleWorld(control.provider, [EXE1, EXE2])
    const store = controlledJobStore(control.provider)
    const dispatcher = new EmbeddedExecutionWorkflowDispatcher({ store, now: () => AT })
    // Admitted before the stop: this job is already queued.
    await dispatcher.submit(world.inputFor(EXE1))

    const stop = await setWorkflowAdmissionStop(control.provider, stopCommand())
    expect(stop.outcome).toBe('applied')

    // New admission, including the entrypoint the reconciliation remediation uses, is refused.
    await expect(dispatcher.submit(world.inputFor(EXE2))).rejects.toThrow(
      'WORKFLOW_ADMISSION_STOPPED'
    )
    // Recovery (submitRecovery) needs a verified graph checkpoint and is covered by the
    // graph-recovery harness; this test does not claim it.

    // Cancellation of admitted work is a separate path that never enqueues: it stays deliverable.
    await dispatcher.cancel(cancelCommand(EXE1, CMD3))
    expect(await store.getCancellation(EXE1)).toEqual(expect.objectContaining({ commandId: CMD3 }))

    // Approval of admitted work is likewise stored without starting a new job.
    await dispatcher.deliver(interactionRequest(EXE1))
    expect(await store.getInteractionResponse(EXE1, INTERACTION)).toBeDefined()

    // Resume restores new admission for the workspace.
    const resume = await clearWorkflowAdmissionStop(control.provider, resumeCommand({ at: LATER }))
    expect(resume.outcome).toBe('applied')
    await dispatcher.submit(world.inputFor(EXE2))
  })
})
