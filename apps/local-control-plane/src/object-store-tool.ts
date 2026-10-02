import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import type { ObjectStore } from '@control-plane/deployment'
import { ToolExecutorError, type ToolExecutor } from '@control-plane/tool-sdk'

/** Concrete server-owned tool: callers provide JSON, never a filesystem path or object key. */
export class ObjectStoreJsonToolExecutor implements ToolExecutor {
  constructor(readonly store: ObjectStore) {}

  async execute(
    request: Parameters<ToolExecutor['execute']>[0],
    version: Parameters<ToolExecutor['execute']>[1],
    signal: AbortSignal
  ) {
    if (signal.aborted) throw new ToolExecutorError('CANCELLED', false, 'none')
    if (
      request.operation !== 'store-json' ||
      version.executor.type !== 'internal' ||
      version.executor.reference !== 'local.object-store-json.v1'
    ) {
      throw new ToolExecutorError('TOOL_BINDING_MISMATCH', false, 'none')
    }
    if (!this.store.putIfAbsent) {
      throw new ToolExecutorError('IMMUTABLE_OBJECT_STORE_REQUIRED', false, 'none')
    }
    const body = new TextEncoder().encode(canonicalJsonStringify(request.input))
    const contentDigest = 'sha256:' + createHash('sha256').update(body).digest('hex')
    const key = ['tool-effects', request.workspaceId, request.executionId, request.requestId].join(
      '/'
    )
    const metadata = { workspace: request.workspaceId, execution: request.executionId }
    try {
      const creation = await this.store.putIfAbsent({
        key,
        body,
        contentType: 'application/json',
        metadata,
      })
      if (creation.outcome === 'exists') {
        const existing = await this.store.get(key)
        if (
          existing.sha256 !== contentDigest ||
          existing.size !== body.byteLength ||
          existing.metadata['workspace'] !== request.workspaceId ||
          existing.metadata['execution'] !== request.executionId
        ) {
          throw new ToolExecutorError('OBJECT_EFFECT_CONFLICT', false, 'committed')
        }
      } else if (
        creation.object.sha256 !== contentDigest ||
        creation.object.size !== body.byteLength ||
        creation.object.metadata['workspace'] !== request.workspaceId ||
        creation.object.metadata['execution'] !== request.executionId
      ) {
        throw new ToolExecutorError('OBJECT_EFFECT_INVALID', false, 'committed')
      }
      // Persisted writes remain successful even when cancellation arrives after their commit.
      return { output: { contentDigest, size: body.byteLength } }
    } catch (error) {
      if (error instanceof ToolExecutorError) throw error
      throw new ToolExecutorError('OBJECT_EFFECT_UNCONFIRMED', false, 'unknown')
    }
  }
}
