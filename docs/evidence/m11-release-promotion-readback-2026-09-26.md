# M11 existing-release promotion readback (2026-09-26)

This records operational recovery of the existing `workspace-v1.58.3` release,
not acceptance or deployment of the unmerged M11 audit branch.

## Source and recovery

- Released source: `03e7bfc646a1d4377e65b8ec7b4d840d3f409405` on `main`.
- [Container Promotion run 36267330343](https://github.com/adea-ai/control-plane/actions/runs/36267330343)
  initially passed tagged-candidate validation and both image build, Trivy,
  CycloneDX SBOM, publication and provenance-attestation jobs.
- Its deployment job failed while downloading Bun, with repeated HTTP 500s.
  The Railway promotion command had not run; this was not a failed image scan.
- A failed-job-only rerun reused the original promotion artifacts. Attempt 2
  completed successfully; neither image was rebuilt by the retry.

## Independent production readback

The promotion JSON artifacts both identify the release and source above.
Railway deployment reads confirmed the following exact image references in the
configured production environment:

| Target          | Image digest                                                              | Successful deployment                  |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| control-api     | `sha256:b22b30808f95c7e1cc05921c594cba51245f0e76a822599e66c1fa44cecb5fe6` | `423376fa-ef00-477f-81e4-c8cbd00b95ec` |
| workflow-worker | `sha256:451f6a00ec0e8f8689191c065208c76a271319ccc0268d16eb8613138c6a93d5` | `c32dd73c-7fbe-4c04-b13f-d9db6a824556` |

- Control API promotion artifact: `10914169629`.
- Workflow worker promotion artifact: `10914134789`.
- The production Control API `/ready` response returned `status: ready`,
  `environment: production`, the exact source SHA above, and the Control API
  deployment ID above in its version metadata.
- The worker's successful Railway deployment is observed; this record does
  not claim a separate public worker readiness probe or native-runtime execution.

## Remaining acceptance boundaries

This restores the existing released baseline. The audit repair branch still
needs its own combined validation, security review, required current-head CI,
merge, subsequent release and exact-digest deployment verification. It does not
close M11's independent human review, complete profile matrix, retention,
evaluation or provider-runtime acceptance gates. Merely finding production
approval variable names is not proof of their values or activation behavior.
