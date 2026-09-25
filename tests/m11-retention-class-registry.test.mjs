import { describe, expect, test } from 'bun:test'
import { decidedRetentionPolicy, retentionClassPolicy } from '@control-plane/config'
import { retentionClasses } from '../scripts/retention-classes.mjs'
import * as sqlite from '../packages/sqlite-persistence/src/index.ts'
import * as postgres from '@control-plane/database'

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

  test('every entry resolves to a real deletion method on both backends', () => {
    for (const [id, entry] of Object.entries(retentionClasses)) {
      const sqliteClass = sqlite[entry.sqlite]
      expect(typeof sqliteClass, `${id}: ${entry.sqlite}`).toBe('function')
      expect(
        typeof sqliteClass.prototype[entry.apply],
        `${id}: ${entry.sqlite}#${entry.apply}`
      ).toBe('function')
      const postgresClass = postgres[entry.postgres]
      expect(typeof postgresClass, `${id}: ${entry.postgres}`).toBe('function')
      expect(
        typeof postgresClass.prototype[entry.apply],
        `${id}: ${entry.postgres}#${entry.apply}`
      ).toBe('function')
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
