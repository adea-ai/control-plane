import { describe, expect, test } from 'bun:test'
import {
  createPostgresConnection,
  createPostgresMigrationConnection,
  DatabaseConnectionError,
  maximumConnectionsPerProcess,
  maximumIdleTimeoutSeconds,
  resolvePostgresClientOptions,
} from './connection.ts'

// Synthetic shared Railway PostgreSQL target: one endpoint and the repository
// logical database. No live host is contacted by these tests.
const applicationUrl =
  'postgresql://control_plane_app:private-password@control-plane-db.railway.internal:5432/control_plane?sslmode=verify-full'

function expectDiagnostic(operation, code) {
  try {
    operation()
    throw new Error('Expected the operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConnectionError)
    expect(error.diagnostic).toEqual({ code })
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
            url: 'postgresql://control_plane_app:private-password@127.0.0.1:1/control_plane',
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
          url: 'postgresql://control_plane_migrator:private-password@control-plane-db.railway.internal/control_plane',
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
            url: 'postgresql://control_plane_migrator:private-password@127.0.0.1:1/control_plane',
          },
          { maxConnections: maximumConnectionsPerProcess + 1 }
        ),
      'INVALID_POOL_BUDGET'
    )
  })
})
