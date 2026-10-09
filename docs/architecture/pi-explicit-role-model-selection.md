# Explicit Pi lead and child model selection

The existing authenticated `model-selection.resolve` operation resolves a role (`lead` or `child`) plus an optional exact connection/model override into a stored immutable selection. Eligibility remains dependent on the exact provider, account, model, auth mode, funding kind, harness, location, current credential and workspace grant. Selection is neither spending nor credential-use authority.

The production product reader now accepts optional `requestedModelSelections` on the canonical lead intent:

```ts
{ lead?: { selectionRef: string, selectionRevision: number },
  child?: { selectionRef: string, selectionRevision: number } }
```

At least one role must be present. Exported contracts are `ModelSelectionReferenceSchema` and `RequestedRoleModelSelectionsSchema`. These fields are requested choices, stored separately from the runtime's accepted selection pins. They contain no model snapshots or secrets. The authenticated product reader must re-fetch them under the original actor, audience, profile and message authority. Public prepare and dispatch remain reference-only; callers cannot supply this evidence in those payloads.

The production binding checks every explicit selection against the current workspace, exact configured target and readiness. SQLite retains one immutable winner for each intent/role. Reopen reuses that winner and current eligibility checks; changing a requested choice on the same accepted intent fails closed. Create a fresh canonical intent to choose another model. With no requested lead reference, existing lead-default behavior is preserved. An explicit rejected choice never falls back to a default, another connection, provider or account.

An intent's requested child reference is a child-role default for that admitted intent. A child-specific override must come from a separate current canonical child request. `ProductionChildModelRequestSchema` binds the original actor, parent intent, child request/execution/attempt, exact child and parent plans, reader principal, authority revision and fixed expiry. `createProductionChildModelAuthority` fits the existing Node `childAuthority` port. It resolves child eligibility before invoking canonical admission/allocation, rereads the child authority after readiness, and requires the canonical admission to retain that exact actor and selection. Resume compares the original selection and independently checks current authority. Missing child choices use only the workspace child default; the lead selection is never inherited.

`createProductionPiLeadComposition` exposes `resolveChildSelection` for trusted canonical child hosts and supports an optional `children` configuration. The configuration requires independent current child-request/admission/authority ports, governed child lifecycle/inbox/progress ports, a child execution-bound model authority and canonical cache cleanup. The factory creates child provider and recorded-spending resolution from the same native composition, using the shared ledger. Provider, price and physical-send spending boundaries recheck child authority. There is no lead-provider fallback for child plans. Existing actor, approval, lineage, budget, private payer and physical-send protections remain independent and mandatory.

Terminal child model caches are collected only after the canonical attempt is terminal and its usage allocation is released/reconciled. Running children and unknown physical sends retain their evidence and holds. Cleanup never settles usage or renews a grant.

## Qualification and activation

Focused schema, SQLite reopen and fault-injection tests exercise model selection and host authority boundaries. Scripted authority ports are not live-provider qualification. Adea must store requested references on its canonical admission intent and use these exact contracts; accepted runtime rows must not be inferred as requests. Package publication, credential creation, production configuration and activation are outside this change. No deployed or user-facing capability is inferred from a source-only integration.
