import { describe, expect, test } from 'bun:test'
import { directFixtureUrl, withFixtureSession } from '../fixtures/fixture-session'

// Disposable migration evidence: a realistic pre-0042 shape with two workspaces,
// custom Agents in every lifecycle state, legacy and reopened lanes, participant-only
// audiences, Agent-authored history, thread state and attribution events. The reviewed
// migration SQL runs against session-local copies; every pre-existing column must survive.

const connectionUrl = process.env.DATABASE_URL
const MIGRATIONS = ['0042_workspace_lead_topics.sql', '0045_agent-edit-revisions.sql'] as const
const TABLES = [
  'workspaces',
  'workspace_memberships',
  'agents',
  'channels',
  'channel_participants',
  'messages',
  'message_mentions',
  'channel_read_states',
  'thread_read_states',
  'workspace_events',
] as const
// Columns the migrations add; the pre-migration snapshot is compared without them.
const ADDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  agents: ['is_workspace_lead', 'revision'],
  channels: ['create_payload_hash'],
}
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function controlPlaneId(prefix: 'agt' | 'prf' | 'pfv' | 'wsp' | 'prj'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return `${prefix}_${[...bytes].map((byte) => CROCKFORD[byte % 32]).join('')}`
}

function omitKeys(row: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)))
}

// A refused write must name the violated constraint, not merely fail.
async function expectViolation(promise: Promise<unknown>, code: string, constraint: string) {
  const failure = await promise.then(
    () => {
      throw new Error(`Expected ${constraint} to refuse the write`)
    },
    (error: unknown) => error
  )
  const cause = (failure as { cause?: unknown }).cause ?? failure
  expect(cause).toMatchObject({ code, constraint_name: constraint })
}

