import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'

/** Apply canonical files inside an operator-provisioned schema without database CREATE. */
export async function migrateOwnedSchema(
  client: postgres.Sql,
  migrationsFolder: string,
  schema: 'app' | 'drizzle',
  requireExistingSchema = true
) {
  if (schema !== 'app' && schema !== 'drizzle') throw new Error('Unsupported migration schema')
  const migrations = readMigrationFiles({ migrationsFolder })
  const identifier = `"${schema}"`
  if (!requireExistingSchema) await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${identifier}`)
  const owners = await client<{ owned: boolean }[]>`
    SELECT n.nspowner = r.oid AS owned FROM pg_namespace n, pg_roles r
    WHERE n.nspname = ${schema} AND r.rolname = current_user`
  if (owners.length !== 1 || owners[0]?.owned !== true)
    throw new Error('Migration schema must already exist and be owned by the migration role')
  await client.begin(async (transaction) => {
    await transaction`SET LOCAL lock_timeout = '5s'`
    await transaction`SET LOCAL statement_timeout = '120s'`
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`schema-migrations:${schema}`}))`
    await transaction.unsafe(
      `CREATE TABLE IF NOT EXISTS ${identifier}.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
    )
    const history = await transaction.unsafe<{ hash: string; created_at: string }[]>(
      `SELECT hash, created_at FROM ${identifier}.__drizzle_migrations ORDER BY id`
    )
    if (
      history.length > migrations.length ||
      history.some(
        (row, index) =>
          row.hash !== migrations[index]?.hash ||
          Number(row.created_at) !== migrations[index]?.folderMillis
      )
    )
      throw new Error('Database migration history is not the canonical file prefix')
    for (const migration of migrations.slice(history.length)) {
      for (const statement of migration.sql) {
        // This exact bootstrap statement is redundant after the ownership check.
        // Keep the canonical file/hash intact; no other SQL is rewritten.
        if (schema === 'app' && /^\s*CREATE SCHEMA IF NOT EXISTS "app";?\s*$/.test(statement))
          continue
        await transaction.unsafe(statement)
      }
      await transaction.unsafe(
        `INSERT INTO ${identifier}.__drizzle_migrations (hash,created_at) VALUES ($1,$2)`,
        [migration.hash, migration.folderMillis]
      )
    }
  })
}
