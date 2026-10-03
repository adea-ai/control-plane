import { GraphDefinitionCatalog } from '@control-plane/orchestration'
import {
  GraphDefinitionExecutionAuthority,
  type GraphCompatibilityEnvironment,
  type GraphDefinitionRepository,
  type GraphNodeOperationPort,
  type GraphEventPublisher,
} from '@control-plane/orchestration'
import type { GraphInput } from '@control-plane/contracts'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import {
  CatalogBackedGraphDefinitionResolver,
  DeclarativeGraphCompiler,
  LangGraphOrchestrationAdapter,
  type DeclarativeGraphCompilerOptions,
  type GraphSchemaRegistry,
} from './index.js'

export interface DeclarativeGraphAssemblyOptions {
  readonly repository: (workspaceId: string) => GraphDefinitionRepository
  readonly compatibility: GraphCompatibilityEnvironment
  readonly operationAllowlist: DeclarativeGraphCompilerOptions['operationAllowlist']
  readonly schemaRegistry: GraphSchemaRegistry
  readonly checkpointer: BaseCheckpointSaver
  readonly operations: GraphNodeOperationPort
  readonly events: GraphEventPublisher
  /** Additional server policy for catalog-owned definitions and inputs. */
  readonly authorizeDefinitionAndInput?: (
    definition: Parameters<
      GraphDefinitionExecutionAuthority['options']['validateDefinitionAndInput']
    >[0],
    input: GraphInput
  ) => boolean | Promise<boolean>
  readonly maximumSteps?: number
  readonly compilerVersion?: string
  readonly adapterVersion?: string
}

/** Builds one provider-neutral resolver/compiler pair for admission and execution. */
export function createDeclarativeGraphAssembly(options: DeclarativeGraphAssemblyOptions) {
  const compiler = new DeclarativeGraphCompiler({
    operationAllowlist: options.operationAllowlist,
    schemaRegistry: options.schemaRegistry,
    ...(options.maximumSteps === undefined ? {} : { maximumSteps: options.maximumSteps }),
  })
  const validateDefinitionAndInput = async (
    definition: Parameters<
      GraphDefinitionExecutionAuthority['options']['validateDefinitionAndInput']
    >[0],
    input: GraphInput
  ) => {
    let registration
    try {
      registration = compiler.compile(definition)
    } catch {
      return false
    }
    if (registration.validateInput?.(input) !== true) return false
    return (await options.authorizeDefinitionAndInput?.(definition, input)) ?? true
  }
  const authority = new GraphDefinitionExecutionAuthority({
    repository: options.repository,
    environment: options.compatibility,
    validateDefinitionAndInput,
  })
  const resolver = new CatalogBackedGraphDefinitionResolver({
    catalogForWorkspace: (workspaceId) =>
      new GraphDefinitionCatalog(options.repository(workspaceId)),
    compatibility: options.compatibility,
  })
  const orchestration = new LangGraphOrchestrationAdapter({
    graphDefinitionResolver: resolver,
    declarativeCompiler: compiler,
    operations: options.operations,
    events: options.events,
    checkpointer: options.checkpointer,
    ...(options.compilerVersion === undefined ? {} : { compilerVersion: options.compilerVersion }),
    ...(options.adapterVersion === undefined ? {} : { adapterVersion: options.adapterVersion }),
  })
  return { authority, compiler, orchestration, resolver }
}
