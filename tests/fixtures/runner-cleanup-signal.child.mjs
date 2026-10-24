// Child process for the real-signal proof of the runner cleanup (M17.02.2, #1025). It wires the
// same `createCleanupRunner` / `installSignalCleanup` the test runner uses to real process
// signals, with one held cleanup callback, and records what happened in a marker file so the
// parent can check order and count from outside the process.
//
// argv: <releasePath> <markerPath> <mode>
//   mode "in-flight": cleanup is already running (like afterEach) when the signal arrives.
//   mode "idle":      nothing is running; the signal itself starts the cleanup.

import { appendFileSync, existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createCleanupRunner, installSignalCleanup } from './runner-cleanup.mjs'

const [, , releasePath, markerPath, mode] = process.argv
const mark = (line) => appendFileSync(markerPath, `${line}\n`)

const queue = [
  async () => {
    mark('cleanup-start')
    while (!existsSync(releasePath)) await delay(10)
    mark('cleanup-done')
  },
]
const run = createCleanupRunner(queue, 'child cleanup')

process.on('exit', (status) => mark(`exit:${status}`))
installSignalCleanup({
  run,
  signals: [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ],
})

if (mode === 'in-flight') {
  void run().catch(() => {})
  while (!existsSync(markerPath)) await delay(10)
}
process.stdout.write('ready\n')
// Stay alive until a signal ends the process.
setInterval(() => {}, 1000)
