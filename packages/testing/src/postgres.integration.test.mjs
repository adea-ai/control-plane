import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { withIsolatedPostgres } from './postgres.ts'
import { integrationTestTimeout } from '@control-plane/database/testing'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

describe.skipIf(!integrationEnabled)('shared PostgreSQL test harness', () => {
  test(
    'migrates independent databases for parallel test workers',
    async () => {
      const names = await Promise.all([
        withIsolatedPostgres((database) => database.name),
        withIsolatedPostgres((database) => database.name),
      ])

      expect(names[0]).not.toBe(names[1])
      expect(names.every((name) => name.startsWith('control_plane_test_'))).toBe(true)
    },
    integrationTestTimeout(30_000)
  )
})
