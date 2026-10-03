# Atomic clause register

The [machine-readable register](control-plane-atomic-clauses.v1.json) preserves all
6,093 clause entries from the fifteen checked-in source inventories. Each entry
retains its stable atom ID, inventory line, heading and original Markdown table
columns. Each source records its provider, captured revision and recorded
provenance uncertainty, file modification time,
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

The [October 3 source freshness observation](canonical-source-freshness-2026-10-03.md)
found changed text and newer revisions for all fifteen sources. This register and
its crosswalk remain bound to the earlier captured revisions until an explicit
clause-by-clause reconciliation. The observation does not regenerate or approve
changed source obligations.

The [machine-readable requirement crosswalk](control-plane-atomic-crosswalk.v1.json)
materializes the existing PRD and TDD crosswalks: 333 links from 70 bounded
requirement rows to 291 distinct atoms. It preserves the original crosswalk
columns, qualifications, inventory line and source hashes. Repeated atom mentions
in explanatory notes resolve to one binding per requirement; one atom may still
link to several requirements. The other 5,802 atoms and 130 bounded rows have no
explicit canonical requirement link. This is partial traceability, not evidence
that the linked clauses are implemented, tested across profiles or accepted.

The security inventory's STM source-line crosswalk belongs to a separate selected
control audit. Its table is recorded as `unmaterializedCrosswalkTables`; those IDs
are not canonical requirement IDs. Typed source-audit linkage and complete
requirement/code/test/profile/evidence mapping remain open. Evidence-key locators
also remain locators rather than passing evidence.

`bun run requirements:check` now validates the source inventory's revision/hash
binding, declared clause count, unique identities, parseable table rows and exact
register content. Removing a clause, replacing its text, renaming its identity or
losing a source inventory cannot silently pass merely because the bounded
requirement rows are unchanged. The check does not authorize the content of a
changed normative source or establish milestone completion.

The same check validates declared crosswalks against the source's atom IDs and
canonical requirement ownership. Missing rows, unknown references, reversed or
malformed ranges, duplicate requirement rows and lost crosswalk configuration
fail validation. The generated crosswalk must match its source inventories
exactly; manually editing links or acceptance markers fails drift validation.

After an authorized source-inventory reconciliation, regenerate and review the
register with `bun run requirements:atomic:write`. The command rejects missing,
malformed, duplicate or count-inconsistent inventories before writing. Then run
`bun run requirements:crosswalk:write` to refresh the explicit links, then
`bun run requirements:write` to refresh the human report and
`bun run requirements:check` to check consistency and live issue dispositions.
Do not regenerate simply to hide drift: review the source and inventory diff,
provenance, ownership and any changed acceptance obligations first.
