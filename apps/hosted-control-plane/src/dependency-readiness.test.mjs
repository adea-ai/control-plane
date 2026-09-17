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
    expect(await hostedDependencyReadiness(surface, { databaseTimeoutMs: 25 })).toBe(false)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20)
  })
})
