# Canonical source freshness observation

Read-only Google Drive observations on 2026-10-03 found newer revisions and changed text for all fifteen canonical sources. Fetching each recorded historical revision reproduced its checked-in captured-text SHA-256 exactly. This confirms the old capture identity; it does not establish that the old inventories describe the latest sources.

The existing 6,093-clause register and 333-link crosswalk remain tied to their captured revisions. Their classifications and historical evidence are unchanged. The [freshness receipt](canonical-source-freshness-2026-10-03.v1.json) records current revision IDs, revision/file timestamps, exact UTF-8 text hashes and selected root-tab object identities, with no authenticated image URLs. The numeric Drive revision and opaque native Docs revision token are different identifiers. The observations occurred sequentially and do not establish a globally frozen source set.

| Source                       | Captured revision | Observed revision | Current text lines |
| ---------------------------- | ----------------: | ----------------: | -----------------: |
| `project-index`              |               131 |               153 |                 87 |
| `agent-hq-prd`               |              2021 |              2040 |                126 |
| `control-plane-prd`          |                46 |                58 |                231 |
| `cortana-prd`                |                29 |                43 |                150 |
| `system-architecture`        |                99 |               133 |                134 |
| `control-plane-tdd`          |               110 |               134 |                338 |
| `agent-skill-spec`           |                45 |                59 |                110 |
| `data-api-spec`              |                73 |                95 |                238 |
| `runtime-node-spec`          |                25 |                37 |                166 |
| `execution-consistency-spec` |                27 |                45 |                172 |
| `artifact-storage-spec`      |                20 |                37 |                150 |
| `security-trust-model`       |                78 |               103 |                121 |
| `evaluation-plan`            |                53 |                64 |                117 |
| `runtime-compatibility`      |                50 |                63 |                174 |
| `architecture-decisions`     |               138 |               153 |                296 |

## Figure and acceptance boundary

Selected root-tab reads exposed twelve inline objects across five source parents, compared with nine objects in the September 30 figure audit. System Architecture now exposes two new object identities in place of its old object; Security exposes four objects, including three new identities and excluding one old identity. Matching object IDs in the other parents do not prove unchanged image bytes. These observations do not refresh image-byte hashes, visual interpretations, nested-tab completeness or independent human acceptance. The [September 30 figure audit](canonical-figure-audit-2026-09-30.md) remains historical evidence.

## Required reconciliation

#186 and #195 remain open. Review the exact source differences, preserve stable clause identities and durable obligations, explicitly disposition clarified or superseded text, and re-extract changed clauses with current anchors. Then refresh requirement, ownership, implementation/test/profile and evidence mappings; review the current embedded figures and contradictions. Repository implementation snapshots in the source documents describe their cited commits and review date. They do not certify a later candidate, promote failed or incomplete runtime gates, or replace live GitHub planning.

Current-source and frozen-candidate acceptance remain unestablished. Docker is the user-selected environment for this task’s hosted validation; no VPS provisioning is required.
