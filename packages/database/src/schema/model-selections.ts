import { jsonb, pgTable, primaryKey, varchar } from 'drizzle-orm/pg-core'
import type {
  ModelConnection,
  RuntimeProviderSelection,
  WorkspaceModelDefaults,
} from '@control-plane/model-gateway'

/** Workspace-scoped model metadata; ciphertext remains in the credential vault. */
export const modelSelectionRecords = pgTable(
  'model_selection_records',
  {
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 16 })
      .$type<'connection' | 'defaults' | 'selection'>()
      .notNull(),
    ref: varchar('ref', { length: 64 }).notNull(),
    record: jsonb('record')
      .$type<ModelConnection | RuntimeProviderSelection | WorkspaceModelDefaults>()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.kind, table.ref] })]
)
