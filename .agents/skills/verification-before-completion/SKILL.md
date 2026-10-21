---
name: verification-before-completion
metadata:
  version: "1.1.0"
  owner: "Control Plane maintainers"
  provenance:
    origin: repository-owned
    integration_version: "1.1.0"
description: "Use when about to claim that work is complete, fixed, or passing, including before a commit or pull request. Not for performing the work itself or for restating a status that was never verified. Requires running the verification command and reading its output before making any success claim."
---

# Verification Before Completion

## Overview

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## Evidence contract

- **Inputs:** a completion claim (about any work) that must be verified before it is made.
- **Safe assumptions:** none — prior passing runs, agent success reports, and "should work" carry zero evidential weight; only fresh command output counts.
- **Allowed mutations:** none — this skill is read-only over the claimed state; it runs commands and reads output, it does not edit the work.
- **Outputs:** a verdict backed by evidence — each claim mapped to a verification command and its observed output, or marked unverified.
- **Verification commands:** the full applicable batch from `.agents/validation.md` (here: `bun run format:check`, `bun run lint`, `bun run type-check`, `bun run build`, `bun run test`) — that file is the canonical owner of what "fully verified" means in this repository.
- **Failure/skip reporting:** every check that could not run is stated with its exact reason; a skipped check is not a passing check, and partial verification proves nothing.
- **Cleanup:** none — verification leaves no artifacts; it records only the commands run and their results.
- **Completion-claim guard:** any check that was not executed is unverified work; a passing claim without the full command output in evidence is forbidden.
- **Stop conditions:** Stop the claim when any required command fails, when a required command cannot run, or when the observed output does not match the claim being made.

### Boundary contract

- **Secrets:** Verification output is reported without secret values; a command that would print credentials is not run and is reported as skipped.
- **Dirty worktree:** Verification is read-only over the working tree; it never cleans, resets, stages, or commits changes.
- **Migration:** A migration claim requires the migration check to have run; an unrun migration check leaves the claim unverified.
- **Generated files:** Generated artifacts are verified by their generator or drift check, never by asserting that the committed file looks right.
- **Provider:** No provider activation and no paid call is implied by verification; a provider-dependent check stays unverified and is named as such.
