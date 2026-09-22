import { describe, expect, test } from 'bun:test'
import { InMemoryExecutionEventRepository } from './index.ts'
import { InMemoryRuntimeEventEffectSink } from './runtime-ingestion.ts'

const correlation = {
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

const draft = (eventId, sequence) => ({
  eventId,
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  type: 'execution.progressed',
  schemaVersion: 1,
  correlation,
  payload: { progress: sequence },
  occurredAt: '2026-09-01T12:00:00.000Z',
  recordedAt: '2026-09-01T12:00:01.000Z',
  retentionExpiresAt: '2026-12-01T12:00:00.000Z',
})

function setup() {
  const events = new InMemoryExecutionEventRepository()
  return { sink: new InMemoryRuntimeEventEffectSink({ events }) }
}

describe('InMemoryRuntimeEventEffectSink replay verification', () => {
  test('a receipt stored pre-cutover still replays as duplicate via the legacy hash', async () => {
    const { sink } = setup()
    // Pre-cutover write: the effect carried only the legacy sha256 form.
    const pre = await sink.applyProgress({
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      eventSequence: 3,
      frameHash: 'sha256:' + 'a'.repeat(64),
      draft: draft('evt_01DRZ3NDEKTSV4RRFFQ69G5FAV', 3),
    })
    expect(pre.outcome).toBe('applied')
    // Post-cutover replay of the same frame: current s2 form plus the
    // recomputed legacy candidate must resolve to duplicate, not conflict.
    const replay = await sink.applyProgress({
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      eventSequence: 3,
      frameHash: 's2:' + 'b'.repeat(64),
      legacyFrameHash: 'sha256:' + 'a'.repeat(64),
      draft: draft('evt_01DRZ3NDEKTSV4RRFFQ69G5FAV', 3),
    })
    expect(replay.outcome).toBe('duplicate')
  })

  test('a different frame under the same key still conflicts', async () => {
    const { sink } = setup()
    await sink.applyProgress({
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      eventSequence: 4,
      frameHash: 'sha256:' + 'a'.repeat(64),
      draft: draft('evt_01DRZ3NDEKTSV4RRFFQ69G5FA0', 4),
    })
    const conflict = await sink.applyProgress({
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      eventSequence: 4,
      frameHash: 's2:' + 'c'.repeat(64),
      legacyFrameHash: 'sha256:' + 'd'.repeat(64),
      draft: draft('evt_01DRZ3NDEKTSV4RRFFQ69G5FA0', 4),
    })
    expect(conflict.outcome).toBe('conflict')
  })

  test('post-cutover receipts verify on the s2 form alone', async () => {
    const { sink } = setup()
    await sink.applyProgress({
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      eventSequence: 5,
      frameHash: 's2:' + 'b'.repeat(64),
      legacyFrameHash: 'sha256:' + 'a'.repeat(64),
      draft: draft('evt_01DRZ3NDEKTSV4RRFFQ69G5FA1', 5),
    })
    const replay = await sink.applyProgress({
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      eventSequence: 5,
      frameHash: 's2:' + 'b'.repeat(64),
      draft: draft('evt_01DRZ3NDEKTSV4RRFFQ69G5FA1', 5),
    })
    expect(replay.outcome).toBe('duplicate')
  })
})
