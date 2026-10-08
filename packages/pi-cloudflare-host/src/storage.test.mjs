import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import { openCloudflarePiStorage } from './storage.ts'

// Real vendor driver over a SQLite structural fixture; not a Workers emulator.
function fixture() {
  const db = new Database(':memory:')
  const storage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value
            )
          )
        return {
          toArray: () =>
            rows.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  value instanceof Uint8Array ? value.slice().buffer : value,
                ])
              )
            ),
        }
      },
    },
    async transaction(operation) {
      db.exec('BEGIN')
      try {
        const result = await operation()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db, storage }
}

test('actual Pi1.1 Cloudflare driver persists and reopens conversation identity', async () => {
  const f = fixture()
  try {
    const first = await openCloudflarePiStorage(f.storage)
    const id = await first.mintId()
    await first.commit([{ type: 'conversation', value: { id } }], undefined)
    await first.close(undefined)
    const reopened = await openCloudflarePiStorage(f.storage)
    expect(await reopened.conversation(id, undefined)).toEqual({ id })
    expect(await reopened.mintId()).toBeGreaterThan(id)
    await reopened.close(undefined)
  } finally {
    f.db.close()
  }
})

test('actual vendor async transaction rolls back and invalidates escaped handles', async () => {
  const f = fixture()
  try {
    const db = new DurableObjectSqliteDatabase(f.storage)
    await db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, body BLOB)')
    let escaped
    await expect(
      db.transaction(async (transaction) => {
        escaped = transaction
        await transaction.run('INSERT INTO fixture VALUES (?, ?)', 1, new Uint8Array([1, 2]))
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')
    expect(await db.all('SELECT * FROM fixture')).toEqual([])
    await expect(escaped.run('INSERT INTO fixture VALUES (?, ?)', 2, null)).rejects.toThrow(
      'no longer active'
    )
    await db.run('INSERT INTO fixture VALUES (?, ?)', 3, new Uint8Array([4, 5]))
    expect((await db.get('SELECT body FROM fixture WHERE id = ?', 3)).body).toEqual(
      new Uint8Array([4, 5])
    )
    await expect(
      db.run('INSERT INTO fixture VALUES (?, ?)', BigInt(Number.MAX_SAFE_INTEGER) + 1n, null)
    ).rejects.toThrow('without losing precision')
    await db.close()
  } finally {
    f.db.close()
  }
})

test('actual vendor rejects a future schema without altering retained conversation', async () => {
  const f = fixture()
  try {
    const storage = await openCloudflarePiStorage(f.storage)
    const id = await storage.mintId()
    await storage.commit([{ type: 'conversation', value: { id } }], undefined)
    await storage.close(undefined)
    f.db.query('UPDATE durable_schema SET version = 99').run()
    await expect(openCloudflarePiStorage(f.storage)).rejects.toThrow('newer than supported')
    expect(f.db.query('SELECT record FROM conversations WHERE id = ?').get(id).record).toBe(
      JSON.stringify({ id })
    )
  } finally {
    f.db.close()
  }
})
