# M11.10 Local durability diagram correction

Status: targeted source correction; documentation acceptance remains incomplete.

Owner-approved [#548](https://github.com/adea-ai/control-plane/issues/548) requires
Local to use embedded SQLite durable execution without Restate. Hosted and managed
cloud retain Restate behind the same workflow contracts. The current
[Local deployment guide](../local-deployment.md) describes this distinction, but
the repository diagram companion and canonical Drive catalog still contradicted it.

## Verified changes

- [Repository companion](../architecture/diagram-sources.md): the execution lifecycle
  label now distinguishes Local SQLite from Hosted/Cloud Restate, and the Local
  topology uses an embedded SQLite durable queue/workflow journal rather than
  single-node Restate. Hosted and Cloud nodes are unchanged.
- [Canonical Diagram Sources (Mermaid)](https://docs.google.com/document/d/163gbj0YZZA2dakPDTDJv9VlRzbwVC7KoZM5kix6YB7U/edit):
  section 5's lifecycle label and section 13's Local host label received the same
  correction. The revision-guarded batch changed exactly one occurrence per label.
  Full native-resource comparison verified that only these text replacements,
  shifted indexes and revision changed; all tab topology, paragraph/text styles,
  other content and structures were preserved. No protected controls were detected;
  authoritative dropdown metadata was unavailable, and no controls were edited.

All five repository companion sources and the two changed canonical sources
rendered successfully with Mermaid CLI 11.17.0 and an isolated headless browser.
Generated renders are validation artifacts, not replacements for the owning
documents' embedded figures. The first render attempt could not find its default
browser cache; the successful run selected an existing headless browser explicitly.
No project dependency or user browser configuration changed.

The canonical post-edit raw native response SHA-256 is
`0b3937e87b8d1394f74639c9d1fa4c7e4f196f0673e78ea4d4deaf05cb9dedef`.
This checksum identifies the retrieved response, not a deployment or human review.

## Remaining gate

Update the corresponding rendered figures in their owning documents after
reviewing the current image mappings. Reconcile the other cross-product diagrams
that still label a generic selected-host lifecycle as Restate, and review every
maintained source in the original inventory against supported composition roots,
configuration and verified behavior. Do not overwrite another product's diagrams
or claim their acceptance from this scoped correction. Required independent
documentation approval and frozen-candidate evidence remain open under
[#195](https://github.com/adea-ai/control-plane/issues/195) and
[#197](https://github.com/adea-ai/control-plane/issues/197).
