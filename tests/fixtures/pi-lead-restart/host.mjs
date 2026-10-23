// TEST ONLY: child host for the Pi lead crash/restart proof. Run as `bun host.mjs initial|recover <dir>`.
// `initial` dispatches one run through the production service, waits until its model turn is held open,
// reports it on stdout, and waits to be killed. `recover` opens the same directory on a fresh process.
// Construction runs the production startup recovery; the composition is never asked to resend.
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dispatchEnvelope, openRestartComposition, startScriptedModel } from './composition.mjs'
import {
  intentId,
  principal,
  waitUntil,
} from '../../../apps/control-api/src/pi-durable/lead-fence-live-harness.mjs'

const [mode, restartDirectory] = process.argv.slice(2)
const emit = (label, value) => process.stdout.write(`${label} ${JSON.stringify(value)}\n`)

async function runWithCleanup(work, cleanup, label) {
  let result
  let primaryFailure
  let failed = false
  try {
    result = await work()
  } catch (error) {
    failed = true
    primaryFailure = error
  }
  const cleanupFailures = []
  for (const close of cleanup) {
    try {
      await close()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  if (failed && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], label, {
      cause: primaryFailure,
    })
  }
  if (failed) throw primaryFailure
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, label)
  return result
}

async function runInitial(directory, beforeSend) {
  const model = startScriptedModel({ gateOpen: false })
  let opened
  let authorizedInferenceKey
  let enterAuthorization
  const authorizationEntered = new Promise((resolve) => {
    enterAuthorization = resolve
  })
  const recordBoundary = async (phase, inferenceKey) => {
    await appendFile(
      join(directory, 'process-evidence.jsonl'),
      `${JSON.stringify({ boundary: 'native_fetch', phase, inferenceKey })}\n`
    )
  }
  const physicalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname !== '/v1/chat/completions') return physicalFetch(input, init)
    if (typeof authorizedInferenceKey !== 'string')
      throw new Error('RESTART_FIXTURE_INFERENCE_KEY_MISSING')
    await recordBoundary('forwarded', authorizedInferenceKey)
    return physicalFetch(input, init)
  }
  await runWithCleanup(
    async () => {
      opened = await openRestartComposition({
        directory,
        seed: true,
        baseUrl: model.baseUrl,
        holdBeforeNativeDispatch: beforeSend,
        onNativeDispatchBoundary: async (inferenceKey) => {
          authorizedInferenceKey = inferenceKey
          await recordBoundary('before_dispatch', inferenceKey)
          if (beforeSend) enterAuthorization(inferenceKey)
        },
      })
      const dispatched = (
        await opened.composition.service.dispatch(
          dispatchEnvelope('pi-durable.lead.dispatch', { intentId }, 'restart-proof:dispatch'),
          principal
        )
      ).data
      const inferenceKey = beforeSend
        ? await authorizationEntered
        : (await waitUntil(
            () => model.counts.streamsStarted >= 1 && model.counts.requests >= 1,
            'model turn held open'
          ),
          authorizedInferenceKey)
      const [record] = opened.composition.adapter.journal.list()
      emit('HELD', {
        handleId: record.handleId,
        state: record.state,
        epoch: record.epoch,
        attemptId: record.attemptId,
        executionId: record.executionId ?? null,
        dispatchId: dispatched.dispatchId,
        inferenceKey,
        requests: model.counts.requests,
      })
      // Hold the process open with the run in flight until the parent kills it.
      await new Promise(() => {})
    },
    [() => opened?.close(), () => model.stop()],
    'Pi lead initial host cleanup failed'
  )
}

async function runRecovery(directory) {
  const model = startScriptedModel({ gateOpen: true })
  let opened
  let reconcileEvidence
  let authorizedInferenceKey
  const authorizedInferenceKeys = []
  const physicalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname !== '/v1/chat/completions') return physicalFetch(input, init)
    if (typeof authorizedInferenceKey !== 'string')
      throw new Error('RESTART_FIXTURE_INFERENCE_KEY_MISSING')
    await appendFile(
      join(directory, 'process-evidence.jsonl'),
      `${JSON.stringify({ boundary: 'native_fetch', phase: 'forwarded', inferenceKey: authorizedInferenceKey })}\n`
    )
    return physicalFetch(input, init)
  }
  await runWithCleanup(
    async () => {
      opened = await openRestartComposition({
        directory,
        seed: false,
        baseUrl: model.baseUrl,
        onNativeDispatchBoundary: async (inferenceKey) => {
          authorizedInferenceKey = inferenceKey
          authorizedInferenceKeys.push(inferenceKey)
          await appendFile(
            join(directory, 'process-evidence.jsonl'),
            `${JSON.stringify({ boundary: 'native_fetch', phase: 'before_dispatch', inferenceKey })}\n`
          )
        },
        reconcileInference: async (_authority, key) => {
          const text = await readFile(join(directory, 'process-evidence.jsonl'), 'utf8').catch(
            (error) => {
              if (error.code === 'ENOENT') return ''
              throw error
            }
          )
          const rows = text.trim()
            ? text
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
            : []
          const beforeDispatch = rows.some(
            (entry) => entry.phase === 'before_dispatch' && entry.inferenceKey === key
          )
          const alreadyForwarded = rows.some(
            (entry) => entry.phase === 'forwarded' && entry.inferenceKey === key
          )
          // These advisory process logs do not bind an independently current store
          // generation or prove that the retained hold never crossed the send boundary.
          // They cannot mint the runtime's private permission to reuse that hold.
          const decision = 'unresolved'
          reconcileEvidence = { key, beforeDispatch, alreadyForwarded, decision }
          return decision
        },
      })
      await opened.composition.adapter.drain()
      const records = opened.composition.adapter.journal.list().map((record) => ({
        handleId: record.handleId,
        state: record.state,
        epoch: record.epoch,
        attemptId: record.attemptId,
        executionId: record.executionId ?? null,
        ownerPid: record.detail.ownerPid,
        inferencePending: record.detail.inferencePending ?? false,
        inferenceKeys: Object.keys(record.detail.inferenceReceipts ?? {}),
      }))
      // A duplicate submission with the original idempotency key after restart. It must not reach the
      // model or admit a second run; the production service answers however it answers, and we report it.
      let duplicate
      try {
        const replayed = await opened.composition.service.dispatch(
          dispatchEnvelope('pi-durable.lead.dispatch', { intentId }, 'restart-proof:dispatch'),
          principal
        )
        duplicate = { ok: true, dispatchId: replayed.data?.dispatchId ?? null }
      } catch (error) {
        duplicate = { ok: false, code: error?.code ?? error?.message ?? 'UNKNOWN' }
      }
      emit('REPORT', {
        records,
        recoveryBlocked: opened.composition.recoveryBlocked,
        requests: model.counts.requests,
        streams: model.counts.streamsStarted,
        resolvePlanCalls: opened.resolvePlanCalls,
        authorizedInferenceKeys,
        reconcileEvidence,
        duplicate,
        requestsAfterDuplicate: model.counts.requests,
        journalAfterDuplicate: opened.composition.adapter.journal.list().length,
      })
    },
    [() => opened?.close(), () => model.stop()],
    'Pi lead recovery host cleanup failed'
  )
}

if (mode === 'initial' || mode === 'before-send') {
  await runInitial(restartDirectory, mode === 'before-send')
} else if (mode === 'recover' || mode === 'recover-safe') {
  await runRecovery(restartDirectory)
} else {
  process.stderr.write(`HOST_MODE_UNKNOWN ${mode}\n`)
  process.exit(2)
}
