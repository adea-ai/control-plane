import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import postgresEsm from 'postgres'

// Child-process regression: an uncaught driver error must not kill the suite.
let phase = 'connect'
async function main() {
  const postgres =
    process.env.TEST_POSTGRES_MODE === 'cjs'
      ? createRequire(import.meta.url)(
          fileURLToPath(new URL('../cjs/src/index.js', import.meta.resolve('postgres')))
        )
      : postgresEsm
  const client = postgres(process.env.TEST_APPLICATION_URL, { max: 1, prepare: false })
  try {
    for (const mode of ['idle', 'query']) {
      phase = `${mode}:timeout`
      const messageId = randomUUID()
      let wrote = false
      let callbackFinished
      const finished = new Promise((resolve) => {
        callbackFinished = resolve
      })
      await assert.rejects(
        client.begin(async (transaction) => {
          try {
            await transaction`set local transaction_timeout = '500ms'`
            await transaction`
              insert into inbox_messages (consumer, message_id, payload)
              values ('m11-timeout-probe', ${messageId}, '{}')
            `
            wrote = true
            if (mode === 'idle') await new Promise((resolve) => setTimeout(resolve, 1_000))
            else await transaction`select pg_sleep(1)`
          } finally {
            callbackFinished()
          }
        })
      )
      await finished
      assert.equal(wrote, true)
      // Allow the driver's deferred COMMIT/ROLLBACK write to settle too.
      await new Promise((resolve) => setTimeout(resolve, 50))
      phase = `${mode}:rollback`
      const rows = await client`
        select id from inbox_messages
        where consumer = 'm11-timeout-probe' and message_id = ${messageId}
      `
      assert.equal(rows.length, 0)
      phase = `${mode}:reuse`
      await client.begin(async (transaction) => {
        await transaction`select 1`
      })
    }
  } finally {
    const previousPhase = phase
    phase = `${previousPhase}:shutdown`
    await client.end({ timeout: 1 })
    phase = previousPhase
  }
}

main().catch((error) => {
  const code = /^[A-Z_0-9]{1,50}$/.test(error?.code) ? error.code : 'UNKNOWN'
  console.error(`TRANSACTION_TIMEOUT_PROBE_FAILED:${phase}:${code}`)
  process.exitCode = 1
})
