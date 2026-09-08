# PostgreSQL client closed-socket guard

`postgres@3.4.9.patch` guards deferred writes after backend closure in both ESM
and CommonJS entry points. It clears the pending write and rejects pending
queries through the driver's existing connection-error path; merely dropping
the write can leave callers waiting indefinitely.

Provenance: [upstream issue 1208](https://github.com/porsager/postgres/issues/1208)
and [proposed upstream fix 1209](https://github.com/porsager/postgres/pull/1209),
reviewed at commit `a2588b3073b5bd125f0fb3b419bdc9f2e8524291` on September 8, 2026. The upstream proposal was unmerged and the latest release was still
3.4.9. This is a repository-maintained patch, not an upstream release claim.

The database integration suite launches the transaction-timeout probe in child
processes for both entry points. It checks idle and in-flight query termination,
rollback, a subsequent transaction, no uncaught-error output and bounded process
shutdown. Child isolation and a ten-second parent deadline contain regressions
that would otherwise crash or hang the complete integration suite. Application
credentials are scoped to the disposable test database and are not printed.

Bun records the patch in `package.json` and `bun.lock`. Both container builds
copy patches before frozen dependency installation; hosted production installation
also retains them. Do not edit a shared dependency cache directly.

This does not certify every `reserve()`/pipeline/disconnect interleaving, remove
the need for bounded pool shutdown, or enable transaction timeouts in production.
Before removing the patch, verify a pinned upstream release includes equivalent
handling in both entry points and rerun the child probes, full integration and
recovery suite, and both production container builds.
