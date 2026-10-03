# Current canonical source text reconciliation — 2026-10-03

This register reconciles the 15 current text captures recorded in the [freshness receipt](canonical-source-freshness-2026-10-03.md) with the historical 6,093-clause inventory. It preserves every historical atom and source revision. It adds independently checkable draft clauses for the changed text; requirement, implementation, profile acceptance, and independent human source review remain pending.

The [machine-readable reconciliation](canonical-source-lineage-2026-10-03.v1.json) contains 4,564 historical atoms whose referenced line text is equal and 1,529 whose source lines changed. All 195 changed blocks have explicit dispositions, including inserted metadata and deleted text. Empty current blocks contain no current clauses. Every nonblank changed current line is anchored by a draft clause. Equal text is mechanical lineage: identical wording, repeated lines, heading changes, or changed surrounding context can still alter the meaning of an obligation.

| Source                       | Captured → observed revision | Equal-text atoms | Changed-text atoms | Changed blocks | Draft current clauses |
| ---------------------------- | ---------------------------- | ---------------- | ------------------ | -------------- | --------------------- |
| `project-index`              | 131 → 153                    | 63               | 72                 | 10             | 69                    |
| `agent-hq-prd`               | 2021 → 2040                  | 249              | 166                | 15             | 87                    |
| `control-plane-prd`          | 46 → 58                      | 254              | 93                 | 17             | 85                    |
| `cortana-prd`                | 29 → 43                      | 294              | 72                 | 9              | 43                    |
| `system-architecture`        | 99 → 133                     | 266              | 280                | 21             | 164                   |
| `control-plane-tdd`          | 110 → 134                    | 361              | 60                 | 15             | 137                   |
| `agent-skill-spec`           | 45 → 59                      | 147              | 90                 | 9              | 48                    |
| `data-api-spec`              | 73 → 95                      | 764              | 171                | 20             | 119                   |
| `runtime-node-spec`          | 25 → 37                      | 291              | 18                 | 9              | 68                    |
| `execution-consistency-spec` | 27 → 45                      | 316              | 56                 | 13             | 70                    |
| `artifact-storage-spec`      | 20 → 37                      | 215              | 22                 | 11             | 36                    |
| `security-trust-model`       | 78 → 103                     | 177              | 84                 | 12             | 114                   |
| `evaluation-plan`            | 53 → 64                      | 345              | 121                | 8              | 29                    |
| `runtime-compatibility`      | 50 → 63                      | 259              | 67                 | 11             | 34                    |
| `architecture-decisions`     | 138 → 153                    | 563              | 157                | 15             | 99                    |

## Integrity and reproduction

The generation step verifies all pinned and current capture SHA-256 values and logical line counts against the historical inventory and freshness receipt. Ordered equal/change spans partition both captures without gaps or overlap. Equal spans are checked against the actual captured lines. Each changed block retains hashes of its old/current line arrays; old atom references are derived from source-line intersections. Current clause anchors must stay within their changed block. Dated implementation reports, definitions, navigation, supersession records, and obligations have separate kinds.

Each complete per-source reconciliation payload, including draft clause text, anchors, block hashes, and pending acceptance fields, is bound by `lineageRegisterSourceSha256` in the freshness receipt. The existing `requirements:check` command validates that binding and reconstructs the historical anchor mapping. A clause or status edit without a coordinated receipt update fails. Updating both files is a reviewable source-extraction change; this integrity check does not establish that a paraphrase preserves all source meaning.

Run the committed structural check with:

```sh
bun scripts/canonical-source-lineage.mjs
```

For a full local recapture check, supply the private capture directory (never commit its raw captures or authenticated figure URLs):

```sh
bun scripts/canonical-source-lineage.mjs --check-captures "$CAPTURE_DIRECTORY"
```

The directory must contain `<sourceId>-pinned.txt` and `<sourceId>.txt` for every source. To regenerate from explicitly reviewed changed blocks, use:

```sh
bun scripts/canonical-source-lineage.mjs --write   --analysis "$LINEAGE_ANALYSIS_JSON"   --proposals "$REVIEWED_PROPOSALS_JSON"   --capture-dir "$CAPTURE_DIRECTORY"
```

The analysis contains each source ID and ordered changed-block type/old/current inclusive line ranges. Proposals contain the corresponding block ranges, explicit disposition/reason, affected old atom IDs, and current clause kind/text/source-line arrays. Generation writes the reconciliation and updates its per-source bindings in the freshness receipt. Capture and proposal hashes do not replace semantic review.

## Remaining acceptance

This is a current-text reconciliation input for [M11.10](https://github.com/adea-ai/control-plane/issues/195) and the [full M11 audit](https://github.com/adea-ai/control-plane/issues/186). The historical inventory, existing partial crosswalk, source requirements ledger, and their acceptance classifications are unchanged. The draft current clause IDs are revision-specific extraction identifiers, not aliases for historical atoms or verified requirement IDs.

Independent source review must reconcile changed context and every old obligation, including deleted/superseded wording. The full clause-to-requirement/code/test/profile mapping remains unfinished. Current figure bytes, nested tabs, source visual consistency, all profile/runtime/security/evaluation/retention evidence, and the final frozen-candidate human acceptance remain separate gates. Docker is the authorized validation substrate; a VPS is not required by the user's task scope.
