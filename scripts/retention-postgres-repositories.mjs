// Postgres repository resolution for the retention operator commands. One map
// serves both commands and the registry test, because a class registered in
// scripts/retention-classes.mjs must resolve to its real repository here — the
// earlier per-command maps drifted and left three classes unreachable on
// PostgreSQL without any test noticing.
export async function resolvePostgresRepository(name) {
  const [
    commandInbox,
    eventRepository,
    executionRepository,
    contextPackageRepository,
    runtimeCommandRepository,
    messagingRetention,
    receiptRetention,
    executionPlanRepository,
  ] = await Promise.all([
    import('../packages/database/src/command-inbox-repository.ts'),
    import('../packages/database/src/execution-event-repository.ts'),
    import('../packages/database/src/execution-repository.ts'),
    import('../packages/database/src/context-package-repository.ts'),
    import('../packages/database/src/runtime-command-repository.ts'),
    import('../packages/database/src/messaging-retention.ts'),
    import('../packages/database/src/receipt-retention.ts'),
    import('../packages/database/src/execution-plan-repository.ts'),
  ])
  const repositories = {
    PostgresCommandAcceptanceRepository: commandInbox.PostgresCommandAcceptanceRepository,
    PostgresExecutionEventRepository: eventRepository.PostgresExecutionEventRepository,
    PostgresExecutionRepository: executionRepository.PostgresExecutionRepository,
    PostgresContextPackageRetention: contextPackageRepository.PostgresContextPackageRetention,
    PostgresRuntimeCommandRepository: runtimeCommandRepository.PostgresRuntimeCommandRepository,
    PostgresMessagingRetention: messagingRetention.PostgresMessagingRetention,
    PostgresReceiptRetention: receiptRetention.PostgresReceiptRetention,
    PostgresExecutionPlanRetention: executionPlanRepository.PostgresExecutionPlanRetention,
  }
  const resolved = repositories[name]
  if (resolved === undefined) throw new Error('UNKNOWN_POSTGRES_REPOSITORY')
  return resolved
}
