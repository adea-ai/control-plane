import { max } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { langgraphCheckpointMigrations } from './schema/langgraph-checkpoints.js'

export const LANGGRAPH_CHECKPOINT_SCHEMA_VERSION = 4

/** Verifies migration-role setup without granting DDL to the Hosted app role. */
export async function verifyLangGraphCheckpointSchema(
  database: ControlPlaneDatabase
): Promise<void> {
  try {
    const [row] = await database
      .select({ version: max(langgraphCheckpointMigrations.version) })
      .from(langgraphCheckpointMigrations)
    if (row?.version === LANGGRAPH_CHECKPOINT_SCHEMA_VERSION) return
  } catch {
    // Missing or unreadable migration state is a startup failure, never a signal to run DDL.
  }
  throw new Error('LANGGRAPH_CHECKPOINT_SCHEMA_REQUIRED')
}
