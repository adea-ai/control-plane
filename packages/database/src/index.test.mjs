import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  commandInbox,
  createPostgresConnection,
  DatabaseConnectionError,
  databaseReadinessProbe,
  executionAttempts,
  executionEvents,
  executions,
  externalSessions,
  inboxMessages,
  interactionRequests,
  outboxEvents,
  persistenceConventions,
  reconciliationCheckpoints,
  runtimeCommands,
  runtimeEventReceipts,
  runtimeInventoryCheckpoints,
  runtimeConnections,
  usageLedgerEntries,
  withDomainTransaction,
} from './index.ts'

describe('persistence schema', () => {
  test('defines shared PostgreSQL conventions and domain-organized messaging tables', () => {
    expect(persistenceConventions).toEqual({
      identifiers: 'uuid-v4-database-generated',
      json: 'jsonb',
      names: 'snake_case-plural-tables',
      revisions: 'bigint-starting-at-one',
      softDelete: 'nullable-deleted-at',
      timestamps: 'timestamp-with-time-zone',
    })

    const inbox = getTableConfig(inboxMessages)
    const command = getTableConfig(commandInbox)
    const outbox = getTableConfig(outboxEvents)
    const execution = getTableConfig(executions)
    const event = getTableConfig(executionEvents)
    const attempt = getTableConfig(executionAttempts)
    const interaction = getTableConfig(interactionRequests)
    const reconciliation = getTableConfig(reconciliationCheckpoints)
    const runtimeConnection = getTableConfig(runtimeConnections)
    const runtimeCommand = getTableConfig(runtimeCommands)
    const runtimeEventReceipt = getTableConfig(runtimeEventReceipts)
    const runtimeInventoryCheckpoint = getTableConfig(runtimeInventoryCheckpoints)
    const externalSession = getTableConfig(externalSessions)
    const usageLedger = getTableConfig(usageLedgerEntries)
    expect(inbox.name).toBe('inbox_messages')
    expect(command.name).toBe('command_inbox')
    expect(outbox.name).toBe('outbox_events')
    expect(execution.name).toBe('executions')
    expect(attempt.name).toBe('execution_attempts')
    expect(interaction.name).toBe('interaction_requests')
    expect(reconciliation.name).toBe('reconciliation_checkpoints')
    expect(runtimeConnection.name).toBe('runtime_connections')
    expect(runtimeCommand.name).toBe('runtime_commands')
    expect(runtimeEventReceipt.name).toBe('runtime_event_receipts')
    expect(runtimeInventoryCheckpoint.name).toBe('runtime_inventory_checkpoints')
    expect(externalSession.name).toBe('external_sessions')
    expect(usageLedger.name).toBe('usage_ledger_entries')
    expect(usageLedger.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'usage_ledger_execution_sequence_unique',
        'usage_ledger_workspace_idempotency_unique',
        'usage_ledger_execution_recorded_index',
      ])
    )
    expect(runtimeCommand.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'command_id',
        'execution_id',
        'attempt_id',
        'runtime_node_ref_id',
        'runtime_connection_id',
        'workspace_id',
        'payload_hash',
        'command_envelope',
        'status',
        'delivery_attempts',
        'last_channel_generation',
        'last_sequence',
        'acknowledgement_reference',
        'result_reference',
        'expires_at',
      ])
    )
    expect(runtimeCommand.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'runtime_commands_node_status_issued_index',
        'runtime_commands_expiry_index',
        'runtime_commands_execution_attempt_index',
      ])
    )
    expect(runtimeEventReceipt.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'command_id',
        'message_kind',
        'message_sequence',
        'frame_hash',
        'outcome',
        'event_id',
        'recorded_at',
      ])
    )
    expect(runtimeEventReceipt.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'runtime_event_receipts_progress_order_index',
        'runtime_event_receipts_event_index',
      ])
    )
    expect(runtimeInventoryCheckpoint.columns.map(({ name }) => name)).toEqual([
      'runtime_node_ref_id',
      'workspace_id',
      'snapshot_version',
      'snapshot_digest',
      'observed_at',
      'active_runtime_refs',
      'revision',
    ])
    expect(inbox.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'id',
        'payload',
        'revision',
        'created_at',
        'updated_at',
        'deleted_at',
      ])
    )
    expect(outbox.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['id', 'payload', 'status', 'revision', 'created_at', 'updated_at'])
    )
    expect(command.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'command_id',
        'caller_principal_id',
        'operation',
        'idempotency_key',
        'payload_hash',
        'workspace_id',
        'project_id',
        'task_id',
        'request_id',
        'status',
        'execution_id',
        'retention_expires_at',
        'conflict_count',
      ])
    )
    expect(command.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'command_inbox_scope_idempotency_unique',
        'command_inbox_status_retention_index',
        'command_inbox_execution_index',
      ])
    )
    expect(execution.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'execution_id',
        'execution_plan_id',
        'execution_plan_digest',
        'execution_plan_schema_version',
        'workspace_id',
        'project_id',
        'task_id',
        'agent_id',
        'state',
        'version',
        'deadline_at',
        'terminal_result_ref',
      ])
    )
    expect(execution.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'executions_scope_index',
        'executions_state_deadline_index',
        'executions_parent_index',
      ])
    )
    expect(event.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'event_id',
        'execution_id',
        'workspace_id',
        'project_id',
        'task_id',
        'agent_id',
        'sequence',
        'event_type',
        'payload',
        'payload_hash',
        'publication_status',
        'next_attempt_at',
        'quarantined_at',
      ])
    )
    expect(event.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'execution_events_execution_sequence_unique',
        'execution_events_replay_index',
        'execution_events_publication_index',
      ])
    )
    expect(attempt.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'attempt_id',
        'execution_id',
        'sequence',
        'runtime_definition_id',
        'runtime_node_ref_id',
        'runtime_connection_id',
        'routing_decision',
        'state',
        'version',
      ])
    )
    expect(attempt.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'execution_attempts_execution_sequence_unique',
        'execution_attempts_state_deadline_index',
        'execution_attempts_runtime_index',
      ])
    )
    expect(interaction.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'interaction_id',
        'execution_id',
        'attempt_id',
        'kind',
        'state',
        'version',
        'allowed_principal_ids',
        'expires_at',
        'response',
      ])
    )
    expect(interaction.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'interaction_requests_execution_index',
        'interaction_requests_attempt_state_index',
        'interaction_requests_expiry_index',
      ])
    )
    expect(reconciliation.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'checkpoint_id',
        'execution_id',
        'command_id',
        'attempt_id',
        'workflow_id',
        'runtime_command_id',
        'pending_event_count',
        'observation_hash',
        'reason',
        'action',
        'state',
        'diagnostics',
        'version',
        'checked_at',
      ])
    )
    expect(reconciliation.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'reconciliation_checkpoints_observation_unique',
        'reconciliation_checkpoints_execution_index',
        'reconciliation_checkpoints_command_index',
        'reconciliation_checkpoints_state_index',
      ])
    )
    expect(runtimeConnection.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'runtime_connection_id',
        'identity_digest',
        'connection_type',
        'runtime_node_ref_id',
        'runtime_definition_id',
        'location',
        'opaque_native_ref',
        'adapter_version',
        'driver_version',
        'harness_version',
        'status',
        'health',
        'capabilities',
        'compatibility_state',
        'availability_state',
        'protocol_version',
        'capability_snapshot_version',
        'capability_snapshot_observed_at',
        'capability_snapshot_expires_at',
        'capability_verification',
        'last_health_report_sequence',
        'last_health_report_digest',
        'limitations',
        'diagnostics',
        'last_discovered_at',
        'last_heartbeat_at',
        'last_health_check_at',
        'expires_at',
        'version',
        'created_at',
        'updated_at',
      ])
    )
    expect(externalSession.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'external_session_id',
        'runtime_connection_id',
        'opaque_native_session_id',
        'workspace_id',
        'project_id',
        'state',
        'ownership',
        'capability_snapshot',
        'safe_metadata',
        'last_observed_at',
        'version',
      ])
    )
    expect(externalSession.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'external_sessions_runtime_native_unique',
        'external_sessions_scope_state_index',
        'external_sessions_runtime_index',
      ])
    )
    expect(
      runtimeConnection.columns.find(({ name }) => name === 'opaque_native_ref')?.getSQLType()
    ).toBe('varchar(31)')
    expect(runtimeConnection.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'runtime_connections_identity_unique',
        'runtime_connections_node_index',
        'runtime_connections_status_freshness_index',
        'runtime_connections_availability_freshness_index',
        'runtime_connections_definition_index',
      ])
    )
  })
})

