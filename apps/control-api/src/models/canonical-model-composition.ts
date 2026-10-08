import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  createExecutionBoundModelSelectionService,
  createFileRecordedModelFundingAuthority,
  createModelFundingPreparationService,
  ExecutionModelSelectionBindingSchema,
  ModelSelectionError,
  resolveModelSelectionFundingView,
  type ExecutionModelSelectionBinding,
  type ModelSelectionService,
} from '@control-plane/model-gateway'
import {
  createCanonicalModelExecutionAuthority,
  type CanonicalModelExecutionHostOptions,
} from './canonical-model-host.js'
import { createSqliteModelFundingConfirmations } from './sqlite-funding-confirmations.js'

/** Actual Node host composition; opt-in, with server repositories and private metadata.
 * R1 derives bindings from canonical admission and retains confirmation refs privately.
 * Every native provider AND spending resolution must use forExecution's same facade.
 */
export function createCanonicalModelHostComposition(options: {
  canonical: CanonicalModelExecutionHostOptions
  selections: Pick<ModelSelectionService, 'resolveSelection' | 'assertReady' | 'withCredential'>
  fundingDirectory: string
  database: Parameters<typeof createSqliteModelFundingConfirmations>[0]
  maximumRetainedFacades?: number
  now?: () => string
}) {
  const executionAuthority = createCanonicalModelExecutionAuthority(options.canonical)
  const fundingAuthority = createFileRecordedModelFundingAuthority({
    directory: options.fundingDirectory,
    currentExecutionAuthority: executionAuthority,
    ...(options.now ? { now: options.now } : {}),
  })
  const confirmations = createSqliteModelFundingConfirmations(options.database)
  const readFunding = (binding: ExecutionModelSelectionBinding) =>
    resolveModelSelectionFundingView({
      binding,
      selections: createExecutionBoundModelSelectionService({
        binding,
        selections: options.selections,
        currentExecutionAuthority: executionAuthority,
      }),
      fundingAuthority,
      ...(options.now ? { now: options.now } : {}),
    })
  const preparation = createModelFundingPreparationService({
    executionAuthority,
    confirmations,
    readFunding,
    ...(options.now ? { now: options.now } : {}),
  })
  const maximum = options.maximumRetainedFacades ?? 256
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
    throw new ModelSelectionError('READINESS_UNAVAILABLE')
  const facades = new Map<
    string,
    { pin: string; facade: ReturnType<typeof createExecutionBoundModelSelectionService> }
  >()
  const key = (binding: ExecutionModelSelectionBinding) =>
    `${binding.workspaceId}/${binding.executionId}/${binding.attemptId}`
  return {
    executionAuthority,
    confirmedExecutionAuthority: preparation.confirmedExecutionAuthority,
    fundingAuthority,
    async prepareForReader(
      input: Parameters<typeof executionAuthority.resolveForReader>[0],
      admissionDeadline: string
    ) {
      const binding = ExecutionModelSelectionBindingSchema.parse(
        await executionAuthority.resolveForReader(input)
      )
      return preparation.prepareFunding(binding, admissionDeadline)
    },
    assertFundingCurrent: preparation.assertFundingCurrent,
    /** Native caller supplies server-derived accepted binding, never a public request body. */
    forExecution(input: unknown) {
      const binding = ExecutionModelSelectionBindingSchema.parse(input)
      const identity = key(binding)
      const pin = canonicalJsonStringify(binding)
      const existing = facades.get(identity)
      if (existing) {
        if (existing.pin !== pin) throw new ModelSelectionError('SELECTION_CHANGED')
        return existing.facade
      }
      if (facades.size >= maximum) throw new ModelSelectionError('READINESS_UNAVAILABLE')
      const facade = createExecutionBoundModelSelectionService({
        binding,
        selections: options.selections,
        currentExecutionAuthority: preparation.confirmedExecutionAuthority,
      })
      facades.set(identity, { pin, facade })
      return facade
    },
    /** Only call after canonical terminal/expiry cleanup; contains refs, never leases/Models. */
    forgetTerminalExecution(input: unknown) {
      const binding = ExecutionModelSelectionBindingSchema.parse(input)
      const existing = facades.get(key(binding))
      if (existing && existing.pin !== canonicalJsonStringify(binding))
        throw new ModelSelectionError('SELECTION_CHANGED')
      facades.delete(key(binding))
    },
    fundingView: {
      async resolve(input: Parameters<typeof executionAuthority.resolveForReader>[0]) {
        const binding = ExecutionModelSelectionBindingSchema.parse(
          await executionAuthority.resolveForReader(input)
        )
        return readFunding(binding)
      },
    },
  }
}
