import {
  CatalogBackedGraphDefinitionResolver,
  DeclarativeGraphCompilationError,
  DeclarativeGraphCompiler,
  DurableGraphEventPublisher,
  LangGraphOrchestrationAdapter,
  LangGraphSqliteCheckpointSaver,
  type DeclarativeGraphCompilerOptions,
} from '@control-plane/langgraph-adapter'
import {
  GraphDefinitionCatalog,
  GraphDefinitionExecutionAuthority,
  type GraphNodeOperationPort,
} from '@control-plane/orchestration'
import {
  SqliteGraphDefinitionRepository,
  type SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { OrchestrationGraphSegmentActivities } from '@control-plane/workflow-runtime'
import type { ObjectStore } from '@control-plane/deployment'
import type { LocalControlApiComposition } from './local-api-composition.js'

export interface LocalGraphOperationResources {
  readonly api: LocalControlApiComposition
  readonly persistence: SqlitePersistenceProvider
  readonly objectStore: ObjectStore
}

/** Server-owned configuration; graph input cannot register operations or schemas. */
export interface ManagedLocalGraphRuntimeOptions {
  readonly capabilities: readonly string[]
  readonly compiler: DeclarativeGraphCompilerOptions
  /** Must enforce the accepted plan's policy, approval, budget and durable effect receipts. */
  readonly operations:
    | GraphNodeOperationPort
    | ((resources: LocalGraphOperationResources) => GraphNodeOperationPort)
  /** Optional durable bootstrap that must finish before the Local service is ready. */
  readonly initialize?: (resources: LocalGraphOperationResources) => Promise<void>
}

/** Shares the catalog and compiler between admission and execution. Owns no database connection. */
export class ManagedLocalGraphRuntime {
  readonly authority: GraphDefinitionExecutionAuthority
  readonly #compiler: DeclarativeGraphCompiler
  readonly #resolver: CatalogBackedGraphDefinitionResolver
  readonly #persistence: SqlitePersistenceProvider
  readonly #operations: ManagedLocalGraphRuntimeOptions['operations']
  readonly #initialize: ManagedLocalGraphRuntimeOptions['initialize']
  readonly #objectStore: ObjectStore | undefined

  constructor(
    persistence: SqlitePersistenceProvider,
    options: ManagedLocalGraphRuntimeOptions,
    objectStore?: ObjectStore
  ) {
    if (typeof options.operations === 'function' && objectStore === undefined)
      throw new Error('LOCAL_GRAPH_OBJECT_STORE_REQUIRED')
    this.#objectStore = objectStore
    this.#persistence = persistence
    this.#operations = options.operations
    this.#initialize = options.initialize
    this.#compiler = new DeclarativeGraphCompiler(options.compiler)
    const environment = {
      capabilities: [...options.capabilities],
      contractMajorVersion: 1,
      compilerVersion: '1.0.0',
      adapterVersion: '1.4.12',
    }
    const repository = (workspaceId: string) =>
      new SqliteGraphDefinitionRepository(persistence, workspaceId)
    this.authority = new GraphDefinitionExecutionAuthority({
      repository,
      environment,
      validateDefinitionAndInput: (definition, input) => {
        try {
          return this.#compiler.validateInput(definition, input)
        } catch (error) {
          if (error instanceof DeclarativeGraphCompilationError) return false
          throw error
        }
      },
    })
    this.#resolver = new CatalogBackedGraphDefinitionResolver({
      catalogForWorkspace: (workspaceId) => new GraphDefinitionCatalog(repository(workspaceId)),
      compatibility: environment,
    })
  }

  async initialize(controlApi: LocalControlApiComposition): Promise<void> {
    if (this.#initialize === undefined) return
    if (this.#objectStore === undefined) throw new Error('LOCAL_GRAPH_OBJECT_STORE_REQUIRED')
    await this.#initialize({
      api: controlApi,
      persistence: this.#persistence,
      objectStore: this.#objectStore,
    })
  }

  activities(controlApi: LocalControlApiComposition, retentionMs?: number) {
    return new OrchestrationGraphSegmentActivities(
      new LangGraphOrchestrationAdapter({
        graphDefinitionResolver: this.#resolver,
        declarativeCompiler: this.#compiler,
        operations:
          typeof this.#operations === 'function'
            ? this.#operations({
                api: controlApi,
                persistence: this.#persistence,
                objectStore: this.#objectStore!,
              })
            : this.#operations,
        checkpointer: new LangGraphSqliteCheckpointSaver(this.#persistence, 'managed-graphs'),
        events: new DurableGraphEventPublisher({
          commands: controlApi.commandRepository,
          attempts: controlApi.executions,
          plans: controlApi.executionPlans,
          events: controlApi.executionEvents,
          ...(retentionMs === undefined ? {} : { retentionMs }),
        }),
      })
    )
  }
}
