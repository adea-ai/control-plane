# Canonical embedded-figure reconciliation

The native Google Docs API made three embedded figures available on 2026-09-30 after the earlier fetched-text captures omitted their image bodies. Direct visual inspection found two source-internal inconsistencies. The System Architecture figure omits the default Local embedded SQLite durability path. The Data API execution diagram uses stale state names and omits three states. These are documentation-governance findings under #195; they do not establish runtime acceptance or close #186.

## Capture provenance

The parent document metadata still matches the pinned text captures. Native Docs `revisionId` is an opaque API token, distinct from the numeric Drive revisions below. Images were read from current native inline-object references; no historical image-revision identity is inferred. SHA-256 covers the retrieved PNG bytes. No authenticated download URLs or credentials are retained here.

| Parent document / captured text location                                                                                                          | Drive revision | Native inline object | Image bytes | PNG SHA-256                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | -------------------- | ----------: | ------------------------------------------------------------------ |
| [System Architecture Overview](https://docs.google.com/document/d/1Bdck8tMJQ_o9C1cPnxpEI9fe39csTmynllRgj-gbTxI/edit), L043 caption                |             99 | `kix.ows2808gmq16`   |      185403 | `1714b1f2e825c908d41b5d9ffd6a516d2b9ac242fc4246f065fe72041c5d68e0` |
| [Data Model & API Specification](https://docs.google.com/document/d/1OZS6eARKKsAkaOUD9dpMxogts2Br2A_HUNVp61QIghM/edit), L063 domain relationships |             73 | `kix.3cdr0vj1ebkd`   |       63584 | `c16ae0d9d91bb99a78cd5af06bfc884560c4eca974c56c5b576cbdb20fc9f9a2` |
| Same Data API document, L072 state machines                                                                                                       |             73 | `kix.j8qqp2z5p3tm`   |       50696 | `ce9932af244815b4a38c9d5da931356ebbb7cf744c9842ae2ba3330ffcb0e11a` |

The first two figures also identify Drive image files `1tqRS7x3p6Gp2Ky-PKVytfof5etqqGvtS` and `11njorotHS-qtm-nSDVN4fu4rM-_jD4_8`; their file modification dates are 2026-09-19. The third image has no Drive source-file ID in its inline metadata. The native object is its capture locator. The text-only atomic inventories retain their original hashes, line numbers and atom counts; this audit is supplemental visual evidence.

## System architecture figure

The readable figure states these boundaries:

- Agent HQ is the private first-party product, with desktop/web/mobile UI, application services, remote relay carrying HPKE ciphertext, Railway Event Gateway/Neon WorkspaceEvents, and cloud-safe metadata plus E2E ContentReplica ciphertext.
- Control Plane is independently consumable open-source Apache-2.0 software. External agents/harnesses and partner/self-hosted clients reach the Control API/Public SDK.
- Profiles, Skills, ProjectState and context policy feed an immutable ExecutionPlan. ContextProvider selection is optional, with Cortana, another compatible provider, or no provider as a supported baseline. Provider responses/contributions are bounded and validated.
- Providers own their separate stores. Control Plane persistence is SQLite for Local/Simple and PostgreSQL for Server/Cloud. The isolation assertion prohibits direct cross-database reads, shared credentials and private-code dependencies.
- Runtime Adapters reach the Tool Gateway/shared integrations/MCP, Model Gateway and SandboxProvider. The Runtime Gateway is labeled for a non-co-located RuntimeNode only; RuntimeDrivers reach Managed Pi or ACP external harnesses.

The durable path is drawn as `Immutable ExecutionPlan → Restate Durable Lifecycle → bounded LangGraph segments / Runtime Adapters`. SQLite appears only in the persistence node. The figure does not express the separate default Local embedded SQLite queue and in-process runtime shown in the adjacent source L044. The correct Local path is already described in [repository architecture](../architecture.md) and [diagram sources](../architecture/diagram-sources.md). The canonical image still needs to show Local embedded durability with optional Local Restate and the Hosted/Cloud Restate path. No source-image edit or source-owner approval is claimed.

## Data API domain relationships

The following labels and associations are readable. Multiplicity marks are too small to establish reliable cardinalities; each cardinality remains unresolved rather than inferred from the prose.

| Subject                 | Relationship label | Object                                      |
| ----------------------- | ------------------ | ------------------------------------------- |
| USER                    | has                | MEMBERSHIP                                  |
| WORKSPACE               | contains           | ROOM, WORKSPACE_EVENT, AGENT, TASK, CHANNEL |
| WORKSPACE               | scopes             | CONTENT_KEY_EPOCH                           |
| WORKSPACE               | provisions         | CLIENT_CONTENT_DEVICE                       |
| CONTENT_KEY_EPOCH       | wrapped_as         | CONTENT_KEY_ENVELOPE                        |
| CLIENT_CONTENT_DEVICE   | receives           | CONTENT_KEY_ENVELOPE                        |
| WORKSPACE               | owns               | CONTENT_REF                                 |
| CONTENT_REF             | represented_by     | CONTENT_REPLICA                             |
| AGENT                   | assigned           | TASK                                        |
| AGENT                   | uses               | AGENT_PROFILE_REF                           |
| RUNTIME_CONNECTION_VIEW | exposes            | EXTERNAL_SESSION_VIEW                       |
| CONTEXT_PROVIDER_VIEW   | surfaces           | MEMORY_WRITE_PROPOSAL_VIEW                  |
| CHANNEL                 | contains           | MESSAGE                                     |
| TASK                    | private_content    | CONTENT_REF                                 |
| MESSAGE                 | private_body       | CONTENT_REF                                 |
| TASK                    | references         | EXECUTION_REF                               |

Agent HQ Task and Control Plane ExecutionRef remain separate authorities. [Repository ownership](../architecture.md) and the [execution schema](../../packages/database/src/schema/executions.ts) use task identity as correlation, without asserting a shared Agent HQ Task database. The view relationships do not establish runtime-session or provider-memory ownership. This bounded inspection supplies no deployed relationship or storage acceptance.

## Data API state machines

The Control Plane diagram draws `Start → Created → Queued → Running`, then `Running → TimedOut / Cancelled / Failed / Succeeded / AwaitingInput`, with `AwaitingInput → Running`. The adjacent text L070 and the [executable execution-state schema](../../packages/domain/src/execution-lifecycle.ts) instead define `accepted`, `queued`, `starting`, `running`, `awaiting_input`, `cancelling`, `completed`, `failed`, `cancelled`, `timed_out` and `reconciliation_required`.

The canonical Control Plane figure therefore needs to replace Created/Succeeded with accepted/completed and include starting, cancelling and reconciliation_required. A correction must be checked against the [actual transition authority](../../packages/domain/src/execution-lifecycle.ts), rather than assuming the prose's compact sequence enumerates every permitted edge. The Agent HQ Task figure separately draws Created, Queued, Running, AwaitingInput, Succeeded, Failed and Cancelled; its simplified vocabulary agrees with the adjacent Task prose. It should retain its product-owned distinction from Control Plane Execution.

## Remaining acceptance

Two automated-agent readers visually inspected these current image captures; this is not independent human acceptance. This establishes their readable content and the documented inconsistencies only. Source-image corrections and owner review, reliable domain cardinality extraction, full figure-to-atom/requirement/code/test/deployment mapping, and independent current-candidate acceptance remain open. Historical ledger classifications and candidate evidence are unchanged. #186 and #195 remain open.
