import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ControlApiFixtures } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { LocalControlApiComposition } from './local-api-composition.ts'

test('Local cancellation composition replays the stored signal after lost ACK and SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-cancellation-replay-'))
  const path = join(directory, 'state.sqlite')
  let persistence = new SqlitePersistenceProvider({ path })
  const signals = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith('/cancelExecution/send')) {
        signals.push({
          path: new URL(request.url).pathname,
          key: request.headers.get('idempotency-key'),
          body: await request.text(),
        })
        if (signals.length === 1) return new Response('{}', { status: 503 })
      }
      return Response.json(
        { status: 'PreviouslyAccepted', invocationId: 'inv_01JABC' },
        { status: 202 }
      )
    },
  })
  const ingress = `http://127.0.0.1:${server.port}`
  try {
    await persistence.migrate()
    let composition = new LocalControlApiComposition(persistence, ingress)
    const plan = createExecutionPlanTestFixture()
    await composition.executionPlans.put(plan)
    const base = ControlApiFixtures.executionAcceptance.request
    const accepted = await composition.executionAcceptanceService.accept(
      {
        ...base,
        issuedAt: new Date().toISOString(),
        payload: {
          ...base.payload,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          retentionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        },
      },
      base.caller.servicePrincipalId
    )
    const command = {
      ...base,
      operation: 'execution.cancel',
      payload: { executionId: accepted.data.executionId },
    }
    await expect(
      composition.executionCancellationService.cancel(command, 'svc_other')
    ).rejects.toThrow('EXECUTION_CANCELLATION_CALLER_MISMATCH')
    expect(signals).toHaveLength(0)
    await expect(
      composition.executionCancellationService.cancel(command, base.caller.servicePrincipalId)
    ).rejects.toThrow('Restate workflow submission failed')
    persistence.close()
    persistence = new SqlitePersistenceProvider({ path })
    await persistence.migrate()
    composition = new LocalControlApiComposition(persistence, ingress)
    const replay = { ...command, commandId: 'cmd_01JABCDEF0123456789ABCDEFH' }
    expect(
      (
        await composition.executionCancellationService.cancel(
          replay,
          base.caller.servicePrincipalId
        )
      ).data
    ).toMatchObject({ commandId: command.commandId, replayed: true })
    expect(signals).toHaveLength(2)
    expect(signals[1]).toEqual(signals[0])
    expect(signals[0]).toEqual({
      path: `/execution-lifecycle/${accepted.data.executionId}/cancelExecution/send`,
      key: `${accepted.data.executionId}:${command.commandId}`,
      body: '{}',
    })
    await composition.executionCancellationService.cancel(replay, base.caller.servicePrincipalId)
    expect(signals).toHaveLength(2)
  } finally {
    server.stop(true)
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})
