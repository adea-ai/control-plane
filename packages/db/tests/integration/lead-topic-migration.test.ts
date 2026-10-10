import { describe, expect, test } from 'bun:test'
import { directFixtureUrl, withFixtureSession } from '../fixtures/fixture-session'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('lead/topic additive migration', () => {
  test('preserves legacy identities, archived bodies, original audiences and read frontiers', async () => {
    await withFixtureSession(directFixtureUrl(), async (client) => {
      const fixtureSchema = 'pg_temp'
      const namespace = client(fixtureSchema)
      const workspaceId = crypto.randomUUID()
      const agentId = crypto.randomUUID()
      const channelId = crypto.randomUUID()
      const archivedChannelId = crypto.randomUUID()
      const senderId = crypto.randomUUID()
      // The hosted runtime role has TEMP but deliberately lacks database CREATE.
      // Session-local fixtures exercise the actual migration without schema grants.
      await client`create temporary table agents (like app.agents including defaults)`
      await client`alter table ${namespace}.agents drop column is_workspace_lead`
      await client`create temporary table channels (like app.channels including defaults)`
      await client`alter table ${namespace}.channels drop column create_payload_hash`
      await client`create unique index channels_active_direct_agent_unique on ${namespace}.channels (workspace_id,agent_id) where kind='direct_agent' and lifecycle_state='active'`
      await client`create temporary table messages (like app.messages including defaults including identity)`
      await client`create temporary table channel_participants (like app.channel_participants including defaults)`
      await client`create temporary table channel_read_states (like app.channel_read_states including defaults)`
      await client`insert into ${namespace}.agents (id,workspace_id,name,profile_id,profile_version) values (${agentId},${workspaceId},'Custom legacy Agent','legacy-profile','1')`
      await client`insert into ${namespace}.channels (id,workspace_id,kind,agent_id,title,visibility,lifecycle_state,idempotency_key) values (${channelId},${workspaceId},'direct_agent',${agentId},'Original private audience','participants','active',${`direct-agent:${agentId}`}), (${archivedChannelId},${workspaceId},'direct_agent',${agentId},'Archived history','participants','archived','old-direct-lane')`
      await client`insert into ${namespace}.channel_participants (workspace_id,channel_id,principal_kind,user_id) values (${workspaceId},${channelId},'user',${senderId}), (${workspaceId},${archivedChannelId},'user',${senderId})`
      await client`insert into ${namespace}.messages (workspace_id,channel_id,sender_kind,sender_user_id,body_text,idempotency_key,create_payload_hash) values (${workspaceId},${archivedChannelId},'user',${senderId},'Retained private legacy body','legacy-message',${'a'.repeat(64)})`
      await client`insert into ${namespace}.channel_read_states (workspace_id,channel_id,user_id,last_read_sequence) values (${workspaceId},${archivedChannelId},${senderId},1)`
      const before = await snapshot()
      const migration = await Bun.file(
        new URL('../../drizzle/0042_workspace_lead_topics.sql', import.meta.url)
      ).text()
      // Apply the actual reviewed SQL to old-shape fixtures in an isolated namespace.
      await client.unsafe(migration.replaceAll('"app"', `"${fixtureSchema}"`))
      expect(await snapshot()).toEqual(before)
      const [legacyAgent] = await client`select is_workspace_lead from ${namespace}.agents`
      expect(legacyAgent!.is_workspace_lead).toBe(false)
      await client`insert into ${namespace}.channels (workspace_id,kind,agent_id,title,visibility,idempotency_key) values (${workspaceId},'direct_agent',${agentId},'New private topic','participants','direct-topic:actor:request-1'), (${workspaceId},'direct_agent',${agentId},'Second private topic','participants','direct-topic:actor:request-2')`
      expect(
        await client`select id from ${namespace}.channels where lifecycle_state='active'`
      ).toHaveLength(3)

      async function snapshot() {
        return {
          agents:
            await client`select id,control_plane_agent_id,workspace_id,name,profile_id,profile_version,lifecycle_state,created_at,updated_at from ${namespace}.agents order by id`,
          channels:
            await client`select id,workspace_id,agent_id,title,visibility,lifecycle_state,idempotency_key,version,created_at,updated_at from ${namespace}.channels order by id`,
          messages: await client`select * from ${namespace}.messages order by id`,
          participants: await client`select * from ${namespace}.channel_participants order by id`,
          reads: await client`select * from ${namespace}.channel_read_states order by id`,
        }
      }
    })
  })
})
