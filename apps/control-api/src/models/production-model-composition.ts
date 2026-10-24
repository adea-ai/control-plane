import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { DelegationService } from '@control-plane/orchestration'
import { createProductionChildModelAuthority } from './production-child-model-authority.js'
import { createProductionChildCurrent } from './production-child-current.js'
import { createProductionChildModelHost } from './production-child-model-host.js'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createProductionChildModelRetention } from './production-child-model-retention.js'
import {
  createProductionChildDelegation,
  type ProductionChildDelegationOptions,
} from './production-child-delegation.js'
import type {
  DurableExecutionAuthority,
  PiDurableGovernedManagementCallCompiler,
} from '@control-plane/pi-durable-adapter'
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
import type { ProductionChildBridgeContext } from '../pi-durable/production-child-bridge.js'
import type { ChildUsageOutcomesFor } from '../pi-durable/child-usage-outcomes.js'
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
import { PiChildPublicationService } from '../pi-durable/child-publication-current.service.js'

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
  /** Host-built issuer + Adea transport; the launcher supplies the exact tool-call compiler. */
  readonly governedManagementCall?: NodePiDurableLeadCompositionOptions['governedManagementCall']
  /** Host-owned management call ingredients; this composition supplies only its retained gate. */
  readonly managementCall?: Pick<
    PiDurableManagementCallerOptions,
    'issue' | 'callAdea' | 'resolveTargetId' | 'requiresApproval'
  > & {
    readonly prepare: PiDurableGovernedManagementCallCompiler['prepare']
  }
  /** Separate canonical child admission and confirmed provider/spending authority. Never lead fallback. */
  readonly children?: {
    /** Optional host-owned child authority mode used by newer launchers. */
    readonly authority?: Omit<Parameters<typeof createProductionChildModelAuthority>[0], 'product'>
    readonly forgetCanonicalModels?: (authority: DurableExecutionAuthority) => void
    /** Server-only retained tool bindings; never derived from an HTTP/request payload. */
    readonly tools: Pick<CreatePiDurableCurrentToolAuthorityOptions, 'service' | 'interactions'>
    readonly delegation: Omit<
      ProductionChildDelegationOptions,
      'product' | 'readCurrent' | 'now' | 'onEventRetained'
    > & { readonly readCurrent?: ProductionChildDelegationOptions['readCurrent'] }
    /**
     * The durable child cost-state projection per delegation. The bridge records a child's estimate and
     * reservation in it, and the terminal settlement reads and completes it, so both use this one factory.
     */
    readonly usageOutcomes: ChildUsageOutcomesFor
    /** The second argument carries this composition's own canonical child ports for the bridge. */
    readonly createGovernedDelegateChild: (
      service: DelegationService,
      context: ProductionChildBridgeContext
    ) => NonNullable<NodePiDurableLeadCompositionOptions['governedDelegateChild']>
    /** Lease and alias only: child admission, funding and facades are composed by the server. */
    readonly modelAuthority: Pick<
      Parameters<typeof createPiExecutionBoundModelComposition>[0],
      'leasePrincipalRef' | 'modelAlias' | 'maximumRetainedFacades'
    > &
      Partial<
        Pick<
          Parameters<typeof createPiExecutionBoundModelComposition>[0],
          'forExecution' | 'readRecordedDecision'
        >
      >
    readonly runtime: Required<
      Pick<
        NodePiDurableLeadCompositionOptions,
        'childProgress' | 'consumeParentInbox' | 'childTimelineDelivery'
      >
    > &
      Pick<NodePiDurableLeadCompositionOptions, 'onParentInboxWake'>
  }
}

