// The owned subprocess for the SQLite child-budget crash regression (#187).
//
// A thrown exception is not crash coverage: an unwinding transaction rolls back
// in the same process, so it can never show what the store recovers from an
// operating-system crash. This module is the crash half. It is a separate
// process that the test kills with SIGKILL while the child allocation is parked
// at a deterministic barrier, so the store has to recover from the crash of the
// whole process rather than from an exception.
//
// Two crash points are covered:
//
//   - `before-commit`: the allocation's staged writes (the child execution, the
//     child attempt, the child budget, the delegation record and the admission
//     receipt) have been written inside the transaction, and the process dies
//     before the enclosing commit. Nothing may survive them.
//   - `after-commit`: the enclosing commit has happened and the caller has not
//     yet observed the result, so the process dies before the acknowledgement.
//     The single committed allocation must survive.
//
// The barrier is installed by wrapping the provider's `transaction` method, so
// the crash lands exactly on the commit seam and no production source is
// edited. The shared child-allocation fixture is reused as it is.
//
// Usage: bun child-budget-admission-crash.fixture.mjs <before-commit|after-commit>

import { SqliteDelegationRepository } from './delegation-repository.ts'
import { recordId } from './record-storage.ts'
import { fixture } from './child-allocation-fixture.mjs'

const CRASH_POINTS = ['before-commit', 'after-commit']

const crashPoint = process.argv[2]
if (!CRASH_POINTS.includes(crashPoint)) {
  process.stderr.write(
    `usage: child-budget-admission-crash.fixture.mjs <${CRASH_POINTS.join('|')}>\n`
  )
  process.exit(2)
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

// The parked promise never settles: the process is killed here, and the state
// it left behind is the crash evidence.
function park(where, evidence) {
  emit({ type: 'parked', point: where, ...evidence })
  return new Promise(() => {})
}

/**
 * Count the rows the allocation staged, so the test can prove the crash landed
 * after those writes and not before them.
 */
async function stagedRows(tx, request) {
  const execution = await tx.get('executions', recordId(request.childExecutionId))
  const attempt = await tx.get('execution-attempts', recordId(request.childAttemptId))
  const delegation = await tx.get('delegations', recordId(request.delegationId))
  const receipt = await tx.get('delegation-admission-receipts', recordId(request.delegationId))
  return {
    attempts: attempt ? 1 : 0,
    delegations: delegation ? 1 : 0,
    executions: execution ? 1 : 0,
    receipts: receipt ? 1 : 0,
  }
}

const f = await fixture()
const child = await f.childAdmission()

const gated = new Proxy(f.provider, {
  get(target, property) {
    if (property === 'transaction') {
      return async (operation) => {
        if (crashPoint === 'before-commit') {
          return target.transaction(async (tx) => {
            const result = await operation(tx)
            // Every staged allocation write has happened inside the transaction;
            // the enclosing commit has not. The process dies here, and the
            // staged rows are reported so the test can prove the crash point.
            await park('before-commit', { staged: await stagedRows(tx, child.request) })
            return result
          })
        }
        const result = await target.transaction(operation)
        // The commit has happened; the caller has not observed the result yet.
        // The process dies here, before the acknowledgement, and the committed
        // rows are reported so the test can prove they survived the crash.
        const committed = await target.transaction((tx) => stagedRows(tx, child.request))
        await park('after-commit', { committed })
        return result
      }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

const allocator = new SqliteDelegationRepository(gated)

emit({
  type: 'ready',
  directory: f.directory,
  request: child.request,
  receipt: child.receipt,
  execution: child.childExecution,
  attempt: child.childAttempt,
  delegation: child.delegation,
})

await allocator.allocate({
  request: child.request,
  receipt: child.receipt,
  execution: child.childExecution,
  attempt: child.childAttempt,
  delegation: child.delegation,
  assertCurrent: async () => undefined,
})

// The allocation returned. The process stays alive so that the test can still
// kill it; a crash before this line is the `after-commit` case.
emit({ type: 'completed' })
await park('after-acknowledgement')
