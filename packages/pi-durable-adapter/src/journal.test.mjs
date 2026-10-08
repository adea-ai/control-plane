import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDurableJournal } from './journal.ts'

test('admission is immutable across SQLite reopen and previous owners are fenced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-journal-'))
  const path = join(directory, 'journal.sqlite')
  try {
    const first = new SqliteDurableJournal(path)
    const record = first.admit({
      handleId: 'handle',
      attemptId: 'attempt',
      startKey: 'key',
      admission: { selectionRef: 'opaque' },
      at: '2026-10-08T00:00:00.000Z',
    })
    const owner = first.claim('handle')
    first.update(
      'handle',
      owner,
      { state: 'running' },
      { type: 'status', data: { state: 'running' }, at: record.at }
    )
    const second = new SqliteDurableJournal(path)
    expect(
      second.admit({
        handleId: 'handle',
        attemptId: 'attempt',
        startKey: 'key',
        admission: { selectionRef: 'opaque' },
        at: record.at,
      })
    ).toEqual(first.get('handle'))
    expect(() =>
      second.admit({
        handleId: 'handle',
        attemptId: 'attempt',
        startKey: 'key',
        admission: { selectionRef: 'changed' },
        at: record.at,
      })
    ).toThrow('IDEMPOTENCY_CONFLICT')
    const next = second.claim('handle')
    expect(next).toBeGreaterThan(owner)
    expect(() => first.update('handle', owner, { state: 'completed' })).toThrow('STALE_OWNER')
    expect(second.events('handle', 1)).toHaveLength(1)
    first.close()
    second.close()
    const reopened = new SqliteDurableJournal(path)
    expect(reopened.get('handle').state).toBe('running')
    expect(reopened.events('handle', 0).map((e) => e.sequence)).toEqual([1, 2])
    reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a second dispatch key cannot give the same attempt another owner', () => {
  const journal = new SqliteDurableJournal(':memory:')
  const admission = { opaque: true }
  journal.admit({
    handleId: 'one',
    attemptId: 'attempt',
    startKey: 'one',
    admission,
    at: '2026-10-08T00:00:00.000Z',
  })
  expect(() =>
    journal.admit({
      handleId: 'two',
      attemptId: 'attempt',
      startKey: 'two',
      admission,
      at: '2026-10-08T00:00:00.000Z',
    })
  ).toThrow('ATTEMPT_CONFLICT')
  journal.close()
})
