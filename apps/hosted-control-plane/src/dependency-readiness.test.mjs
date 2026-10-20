import { describe, expect, test } from 'bun:test'
import { hostedDependencyReadiness } from './dependency-readiness.ts'

/** The per-call readiness budget of the single-flight regressions. */
const READINESS_BUDGET_MS = 5
/**
 * The gap between two timed-out calls. It is longer than the budget, so every
 * timer the evaluation armed has fired and every release microtask has run
 * before the next call starts.
 */
const INTER_CALL_GAP_MS = 10
const interCallGap = () => new Promise((resolve) => setTimeout(resolve, INTER_CALL_GAP_MS))

function compositionSurface({ componentReadiness = true, check = async () => undefined } = {}) {
  let databaseProbes = 0
  return {
    surface: {
      manifest: async () => ({
        components: [{ ready: componentReadiness }, { ready: componentReadiness }],
      }),
      connection: {
        check: async (...arguments_) => {
          databaseProbes += 1
          return check(...arguments_)
        },
      },
    },
    databaseProbes: () => databaseProbes,
  }
}

describe('Hosted dependency readiness', () => {
  test('reports ready when every manifest component and the database are ready', async () => {
    const { surface } = compositionSurface()
    expect(await hostedDependencyReadiness(surface)).toBe(true)
  })

  test('fails closed without probing the database when a manifest component is down', async () => {
    const { surface, databaseProbes } = compositionSurface({ componentReadiness: false })
    expect(await hostedDependencyReadiness(surface)).toBe(false)
    expect(databaseProbes()).toBe(0)
  })

  test('reports not ready when the database probe rejects', async () => {
    const { surface } = compositionSurface({
      check: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(await hostedDependencyReadiness(surface)).toBe(false)
  })

  test('reports not ready when the database probe exceeds the readiness budget', async () => {
    const { surface } = compositionSurface({ check: () => new Promise(() => {}) })
    const startedAt = Date.now()
    expect(await hostedDependencyReadiness(surface, { readinessTimeoutMs: 25 })).toBe(false)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20)
  })

  test('a manifest that never settles cannot hang the readiness endpoint', async () => {
    // The manifest used to be awaited without a bound, so a manifest that never
    // settled held the readiness endpoint open indefinitely.
    const surface = {
      manifest: () => new Promise(() => {}),
      connection: { check: async () => undefined },
    }
    const startedAt = Date.now()
    expect(await hostedDependencyReadiness(surface, { readinessTimeoutMs: 30 })).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  test('a manifest that rejects fails closed', async () => {
    const surface = {
      manifest: async () => {
        throw new Error('the manifest could not be read')
      },
      connection: { check: async () => undefined },
    }
    expect(await hostedDependencyReadiness(surface)).toBe(false)
  })

  test('the manifest and the probe share one budget', async () => {
    // A manifest that consumes most of the budget leaves the probe only what is
    // left, so the two steps cannot add up to more than the caller allowed.
    const { surface, databaseProbes } = compositionSurface({
      check: () => new Promise(() => {}),
    })
    const slowManifest = {
      manifest: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return { components: [{ ready: true }] }
      },
      connection: surface.connection,
    }
    const startedAt = Date.now()
    expect(await hostedDependencyReadiness(slowManifest, { readinessTimeoutMs: 60 })).toBe(false)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(2000)
    expect(databaseProbes()).toBe(1)
  })

  test('a manifest that arrives after the budget starts no probe', async () => {
    // The manifest used to be awaited without a bound, and a manifest that
    // arrived after the budget had expired still continued and started a
    // fresh probe with no time left.
    let databaseProbes = 0
    const surface = {
      manifest: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return { components: [{ ready: true }] }
      },
      connection: {
        check: async () => {
          databaseProbes += 1
        },
      },
    }
    expect(await hostedDependencyReadiness(surface, { readinessTimeoutMs: 20 })).toBe(false)
    // The expired manifest must not have started a probe.
    expect(databaseProbes).toBe(0)
  })

  test('repeated calls do not accumulate probes for one surface', async () => {
    let manifests = 0
    let databaseProbes = 0
    const surface = {
      manifest: async () => {
        manifests += 1
        await new Promise((resolve) => setTimeout(resolve, 40))
        return { components: [{ ready: true }] }
      },
      connection: {
        check: async () => {
          databaseProbes += 1
          await new Promise((resolve) => setTimeout(resolve, 40))
        },
      },
    }
    const first = hostedDependencyReadiness(surface, { readinessTimeoutMs: 500 })
    const second = hostedDependencyReadiness(surface, { readinessTimeoutMs: 500 })
    expect(await second).toBe(false)
    await first
    // The surface owns one connection, so only one manifest and one probe ran.
    expect(manifests).toBe(1)
    expect(databaseProbes).toBeLessThanOrEqual(1)
  })

  test('sequential calls after a timeout do not start another unresolved manifest', async () => {
    // The ownership used to be released when the response budget expired, while
    // the raw manifest was still pending, so three sequential calls produced
    // three unresolved manifests.
    let manifests = 0
    const surface = {
      manifest: () => {
        manifests += 1
        return new Promise(() => {})
      },
      connection: { check: async () => undefined },
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await hostedDependencyReadiness(surface, { readinessTimeoutMs: READINESS_BUDGET_MS })
      ).toBe(false)
      await interCallGap()
    }
    // One manifest is pending; the later calls started no work.
    expect(manifests).toBe(1)
  })

  test('sequential calls after a timeout do not start another unresolved check', async () => {
    // The manifest answers immediately and the check never settles. The
    // ownership used to be released when the probe's timeout wrapper settled,
    // not when the raw check settled, so three calls separated by a gap each
    // started another check while the first was still pending.
    let manifests = 0
    let checks = 0
    let checkSettled = false
    // A controlled deferred that is never settled: the raw check stays
    // unresolved for the whole regression.
    const pendingCheck = new Promise(() => {})
    void pendingCheck.then(() => {
      checkSettled = true
    })
    const surface = {
      manifest: async () => {
        manifests += 1
        return { components: [{ ready: true }] }
      },
      connection: {
        check: () => {
          checks += 1
          return pendingCheck
        },
      },
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await hostedDependencyReadiness(surface, { readinessTimeoutMs: READINESS_BUDGET_MS })
      ).toBe(false)
      // The gap lets the probe's timeout wrapper settle and the release
      // microtask run, so a released ownership would show here.
      await interCallGap()
    }
    expect(manifests).toBe(1)
    // Exactly one raw check, and it is still unresolved.
    expect(checks).toBe(1)
    expect(checkSettled).toBe(false)
  })

  test('a settled raw check releases the single-flight ownership', async () => {
    // The ownership is held until the raw check settles, so a surface whose
    // check completed becomes usable again.
    let checks = 0
    let releaseCheck
    const surface = {
      manifest: async () => ({ components: [{ ready: true }] }),
      connection: {
        check: () => {
          checks += 1
          return new Promise((resolve) => {
            releaseCheck = resolve
          })
        },
      },
    }
    expect(
      await hostedDependencyReadiness(surface, { readinessTimeoutMs: READINESS_BUDGET_MS })
    ).toBe(false)
    await interCallGap()
    // The raw check is still pending, so the surface stays single-flight.
    expect(
      await hostedDependencyReadiness(surface, { readinessTimeoutMs: READINESS_BUDGET_MS })
    ).toBe(false)
    expect(checks).toBe(1)
    // The raw check settles, so the ownership is released.
    releaseCheck()
    await interCallGap()
    expect(
      await hostedDependencyReadiness(surface, { readinessTimeoutMs: READINESS_BUDGET_MS })
    ).toBe(false)
    expect(checks).toBe(2)
  })

  test('a manifest that settles after the budget does not surface on its own', async () => {
    // The step is observed by the budget, so its late rejection is never an
    // unhandled rejection.
    const unhandled = []
    const onUnhandled = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const surface = {
        manifest: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('the manifest failed late')), 60)
          }),
        connection: { check: async () => undefined },
      }
      expect(await hostedDependencyReadiness(surface, { readinessTimeoutMs: 20 })).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
