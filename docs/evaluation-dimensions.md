# Evaluation dimensions

M11.6 extends the versioned production-readiness evaluation schema with goal coverage,
constraint adherence, evidence sufficiency, assumption disclosure, uncertainty calibration,
scope control, verification completeness, cleanup completeness, security, provenance correctness,
escalation quality, reliability, efficiency, handoff quality, reviewer feedback, and token usage.
Existing functional correctness, tool use, structured output, policy compliance, runtime
compatibility, latency, and cost dimensions remain supported.

Score dimensions are higher-is-better; `latency_ms`, `cost_usd`, and `tokens` are
lower-is-better. Each versioned task rubric supplies its own thresholds and required dimensions.
There is no universal numerical quality threshold. A missing required metric fails the case;
a failed required case blocks promotion even if other aggregate scores are high. Candidate
comparisons must use the matching version-pinned baseline and declared regression tolerances.

Execution adapters receive a detached copy of the case. Their changes to thresholds or required
flags cannot modify the evaluator's authoritative suite. This prevents object-aliasing mistakes
or manipulation at this callback boundary; it is not a sandbox for arbitrary in-process code.

Promotion and rollback hold a per-gate update guard while their audit record is persisted.
Conflicting updates return `RELEASE_GATE_UPDATE_IN_PROGRESS`; reads and updates to independent
gates remain available. A rejected audit write leaves promoted state unchanged and releases the
guard. This is a single-registry concurrency contract, not distributed locking or durable gate
recovery across processes; those require an authoritative persistence integration.

These contracts validate supplied measurements; they do not prove those measurements are true.
The M11.6 task corpus, deterministic evidence scorers, controlled live-provider runs, human
calibration, hidden-task rotation, statistical comparisons, and provenance records remain
separate required deliverables. A green schema or gate unit test is not an agent-quality result.
