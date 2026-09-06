# Control Plane Diagram Sources

Status: Canonical repository companion source
Last reviewed: 2026-08-28

These Mermaid definitions are the version-controlled Control Plane companion to the canonical Google Drive diagram catalog. If the two sources diverge, update both in the same architecture reconciliation pass.

## Editing and rendering rules

1. Edit Mermaid source before replacing a rendered image.
2. Validate/render the diagram before updating an embedded figure.
3. Keep ownership boundaries consistent with the canonical PRDs/TDDs/ADRs.
4. Do not conflate Adea Remote Relay with Control Plane Runtime Gateway.
5. Co-located Local runtime/provider access must not traverse Runtime Gateway.
6. M9 managed cloud is Railway + Neon + R2 + Restate; M10 adds Local/Hosted adapters without changing core semantics.

## Control Plane TDD: Execution & Orchestration

```mermaid
flowchart TB
    RQ[Execution Request] --> AUTH[Validate Authorization]
    AUTH --> RES[Resolve AgentProfile / Skills / Context]
    RES --> EP[Compile immutable ExecutionPlan]
    EP --> RS[Restate Durable Lifecycle]
    RS --> C{Graph semantics required?}
    C -->|No| RA[RuntimeAdapter]
    C -->|Yes| LG[Bounded LangGraph.js Segment]
    LG --> RA
    RA --> TR{RuntimeTransport}
    TR -->|Co-located| DL[DirectLocalRuntimeTransport]
    TR -->|Non-co-located| RG[RemoteRuntimeGatewayTransport]
    DL --> RD[RuntimeDriver]
    RG --> GW[Runtime Gateway]
    GW --> RD
    RD --> RT{Runtime family}
    RT -->|Managed| PI[Managed Pi]
    RT -->|External| ACP[ACP-connected Harness]
    PI --> OUT[Normalized Result / Events]
    ACP --> OUT
    OUT --> REC[Reconciliation]
    REC --> PS[(ProjectState)]
```

## Control Plane TDD: Context & Delegation Lifecycle

```mermaid
flowchart TB
    PS[(ProjectState)] --> SEL[Relevance Selection]
    EXT[Authorized caller / Artifact / LocalProjectGrant refs] --> SEL
    SEL --> PSEL{ContextProvider policy}
    PSEL -->|Disabled / none| CP[ContextPackage]
    PSEL -->|Preferred / required| CPA[ContextProviderAdapter]
    CPA --> CPD{Provider transport}
    CPD -->|Co-located| DIR[ContextProviderDriver / direct local-service boundary]
    CPD -->|Remote when required| REM[Approved remote provider transport]
    DIR --> CC[Validated ContextContribution]
    REM --> CC
    CC --> CP
    CP --> P[Parent Execution]
    P --> D{Delegate?}
    D -->|No| R[Result]
    D -->|Yes| W1[Worker A]
    D -->|Yes| W2[Worker B]
    W1 --> FAN[Reconciliation]
    W2 --> FAN
    P --> FAN
    FAN --> A{Promote durable output?}
    A -->|Yes| PS
    A -->|No| R
    FAN --> R
```

## Control Plane TDD: Runtime Adapter Architecture

```mermaid
classDiagram
    class RuntimeAdapter {
      +describe()
      +capabilities()
      +validate(request)
      +startExecution(request)
      +cancelExecution(id)
      +resumeExecution(ref)
      +streamEvents(id)
      +collectArtifacts(id)
    }
    class ManagedPiAdapter
    class ACPAdapter
    class RuntimeTransport {
      +send(command)
      +cancel(commandId)
      +reconcile(commandId)
    }
    class DirectLocalRuntimeTransport
    class RemoteRuntimeGatewayTransport
    class RuntimeGateway
    class RuntimeDriver {
      +describeOperations()
      +execute(command)
      +cancel(commandId)
      +reconcile(commandId)
    }
    class ManagedPiDriver
    class ACPDriver
    class ManagedPi
    class ExternalHarness

    RuntimeAdapter <|-- ManagedPiAdapter
    RuntimeAdapter <|-- ACPAdapter
    ManagedPiAdapter --> RuntimeTransport
    ACPAdapter --> RuntimeTransport
    RuntimeTransport <|-- DirectLocalRuntimeTransport
    RuntimeTransport <|-- RemoteRuntimeGatewayTransport
    DirectLocalRuntimeTransport --> RuntimeDriver
    RemoteRuntimeGatewayTransport --> RuntimeGateway
    RuntimeGateway --> RuntimeDriver
    RuntimeDriver <|-- ManagedPiDriver
    RuntimeDriver <|-- ACPDriver
    ManagedPiDriver --> ManagedPi
    ACPDriver --> ExternalHarness
```

## Managed Cloud and Portability Profiles

```mermaid
flowchart TB
    CORE[Shared Control Plane Core / Public Contracts]

    subgraph Cloud["M9 Managed Cloud Reference"]
      RAIL[Railway Compute]
      NEON[(Neon PostgreSQL)]
      R2[(Cloudflare R2)]
      RSC[Restate]
    end

    subgraph Local["M10 Local"]
      LCP[All-in-one Control Plane]
      SQL[(node:sqlite)]
      LRS[Single-node Restate]
      FS[(Filesystem ObjectStore)]
      DRT[Direct RuntimeTransport]
    end

    subgraph Hosted["M10 Hosted"]
      HCP[Compose Control Plane]
      HP[(SQLite simple / PostgreSQL server)]
      HRS[Restate]
      HOS[(Filesystem / S3-compatible ObjectStore)]
      HRT[Direct or Remote RuntimeTransport]
    end

    CORE --> RAIL
    RAIL --> NEON
    RAIL --> R2
    RAIL --> RSC

    CORE --> LCP
    LCP --> SQL
    LCP --> LRS
    LCP --> FS
    LCP --> DRT

    CORE --> HCP
    HCP --> HP
    HCP --> HRS
    HCP --> HOS
    HCP --> HRT
```

## ProjectState Concurrency and Promotion

```mermaid
sequenceDiagram
    participant E1 as Execution A
    participant E2 as Execution B
    participant P as Promotion Service
    participant S as ProjectState Store
    participant R as Reviewer or Policy
    E1->>P: StatePromotionProposal at revision 12
    E2->>P: StatePromotionProposal at revision 12
    P->>S: Compare-and-swap expected_revision 12
    S-->>P: Commit revision 13
    P->>S: Compare-and-swap expected_revision 12
    S-->>P: Conflict with current revision 13
    P->>R: Classify compatible, superseding, or review-required
    R->>S: Rebase, merge, approve, or reject
    S-->>P: New immutable revision when approved
    Note over E1,S: ContextPackages pin the exact ProjectState revision and item versions used
```
