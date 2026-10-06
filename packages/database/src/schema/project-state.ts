import type {
  AppliedStateMutation,
  ProjectState,
  StatePromotionProposal,
} from '@control-plane/domain'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'

const identifier = (name: string) => varchar(name, { length: 30 })

export const statePromotionProposalState = pgEnum('state_promotion_proposal_state', [
  'candidate',
  'approved',
  'rejected',
  'merged',
  'superseded',
  'expired',
])

export const projectStates = pgTable(
  'project_states',
  {
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    revision: integer('revision').notNull(),
    state: jsonb('state').$type<ProjectState>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.projectId] })]
)

export const projectStateRevisions = pgTable(
  'project_state_revisions',
  {
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    revision: integer('revision').notNull(),
    state: jsonb('state').$type<ProjectState>().notNull(),
    recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.projectId, table.revision] }),
    foreignKey({
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projectStates.workspaceId, projectStates.projectId],
      name: 'project_state_revisions_state_fk',
    }),
  ]
)

export const projectStateMutations = pgTable(
  'project_state_mutations',
  {
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    mutationId: identifier('mutation_id').notNull(),
    inputDigest: varchar('input_digest', { length: 71 }).notNull(),
    resultingRevision: integer('resulting_revision').notNull(),
    touchedItemIds: jsonb('touched_item_ids')
      .$type<AppliedStateMutation['touchedItemIds']>()
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.projectId, table.mutationId] }),
    foreignKey({
      columns: [table.workspaceId, table.projectId, table.resultingRevision],
      foreignColumns: [
        projectStateRevisions.workspaceId,
        projectStateRevisions.projectId,
        projectStateRevisions.revision,
      ],
      name: 'project_state_mutations_revision_fk',
    }),
  ]
)

export const statePromotionProposals = pgTable(
  'state_promotion_proposals',
  {
    proposalId: identifier('proposal_id').primaryKey(),
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    revision: integer('revision').notNull(),
    state: statePromotionProposalState('state').notNull(),
    proposal: jsonb('proposal').$type<StatePromotionProposal>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    index('state_promotion_proposals_scope_state_index').on(
      table.workspaceId,
      table.projectId,
      table.state
    ),
  ]
)

/**
 * One receipt per scope: the authenticated command that created revision zero. Committed in the
 * same transaction as the state, its revision-zero snapshot and the `project_state.initialized`
 * outbox event. Scopes created by operator bootstrap or portability import have no receipt.
 */
export const projectStateInitializations = pgTable(
  'project_state_initializations',
  {
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    callerId: varchar('caller_id', { length: 64 }).notNull(),
    commandId: identifier('command_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    initializedAt: timestamp('initialized_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.projectId],
      name: 'project_state_initializations_scope_pk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projectStates.workspaceId, projectStates.projectId],
      name: 'project_state_initializations_state_fk',
    }),
    check(
      'project_state_initializations_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`
    ),
  ]
)
