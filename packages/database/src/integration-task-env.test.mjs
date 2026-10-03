import { readFile } from 'node:fs/promises'
import { expect, test } from 'bun:test'

const turbo = JSON.parse(await readFile(new URL('../../../turbo.json', import.meta.url), 'utf8'))

test('the integration task forwards database URLs and runner timeout budgets', () => {
  expect(turbo.tasks['test:integration'].env).toEqual(
    expect.arrayContaining([
      'DATABASE_ADMIN_URL',
      'DATABASE_MIGRATION_URL',
      'DATABASE_URL',
      'DATABASE_URL_UNPOOLED',
      'INTEGRATION_TEST_TIMEOUT_MS',
      'RUN_DATABASE_INTEGRATION',
    ])
  )
})
