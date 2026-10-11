import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { createProductionChildModelAuthority } from './production-child-model-authority.js'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createProductionChildModelRetention } from './production-child-model-retention.js'
import type { DurableExecutionAuthority } from '@control-plane/pi-durable-adapter'
import { RecordedModelFundingDecisionSchema } from '@control-plane/model-gateway'
import { createPiExecutionBoundModelComposition } from '@control-plane/pi-durable-adapter'
import { createCurrentModelConnectionComposition } from './current-model-composition.js'
import { pinModelConnectionOptions } from './pinned-model-connections.js'
import { createCanonicalModelHostComposition } from './canonical-model-composition.js'
import { ConfiguredModelConnectionService } from './model-connections.service.js'
import { createPiLeadModelAdmissionReadiness } from './pi-lead-model-readiness.js'
import { createProductionLeadProductAuthority } from './production-lead-product.js'
import { createProductionLeadReadiness } from './production-lead-readiness.js'
import { createProductionFacadeRetention } from './production-facade-retention.js'
import { createProductionRuntimeBinding } from './production-runtime-binding.js'
import { createPiLeadModelProductAuthority } from '../pi-durable/model-product-authority.js'
import {
  createNodePiDurableLeadComposition,
  type NodePiDurableLeadCompositionOptions,
} from '../pi-durable/node-composition.js'
import { SqlitePiDurableLeadIntentStore } from '../pi-durable/node-admission.js'
import {
  createPiDurableCurrentToolAuthority,
  type CreatePiDurableCurrentToolAuthorityOptions,
} from '../pi-durable/current-tool-authority.js'
import {
  PiLeadPublicationService,
  type PiLeadPublicationPorts,
} from '../pi-durable/publication-current.service.js'
import { createSqlitePiLeadPublicationReader } from '../pi-durable/sqlite-publication-reader.js'

export interface ProductionPiLeadCompositionOptions {
  readonly directory: string
  readonly fundingDirectory: string
  readonly modelConnections: Parameters<typeof createCurrentModelConnectionComposition>[0]
  readonly product: Parameters<typeof createProductionLeadProductAuthority>[0]['product']
  readonly profiles: Parameters<typeof createProductionLeadProductAuthority>[0]['profiles']
  readonly readiness: Omit<Parameters<typeof createPiLeadModelAdmissionReadiness>[0], 'selections'>
  readonly admission: Omit<
    NodePiDurableLeadCompositionOptions['admission'],
    'product' | 'assertProviderReady'
  >
  readonly ledger: NodePiDurableLeadCompositionOptions['usage']['ledger']
  readonly reconcileInference: NodePiDurableLeadCompositionOptions['reconcileInference']
  readonly releaseExpired: NonNullable<
    NodePiDurableLeadCompositionOptions['preparationAuthority']
  >['releaseExpired']
  /** Separate lock-safe CP authority. Never calls product/PG while Adea holds publication locks. */
  readonly publicationAuthority: PiLeadPublicationPorts['assertCurrent']
  /** Publication freshness clock is independent from admission's retained-plan clock. */
  readonly publicationNow?: () => string
  /** Host-governed tool service/interactions for the canonical current-authority adapter. */
  readonly managementAuthority?: Pick<
    CreatePiDurableCurrentToolAuthorityOptions,
    'service' | 'interactions'
  >
  readonly leasePrincipalRef: string
  readonly modelAlias: string
  /** Separate canonical child admission and confirmed provider/spending authority. Never lead fallback. */
  readonly children?: {
    readonly authority: Omit<Parameters<typeof createProductionChildModelAuthority>[0], 'product'>
    readonly forgetCanonicalModels: (authority: DurableExecutionAuthority) => void
    readonly modelAuthority: Omit<
      Parameters<typeof createPiExecutionBoundModelComposition>[0],
      'ledger'
    >
    readonly runtime: Required<
      Pick<
        NodePiDurableLeadCompositionOptions,
        'governedDelegateChild' | 'childProgress' | 'parentInbox' | 'consumeParentInbox'
      >
    > &
      Pick<NodePiDurableLeadCompositionOptions, 'onParentInboxWake' | 'tools'>
  }
}

/** Actual opt-in production composition. No fixture, secret discovery, environment provider,
 * account substitution, synthetic grant or payer/default inference is constructed here.
 * The launcher supplies current server authority, actual repositories/vault and recorded private files.
 */
