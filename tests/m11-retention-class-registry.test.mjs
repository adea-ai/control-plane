import { describe, expect, test } from 'bun:test'
import { decidedRetentionPolicy, retentionClassPolicy } from '@control-plane/config'
import { retentionClasses } from '../scripts/retention-classes.mjs'
import * as sqlite from '../packages/sqlite-persistence/src/index.ts'
import * as postgres from '@control-plane/database'
import { resolvePostgresRepository } from '../scripts/retention-postgres-repositories.mjs'

// The registry is the single source of truth for which classes have a deletion
// path. These assertions keep it honest: an entry must name a class the decided
// policy knows, and it must resolve to a real method on the real class for both
// backends, so a rename cannot leave the operator command pointing at nothing.
describe('retention class registry (#194)', () => {
  test('every registered class exists in the decided policy', () => {
    for (const id of Object.keys(retentionClasses)) {
      expect(() => retentionClassPolicy(decidedRetentionPolicy, id)).not.toThrow()
    }
  })

  test('every entry resolves to a real deletion method on the backends it implements', () => {
    for (const [id, entry] of Object.entries(retentionClasses)) {
      // A class may be PostgreSQL-only, but never unregistered on both sides.
      const sqliteClass = entry.sqlite === null ? undefined : sqlite[entry.sqlite]
      if (entry.sqlite === null) {
        expect(entry.sqlite, `${id} is PostgreSQL-only`).toBeNull()
      } else {
        expect(typeof sqliteClass, `${id}: ${entry.sqlite}`).toBe('function')
        expect(
          typeof sqliteClass.prototype[entry.apply],
          `${id}: ${entry.sqlite}#${entry.apply}`
        ).toBe('function')
      }
      const postgresClass = postgres[entry.postgres]
      expect(typeof postgresClass, `${id}: ${entry.postgres}`).toBe('function')
      expect(
        typeof postgresClass.prototype[entry.apply],
        `${id}: ${entry.postgres}#${entry.apply}`
      ).toBe('function')
    }
  })

  test('every entry resolves through the command-side Postgres map', async () => {
    // The registry test above checks the classes; this checks the map the
    // operator command actually uses, which drifted once and left three classes
    // unreachable on PostgreSQL without any test noticing.
    for (const [id, entry] of Object.entries(retentionClasses)) {
      const resolved = await resolvePostgresRepository(entry.postgres)
      expect(typeof resolved, `${id}: ${entry.postgres}`).toBe('function')
    }
  })

  test('a class the policy keeps reference-governed has no deletion path', () => {
    // No age deadline means no candidate can ever be eligible, so a deletion
    // implementation for such a class would be unreachable code.
    const unbounded = decidedRetentionPolicy.classes
      .filter((entry) => entry.retainMs === null)
      .map((entry) => entry.id)
    expect(unbounded).toContain('project-state')
    for (const id of unbounded) {
      expect(retentionClasses[id], `${id} is reference-governed`).toBeUndefined()
    }
  })

  test('every class the policy gives a finite duration either has a path or is a stated remaining gap', () => {
    // A finite duration means the owner decided the class is physically deleted
    // after that window, so it needs a deletion path. The classes below are the
    // ones where that path still does not exist. Each names the hold owner the
    // decided policy itself records, so the remaining #194 retention scope is
    // explicit and cannot drift silently: adding a path for one of them, or
    // giving a new class a finite duration, fails this assertion until the list
    // is updated.
    const remaining = {
      'native-terminal-snapshots': 'runtime-owner',
      'workflow-references': 'platform-operator',
      usage: 'billing-owner',
      'logs-traces': 'platform-operator',
      artifacts: 'release-owner',
      backups: 'platform-operator',
    }
    const withoutPath = decidedRetentionPolicy.classes
      .filter((entry) => entry.retainMs !== null)
      .filter((entry) => retentionClasses[entry.id] === undefined)
      .map((entry) => entry.id)
      .toSorted()
    expect(withoutPath).toEqual(Object.keys(remaining).toSorted())
    for (const [id, owner] of Object.entries(remaining)) {
      expect(retentionClassPolicy(decidedRetentionPolicy, id).holdOwner).toBe(owner)
    }
  })

  test('the registry covers the classes the CLI accepts', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')

    const apply = await readFile(
      fileURLToPath(new URL('../scripts/retention-apply.mjs', import.meta.url)),
      'utf8'
    )
    expect(apply).toContain('Object.keys(retentionClasses)')
  })
})
