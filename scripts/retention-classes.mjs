// The retention class registry (#194): one place that says, for every class
// with an implemented deletion path, which backend classes and methods serve
// it. Both operator commands and the class report read this, so the surface
// cannot drift between them, and a test asserts every entry resolves to a real
// function on the mapped repositories.
//
// Classes absent from this registry are NOT implemented: either the owner's
// decided policy keeps them reference-governed (no age deadline, so nothing can
// ever be eligible) or their deletion path is still to be built. The class
// report prints that distinction rather than implying coverage that does not
// exist.
export const retentionClasses = {
  'command-inbox': {
    apply: 'deleteEligibleInbox',
    sqlite: 'SqliteCommandAcceptanceRepository',
    postgres: 'PostgresCommandAcceptanceRepository',
  },
  'execution-events': {
    apply: 'deleteEligibleEvents',
    sqlite: 'SqliteExecutionEventRepository',
    postgres: 'PostgresExecutionEventRepository',
  },
  executions: {
    apply: 'deleteEligibleExecutions',
    sqlite: 'SqliteExecutionRepository',
    postgres: 'PostgresExecutionRepository',
  },
  'context-packages': {
    apply: 'deleteEligibleContextPackages',
    sqlite: 'SqliteContextPackageRepository',
    postgres: 'PostgresContextPackageRetention',
  },
  messaging: {
    apply: 'deleteEligibleOutboxEvents',
    // PostgreSQL-only: the supported SQLite profiles carry no inbox/outbox
    // tables, so there is nothing to sweep there.
    sqlite: null,
    postgres: 'PostgresMessagingRetention',
  },
}

export const retentionClassIds = Object.keys(retentionClasses)
