import {
  EvalRunSchema,
  type EvalRun,
  type EvaluationMetric,
  type EvaluationMetricValues,
} from './evaluations.js'
import { z } from 'zod'

export interface ReleaseGateDecision {
  readonly releaseGateId: string
  readonly candidateRunId: string
  readonly baselineRunId: string
  readonly status: 'blocked' | 'passed'
  readonly reasons: readonly string[]
  readonly evaluatedAt: string
}

export interface ReleaseAuditRecord {
  readonly releaseAuditId: string
  readonly releaseGateId: string
  readonly action: 'promote' | 'rollback'
  readonly actor: string
  readonly fromRunId?: string | undefined
  readonly toRunId: string
  readonly reason?: string | undefined
  readonly at: string
}

export const ReleaseAuditRecordSchema = z
  .object({
    releaseAuditId: z.string().uuid(),
    releaseGateId: z.string().min(1).max(256),
    action: z.enum(['promote', 'rollback']),
    actor: z.string().min(1).max(256),
    fromRunId: z.string().min(1).max(256).optional(),
    toRunId: z.string().min(1).max(256),
    reason: z.string().min(1).max(256).optional(),
    at: z.iso.datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.action === 'promote' && record.reason !== undefined) {
      context.addIssue({ code: 'custom', message: 'Promotion records cannot include a reason' })
    }
    if (record.action === 'rollback' && record.reason === undefined) {
      context.addIssue({ code: 'custom', message: 'Rollback records require a reason' })
    }
  })

export interface ReleaseAuditRepository {
  append(record: ReleaseAuditRecord): Promise<void>
  list(releaseGateId?: string): Promise<readonly ReleaseAuditRecord[]>
}

export class InMemoryReleaseAuditRepository implements ReleaseAuditRepository {
  readonly #records: ReleaseAuditRecord[] = []

  async append(value: ReleaseAuditRecord): Promise<void> {
    const record = ReleaseAuditRecordSchema.parse(value)
    if (this.#records.some(({ releaseAuditId }) => releaseAuditId === record.releaseAuditId)) {
      throw new Error('RELEASE_AUDIT_CONFLICT')
    }
    this.#records.push(clone(record))
  }

  async list(releaseGateId?: string): Promise<readonly ReleaseAuditRecord[]> {
    return clone(
      releaseGateId === undefined
        ? this.#records
        : this.#records.filter((record) => record.releaseGateId === releaseGateId)
    )
  }
}

interface GateState {
  readonly candidate: EvalRun
  readonly baseline: EvalRun
  readonly decision: ReleaseGateDecision
  promoted?: EvalRun
}

const lowerIsBetter = new Set<EvaluationMetric>(['latency_ms', 'cost_usd', 'tokens'])

export class ReleaseGateRegistry {
  readonly #now: () => string
  readonly #createId: () => string
  readonly #auditRepository: ReleaseAuditRepository
  readonly #gates = new Map<string, GateState>()