/** Build the durable management-call authority using the host's exact issuer, transport and target. */
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
      typeof children.createGovernedDelegateChild !== 'function' ||
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
      typeof children.usageOutcomes !== 'function' ||
      typeof children.runtime?.childProgress?.scan !== 'function' ||
      typeof children.runtime?.childTimelineDelivery?.notify !== 'function' ||
      !children.runtime?.childTimelineDelivery?.principalId ||
      typeof children.runtime?.consumeParentInbox !== 'function' ||
      typeof children.tools?.service?.execute !== 'function' ||
      typeof children.tools?.interactions?.get !== 'function')
  )
    throw new Error('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
  if (options.managementCall !== undefined) {
    if (options.governedManagementCall !== undefined || !options.managementAuthority)
      throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
    if (
      typeof options.managementCall.issue !== 'function' ||
      typeof options.managementCall.callAdea !== 'function' ||
      typeof options.managementCall.resolveTargetId !== 'function' ||
      typeof options.managementCall.prepare !== 'function' ||
      (options.managementCall.requiresApproval !== undefined &&
        typeof options.managementCall.requiresApproval !== 'function')
    )
      throw new Error('PI_PRODUCTION_BINDING_REQUIRED')
  }
  const externalChildAuthority =
    options.children !== undefined &&
    (options.children.authority !== undefined ||
      options.children.forgetCanonicalModels !== undefined ||
      options.children.modelAuthority.forExecution !== undefined ||
      options.children.modelAuthority.readRecordedDecision !== undefined)
  if (
    externalChildAuthority &&
    (!options.children?.authority ||
      typeof options.children.authority.readCurrent !== 'function' ||
      typeof options.children.authority.admit !== 'function' ||
      typeof options.children.authority.assertCurrent !== 'function' ||
      typeof options.children.forgetCanonicalModels !== 'function' ||
      typeof options.children.modelAuthority.forExecution !== 'function' ||
      typeof options.children.modelAuthority.readRecordedDecision !== 'function' ||
      typeof options.children.delegation.readCurrent !== 'function')
  )
    throw new Error('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
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
      managementJournalDatabase = new DatabaseSync(join(options.directory, 'authority.sqlite'), {
        timeout: 5000,
      })
      managementJournalDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    }
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
    const childCurrent = children
      ? createProductionChildCurrent({
          executions: options.admission.executions,
          plans: options.admission.plans,
          intents,
          delegations: children.delegation.records,
          toolCalls: children.tools.service.calls,
          product: options.product,
          assertRetainedProductCurrent: product.assertRetainedProductCurrent,
          ...(options.admission.now ? { now: options.admission.now } : {}),
        })
      : undefined
    const childHost =
      children && childCurrent
        ? createProductionChildModelHost({
            current: childCurrent,
            product,
            selections: metadata.selections,
            fundingDirectory: options.fundingDirectory,
            database: fundingDatabase,
            leasePrincipalRef: children.modelAuthority.leasePrincipalRef,
            modelAlias: children.modelAuthority.modelAlias,
            ...(children.modelAuthority.maximumRetainedFacades !== undefined
              ? { maximumRetainedFacades: children.modelAuthority.maximumRetainedFacades }
              : {}),
            ...(options.admission.now ? { now: options.admission.now } : {}),
          })
        : undefined
    const childDelegation =
      children && childCurrent
        ? createProductionChildDelegation({
            ...children.delegation,
            product,
            readCurrent: children.delegation.readCurrent ?? childCurrent.readAdmission,
            ...(options.admission.now ? { now: options.admission.now } : {}),
            ...(children.runtime.onParentInboxWake
              ? { onEventRetained: async () => children.runtime.onParentInboxWake?.() }
              : {}),
          })
        : undefined
    const governedDelegateChild =
      children && childDelegation
        ? children.createGovernedDelegateChild(childDelegation.service, {
            authority: childCurrent!,
            modelBinding: childHost!.bindingFor,
            usageOutcomes: children.usageOutcomes,
            runtime: { start: (request) => runtimeBinding.current().start(request) },
          })
        : undefined
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
    const managementCaller =
      options.managementCall && piDurableCurrentToolAuthority && managementJournalDatabase
        ? createProductionGovernedManagementCall({
            authority: { assertCurrent: piDurableCurrentToolAuthority.assertCurrent },
            database: managementJournalDatabase,
            call: options.managementCall,
          })
        : undefined
    const builtManagementCall: PiDurableGovernedManagementCallCompiler | undefined =
      managementCaller && options.managementCall
        ? {
            prepare: options.managementCall.prepare,
            execute: async (request) => managementCaller.execute(request),
          }
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
    const childAuthority = children
      ? children.authority
        ? createProductionChildModelAuthority({ ...children.authority, product })
        : childCurrent && childHost
          ? createProductionChildModelAuthority({
              product,
              readCurrent: childCurrent.readRuntime,
              admit: childHost.admit,
              assertCurrent: childHost.assertCurrent,
            })
          : undefined
      : undefined
    const childModels = children
      ? children.modelAuthority.forExecution && children.modelAuthority.readRecordedDecision
        ? createPiExecutionBoundModelComposition({
            ...children.modelAuthority,
            forExecution: children.modelAuthority.forExecution,
            readRecordedDecision: children.modelAuthority.readRecordedDecision,
            ledger: options.ledger,
          })
        : childHost
          ? createPiExecutionBoundModelComposition({
              leasePrincipalRef: children.modelAuthority.leasePrincipalRef,
              modelAlias: children.modelAuthority.modelAlias,
              ...(children.modelAuthority.maximumRetainedFacades !== undefined
                ? { maximumRetainedFacades: children.modelAuthority.maximumRetainedFacades }
                : {}),
              forExecution: childHost.forExecution,
              readRecordedDecision: childHost.readRecordedDecision,
              ledger: options.ledger,
            })
          : undefined
      : undefined
    const childRetention =
      children && childModels && childHost
        ? createProductionChildModelRetention({
            executions: options.admission.executions,
            ledger: options.ledger,
            maximum: children.modelAuthority.maximumRetainedFacades ?? 256,
            forgetNative: childModels.forgetTerminalExecution,
            forgetCanonical:
              children.forgetCanonicalModels ?? childHost?.forgetTerminalExecution ?? (() => {}),
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
            childDelegations: childDelegation.service,
            childSettlement: {
              delegations: options.children.delegation.records,
              usageOutcomes: options.children.usageOutcomes,
              now: options.admission.now ?? (() => new Date().toISOString()),
            },
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
    const childPublicationService =
      options.children && childDelegation
        ? new PiChildPublicationService({
            readRetained: createSqlitePiLeadPublicationReader({
              database: intentDatabase,
              adapter: installed.adapter,
              includeStatus: false,
            }),
            listChildren: (executionId) => childDelegation.service.listChildren(executionId),
            listParentEvents: async () => options.children!.delegation.events.list(),
            assertCurrent: options.publicationAuthority,
            ...(options.publicationNow ? { now: options.publicationNow } : {}),
          })
        : undefined
    let closing: Promise<void> | undefined
    return {
      piDurableLeadService: installed.service,
      ...(managementPort ? { governedManagementCall: managementPort } : {}),
      /** Read-only server-owned child authority (no caller input); used by composition proofs. */
      ...(childCurrent ? { childAuthorityCurrent: childCurrent } : {}),
      /** The exact child authority port the adapter consumes; read-only proof surface. */
      ...(childAuthority ? { childAuthority } : {}),
      /** Server-derived child binding for a retained attempt; never a credential or spend grant. */
      ...(childHost ? { childModelBinding: childHost.bindingFor } : {}),
      publicationService,
      ...(childPublicationService ? { childPublicationService } : {}),
      ...(piDurableCurrentToolAuthority ? { piDurableCurrentToolAuthority } : {}),
      modelConnectionService: new ConfiguredModelConnectionService(
        metadata.selections,
        metadata.administration,
        canonical.fundingView
      ),
      product,
      resolveChildSelection: product.resolveChildSelection,
      adapter: installed.adapter,
      /** Settles completed children now, as the recovery pass does. Present with `children`. */
      ...(installed.settleChildTerminalAccounting
        ? { settleChildTerminalAccounting: installed.settleChildTerminalAccounting }
        : {}),
      /** Settles the completed lead now, as the recovery pass does. */
      settleTerminalAccounting: () => installed.settleTerminalAccounting(),
      get terminalSettlementBlocked() {
        return installed.terminalSettlementBlocked
      },
      get childTerminalSettlementBlocked() {
        return installed.childTerminalSettlementBlocked
      },
      /**
       * True when a close gave up waiting for an accepted recovery. The teardown still completed;
       * the host reads this after close to know the drain was not clean.
       */
      get drainIncomplete() {
        return installed.drainIncomplete
      },
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
