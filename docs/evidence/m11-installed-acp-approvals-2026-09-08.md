# Installed ACP approval investigation

Status: native two-approval scenario passed locally; full M11 acceptance remains incomplete.

The installed native release from the cancellation certification was exercised through the
Local launcher, authenticated HTTP API, SQLite, and real Restate. The extended certification
requests two sequential native command approvals and requires an isolated marker write only
after each grant, followed by aggregate usage of 33 input and 9 output tokens.

## Observations

- The unchanged launcher inherits upstream ACP's `agent` mode, whose approval reviewer is
  `auto_review`. The first approval scenario requested model `codex-auto-review` rather than
  the explicitly selected task model. The fixture rejected that request and timed out waiting
  for a human permission interaction.
- Explicitly selecting upstream `read-only` mode changes the reviewer to `user` while retaining
  upstream workspace-write sandbox semantics. Native permission requests then appear and the
  authenticated interaction endpoint accepts grants.
- Initial tests saw an absent marker at what appeared to be the second permission. Retained
  native session evidence proved the first command did write the marker. Boundary instrumentation
  then showed two different Control Plane interaction IDs while the provider request count was
  still five: these were re-observations of the same native request, not sequential tool calls.
- The first test revision could select an already-observed interaction while its durable state
  was still pending. The test now excludes previously granted interaction IDs; the missing
  marker assertion still failed because the adapter generated a new ID on every replay.
- The driver now memoizes generated interaction IDs by execution handle and native request ID,
  for both permissions and elicitation. Historical progress re-observation therefore cannot
  manufacture another approval for the same request. Separate executions remain separate.
- With stable IDs and the human-review preset, both native marker writes are gated by their
  own grants. The execution completes in one attempt with 33 input and 9 output tokens across
  three model calls. The entire certification makes seven model requests, including the prior
  completion, loaded-session accounting, and cancellation scenarios.

## Validation and next gate

The workspace build passed all 41 packages. The adapter regression reproduces differing IDs
without the fix and passes with it; the adapter test file passes all 30 tests. The installed
native certification passes both grants, marker effects, aggregate usage, and the preceding
completion/cancellation scenarios. This proves the deterministic macOS installed-runtime lane,
not live-provider quality, arbitrary tool coverage, Linux isolation, or in-flight recovery.

No new dependencies or native build changes are involved. The test owns and removes its private
temporary workspace and closes its API, runtime, model server, and Local composition.
