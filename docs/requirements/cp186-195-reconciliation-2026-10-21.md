# CP #186 / #195 requirements and source reconciliation — 2026-10-21

Status: **both issues remain open.** This record closes the reconciliation
_instrumentation_ lane only. It does not satisfy any acceptance criterion, does
not close #186 or #195, and does not promote any historical result.

- Reconciled against base `27f17bd55e0266439b5b3089163195c9e7a669be`.
- Recorded candidate `d3e449471d02f791c52196ea296a5a8a653a4dd4` (2026-08-30
  baseline) does **not** cover that base and is retained unchanged as a
  historical baseline only.
- Current source revisions come from the recorded 2026-10-03 freshness
  observation. No source document was modified and no canonical Google Doc was
  written through any workflow.

## What now exists

| Artifact                                                                                       | Purpose                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [control-plane-requirements-crosswalk.v1.json](./control-plane-requirements-crosswalk.v1.json) | The one canonical current-source → atomic clause → requirement → code/test/profile → issue/evidence crosswalk, generated from the ledger, the atomic register, the atomic crosswalk, the source lineage register and the freshness receipt. |
| [canonical-figure-inventory.v1.json](./canonical-figure-inventory.v1.json)                     | The actual embedded-object inventory: current native inline-object identities per source revision, the historical PNG identities and hashes, and the identity reconciliation between them.                                                  |
| [control-plane-requirements.v1.json](./control-plane-requirements.v1.json)                     | The ledger, extended with the recorded GitHub issue snapshot, per-source dispositions for unlinked clauses, the worker contribution slots and the external acceptance gates.                                                                |
| [control-plane-requirements.md](./control-plane-requirements.md)                               | The generated report, now carrying the current-source reconciliation table, the canonical crosswalk table, the GitHub issue reconciliation, the worker evidence table and the open gates.                                                   |

All four are deterministic: `bun run requirements:write` regenerates the report,
the crosswalk and the figure inventory, and `bun run requirements:check` fails
closed when any of them drifts from the ledger.

## Crosswalk coverage

| Measure                                                      |                        Value |
| ------------------------------------------------------------ | ---------------------------: |
| Normative sources joined                                     |                           15 |
| Sources with a recorded current revision                     |                           15 |
| Sources whose text changed after the captured revision       |                           15 |
| Captured atomic clauses                                      |                         6093 |
| Captured clauses whose source text changed                   |                         1529 |
| Current clauses extracted into the lineage register          |                         1202 |
| Explicit clause-to-requirement links                         |                          333 |
| Linked clauses                                               |                          291 |
| Unlinked clauses carrying an explicit per-source disposition |                         5802 |
| Bounded requirement rows                                     |                          200 |
| Requirement rows with at least one clause link               |                           70 |
| Requirement rows with a recorded code target                 |                           13 |
| Requirement rows with a recorded test target                 |                          132 |
| Requirement rows with a recorded profile target              |                            2 |
| M1–M10 issue audits                                          |                          103 |
| Deployment profiles                                          | 4 (all `partially_verified`) |
| Worker lanes recorded                                        | 7 (0 integrated; 6 received) |
| External acceptance gates recorded                           |                            5 |

The crosswalk joins what exists; it does not invent links. Every unlinked
clause set carries an owner, a severity, a disposition and an issue, so no
clause is silently orphaned. `planned`, `tbd` and `superseded` rows keep their
classification and normative state; superseded rows now carry an explicit
supersession record (owner, severity, disposition, issue) instead of being
exempt from accountability.

## GitHub status reconciled against repository documentation

The GitHub milestone for these issues now renders as **“M19 — Feature Completion
& Production Audit”** while the repository documentation labels the same
milestone **M11**. Issue numbers are the stable identity; the display titles are
informational and were changed on GitHub without a corresponding documentation
change.

