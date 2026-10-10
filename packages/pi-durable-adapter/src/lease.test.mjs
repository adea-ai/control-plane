import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSessionLease } from './lease.ts'

test('a live process cannot have two owners for one Pi session store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lease-'))
  try {
    const first = new NodeSessionLease(directory, 'session')
    expect(() => new NodeSessionLease(directory, 'session')).toThrow('PI_SESSION_OWNER_ACTIVE')
    first.release()
    const second = new NodeSessionLease(directory, 'session')
    first.release()
    expect(() => new NodeSessionLease(directory, 'session')).toThrow('PI_SESSION_OWNER_ACTIVE')
    second.release()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
