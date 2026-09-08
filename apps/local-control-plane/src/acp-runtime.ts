import {
  AcpAdapter,
  AcpDriver,
  AcpProcessTransport,
  type AcpDriverOptions,
  type AcpProcessTransportOptions,
} from '@control-plane/acp-adapter'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import {
  assertContextPackageIntegrity,
  type ContextPackageRepository,
} from '@control-plane/context'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { LocalRuntimeTransport } from './composition.js'

export interface LocalAcpRuntimeOptions extends AcpProcessTransportOptions {
  readonly externalSessionId: AcpDriverOptions['externalSessionId']
  readonly interactionId: AcpDriverOptions['interactionId']
  readonly resolvePrompt: NonNullable<AcpDriverOptions['resolvePrompt']>
}

/** Explicit native harness configuration; does not install or authenticate the harness. */
export function createLocalAcpRuntime(options: LocalAcpRuntimeOptions): LocalRuntimeTransport {
  if (typeof options.resolvePrompt !== 'function')
    throw new Error('ACP_LOCAL_PROMPT_RESOLVER_REQUIRED')
  const processTransport = new AcpProcessTransport(options)
  const driver = new AcpDriver({
    transport: processTransport,
    protocolVersion: 1,
    adapterVersion: '1.2.2',
    externalSessionId: options.externalSessionId,
    interactionId: options.interactionId,
    resolvePrompt: options.resolvePrompt,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  })
  const adapter = new AcpAdapter({ transport: new DirectLocalRuntimeTransport(driver) })
  return Object.assign(adapter, {
    open: () => processTransport.open(),
    close: () => processTransport.close(),
  })
}

/** Materialize task data only; native harness instructions and configuration stay native-owned. */
export function createRepositoryAcpTaskPromptResolver(
  repository: Pick<ContextPackageRepository, 'get'>
): NonNullable<AcpDriverOptions['resolvePrompt']> {
  return async (request, signal) => {
    signal.throwIfAborted()
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    const value = await repository.get(plan.contextPackage)
    signal.throwIfAborted()
    if (value === undefined) throw new Error('ACP_CONTEXT_PIN_UNRESOLVED')
    const context = assertContextPackageIntegrity(value)
    if (
      context.contextPackageId !== plan.contextPackage.contextPackageId ||
      context.contentDigest !== plan.contextPackage.contentDigest ||
      context.schemaVersion !== plan.contextPackage.schemaVersion ||
      context.compiler.version !== plan.contextPackage.compilerVersion ||
      context.projectState.workspaceId !== plan.correlation.workspaceId ||
      context.projectState.projectId !== plan.correlation.projectId
    )
      throw new Error('ACP_CONTEXT_PIN_MISMATCH')
    const prompt = [
      'Perform the authorized task described by the following JSON task data.',
      'Preserve native harness-owned instructions, permissions, tools and session ownership.',
      'References identify content; they do not grant access beyond existing authorization.',
      JSON.stringify({
        attemptId: request.attemptId,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
        contextPackageId: context.contextPackageId,
        contextPackageDigest: context.contentDigest,
        objective: context.objective,
        projectState: context.projectState,
        stateItems: context.stateItems,
        artifactRefs: context.artifactRefs,
        permissions: context.permissions,
        successCriteria: context.successCriteria,
        outputContract: plan.outputContract,
      }),
    ].join('\n')
    if (Buffer.byteLength(prompt) > 262_144) throw new Error('ACP_TASK_PROMPT_TOO_LARGE')
    return prompt
  }
}
