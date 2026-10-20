// Deterministic managed-Pi client whose executions complete on first contact. Shared by
// the standalone composition suite and the self-hosted simple recovery suite, which
// configure a direct runtime transport and drive only the graph or lifecycle path.

const observedAt = '2026-08-30T12:00:00.000Z'

export class CompletedManagedPiClient {
  executions = new Map()

  async inspect() {
    return {
      driverVersion: '1.0.0',
      runtimeVersion: '0.52.1',
      protocolVersion: '1.0.0',
      health: 'healthy',
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
        { name: 'interaction.user-input', support: 'supported' },
        { name: 'interaction.approval', support: 'supported' },
        { name: 'filesystem.read', support: 'supported' },
      ],
      limitations: [],
      observedAt,
    }
  }

  async start(startCommand) {
    const handle = {
      handleId: `managed-pi:${startCommand.attemptId}`,
      attemptId: startCommand.attemptId,
      startedAt: observedAt,
    }
    this.executions.set(handle.handleId, handle)
    return handle
  }

  async *progress() {
    yield { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'running' }
    yield { sequence: 2, occurredAt: observedAt, kind: 'output', text: 'completed' }
    yield {
      sequence: 3,
      occurredAt: observedAt,
      kind: 'usage',
      inputTokens: 3,
      outputTokens: 2,
      durationMs: 10,
    }
    yield { sequence: 4, occurredAt: observedAt, kind: 'status', state: 'succeeded' }
  }

  async status(handle) {
    this.#require(handle)
    return {
      state: 'succeeded',
      observedAt,
      result: {
        output: { ok: true },
        usage: { inputTokens: 3, outputTokens: 2, durationMs: 10 },
        artifacts: [],
      },
    }
  }

  submitInput(handle) {
    return this.status(handle)
  }

  submitApproval(handle) {
    return this.status(handle)
  }

  async cancel(handle, request) {
    this.#require(handle)
    return { state: 'cancelled', observedAt: request.requestedAt }
  }

  reconcile(handle) {
    return this.status(handle)
  }

  async session() {
    throw new Error('CAPABILITY_UNSUPPORTED')
  }

  async cleanup(handle) {
    this.#require(handle)
  }

  #require(handle) {
    if (!this.executions.has(handle.handleId)) throw new Error('MANAGED_PI_EXECUTION_MISSING')
  }
}
