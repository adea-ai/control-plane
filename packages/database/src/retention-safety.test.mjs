import { expect, test } from 'bun:test'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresExecutionEventRepository } from './execution-event-repository.ts'

for (const [Repository, method, prefix] of [
  [PostgresCommandAcceptanceRepository, 'deleteExpiredInbox', 'COMMAND'],
  [PostgresExecutionEventRepository, 'deleteExpiredEvents', 'EVENT'],
]) {
  test(`${method} refuses deletion without touching PostgreSQL`, async () => {
    let accesses = 0
    const database = new Proxy(
      {},
      {
        get() {
          accesses += 1
          throw new Error('UNEXPECTED_DATABASE_ACCESS')
        },
      }
    )
    const repository = new Repository(database)
    await expect(repository[method](new Date('invalid'))).rejects.toThrow(
      `${prefix}_RETENTION_INVALID_TIMESTAMP`
    )
    await expect(repository[method](new Date('2030-01-01T00:00:00.000Z'))).rejects.toThrow(
      `${prefix}_RETENTION_ELIGIBILITY_REQUIRED`
    )
    expect(accesses).toBe(0)
  })
}
