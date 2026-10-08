import {
  CurrentModelAccountEvidenceSchema,
  type CurrentModelAccountAuthority,
} from './current-authority.js'
import { ModelSelectionError } from './selection-service.js'

export interface PiDurableRegistryMetadata {
  readonly piAiVersion: string
  readonly piDurableVersion: string
  readonly sourceRevision: string
  /** Metadata from the supported Pi provider.getModels() abstraction. No auth, registry closure or secret. */
  getModels(): readonly { readonly id: string; readonly provider: string; readonly api: string }[]
}

/** First qualified transport: exact reviewed Pi1.1.0 OpenAI Responses/API-key/remote-host.
 * Registry membership never establishes entitlement, quota, residency or funding.
 * The authenticated account reader is invoked on EVERY boundary, including retries/reopen.
 */
export function createPiDurableAccountAuthority(options: {
  registry: PiDurableRegistryMetadata
  currentAccount: CurrentModelAccountAuthority
}): CurrentModelAccountAuthority {
  function assertPin() {
    if (
      options.registry.piAiVersion !== '1.1.0' ||
      options.registry.piDurableVersion !== '1.1.0' ||
      options.registry.sourceRevision !== '1cedd32724abfcb0915f76cc61b6827e2c16dbad'
    )
      throw new ModelSelectionError('INCOMPATIBLE_HARNESS')
  }
  assertPin()
  return {
    async readCurrent(input) {
      try {
        assertPin()
        const current = CurrentModelAccountEvidenceSchema.parse(
          await options.currentAccount.readCurrent(input)
        )
        assertPin()
        if (
          current.provider !== 'openai' ||
          current.authKind !== 'api_key' ||
          current.fundingSource !== 'byo_api'
        )
          throw new ModelSelectionError('AUTH_MODE_UNSUPPORTED')
        const raw = options.registry.getModels()
        const compatible = raw.filter(
          (model) =>
            model.provider === 'openai' &&
            model.api === 'openai-responses' &&
            typeof model.id === 'string' &&
            model.id.length > 0 &&
            model.id.length <= 256
        )
        if (new Set(compatible.map((model) => model.id)).size !== compatible.length)
          throw new ModelSelectionError('READINESS_UNAVAILABLE')
        const registered = new Set(compatible.map((model) => model.id))
        const models = current.models.filter((model) => registered.has(model))
        if (!models.length) throw new ModelSelectionError('MODEL_UNAVAILABLE')
        const harnesses = current.targets.filter(
          (target) =>
            target.harness === 'pi_durable' &&
            target.harnessVersion === '1.1.0' &&
            target.providerBinding === 'pi_durable_models'
        )
        if (!harnesses.length) throw new ModelSelectionError('INCOMPATIBLE_HARNESS')
        const targets = harnesses.filter((target) => target.location === 'remote_host')
        if (!targets.length) throw new ModelSelectionError('INCOMPATIBLE_LOCATION')
        return CurrentModelAccountEvidenceSchema.parse({ ...current, models, targets })
      } catch (error) {
        if (error instanceof ModelSelectionError) throw error
        throw new ModelSelectionError('READINESS_UNAVAILABLE')
      }
    },
  }
}
