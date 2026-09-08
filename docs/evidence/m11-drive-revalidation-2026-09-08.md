# M11.10 Drive source revalidation

Source revalidation and scoped correction, not completion of the documentation audit. Live GitHub
inspection shows #186, #187, and #189 closed; #188 and #190–#197 remain open.
Issue closure is not independent acceptance evidence.

Google Drive discovery and content retrieval are available in this session.
The existing `docs/requirements` inventory already records earlier retrievals;
this pass does not replace that inventory or claim newly discovered access.

## Findings from the two inspected sources

- [Control Plane PRD](https://docs.google.com/document/d/1o-gu4U3e-oJNMIms2eX86J9OaY-OxnXLdq8ggSjHmH0/edit),
  modified `2026-08-28T07:15:36.403Z`: its product/repository table still names
  `0xPlayerOne/control-plane`. Live `gh repo view adea-ai/control-plane`
  resolves the current repository as `adea-ai/control-plane`. Reconcile this
  identity in the native document; verify the other products independently
  before changing their repository names.
- [Artifact Storage Specification](https://docs.google.com/document/d/12cxxFPv9ZI6vHyksczXGOGtuSTvN-MD10nuJTsick7I/edit),
  modified `2026-08-28T07:05:15.684Z`: section 13 requires explicit class-specific
  retention, reference checks, durable deletion jobs/tombstones, visible retry
  exceptions, and auditable holds. Section 19 leaves default retention windows
  by class/sensitivity as an implementation choice. Therefore the source does
  not supply missing numerical defaults for automatic deletion.

The PRD distinguishes accepted product requirements from GitHub-tracked
implementation and reserves live Agent HQ/Cortana composition for M12. Do not
rewrite normative requirements as accomplished M11 behavior or make live
cross-product access a prerequisite for ordinary standalone implementation.
M11's own current native-runtime and all-profile acceptance gaps remain open.

## Verified native PRD correction

After the read-only findings above, a fresh structured read and revision-guarded
native edit corrected the repository table label to `adea-ai/control-plane`
and both Control Plane repository hyperlinks to
`https://github.com/adea-ai/control-plane`. Other products were not changed.

The final full-tab comparison against the pre-edit snapshot passed after
normalizing only the intended repository replacement, shifted document indexes,
and an explicitly serialized default baseline style. A newline style change
introduced during editing was restored before that comparison. No stale
`0xPlayerOne/control-plane` references remain in the tab. Tab identity,
structure, other content, and other styles were preserved. No protected controls
were detected; authoritative dropdown metadata was unavailable, and no control
edits were attempted.

The final trusted-read raw document SHA-256 was
`68956e088669c346d47d06ecba5386481163dc9d32a747d847071cd87eb9d71c`.
This is a targeted identity correction, not a new full-PRD review or acceptance
of its requirements as implemented.

## Remaining reconciliation

The other discovered PRDs, TDDs, specifications,
ADRs, diagrams, glossary, and evaluation sources still require source-by-source
review and implementation mapping under #195; this two-source pass cannot
prove the whole inventory consistent. Independent reviewer approval remains
required by the issue.
