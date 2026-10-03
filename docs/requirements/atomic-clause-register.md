# Atomic clause register

The [machine-readable register](control-plane-atomic-clauses.v1.json) preserves all
6,093 clause entries from the fifteen checked-in source inventories. Each entry
retains its stable atom ID, inventory line, heading and original Markdown table
columns. Each source records its captured revision, file modification time,
captured-text SHA-256, inventory path and a separate SHA-256 of the inventory
Markdown. These two hashes identify different artifacts.

The register covers the captured text and its recorded dispositions. It does not
supply unavailable embedded figures, prove that Drive has not changed since
capture, or certify the recorded audit candidate. Definitions, metadata and
superseded/planned decisions remain their recorded source clauses; the generator
does not silently relabel them as accepted implementation requirements.

The 200 bounded requirement rows remain separate from the 6,093 source clauses.
Full atom-to-requirement, ownership, code/test/profile and deployed/independent
evidence mapping remains an open [#186](https://github.com/adea-ai/control-plane/issues/186)
acceptance gate. Preserve the source inventory's explicit incomplete mapping and
unestablished acceptance markers. An inventory path or evidence key is a location,
not a passing test or production proof.

`bun run requirements:check` now validates the source inventory's revision/hash
binding, declared clause count, unique identities, parseable table rows and exact
register content. Removing a clause, replacing its text, renaming its identity or
losing a source inventory cannot silently pass merely because the bounded
requirement rows are unchanged. The check does not authorize the content of a
changed normative source or establish milestone completion.

After an authorized source-inventory reconciliation, regenerate and review the
register with `bun run requirements:atomic:write`. The command rejects missing,
malformed, duplicate or count-inconsistent inventories before writing. Then run
`bun run requirements:write` to refresh the human report and
`bun run requirements:check` to check consistency and live issue dispositions.
Do not regenerate simply to hide drift: review the source and inventory diff,
provenance, ownership and any changed acceptance obligations first.
