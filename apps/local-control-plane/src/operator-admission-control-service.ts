import {
  AdmissionControlCommandResultSchema,
  type AdmissionControlCommandResult,
  type AdmissionResumeCommand,
  type AdmissionStopCommand,
  type ServicePrincipal,
} from '@control-plane/contracts'
import type { AdmissionControlService } from '@control-plane/control-api'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  clearWorkflowAdmissionStop,
  setWorkflowAdmissionStop,
} from './operator-admission-controls.js'

/**
 * The local composition's reachable admission stop/resume control. The actor
 * is the authenticated principal the private-API guard produced and the scope
 * is the envelope workspace; every outcome is the audit record that
 * `operator-admission-controls` commits in the same transaction as the state
 * change, so duplicates and replays are successful, idempotent results.
 *
 * Enforcement lives on the embedded workflow queue (the `beforeEnqueue` gate
 * composed in `composition.ts`). A composition whose durable execution mode
 * does not route new-job admission through that queue must report the control
 * unavailable instead of recording a stop that nothing would enforce — an
 * unenforced stop could never produce real failure evidence.
 */
export class LocalAdmissionControlService implements AdmissionControlService {
  readonly #persistence: PersistenceProvider
  readonly #enforcement: 'embedded-queue' | 'unavailable'

  constructor(options: {
    readonly persistence: PersistenceProvider
    readonly enforcement?: 'embedded-queue' | 'unavailable'
  }) {
    this.#persistence = options.persistence
    this.#enforcement = options.enforcement ?? 'embedded-queue'
  }

  stop(
    input: AdmissionStopCommand,
    principal: ServicePrincipal
  ): Promise<AdmissionControlCommandResult> {
    return this.#apply('stop', input, principal)
  }

  resume(
    input: AdmissionResumeCommand,
    principal: ServicePrincipal
  ): Promise<AdmissionControlCommandResult> {
    return this.#apply('resume', input, principal)
  }

  async #apply(
    action: 'stop' | 'resume',
    input: AdmissionStopCommand | AdmissionResumeCommand,
    principal: ServicePrincipal
  ): Promise<AdmissionControlCommandResult> {
    if (this.#enforcement !== 'embedded-queue') {
      throw new Error('ADMISSION_CONTROL_RUNTIME_UNAVAILABLE')
    }
    const outcome = await (
      action === 'stop' ? setWorkflowAdmissionStop : clearWorkflowAdmissionStop
    )(this.#persistence, {
      actor: principal,
      scope: { kind: 'workspace', workspaceId: input.workspaceId },
      commandId: input.commandId,
      reasonClass: input.payload.reasonClass,
      ...(input.payload.reason === undefined ? {} : { reason: input.payload.reason }),
      at: input.issuedAt,
    })
    // The HTTP scope is always a workspace, so the typed global-scope
    // unavailable can never be reached here; failing loudly keeps it that way.
    if (outcome.status !== 'ok') throw new Error('ADMISSION_CONTROL_SCOPE_GLOBAL_UNSUPPORTED')
    return AdmissionControlCommandResultSchema.parse({
      contractVersion: input.contractVersion,
      requestId: input.requestId,
      correlation: input.correlation,
      data: {
        commandId: input.commandId,
        workspaceId: input.workspaceId,
        operation: input.operation,
        outcome: outcome.outcome,
        admission: outcome.state.status,
      },
    })
  }
}
