import { expect, test } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { fixture } from './adapter.fixture.mjs'

// Synthetic canaries only. They are not credentials, no provider receives them, and each one
// exists solely to prove that a credential-shaped value cannot reach a durable Pi sink.
const leaseCanary = 'DO_NOT_PERSIST_PI_DURABLE_LEASE_CANARY'
const admissionCanary = 'DO_NOT_PERSIST_PI_DURABLE_ADMISSION_CANARY'
const engineCanary = 'DO_NOT_PERSIST_PI_DURABLE_ENGINE_ERROR_CANARY'
const sessionCanary = 'DO_NOT_PERSIST_PI_DURABLE_SESSION_CANARY'

const completed = {
  text: 'answer',
  submissionId: 'submission',
  usage: { inputTokens: 3, outputTokens: 4, costUsd: '0.000007', durationMs: 2 },
  inferences: [
    {
      inferenceId: 'pi-generation:1',
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        durationMs: 2,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    },
  ],
}

// Opens the real authority file after the adapter closes, so each row is committed state.
function rows(directory, table) {
  const db = new DatabaseSync(join(directory, 'authority.sqlite'))
  try {
    return db.prepare(`SELECT * FROM ${table}`).all()
  } finally {
    db.close()
  }
}

// Builds a real adapter fixture whose provider lease carries the lease canary and whose
// engine records what its credential callback received before running.
function harness(directory, { run } = {}) {
  const observed = { lease: undefined }
  const { options, request, admission } = fixture(directory)
  const resolveProvider = options.resolveProvider
  options.resolveProvider = async (...args) => ({
    ...(await resolveProvider(...args)),
    withModels: async (use) => use({ apiKey: leaseCanary }),
  })
  options.engineFactory = async (engineOptions) => ({
    run: async () => {
      observed.lease = await engineOptions.withModels(async (models) => models.apiKey)
      return run ? run() : completed
    },
    close: async () => {},
    cancel: async () => {},
  })
  return { options, request, admission, observed }
}

test('keeps a secret canary out of Pi durable admission rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-canary-admission-'))
  const rejected = mkdtempSync(join(tmpdir(), 'pi-canary-admission-rejected-'))
  try {
    const { options, request, observed } = harness(directory)
    const adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await adapter.drain()
    await adapter.close()
    // Positive control: the lease canary crossed the real provider callback into the engine.
    expect(observed.lease).toBe(leaseCanary)
    const admissions = rows(directory, 'pi_admissions')
    expect(admissions).toHaveLength(1)
    expect(JSON.stringify(admissions)).toContain(handle.handleId)
    expect(JSON.stringify(admissions)).not.toContain(leaseCanary)

    // An unschematized canary in the admission authority is rejected before any row exists.
    const strict = harness(rejected)
    const strictAdapter = new PiDurableRuntimeAdapter({
      ...strict.options,
      resolveAdmission: async () => ({
        ...strict.admission,
        authority: { ...strict.admission.authority, credential: admissionCanary },
      }),
    })
    const failure = await strictAdapter.start(strict.request).then(
      () => undefined,
      (error) => error
    )
    await strictAdapter.close()
    expect(failure?.message).toBe('PI_ADMISSION_AUTHORITY_REJECTED')
    expect(rows(rejected, 'pi_admissions')).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(rejected, { recursive: true, force: true })
  }
})

test('keeps a secret canary out of Pi durable progress rows', async () => {
  const completedDirectory = mkdtempSync(join(tmpdir(), 'pi-canary-progress-completed-'))
  const failedDirectory = mkdtempSync(join(tmpdir(), 'pi-canary-progress-failed-'))
  try {
    const success = harness(completedDirectory)
    const completedAdapter = new PiDurableRuntimeAdapter(success.options)
    await completedAdapter.start(success.request)
    await completedAdapter.drain()
    await completedAdapter.close()
    const progress = rows(completedDirectory, 'pi_progress')
    // Positive control: the completed run wrote its status and output events.
    expect(progress.map((row) => JSON.parse(row.body).type)).toEqual(
      expect.arrayContaining(['status', 'output'])
    )
    expect(JSON.stringify(progress)).not.toContain(leaseCanary)

    // The engine fails with the canary in its error text. Only the fixed reason code may persist.
    const failure = harness(failedDirectory, {
      run: () => {
        throw new Error(`${engineCanary} engine rejected the request`)
      },
    })
    const failedAdapter = new PiDurableRuntimeAdapter(failure.options)
    await failedAdapter.start(failure.request)
    await failedAdapter.drain()
    await failedAdapter.close()
    const failedProgress = rows(failedDirectory, 'pi_progress')
    // Positive control: the failure path ran and recorded its reason code.
    expect(JSON.stringify(failedProgress)).toContain('PI_INFERENCE_RECONCILIATION_REQUIRED')
    expect(JSON.stringify(failedProgress)).not.toContain(engineCanary)
    expect(JSON.stringify(rows(failedDirectory, 'pi_admissions'))).not.toContain(engineCanary)
  } finally {
    rmSync(completedDirectory, { recursive: true, force: true })
    rmSync(failedDirectory, { recursive: true, force: true })
  }
})

test('keeps a secret canary out of Pi durable session rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-canary-session-'))
  try {
    const { options } = harness(directory)
    const adapter = new PiDurableRuntimeAdapter(options)
    const created = await adapter.session({
      operation: 'create',
      idempotencyKey: 'session:canary-check',
    })
    const sessionId = created.session.sessionId
    await adapter.session({ operation: 'close', sessionId })
    // An unschematized canary in a session operation is rejected before any row is written.
    const failure = await adapter
      .session({
        operation: 'create',
        idempotencyKey: 'session:rejected',
        providerCredential: sessionCanary,
      })
      .then(
        () => undefined,
        (error) => error
      )
    await adapter.close()
    expect(failure).toBeDefined()
    expect(String(failure.message)).not.toContain(sessionCanary)
    const sessions = rows(directory, 'pi_sessions')
    // Positive control: create and close committed exactly one closed session row.
    expect(sessions).toHaveLength(1)
    expect(JSON.stringify(sessions)).toContain(sessionId)
    expect(JSON.parse(sessions[0].body).state).toBe('closed')
    expect(JSON.stringify(sessions)).not.toContain(sessionCanary)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
