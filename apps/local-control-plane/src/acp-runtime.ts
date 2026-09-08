import {
  AcpAdapter,
  AcpDriver,
  AcpProcessTransport,
  type AcpDriverOptions,
  type AcpProcessTransportOptions,
} from '@control-plane/acp-adapter'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import type { LocalRuntimeTransport } from './composition.js'

export interface LocalAcpRuntimeOptions extends AcpProcessTransportOptions {
  readonly externalSessionId: AcpDriverOptions['externalSessionId']
  readonly interactionId: AcpDriverOptions['interactionId']
}

/** Explicit native harness configuration; does not install or authenticate the harness. */
export function createLocalAcpRuntime(options: LocalAcpRuntimeOptions): LocalRuntimeTransport {
  const processTransport = new AcpProcessTransport(options)
  const driver = new AcpDriver({
    transport: processTransport,
    protocolVersion: 1,
    adapterVersion: '1.2.2',
    externalSessionId: options.externalSessionId,
    interactionId: options.interactionId,
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
