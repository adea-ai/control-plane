import { describe, expect, test } from 'bun:test'
import { ConfigurationError } from './service.ts'
import {
  databaseSessionCredentials,
  effectivePostgresTlsMode,
  loadDatabaseSessionCredentials,
} from './database.ts'

// Synthetic shared Railway PostgreSQL target: one endpoint, the repository
// logical database, and the three separated principals. No live host is used.
const railwayHost = 'control-plane-db.railway.internal'
const application = {
  role: 'application',
  url: `postgresql://control_plane_app:synthetic-test-password@${railwayHost}:5432/control_plane?sslmode=verify-full`,
}

// A pooled route follows the common `<endpoint>-pooler` label convention. The
// qualification must reject it without trusting a provider hostname suffix.
const pooledNeon = {
  role: 'application',
  url: 'postgresql://control_plane_app:synthetic-test-password@ep-example-pooler.c-5.us-east-2.aws.neon.tech/control_plane?sslmode=verify-full',
}
const directNeon = pooledNeon.url.replace('-pooler.', '.')

function expectConfigurationFailure(operation, missing = [], invalid = []) {
  expect(operation).toThrow(ConfigurationError)
  try {
    operation()
  } catch (error) {
    expect(error.diagnostic).toEqual({
      code: 'INVALID_DATABASE_CONFIGURATION',
      invalid,
      missing,
      role: 'application',
    })
    expect(JSON.stringify(error)).not.toContain('synthetic-test-password')
    expect(JSON.stringify(error)).not.toContain('private-password')
    expect(JSON.stringify(error)).not.toContain('postgresql://')
  }
}

describe('application database session credentials', () => {
  test('preserves a single direct Railway application endpoint without additional configuration', () => {
    expect(databaseSessionCredentials(application)).toEqual(application)
    expect(loadDatabaseSessionCredentials({ DATABASE_URL: application.url })).toEqual(application)
  })

  test('requires an explicit direct endpoint for any pooled route, regardless of provider', () => {
    for (const url of [
      'postgresql://control_plane_app:synthetic-test-password@db-pooler.example.test/control_plane?sslmode=require',
      'postgresql://control_plane_app:synthetic-test-password@ep-example-pooler.c-5.us-east-2.aws.neon.tech/control_plane?sslmode=require',
    ]) {
      expectConfigurationFailure(
        () => databaseSessionCredentials({ role: 'application', url }),
        ['DATABASE_URL_UNPOOLED']
      )
    }
  })

  test('uses the same application role and database on the derived direct route', () => {
    expect(databaseSessionCredentials(pooledNeon, directNeon)).toEqual({
      role: 'application',
      url: directNeon,
    })
    expect(
      loadDatabaseSessionCredentials({
        DATABASE_URL: pooledNeon.url,
        DATABASE_URL_UNPOOLED: directNeon,
      })
    ).toEqual({ role: 'application', url: directNeon })
  })

  test('supports an explicitly configured generic direct host with the application identity', () => {
    const pooled = {
      role: 'application',
      url: 'postgresql://control_plane_app:synthetic-test-password@pool.internal:6432/control_plane?sslmode=require',
    }
    const direct =
      'postgresql://control_plane_app:synthetic-test-password@database.internal:5432/control_plane?sslmode=require'
    expect(databaseSessionCredentials(pooled, direct)).toEqual({ role: 'application', url: direct })
  })

  test.each([
    ['missing direct connection', undefined],
    ['pooled session connection', pooledNeon.url],
    ['unrelated pooled endpoint', directNeon.replace('ep-example.', 'ep-other-pooler.')],
    ['other direct endpoint', directNeon.replace('ep-example.', 'ep-other.')],
    ['migration principal', directNeon.replace('control_plane_app:', 'control_plane_migrator:')],
    ['other database', directNeon.replace('/control_plane?', '/other?')],
    ['invalid URL', 'not-a-url'],
    ['empty explicit URL', ''],
  ])('rejects %s without exposing credentials', (_name, url) => {
    expectConfigurationFailure(
      () => databaseSessionCredentials(pooledNeon, url),
      url === undefined ? ['DATABASE_URL_UNPOOLED'] : [],
      url === undefined ? [] : ['DATABASE_URL_UNPOOLED']
    )
  })

  test('a pooled application endpoint only accepts its own derived direct route', () => {
    expectConfigurationFailure(
      () => databaseSessionCredentials(pooledNeon, directNeon.replace('ep-example.', 'ep-other.')),
      [],
      ['DATABASE_URL_UNPOOLED']
    )
    expect(databaseSessionCredentials(pooledNeon, directNeon)).toEqual({
      role: 'application',
      url: directNeon,
    })
    // A non-pooled application endpoint may supply an explicit generic session
    // host; the provider suffix is not trusted to infer one.
    expect(databaseSessionCredentials({ ...pooledNeon, url: directNeon }, directNeon)).toEqual({
      role: 'application',
      url: directNeon,
    })
  })

  test('preserves strict TLS certificate and hostname verification across the session endpoint', () => {
    const verified = {
      role: 'application',
      url: 'postgresql://control_plane_app:synthetic-test-password@pool.internal:6432/control_plane?sslmode=verify-full',
    }
    const direct =
      'postgresql://control_plane_app:synthetic-test-password@database.internal:5432/control_plane'
    // A session endpoint must not silently downgrade certificate verification.
    expectConfigurationFailure(
      () => databaseSessionCredentials(verified, `${direct}?sslmode=require`),
      [],
      ['DATABASE_URL_UNPOOLED']
    )
    expectConfigurationFailure(
      () => databaseSessionCredentials(verified, direct),
      [],
      ['DATABASE_URL_UNPOOLED']
    )
    // Verification at least as strict as the pooled endpoint remains accepted.
    expect(
      databaseSessionCredentials(
        { ...verified, url: `${verified.url.replace('verify-full', 'require')}` },
        `${direct}?sslmode=verify-full`
      )
    ).toEqual({ role: 'application', url: `${direct}?sslmode=verify-full` })
    expect(databaseSessionCredentials(verified, `${direct}?sslmode=verify-full`)).toEqual({
      role: 'application',
      url: `${direct}?sslmode=verify-full`,
    })
  })
})

