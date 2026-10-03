import { isDeepStrictEqual } from 'node:util'
import type { GraphToolPin } from '@control-plane/contracts'
import type { ControlPlaneDatabase } from '@control-plane/database'
import type { ObjectStore } from '@control-plane/deployment'
import type {
  GraphCompatibilityEnvironment,
  PublishedGraphDefinition,
} from '@control-plane/orchestration'
import type { ExecutionGraphAuthority } from '@control-plane/execution-plan'
import { GraphDefinitionCatalog } from '@control-plane/orchestration'
import {
  PostgresCommandAcceptanceRepository,
  PostgresExecutionEventRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresGraphDefinitionRepository,
  PostgresInteractionRepository,
  verifyLangGraphCheckpointSchema,
} from '@control-plane/database'
import {
  createDeclarativeGraphAssembly,
  DurableGraphEventPublisher,
  LangGraphPostgresCheckpointProvider,
} from '@control-plane/langgraph-adapter'
import { OrchestrationGraphSegmentActivities } from '@control-plane/workflow-runtime'
import {
  HostedGraphToolOperations,
  type HostedGraphToolConfiguration,
  type HostedGraphToolOperationsOptions,
} from './hosted-graph-tool-operations.js'

export interface HostedServerGraphRuntimeOptions {
  readonly database: ControlPlaneDatabase
  readonly databaseUrl: string
  readonly objectStore: ObjectStore
  readonly configuration: HostedGraphToolConfiguration
  readonly now?: () => string
}

const COMPATIBILITY: GraphCompatibilityEnvironment = {
  capabilities: ['graph.tool-pins.v1'],
  contractMajorVersion: 1,
  compilerVersion: '1.0.0',
  adapterVersion: '1.4.12',
}

/** Real PostgreSQL checkpoint, catalog authority, event and effect assembly for Hosted Server. */
export class HostedServerGraphRuntime {
  readonly operations: HostedGraphToolOperations
  readonly activities: OrchestrationGraphSegmentActivities
  readonly authority: ExecutionGraphAuthority
  readonly #database: ControlPlaneDatabase
  readonly #checkpointer: LangGraphPostgresCheckpointProvider
  #started = false

  constructor(options: HostedServerGraphRuntimeOptions) {
    this.#database = options.database
    const plans = new PostgresExecutionPlanRepository(options.database)
    const executions = new PostgresExecutionRepository(options.database)
    const commands = new PostgresCommandAcceptanceRepository(options.database)
    const interactions = new PostgresInteractionRepository(options.database)
    this.#checkpointer = LangGraphPostgresCheckpointProvider.fromConnectionString(
      options.databaseUrl
    )
    const operationsOptions: HostedGraphToolOperationsOptions = {
      database: options.database,
      objectStore: options.objectStore,
      plans,
      executions,
      commands,
      interactions,
      configuration: options.configuration,
      ...(options.now === undefined ? {} : { now: options.now }),
    }
    this.operations = new HostedGraphToolOperations(operationsOptions)
    const graphRepository = (workspaceId: string) =>
      new PostgresGraphDefinitionRepository(options.database, workspaceId)
    const assembly = createDeclarativeGraphAssembly({
      repository: graphRepository,
      compatibility: COMPATIBILITY,
      operationAllowlist: [{ kind: 'tool', name: 'store' }],
      schemaRegistry: {
        getValidator(reference) {
          return reference === 'schema:json' ? isJsonObject : undefined
        },
      },
      checkpointer: this.#checkpointer.checkpointer,
      operations: this.operations,
      events: new DurableGraphEventPublisher({
        commands,
        attempts: executions,
        plans,
        events: new PostgresExecutionEventRepository(options.database),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      authorizeDefinitionAndInput: (definition) =>
        isHostedGraphDefinition(definition, this.operations.toolPin),
      compilerVersion: COMPATIBILITY.compilerVersion,
      adapterVersion: COMPATIBILITY.adapterVersion,
    })
    this.activities = new OrchestrationGraphSegmentActivities(assembly.orchestration)
    this.authority = {
      validate: async (workspaceId, selection) => {
        try {
          if (!(await assembly.authority.validate(workspaceId, selection))) return false
          await this.operations.ensureToolRegistered(workspaceId)
          return true
        } catch {
          return false
        }
      },
      authorize: async (workspaceId, reference) => {
        try {
          if (!(await assembly.authority.authorize(workspaceId, reference))) return false
          const definition = await new GraphDefinitionCatalog(
            graphRepository(workspaceId)
          ).getPinned(reference)
          if (!isHostedGraphDefinition(definition, this.operations.toolPin)) return false
          await this.operations.ensureToolRegistered(workspaceId)
          return true
        } catch {
          return false
        }
      },
    }
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('HOSTED_GRAPH_RUNTIME_ALREADY_STARTED')
    await verifyLangGraphCheckpointSchema(this.#database)
    await this.operations.pinConfiguration()
    this.#started = true
  }

  async close(): Promise<void> {
    this.#started = false
    await this.#checkpointer.close()
  }
}

export function isHostedGraphDefinition(
  definition: PublishedGraphDefinition,
  toolPin: GraphToolPin
): boolean {
  return (
    definition.content.schemas.input === 'schema:json' &&
    definition.content.schemas.state === 'schema:json' &&
    definition.content.schemas.output === 'schema:json' &&
    definition.content.requiredCapabilities.length === 1 &&
    definition.content.requiredCapabilities[0] === COMPATIBILITY.capabilities[0] &&
    definition.content.nodes.every(
      ({ operation }) =>
        operation.kind === 'tool' &&
        operation.name === 'store' &&
        operation.toolPin !== undefined &&
        isDeepStrictEqual(operation.toolPin, toolPin)
    )
  )
}

function isJsonObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
