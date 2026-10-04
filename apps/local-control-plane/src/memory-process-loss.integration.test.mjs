import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  disposeMemoryRootProcessLoss,
  exerciseMemoryRootProcessLoss,
} from '../../../tests/fixtures/memory-root-process-loss.mjs'

for (const failure of ['persistence', 'connection']) {
  test(`memory process fixture removes its directory when ${failure} close fails`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-m11-memory-loss-'))
    const closed = []
    const close = (storage) => () => {
      closed.push(storage)
      if (storage === failure) throw new Error('synthetic storage close failure')
    }
    try {
      await expect(
        disposeMemoryRootProcessLoss({
          directory,
          profile: 'cleanup-regression',
          root: {
            persistence: { close: close('persistence') },
            connection: { close: close('connection') },
          },
        })
      ).rejects.toThrow('synthetic storage close failure')
      expect(existsSync(directory)).toBe(false)
      expect(closed).toEqual(['persistence', 'connection'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const profile of ['local', 'hosted-simple']) {
  test(`${profile} recovers a memory effect after SIGKILL with durable committing intent`, async () => {
    expect(await exerciseMemoryRootProcessLoss(profile)).toEqual({
      profile,
      signal: 'SIGKILL',
      persistedState: 'committing',
      recoveredState: 'committed',
      writeCalls: 1,
      statusCalls: 1,
      records: 1,
      operations: ['status'],
      fixtureRemoved: true,
      childReaped: true,
    })
  }, 12_000)
}
