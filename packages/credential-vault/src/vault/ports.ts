import { Context } from 'effect'
import type { PolicyDecisionPoint } from '@control-plane/policy'
import type { SecretProvider } from '../index.js'

/**
 * The existing constructor-injected ports (SecretProvider, PolicyDecisionPoint,
 * injectable clock) expressed as Effect services so the engine can require them
 * in its R channel. The ports themselves are unchanged public types.
 */

export class Clock extends Context.Tag('credential-vault/Clock')<Clock, { readonly now: () => string }>() {}

export class SecretProviderPort
  extends Context.Tag('credential-vault/SecretProviderPort')<SecretProviderPort, SecretProvider>()
{}

export class PolicyPort
  extends Context.Tag('credential-vault/PolicyPort')<PolicyPort, PolicyDecisionPoint>()
{}
