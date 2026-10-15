import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { CanonicalDelegationRuntimeBridge } from '../packages/orchestration/src/delegation-runtime.ts'
import { createGovernedChildCompositionFixture } from './pi-durable-governed-child-composition.fixture.mjs'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import { SqliteToolCallRepository } from '../packages/sqlite-persistence/src/tool-repositories.ts'
import { SqliteDelegationRepository } from '../packages/sqlite-persistence/src/delegation-repository.ts'
import {
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
} from '../packages/sqlite-persistence/src/repositories.ts'

/** Actual existing Pi/HTTP/approval/ledger fixture. Only mapping faults and
 * metadata-read qualification are test controlled; no spend grant is invented.
 */
export async function withChildMappingRecovery(
  run,
  { beforeNative = false, lostAck = false } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'child-mapping-adversarial-'))
  let f
  let provider
  try {
    f = await createGovernedChildCompositionFixture(directory, {
      transactionalChildAdmission: true,
    })
    let faulted = false
    const writer = new Proxy(f.storage.delegations, {
      get(target, key) {
        if (key === 'bindChildSession')
          return async (...args) => {
            if (!faulted) {
              faulted = true
              if (lostAck) await target.bindChildSession(...args)
              throw new Error('TEST_MAPPING_ACK_OR_WRITE_LOST')
            }
            return target.bindChildSession(...args)
          }
        const value = target[key]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    f.host.executor.options.bridge = new CanonicalDelegationRuntimeBridge({
      ...f.host.bridgeOptions,
      childReceipts: writer,
      terminalPublisher: f.storage.events,
      ...(beforeNative
        ? {
            runtime: {
              async start() {
                throw new Error('TEST_CRASH_BEFORE_NATIVE_ADMISSION')
              },
            },
          }
        : {}),
    })
    await f.leadRuntime.adapter.start(f.leadRequest)
    await f.leadRuntime.adapter.drain()
    await f.childRuntime.adapter.drain()
    provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
    await provider.migrate()
    const records = new SqliteDelegationRepository(provider)
    const calls = new SqliteToolCallRepository(provider, f.ids.workspaceId)
    const snapshot = await records.getChildRuntimeStart(f.ids.delegationId)
    const mapping = await records.getChildMapping(f.ids.childAttemptId)
    const handle = await f.childRuntime.adapter.findExistingHandle(snapshot.receipt.request)
    const control = {
      allowed: true,
      qualified: true,
      revision: 1,
      at: '2026-08-25T18:02:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      lookups: 0,
      reads: 0,
      qualifications: 0,
      afterLookup: undefined,
      inTransaction: undefined,
      bindingPatch: {},
    }
    let capturedReader
    const authority = {
      readerPrincipalId: 'svc_product-reader',
      audienceRef: 'scope:workspace-lead',
      now: () => control.at,
      async assertQualified(scope) {
        control.qualifications++
        assert.equal(scope.workspaceId, f.ids.workspaceId)
        assert.equal(scope.runtimeConnectionId, f.host.bridgeOptions.runtimeConnectionId)
        if (!control.qualified || scope.nativeReceiptReader !== options.nativeReceiptReader)
          throw new Error('TEST_READ_AUTHORITY_UNQUALIFIED')
      },
      async assertCurrent(receipt, reader) {
        control.reads++
        if (reader) {
          capturedReader = reader
          await control.inTransaction?.(reader)
        }
        const call = reader
          ? await reader.getToolCall(f.host.request.toolCallId)
          : await calls.get(f.host.request.toolCallId)
        assert.equal(receipt.originalActorPrincipalId, f.actor)
        assert.equal(receipt.originalActorPrincipalId, call.principalRef)
        if (!control.allowed || !f.state.active.lead || !f.state.active.child)
          throw new Error('TEST_RECEIPT_READ_REVOKED')
        return {
          workspaceId: receipt.workspaceId,
          runtimeConnectionId: receipt.runtimeConnectionId,
          originalActorPrincipalId: receipt.originalActorPrincipalId,
          readerPrincipalId: 'svc_product-reader',
          audienceRef: 'scope:workspace-lead',
          authorityRevision: control.revision,
          expiresAt: control.expiresAt,
          ...control.bindingPatch,
        }
      },
    }
    const forbidden = async () => {
      throw new Error('TEST_REPAIR_CALLED_EFFECT_OR_SPEND')
    }
    const options = {
      ...f.host.bridgeOptions,
      records,
      childReceipts: records,
      lifecycle: new ExecutionLifecycleService(new SqliteExecutionRepository(provider)),
      plans: new SqliteExecutionPlanRepository(provider),
      terminalPublisher: f.storage.events,
      runtime: { start: forbidden },
      assertAuthority: forbidden,
      reserveBudget: forbidden,
      nativeReceiptReader: {
        runtimeConnectionId: f.host.bridgeOptions.runtimeConnectionId,
        async findExistingHandle(request) {
          control.lookups++
          const result = await f.childRuntime.adapter.findExistingHandle(request)
          await control.afterLookup?.()
          return result
        },
      },
      receiptReadAuthority: authority,
    }
    const baseline = {
      usage: await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId),
      call: await f.storage.calls.get(f.host.request.toolCallId),
      requests: f.child.requests.length,
      starts: f.host.starts.length,
      publications: await f.storage.publications.list(),
    }
    await run({
      f,
      canonicalPath: join(directory, 'canonical.sqlite'),
      provider,
      records,
      snapshot,
      mapping,
      handle,
      control,
      options,
      authority,
      bridge: new CanonicalDelegationRuntimeBridge(options),
      get reader() {
        return capturedReader
      },
      async assertNoOtherEffects() {
        assert.deepEqual(
          await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId),
          baseline.usage
        )
        assert.deepEqual(await f.storage.calls.get(f.host.request.toolCallId), baseline.call)
        assert.equal(f.child.requests.length, baseline.requests)
        assert.equal(f.host.starts.length, baseline.starts)
        assert.deepEqual(await f.storage.publications.list(), baseline.publications)
      },
    })
  } finally {
    await provider?.close()
    await f?.close()
    await rm(directory, { recursive: true, force: true })
  }
}
