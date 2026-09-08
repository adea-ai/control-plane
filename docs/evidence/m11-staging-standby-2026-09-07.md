# M11 staging standby — 2026-09-07

After the bounded certification of `a76f27453e558525a05089e3c88085153a63a528`, staging compute was
stood down. This is cleanup evidence, not full M11 or production certification.

- Project: `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f`.
- Staging environment: `3beb119e-1b23-4fa6-9af3-2c6b9976708f`.
- Removed API deployment: `3105c082-1ffb-467e-8fd0-b518812668a9`.
- Removed worker deployment: `fc592d2a-7321-4c22-8be6-66b75ac9d805`.
- Removed Restate deployment: `b89c1933-5d0f-4a29-9f15-e1bc6e0ddde0`.
- Before shutdown, Restate reported exactly one completed invocation and no active invocations.
- Final service inventory: each service stopped, zero running replicas; both application sources
  null. Restate retains its pinned image configuration.
- The 500 MB `restate-data` volume remains READY at `/restate-data`, approximately 50.9 MB used.
- Production configuration for API, worker, and Restate was compared with pre-shutdown snapshots
  and remained unchanged. No production deployment was removed.
- Services, secrets, Neon databases, R2 objects, and the Restate volume were not deleted. Staging
  can be explicitly reactivated for later cloud certification; removed deployment revisions are
  not running workloads and are not a backup of data.

The first guarded standby run stopped compute but correctly failed verification because Git source
configuration remained. Two null-source environment configuration patches and the service-wide
trigger disconnection did not clear that retained source. An explicit environment-scoped
`serviceInstanceUpdate` with `source.repo: null` cleared each application source, confirmed by
independent readback. The script now combines guarded trigger disconnection and this source update.
The final dry-run and applied verification both returned no actions. Workspace lint, type-check,
format checking, and the full test command passed, including 101 E2E tests and 569 assertions.
This provider distinction is retained in the runbook and
regression coverage rather than weakening standby verification to ignore configured sources.
