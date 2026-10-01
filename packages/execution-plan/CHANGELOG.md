# Changelog

## [1.8.0](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.7.0...execution-plan-v1.8.0) (2026-10-01)


### Features

* **graph:** persist events and secure accepted effects ([#809](https://github.com/adea-ai/control-plane/issues/809)) ([8ea6111](https://github.com/adea-ai/control-plane/commit/8ea61113e900b4bf39bbc9f41b4d4c995d107f5b))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.6.2...execution-plan-v1.7.0) (2026-10-01)


### Features

* **graph:** add durable catalog administration and pinned declarative plans ([#803](https://github.com/adea-ai/control-plane/issues/803)) ([a7813c0](https://github.com/adea-ai/control-plane/commit/a7813c0b0c3f456e168fe06db99f15661b07a29f))

## [1.6.2](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.6.1...execution-plan-v1.6.2) (2026-10-01)


### Bug Fixes

* **deps:** update external non-major dependencies ([#802](https://github.com/adea-ai/control-plane/issues/802)) ([76aafec](https://github.com/adea-ai/control-plane/commit/76aafec17902426c55e782e210d90d6e5aa7370a))

## [1.6.1](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.6.0...execution-plan-v1.6.1) (2026-09-30)


### Bug Fixes

* **m11:** enforce catalog ownership and defer scheduled deletes ([#765](https://github.com/adea-ai/control-plane/issues/765)) ([7cdb1c4](https://github.com/adea-ai/control-plane/commit/7cdb1c4969a6fe8f57d59107d6906067538238dc))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.5.4...execution-plan-v1.6.0) (2026-09-28)


### Features

* **m11:** harden retention, budgets and runtime delivery ([#743](https://github.com/adea-ai/control-plane/issues/743)) ([ea7ced3](https://github.com/adea-ai/control-plane/commit/ea7ced395a93ca7975a77f8b481235e893f33562))

## [1.5.4](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.5.3...execution-plan-v1.5.4) (2026-09-27)


### Bug Fixes

* **m11:** close approval and retention audit gaps ([#740](https://github.com/adea-ai/control-plane/issues/740)) ([58559d9](https://github.com/adea-ai/control-plane/commit/58559d9a0b4b4283396635f8b25bf633f4a87beb))

## [1.5.3](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.5.2...execution-plan-v1.5.3) (2026-09-22)


### Bug Fixes

* **m612:** execution plan digests are versioned with code-point normalization ([#657](https://github.com/adea-ai/control-plane/issues/657)) ([bbf4637](https://github.com/adea-ai/control-plane/commit/bbf463760bbce534cb535516bba660794245b8f6))

## [1.5.2](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.5.1...execution-plan-v1.5.2) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.5.0...execution-plan-v1.5.1) (2026-09-20)


### Bug Fixes

* **contracts:** locale-independent canonicalJsonStringify + canonical-JSON divergence audit ([#611](https://github.com/adea-ai/control-plane/issues/611)) ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))


### Maintenance

* **contracts:** add canonicalJsonStringify and consolidate canonical-JSON digests ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.4.2...execution-plan-v1.5.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.4.2](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.4.1...execution-plan-v1.4.2) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.4.1](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.4.0...execution-plan-v1.4.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.3.0...execution-plan-v1.4.0) (2026-09-08)


### Features

* **local:** install and launch pinned Codex ACP runtime ([#434](https://github.com/adea-ai/control-plane/issues/434)) ([5d07c04](https://github.com/adea-ai/control-plane/commit/5d07c044e174e0ea98073b7fd7d154121a4e4d84))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.2.2...execution-plan-v1.3.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.2.2](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.2.1...execution-plan-v1.2.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.2.1](https://github.com/adea-ai/control-plane/compare/execution-plan-v1.2.0...execution-plan-v1.2.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/execution-plan-v1.1.0...execution-plan-v1.2.0) (2026-08-29)


### Features

* **database:** persist execution plans ([233895c](https://github.com/0xPlayerOne/control-plane/commit/233895c96091701cf8d1dd89480a5ee4ec5198b2))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/execution-plan-v1.0.0...execution-plan-v1.1.0) (2026-08-24)


### Features

* **execution:** add idempotent command acceptance ([#109](https://github.com/0xPlayerOne/control-plane/issues/109)) ([bd096fb](https://github.com/0xPlayerOne/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/0xPlayerOne/control-plane/issues/21)

## 1.0.0 (2026-08-24)


### Features

* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* compile immutable execution plans ([#95](https://github.com/0xPlayerOne/control-plane/issues/95)) ([88346ef](https://github.com/0xPlayerOne/control-plane/commit/88346efea272bb1ab9441f14a3114869d8e9340b))
