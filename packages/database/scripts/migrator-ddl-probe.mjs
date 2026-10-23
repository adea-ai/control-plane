import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

/** Proves the restricted migration role can bootstrap and perform transactional app-schema DDL. */
export async function verifyMigratorDdl(sql) {
  const table = `cp_postgres_probe_${randomBytes(8).toString('hex')}`

  await sql.begin(async (transaction) => {
    const [{ schema_exists: schemaExists }] = await transaction.unsafe(
      "SELECT to_regnamespace('app') IS NOT NULL AS schema_exists"
    )
    assert.equal(typeof schemaExists, 'boolean', 'PostgreSQL app-schema lookup returned no result')
    const createdSchema = !schemaExists
    if (createdSchema) await transaction.unsafe('CREATE SCHEMA app')

    await transaction.unsafe(
      `CREATE TABLE app.${table} (id integer PRIMARY KEY, marker text NOT NULL)`
    )
    await transaction.unsafe(`INSERT INTO app.${table} (id, marker) VALUES ($1, $2)`, [1, 'ok'])
    const [row] = await transaction.unsafe(`SELECT marker FROM app.${table} WHERE id = $1`, [1])
    assert.equal(row?.marker, 'ok', 'PostgreSQL migrator DDL probe did not round trip')
    await transaction.unsafe(`DROP TABLE app.${table}`)
    if (createdSchema) await transaction.unsafe('DROP SCHEMA app')
  })
}
