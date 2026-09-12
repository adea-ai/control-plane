# Control Plane TDD revision audit

Reviewed September 12, 2026. Canonical document:
`1sEl6doINP1TpbzZQvpDzDgpMCycFu0PFX90If_UINeg`.

The ledger records file modification time `2026-08-24T20:34:22.096Z`. Drive history identifies
revision 85 at `2026-08-24T20:34:22.007Z` as the corresponding revision. Current revision 96
is dated `2026-08-28T06:03:21.730Z`; current file metadata is
`2026-08-28T06:03:21.899Z`. Both versions were fetched by explicit revision ID.

The line-level comparison has 300 prior and 303 current lines, with 149 added/removed
lines in the diff. Many lines contain whole paragraphs: this count is not an atomic
requirement count. SHA-256 of retrieved text normalized to LF with a final newline:

- Revision 85: `27e628e8fdf7a34ec91268638068e7eec0fecff7ded8561bf3a9730e7972c511`.
- Revision 96: `b631f400fac1e97a9ca2b23b9a6ae06e8abc0fff0c286b279d7ff32441c12495`.

## Substantive changes requiring ledger reconciliation

1. Restate replaces Temporal as the durable outer lifecycle. LangGraph remains a bounded
   graph/checkpoint layer, separate from ProjectState and lifecycle history.
2. Co-located execution uses direct RuntimeDriver/IPC; the Runtime Gateway is for remote
   RuntimeNodes. Local execution must not require a cloud gateway hop.
3. Persistence is profile-specific: SQLite for Local and Hosted Simple, PostgreSQL for
   Hosted Server and managed cloud. Railway/Neon/R2/Restate replaces the AWS-first reference.
4. AgentProfile versions and field-level merge strategies become deterministic and
   provenance-bearing. Lower-precedence layers cannot broaden higher-precedence constraints.
5. Skill selection is the pinned baseline, authorized explicit requests, and transitive
   dependencies. SemVer resolution, prerelease exclusion, DAG ordering, conflicts and
   supersedes rules must be checked; semantic/LLM selection is not the MVP contract.
6. ContextProvider selection, failure policy and cache identity become explicit. Default
   degradation differs for preferred versus required providers. Core selection must not
   hard-code Cortana priority; retrieval and runtime tool grants remain independent.
7. Operational defaults now specify retry jitter/backoff, heartbeat degradation/offline
   thresholds, inventory freshness, command expiry, ledger retention and dead-letter timing.
   These values require exact mapping to central configuration and behavior tests.
8. Remote content requires the specified HPKE suite and associated-data bindings, with
   signing/authentication keys distinct from encryption keys and rejection of replay,
   expiry, wrong recipient, downgrade, malformed input and tampering.
9. Public contracts now specify executable Zod schemas, generated artifacts, major/minor
   compatibility, bounded cursor pagination, normalized errors and sequence-bearing events.
10. M9, M10, M11 and M12 responsibilities are separated explicitly. A fixture-backed
    standalone implementation gate must not be confused with live M12 product composition,
    nor may fixtures replace a requirement that specifically calls for native or deployed proof.

## Remaining contradictions and acceptance boundary

Revision 96 still names `pnpm` and the former `0xPlayerOne/control-plane` repository, while
the checked-in project uses Bun and `adea-ai/control-plane`. Record and reconcile these
through documentation governance; do not change implementation or reinterpret scope silently.
Its marketplace non-goal wording also needs reconciliation against later approved marketplace
plans and implementation, distinguishing runtime-native plugin installation from canonical
Skill ingestion rather than treating them as the same product surface.

This is a revision-delta audit, not a full atomic extraction or a claim that any listed
implementation requirement passes. The ledger's historical source timestamp remains unchanged
until its requirement mappings are re-audited. High-severity reconciliation remains owned by
documentation governance under #186 and #195, with behavior and operational proof under #188
and #194 as applicable. No canonical Drive content or permissions were changed.
