import {
  createPiDurableAccountAuthority,
  type PiDurableRegistryMetadata,
} from '@control-plane/model-gateway'
import { piDurableRegistryMetadata } from '@control-plane/pi-durable-adapter'
import type { createCurrentModelConnectionComposition } from './current-model-composition.js'

type ModelConnectionOptions = Parameters<typeof createCurrentModelConnectionComposition>[0]

/** Product BYO eligibility is always intersected with the repository-pinned Pi catalog before any
 * selection, readiness or inference read. The host supplies only an authenticated current account
 * reader; it cannot widen the models, harness, location or provider the reader reports.
 */
export function pinModelConnectionOptions(
  options: ModelConnectionOptions,
  registry: PiDurableRegistryMetadata = piDurableRegistryMetadata
): ModelConnectionOptions {
  return {
    ...options,
    currentAccountAuthority: createPiDurableAccountAuthority({
      registry,
      currentAccount: options.currentAccountAuthority,
    }),
  }
}
