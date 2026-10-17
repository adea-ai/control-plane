# Digest writer guard

`bun run lint` runs `check:digest-writers` after the existing
`check:canonical-ordering` command. The existing locale-ordering check remains
unchanged. The new guard looks for locale-dependent ordering that reaches a
digest or a persisted digest field; it does not prohibit locale sorting used
only to present data.

The analyzer reads production TypeScript and JavaScript under `apps/`,
`packages/`, and `scripts/`; only the guard's own implementation is excluded.
It skips `.test.` files. It scans direct and computed `localeCompare` calls
plus `Intl.Collator` comparators, and follows statically imported comparator,
serializer, and digest helpers through relative imports and
`@control-plane/<package>` source barrels. It recognizes named aliases,
namespace imports, exported wrappers, object digest fields, crypto
`createHash().update(...)` calls, and persistence methods such as `insert`,
`put`, `save`, and `upsert`. Locale-sorted values written as ordinary display
fields remain allowed, including when the same function hashes unrelated
canonical data. A `CANONICAL-JSON` comment does not exempt a file or a call
site.

This is a bounded static analysis, not a TypeScript type checker. Its importer
frontier follows relevant static named imports and re-exports through local
wrappers and workspace source barrels; crypto dependencies of selected writers
are included to inspect their hash boundary. It tracks simple identifier
aliases and function return values. It does not resolve dynamic imports,
CommonJS `require`, runtime path aliases outside the workspace package
convention, reflection, or arbitrary function-pointer dispatch. Analysis and
parse failures stop the check with an error. The CLI accepts
`--root=/absolute/path` to inspect another checkout; exact exceptions are
always loaded from the guard script's own
`scripts/digest-writer-exceptions.json`.

The exception file is a snapshot of exact source-to-sink edges observed on
`main` at `311c3a83` and on the peer compatibility candidates for PRs #1149,
#1150, #1151, #1152, and #1153. The event-frame edges were refreshed on
`main` at `d1d1d3bd1` during the PR #1154 merge: the events helper gained
both optional-locale comparator branches, so both exact source fingerprints
are conservatively included for each previously reviewed sink. Context entries pin PR #1153 at final head
`20c55cd8158ea09e1e4234d6069afa4f532ad739`. Each edge pins the source path and helper,
the source callsite path and owner, the sink path and owner, token fingerprints,
sink kind, and an occurrence ordinal among identical sites in that owner.
Line numbers are diagnostics only. The ordinal catches a second identical
writer statement while remaining stable when lines or whitespace shift.
Reasons state the existing persisted contract, compatibility verifier, or
known writer debt for that exact edge. Adding a new call site, changing its
owner, adding a duplicate, or changing either fingerprint makes it fail even
when it shares a file with an allowed edge or reuses its legacy helper. These
entries preserve current behavior while a separate format migration is
considered; they do not approve new locale-dependent digest writers or
authorize rewriting stored values.

The inventory includes retained context-package, context-command,
project-state, execution-plan, delegation, event-frame, tool-input,
tool-registration, and tool-schema digest edges; the SQLite context-operation
index; the local graph's legacy result verifier; and a durable-tool fixture.
Some entries are existing writers, not verification-only code; each reason
records that distinction and its provenance. Two exact exceptions document
analysis limits: the event `reject` method reads the versioned `s2` frame hash
from a multi-field return, and the portability CLI only echoes an already
computed digest. Neither exception exempts the source helper or neighboring
call sites. The portability manifest is separately outstanding: published schema-v1 digests
have both a historical locale-ordering epoch and a later unversioned
code-point-ordering epoch. Its exact current locale-dependent edges remain
listed only so this guard does not imply that the format has been migrated or
host-independent. Removing those exceptions requires a separately versioned
manifest digest transition that verifies both historical epochs. The context
operation-key entries also preserve the current durable SQLite namespace; the
analyzer conservatively reports both optional-locale branches in that helper,
while the operation-key call uses the default branch.
