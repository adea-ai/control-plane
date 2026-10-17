# GitHub workflows and configuration

Rules for editing `.github/workflows/` and CI configuration. Applies only when modifying workflows or CI-related config.

## Workflow design

- Keep workflows concise, independently runnable, and safe to re-run.
- Use `push` for `main` and `pull_request` for `main` unless a workflow has a documented event-specific reason.
- Give workflows clear names and jobs concise names; avoid repeating the workflow name in the job name.
- Use per-workflow concurrency groups that cancel superseded runs while allowing independent workflows to run in parallel.
- Keep setup language-aware and cache dependency downloads by lockfile; do not cache secrets, `node_modules`, virtual environments, or broad build output without a measured reason.
- Use least-privilege permissions and pin action versions consistently with the template.
- Keep CI, Test, Security, CodeQL, Draft PR, Release PR, and Release concerns separated.
- Security and CodeQL may skip when repository visibility or GitHub plan support does not permit them. Do not make an unavailable check required.
- Vite+ caches local task outputs. Shared Code Foundry setup owns the Actions restore/save contract; preserve push-only writes and toolchain separation.
- Update branch protection when adding or renaming required job checks; verify the actual GitHub status context.
