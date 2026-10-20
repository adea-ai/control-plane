import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PostgresPiCancellationRequests } from './postgres-cancellation-requests.ts'

const socket = process.env.PI_CANCELLATION_TEST_PG_SOCKET
if (!/^\/tmp\/pi-cancellation-pg\.[A-Za-z0-9]+\/socket$/.test(socket ?? ''))
  throw new Error('OWNED_TEST_SOCKET_REQUIRED')
const postgres = createRequire(import.meta.resolve('@control-plane/database'))('postgres').default
const client = postgres({
  host: socket,
  database: 'postgres',
  username: userInfo().username,
  max: 1,
  prepare: false,
  onnotice: () => {},
})
try {
  const intent = JSON.parse(await Bun.stdin.text())
  const repository = new PostgresPiCancellationRequests(drizzle(client))
  const record = await repository.get(intent)
  const replay = await repository.retain(intent)
  process.stdout.write(JSON.stringify({ record, replay }))
} finally {
  await client.end({ timeout: 5 })
}
