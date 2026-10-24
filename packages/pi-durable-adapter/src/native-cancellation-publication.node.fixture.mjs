import assert from 'node:assert/strict'
import { withPublicationFault } from './native-cancellation-publication.fixture.mjs'
import { PiDurableRuntimeAdapter } from '../dist/adapter.js'
import { createPiDurableEngine } from '../dist/pi-engine.js'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
assert.equal(process.version, 'v24.21.0')
for (const mode of ['read', 'claim', 'update', 'successor']) {
  await withPublicationFault(
    mode,
    async (f) => {
      assert.ok(f.nativeReceipt.taskIds.length > 0)
      assert.deepEqual(f.adapter.journal.get(f.handle.handleId), f.publicationCut)
      assert.equal(f.publicationCut.detail.cancellationIntent, undefined)
      assert.equal(f.faultCalls, mode === 'successor' ? 0 : 1)
      if (mode === 'successor')
        assert.equal(f.publicationCut.detail.turn.requestId, 'newer-journal-turn')
      const observer = f.engine.guardedCancellation
      assert.deepEqual(await observer.readReceipt(f.nativePins), f.nativeReceipt)
      assert.deepEqual(await observer.drainReceipt(f.nativePins), f.nativeReceipt)
      const before = await f.engine.inspect(f.nativePins.sessionId),
        journal = f.adapter.journal.get(f.handle.handleId)
      assert.equal(f.providerRequests(), 1)
      assert.equal(f.streamAborts(), 1)
      assert.deepEqual(await observer.readReceipt(f.nativePins), f.nativeReceipt)
      assert.deepEqual(await observer.drainReceipt(f.nativePins), f.nativeReceipt)
      assert.deepEqual(await f.engine.inspect(f.nativePins.sessionId), before)
      assert.deepEqual(f.adapter.journal.get(f.handle.handleId), journal)
      assert.equal(f.providerRequests(), 1)
      assert.equal(f.streamAborts(), 1)
      assert.ok(f.failure instanceof RuntimeAdapterError)
      assert.equal(f.failure.code, 'PI_NATIVE_CANCELLATION_PUBLICATION_UNKNOWN')
      assert.equal(f.failure.classification, 'conflict')
      assert.equal(f.failure.retryable, false)
    },
    { Adapter: PiDurableRuntimeAdapter, createEngine: createPiDurableEngine }
  )
  console.log(
    JSON.stringify({ mode, node: process.version, sqlite: process.versions.sqlite, result: 'pass' })
  )
}