  constructor(
    options: {
      readonly now?: () => string
      readonly createId?: () => string
      readonly auditRepository?: ReleaseAuditRepository
    } = {}
  ) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? (() => crypto.randomUUID())
    this.#auditRepository = options.auditRepository ?? new InMemoryReleaseAuditRepository()
  }

  evaluate(input: {
    readonly releaseGateId: string
    readonly candidate: EvalRun
    readonly baseline: EvalRun
    readonly maximumRegressions: EvaluationMetricValues
  }): ReleaseGateDecision {
    const candidateRun = EvalRunSchema.parse(input.candidate)
    const baselineRun = EvalRunSchema.parse(input.baseline)
    const reasons = candidateRun.results.flatMap(({ failedRequiredMetrics }) =>
      failedRequiredMetrics.map((metric) => `REQUIRED_THRESHOLD_FAILED:${metric}`)
    )
    if (JSON.stringify(candidateRun.suite) !== JSON.stringify(baselineRun.suite)) {
      reasons.push('INCOMPARABLE_BASELINE:suite')
    }
    for (const [metric, maximum] of Object.entries(input.maximumRegressions) as [
      EvaluationMetric,
      number,
    ][]) {
      if (!Number.isFinite(maximum) || maximum < 0) throw new Error('INVALID_REGRESSION_BUDGET')
      const candidate = candidateRun.aggregateMetrics[metric]
      const baseline = baselineRun.aggregateMetrics[metric]
      if (candidate === undefined || baseline === undefined) {
        reasons.push(`MISSING_COMPARISON_METRIC:${metric}`)
      } else if (relativeRegression(metric, candidate, baseline) > maximum) {
        reasons.push(`REGRESSION:${metric}`)
      }
    }
    const decision: ReleaseGateDecision = {
      releaseGateId: input.releaseGateId,
      candidateRunId: candidateRun.evalRunId,
      baselineRunId: baselineRun.evalRunId,
      status: reasons.length === 0 ? 'passed' : 'blocked',
      reasons: [...new Set(reasons)].sort(),
      evaluatedAt: this.#now(),
    }
    const promoted = this.#gates.get(input.releaseGateId)?.promoted
    this.#gates.set(input.releaseGateId, {
      candidate: clone(candidateRun),
      baseline: clone(baselineRun),
      decision,
      ...(promoted === undefined ? {} : { promoted: clone(promoted) }),
    })
    return clone(decision)
  }

  async promote(releaseGateId: string, actor: string): Promise<ReleaseAuditRecord> {
    const gate = this.#gate(releaseGateId)
    if (gate.decision.status !== 'passed') throw new Error('RELEASE_GATE_BLOCKED')
    const record: ReleaseAuditRecord = {
      releaseAuditId: this.#createId(),
      releaseGateId,
      action: 'promote',
      actor,
      ...(gate.promoted === undefined ? {} : { fromRunId: gate.promoted.evalRunId }),
      toRunId: gate.candidate.evalRunId,
      at: this.#now(),
    }
    const parsed = ReleaseAuditRecordSchema.parse(record)
    await this.#auditRepository.append(parsed)
    gate.promoted = clone(gate.candidate)
    return clone(parsed)
  }

  async rollback(
    releaseGateId: string,
    actor: string,
    reason: string
  ): Promise<ReleaseAuditRecord> {
    const gate = this.#gate(releaseGateId)
    const record: ReleaseAuditRecord = {
      releaseAuditId: this.#createId(),
      releaseGateId,
      action: 'rollback',
      actor,
      ...(gate.promoted === undefined ? {} : { fromRunId: gate.promoted.evalRunId }),
      toRunId: gate.baseline.evalRunId,
      reason: reason.slice(0, 256),
      at: this.#now(),
    }
    const parsed = ReleaseAuditRecordSchema.parse(record)
    await this.#auditRepository.append(parsed)
    gate.promoted = clone(gate.baseline)
    return clone(parsed)
  }

  candidate(releaseGateId: string): EvalRun {
    return clone(this.#gate(releaseGateId).candidate)
  }

  promoted(releaseGateId: string): EvalRun | undefined {
    const promoted = this.#gate(releaseGateId).promoted
    return promoted === undefined ? undefined : clone(promoted)
  }

  async auditLog(releaseGateId?: string): Promise<readonly ReleaseAuditRecord[]> {
    return clone(await this.#auditRepository.list(releaseGateId))
  }

  #gate(releaseGateId: string): GateState {
    const gate = this.#gates.get(releaseGateId)
    if (!gate) throw new Error('RELEASE_GATE_MISSING')
    return gate
  }
}

function relativeRegression(metric: EvaluationMetric, candidate: number, baseline: number): number {
  const denominator = Math.max(Math.abs(baseline), Number.EPSILON)
  return lowerIsBetter.has(metric)
    ? Math.max(0, (candidate - baseline) / denominator)
    : Math.max(0, (baseline - candidate) / denominator)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}
