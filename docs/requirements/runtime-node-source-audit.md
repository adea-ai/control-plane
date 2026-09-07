# RuntimeNode source recovery and extraction

Retrieved through Google Drive on 2026-09-07: [RuntimeNode & Desktop Protocol Specification](https://docs.google.com/document/d/1O25Genu8ChpXF1PZfcPP6rABeBpKt4fQZ6xu3rLrd8I/edit), modified 2026-08-28T07:21:06.166Z. The source identifies itself as an accepted technical specification.

The ledger now extracts CP-RNODE-001 through CP-RNODE-008 for ownership, remote authentication, transport separation, bounds/retention, deduplication, recovery, provider optionality, and local grant containment. These are normative requirements, not claims that the implementation satisfies them. The remaining specification sections still require atomic extraction and cross-profile validation; the original retrieval/reconciliation umbrella requirement remains open.

Source sections 2, 4–6 and 19 establish Agent HQ ownership of registration, pairing and key lifecycle. Control Plane consumes identity validation and owns runtime connections and routing. M11 standalone fixtures must not become a second production identity authority. Live cross-product pairing remains M12 integration scope.

Current source inspection: the Runtime Gateway entrypoint requires an injected WebSocket server in staging/production. Authentication consumes a validation port and the repository contains a synthetic identity implementation. The Hosted composition does not thereby gain a supported production identity backend. Matching issuance/validation, revocation, persistence, authenticated server composition and artifact-backed terminal results must be traced and tested before that gap can close.

Recovered source access resolves the previous indexing blocker. It does not resolve every production transport implementation choice, prove independent conformance, or authorize a change to external registration services.
