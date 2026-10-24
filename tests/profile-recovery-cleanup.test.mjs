// Portable qualification of the published #1048 cleanup helper, independent of legacy profiles.
import { expect, test } from 'bun:test'
import { cleanupTemporaryCompositions } from './fixtures/profile-recovery-cleanup.mjs'
import { cleanupChildHost } from './fixtures/pi-durable-child-host-cleanup.mjs'

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

const childHostSteps = ['runtime', 'server', 'canonical', 'provider']

for (const failedStep of childHostSteps)
  for (const mode of ['synchronous', 'asynchronous'])
    test(`child host cleanup attempts every close and preserves shared state after ${mode} ${failedStep} failure`, async () => {
      const closeFailure = new Error(`${mode} ${failedStep} close failed`)
      const events = []
      const failure = await cleanupChildHost({
        directory: 'shared-child-host-state',
        ownedWork: [],
        closeSteps: childHostSteps.map((step) => () => {
          events.push(`close:${step}`)
          if (step === failedStep) {
            if (mode === 'synchronous') throw closeFailure
            return Promise.reject(closeFailure)
          }
        }),
        removeDirectory: async (directory) => events.push(`remove:${directory}`),
      }).catch((error) => error)
      expect(events).toEqual(childHostSteps.map((step) => `close:${step}`))
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.cause).toBe(closeFailure)
      expect(failure.errors).toHaveLength(2)
      expect(failure.errors[0]).toBe(closeFailure)
      expect(failure.errors[1].message).toBe(
        'temporary state preserved until close is confirmed: shared-child-host-state'
      )
    })

test('child host cleanup retains multiple close failures in order and never removes their shared directory', async () => {
  const first = new Error('runtime close failed')
  const second = new Error('canonical close failed')
  const events = []
  const failure = await cleanupChildHost({
    directory: 'shared-state',
    ownedWork: [],
    closeSteps: [
      () => {
        events.push('runtime')
        throw first
      },
      () => events.push('server'),
      () => {
        events.push('canonical')
        throw second
      },
      () => events.push('provider'),
    ],
    removeDirectory: async () => events.push('remove'),
  }).catch((error) => error)
  expect(events).toEqual(['runtime', 'server', 'canonical', 'provider'])
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors.slice(0, 2)).toEqual([first, second])
  expect(failure.errors).toHaveLength(3)
})

test('child host cleanup awaits settled work, attempts optional resources and closes in order before removal', async () => {
  const events = []
  const absent = undefined
  const workFailure = new Error('already observed operation failure')
  await cleanupChildHost({
    directory: 'shared-state',
    ownedWork: [
      Promise.resolve().then(() => events.push('work:fulfilled')),
      Promise.reject(workFailure),
    ],
    closeSteps: [
      () => {
        events.push('close:absent')
        return absent?.close()
      },
      ...childHostSteps.map((step) => async () => events.push(`close:${step}`)),
    ],
    removeDirectory: async (directory) => events.push(`remove:${directory}`),
  })
  expect(events).toEqual([
    'work:fulfilled',
    'close:absent',
    ...childHostSteps.map((step) => `close:${step}`),
    'remove:shared-state',
  ])
})

test('child host cleanup waits for every actual owned operation before closing or removing state', async () => {
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  const events = []
  const observedFirst = first.promise.then(() => events.push('work:first'))
  const cleanup = cleanupChildHost({
    directory: 'held-work-state',
    ownedWork: [observedFirst, second.promise],
    closeSteps: [() => events.push('close:first'), () => events.push('close:second')],
    removeDirectory: async () => events.push('remove'),
  })
  const outcome = cleanup.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await Promise.resolve()
    expect(events).toEqual([])
    first.resolve()
    await observedFirst
    expect(events).toEqual(['work:first'])
  } finally {
    first.resolve()
    second.resolve()
    await outcome
  }
  expect((await outcome).error).toBeUndefined()
  expect(events).toEqual(['work:first', 'close:first', 'close:second', 'remove'])
})

test('child host cleanup does not advance past a held close or remove its directory early', async () => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const events = []
  const cleanup = cleanupChildHost({
    directory: 'held-close-state',
    ownedWork: [],
    closeSteps: [
      async () => {
        events.push('close:first:start')
        entered.resolve()
        await release.promise
        events.push('close:first:end')
      },
      () => events.push('close:second'),
    ],
    removeDirectory: async () => events.push('remove'),
  })
  const outcome = cleanup.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await entered.promise
    expect(events).toEqual(['close:first:start'])
  } finally {
    release.resolve()
    await outcome
  }
  expect((await outcome).error).toBeUndefined()
  expect(events).toEqual(['close:first:start', 'close:first:end', 'close:second', 'remove'])
})

test('child host cleanup preserves the primary failure alongside all close failures', async () => {
  const primary = new Error('original child host assertion failed')
  const first = new Error('runtime close failed')
  const second = new Error('provider close failed')
  const failure = await cleanupChildHost({
    directory: 'failed-host-state',
    ownedWork: [],
    primaryFailure: primary,
    closeSteps: [
      () => {
        throw first
      },
      async () => {
        throw second
      },
    ],
    removeDirectory: async () => {
      throw new Error('must not remove unconfirmed state')
    },
  }).catch((error) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause).toBeInstanceOf(AggregateError)
  expect(failure.cause.errors.slice(0, 2)).toEqual([first, second])
  expect(failure.errors.slice(0, 3)).toEqual([primary, first, second])
  expect(failure.errors).toHaveLength(4)
})

test('child host cleanup aggregates removal failure with the original primary error after all closes', async () => {
  const primary = new Error('original work failed')
  const removal = new Error('remove failed')
  const events = []
  const failure = await cleanupChildHost({
    directory: 'closed-host-state',
    ownedWork: [],
    primaryFailure: primary,
    closeSteps: childHostSteps.map((step) => () => events.push(step)),
    removeDirectory: async () => {
      events.push('remove')
      throw removal
    },
  }).catch((error) => error)
  expect(events).toEqual([...childHostSteps, 'remove'])
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause).toBeInstanceOf(AggregateError)
  expect(failure.cause.errors).toEqual([removal])
  expect(failure.errors).toEqual([primary, removal])
})

test('successful child host cleanup lets the callsite rethrow its exact primary failure', async () => {
  const primary = new Error('original child host error')
  const events = []
  let primaryFailure
  const failure = await (async () => {
    try {
      throw primary
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await cleanupChildHost({
        directory: 'closed-host-state',
        ownedWork: [],
        primaryFailure,
        closeSteps: [() => events.push('close')],
        removeDirectory: async () => events.push('remove'),
      })
    }
  })().catch((error) => error)
  expect(failure).toBe(primary)
  expect(events).toEqual(['close', 'remove'])
})
