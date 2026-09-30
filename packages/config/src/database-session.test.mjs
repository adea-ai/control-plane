import { describe, expect, test } from 'bun:test'
import { ConfigurationError } from './service.ts'
import { databaseSessionCredentials, loadDatabaseSessionCredentials } from './database.ts'

const application = {
  role: 'application',
  url: 'postgresql://control_plane_app:private-password@ep-example-pooler.c-5.us-east-2.aws.neon.tech/control_plane?sslmode=require',
}
const direct = application.url.replace('-pooler.', '.')

describe('application database session credentials', () => {
  test('preserves a direct application connection without additional configuration', () => {
    const credentials = {
      role: 'application',
      url: 'postgres://app:private-password@database:5432/control_plane',
    }
    expect(databaseSessionCredentials(credentials)).toEqual(credentials)
  })
  test('uses the same application role and database on the direct Neon endpoint', () => {
    expect(databaseSessionCredentials(application, direct)).toEqual({
      role: 'application',
      url: direct,
    })
    expect(
      loadDatabaseSessionCredentials({
        DATABASE_URL: application.url,
        DATABASE_URL_UNPOOLED: direct,
      })
    ).toEqual({ role: 'application', url: direct })
  })
  test.each([
    ['missing direct connection', undefined],
    ['pooled session connection', application.url],
    ['migration principal', direct.replace('control_plane_app:', 'control_plane_migrator:')],
    ['other database', direct.replace('/control_plane?', '/other?')],
    ['other Neon endpoint', direct.replace('ep-example.', 'ep-other.')],
    ['invalid URL', 'not-a-url'],
    ['empty explicit URL', ''],
  ])('rejects %s without exposing credentials', (_name, url) => {
    expect(() => databaseSessionCredentials(application, url)).toThrow(ConfigurationError)
    try {
      databaseSessionCredentials(application, url)
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private-password')
      expect(JSON.stringify(error)).not.toContain('postgresql://')
    }
  })
  test('supports an explicitly configured generic direct host with the application identity', () => {
    expect(
      databaseSessionCredentials(
        { role: 'application', url: 'postgres://app:private-password@pool:6432/control_plane' },
        'postgres://app:private-password@database:5432/control_plane'
      ).role
    ).toBe('application')
  })
  test('a direct Neon application URL cannot select notifications from another endpoint', () => {
    expect(() =>
      databaseSessionCredentials(
        { ...application, url: direct },
        direct.replace('ep-example.', 'ep-other.')
      )
    ).toThrow(ConfigurationError)
    expect(databaseSessionCredentials({ ...application, url: direct }, direct)).toEqual({
      role: 'application',
      url: direct,
    })
  })
})