export async function createProductionPiLeadComposition(
  options: ProductionPiLeadCompositionOptions
) {
  if (
    !isAbsolute(options.directory) ||
    !isAbsolute(options.fundingDirectory) ||
    !options.admission.scopeAuthority ||
    typeof options.product?.readCurrent !== 'function' ||
    typeof options.profiles?.resolveImmutable !== 'function' ||
    typeof options.publicationAuthority !== 'function' ||
    typeof options.releaseExpired !== 'function' ||
    typeof options.reconcileInference !== 'function' ||
    typeof options.modelConnections?.currentAccountAuthority?.readCurrent !== 'function'
  )
    throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
  if (
    options.managementAuthority !== undefined &&
    (typeof options.managementAuthority.service?.execute !== 'function' ||
      typeof options.managementAuthority.interactions?.get !== 'function')
  )
    throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
  const children = options.children
  if (
    children !== undefined &&
    (!children ||
      typeof children.authority?.readCurrent !== 'function' ||
      typeof children.authority?.admit !== 'function' ||
      typeof children.authority?.assertCurrent !== 'function' ||
      typeof children.forgetCanonicalModels !== 'function' ||
      typeof children.modelAuthority?.forExecution !== 'function' ||
      typeof children.modelAuthority?.readRecordedDecision !== 'function' ||
      !children.modelAuthority?.leasePrincipalRef ||
      !children.modelAuthority?.modelAlias ||
      typeof children.runtime?.governedDelegateChild?.prepare !== 'function' ||
      typeof children.runtime?.childProgress?.scan !== 'function' ||
      typeof children.runtime?.parentInbox?.list !== 'function' ||
      typeof children.runtime?.consumeParentInbox !== 'function' ||
      typeof children.runtime?.tools?.service?.execute !== 'function' ||
      typeof children.runtime?.tools?.assertAuthority !== 'function')
  )
    throw new Error('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  let fundingDatabase: DatabaseSync | undefined
  let intentDatabase: DatabaseSync | undefined
  let runtime: Awaited<ReturnType<typeof createNodePiDurableLeadComposition>> | undefined
  const runtimeBinding = createProductionRuntimeBinding()
  let retentionTimer: ReturnType<typeof setInterval> | undefined
  const closeDatabases = () => {
    try {
      intentDatabase?.close()
    } finally {
      fundingDatabase?.close()
    }
  }
  try {
    fundingDatabase = new DatabaseSync(
      join(options.directory, 'model-funding-confirmations.sqlite')
    )
    intentDatabase = new DatabaseSync(join(options.directory, 'lead-admission.sqlite'))
    fundingDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    intentDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    const metadata = createCurrentModelConnectionComposition(
      pinModelConnectionOptions(options.modelConnections)
    )
    const product = createProductionLeadProductAuthority({
      database: fundingDatabase,
      product: options.product,
      profiles: options.profiles,
      selections: metadata.selections,
      target: options.readiness.target,
      ...(options.admission.now ? { now: options.admission.now } : {}),
    })
    const intents = new SqlitePiDurableLeadIntentStore(intentDatabase)
    const canonical = createCanonicalModelHostComposition({
      canonical: {
        executions: options.admission.executions,
        plans: options.admission.plans,
        intents,
        product: createPiLeadModelProductAuthority({
          product,
          workspaceScope: {
            assertSupported: runtimeBinding.assertSupported,
          },
        }),
        scopeAuthority: options.admission.scopeAuthority,
        leasePrincipalRef: options.leasePrincipalRef,
        modelAlias: options.modelAlias,
        ...(options.admission.now ? { now: options.admission.now } : {}),
      },
      selections: metadata.selections,
      fundingDirectory: options.fundingDirectory,
      database: fundingDatabase,
      ...(options.admission.now ? { now: options.admission.now } : {}),
    })
    const piDurableCurrentToolAuthority = options.managementAuthority
      ? createPiDurableCurrentToolAuthority({
          currentExecutionAuthority: canonical.executionAuthority,
          intents,
          executions: options.admission.executions,
          plans: options.admission.plans,
          service: options.managementAuthority.service,
          interactions: options.managementAuthority.interactions,
          ...(options.admission.now ? { now: options.admission.now } : {}),
        })
      : undefined
    let retention: ReturnType<typeof createProductionFacadeRetention> | undefined
    const native = createPiExecutionBoundModelComposition({
      forExecution: (binding) => {
        const facade = canonical.forExecution(binding)
        retention!.rememberBinding(binding)
        return facade
      },
      leasePrincipalRef: options.leasePrincipalRef,
      modelAlias: options.modelAlias,
      ledger: options.ledger,
      readRecordedDecision: async (authority) => {
        // Resolve only from the actual retained attempt, never a caller's actor or model snapshot.
        const intent = await intents.getByAttempt(authority.request.attemptId)
        if (!intent) throw new Error('PI_PRODUCTION_INTENT_UNAVAILABLE')
        const accepted = intents.marker(intent.intentId)
        if (!accepted) throw new Error('PI_PRODUCTION_INTENT_UNAVAILABLE')
        const binding = await canonical.executionAuthority.resolveForReader({
          workspaceId: intent.workspaceId,
          executionId: intent.executionId,
          attemptId: intent.attemptId,
          principalId: accepted.actorPrincipalId,
          ...authority.admission.selection,
        })
        if (!binding) throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
        return RecordedModelFundingDecisionSchema.parse(
          await canonical.fundingAuthority.readCurrent(binding)
        )
      },
      ...(options.admission.now ? { now: options.admission.now } : {}),
    })
    retention = createProductionFacadeRetention({
      executions: options.admission.executions,
      ledger: options.ledger,
      forgetNative: native.forgetTerminalExecution,
      forgetCanonical: canonical.forgetTerminalExecution,
    })
    const assertProviderReady = createPiLeadModelAdmissionReadiness({
      ...options.readiness,
      selections: metadata.selections,
    })
    const childAuthority = options.children
      ? createProductionChildModelAuthority({ ...options.children.authority, product })
      : undefined
    const childModels = options.children
      ? createPiExecutionBoundModelComposition({
          ...options.children.modelAuthority,
          ledger: options.ledger,
        })
      : undefined
    const childRetention =
      options.children && childModels
        ? createProductionChildModelRetention({
            executions: options.admission.executions,
            ledger: options.ledger,
            maximum: options.children.modelAuthority.maximumRetainedFacades ?? 256,
            forgetNative: childModels.forgetTerminalExecution,
            forgetCanonical: options.children.forgetCanonicalModels,
          })
        : undefined
    const collectModels = async () => {
      await retention!.collect()
      await childRetention?.collect()
    }
    const modelsFor = (authority: Parameters<typeof native.resolvePrice>[0]) => {
      if (!assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan)
        return native
      if (!options.children || !childAuthority) throw new Error('PI_CHILD_MODEL_AUTHORITY_REQUIRED')
      if (!childModels) throw new Error('PI_CHILD_MODEL_AUTHORITY_REQUIRED')
      return childModels
    }
    runtime = await createNodePiDurableLeadComposition({
      ...(options.children && childAuthority
        ? { ...options.children.runtime, childAuthority }
        : {}),
      onAdapterReady: runtimeBinding.onAdapterReady,
      directory: options.directory,
      admission: {
        ...options.admission,
        product,
        assertProviderReady: createProductionLeadReadiness(assertProviderReady),
      },
      provider: async (reference, authority) => {
        if (assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan) {
          if (!childAuthority) throw new Error('PI_CHILD_MODEL_AUTHORITY_REQUIRED')
          await childAuthority.assertAuthority(authority)
          await childRetention?.collect()
          childRetention!.remember(authority)
          return modelsFor(authority).resolveProvider(reference, authority)
        }
        await retention!.collect()
        return retention!.resolveProvider(authority, () =>
          native.resolveProvider(reference, authority)
        )
      },
      usage: {
        ledger: options.ledger,
        resolvePrice: async (authority) => {
          if (assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan) {
            if (!childAuthority) throw new Error('PI_CHILD_MODEL_AUTHORITY_REQUIRED')
            await childAuthority.assertAuthority(authority)
            childRetention!.remember(authority)
          }
          return modelsFor(authority).resolvePrice(authority)
        },
        assertSpendingAuthorized: async (authority, request) => {
          if (assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan) {
            if (!childAuthority) throw new Error('PI_CHILD_MODEL_AUTHORITY_REQUIRED')
            await childAuthority.assertAuthority(authority)
            childRetention!.remember(authority)
          }
          return modelsFor(authority).assertSpendingAuthorized(authority, request)
        },
      },
      reconcileInference: options.reconcileInference,
      preparationAuthority: {
        readFunding: async (admission, principal) => {
          const intent = await intents.getByAttempt(admission.admittedAttempt.attemptId)
          if (!intent) throw new Error('PI_PRODUCTION_INTENT_UNAVAILABLE')
          return (
            await canonical.prepareForReader(
              {
                workspaceId: admission.workspaceId,
                executionId: admission.admittedAttempt.executionId,
                attemptId: admission.admittedAttempt.attemptId,
                principalId: principal.principalId,
                selectionRef: intent.selectionRef,
                selectionRevision: intent.selectionRevision,
              },
              admission.deadlineAt
            )
          ).funding
        },
        releaseExpired: options.releaseExpired,
      },
    })
    const installed = runtime
    retentionTimer = setInterval(() => {
      void collectModels().catch(() => {
        /* Retry metadata cleanup; never release authority or holds. */
      })
    }, 30_000)
    retentionTimer.unref()
    const publicationService = new PiLeadPublicationService({
      readRetained: createSqlitePiLeadPublicationReader({
        database: intentDatabase,
        adapter: installed.adapter,
      }),
      assertCurrent: options.publicationAuthority,
      ...(options.publicationNow ? { now: options.publicationNow } : {}),
    })
    let closing: Promise<void> | undefined
    return {
      piDurableLeadService: installed.service,
      publicationService,
      ...(piDurableCurrentToolAuthority ? { piDurableCurrentToolAuthority } : {}),
      modelConnectionService: new ConfiguredModelConnectionService(
        metadata.selections,
        metadata.administration,
        canonical.fundingView
      ),
      product,
      resolveChildSelection: product.resolveChildSelection,
      adapter: installed.adapter,
      collectTerminalModels: collectModels,
      close: () => {
        closing ??= (async () => {
          if (retentionTimer) clearInterval(retentionTimer)
          try {
            await installed.close()
            await collectModels()
          } finally {
            closeDatabases()
          }
        })()
        return closing
      },
    }
  } catch (error) {
    if (retentionTimer) clearInterval(retentionTimer)
    try {
      await runtime?.close()
    } finally {
      closeDatabases()
    }
    throw error
  }
}