describe('effective TLS across the session endpoint', () => {
  const base =
    'postgresql://control_plane_app:synthetic-test-password@database.internal:5432/control_plane'
  const pooled = (query) => ({
    role: 'application',
    url: `postgresql://control_plane_app:synthetic-test-password@pool.internal:6432/control_plane${query}`,
  })

  test('the system trust root escalates the application endpoint to verify-full', () => {
    // require plus the system root resolves to verify-full, so a require-only
    // session endpoint is a downgrade.
    expectConfigurationFailure(
      () =>
        databaseSessionCredentials(
          pooled('?sslmode=require&sslrootcert=system'),
          `${base}?sslmode=require`
        ),
      [],
      ['DATABASE_URL_UNPOOLED']
    )
    // The system root alone is verify-full, so a session endpoint with no TLS
    // at all is a downgrade.
    expectConfigurationFailure(
      () => databaseSessionCredentials(pooled('?sslrootcert=system'), base),
      [],
      ['DATABASE_URL_UNPOOLED']
    )
    expectConfigurationFailure(
      () => databaseSessionCredentials(pooled('?sslrootcert=system'), `${base}?sslmode=require`),
      [],
      ['DATABASE_URL_UNPOOLED']
    )
  })

  test('accepts every session endpoint that is effectively as strict', () => {
    const strictSessions = [
      `${base}?sslmode=verify-full`,
      `${base}?sslmode=verify-ca`,
      `${base}?sslrootcert=system`,
      `${base}?sslmode=require&sslrootcert=system`,
      `${base}?sslmode=verify-full&sslrootcert=system`,
    ]
    for (const query of [
      '?sslmode=require&sslrootcert=system',
      '?sslrootcert=system',
      '?sslmode=verify-full',
      '?sslmode=verify-ca',
    ]) {
      for (const url of strictSessions) {
        expect(databaseSessionCredentials(pooled(query), url)).toEqual({
          role: 'application',
          url,
        })
      }
    }
    // The system root on the session endpoint only strengthens it.
    expect(
      databaseSessionCredentials(pooled('?sslmode=require'), `${base}?sslrootcert=system`)
    ).toEqual({ role: 'application', url: `${base}?sslrootcert=system` })
  })

  test('treats verify-ca as the verify-full the driver connects with', () => {
    expect(
      databaseSessionCredentials(pooled('?sslmode=verify-full'), `${base}?sslmode=verify-ca`)
    ).toEqual({
      role: 'application',
      url: `${base}?sslmode=verify-ca`,
    })
    expect(
      databaseSessionCredentials(pooled('?sslmode=verify-ca'), `${base}?sslmode=verify-full`)
    ).toEqual({
      role: 'application',
      url: `${base}?sslmode=verify-full`,
    })
  })

  test.each([
    [
      'repeated sslmode on the session endpoint',
      '?sslmode=verify-full',
      '?sslmode=verify-full&sslmode=verify-full',
    ],
    [
      'repeated sslmode on the application endpoint',
      '?sslmode=require&sslmode=verify-full',
      '?sslmode=verify-full',
    ],
    ['unknown sslmode on the session endpoint', '?sslmode=require', '?sslmode=bogus'],
    ['unknown sslmode on the application endpoint', '?sslmode=bogus', '?sslmode=verify-full'],
    [
      'unknown sslmode paired with the system root',
      '?sslmode=require',
      '?sslmode=bogus&sslrootcert=system',
    ],
    ['unverified session mode', '?sslmode=require', '?sslmode=disable'],
    [
      'unverified mode paired with the system root',
      '?sslmode=require',
      '?sslmode=prefer&sslrootcert=system',
    ],
    ['unverified application mode', '?sslmode=allow', '?sslmode=verify-full'],
  ])('fails closed on %s', (_name, applicationQuery, sessionQuery) => {
    expectConfigurationFailure(
      () => databaseSessionCredentials(pooled(applicationQuery), `${base}${sessionQuery}`),
      [],
      ['DATABASE_URL_UNPOOLED']
    )
  })

  test('resolves one effective TLS mode shared with the connection resolver', () => {
    const cases = [
      ['', 'unset'],
      ['?sslmode=require', 'require'],
      ['?sslmode=verify-ca', 'verify-full'],
      ['?sslmode=verify-full', 'verify-full'],
      ['?sslrootcert=system', 'verify-full'],
      ['?sslmode=require&sslrootcert=system', 'verify-full'],
      ['?sslmode=verify-ca&sslrootcert=system', 'verify-full'],
      ['?sslrootcert=/etc/ca.pem', 'unset'],
      ['?sslmode=disable', undefined],
      ['?sslmode=allow', undefined],
      ['?sslmode=prefer', undefined],
      ['?sslmode=disable&sslrootcert=system', undefined],
      ['?sslmode=bogus&sslrootcert=system', undefined],
      ['?sslmode=require&sslmode=require', undefined],
    ]
    for (const [query, expected] of cases) {
      expect(effectivePostgresTlsMode(new URL(`${base}${query}`))).toBe(expected)
    }
  })
})