| Issue | Repository documentation label | Current GitHub title | State  |
| ----- | ------------------------------ | -------------------- | ------ |
| #186  | M11.1                          | M19.01               | OPEN   |
| #187  | M11.2                          | M19.02               | OPEN   |
| #188  | M11.3                          | M19.05               | OPEN   |
| #189  | M11.4                          | M19.03               | OPEN   |
| #190  | M11.5                          | M19.06               | OPEN   |
| #191  | M11.6                          | M19.07               | OPEN   |
| #192  | M11.7                          | M11.7 (unchanged)    | CLOSED |
| #193  | M11.8                          | M19.08               | OPEN   |
| #194  | M11.9                          | M19.09               | OPEN   |
| #195  | M11.10                         | M19.10               | OPEN   |
| #196  | M11.11                         | M19.11               | OPEN   |
| #197  | M11.12                         | M19.12               | OPEN   |

Two concrete divergences between the recorded repository documentation and the
live issue state:

- **#189 and #193 were reopened.** The 2026-09-30 acceptance continuation
  records both as closed. Both are open on GitHub today. Their acceptance
  criteria are therefore live again and their earlier closure is not evidence.
- **The M19 numbering does not follow issue order.** #188 is M19.05 while #189
  is M19.03, and no issue carries M19.04. The repository's M11.N labels remain
  the only stable way to name these gates.

The live state was recorded from the public GitHub REST API without
authentication, on 2026-10-21, and is stored in the ledger as
`githubIssueSnapshot`. A recorded open state is not evidence that the acceptance
criteria hold.

## Embedded figure and tab inventory

The inventory records object identity, not captions. The 2026-10-03 root-tab
read exposed **12** inline objects across five parents; the 2026-09-30 audit
recorded **9** objects with their PNG SHA-256 values.

| Source                         | Current revision | Current objects | Retained identity | New identity | Absent identity | Current image bytes | Nested tabs inventoried |
| ------------------------------ | ---------------: | --------------: | ----------------: | -----------: | --------------: | ------------------- | ----------------------- |
| Agent HQ PRD                   |             2040 |               1 |                 1 |            0 |               0 | no                  | no                      |
| System Architecture Overview   |              133 |               2 |                 0 |            2 |               1 | no                  | no                      |
| Control Plane TDD              |              134 |               3 |                 3 |            0 |               0 | no                  | no                      |
| Data Model & API Specification |               95 |               2 |                 2 |            0 |               0 | no                  | no                      |
| Security & Trust Model         |              103 |               4 |                 1 |            3 |               1 | no                  | no                      |

Consequences that the repository must not paper over:

- The System Architecture figure at revision 133 is **not** the figure that the
  2026-09-30 audit read at revision 99. Its captured PNG hash describes the
  historical revision only.
- The Security & Trust Model at revision 103 exposes three object identities
  that were not present at revision 78, and the identity that carried the
  “3. Workspace Isolation” image is no longer observed. The relay/runtime-gateway
  split recorded in the September audit cannot be confirmed against the current
  image.
- No nested tab was inventoried in any recorded observation, and no image bytes
  were refreshed at any current revision. A retained object identity does not
  prove unchanged image bytes.

The September 30 audit remains the historical evidence for the visual reading of
the captured bytes; it is not refreshed by this inventory.

## Worker integration

The seven contributing lanes are recorded by stable ID with an exact head. A
received contribution names a commit that exists in the repository, and each of
its evidence paths is proven against the tree of that commit, because a lane's
files are not in this branch until it is merged. No contribution is integrated
into the current tree, so no worker result is reported as evidence.

