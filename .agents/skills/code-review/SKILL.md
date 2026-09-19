---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
metadata:
  version: "1.0.0"
  owner: "Control Plane maintainers"
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

Use the repository's [issue-tracker guide](../../../docs/agents/issue-tracker.md)
to retrieve the spec. No skill installer or external setup command is required.
Review is read-only: follow [repository policy](../../../AGENTS.md) and
[contribution boundaries](../../../.github/CONTRIBUTING.md). A review request does
not authorize fixes, issue edits, PR comments, or merges.

Record the resolved base and head commits and dirty state. The committed diff
below does not include staged, unstaged, or untracked work; when the request
includes work in progress, inspect those surfaces separately and report which
ones were reviewed. Preserve all existing changes.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`)
and at least one requested review surface is non-empty. A committed-only review
with an empty diff ends here. A work-in-progress review may still have staged,
unstaged, or untracked changes even when the committed diff is empty; include
those exact surfaces in each reviewer's scope. Resolve bad refs before delegation.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, etc.) — resolve repository identity and fetch via the issue-tracker guide.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.
If delegation is unavailable, perform both axes sequentially and disclose the
lack of independent review. Do not claim two independent reviews from one pass.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

Include exact candidate scope, spec provenance, checks actually observed, missing
or skipped evidence, and task-owned worker cleanup. Closed issues and green CI
do not prove spec compliance; a missing spec is an unverified axis, not a pass.
Review this repository adaptation when tracker, policy, or review tooling changes;
version routing changes in metadata and retain history in Git.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

## Evidence contract

- **Inputs:** a base ref (commit, branch, tag, or merge-base); the review surfaces to cover — committed diff, plus staged, unstaged, or untracked work when the request includes work in progress — with the resolved base/head commits and dirty state recorded.
- **Safe assumptions:** the fixed point resolves and at least one requested surface is non-empty; documented repo standards override the smell baseline; delegation is available (if not, run both axes sequentially and disclose the lack of independent review).
- **Allowed mutations:** none — this skill is read-only over the code, the working tree, and the issue tracker; a review request does not authorize fixes, issue edits, PR comments, or merges.
- **Outputs:** two side-by-side findings lists under `## Standards` and `## Spec`, each citing file:line and its source (documented rule or spec line), plus a one-line per-axis summary, spec provenance, and the exact surfaces reviewed.
- **Verification commands:** review is observational — it re-runs none of the `.agents/validation.md` batch as proof of correctness; findings cite standards files and spec text, not tool output.
- **Failure/skip reporting:** an empty committed diff ends a committed-only review; a missing spec is reported as "no spec available" and the Spec axis is marked skipped, never passed.
- **Cleanup:** none — the review leaves no files, comments, issues, or PR artifacts behind.
- **Completion-claim guard:** reviews are advisory — the skill must not claim the reviewed work is correct, complete, or mergeable, and closed issues or green CI never stand in for spec compliance.
