// Child process for the retained approval write restart proofs. Runs one task against
// persisted state in the given directory, prints one JSON line, and may crash on purpose.
import { DatabaseSync } from 'node:sqlite'
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import { compose, taskFor, working } from './retained-approval-write.harness.mjs'

const [directory, scenario] = process.argv.slice(2)
if (scenario === 'hang') {
  // Test-only: never finishes, so the owner's deadline is what ends it. The interval keeps it alive.
  setInterval(() => {}, 1_000)
  await new Promise(() => {})
}
const f = await fixture()
const counter = {
  invocations: 0,
  crashAfterWrite: scenario === 'crash-after-write',
  failNext: false,
}
let startupLock
let session
try {
  session = await compose(directory, f, {
    counter,
    clock: { now: working },
    ...(scenario === 'compose-busy' || scenario === 'compose-invalid'
      ? {
          createEffectDatabase(path) {
            if (scenario === 'compose-invalid')
              throw Object.assign(new Error('FIXTURE_INVALID_SQL'), {
                code: 'ERR_SQLITE_ERROR',
                errcode: 1,
              })
            startupLock = new DatabaseSync(path)
            startupLock.exec('BEGIN EXCLUSIVE')
            return new DatabaseSync(path)
          },
        }
      : {}),
  })
  const outcome = await session.runner.run(taskFor(f))
  console.log(JSON.stringify({ outcome, invocations: counter.invocations }))
} catch (error) {
  // A losing startup lock has no runner or effect invocation. Preserve its
  // conflict result; runtime and unrelated startup failures keep their code.
  const startupConflict =
    session === undefined &&
    counter.invocations === 0 &&
    error.code === 'ERR_SQLITE_ERROR' &&
    error.errcode === 5
  console.log(
    JSON.stringify({
      error: startupConflict ? 'PI_EFFECT_STORE_CONFLICT' : (error.code ?? String(error.message)),
      invocations: counter.invocations,
    })
  )
} finally {
  try {
    session?.close()
  } finally {
    startupLock?.close()
  }
}
