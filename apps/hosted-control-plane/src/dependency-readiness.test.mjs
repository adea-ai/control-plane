import { describe, expect, test } from 'bun:test'
import { hostedDependencyReadiness } from './dependency-readiness.ts'

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
