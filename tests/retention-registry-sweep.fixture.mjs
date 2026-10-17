import { decidedRetentionPolicy, retentionClassPolicy } from '@control-plane/config'
import * as sqlite from '@control-plane/sqlite-persistence'
import { retentionClasses } from '../scripts/retention-classes.mjs'

/**
 * Applies every implemented SQLite retention class from the operator registry
 * with the decided policy and no holds, so a deletion path registered later is
 * swept here without touching the tests.
 */
export async function sweepRegisteredRetentionClasses(provider, now) {
  const results = {}
  for (const [classId, entry] of Object.entries(retentionClasses)) {
    if (entry.sqlite === null) continue
    const Repository = sqlite[entry.sqlite]
    if (Repository === undefined) throw new Error(`RETENTION_REGISTRY_UNRESOLVED:${entry.sqlite}`)
    results[classId] = await new Repository(provider)[entry.apply](now, {
      policyRetainMs: retentionClassPolicy(decidedRetentionPolicy, classId).retainMs,
      dryRun: false,
    })
  }
  return results
}
