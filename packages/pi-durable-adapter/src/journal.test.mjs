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

test('interaction transition checks the full snapshot and atomically commits epoch and cursor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-journal-interaction-'))
  const path = join(directory, 'journal.sqlite')
  const first = new SqliteDurableJournal(path)
  const second = new SqliteDurableJournal(path)
  try {
    const admission = first.admit({
      handleId: 'handle',
      attemptId: 'attempt',
      startKey: 'key',
      admission: { opaque: true },
      at: '2026-10-08T00:00:00.000Z',
    })
    const completed = first.update('handle', admission.epoch, {
      state: 'completed',
      detail: { inferencePending: false },
    })
    const events = first.events('handle', 0)
    const closed = second.update('handle', completed.epoch, {
      detail: { ...completed.detail, sessionClosed: true },
    })
    let guarded = false
    expect(() =>
      first.transition(completed, () => {
        guarded = true
        return { change: { state: 'awaiting_input' } }
      })
    ).toThrow('STALE_STATE')
    expect(guarded).toBe(false)
    expect(first.get('handle')).toEqual(closed)
    expect(first.events('handle', 0)).toEqual(events)
    expect(() =>
      first.transition(closed, () => {
        throw new Error('GUARD_DENIED')
      })
    ).toThrow('GUARD_DENIED')
    expect(first.get('handle')).toEqual(closed)
    const open = second.update('handle', closed.epoch, { detail: { inferencePending: false } })
    const next = first.transition(open, (current) => ({
      change: { state: 'awaiting_input', detail: { ...current.detail, pendingInput: 'exact' } },
      event: {
        type: 'interaction',
        data: { interactionId: 'exact', kind: 'input' },
        at: admission.at,
      },
    }))
    expect(next.epoch).toBe(open.epoch + 1)
    expect(second.get('handle')).toEqual(next)
    expect(second.events('handle', 0)).toHaveLength(events.length + 1)
    expect(second.transition(next, () => undefined)).toEqual(next)
    expect(first.events('handle', 0)).toHaveLength(events.length + 1)
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
