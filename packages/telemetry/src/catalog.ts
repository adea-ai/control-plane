export const executionTraceSpans = [
  'execution.root',
  'plan.compile',
  'workflow.run',
  'runtime.route',
  'runtime.start',
  'graph.run',
  'graph.node',
  'model.call',
  'tool.authorize',
  'tool.execute',
  'sandbox.execute',
  'approval.wait',
  'artifact.promote',
  'usage.settle',
  'execution.cleanup',
] as const

export const operationalMetrics = [
  'control.api.request.duration',
  'control.api.error.count',
  'control.command_inbox.duplicate.count',
  'control.command_inbox.conflict.count',
  'workflow.backlog.count',
  'workflow.replay.count',
  'runtime.available.count',
  'runtime.gateway.connection.count',
  'runtime.gateway.ack.duration',
  'model.call.duration',
  'model.call.error.count',
  'tool.call.duration',
  'tool.call.error.count',
  'execution.reconciliation.count',
  'execution.manual_intervention.count',
  'context.provider_resolution.count',
  'memory.write.decision.count',
  'control.event.quarantine.count',
  'usage.cost.usd',
] as const

export type ExecutionTraceSpanName = (typeof executionTraceSpans)[number]
export type OperationalMetricName = (typeof operationalMetrics)[number]

export interface DiagnosticQuery {
  readonly failureClass: 'application' | 'workflow' | 'gateway' | 'runtime' | 'provider' | 'policy'
  readonly signals: readonly string[]
  readonly correlateBy: readonly string[]
}

export const diagnosticQueries: readonly DiagnosticQuery[] = [
  {
    failureClass: 'application',
    signals: [
      'control.api.error.count',
      'control.api.request.duration',
      'service.name=control-api',
    ],
    correlateBy: ['control.correlation_id', 'workspace.id', 'execution.id'],
  },
  {
    failureClass: 'workflow',
    signals: ['workflow.backlog.count', 'workflow.replay.count', 'span.name=workflow.run'],
    correlateBy: ['workflow.id', 'execution.id', 'execution.attempt.id'],
  },
  {
    failureClass: 'gateway',
    signals: [
      'runtime.gateway.connection.count',
      'runtime.gateway.ack.duration',
      'service.name=runtime-gateway',
    ],
    correlateBy: ['runtime.node.id', 'runtime.id', 'execution.id'],
  },
  {
    failureClass: 'runtime',
    signals: ['runtime.available.count', 'span.name=runtime.route', 'span.name=runtime.start'],
    correlateBy: ['runtime.id', 'runtime.node.id', 'execution.id'],
  },
  {
    failureClass: 'provider',
    signals: [
      'model.call.error.count',
      'tool.call.error.count',
      'span.name=model.call OR span.name=tool.execute',
    ],
    correlateBy: ['gen_ai.request.model', 'tool.id', 'execution.id'],
  },
  {
    failureClass: 'policy',
    signals: ['span.name=tool.authorize', 'event=policy.denied', 'event=approval.waiting'],
    correlateBy: ['policy.version', 'tool.id', 'execution.id'],
  },
] as const
