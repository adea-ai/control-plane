import {
  CurrentModelAccountAuthorization,
  ModelConnectionAdministration,
  ModelSelectionService,
  type CurrentModelAccountAuthority,
  type ModelSelectionRepository,
} from '@control-plane/model-gateway'
import type { CredentialVault } from '@control-plane/credential-vault'
import { ConfiguredModelConnectionService } from './model-connections.service.js'

/** Explicit host composition. Missing current account authority fails closed; no
 * environment defaults, static qualification fallback or credential setup occurs.
 * Pass modelConnectionService to createControlApiApplication. R1 receives selections
 * through its execution-bound facade, alongside independent recorded spending authority.
 */
export function createCurrentModelConnectionComposition(options: {
  repository: ModelSelectionRepository
  vault: CredentialVault
  currentAccountAuthority: CurrentModelAccountAuthority
  now?: () => string
  fundingView?: ConstructorParameters<typeof ConfiguredModelConnectionService>[2]
}) {
  const authorization = new CurrentModelAccountAuthorization(
    options.currentAccountAuthority,
    options.now
  )
  const selections = new ModelSelectionService({
    repository: options.repository,
    vault: options.vault,
    qualification: authorization,
    ...(options.now ? { now: options.now } : {}),
  })
  const administration = new ModelConnectionAdministration({
    repository: options.repository,
    vault: options.vault,
    grants: authorization,
  })
  return {
    selections,
    administration,
    modelConnectionService: new ConfiguredModelConnectionService(
      selections,
      administration,
      options.fundingView
    ),
  }
}
