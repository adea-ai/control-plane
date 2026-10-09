import type { PersistenceProvider } from '@control-plane/deployment'
import {
  PersistenceProviderAcpRemoteDeviceStateStore,
  acpRemoteDeviceStateScope,
} from './acp-remote-device-state.ts'
import {
  SecureAcpDeviceEndpoint,
  type SecureAcpDeviceEndpointOptions,
} from './acp-remote-transport.ts'

/**
 * Production construction of the secure device route.
 *
 * Unlike `SecureAcpDeviceEndpoint`'s in-memory default (a test seam), this factory ALWAYS builds
 * the durable `PersistenceProviderAcpRemoteDeviceStateStore` over the caller's real
 * `PersistenceProvider`, scoped by the authenticated route identity
 * (`acpRemoteDeviceStateScope(route)`), so a production composition cannot accidentally run with a
 * non-durable fence: revocation, the highest accepted channel generation, and the replay ledger
 * survive restarts and are enforced atomically inside the store's transaction.
 */
export type PersistentSecureAcpDeviceEndpointOptions = Omit<
  SecureAcpDeviceEndpointOptions,
  'stateStore'
> & {
  readonly provider: PersistenceProvider
}

/** Constructs a device endpoint whose fence state is durable over the supplied provider. */
export function createPersistentSecureAcpDeviceEndpoint(
  options: PersistentSecureAcpDeviceEndpointOptions
): SecureAcpDeviceEndpoint {
  const { provider, ...endpoint } = options
  return new SecureAcpDeviceEndpoint({
    ...endpoint,
    stateStore: new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(options.route)
    ),
  })
}