| Worker | Lane                              | Status   | Exact head                                 | Issues     | Evidence                                                               |
| ------ | --------------------------------- | -------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------- |
| W1     | cp558-resolution                  | received | `661bb80f606d9637de8b4199b3e862e127a33968` | #558       | #558 context-consumer conformance record and conformance tests         |
| W2     | cp186-195-requirements            | received | `b2de58916ba5315f4cf5ad40aa8399161abc263a` | #186, #195 | canonical crosswalk, figure inventory, this record                     |
| W3     | cp187-architecture-audit          | received | `fc169f506ec98432883af6cd26bcc8a0101570f3` | #187       | architecture binding-detector handoff, audit script, regression checks |
| W4     | cp190-trust-boundary              | received | `40444c70a5d688628f4ddbc792c91ce957a2c2e9` | #190       | security/trust-boundary audit record and its matrix                    |
| W5     | cp191-adversarial-eval            | received | `2326e670420ebc1725ab36e0442b1849d425686d` | #191       | adversarial evaluation program record, baseline scorecard, corpus      |
| W6     | cp196-skill-library               | received | `683fe954028901841bb6c20f27a795cdde757db2` | #196       | blinded comparison packet, skill-eval harness, audit skill             |
| W7     | cp612-project-state-digest-compat | pending  | —                                          | #612       | —                                                                      |

The architecture, adversarial-evaluation and skill-library lanes still had
uncommitted changes when this record was written, so their recorded heads are
provisional. The project-state digest lane had not published a head. W2 records
the commit that carries the canonical crosswalk, the figure inventory and this
record.

`bun run requirements:refresh` re-reads the live issue identities and is the
step that folds an arrived contribution into the crosswalk.

## Deterministic controls added

| Control                                                | Failure it prevents                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Report, crosswalk and figure-inventory drift           | A published artifact that no longer matches the ledger it was generated from.                 |
| Gap reference resolution against the recorded snapshot | A gap that points at a missing or closed issue, or at an unauthorized milestone.              |
| Orphaned atomic clauses                                | A captured clause set with no requirement link and no accountable owner.                      |
| Stale candidate proof                                  | A historical candidate presented as evidence about the current head.                          |
| Worker contribution heads                              | Worker evidence integrated without an exact, resolvable commit.                               |
| Superseded-row disposition                             | A superseded row with no owner, severity or disposition.                                      |
| Pinned formatter version                               | A report regenerated by a different formatter version, which would look like a content drift. |

One defect was found and fixed while adding these controls: the report
generator formatted the report through a child-process pipe and the runtime
truncated that pipe at 512 KiB while still reporting success. The generated
report is larger than that, so `requirements:check` failed on an otherwise
correct tree and `requirements:write` published a partial report. The formatter
now writes to a temporary file descriptor, and the formatter version is verified
against the version pinned in `bun.lock`.

## Remaining external gates

| Gate                     | Status  | Severity | Owner                    | Next executable action                                                                                                                                                                        |
| ------------------------ | ------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GATE-SOURCE-IMAGE-ACCESS | blocked | high     | documentation-governance | With read-only Drive/Docs access, re-read every parent tab including nested tabs at the current revision and record the native inline-object identity, byte length and SHA-256 of each image. |
| GATE-HUMAN-RATIFICATION  | blocked | high     | documentation-governance | The source owner reviews the 1529 changed clauses and the current figure inventory and ratifies or corrects each disposition.                                                                 |
| GATE-INDEPENDENT-SAMPLE  | blocked | high     | independent-reviewer     | An independent reviewer reproduces the crosswalk, the drift controls and a representative sample on the exact recorded head.                                                                  |
| GATE-WORKER-EVIDENCE     | pending | medium   | requirements-ledger      | Refresh the ledger after each lane publishes its final head; the received lanes still have uncommitted changes.                                                                               |
| GATE-CURRENT-CANDIDATE   | blocked | high     | validation-architecture  | Freeze a current candidate on the reconciled head, record it in `candidate`, and run the required deterministic lanes.                                                                        |

Human semantic ratification, an independent representative sample and current
source image access are real external gates. None of them was simulated,
inferred or recorded as satisfied.

## What was deliberately not done

- No canonical Google Doc was written. The source owner owns the canonical
  documents, and the reconciliation is read-only.
- No requirement, issue-audit or profile classification was changed. The
  reconciliation adds join structure, dispositions and gates; it does not
  upgrade evidence.
- No image was inferred from a caption. Object identity is recorded from native
  inline-object references only, and absent bytes are recorded as absent.
- No milestone was closed, deferred or narrowed, and no historical result was
  promoted.
