import { expect, test } from 'bun:test'
import { databaseSessionCredentials, loadDatabaseSessionCredentials } from './database.ts'

const url =
  'postgresql://control_plane_app:synthetic@postgres.railway.internal:5432/railway?sslmode=verify-full'
const application = { role: 'application', url }

test('a direct session uses the same runtime credentials without rewriting its hostname', () => {
  expect(databaseSessionCredentials(application)).toEqual(application)
  expect(databaseSessionCredentials(application, url)).toEqual(application)
  expect(loadDatabaseSessionCredentials({ DATABASE_URL: url })).toEqual(application)
})

test('an explicit session endpoint cannot change the server, database, or credential', () => {
  for (const change of [
    (u) => {
      u.hostname = 'unreviewed.example.invalid'
    },
    (u) => {
      u.port = '44407'
    },
    (u) => {
      u.pathname = '/other'
    },
    (u) => {
      u.username = 'postgres'
    },
    (u) => {
      u.password = 'different'
    },
    (u) => {
      u.searchParams.set('sslmode', 'require')
    },
    (u) => {
      u.searchParams.set('sslmode', 'disable')
    },
  ]) {
    const target = new URL(url)
    change(target)
    expect(() => databaseSessionCredentials(application, target.href)).toThrow()
  }
})

test('migration and administrator identities cannot be used for runtime sessions', () => {
  for (const role of ['migration', 'administration'])
    expect(() => databaseSessionCredentials({ role, url })).toThrow()
})
