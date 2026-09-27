import { writeFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { userInfo } from 'node:os'
import { decidedRetentionPolicy } from '../../packages/config/src/retention-policy.ts'

export const sqliteOperatorSession = {
  actorPrincipalRef: `operator:os-user:${encodeURIComponent(userInfo().username)}`,
  authorityRef: 'authority:sqlite:local-os',
}

/** Explicit test-owned authority, not a production authorization default. */
export async function writeOperatorPolicyFixture(
  database,
  { classIds = ['command-inbox'], actions = ['create', 'release', 'sweep', 'assess'], grants } = {}
) {
  const target = { backend: 'sqlite', database: await realpath(database) }
  const policy = Object.fromEntries(
    classIds.map((classId) => {
      const decided = decidedRetentionPolicy.classes.find((entry) => entry.id === classId)
      if (!decided) throw new Error('UNKNOWN_TEST_RETENTION_CLASS')
      return [
        classId,
        {
          owner: decided.holdOwner,
          scopes: ['class', 'workspace', 'project'],
          reasonCodes: ['legal-case'],
        },
      ]
    })
  )
  const document = {
    schemaVersion: 1,
    target,
    policy,
    grants:
      grants ??
      classIds.map((classId) => ({
        ...sqliteOperatorSession,
        classId,
        scope: { kind: 'class' },
        actions,
      })),
  }
  const path = join(dirname(database), 'operator-policy.json')
  await writeFile(path, JSON.stringify(document), { mode: 0o600 })
  return { path, target, document }
}
