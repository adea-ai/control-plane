import { describe, expect, test } from 'bun:test'
import {
  createPostgresConnection,
  createPostgresMigrationConnection,
  createReadinessBudget,
  DatabaseConnectionError,
  evaluateWithinReadinessBudget,
  maximumConnectionsPerProcess,
  maximumIdleTimeoutSeconds,
  resolvePostgresClientOptions,
  teardownPostgresPool,
} from './connection.ts'

// Synthetic shared Railway PostgreSQL target: one endpoint and the repository
// logical database. No live host is contacted by these tests.
const applicationUrl =
  'postgresql://control_plane_app:synthetic-test-password@control-plane-db.railway.internal:5432/control_plane?sslmode=verify-full'

function expectDiagnostic(operation, code) {
  try {
    operation()
    throw new Error('Expected the operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConnectionError)
    expect(error.diagnostic).toEqual({ code })
    expect(JSON.stringify(error)).not.toContain('synthetic-test-password')
    expect(JSON.stringify(error)).not.toContain('private-password')
    expect(JSON.stringify(error)).not.toContain('postgresql://')
  }
}

describe('resolvePostgresClientOptions', () => {
  test('bounds the per-process connection pool with conservative defaults', () => {
    expect(resolvePostgresClientOptions(applicationUrl)).toEqual({
      max: 10,
      idle_timeout: 20,
      prepare: false,
      ssl: 'verify-full',
    })
    expect(
      resolvePostgresClientOptions(applicationUrl, { maxConnections: 1, idleTimeoutSeconds: 5 })
    ).toEqual({ max: 1, idle_timeout: 5, prepare: false, ssl: 'verify-full' })
    expect(
      resolvePostgresClientOptions(applicationUrl, {
        maxConnections: maximumConnectionsPerProcess,
        idleTimeoutSeconds: maximumIdleTimeoutSeconds,
      })
    ).toMatchObject({ max: maximumConnectionsPerProcess, idle_timeout: maximumIdleTimeoutSeconds })
  })

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maximumConnectionsPerProcess + 1])(
    'rejects an out-of-bounds connection budget: %p',
    (maxConnections) => {
      expectDiagnostic(
        () => resolvePostgresClientOptions(applicationUrl, { maxConnections }),
        'INVALID_POOL_BUDGET'
      )
    }
  )

  test.each([0, -1, 1.5, Number.NaN, maximumIdleTimeoutSeconds + 1])(
    'rejects an out-of-bounds idle timeout: %p',
    (idleTimeoutSeconds) => {
      expectDiagnostic(
        () => resolvePostgresClientOptions(applicationUrl, { idleTimeoutSeconds }),
        'INVALID_IDLE_TIMEOUT'
      )
    }
  )

  test('preserves strict TLS certificate and hostname verification from the URL', () => {
    expect(resolvePostgresClientOptions(applicationUrl).ssl).toBe('verify-full')
    expect(
      resolvePostgresClientOptions(applicationUrl.replace('verify-full', 'verify-ca')).ssl
    ).toBe('verify-full')
    expect(resolvePostgresClientOptions(applicationUrl.replace('verify-full', 'require')).ssl).toBe(
      'require'
    )
  })

  test('does not let sslmode=require suppress sslrootcert=system verification', () => {
    const requireUrl = applicationUrl.replace('verify-full', 'require')
    expect(resolvePostgresClientOptions(requireUrl).ssl).toBe('require')
    expect(resolvePostgresClientOptions(`${requireUrl}&sslrootcert=system`).ssl).toBe('verify-full')
    expect(
      resolvePostgresClientOptions(
        `${applicationUrl.replace('?sslmode=verify-full', '')}?sslrootcert=system`
      ).ssl
    ).toBe('verify-full')
    // A non-verifying mode still fails closed even with the system trust root.
    expectDiagnostic(
      () =>
        resolvePostgresClientOptions(
          `${applicationUrl.replace('verify-full', 'disable')}&sslrootcert=system`
        ),
      'INVALID_DATABASE_TLS'
    )
  })

  test('fails closed on an unknown sslmode even with the system trust root', () => {
    for (const mode of ['bogus', 'verify-none']) {
      expectDiagnostic(
        () =>
          resolvePostgresClientOptions(
            `${applicationUrl.replace('verify-full', mode)}&sslrootcert=system`
          ),
        'INVALID_DATABASE_TLS'
      )
    }
  })

  test('accepts a repeated system trust root as one verified connection', () => {
    expect(
      resolvePostgresClientOptions(`${applicationUrl}&sslrootcert=system&sslrootcert=system`).ssl
    ).toBe('verify-full')
  })

  test('does not enable TLS when the URL does not request it', () => {
    expect(
      resolvePostgresClientOptions(applicationUrl.replace('?sslmode=verify-full', ''))
    ).not.toHaveProperty('ssl')
  })

  test.each(['disable', 'allow', 'prefer', 'unsupported'])(
    'fails closed on an unverified TLS mode: %s',
    (sslMode) => {
      expectDiagnostic(
        () => resolvePostgresClientOptions(applicationUrl.replace('verify-full', sslMode)),
        'INVALID_DATABASE_TLS'
      )
    }
  )

  test('fails closed on a conflicting or repeated TLS mode', () => {
    expectDiagnostic(
      () => resolvePostgresClientOptions(`${applicationUrl}&sslmode=require`),
      'INVALID_DATABASE_TLS'
    )
  })

  test('rejects a non-PostgreSQL URL before resolving pool options', () => {
    expectDiagnostic(
      () =>
        resolvePostgresClientOptions('mysql://control_plane_app:private-password@db/control_plane'),
      'INVALID_DATABASE_URL'
    )
  })

  test('validates the pool budget before opening a client', () => {
    expectDiagnostic(
      () =>
        createPostgresConnection(
          {
            role: 'application',
            url: 'postgresql://control_plane_app:synthetic-test-password@127.0.0.1:1/control_plane',
          },
          { maxConnections: 0 }
        ),
      'INVALID_POOL_BUDGET'
    )
  })
})

