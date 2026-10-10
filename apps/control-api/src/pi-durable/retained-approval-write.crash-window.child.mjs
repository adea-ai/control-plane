// Child process for the crash-window proof. It runs one task over the persisted state in the
// given directory and prints one JSON line. The `crash-before-settlement` scenario exits the
// process at the effect gate's settlement write, after the tool-success record has committed.
// The patch is in this child process only; no production module is changed.
import { SqliteDurableEffectGateStore } from '@control-plane/pi-durable-adapter'
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import { compose, taskFor, working } from './retained-approval-write.harness.mjs'

const [directory, scenario] = process.argv.slice(2)
if (scenario === 'crash-before-settlement') {
  const compareAndSet = SqliteDurableEffectGateStore.prototype.compareAndSet
  SqliteDurableEffectGateStore.prototype.compareAndSet = function (expectedRevision, record) {
    if (record.state === 'settled') process.exit(137)
    return compareAndSet.call(this, expectedRevision, record)
  }
}

const f = await fixture()
const counter = { invocations: 0 }
const session = await compose(directory, f, { counter, clock: { now: working } })
try {
  const outcome = await session.runner.run(taskFor(f))
  console.log(JSON.stringify({ outcome, invocations: counter.invocations }))
} catch (error) {
  console.log(
    JSON.stringify({ error: error.code ?? String(error.message), invocations: counter.invocations })
  )
} finally {
  session.close()
}
