import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { DelegationService } from '@control-plane/orchestration'
import { createProductionChildModelAuthority } from './production-child-model-authority.js'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createProductionChildModelRetention } from './production-child-model-retention.js'
import {
  createProductionChildDelegation,
  type ProductionChildDelegationOptions,
} from './production-child-delegation.js'
import type { DurableExecutionAuthority } from '@control-plane/pi-durable-adapter'
import { RecordedModelFundingDecisionSchema } from '@control-plane/model-gateway'
import { createPiExecutionBoundModelComposition } from '@control-plane/pi-durable-adapter'
import { createCurrentModelConnectionComposition } from './current-model-composition.js'
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
  createPiDurableGovernedManagementCall,
  SqlitePiDurableManagementCallStore,
  type PiDurableManagementCallAuthority,
  type PiDurableManagementCallerOptions,
} from '../pi-durable/management-governed-call.js'
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
  /** Host-built issuer + Adea transport; the launcher supplies the exact tool-call compiler. */
  readonly governedManagementCall?: NodePiDurableLeadCompositionOptions['governedManagementCall']
  /**
   * Host-built issuer, Adea transport and target mapping (DeepSeek1215
   * canonical factories). The composition supplies only the retained gate
   * store on the runtime journal database and the management current-tool
   * authority; it never derives decision contents or transport policy.
   * Mutually exclusive with `governedManagementCall`.
   */
  readonly managementCall?: Pick<
    PiDurableManagementCallerOptions,
    'issue' | 'callAdea' | 'resolveTargetId' | 'requiresApproval'
  >
  readonly children?: {
    readonly authority: Omit<Parameters<typeof createProductionChildModelAuthority>[0], 'product'>
    readonly forgetCanonicalModels: (authority: DurableExecutionAuthority) => void
    /** Server-only retained tool bindings; never derived from an HTTP/request payload. */
    readonly tools: Pick<CreatePiDurableCurrentToolAuthorityOptions, 'service' | 'interactions'>
    readonly delegation: Omit<
      ProductionChildDelegationOptions,
      'product' | 'now' | 'onEventRetained'
    >
    readonly createGovernedDelegateChild: (
      service: DelegationService
    ) => NonNullable<NodePiDurableLeadCompositionOptions['governedDelegateChild']>
    readonly modelAuthority: Omit<
      Parameters<typeof createPiExecutionBoundModelComposition>[0],
      'ledger'
    >
    readonly runtime: Required<
      Pick<NodePiDurableLeadCompositionOptions, 'childProgress' | 'consumeParentInbox'>
    > &
      Pick<NodePiDurableLeadCompositionOptions, 'onParentInboxWake'>
  }
}

/**
 * Builds the governed management caller over the retained
 * `pi_management_call_gates` store colocated on the runtime journal
 * database. Issuer, transport and target mapping are host-built ingredients
 * from the DeepSeek1215 canonical factories (CP PR1043 comment 6076488885);
 * this builder never derives decision contents, digest identity or transport
 * policy itself.
 */