describe('createPostgresConnection', () => {
  test('rejects non-PostgreSQL URLs without serializing credentials', () => {
    const url = 'mysql://application:top-secret@database/control_plane'

    try {
      createPostgresConnection({ role: 'application', url })
      throw new Error('Expected connection creation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConnectionError)
      expect(JSON.stringify(error)).not.toContain('top-secret')
      expect(error.diagnostic).toEqual({ code: 'INVALID_DATABASE_URL' })
    }
  })

  test('rejects migration credentials from the application connection path', () => {
    expect(() =>
      createPostgresConnection({
        role: 'migration',
        url: 'postgresql://migrator:secret@database/control_plane',
      })
    ).toThrow(DatabaseConnectionError)
  })
})

describe('databaseReadinessProbe', () => {
  const fakeConnection = (check) => ({ check, close: async () => undefined })

  test('resolves true when the database check settles', async () => {
    expect(await databaseReadinessProbe(fakeConnection(async () => undefined))).toBe(true)
  })

  test('resolves false when the database check rejects', async () => {
    expect(
      await databaseReadinessProbe(
        fakeConnection(async () => {
          throw new Error('connection refused')
        })
      )
    ).toBe(false)
  })

  test('resolves false when the database check exceeds the probe budget', async () => {
    const startedAt = Date.now()
    expect(
      await databaseReadinessProbe(
        fakeConnection(() => new Promise(() => {})),
        25
      )
    ).toBe(false)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20)
  })
})

test('withDomainTransaction applies an atomic serializable transaction boundary', async () => {
  const transaction = { marker: 'transaction' }
  const calls = []
  const database = {
    transaction: async (operation, configuration) => {
      calls.push(configuration)
      return operation(transaction)
    },
  }

  const result = await withDomainTransaction(database, async (context) => {
    expect(context).toBe(transaction)
    return 'committed'
  })

  expect(result).toBe('committed')
  expect(calls).toEqual([
    { accessMode: 'read write', deferrable: false, isolationLevel: 'serializable' },
  ])
})
