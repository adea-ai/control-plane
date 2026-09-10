import { z } from 'zod'

export const LoadProfileSchema = z
  .object({
    profileId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9.-]*$/),
    iterations: z.number().int().positive().max(1_000_000),
    concurrency: z.number().int().positive().max(10_000),
    budgets: z
      .object({
        p95LatencyMs: z.number().finite().nonnegative(),
        minimumThroughputPerSecond: z.number().finite().nonnegative(),
        maximumErrorRate: z.number().finite().min(0).max(1),
        maximumMemoryDeltaBytes: z.number().int().nonnegative(),
        maximumCostPerOperationUsd: z.number().finite().nonnegative(),
        maximumAttemptsPerOperation: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .refine((profile) => profile.concurrency <= profile.iterations, {
    message: 'Concurrency cannot exceed iterations',
  })

export type LoadProfile = z.output<typeof LoadProfileSchema>

export interface LoadResult {
  readonly profileId: string
  readonly completed: number
  readonly failed: number
  readonly p50LatencyMs: number
  readonly p95LatencyMs: number
  readonly p99LatencyMs: number
  readonly throughputPerSecond: number
  readonly errorRate: number
  readonly memoryDeltaBytes: number
  readonly costPerOperationUsd: number
  readonly maximumAttempts: number
  readonly invalidEvidence: number
  readonly failedBudgets: readonly string[]
  readonly status: 'failed' | 'passed'
}

export async function runLoadProfile(
  input: unknown,
  operation: (input: {
    readonly sequence: number
  }) => Promise<{ readonly costUsd: number; readonly attempts: number }>,
  adapters: {
    readonly now?: () => number
    readonly memoryUsage?: () => number
  } = {}
): Promise<LoadResult> {
  const profile = LoadProfileSchema.parse(input)
  const now = adapters.now ?? (() => performance.now())
  const memoryUsage = adapters.memoryUsage ?? (() => process.memoryUsage.rss())
  const startedAt = now()
  const memoryBefore = memoryUsage()
  let invalidMeasurement =
    !Number.isFinite(startedAt) || !Number.isSafeInteger(memoryBefore) || memoryBefore < 0
  const latencies: number[] = []
  let nextSequence = 0
  let completed = 0
  let failed = 0
  let totalCostUsd = 0
  let maximumAttempts = 0
  let invalidEvidence = 0

  await Promise.all(
    Array.from({ length: profile.concurrency }, async () => {
      while (nextSequence < profile.iterations) {
        const sequence = nextSequence++
        const operationStartedAt = now()
        try {
          const outcome = await operation({ sequence })
          if (
            !Number.isFinite(outcome.costUsd) ||
            outcome.costUsd < 0 ||
            !Number.isSafeInteger(outcome.attempts) ||
            outcome.attempts < 1
          ) {
            invalidEvidence += 1
            failed += 1
            continue
          }
          totalCostUsd += outcome.costUsd
          maximumAttempts = Math.max(maximumAttempts, outcome.attempts)
          completed += 1
        } catch {
          failed += 1
        } finally {
          const operationCompletedAt = now()
          const latency = operationCompletedAt - operationStartedAt
          if (
            !Number.isFinite(operationStartedAt) ||
            !Number.isFinite(operationCompletedAt) ||
            !Number.isFinite(latency) ||
            latency < 0
          ) {
            invalidMeasurement = true
          }
          latencies.push(Number.isFinite(latency) && latency >= 0 ? latency : 0)
        }
      }
    })
  )

  const completedAt = now()
  const memoryAfter = memoryUsage()
  const duration = completedAt - startedAt
  if (
    !Number.isFinite(completedAt) ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isSafeInteger(memoryAfter) ||
    memoryAfter < 0
  ) {
    invalidMeasurement = true
  }
  if (invalidMeasurement) invalidEvidence += 1
  const durationMs = Number.isFinite(duration) && duration >= 0 ? Math.max(1, duration) : 1
  const result = {
    profileId: profile.profileId,
    completed,
    failed,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    p99LatencyMs: percentile(latencies, 0.99),
    throughputPerSecond: (completed / durationMs) * 1000,
    errorRate: failed / profile.iterations,
    memoryDeltaBytes:
      Number.isSafeInteger(memoryBefore) && Number.isSafeInteger(memoryAfter)
        ? Math.max(0, memoryAfter - memoryBefore)
        : 0,
    costPerOperationUsd: totalCostUsd / profile.iterations,
    maximumAttempts,
    invalidEvidence,
  }
  const failedBudgets = [
    ...(result.p95LatencyMs > profile.budgets.p95LatencyMs ? ['p95_latency'] : []),
    ...(result.throughputPerSecond < profile.budgets.minimumThroughputPerSecond
      ? ['throughput']
      : []),
    ...(result.errorRate > profile.budgets.maximumErrorRate ? ['error_rate'] : []),
    ...(result.memoryDeltaBytes > profile.budgets.maximumMemoryDeltaBytes ? ['memory_delta'] : []),
    ...(result.costPerOperationUsd > profile.budgets.maximumCostPerOperationUsd
      ? ['unit_cost']
      : []),
    ...(result.maximumAttempts > profile.budgets.maximumAttemptsPerOperation
      ? ['attempt_amplification']
      : []),
    ...(result.invalidEvidence > 0 ? ['invalid_evidence'] : []),
  ]
  return {
    ...result,
    failedBudgets,
    status: failedBudgets.length === 0 ? 'passed' : 'failed',
  }
}

export class BoundedAdmissionController {
  readonly #maximumInFlight: number
  readonly #retryAfterMs: number
  #inFlight = 0

  constructor(options: { readonly maximumInFlight: number; readonly retryAfterMs: number }) {
    if (!Number.isSafeInteger(options.maximumInFlight) || options.maximumInFlight < 1) {
      throw new Error('INVALID_ADMISSION_LIMIT')
    }
    if (!Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs < 1) {
      throw new Error('INVALID_RETRY_DELAY')
    }
    this.#maximumInFlight = options.maximumInFlight
    this.#retryAfterMs = options.retryAfterMs
  }

  get inFlight(): number {
    return this.#inFlight
  }

  async tryRun<Result>(
    operation: () => Result | Promise<Result>
  ): Promise<
    | { readonly accepted: false; readonly retryAfterMs: number }
    | { readonly accepted: true; readonly value: Result }
  > {
    if (this.#inFlight >= this.#maximumInFlight) {
      return { accepted: false, retryAfterMs: this.#retryAfterMs }
    }
    this.#inFlight += 1
    try {
      return { accepted: true, value: await operation() }
    } finally {
      this.#inFlight -= 1
    }
  }
}

export function compareLoadBaselines(input: {
  readonly baseline: BaselineMetrics
  readonly candidate: BaselineMetrics
  readonly maximumRegressions: {
    readonly latency: number
    readonly throughput: number
    readonly cost: number
    readonly memory: number
    readonly errorRate: number
  }
}): readonly string[] {
  assertValidBaseline(input)
  const regressions = []
  if (
    increase(input.candidate.p95LatencyMs, input.baseline.p95LatencyMs) >
    input.maximumRegressions.latency
  ) {
    regressions.push('latency')
  }
  if (
    decrease(input.candidate.throughputPerSecond, input.baseline.throughputPerSecond) >
    input.maximumRegressions.throughput
  ) {
    regressions.push('throughput')
  }
  if (
    increase(input.candidate.costPerOperationUsd, input.baseline.costPerOperationUsd) >
    input.maximumRegressions.cost
  ) {
    regressions.push('cost')
  }
  if (
    increase(input.candidate.memoryDeltaBytes, input.baseline.memoryDeltaBytes) >
    input.maximumRegressions.memory
  ) {
    regressions.push('memory')
  }
  if (
    increase(input.candidate.errorRate, input.baseline.errorRate) >
    input.maximumRegressions.errorRate
  ) {
    regressions.push('error_rate')
  }
  return regressions.toSorted()
}

function assertValidBaseline(input: {
  readonly baseline: BaselineMetrics
  readonly candidate: BaselineMetrics
  readonly maximumRegressions: Readonly<Record<string, number>>
}): void {
  const measurements = [
    ...Object.values(input.baseline),
    ...Object.values(input.candidate),
    ...Object.values(input.maximumRegressions),
  ]
  if (measurements.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('INVALID_LOAD_BASELINE')
  }
  if (input.baseline.errorRate > 1 || input.candidate.errorRate > 1) {
    throw new Error('INVALID_LOAD_BASELINE')
  }
}

interface BaselineMetrics {
  readonly p95LatencyMs: number
  readonly throughputPerSecond: number
  readonly costPerOperationUsd: number
  readonly memoryDeltaBytes: number
  readonly errorRate: number
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].toSorted((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index] ?? 0
}

function increase(candidate: number, baseline: number): number {
  return Math.max(0, (candidate - baseline) / Math.max(Math.abs(baseline), Number.EPSILON))
}

function decrease(candidate: number, baseline: number): number {
  return Math.max(0, (baseline - candidate) / Math.max(Math.abs(baseline), Number.EPSILON))
}
