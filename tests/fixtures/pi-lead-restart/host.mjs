// TEST ONLY: child host for the Pi lead crash/restart proof. Run as `bun host.mjs initial|recover <dir>`.
// `initial` dispatches one run through the production service, waits until its model turn is held open,
// reports it on stdout, and waits to be killed. `recover` opens the same directory on a fresh process.
// Construction runs the production startup recovery; the composition is never asked to resend.
import { dispatchEnvelope, openRestartComposition, startScriptedModel } from './composition.mjs'
import {
  intentId,
  principal,
  waitUntil,
} from '../../../apps/control-api/src/pi-durable/lead-fence-live-harness.mjs'

const [mode, directory] = process.argv.slice(2)
const emit = (label, value) => process.stdout.write(`${label} ${JSON.stringify(value)}\n`)

if (mode === 'initial') {
  const model = startScriptedModel({ gateOpen: false })
  const opened = await openRestartComposition({ directory, seed: true, baseUrl: model.baseUrl })
  const dispatched = (
    await opened.composition.service.dispatch(
      dispatchEnvelope('pi-durable.lead.dispatch', { intentId }, 'restart-proof:dispatch'),
      principal
    )
  ).data
  await waitUntil(
    () => model.counts.streamsStarted >= 1 && model.counts.requests >= 1,
    'model turn held open'
  )
  const [record] = opened.composition.adapter.journal.list()
  emit('HELD', {
    handleId: record.handleId,
    state: record.state,
    epoch: record.epoch,
    attemptId: record.attemptId,
    executionId: record.executionId ?? null,
    dispatchId: dispatched.dispatchId,
    requests: model.counts.requests,
  })
  // Hold the process open with the run in flight until the parent kills it.
  await new Promise(() => {})
} else if (mode === 'recover') {
  // A gate that is already open: if anything resent, its answer would complete and be counted.
  const model = startScriptedModel({ gateOpen: true })
  const opened = await openRestartComposition({ directory, seed: false, baseUrl: model.baseUrl })
  const records = opened.composition.adapter.journal.list().map((record) => ({
    handleId: record.handleId,
    state: record.state,
    epoch: record.epoch,
    attemptId: record.attemptId,
    executionId: record.executionId ?? null,
    ownerPid: record.detail.ownerPid,
    inferencePending: record.detail.inferencePending ?? false,
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
    duplicate,
    requestsAfterDuplicate: model.counts.requests,
    journalAfterDuplicate: opened.composition.adapter.journal.list().length,
  })
  await opened.close()
  model.stop()
  process.exit(0)
} else {
  process.stderr.write(`HOST_MODE_UNKNOWN ${mode}\n`)
  process.exit(2)
}
