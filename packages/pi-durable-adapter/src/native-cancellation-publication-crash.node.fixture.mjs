// Test-only compiled Node host. The initial process is killed after actual native
// N and before the adapter receives its reply; recovery never opens a native owner.
import assert from 'node:assert/strict'
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { PiDurableRuntimeAdapter } from '../dist/adapter.js'
import { createPiDurableEngine } from '../dist/pi-engine.js'
import { fixture } from './adapter.fixture.mjs'
import { withPublicationFault } from './native-cancellation-publication.fixture.mjs'

const prefix = 'PI_NATIVE_CRASH '
const [mode, directory] = process.argv.slice(2)
assert.equal(process.version, 'v24.21.0')
assert.ok(directory)
const boundaryPath = join(directory, 'native-publication-crash-boundary.json')
const emit = (value) => process.stdout.write(`${prefix}${JSON.stringify(value)}\n`)

if (mode === 'initial') {
  await withPublicationFault(
    'read',
    () => assert.fail('The post-N crash boundary must not return'),
    {
      Adapter: PiDurableRuntimeAdapter,
      createEngine: createPiDurableEngine,
      directory,
      afterNativeCommit: async (evidence) => {
        const records = evidence.adapter.journal.list()
        assert.equal(records.length, 1)
        const record = records[0]
        assert.equal(record.state, 'running')
        assert.equal(record.detail.cancellationIntent, undefined)
        assert.equal(record.detail.nativeCancellationReceipt, undefined)
        assert.equal(evidence.providerRequests, 1)
        assert.equal(evidence.streamAborts, 1)
        assert.ok(evidence.nativeReceipt.taskIds.length > 0)
        const boundary = {
          kind: 'N_COMMITTED',
          node: process.version,
          nativePins: evidence.nativePins,
          nativeReceipt: evidence.nativeReceipt,
          record,
          providerRequests: evidence.providerRequests,
          streamAborts: evidence.streamAborts,
        }
        const descriptor = openSync(boundaryPath, 'wx', 0o600)
        try {
          writeFileSync(descriptor, JSON.stringify(boundary))
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        // A pending promise alone does not keep a Node process alive. No close or
        // publication path is allowed to run before the parent's explicit kill.
        setInterval(() => {}, 1000)
        emit(boundary)
        await new Promise(() => {})
      },
    }
  )
} else if (mode === 'recover') {
  const boundary = JSON.parse(await readFile(boundaryPath, 'utf8'))
  const { options, request, admission } = fixture(directory)
  const counters = {
    authority: 0,
    inferenceAuthorizations: 0,
    models: 0,
    engines: 0,
    settlements: 0,
    probes: [],
  }
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 64, maxTokens: 32 }] })
  faux.setResponses([fauxAssistantMessage('Unexpected recovery inference')])
  options.assertAuthority = async (authority) => {
    counters.authority += 1
    assert.equal(authority.request.attemptId, request.attemptId)
    assert.equal(authority.request.executionPlan.contentDigest, request.executionPlan.contentDigest)
    assert.equal(authority.admission.authority.scopeRef, admission.authority.scopeRef)
  }
  const originalProvider = options.resolveProvider
  options.resolveProvider = async (...args) => ({
    ...(await originalProvider(...args)),
    provider: 'faux',
    providerModel: 'faux-1',
    withModels: async (use) => {
      counters.models += 1
      const models = createModels()
      models.setProvider(faux.provider)
      return use(models)
    },
  })
  options.authorizeInference = async () => {
    counters.inferenceAuthorizations += 1
    return { maxOutputTokens: 10, maximumInputTokens: 64, assertActive: async () => {} }
  }
  options.engineFactory = async (engineOptions) => {
    counters.engines += 1
    return createPiDurableEngine(engineOptions)
  }
  options.settleUsage = async (_authority, _key, usage) => {
    counters.settlements += 1
    return usage
  }
  options.reconcileInference = async (_authority, key) => {
    counters.probes.push(key)
    return 'unresolved'
  }
  const adapter = new PiDurableRuntimeAdapter(options)
  let report
  let primaryFailure
  try {
    const handle = await adapter.start(request)
    assert.equal(handle.handleId, boundary.record.handleId)
    const first = await adapter.reconcile(handle)
    await adapter.drain()
    assert.equal(first.state, 'unknown')
    assert.deepEqual(await adapter.start(request), handle)
    assert.equal((await adapter.reconcile(handle)).state, 'unknown')
    await adapter.drain()
    const records = adapter.journal.list()
    assert.equal(records.length, 1)
    const record = records[0]
    assert.equal(record.state, 'unknown')
    assert.ok(record.epoch > boundary.record.epoch)
    assert.deepEqual(record.detail.activeInference, boundary.record.detail.activeInference)
    assert.equal(record.detail.inferencePending, true)
    for (const key of [
      'cancellationIntent',
      'nativeCancellationReceipt',
      'result',
      'terminalUsage',
    ])
      assert.equal(record.detail[key], undefined)
    assert.equal(record.detail.safeResumeInferenceKey, undefined)
    const events = []
    for await (const event of adapter.progress(handle)) events.push(event)
    assert.equal(
      events.some((event) => ['cancelled', 'completed', 'failed'].includes(event.data?.state)),
      false
    )
    assert.ok(counters.authority > 0)
    assert.equal(counters.inferenceAuthorizations, 0)
    assert.equal(counters.engines, 0)
    assert.equal(counters.models, 0)
    assert.equal(counters.settlements, 0)
    assert.equal(faux.state.callCount, 0)
    report = {
      kind: 'RECOVERED',
      node: process.version,
      handle,
      record,
      counters,
      providerRequests: faux.state.callCount,
      events,
    }
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    // Keep both the proof failure and a failing close observable. Process exit
    // remains the parent's required boundary before directory cleanup.
    await closeRecoveryAdapter()
  }
  async function closeRecoveryAdapter() {
    try {
      await adapter.close()
    } catch (error) {
      if (primaryFailure !== undefined)
        throw new AggregateError(
          [primaryFailure, error],
          'Native recovery proof and close failed',
          {
            cause: error,
          }
        )
      throw error
    }
  }
  // Only public adapter evidence is observed after restart. An unopened native
  // receipt lookup and positive cancellation recovery are separate, unproven work.
  emit(report)
} else {
  throw new Error('UNKNOWN_NATIVE_CRASH_FIXTURE_MODE')
}
