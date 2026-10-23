import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { migrateOwnedSchema } from './scoped-migrations.ts'

const administration = process.env.SCOPED_MIGRATION_TEST_ADMIN_URL

test.skipIf(!administration)(
  'owned-schema migrations need no database CREATE and reject changed history atomically',
  async () => {
    const origin = new URL(administration)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
      throw new Error('Disposable loopback fixture required')
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const database = `scoped_${suffix}`
    const role = `migrator_${suffix}`
    const password = 'synthetic-fixture-only'
    const admin = postgres(administration, { max: 1 })
    const folder = await mkdtemp(join(tmpdir(), 'scoped-migrations-'))
    let owner
    let schemaAdmin
    try {
      await admin.unsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
      )
      await admin.unsafe(`CREATE DATABASE ${database}`)
      origin.pathname = `/${database}`
      schemaAdmin = postgres(origin.toString(), { max: 1 })
      await schemaAdmin.unsafe(`CREATE SCHEMA app AUTHORIZATION ${role}`)
      await schemaAdmin.unsafe(`REVOKE CREATE ON DATABASE ${database} FROM PUBLIC, ${role}`)
      origin.username = role
      origin.password = password
      owner = postgres(origin.toString(), { max: 1 })
      await mkdir(join(folder, 'meta'))
      const journal = {
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_initial', breakpoints: true }],
      }
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal))
      const initial =
        'CREATE SCHEMA IF NOT EXISTS "app";\n--> statement-breakpoint\nCREATE TABLE app.fixture (id integer PRIMARY KEY);'
      await writeFile(join(folder, '0000_initial.sql'), initial)
      expect(
        (
          await owner`SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed`
        )[0]?.allowed
      ).toBe(false)
      await migrateOwnedSchema(owner, folder, 'app')
      await migrateOwnedSchema(owner, folder, 'app')
      expect(
        (await owner`SELECT count(*)::integer AS count FROM app.__drizzle_migrations`)[0]?.count
      ).toBe(1)
      await writeFile(join(folder, '0000_initial.sql'), initial + '\n-- changed')
      await expect(migrateOwnedSchema(owner, folder, 'app')).rejects.toThrow(
        'canonical file prefix'
      )
      await writeFile(join(folder, '0000_initial.sql'), initial)
      journal.entries.push({
        idx: 1,
        version: '7',
        when: 2000,
        tag: '0001_failure',
        breakpoints: true,
      })
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal))
      await writeFile(
        join(folder, '0001_failure.sql'),
        'CREATE TABLE app.rollback_probe(id integer);\n--> statement-breakpoint\nSELECT nonexistent_scoped_fixture_function();'
      )
      await expect(migrateOwnedSchema(owner, folder, 'app')).rejects.toThrow()
      expect(
        (await owner`SELECT to_regclass('app.rollback_probe') AS relation`)[0]?.relation
      ).toBeNull()
      expect(
        (await owner`SELECT count(*)::integer AS count FROM app.__drizzle_migrations`)[0]?.count
      ).toBe(1)
      await expect(migrateOwnedSchema(owner, folder, 'drizzle')).rejects.toThrow(
        'already exist and be owned'
      )
    } finally {
      await owner?.end({ timeout: 1 })
      await schemaAdmin?.end({ timeout: 1 })
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await admin.end({ timeout: 1 })
      await rm(folder, { recursive: true, force: true })
    }
  },
  30000
)
