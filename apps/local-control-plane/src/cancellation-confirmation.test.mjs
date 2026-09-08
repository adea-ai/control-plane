import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.ts'

const recordId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`

test.each(['starting', 'running', 'awaiting_input', 'cancelling', 'unknown'])(
  'cancellation does not commit an active or ambiguous %s acknowledgement',
  async (state) => {
    const directory = await mkdtemp(join(tmpdir(), 'local-cancel-confirmation-'))
    const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const handle = {
      handleId: 'native:confirmation',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      startedAt: '2026-09-08T00:00:00.000Z',
    }
    const input = {
      executionId,
      attemptId: handle.attemptId,
      effectKey: 'confirmation:cancel',
      reason: 'user_request',
    }
    const requests = []
    let observedState = state
    let observedHandle = handle
    let reconciliations = 0
    const runtime = {
      transportKind: 'direct-local',
      // Adapters may cache this idempotent acknowledgement even after stopping.
      cancel: async (_handle, request) => {
        requests.push(request)
        return { handle, state, observedAt: handle.startedAt }
      },
      reconcile: async () => {
        reconciliations++
        return { handle: observedHandle, state: observedState, observedAt: handle.startedAt }
      },
    }
    try {
      await persistence.migrate()
      await persistence.transaction((tx) =>
        tx.put({ namespace: 'runtime-handles', id: recordId(executionId), value: handle })
      )
      let activities = new DirectRuntimeActivityPort(persistence, {}, runtime)
      await expect(activities.cancel(input)).rejects.toThrow('RUNTIME_CANCEL_UNCONFIRMED')
      expect(
        await persistence.transaction((tx) => tx.get('workflow-effects', recordId(input.effectKey)))
      ).toBeUndefined()
      persistence.close()
      await persistence.migrate()
      activities = new DirectRuntimeActivityPort(persistence, {}, runtime)
      observedState = 'cancelled'
      for (const mismatch of [
        { handleId: 'native:other' },
        { attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
        { startedAt: '2026-09-08T00:00:01.000Z' },
      ]) {
        observedHandle = { ...handle, ...mismatch }
        await expect(activities.cancel(input)).rejects.toThrow('RUNTIME_CANCEL_HANDLE_MISMATCH')
      }
      observedHandle = handle
      await activities.cancel(input)
      await activities.cancel(input)
      expect(requests).toHaveLength(5)
      for (const request of requests) expect(request).toEqual(requests[0])
      expect(reconciliations).toBe(5)
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
