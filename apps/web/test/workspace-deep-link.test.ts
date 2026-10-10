import { describe, expect, test } from 'bun:test'

import { createDeepLinkAttempts } from '../src/lib/workspace-deep-link'

/** A switch the test resolves by hand, so completion order is controlled. */
function controlledSwitches() {
  const calls: string[] = []
  const pending: { workspace: string; resolve(switched: boolean): void }[] = []
  return {
    calls,
    pending,
    switchTo(workspace: string) {
      calls.push(workspace)
      return new Promise<boolean>((resolve) => pending.push({ workspace, resolve }))
    },
  }
}

/** Lets queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The URL the harness reads: which workspace is requested, and whether it is scoped. */
type Url = { requested: string | undefined; scoped: boolean }

function harness(url: Url) {
  const switches = controlledSwitches()
  const consumed: string[] = []
  const attempts = createDeepLinkAttempts({
    consume: (workspace) => consumed.push(workspace),
    requested: () => url.requested,
    retain: () => url.scoped,
    switchTo: (workspace) => switches.switchTo(workspace),
  })
  return { attempts, consumed, switches }
}

describe('a delayed completion for a link the URL has moved past', () => {
  test('strips nothing and never settles the newer link', async () => {
    const url: Url = { requested: 'A', scoped: false }
    const { attempts, consumed, switches } = harness(url)

    attempts.start('A')
    url.requested = 'B'
    attempts.start('B')
    // A's completion arrives after the URL advanced to B.
    switches.pending[0]!.resolve(true)
    await settle()
    expect(consumed).toEqual([])

    switches.pending[1]!.resolve(true)
    await settle()
    expect(consumed).toEqual(['B'])
  })
})

describe('a scoped link', () => {
  test('keeps its workspace param while the destination is unconsumed', async () => {
    const url: Url = { requested: 'A', scoped: true }
    const { attempts, consumed, switches } = harness(url)

    attempts.start('A')
    switches.pending[0]!.resolve(true)
    await settle()
    expect(attempts.state('A')).toBe('settled')
    // The surface needs the param to apply the destination against the target.
    expect(consumed).toEqual([])

    // Re-runs never switch again, and the link is still not consumed.
    for (let index = 0; index < 20; index += 1) attempts.start('A')
    expect(switches.calls).toEqual(['A'])
    expect(consumed).toEqual([])
  })

  test('is released once the surface consumes it, and a later issue is a fresh attempt', async () => {
    const url: Url = { requested: 'A', scoped: true }
    const { attempts, consumed, switches } = harness(url)

    attempts.start('A')
    switches.pending[0]!.resolve(true)
    await settle()
    expect(consumed).toEqual([])

    // The surface applied the destination and stripped the whole link: release, then re-issue.
    attempts.release()
    url.requested = undefined
    url.requested = 'A'
    url.scoped = false
    attempts.start('A')
    expect(switches.calls).toEqual(['A', 'A'])
    switches.pending[1]!.resolve(true)
    await settle()
    expect(consumed).toEqual(['A'])
  })
})

describe('a failed switch', () => {
  test('is not retried on its own, and an explicit re-issue starts a fresh attempt', async () => {
    const url: Url = { requested: 'A', scoped: false }
    const { attempts, switches } = harness(url)

    attempts.start('A')
    switches.pending[0]!.resolve(false)
    await settle()
    expect(attempts.state('A')).toBe('failed')

    // Re-running the effect for the same link never switches again.
    for (let index = 0; index < 20; index += 1) attempts.start('A')
    expect(switches.calls).toEqual(['A'])

    // Removing the param releases the link; issuing it again is the explicit retry.
    attempts.release()
    url.requested = 'A'
    attempts.start('A')
    expect(switches.calls).toEqual(['A', 'A'])
    switches.pending[1]!.resolve(true)
    await settle()
    expect(attempts.state('A')).toBe('settled')
  })
})

describe('a settled unscoped link', () => {
  test('is consumed once and never re-switched while its param is still present', async () => {
    const url: Url = { requested: 'A', scoped: false }
    const { attempts, consumed, switches } = harness(url)

    attempts.start('A')
    switches.pending[0]!.resolve(true)
    await settle()
    expect(consumed).toEqual(['A'])

    for (let index = 0; index < 50; index += 1) attempts.start('A')
    expect(switches.calls).toEqual(['A'])
    expect(consumed).toEqual(['A'])
  })
})

describe('a same-ID revisit', () => {
  test('a stale completion from the earlier visit never settles or strips the new one', async () => {
    const url: Url = { requested: 'A', scoped: false }
    const { attempts, consumed, switches } = harness(url)

    // First visit: the switch is still in flight when the user navigates away.
    attempts.start('A')
    attempts.release()
    url.requested = undefined
    // Second visit to the same workspace ID.
    url.requested = 'A'
    attempts.start('A')
    expect(switches.calls).toEqual(['A', 'A'])
    expect(attempts.state('A')).toBe('switching')

    switches.pending[0]!.resolve(true)
    await settle()
    expect(consumed).toEqual([])
    expect(attempts.state('A')).toBe('switching')

    switches.pending[1]!.resolve(true)
    await settle()
    expect(consumed).toEqual(['A'])
  })

  test('a stale completion from an earlier scoped visit never strips a newer unscoped one', async () => {
    const url: Url = { requested: 'A', scoped: true }
    const { attempts, consumed, switches } = harness(url)

    attempts.start('A')
    attempts.release()
    url.requested = undefined
    url.requested = 'A'
    url.scoped = false
    attempts.start('A')

    switches.pending[0]!.resolve(true)
    await settle()
    expect(consumed).toEqual([])

    switches.pending[1]!.resolve(true)
    await settle()
    expect(consumed).toEqual(['A'])
  })
})
