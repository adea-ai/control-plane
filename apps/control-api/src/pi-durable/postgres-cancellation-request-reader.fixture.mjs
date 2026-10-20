import { drizzle } from 'drizzle-orm/postgres-js'
import { PostgresPiCancellationRequests } from './postgres-cancellation-requests.ts'

import {
  openCancellationTestClient,
  verifyCancellationTestIdentity,
} from './postgres-cancellation-test-database.fixture.mjs'

const client = openCancellationTestClient()
try {
  await verifyCancellationTestIdentity(client)
  const intent = JSON.parse(await Bun.stdin.text())
  const repository = new PostgresPiCancellationRequests(drizzle(client))
  const record = await repository.get(intent)
  const replay = await repository.retain(intent)
  process.stdout.write(JSON.stringify({ record, replay }))
} finally {
  await client.end({ timeout: 5 })
}
