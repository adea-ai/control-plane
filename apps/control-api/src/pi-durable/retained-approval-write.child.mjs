// Child process for the retained approval write restart proofs. Runs one task against
// persisted state in the given directory, prints one JSON line, and may crash on purpose.
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import { compose, taskFor, working } from './retained-approval-write.harness.mjs'

const [directory, scenario] = process.argv.slice(2)
const f = await fixture()
const counter = {
  invocations: 0,
  crashAfterWrite: scenario === 'crash-after-write',
  failNext: false,
}
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
