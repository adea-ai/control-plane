# Blinded independent comparison packet

Status: **prepared, not executed.** The blinded human comparison for CP #196 is
an external gate. Nothing in this repository is a human score, and the
`blinded-comparison-sheet.json` values stay `null` until a real independent
reviewer fills them in. An offline fixture run, a harness verdict, or a
modeled executor is not a substitute for that review, and this document does
not report one.

## Why this gate exists

The offline cold-task suite in this directory measures contract conformance:
whether a skill's own text carries the instructions a task needs, and whether
an executor that follows those instructions reports the observed state. It
cannot measure whether a human reader selects the right skill, whether the
wording is clear, or whether a reviewer had to correct the output. Those are
the questions a blinded comparison answers.

## Scope of the comparison

| Item          | Value                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task          | One representative cold repository audit request, run against the pinned baseline skill library and the candidate skill library                                                              |
| Baseline      | commit `27f17bd55e0266439b5b3089163195c9e7a669be` (`.agents/skills/**` as committed)                                                                                                         |
| Candidate     | the exact head under review (`.agents/skills/**` as proposed)                                                                                                                                |
| Blinding      | the two library variants are presented as `Library A` and `Library B` in a randomized order fixed by the packet below; the reviewer is not told which is which                               |
| Reviewer      | at least two independent reviewers, neither of whom authored the candidate                                                                                                                   |
| Rubric        | [`docs/evaluation-dimensions.md`](../../evaluation-dimensions.md) plus the twelve calibration dimensions in [`docs/evals/calibration-scoring-sheet.json`](../calibration-scoring-sheet.json) |
| Scoring sheet | [`blinded-comparison-sheet.json`](./blinded-comparison-sheet.json)                                                                                                                           |

## What the reviewer receives

1. The cold audit request text, with the requester, the candidate commit, and
   the expected answer withheld.
2. Two skill libraries, `A` and `B`, each in a separate directory, identical in
   every respect except the skill content under test.
3. The rubric and the scoring sheet, with the field names but no values.
4. The reviewer's only instruction: report what each library caused them to
   do, and where they had to correct it.

## Randomization

The packet fixes the blinding order so a second reviewer can reproduce it:

```sh
# Library A and Library B are assigned by the parity of the last hexadecimal
# digit of the pinned baseline commit's full 40-character id. The full id
# resolves identically in every clone, unlike a short abbreviation, whose
# length depends on the local object database. Reviewers must not be told
# which side is which.
echo $((0x$(git rev-parse 27f17bd55e0266439b5b3089163195c9e7a669be | cut -c40) % 2))
```

- `0` → `A` = baseline, `B` = candidate
- `1` → `A` = candidate, `B` = baseline

For the pinned commit the last digit is `e`, so the parity is `0` and
`A` = baseline. The command requires the commit to be present in the
reviewer's checkout; the recorded value above is the fallback when it is not.

The reviewer scores `A` and `B` independently and only then learns the
assignment. Scores are not swapped by the reviewer, and the packet records the
assignment only after both reviewers have submitted their sheets.

The assignment is derivable from a published commit id, so the blinding is
against self-deception rather than against a motivated reviewer. It is not
secret, and it does not claim to be.

## What the reviewer records

For each library, per rubric dimension, on the `pass` / `partial` / `fail`
scale already used by the calibration kit:

- the dimension score,
- whether the library routed the request to the right skill, or to no skill,
- the number of corrections the reviewer had to make to the output, and what
  each correction was,
- whether the reviewer had to stop and ask for a missing authority or a
  missing piece of evidence.

The correction count is the reviewer-correction metric that the offline suite
cannot produce. It stays `null` until a reviewer records it.

## Acceptance

The comparison is advisory input to the qualification decision. It does not
promote a library on its own, and it cannot be replaced by the offline suite.
Any disagreement between reviewers is recorded as a disagreement, and the
error bounds in the calibration sheet apply.

## After the comparison

1. Fill in [`blinded-comparison-sheet.json`](./blinded-comparison-sheet.json),
   including the reviewer-correction counts, and commit it as a new versioned
   file rather than editing the empty one in place.
2. Record the result in
   [`docs/skills/library-baseline.md`](../../skills/library-baseline.md) and in
   [`docs/skills/CHANGELOG.md`](../../skills/CHANGELOG.md).
3. Keep the offline suite's own numbers separate from the human numbers. They
   measure different things and must not be summed or averaged together.
