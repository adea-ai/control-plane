# Canonical embedded-figure reconciliation

Current native Google Docs reads on 2026-09-30 enumerated all 15 pinned source documents without API errors and exposed nine inline image objects across the five parents below; the other ten returned no inline image objects. This is a current API inventory, not proof of historical or other embedded-resource completeness. Visual reconciliation found source-internal inconsistencies in the System Architecture, Agent HQ PRD, Control Plane TDD, Security & Trust Model, and Data API figures. These are documentation-governance findings under #195; they do not establish runtime acceptance or close #186.

The [October 3 freshness observation](canonical-source-freshness-2026-10-03.md)
found newer parent revisions and twelve inline objects in selected root tabs,
including changed System Architecture and Security object identities. This audit
remains a September 30 interpretation; current image bytes and visual
reconciliation have not been refreshed by the later metadata observation.

## Capture provenance

The parent document metadata still matches the pinned text captures. Native Docs `revisionId` is an opaque API token, distinct from the numeric Drive revisions below. Images were read from current native inline-object references; no historical image-revision identity is inferred. SHA-256 covers the retrieved PNG bytes. No authenticated download URLs or credentials are retained here.

| Parent document / captured text location                                                                                                                | Pinned Drive revision | Native inline object | Image bytes | PNG SHA-256                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------: | -------------------- | ----------: | ------------------------------------------------------------------ |
| [System Architecture Overview](https://docs.google.com/document/d/1Bdck8tMJQ_o9C1cPnxpEI9fe39csTmynllRgj-gbTxI/edit), L043 caption                      |                    99 | `kix.ows2808gmq16`   |      185403 | `1714b1f2e825c908d41b5d9ffd6a516d2b9ac242fc4246f065fe72041c5d68e0` |
| [Data Model & API Specification](https://docs.google.com/document/d/1OZS6eARKKsAkaOUD9dpMxogts2Br2A_HUNVp61QIghM/edit), L063 domain relationships       |                    73 | `kix.3cdr0vj1ebkd`   |       63584 | `c16ae0d9d91bb99a78cd5af06bfc884560c4eca974c56c5b576cbdb20fc9f9a2` |
| Same Data API document, L072 state machines                                                                                                             |                    73 | `kix.j8qqp2z5p3tm`   |       50696 | `ce9932af244815b4a38c9d5da931356ebbb7cf744c9842ae2ba3330ffcb0e11a` |
| [Agent HQ PRD](https://docs.google.com/document/d/1gv4WEkH2Fko1Vj2WXrkLye_CqrpTEUmMvNZsg1R5K0Q/edit), image immediately before Figure 1 caption at L059 |                  2021 | `kix.vzbv0wf940bf`   |       50662 | `ffe6fef5090d37a94c683dcebb58e87f0824883d8013d433d12e6ff9de749d41` |
| [Control Plane TDD](https://docs.google.com/document/d/1sEl6doINP1TpbzZQvpDzDgpMCycFu0PFX90If_UINeg/edit), image before Figure 1 caption at L113        |                   110 | `kix.x35li8uk2135`   |      144576 | `c93a4f16da227eff703bace6ab8e00f0358142a5032ed51005acbcfe1f850b78` |
| Same TDD, image before Figure 2 caption at L137                                                                                                         |                   110 | `kix.obxnsrixkdh2`   |      191741 | `33e16d6cd6683dc9145467da0504573babd07026c25bbe6a5302cf969d047139` |
| Same TDD, image before Figure 3 caption at L181                                                                                                         |                   110 | `kix.ro51mjyzqmi9`   |      119111 | `cafdbfac8880b4b374b8de1d158fc522390b4e0ca6b520a5f4336d6e6b8eff99` |
| [Security & Trust Model](https://docs.google.com/document/d/14-6uCBJQDxJB0Cd8hpIiHx1AvNG7aJWnwBQIp4sWvlE/edit), image before Figure 1 caption at L036   |                    78 | `kix.vlyjrmx8itur`   |      164420 | `75ad026c90af7abe89a8f20f9c3604a17e2a91658b712265fc1299ff730eee6f` |
| Same Security document, inline in heading “3. Workspace Isolation” at L037; no separate caption                                                         |                    78 | `kix.a77to4b9gn0r`   |      112498 | `8f24f3000f97c91b9349e40d494d0cb7a48f9f5c4e6f88d9f3cbc67ad154199c` |

The six additional image byte counts and SHA-256 values above were computed from the recovered PNG bytes. Numeric Drive revisions are from the pinned current-source inventory; native Docs `revisionId` values are opaque API tokens and are not substituted for those numeric revisions. Captions are associated by their actual native text positions, not image filenames or perceived figure numbering. The text-only atomic inventories retain their original hashes, line numbers and atom counts; this audit is supplemental visual evidence.

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

| Subject                 | Relationship label | Object                     |
| ----------------------- | ------------------ | -------------------------- |
| USER                    | has                | MEMBERSHIP                 |
| WORKSPACE               | contains           | MEMBERSHIP                 |
| WORKSPACE               | contains           | ROOM                       |
| WORKSPACE               | emits              | WORKSPACE_EVENT            |
| WORKSPACE               | contains           | AGENT                      |
| WORKSPACE               | contains           | TASK                       |
| WORKSPACE               | contains           | CHANNEL                    |
| WORKSPACE               | surfaces           | RUNTIME_CONNECTION_VIEW    |
| WORKSPACE               | configures         | CONTEXT_PROVIDER_VIEW      |
| WORKSPACE               | scopes             | CONTENT_KEY_EPOCH          |
| WORKSPACE               | provisions         | CLIENT_CONTENT_DEVICE      |
| CONTENT_KEY_EPOCH       | wrapped_as         | CONTENT_KEY_ENVELOPE       |
| CLIENT_CONTENT_DEVICE   | receives           | CONTENT_KEY_ENVELOPE       |
| WORKSPACE               | owns               | CONTENT_REF                |
| CONTENT_REF             | represented_by     | CONTENT_REPLICA            |
| AGENT                   | assigned           | TASK                       |
| AGENT                   | uses               | AGENT_PROFILE_REF          |
| RUNTIME_CONNECTION_VIEW | exposes            | EXTERNAL_SESSION_VIEW      |
| CONTEXT_PROVIDER_VIEW   | surfaces           | MEMORY_WRITE_PROPOSAL_VIEW |
| CHANNEL                 | contains           | MESSAGE                    |
| TASK                    | private_content    | CONTENT_REF                |
| MESSAGE                 | private_body       | CONTENT_REF                |
| TASK                    | references         | EXECUTION_REF              |

Agent HQ Task and Control Plane ExecutionRef remain separate authorities. [Repository ownership](../architecture.md) and the [execution schema](../../packages/database/src/schema/executions.ts) use task identity as correlation, without asserting a shared Agent HQ Task database. The view relationships do not establish runtime-session or provider-memory ownership. This bounded inspection supplies no deployed relationship or storage acceptance.

## Data API state machines

The Control Plane diagram draws `Start → Created → Queued → Running`, then `Running → TimedOut / Cancelled / Failed / Succeeded / AwaitingInput`, with `AwaitingInput → Running`. The adjacent text L070 and the [executable execution-state schema](../../packages/domain/src/execution-lifecycle.ts) instead define `accepted`, `queued`, `starting`, `running`, `awaiting_input`, `cancelling`, `completed`, `failed`, `cancelled`, `timed_out` and `reconciliation_required`.

The canonical Control Plane figure therefore needs to replace Created/Succeeded with accepted/completed and include starting, cancelling and reconciliation_required. A correction must be checked against the [actual transition authority](../../packages/domain/src/execution-lifecycle.ts), rather than assuming the prose's compact sequence enumerates every permitted edge. The Agent HQ Task figure separately draws Created, Queued, Running, AwaitingInput, Succeeded, Failed and Cancelled; its simplified vocabulary agrees with the adjacent Task prose. It should retain its product-owned distinction from Control Plane Execution.

## Agent HQ PRD system figure

The object immediately before the Figure 1 caption at L059 depicts `User → Agent HQ Workspace → Control Plane → Optional ContextProvider?`. The provider “Yes” branch reaches `Validated ContextContribution`; “No / disabled” bypasses it. Both paths reach `Immutable ExecutionPlan → Restate → Graph semantics required?`. “Yes” reaches `LangGraph.js`, “No” bypasses it, and both converge on `Runtime Adapter`. The diagram then shows `Runtime Adapter → Managed Pi` and `Runtime Adapter → ACP Adapter → External Harnesses`, with both runtime branches reaching `Models & Tools`.

The flow is visually readable, but its unconditional Restate box conflicts with adjacent PRD L068, which says default Local uses the embedded SQLite durable queue and Restate is only an explicit Local compatibility option; Hosted/cloud and Self-hosted use Restate. Repository [profile architecture](../architecture.md) and [diagram sources](../architecture/diagram-sources.md) encode the same profile distinction. This figure also does not show which profile selects which durable engine. Caption is native Figure 1, not inferred from the image filename.

## Control Plane TDD runtime and execution figures

The image before TDD Figure 2 (caption L137) is a class/transport diagram. `ManagedPiAdapter` and `ACPAdapter` inherit from `RuntimeAdapter`, whose readable operations are `describe()`, `capabilities()`, `validate(request)`, `startExecution(request)`, `cancelExecution(id)`, `resumeExecution(ref)`, `streamEvents(id)`, and `collectArtifacts(id)`. Both adapters connect to `RuntimeTransport`. `DirectLocalRuntimeTransport` and `RemoteRuntimeGatewayTransport` inherit from `RuntimeTransport`; the former connects to `RuntimeDriver`, the latter to `RuntimeGateway`, which connects to `RuntimeDriver`. `ManagedPiDriver` and `ACPDriver` inherit from `RuntimeDriver`; they connect respectively to `ManagedPi` and `ExternalHarness`. The image encodes no multiplicity. This separation agrees with TDD L136 and the repository [RuntimeAdapter diagram source](../architecture/diagram-sources.md); remote transport is only for a non-co-located RuntimeNode.

The image before TDD Figure 3 (caption L181) gives this execution flow: `Execution Request → Validate Authorization → Resolve AgentProfile / Skills / ProjectState / Context Policy → Optional ContextProvider?`. “Yes” reaches `Request / Validate ContextContribution`; “No / disabled” bypasses the provider; both feed `Compile immutable ExecutionPlan → Restate Workflow → Graph semantics required?`. “Yes” reaches `LangGraph.js Segment`, “No” bypasses it, and both feed `Runtime Adapter`. A `Runtime` decision branches “Managed” to `Managed Pi` and “External” through `ACP Adapter` to `External Harness`; both reach `Normalized Result / Events → Reconciliation → ProjectState`. The image shows Restate as the sole outer workflow engine even though adjacent TDD L128 and L254 and repository profile sources define embedded SQLite as the default Local lifecycle engine, with Restate for Hosted/cloud and optionally for Local. This is a source-internal contradiction, not proof about runtime behavior. As drawn, the flow does show optional provider/no-provider routing, but does not label which profile selects the durable engine. Figure association follows the native caption location, not the image filename.

The TDD Figure 1 image (caption L113) depicts context construction and delegation: `ProjectState → Relevance Selection → ContextProvider policy`. The “Provider” branch reaches `Validated ContextContribution`; “No provider” bypasses it; both paths reach `ContextPackage → Parent Execution`. The parent reaches a `Delegate?` decision: “Yes” branches to Worker A and Worker B, while “No” curves directly toward Result. Parent execution and worker outputs feed `Reconciliation`. Reconciliation reaches `Promote durable output?`; “Yes” loops to ProjectState, “No” reaches Result, and a separate visible reconciliation path also reaches Result. The arrows and labels are readable, but the image gives no cardinalities. The repository [context/delegation diagram source](../architecture/diagram-sources.md) confirms provider optionality; the figure is a conceptual flow, not evidence of running delegation or promotion.

## Security & Trust Model figures

The monochrome image object `kix.vlyjrmx8itur` appears immediately before the body caption “Figure 1. Security trust boundaries and credential flow” at L036. It draws four zones: Agent HQ Application, Selected Control Plane (local, self-hosted, or managed cloud), User Device, and External Provider / Connector. The CP zone contains Control Plane, SQLite local / PostgreSQL server, OS secure storage / managed secrets / credential leases, ContextProvider Registry / Policy / Adapters, Model Gateway, SandboxProvider, Tool Gateway / PolicyDecisionPoint, and a single node labeled `Remote Runtime Gateway / Relay Transport`. The Agent HQ zone contains Neon Auth, Agent HQ API, Event Gateway, `@agent-hq/artifacts`, Cloudflare R2, and Agent HQ PostgreSQL / Drizzle. The device zone contains Desktop Local Runtime Host, Managed Local Pi, External Harnesses, and Cortana / Local Context Provider. Browser / Agent HQ Client is drawn outside the four trust-zone rectangles. The external zone contains Remote Context / Memory Provider and Models / Tools / Connectors / Sandbox Provider.

Readable connection labels on this monochrome figure include `Non-co-located RuntimeNode only`, `Non-co-located provider request`, `Co-located provider request`, `Remote scoped provider request`, and `Outbound authenticated runtime channel`. The image combines Remote Relay and Runtime Gateway in one node, whereas the adjacent Security text L046 and repository [remote-control relay boundary](../remote-control-relay.md) state that Agent HQ product relay and Control Plane Runtime Gateway are separate transports: the relay carries product-control commands to the selected Control Plane host, while Runtime Gateway carries runtime commands to a non-co-located RuntimeNode. The image’s combined node therefore contradicts both the colored image under “3. Workspace Isolation” and the surrounding source/repository separation. Some long crossing lines and arrowheads are too small or overlap boundaries; this audit does not assign uncertain endpoints or infer direction from proximity. The labels and zone contents are readable, but cardinalities are not represented.

The colored image object `kix.a77to4b9gn0r` is embedded in the heading “3. Workspace Isolation” at L037 and has no separate caption. It draws User Device, Agent HQ Application, Selected Control Plane, and External Provider / Connector trust zones. Readable nodes include the Browser / Agent HQ Client; Agent HQ API, Neon Auth, Event Gateway, artifact service/R2, cloud-safe metadata plus E2E ContentReplica ciphertext, and Remote Relay / HPKE ciphertext; Control Plane with profile-appropriate SQLite/PostgreSQL persistence, secure storage/secrets/credential leases, Runtime Gateway marked `non-co-located RuntimeNode only`, Tool Gateway / PolicyDecisionPoint, ContextProvider Registry / Policy / Adapters, Model Gateway, and SandboxProvider; device-side ContentSyncDevice / local E2E sync key, encrypted Agent HQ local content, Desktop Local Runtime Host, Managed Local Pi, External Harnesses, and Cortana / Local Context Provider; and external model/tool/connector/sandbox and remote context/memory providers.

The figure explicitly labels `Cloud-safe service calls`, `Remote product command / HPKE`, `Outbound authenticated runtime channel`, `Co-located provider request`, `Non-co-located provider request`, and `Non-co-located RuntimeNode only`. These readable labels distinguish product relay, direct/co-located access, and remote-only runtime transport. Several long lines cross zones and overlap; where arrowheads/endpoints are too small to resolve, this audit records the node/label boundary but does not assert an exact direction or assign an edge. Cardinalities are not shown. The two security figures draw distinct Agent HQ and Control Plane persistence nodes, consistent with Security L038–L040 and TDD L285; this is design evidence only, not proof against cross-database reads or private-code dependencies. Repository [service ownership](../architecture.md) likewise documents separate data/code ownership. The image’s trust-zone separation is consistent with Security L027–L032 and L046 and repository [remote-control relay boundary](../remote-control-relay.md); it does not by itself verify database isolation, encryption, or any deployed flow. Unlike the monochrome image, it does not combine Relay and Runtime Gateway.

## Remaining acceptance

Two automated-agent readers visually inspected these nine current inline-object captures; this is not independent human acceptance. This establishes their readable content and the documented inconsistencies only. Bounded next lanes are to reconcile the SA/Agent HQ/TDD lifecycle images with profile-specific persistence defaults, split the Security Relay and Runtime Gateway nodes and clarify unresolved edge directions, and validate Data API cardinalities against the owning schema/source before updating its figure. Source-owner review, full figure-to-atom/requirement/code/test/deployment mapping, and independent current-candidate acceptance remain open. Historical ledger classifications and candidate evidence are unchanged. #186 and #195 remain open.
