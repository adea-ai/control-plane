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
closed when any of them drifts from the ledger. This record is hand-authored, so
its own tables are checked against the artifacts they cite: a coverage number, a
recorded worker head or a gate state that the crosswalk and the ledger do not
carry fails the check instead of being published.

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
| Worker lanes recorded                                        | 7 (0 integrated; 7 received) |
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
into the current tree, so no worker result is reported as evidence and no
worker result is promoted into a requirement or issue classification.

| Worker | Lane                              | Status   | Exact head                                 | Issues     | Evidence                                                               |
| ------ | --------------------------------- | -------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------- |
| W1     | cp558-resolution                  | received | `24c84da87575ec458116138ceaa647258a9e51f8` | #558       | #558 context-consumer conformance record and conformance tests         |
| W2     | cp186-195-requirements            | received | `076cc525a9ca2d45f9a727cb44e4e763cef261f4` | #186, #195 | canonical crosswalk, figure inventory, this record                     |
| W3     | cp187-architecture-audit          | received | `70017bd9ae7a46a8a58aada372f9e75166004d02` | #187       | architecture binding-detector handoff, audit script, regression checks |
| W4     | cp190-trust-boundary              | received | `43295261c6a8a5ef112e1e319961f3601f6de71b` | #190       | security/trust-boundary audit record, matrix and probes                |
| W5     | cp191-adversarial-eval            | received | `9bf1cb374a189345750e6dad6057191233c52a61` | #191       | adversarial evaluation program record, baseline scorecard, corpus      |
| W6     | cp196-skill-library               | received | `eb84f92e73a665f676a9a7ff22041b73e0844076` | #196       | blinded comparison packet, skill-eval harness, audit skill             |
| W7     | cp612-project-state-digest-compat | received | `eb7d3ba7f42af0550f14dab8a30fc6a710ebcafc` | #612       | project-state digest compatibility record and reopen-race checks       |

Every lane has published a commit. The recorded worker heads identify received
evidence snapshots, not continuing claims of current remote state. W2 records the
last published state of this lane, which carries the canonical crosswalk, the
figure inventory and this record; the branch head that publishes this record is
always ahead of the head it can name, so the recorded W2 head trails the branch
by construction. A lane that publishes a further commit needs one more refresh.

W7's published head was observed on 2026-10-21 at
`1bdae6df04ef0714c48dc89381ee3c61188a0965`. Its cited evidence retains the
original `eb7d3ba7f42af0550f14dab8a30fc6a710ebcafc` commit. Earlier recorded
checks and timestamps remain historical; they do not certify the newer head,
which requires its own validation. No worker result is integrated or promoted
by this publication metadata correction.

`bun run requirements:refresh` re-reads the live issue identities and is the
step that folds an arrived contribution into the crosswalk.

## Deterministic controls added

| Control                                                | Failure it prevents                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Report, crosswalk and figure-inventory drift           | A published artifact that no longer matches the ledger it was generated from.                                                    |
| Reconciliation record provenance                       | A record table that publishes a coverage number, a worker head or a gate state the cited artifacts do not carry.                 |
| Gap reference resolution against the recorded snapshot | A gap that points at a missing or closed issue, or at an unauthorized milestone.                                                 |
| Orphaned atomic clauses                                | A captured clause set with no requirement link and no accountable owner.                                                         |
| Stale candidate proof                                  | A historical candidate presented as evidence about the current head.                                                             |
| Worker contribution heads                              | Worker evidence integrated without an exact, resolvable commit.                                                                  |
| Worker evidence commit binding                         | A worker evidence entry whose recorded commit is not the head it is proven against.                                              |
| Worker evidence content binding                        | A worker evidence path that resolves in this tree to different content than at the recorded head, read as the reviewed artifact. |
| Historical figure identity binding                     | A figure identity, revision or digest that has left the canonical 2026-09-30 figure audit it was carried from.                   |
| Profile and requirement join audit                     | A deployment profile whose linked requirements contradict the requirement rows that name the profile, read as a coverage claim.  |
| Superseded-row disposition                             | A superseded row with no owner, severity or disposition.                                                                         |
| Pinned formatter version                               | A report regenerated by a different formatter version, which would look like a content drift.                                    |