export function createProductionGovernedManagementCall(options: {
  readonly authority: PiDurableManagementCallAuthority
  readonly database: DatabaseSync
  readonly call: Pick<
    PiDurableManagementCallerOptions,
    'issue' | 'callAdea' | 'resolveTargetId' | 'requiresApproval'
  >
}): ReturnType<typeof createPiDurableGovernedManagementCall> {
  return createPiDurableGovernedManagementCall({
    authority: options.authority,
    store: new SqlitePiDurableManagementCallStore(options.database),
    issue: options.call.issue,
    callAdea: options.call.callAdea,
    resolveTargetId: options.call.resolveTargetId,
    ...(options.call.requiresApproval ? { requiresApproval: options.call.requiresApproval } : {}),
  })
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
      typeof children.createGovernedDelegateChild !== 'function' ||
      typeof children.modelAuthority?.forExecution !== 'function' ||
      typeof children.modelAuthority?.readRecordedDecision !== 'function' ||
      !children.modelAuthority?.leasePrincipalRef ||
      !children.modelAuthority?.modelAlias ||
      typeof children.delegation?.records?.insert !== 'function' ||
      typeof children.delegation?.records?.get !== 'function' ||
      typeof children.delegation?.records?.findByChild !== 'function' ||
      typeof children.delegation?.records?.listByParent !== 'function' ||
      typeof children.delegation?.records?.compareAndSet !== 'function' ||
      typeof children.delegation?.records?.allocate !== 'function' ||
      typeof children.delegation?.lifecycle?.getExecution !== 'function' ||
      typeof children.delegation?.plans?.get !== 'function' ||
      typeof children.delegation?.events?.publish !== 'function' ||
      typeof children.delegation?.events?.list !== 'function' ||
      typeof children.delegation?.scopeAdmission?.resolveCallerPrincipalId !== 'function' ||
      typeof children.delegation?.scopeAdmission?.now !== 'function' ||
      !children.delegation?.scopeAdmission?.authority ||
      typeof children.delegation?.readCurrent !== 'function' ||
      typeof children.runtime?.childProgress?.scan !== 'function' ||
      typeof children.runtime?.consumeParentInbox !== 'function' ||
      typeof children.tools?.service?.execute !== 'function' ||
      typeof children.tools?.interactions?.get !== 'function')
  )
    throw new Error('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  if (options.managementCall !== undefined) {
    if (options.governedManagementCall !== undefined)
      throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
    if (!options.managementAuthority) throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
    if (
      typeof options.managementCall.issue !== 'function' ||
      typeof options.managementCall.callAdea !== 'function' ||
      typeof options.managementCall.resolveTargetId !== 'function' ||
      (options.managementCall.requiresApproval !== undefined &&
        typeof options.managementCall.requiresApproval !== 'function')
    )
      throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
  }
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  let fundingDatabase: DatabaseSync | undefined
  let intentDatabase: DatabaseSync | undefined
  let managementJournalDatabase: DatabaseSync | undefined
  let runtime: Awaited<ReturnType<typeof createNodePiDurableLeadComposition>> | undefined
  const runtimeBinding = createProductionRuntimeBinding()
  let retentionTimer: ReturnType<typeof setInterval> | undefined
  const closeDatabases = () => {
    try {
      intentDatabase?.close()
    } finally {
      try {
        fundingDatabase?.close()
      } finally {
        managementJournalDatabase?.close()
      }
    }
  }
  try {
    fundingDatabase = new DatabaseSync(
      join(options.directory, 'model-funding-confirmations.sqlite')
    )
    intentDatabase = new DatabaseSync(join(options.directory, 'lead-admission.sqlite'))
    fundingDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    intentDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    if (options.managementCall !== undefined) {
      // Retained management-gate records colocate with the runtime journal
      // family (authority.sqlite, the durable runtime/effect state's file).
      // The adapter opens its own connection to that file when the runtime is
      // created; SQLite's file-level atomicity keeps the retained single-claim
      // contract across both connections, matching this file's existing
      // dedicated-connection pattern for lead-admission.sqlite.
      managementJournalDatabase = new DatabaseSync(join(options.directory, 'authority.sqlite'), {
        timeout: 5000,
      })
      managementJournalDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    }
    const metadata = createCurrentModelConnectionComposition(options.modelConnections)
    const product = createProductionLeadProductAuthority({
      database: fundingDatabase,
      product: options.product,
      profiles: options.profiles,
      selections: metadata.selections,
      target: options.readiness.target,
      ...(options.admission.now ? { now: options.admission.now } : {}),
    })
    const childDelegation = children
      ? createProductionChildDelegation({
          ...children.delegation,
          product,
          ...(options.admission.now ? { now: options.admission.now } : {}),
          ...(children.runtime.onParentInboxWake
            ? { onEventRetained: async () => children.runtime.onParentInboxWake?.() }
            : {}),
        })
      : undefined
    const governedDelegateChild =
      children && childDelegation
        ? children.createGovernedDelegateChild(childDelegation.service)
        : undefined
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
    // Child tool gate (CP1041/1018 wiring): the governed child tool service
    // asserts through the canonical current-tool authority built from the
    // server-owned children tool registry.
    const currentToolAuthority = children
      ? createPiDurableCurrentToolAuthority({
          currentExecutionAuthority: canonical.executionAuthority,
          intents,
          executions: options.admission.executions,
          plans: options.admission.plans,
          service: children.tools.service,
          interactions: children.tools.interactions,
          ...(options.admission.now ? { now: options.admission.now } : {}),
        })
      : undefined
    // Management current authority (DeepSeek1215 receipt fc42c7dd lineage,
    // integrated under MiMo sole-writer ownership of this file): host-governed
    // management tool service/interactions, returned for the launcher's
    // governed management call.
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
    // Governed management call: canonical caller + retained gate store on the
    // runtime journal database. Issuer, Adea transport and target mapping are
    // host-built ingredients (DeepSeek1215 factories); this composition only
    // supplies the durable store and the management current-tool authority.
    const builtManagementCall =
      options.managementCall && piDurableCurrentToolAuthority && managementJournalDatabase
        ? createProductionGovernedManagementCall({
            authority: { assertCurrent: piDurableCurrentToolAuthority.assertCurrent },
            database: managementJournalDatabase,
            call: options.managementCall,
          })
        : undefined
    const managementPort = options.governedManagementCall ?? builtManagementCall
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
      ...(managementPort ? { governedManagementCall: managementPort } : {}),
      ...(options.children &&
      childAuthority &&
      currentToolAuthority &&
      childDelegation &&
      governedDelegateChild
        ? {
            ...options.children.runtime,
            parentInbox: options.children.delegation.events,
            childAuthority,
            governedDelegateChild,
            delegationService: childDelegation.service,
            tools: {
              service: options.children.tools.service,
              assertAuthority: currentToolAuthority.assertCurrent,
            },
          }
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
      ...(managementPort ? { governedManagementCall: managementPort } : {}),
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
