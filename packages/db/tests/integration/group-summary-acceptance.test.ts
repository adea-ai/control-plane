import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createMessage } from '../../src/conversations'
import {
  createGroupChannelWithGrants,
  decideGroupChannelSummaryReadNow,
  groupCreationCandidatesFromGrants,
  revokeGroupGrant,
  setGroupChannelParticipantsWithGrants,
  shareGroupHistory,
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'
const LATER = '2026-10-08T13:00:00.000Z'

/** Explicit ceiling for drive-to-decision flows; same as group-channels.test.ts. */
function T(name: string, fn: () => Promise<void>) {
  test(name, fn, 30_000)
}

// Acceptance (#1178, criterion 2): an earlier summary reaching before a
// newcomer's join point is denied on the real database path and unlocked only
// by an explicit, reader-scoped `earlier_summary` sharing grant; revoking that
// grant re-locks it. Mirrors the history-read proof in group-channels.test.ts.
describe.skipIf(!connectionUrl)('group summary reads: join point and sharing (acceptance)', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `group-summary-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Group summaries',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Summarizer',
      profileId: 'lead',
      profileVersion: '1',
    })
    return { agent, member, owner, workspace }
  }

  function founderGrants(channelId: string, f: Awaited<ReturnType<typeof fixture>>) {
    return {
      audienceGrants: [
        {
          expiresAt: null,
          grantId: 'gra_owner',
          groupId: channelId,
          issuedAt: ISSUED,
          participant: f.owner,
          revision: 1,
          revokedAt: null,
        },
      ],
      enlistmentGrants: [],
    }
  }

  function bothGrants(channelId: string, f: Awaited<ReturnType<typeof fixture>>) {
    return {
      audienceGrants: [
        ...founderGrants(channelId, f).audienceGrants,
        {
          expiresAt: null,
          grantId: 'gra_member',
          groupId: channelId,
          issuedAt: ISSUED,
          participant: f.member,
          revision: 1,
          revokedAt: null,
        },
      ],
      enlistmentGrants: [
        {
          agent: { agentId: f.agent.id, workspaceId: f.workspace.id },
          expiresAt: null,
          grantId: 'gra_agent',
          groupId: channelId,
          issuedAt: ISSUED,
          revision: 1,
          revokedAt: null,
        },
      ],
    }
  }

  T(
    'a newcomer summary before the join point is denied until an earlier_summary grant, then re-locks',
    async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, founderGrants(channelId, f)),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      await createMessage(connection.db, f.workspace.id, channelId, f.owner, {
        bodyText: 'context before the newcomer',
        idempotencyKey: crypto.randomUUID(),
        sender: f.owner,
      })
      await setGroupChannelParticipantsWithGrants(
        connection.db,
        f.workspace.id,
        channelId,
        f.owner,
        {
          candidates: groupCreationCandidatesFromGrants(f.workspace.id, bothGrants(channelId, f)),
          expectedVersion: created.channel.version,
          now: LATER,
        }
      )

      const denied = await decideGroupChannelSummaryReadNow(
        connection.db,
        f.workspace.id,
        channelId,
        f.member,
        0,
        LATER
      )
      expect(denied).toMatchObject({ action: 'deny', reason: 'summary_before_join_point' })

      await shareGroupHistory(connection.db, f.workspace.id, channelId, f.owner, {
        expiresAt: null,
        grantId: 'gra_share_summary',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
        scope: 'earlier_summary',
      })
      const unlocked = await decideGroupChannelSummaryReadNow(
        connection.db,
        f.workspace.id,
        channelId,
        f.member,
        0,
        LATER
      )
      expect(unlocked).toMatchObject({ action: 'allow', basis: 'earlier_summary_grant' })

      const revoked = await revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
        grantId: 'gra_share_summary',
        kind: 'sharing',
        revokedAt: LATER,
      })
      expect(revoked).toEqual({ revoked: true })
      const relocked = await decideGroupChannelSummaryReadNow(
        connection.db,
        f.workspace.id,
        channelId,
        f.member,
        0,
        LATER
      )
      expect(relocked).toMatchObject({ action: 'deny', reason: 'summary_before_join_point' })

      // The sharing grant row survives as a revoked record, never silently deleted.
      const rows = await connection.db
        .select()
        .from(schema.groupSharingGrants)
        .where(eq(schema.groupSharingGrants.channelId, channelId))
      expect(rows.filter((row) => row.scope === 'earlier_summary')).toHaveLength(1)
    }
  )
})
