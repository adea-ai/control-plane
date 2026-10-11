import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'

/** Repository-pinned Pi Durable 1.1.0 / pi-ai 1.1.0 catalog. Installed package metadata only:
 * no credential, registry closure or provider object is exposed. Membership never grants
 * authentication, entitlement, quota or residency.
 */
export const piDurableRegistryMetadata = Object.freeze({
  piAiVersion: '1.1.0',
  piDurableVersion: '1.1.0',
  sourceRevision: '1cedd32724abfcb0915f76cc61b6827e2c16dbad',
  getModels: () => openaiProvider().getModels(),
})
