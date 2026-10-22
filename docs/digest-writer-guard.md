# Digest writer guard

`bun run lint` runs `check:digest-writers` after the existing
`check:canonical-ordering` command. The existing locale-ordering check remains
unchanged. The new guard looks for locale-dependent ordering that reaches a
digest or a persisted digest field; it does not prohibit locale sorting used
only to present data.

The analyzer expects a repository root containing both `apps/` and
`packages/`. It also scans the top-level `scripts/` directory when present;
that directory alone may be absent. An empty or invalid root, a missing
required directory, or any error while traversing an existing scan directory
fails the check with the affected path. In particular, a recursive `ENOENT`
is an error rather than an omitted subtree. The scanner reads production
TypeScript and JavaScript under those roots; only the guard's own
implementation is excluded. It skips `.test.` files. It scans direct and
computed `localeCompare` calls
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
parse failures stop the check with an error. The CLI accepts a non-empty
`--root=/absolute/path` to inspect another checkout; exact exceptions are
always loaded from the guard script's own
`scripts/digest-writer-exceptions.json`.

The exception file is a snapshot of exact source-to-sink edges observed on
`main` at `311c3a83` and on the peer compatibility candidates for PRs #1149,
#1150, #1151, #1152, and #1153. Context entries pin PR #1153 at final head
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
The PR #1151 integration candidate at immutable head
`93bef9334055db6a3fbb2ca5c452d3fa60bb0520` adds six exact tool-digest edges. They
pair the helper's default and explicit-locale comparator call sites with
`digestWithLocale`, legacy `digest`, and the existing child-continuation
fixture. The untagged matchers accept `digestV2` or explicit locale digests
for only the two evidenced locales, `en-US` and `sv-SE`; they do not use the
host-default `digest` helper as a fallback. That helper remains available to
reproduce legacy host-default bytes for existing legacy APIs and the historical
fixture. Tagged version 2 accepts only the version-2 digest; malformed or
unknown versions fail closed. Untagged code-point v2 digests are accepted on
all runtimes; locale-dependent historical candidates are accepted only on the
exact Bun 1.4.2 and ICU 78.1 runtime pair. Unknown runtimes and unsupported
locales fail closed before effects, and no environment setting bypasses this
fence. A future Bun or ICU upgrade requires requalifying the fixed historical
fixtures before extending the supported pair. These exceptions cover only the
source/sink pairs in that candidate and do not permit other locale choices.
Their provenance records the prior published head and this immutable
integration-candidate snapshot separately; the candidate snapshot is an
identity for the reviewed source, not a claim of publication.

Published PR #1152 at immutable head
`bf6d40647c5ad8206859c63310fa59b9a0eebf99` adds six exact analyzer edges for
the default and explicit-locale `canonicalJson` call sites. The runtime frame
receipt path continues to use the default helper, preserving its existing
bytes; the explicit `en-US` helper call is confined to historical untagged
terminal-usage verification. The candidate includes a fixed historical
en-US payload checked under an `sv-SE` host locale. The `#reject` edge remains
a property-insensitive analyzer false positive: that path compares the
versioned `s2` frame hash. These exceptions do not authorize a new locale
dependent writer. The event helper still uses the current runtime's ICU
collation data, so this does not prove reproducibility across ICU upgrades. The
candidate passed full-root validation and the PostgreSQL historical-consumer check.

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
