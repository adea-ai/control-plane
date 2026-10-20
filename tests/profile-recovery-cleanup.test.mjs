// Portable qualification of the published #1048 cleanup helper, independent of legacy profiles.
import { expect, test } from 'bun:test'
import { cleanupTemporaryCompositions } from './fixtures/profile-recovery-cleanup.mjs'

test('every owned composition closes before any removable directory is removed', async () => {
  const events = []
  await cleanupTemporaryCompositions({
    ownedCompositions: [
      { composition: 'first', directory: 'first-state' },
      { composition: 'second', directory: 'second-state' },
    ],
    directories: ['second-state', 'unopened-state', 'first-state'],
    disposeComposition: async (composition) => events.push(`close:${composition}`),
    removeDirectory: async (directory) => events.push(`remove:${directory}`),
  })
  expect(events).toEqual([
    'close:first',
    'close:second',
    'remove:second-state',
    'remove:unopened-state',
    'remove:first-state',
  ])
})

test('a failed close preserves its state while later closes and independent removals continue', async () => {
  const closeFailure = new Error('close unconfirmed')
  const events = []
  const failure = await cleanupTemporaryCompositions({
    ownedCompositions: [
      { composition: 'first', directory: 'preserved-state' },
      { composition: 'second', directory: 'removable-state' },
    ],
    directories: ['preserved-state', 'removable-state'],
    disposeComposition: async (composition) => {
      events.push(`close:${composition}`)
      if (composition === 'first') throw closeFailure
    },
    removeDirectory: async (directory) => events.push(`remove:${directory}`),
  }).catch((error) => error)
  expect(events).toEqual(['close:first', 'close:second', 'remove:removable-state'])
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause).toBe(closeFailure)
  expect(failure.errors).toHaveLength(2)
  expect(failure.errors[0]).toBe(closeFailure)
  expect(failure.errors[1].message).toBe(
    'temporary state preserved until close is confirmed: preserved-state'
  )
})

test('one unconfirmed owner preserves a directory shared with a successfully closed owner', async () => {
  const closed = []
  const removed = []
  const failure = await cleanupTemporaryCompositions({
    ownedCompositions: [
      { composition: 'unconfirmed', directory: 'shared-state' },
      { composition: 'confirmed', directory: 'shared-state' },
    ],
    directories: ['shared-state', 'shared-state'],
    disposeComposition: async (composition) => {
      closed.push(composition)
      if (composition === 'unconfirmed') throw new Error('still open')
    },
    removeDirectory: async (directory) => removed.push(directory),
  }).catch((error) => error)
  expect(closed).toEqual(['unconfirmed', 'confirmed'])
  expect(removed).toEqual([])
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toHaveLength(2)
})

test('removal failures retain all diagnostics and never skip another owned directory', async () => {
  const first = new Error('first removal failed')
  const second = new Error('second removal failed')
  const removed = []
  const failure = await cleanupTemporaryCompositions({
    ownedCompositions: [],
    directories: ['first', 'second', 'third'],
    disposeComposition: async () => {
      throw new Error('no composition should be disposed')
    },
    removeDirectory: async (directory) => {
      removed.push(directory)
      if (directory === 'first') throw first
      if (directory === 'second') throw second
    },
  }).catch((error) => error)
  expect(removed).toEqual(['first', 'second', 'third'])
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause).toBe(first)
  expect(failure.errors).toEqual([first, second])
})
