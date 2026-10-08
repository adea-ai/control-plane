# Control Plane TDD revision audit

This file preserves a historical revision comparison for canonical document
`1sEl6doINP1TpbzZQvpDzDgpMCycFu0PFX90If_UINeg`. The historical comparison was reviewed
September 12, 2026; it is not the current source pin.

The historical comparison records file modification time `2026-08-24T20:34:22.096Z`,
revision 85 at `2026-08-24T20:34:22.007Z`, and revision 96 at
`2026-08-28T06:03:21.730Z`; revision 96 file metadata was
`2026-08-28T06:03:21.899Z`. Both versions were fetched by explicit revision ID.

The September 30 extraction baseline is revision 110, modified
`2026-09-29T02:22:57.922Z`; file metadata reports `2026-09-29T02:22:58.053Z`. Its exact
fetched-text SHA-256 is in the [current-source inventory](control-plane-source-inventory.md).
That snapshot's internal review marker is 2026-09-28, earlier than its file modification. Historical
revision-85/revision-96 hashes and comparisons remain unchanged; they are not current-candidate
evidence.

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

## Follow-up and acceptance boundary

Follow-up reviewed September 27, 2026: the live TDD source was updated with a revision-guarded
write. Appendix C now identifies Bun 1.4 workspaces, and Appendix D describes its milestone
statuses as a historical planning baseline with GitHub as the current authority instead of
claiming M1-M11 are complete. The live ADR-027 record now says it is partially superseded by
ADR-035 and records that Bun 1.4 supersedes the original pnpm workspace tooling. Both edits
were verified by read-back. No Drive permissions changed. Revision 96 remains a historical
snapshot and still contains the earlier pnpm/repository-identity wording; the newer canonical
source is what was reconciled.

The marketplace non-goal wording still needs reconciliation against later approved marketplace
plans and implementation, distinguishing runtime-native plugin installation from canonical
Skill ingestion rather than treating them as the same product surface. This is a revision-delta
audit, not a full atomic extraction or a claim that any listed implementation requirement passes.
The ledger's historical source timestamp remains unchanged until its requirement mappings are
re-audited. High-severity reconciliation remains owned by documentation governance under #186
and #195, with behavior and operational proof under #188 and #194 as applicable. The #195
source inventory and marketplace reconciliation remain open.

## October 8 Pi Durable amendment comparison

The [machine-readable amendment audit](control-plane-tdd-amendment-audit-2026-10-08.v1.json)
records all 19 changed blocks between captured revision 110 and observed revision
139 (modified `2026-10-08T04:17:18.396Z`). Drive readback on October 8 confirmed
revision 139 remained current. Its exact fetched UTF-8 text SHA-256 is
`7927e73c156fdf1ef4b67ba51a759f5b37f5eb1df9cf70167e3e60b4546c6b86`.
These are comparison blocks, not 19 atomic requirements or a whole-source audit.

The source describes Pi Durable as the accepted future target and discloses dated
implementation gaps. The comparison retains live Local/Hosted/managed execution,
authorization and approvals, effect and charge certainty, credential custody,
retention, recovery, drain/history and rollback until a replacement qualifies.
In particular, managed upgrades and deterministic configuration generation for
Local/self-hosted Managed Pi remain explicit obligations; generic configuration
and version pinning do not replace them.

Two independent agents reviewed the source interpretation and confirmed that
correction. They did not certify implementation, deployed profiles or independent
approval provenance. The JSON records per-block line ranges, content hashes,
dispositions and retained obligations. Original acceptance ownership stays with
[#186](https://github.com/adea-ai/control-plane/issues/186) and
[#195](https://github.com/adea-ai/control-plane/issues/195).

The linked [Adea TDD](https://docs.google.com/document/d/1QwKfYCXagfmNNQ3NkaHrigGZWuPzEokwCigoz4q0KFY/edit)
was captured at revision 163, modified `2026-10-08T04:17:08.425Z`, and its current
revision was also rechecked. The numbered REQ090–REQ177 span defines 51 explicit
clauses; the source also defines A01–A40 and 23 S labels. The 37 undefined numeric
IDs in that span reflect sparse numbering, not missing requirements or code
defects. Unnumbered obligations remain required. S-label referents/versions and
ADR-038 approval provenance remain unverified.

Matching planned P1–P3 Mermaid source from canonical Diagram Sources revision 83
is now [versioned in the repository](../architecture/diagram-sources.md) through
[PR #953](https://github.com/adea-ai/control-plane/pull/953). This does not establish
independent pixel review, replacement of canonical embedded figures, or runtime
qualification.

The existing 6,093-clause register and 200 bounded requirement rows retain their
historical source/candidate pins. This delta record does not regenerate those
inventories, complete the full clause-to-requirement/code/test/profile mapping,
resolve every contradiction, or satisfy final frozen-candidate acceptance.
