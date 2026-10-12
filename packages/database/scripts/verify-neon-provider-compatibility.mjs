import assert from 'node:assert/strict'
import postgres from 'postgres'
import process from 'node:process'
import { verifyNeonMigratorDdl } from './neon-ddl-probe.mjs'

const endpoints = [
  { variable: 'DATABASE_URL', role: 'control_plane_app', pooled: true },
  { variable: 'DATABASE_URL_UNPOOLED', role: 'control_plane_app', pooled: false },
  { variable: 'DATABASE_MIGRATION_URL', role: 'control_plane_migrator', pooled: false },
]

const clients = []

try {
  for (const endpoint of endpoints) {
    const connectionString = process.env[endpoint.variable]
    assert.ok(connectionString, `${endpoint.variable} is required`)

    const url = new URL(connectionString)
    assert.equal(url.protocol, 'postgresql:', `${endpoint.variable} must use PostgreSQL`)
    assert.equal(url.username, endpoint.role, `${endpoint.variable} has the wrong database role`)
    assert.match(
      url.hostname,
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/i,
      `${endpoint.variable} must target Neon`
    )
    assert.equal(
      /^[a-z0-9-]+-pooler\./i.test(url.hostname),
      endpoint.pooled,
      `${endpoint.variable} has the wrong pooled/direct route`
    )
    assert.equal(
      url.searchParams.get('sslmode'),
      'require',
      `${endpoint.variable} must require TLS`
    )

    const sql = postgres(connectionString, {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 1,
    })
    clients.push(sql)

    const [identity] = await sql`
      select current_user as role, current_database() as database
    `
    assert.equal(identity.role, endpoint.role, `${endpoint.variable} connected as the wrong role`)
    assert.equal(identity.database, 'neondb', `${endpoint.variable} selected the wrong database`)

    const [roundTrip] = await sql.begin(
      async (transaction) => transaction`select 1::integer as result`
    )
    assert.equal(roundTrip.result, 1, `${endpoint.variable} transaction did not round trip`)

    if (endpoint.variable === 'DATABASE_MIGRATION_URL') {
      await verifyNeonMigratorDdl(sql)
    }
  }
  console.log('Neon pooled/direct endpoint, role and migrator DDL compatibility verified.')
} finally {
  await Promise.all(clients.map((client) => client.end({ timeout: 5 })))
}
