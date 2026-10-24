import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { createPiDurableEngine } from './pi-engine.ts'
import { withPublicationFault } from './native-cancellation-publication.fixture.mjs'

for (const mode of ['read', 'claim', 'update', 'successor']) {
  test(`native N followed by ${mode} publication failure retains observable truth without repeating abort`, async () => {
    await withPublicationFault(
      mode,
      async (f) => {
        expect(f.nativeReceipt).toBeDefined()
        expect(f.nativeReceipt.taskIds.length).toBeGreaterThan(0)
        expect(f.adapter.journal.get(f.handle.handleId)).toEqual(f.publicationCut)
        expect(f.publicationCut.detail.cancellationIntent).toBeUndefined()
        expect(f.faultCalls).toBe(mode === 'successor' ? 0 : 1)
        if (mode === 'successor')
          expect(f.publicationCut.detail.turn.requestId).toBe('newer-journal-turn')
        const observer = f.engine.guardedCancellation
        expect(await observer.readReceipt(f.nativePins)).toEqual(f.nativeReceipt)
        expect(await observer.drainReceipt(f.nativePins)).toEqual(f.nativeReceipt)
        const nativeBefore = await f.engine.inspect(f.nativePins.sessionId)
        const journalBefore = f.adapter.journal.get(f.handle.handleId)
        const counts = { requests: f.providerRequests(), aborts: f.streamAborts() }
        expect(counts.requests).toBe(1)
        expect(counts.aborts).toBe(1)
        expect(await observer.readReceipt(f.nativePins)).toEqual(f.nativeReceipt)
        expect(await observer.drainReceipt(f.nativePins)).toEqual(f.nativeReceipt)
        expect(await f.engine.inspect(f.nativePins.sessionId)).toEqual(nativeBefore)
        expect(f.adapter.journal.get(f.handle.handleId)).toEqual(journalBefore)
        expect({ requests: f.providerRequests(), aborts: f.streamAborts() }).toEqual(counts)
        // Put the RED expectation last: even the old classification must first
        // demonstrate a committed N and its real, non-repeating historical receipt.
        expect(f.failure?.message).toBe('PI_NATIVE_CANCELLATION_PUBLICATION_UNKNOWN')
        expect(f.failure).toBeInstanceOf(RuntimeAdapterError)
        expect(f.failure.code).toBe('PI_NATIVE_CANCELLATION_PUBLICATION_UNKNOWN')
        expect(f.failure.classification).toBe('conflict')
        expect(f.failure.retryable).toBe(false)
      },
      { Adapter: PiDurableRuntimeAdapter, createEngine: createPiDurableEngine }
    )
  }, 15000)
}

test('compiled adapter preserves post-native publication uncertainty in actual pinned Node SQLite', () => {
  const result = spawnSync(
    'node',
    [fileURLToPath(new URL('./native-cancellation-publication.node.fixture.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 }
  )
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(rows.map((row) => row.mode)).toEqual(['read', 'claim', 'update', 'successor'])
  expect(rows.every((row) => row.node === 'v24.21.0' && row.result === 'pass')).toBe(true)
}, 15000)