describe('createPostgresConnection', () => {
  test('keeps the application credential role required', () => {
    expectDiagnostic(
      () =>
        createPostgresConnection({
          role: 'migration',
          url: 'postgresql://control_plane_migrator:synthetic-test-password@control-plane-db.railway.internal/control_plane',
        }),
      'INVALID_CREDENTIAL_ROLE'
    )
  })

  test('composes a bounded application connection without contacting the host', async () => {
    const connection = createPostgresConnection(
      { role: 'application', url: applicationUrl },
      { maxConnections: 4 }
    )
    try {
      expect(connection.database).toBeDefined()
      expect(typeof connection.check).toBe('function')
    } finally {
      await connection.close()
    }
  })

  test('applies the same budget to the migration connection path', async () => {
    expectDiagnostic(
      () =>
        createPostgresMigrationConnection(
          {
            role: 'migration',
            url: 'postgresql://control_plane_migrator:synthetic-test-password@127.0.0.1:1/control_plane',
          },
          { maxConnections: maximumConnectionsPerProcess + 1 }
        ),
      'INVALID_POOL_BUDGET'
    )
  })
})

describe('the shared readiness budget', () => {
  test('bounds the steps it evaluates and fails closed when it expires', async () => {
    const startedAt = Date.now()
    const outcome = await evaluateWithinReadinessBudget(() => new Promise(() => {}), 30)
    expect(outcome.completed).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  test('reports the value of a budget that completes', async () => {
    const outcome = await evaluateWithinReadinessBudget(async () => 'ready', 1000)
    expect(outcome).toEqual({ completed: true, value: 'ready' })
  })

  test('fails closed when a step rejects', async () => {
    const outcome = await evaluateWithinReadinessBudget(async () => {
      throw new Error('the manifest could not be read')
    }, 1000)
    expect(outcome.completed).toBe(false)
  })

  test('the budget reports the time that is left', async () => {
    const budget = createReadinessBudget(1000)
    expect(budget.remainingMs()).toBeGreaterThan(0)
    expect(budget.remainingMs()).toBeLessThanOrEqual(1000)
    expect(budget.expired()).toBe(false)
  })

  test('a step that settles after the budget does not surface on its own', async () => {
    const unhandled = []
    const onUnhandled = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const outcome = await evaluateWithinReadinessBudget(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('the step failed late')), 60)
          }),
        20
      )
      expect(outcome.completed).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('the pool teardown', () => {
  test('a graceful close releases the pool', async () => {
    let ended = false
    const outcome = await teardownPostgresPool(
      {
        async end() {
          ended = true
        },
      },
      { timeoutSeconds: 1 }
    )
    expect(ended).toBe(true)
    expect(outcome.released).toBe(true)
  })

  test('a forced pool-end timeout releases the pool without an unhandled rejection', async () => {
    // The driver drains the pool, and a pool that does not drain within its
    // timeout is terminated: the driver rejects the pending queries and
    // resolves its end promise. That resolution is awaited, so the release is
    // proven, and it is not an unhandled rejection.
    const unhandled = []
    const onUnhandled = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const outcome = await teardownPostgresPool(
        {
          end: async () =>
            new Promise((resolve) => {
              setTimeout(resolve, 40)
            }),
        },
        { timeoutSeconds: 1, boundSeconds: 5 }
      )
      expect(outcome.released).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('a teardown that does not settle is reported instead of hanging', async () => {
    const startedAt = Date.now()
    const outcome = await teardownPostgresPool(
      { end: () => new Promise(() => {}) },
      {
        timeoutSeconds: 1,
        boundSeconds: 1,
      }
    )
    expect(outcome.released).toBe(false)
    expect(outcome.reason).toBeDefined()
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  test('a failing teardown is reported and does not mask the original failure', async () => {
    const outcome = await teardownPostgresPool(
      {
        async end() {
          throw new Error('the pool could not be ended')
        },
      },
      { timeoutSeconds: 1 }
    )
    expect(outcome.released).toBe(false)
    expect(outcome.reason).toContain('the pool could not be ended')
  })

  test('the connection close releases the pool and never throws over the original failure', async () => {
    const connection = createPostgresConnection({ role: 'application', url: applicationUrl })
    const original = new Error('the original failure')
    let thrown
    try {
      try {
        throw original
      } finally {
        await connection.close()
      }
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(original)
  })
})

describe('the qualified Postgres TLS behaviour', () => {
  test('a bare sslmode=require asks the driver for encryption without certificate verification', () => {
    // postgres 3.4.9 maps the driver option `require` to rejectUnauthorized
    // false, so the connection is encrypted and the certificate is not
    // verified. The strict certificate and hostname verification is carried by
    // the modes that ask for it.
    const requireUrl = applicationUrl.replace('verify-full', 'require')
    expect(resolvePostgresClientOptions(requireUrl).ssl).toBe('require')
    expect(resolvePostgresClientOptions(applicationUrl).ssl).toBe('verify-full')
    expect(
      resolvePostgresClientOptions(applicationUrl.replace('verify-full', 'verify-ca')).ssl
    ).toBe('verify-full')
  })

  test('the strict certificate and hostname verification is never downgraded', () => {
    for (const url of [
      applicationUrl,
      applicationUrl.replace('verify-full', 'verify-ca'),
      `${applicationUrl.replace('verify-full', 'require')}&sslrootcert=system`,
      `${applicationUrl.replace('?sslmode=verify-full', '')}?sslrootcert=system`,
    ]) {
      expect(resolvePostgresClientOptions(url).ssl).toBe('verify-full')
    }
  })

  test('the permitted local disposable-test behaviour is preserved', () => {
    // The local disposable test target asks for no TLS, and that is the only
    // shape that carries none.
    const localUrl =
      'postgresql://control_plane_app:local-application-only@127.0.0.1:54329/control_plane'
    expect(resolvePostgresClientOptions(localUrl)).not.toHaveProperty('ssl')
  })
})
