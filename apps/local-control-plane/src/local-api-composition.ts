import {
  DurableExecutionAcceptanceService,
  DurableExecutionValidationService,
  RestateExecutionWorkflowDispatcher,
  createExecutionId,
  RepositoryProfileResolutionService,
  RepositoryProjectStateResolutionService,
  RepositoryContextPackageResolutionService,
} from '@control-plane/control-api'
import { CommandInboxService } from '@control-plane/domain'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionEventRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionValidationCommandRepository,
  SqliteExecutionRepository,
  SqliteProjectStateRepository,
  SqliteReconciliationCheckpointRepository,
  SqliteRuntimeCommandRepository,
  SqliteRuntimeDiscoveryRepository,
  SqliteRuntimeInventoryCheckpointRepository,
  SqliteRuntimeEventEffectSink,
  SqliteStatePromotionProposalRepository,
  SqliteVersionedCatalogRepository,
  type SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'

export class LocalControlApiComposition {
  readonly commandRepository: SqliteCommandAcceptanceRepository
  readonly commands: CommandInboxService
  readonly catalog: SqliteVersionedCatalogRepository
  readonly contextPackages: SqliteContextPackageRepository
  readonly executionPlans: SqliteExecutionPlanRepository
  readonly executions: SqliteExecutionRepository
  readonly executionEvents: SqliteExecutionEventRepository
  readonly projectStates: SqliteProjectStateRepository
  readonly statePromotionProposals: SqliteStatePromotionProposalRepository
  readonly reconciliationCheckpoints: SqliteReconciliationCheckpointRepository
  readonly runtimeCommands: SqliteRuntimeCommandRepository
  readonly runtimeInventoryCheckpoints: SqliteRuntimeInventoryCheckpointRepository
  readonly runtimeEventEffects: SqliteRuntimeEventEffectSink
  readonly executionAcceptanceService: DurableExecutionAcceptanceService
  readonly executionValidationService: DurableExecutionValidationService
  readonly profileResolutionService: RepositoryProfileResolutionService
  readonly projectStateResolutionService: RepositoryProjectStateResolutionService
  readonly contextPackageResolutionService: RepositoryContextPackageResolutionService
  readonly runtimeDiscoveryRepository: SqliteRuntimeDiscoveryRepository

  constructor(persistence: SqlitePersistenceProvider, restateIngressUrl: string) {
    this.commandRepository = new SqliteCommandAcceptanceRepository(persistence)
    this.catalog = new SqliteVersionedCatalogRepository(persistence)
    this.contextPackages = new SqliteContextPackageRepository(persistence)
    this.executionPlans = new SqliteExecutionPlanRepository(persistence)
    this.executions = new SqliteExecutionRepository(persistence)
    this.executionEvents = new SqliteExecutionEventRepository(persistence)
    this.projectStates = new SqliteProjectStateRepository(persistence)
    this.statePromotionProposals = new SqliteStatePromotionProposalRepository(persistence)
    this.reconciliationCheckpoints = new SqliteReconciliationCheckpointRepository(persistence)
    this.runtimeCommands = new SqliteRuntimeCommandRepository(persistence)
    this.runtimeInventoryCheckpoints = new SqliteRuntimeInventoryCheckpointRepository(persistence)
    this.runtimeEventEffects = new SqliteRuntimeEventEffectSink(persistence)
    this.runtimeDiscoveryRepository = new SqliteRuntimeDiscoveryRepository(persistence)
    this.commands = new CommandInboxService({
      repository: this.commandRepository,
      executionIdFactory: createExecutionId,
      executionPlanValidator: new ExecutionPlanAcceptanceValidator(this.executionPlans),
    })
    this.executionAcceptanceService = new DurableExecutionAcceptanceService({
      commands: this.commands,
      dispatcher: new RestateExecutionWorkflowDispatcher({ ingressUrl: restateIngressUrl }),
    })
    this.executionValidationService = new DurableExecutionValidationService({
      compilerVersion: '1.0.0',
      contextPackages: this.contextPackages,
      commands: new SqliteExecutionValidationCommandRepository(persistence),
      profiles: this.catalog,
      projectStates: this.projectStates,
      skills: this.catalog,
    })
    this.profileResolutionService = new RepositoryProfileResolutionService(this.catalog)
    this.projectStateResolutionService = new RepositoryProjectStateResolutionService(
      this.projectStates
    )
    this.contextPackageResolutionService = new RepositoryContextPackageResolutionService(
      this.contextPackages
    )
  }
}