describe.skipIf(!connectionUrl)('lead identity additive migrations', () => {
  test('preserve audiences, histories, ownership, and custom Agent identity on realistic old-shape data', async () => {
    await withFixtureSession(directFixtureUrl(), async (client) => {
      // The hosted runtime role has TEMP but not database CREATE; session-local copies keep
      // the reviewed SQL under test without schema grants.
      for (const table of TABLES) {
        await client.unsafe(
          `create temporary table ${table} (like app.${table} including defaults including identity)`
        )
      }
      await client.unsafe(`alter table agents drop column if exists is_workspace_lead`)
      await client.unsafe(`alter table agents drop column if exists revision`)
      await client.unsafe(`alter table channels drop column if exists create_payload_hash`)
      await client.unsafe(
        `create unique index channels_active_direct_agent_unique on channels (workspace_id, agent_id) where kind = 'direct_agent' and lifecycle_state = 'active'`
      )

      const insert = async (table: string, row: Record<string, unknown>) => {
        const columns = Object.keys(row)
        const values = columns.map((column) => {
          const value = row[column]
          return value !== null && typeof value === 'object' && !(value instanceof Date)
            ? client.json(value as never)
            : value
        })
        const [inserted] = await client.unsafe(
          `insert into pg_temp.${table} (${columns.map((column) => `"${column}"`).join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning *`,
          values as never
        )
        return inserted as Record<string, unknown>
      }

      const ownerOne = crypto.randomUUID()
      const adminOne = crypto.randomUUID()
      const memberOne = crypto.randomUUID()
      const ownerTwo = crypto.randomUUID()
      const workspaceOne = crypto.randomUUID()
      const workspaceTwo = crypto.randomUUID()
      const projectOne = crypto.randomUUID()

      await insert('workspaces', {
        id: workspaceOne,
        name: 'Adea HQ',
        owner_user_id: ownerOne,
        idempotency_key: 'default',
      })
      await insert('workspaces', {
        id: workspaceTwo,
        name: 'Research',
        owner_user_id: ownerTwo,
        idempotency_key: 'research',
      })
      for (const [workspaceId, userId, role, sortOrder] of [
        [workspaceOne, ownerOne, 'owner', 0],
        [workspaceOne, adminOne, 'admin', 1],
        [workspaceOne, memberOne, 'member', 2],
        [workspaceTwo, ownerTwo, 'owner', 0],
        [workspaceTwo, memberOne, 'member', 1],
      ] as const) {
        await insert('workspace_memberships', {
          workspace_id: workspaceId,
          user_id: userId,
          role,
          sort_order: sortOrder,
        })
      }

      const profile = () => ({
        profile_id: controlPlaneId('prf'),
        profile_version: controlPlaneId('pfv'),
      })
      const ada = { id: crypto.randomUUID(), ...profile() }
      const grace = { id: crypto.randomUUID(), ...profile() }
      const linus = { id: crypto.randomUUID(), ...profile() }
      const turing = { id: crypto.randomUUID(), ...profile() }
      const agentRows = [
        {
          id: ada.id,
          control_plane_agent_id: controlPlaneId('agt'),
          workspace_id: workspaceOne,
          project_id: projectOne,
          name: 'Ada Lovelace',
          role_summary: 'Builds analytical engines',
          avatar_ref: 'avatar:ada',
          character_ref: 'character:75',
          presentation_metadata: { accent: 'violet' },
          lifecycle_state: 'active',
          profile_id: ada.profile_id,
          profile_version: ada.profile_version,
          profile_state: 'available',
          profile_revision: 3,
        },
        {
          id: grace.id,
          control_plane_agent_id: controlPlaneId('agt'),
          workspace_id: workspaceOne,
          name: 'Grace Hopper',
          role_summary: 'Compiler pioneer',
          presentation_metadata: {},
          lifecycle_state: 'archived',
          profile_id: grace.profile_id,
          profile_version: grace.profile_version,
          profile_state: 'deprecated',
          profile_revision: 1,
        },
        {
          id: linus.id,
          control_plane_agent_id: controlPlaneId('agt'),
          workspace_id: workspaceOne,
          name: 'Linus Kernel Reviewer',
          role_summary: 'Reviews kernel patches',
          presentation_metadata: {},
          lifecycle_state: 'configuration_error',
          profile_id: linus.profile_id,
          profile_version: linus.profile_version,
          profile_state: 'missing',
          profile_revision: 0,
        },
        {
          id: turing.id,
          control_plane_agent_id: controlPlaneId('agt'),
          workspace_id: workspaceTwo,
          name: 'Alan Turing',
          role_summary: 'Cryptanalysis',
          presentation_metadata: { accent: 'blue' },
          lifecycle_state: 'active',
          profile_id: turing.profile_id,
          profile_version: turing.profile_version,
          profile_state: 'available',
          profile_revision: 0,
        },
      ]
      for (const row of agentRows) await insert('agents', row)

      const channel = (row: Record<string, unknown>) =>
        insert('channels', {
          id: crypto.randomUUID(),
          visibility: 'workspace',
          lifecycle_state: 'active',
          version: 1,
          ...row,
        })
      const general = await channel({
        workspace_id: workspaceOne,
        kind: 'group',
        title: 'General',
        idempotency_key: 'group:general',
        version: 4,
      })
      const engineering = await channel({
        workspace_id: workspaceOne,
        kind: 'project',
        project_id: projectOne,
        is_primary_project_channel: true,
        title: 'Engineering',
        idempotency_key: `project:${projectOne}`,
        sort_order: 1,
        version: 2,
      })
      const adaLegacyLane = await channel({
        workspace_id: workspaceOne,
        kind: 'direct_agent',
        agent_id: ada.id,
        title: 'Direct conversation',
        visibility: 'participants',
        lifecycle_state: 'archived',
        idempotency_key: `direct-agent:${ada.id}`,
        version: 5,
      })
      const adaReopenedLane = await channel({
        workspace_id: workspaceOne,
        kind: 'direct_agent',
        agent_id: ada.id,
        title: 'Direct conversation',
        visibility: 'participants',
        idempotency_key: `direct-agent:${ada.id}:${crypto.randomUUID()}`,
        version: 3,
      })
      const graceLane = await channel({
        workspace_id: workspaceOne,
        kind: 'direct_agent',
        agent_id: grace.id,
        title: 'Direct conversation',
        visibility: 'participants',
        lifecycle_state: 'archived',
        idempotency_key: `direct-agent:${grace.id}`,
        version: 2,
      })
      const strategy = await channel({
        workspace_id: workspaceOne,
        kind: 'group',
        title: 'Private strategy',
        visibility: 'participants',
        idempotency_key: 'group:strategy',
        version: 2,
      })
      const turingLane = await channel({
        workspace_id: workspaceTwo,
        kind: 'direct_agent',
        agent_id: turing.id,
        title: 'Direct conversation',
        visibility: 'participants',
        idempotency_key: `direct-agent:${turing.id}`,
      })

      for (const [workspaceId, channelId, userId] of [
        [workspaceOne, adaReopenedLane.id, ownerOne],
        [workspaceOne, adaLegacyLane.id, ownerOne],
        [workspaceOne, graceLane.id, adminOne],
        [workspaceOne, strategy.id, ownerOne],
        [workspaceOne, strategy.id, memberOne],
        [workspaceTwo, turingLane.id, ownerTwo],
      ] as const) {
        await insert('channel_participants', {
          workspace_id: workspaceId,
          channel_id: channelId,
          principal_kind: 'user',
          user_id: userId,
        })
      }
      for (const [workspaceId, channelId, agentId] of [
        [workspaceOne, adaReopenedLane.id, ada.id],
        [workspaceOne, adaLegacyLane.id, ada.id],
        [workspaceOne, graceLane.id, grace.id],
        [workspaceTwo, turingLane.id, turing.id],
      ] as const) {
        await insert('channel_participants', {
          workspace_id: workspaceId,
          channel_id: channelId,
          principal_kind: 'agent',
          agent_id: agentId,
        })
      }

      const message = async (row: Record<string, unknown>) => {
        const inserted = await insert('messages', {
          id: crypto.randomUUID(),
          version: 1,
          create_payload_hash: 'a'.repeat(64),
          ...row,
        })
        return { id: inserted.id as string, sequence: Number(inserted.sequence) }
      }
      const kickoff = await message({
        workspace_id: workspaceOne,
        channel_id: general.id,
        sender_kind: 'user',
        sender_user_id: ownerOne,
        body_text: 'Kickoff notes for the launch are in the brief.',
        idempotency_key: 'msg:kickoff',
      })
      const question = await message({
        workspace_id: workspaceOne,
        channel_id: general.id,
        sender_kind: 'user',
        sender_user_id: memberOne,
        body_text: 'Can someone review the brief before Friday?',
        idempotency_key: 'msg:question',
      })
      const reply = await message({
        workspace_id: workspaceOne,
        channel_id: general.id,
        sender_kind: 'user',
        sender_user_id: ownerOne,
        body_text: 'Reviewing now.',
        thread_root_message_id: question.id,
        reply_to_message_id: question.id,
        idempotency_key: 'msg:reply',
      })
      const summary = await message({
        workspace_id: workspaceOne,
        channel_id: general.id,
        sender_kind: 'agent',
        sender_agent_id: ada.id,
        body_text: 'Summary posted: three risks, one decision.',
        idempotency_key: 'msg:summary',
        version: 2,
        edited_at: new Date('2026-10-07T12:00:00.000Z'),
      })
      await message({
        workspace_id: workspaceOne,
        channel_id: general.id,
        sender_kind: 'user',
        sender_user_id: memberOne,
        body_text: null,
        idempotency_key: 'msg:tombstone',
        deleted_at: new Date('2026-10-07T13:00:00.000Z'),
      })
      const adaPrompt = await message({
        workspace_id: workspaceOne,
        channel_id: adaReopenedLane.id,
        sender_kind: 'user',
        sender_user_id: ownerOne,
        body_text: 'Draft the onboarding plan for the pilot.',
        idempotency_key: 'msg:ada-prompt',
      })
      await message({
        workspace_id: workspaceOne,
        channel_id: adaReopenedLane.id,
        sender_kind: 'agent',
        sender_agent_id: ada.id,
        body_text: 'Plan drafted; see the outline.',
        idempotency_key: 'msg:ada-answer',
      })
      const legacyPrompt = await message({
        workspace_id: workspaceOne,
        channel_id: adaLegacyLane.id,
        sender_kind: 'user',
        sender_user_id: ownerOne,
        body_text: 'Keep the signed contract on file; do not forward.',
        idempotency_key: 'msg:legacy-prompt',
      })
      const legacyAnswer = await message({
        workspace_id: workspaceOne,
        channel_id: adaLegacyLane.id,
        sender_kind: 'agent',
        sender_agent_id: ada.id,
        body_text: 'Archived answer with the citations.',
        idempotency_key: 'msg:legacy-answer',
      })
      await message({
        workspace_id: workspaceOne,
        channel_id: graceLane.id,
        sender_kind: 'agent',
        sender_agent_id: grace.id,
        body_text: 'Historical handoff notes.',
        idempotency_key: 'msg:grace-handoff',
      })
      const confidential = await message({
        workspace_id: workspaceOne,
        channel_id: strategy.id,
        sender_kind: 'user',
        sender_user_id: ownerOne,
        body_text: 'Pricing floor is confidential.',
        idempotency_key: 'msg:strategy',
      })
      await message({
        workspace_id: workspaceTwo,
        channel_id: turingLane.id,
        sender_kind: 'user',
        sender_user_id: ownerTwo,
        body_text: 'Hello Turing.',
        idempotency_key: 'msg:turing-prompt',
      })
      await message({
        workspace_id: workspaceTwo,
        channel_id: turingLane.id,
        sender_kind: 'agent',
        sender_agent_id: turing.id,
        body_text: 'Hello. Ready to help.',
        idempotency_key: 'msg:turing-answer',
      })

      await insert('message_mentions', {
        workspace_id: workspaceOne,
        message_id: question.id,
        principal_kind: 'user',
        user_id: adminOne,
      })
      await insert('message_mentions', {
        workspace_id: workspaceOne,
        message_id: summary.id,
        principal_kind: 'user',
        user_id: memberOne,
      })

      await insert('channel_read_states', {
        workspace_id: workspaceOne,
        user_id: ownerOne,
        channel_id: general.id,
        last_read_sequence: question.sequence,
        read_at: new Date('2026-10-07T12:30:00.000Z'),
      })
      await insert('channel_read_states', {
        workspace_id: workspaceOne,
        user_id: memberOne,
        channel_id: general.id,
        manually_unread: true,
      })
      await insert('channel_read_states', {
        workspace_id: workspaceOne,
        user_id: ownerOne,
        channel_id: adaLegacyLane.id,
        last_read_sequence: legacyAnswer.sequence,
      })
      await insert('thread_read_states', {
        workspace_id: workspaceOne,
        user_id: memberOne,
        channel_id: general.id,
        thread_root_message_id: question.id,
        last_read_sequence: reply.sequence,
      })
      await insert('channel_read_states', {
        workspace_id: workspaceTwo,
        user_id: ownerTwo,
        channel_id: turingLane.id,
        last_read_sequence: 0,
      })
      expect(adaPrompt.sequence).toBeGreaterThan(0)
      expect(confidential.sequence).toBeGreaterThan(legacyPrompt.sequence)

      for (const [
        workspaceId,
        sequence,
        eventType,
        aggregateType,
        aggregateId,
        actorId,
        payload,
      ] of [
        [workspaceOne, 1, 'agent.created', 'agent', ada.id, ownerOne, { agentId: ada.id }],
        [workspaceOne, 2, 'agent.created', 'agent', grace.id, ownerOne, { agentId: grace.id }],
        [workspaceOne, 3, 'agent.created', 'agent', linus.id, adminOne, { agentId: linus.id }],
        [
          workspaceOne,
          4,
          'channel.created',
          'channel',
          general.id,
          ownerOne,
          { channelId: general.id },
        ],
        [
          workspaceOne,
          5,
          'message.created',
          'message',
          kickoff.id,
          ownerOne,
          { messageId: kickoff.id },
        ],
        [workspaceTwo, 1, 'agent.created', 'agent', turing.id, ownerTwo, { agentId: turing.id }],
      ] as const) {
        await insert('workspace_events', {
          workspace_id: workspaceId,
          workspace_sequence: sequence,
          event_type: eventType,
          schema_version: 1,
          aggregate_type: aggregateType,
          aggregate_id: aggregateId,
          actor_kind: 'user',
          actor_id: actorId,
          payload: { actorUserId: actorId, ...payload },
        })
      }

      const before = await snapshot()
      // The fixture must be realistic, not an empty or default-only shape.
      expect(engineering).toMatchObject({ kind: 'project', is_primary_project_channel: true })
      expect(before.agents).toHaveLength(4)
      expect(before.channels).toHaveLength(7)
      expect(before.messages).toHaveLength(13)
      expect(before.channel_participants).toHaveLength(10)
      expect(before.workspace_memberships).toHaveLength(5)
      expect(before.workspace_events).toHaveLength(6)
      expect(before.agents.map((row) => [row.lifecycle_state, row.project_id !== null])).toEqual(
        expect.arrayContaining([
          ['active', true],
          ['archived', false],
          ['configuration_error', false],
        ])
      )

      for (const migration of MIGRATIONS) {
        const sql = await Bun.file(new URL(`../../drizzle/${migration}`, import.meta.url)).text()
        // Apply the reviewed SQL to the old-shape copies in the session's temporary schema.
        await client.unsafe(sql.replaceAll('"app"', '"pg_temp"'))
      }

      const after = await snapshot(ADDED_COLUMNS)
      for (const table of TABLES) expect(after[table]).toEqual(before[table])

      // Defaults for existing rows: every Agent is a non-lead at revision 0; no channel has a create hash.
      const [defaults] = await client.unsafe(
        `select count(*) filter (where is_workspace_lead = false and revision = 0)::int as agents,
                (select count(*) from channels where create_payload_hash is null)::int as channels
           from agents`
      )
      expect(defaults).toEqual({ agents: 4, channels: 7 })

      // Uniqueness and lane semantics hold on the migrated shape.
      await insert('agents', {
        workspace_id: workspaceOne,
        name: 'Workspace lead',
        profile_id: 'workspace-lead-unconfigured',
        profile_version: 'unconfigured',
        profile_state: 'missing',
        is_workspace_lead: true,
      })
      await expectViolation(
        insert('agents', {
          workspace_id: workspaceOne,
          name: 'Second lead',
          profile_id: 'workspace-lead-unconfigured',
          profile_version: 'unconfigured',
          is_workspace_lead: true,
        }),
        '23505',
        'agents_workspace_lead_unique'
      )
      await insert('agents', {
        workspace_id: workspaceTwo,
        name: 'Workspace lead',
        profile_id: 'workspace-lead-unconfigured',
        profile_version: 'unconfigured',
        profile_state: 'missing',
        is_workspace_lead: true,
      })
      await expectViolation(
        insert('agents', {
          workspace_id: crypto.randomUUID(),
          name: 'Projected lead',
          profile_id: 'workspace-lead-unconfigured',
          profile_version: 'unconfigured',
          project_id: projectOne,
          is_workspace_lead: true,
        }),
        '23514',
        'agents_workspace_lead_standalone'
      )
      await expectViolation(
        client.unsafe(`update agents set revision = -1 where id = $1`, [ada.id]),
        '23514',
        'agents_revision_nonnegative'
      )
      await expectViolation(
        insert('channels', {
          workspace_id: workspaceOne,
          kind: 'direct_agent',
          agent_id: ada.id,
          title: 'Second default lane',
          visibility: 'participants',
          idempotency_key: `direct-agent:${ada.id}:${crypto.randomUUID()}`,
        }),
        '23505',
        'channels_active_default_direct_agent_unique'
      )
      for (const key of ['direct-topic:one:request-1', 'direct-topic:one:request-2']) {
        await insert('channels', {
          workspace_id: workspaceOne,
          kind: 'direct_agent',
          agent_id: ada.id,
          title: 'Topic',
          visibility: 'participants',
          idempotency_key: key,
        })
      }
      expect(
        await client.unsafe(
          `select count(*)::int as topics from channels where agent_id = $1 and idempotency_key like 'direct-topic:%'`,
          [ada.id]
        )
      ).toEqual([{ topics: 2 }])
      async function snapshot(omitted: Readonly<Record<string, readonly string[]>> = {}) {
        const result: Record<string, Record<string, unknown>[]> = {}
        for (const table of TABLES) {
          const rows = await client.unsafe(
            `select to_jsonb(t) as row from pg_temp.${table} t order by t.id`
          )
          result[table] = rows.map((entry) => {
            const row =
              typeof entry.row === 'string' ? JSON.parse(entry.row) : (entry.row as object)
            return omitKeys(row as Record<string, unknown>, omitted[table] ?? [])
          })
        }
        return result
      }
    })
  })
})