One defect was found and fixed while adding these controls: the report
generator formatted the report through a child-process pipe and the runtime
truncated that pipe at 512 KiB while still reporting success. The generated
report is larger than that, so `requirements:check` failed on an otherwise
correct tree and `requirements:write` published a partial report. The formatter
now writes to a temporary file descriptor, and the formatter version is verified
against the version pinned in `bun.lock`.

## Open join and lineage gaps at this head

Two joins in this reconciliation are recorded but not closed. Both are reported
on every check instead of being inferred from an empty array. Closing either one
rewrites a generated ledger, which this change does not do.

### Profile and requirement join

`AHQ-CP-005` and `CP-TDD-004` name the `cloud` profile in their recorded
evidence, and the `cloud` profile row links no requirement. The two directions
are derived from different evidence kinds: a requirement row names a profile
through the `profile` attribute of its own evidence entry, while a profile row
links the requirements whose code, test or document evidence path is one of the
profile's evidence paths. Every deployment profile records environment evidence
only, so that intersection is empty for all four profiles. The profile column is
a reference and not a coverage claim.

Closing this requires the crosswalk to record the profile and requirement join
from one rule, and `bun run requirements:write` to republish the crosswalk and
the report. That rewrites a generated ledger, so it is left to the ledger owner.

### Worker evidence content binding

A worker evidence path that exists at the recorded head is not the reviewed
artifact when the same path in this tree carries different content. The table is
the complete inventory of such paths, with the full Git blob identity at the
lane's recorded head and in this tree. It is derived from the recorded heads, not
inferred from file names or from the earlier summary of this section.

Lanes with such a path: 5 of 7 (W1, W2, W3, W5, W6). W4 and W7 have none.

| Worker | Path                                                                          | Blob at the lane head                      | Blob in this tree                          |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| W1     | `docs/architecture/decision-558-context-consumer-conformance.md`              | `35a24669ce734073ed083a63f5265a6365379aee` | `3ecb4635e46ffda7e6b03fa18f5cd73e72773177` |
| W1     | `apps/control-api/src/decision-context-consumer-conformance.test.mjs`         | `1eaab295753b133cba7478562471658e8e3f9989` | `8f6edefb83a0233f36cc58748718294496f494c2` |
| W2     | `docs/requirements/control-plane-requirements-crosswalk.v1.json`              | `04d343c126d52b3cd6162c2f65f29beaef93c63c` | `91d9227b1155c4b16ac2618142d5e2d8c07e7aa5` |
| W2     | `docs/requirements/cp186-195-reconciliation-2026-10-21.md`                    | `5789b8d62607d437c201f8467e4845cc33af83c7` | not recorded (this record)                 |
| W3     | `docs/evidence/m11-architecture-audit-binding-detector-handoff-2026-10-21.md` | `f325249cdbf7116d3eeff8a04a51d325be8029cf` | `c0be0e08052cda90938af8fef6ced862e5fb15d3` |
| W3     | `scripts/architecture-audit.mjs`                                              | `e9e869d59ea264e362a0379dc8f7aea898130fd7` | `f06e80b58866215590c1f2c2e6b2770c52110ec1` |
| W5     | `docs/adversarial-corpus-v1.md`                                               | `866d865fc4738cfea360ba49813e2274ecd3bff4` | `fc2e8e8ef2e0c2cfd169cd322281b07a09040ee0` |
| W6     | `docs/evals/skill-evals/blinded-comparison-packet.md`                         | `5c026a799de13883c18607b41ace410607fbfaef` | `cfea41d1675cbd389417717792387b4667e4512d` |
| W6     | `docs/evals/skill-evals/README.md`                                            | `3be94bdd89aa009d476aafe446da0cc418e691d7` | `920ee64a37d4178ba10e34aee1edbb6f833dd6c0` |

Paths whose content is identical, and so are not mismatches:

- W2 `docs/requirements/canonical-figure-inventory.v1.json`, blob `43c717c7956dc999688b73ef11aa1e748710a418`.
- W6 `.agents/skills/control-plane-audit/SKILL.md`, blob `61b1a77fa5be40dfe320c37313c60ad20e704455`. An earlier version of this table listed it as differing; it does not differ.

Paths that exist at a lane's head and are absent from this tree: W3
`scripts/m11-architecture-audit-regression.test.mjs`; W4 the
audit record, the matrix and `scripts/security-trust-boundary-probes.mjs`; W5 the
evaluation program record and the baseline scorecard; W7 the compatibility record
and the reopen-race test. These are lane artifacts that are not in this tree.

W1 and W6 were omitted from the earlier table because their recorded heads could
not be resolved when it was written. They are now fetched by exact object name
(see "Reproducing full-clone provenance"), so their paths are compared like the
others. A matching blob at two paths does not integrate a lane: every lane stays
"received", not integrated, and no result is promoted into a requirement or issue
classification. Issues #186, #195 and #197 stay open.

The lane-side blob is immutable. The tree-side blob follows later commits to this
tree, and this record cannot name its own tree identity. The validator compares the
table with the recorded heads whenever every recorded head resolves, and reports a
stale row, an omitted path or a wrong lane count; in a shallow checkout the table is
reported as not checked.

Closing this requires the ledger to record the blob identity of each worker
evidence path, which is a generated-ledger change and is left to the ledger
owner.

## Reproducing full-clone provenance

An ordinary clone carries the candidate, the reconciliation base and most lane
heads, but not W1 (`24c84da8…`) or W6 (`eb84f92e…`): those two commits are on no
branch and exist only in the hosting provider's commit store. A shallow checkout
carries none of them, and the validator reports each as unverified, never as
verified. To qualify the worker evidence in a full clone:

1. Use the pinned toolchain from `.node-version` and `.bun-version`; the smoke lane
   fails with `ACP_INSTALL_NODE_24_REQUIRED` on an older Node.
2. Use a complete clone (`git fetch --unshallow` if the clone is shallow) and run
   `bun install --frozen-lockfile`, so the repository-pinned formatter is present.
3. Run `bun run requirements:provenance:fetch`. It fetches each recorded commit that
   is absent by its exact object name, accepts only the object that carries that
   name, and lists every object as `PRESENT`, `FETCHED` or `UNAVAILABLE`. It exits
   non-zero when any object is unavailable.
4. Run `bun run requirements:check`. A lane whose head is still unavailable remains an
   error in a full clone. Nothing is substituted for a missing object, and an
   unavailable object is evidence that was not verified.

The fetch establishes that the recorded commits exist and carry the recorded
names. It does not accept any lane's work: the divergence findings, the semantic
ratification and every other gate below are unchanged.

## Remaining external gates

| Gate                     | Status  | Severity | Owner                    | Next executable action                                                                                                                                                                        |
| ------------------------ | ------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GATE-SOURCE-IMAGE-ACCESS | blocked | high     | documentation-governance | With read-only Drive/Docs access, re-read every parent tab including nested tabs at the current revision and record the native inline-object identity, byte length and SHA-256 of each image. |
| GATE-HUMAN-RATIFICATION  | blocked | high     | documentation-governance | The source owner reviews the 1529 changed clauses and the current figure inventory and ratifies or corrects each disposition.                                                                 |
| GATE-INDEPENDENT-SAMPLE  | blocked | high     | independent-reviewer     | An independent reviewer reproduces the crosswalk, the drift controls and a representative sample on the exact recorded head.                                                                  |
| GATE-WORKER-EVIDENCE     | pending | medium   | requirements-ledger      | Refresh the ledger after a lane publishes a further commit; every lane currently has a published head and none is merged into this tree.                                                      |
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
- No generated ledger was edited or republished. The profile and requirement join
  and the worker evidence content binding are reported by the checks; closing
  them rewrites the crosswalk, the report and the ledger.
- No milestone was closed, deferred or narrowed, and no historical result was
  promoted.
