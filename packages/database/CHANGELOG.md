# Changelog

## [1.7.3](https://github.com/adea-ai/control-plane/compare/database-v1.7.2...database-v1.7.3) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.7.2](https://github.com/adea-ai/control-plane/compare/database-v1.7.1...database-v1.7.2) (2026-09-05)


### Maintenance

* **infra:** align Neon branch names with Railway environment names ([#368](https://github.com/adea-ai/control-plane/issues/368)) ([fb698a2](https://github.com/adea-ai/control-plane/commit/fb698a2f86d2cf6a3e5b9ceaf0938c55d573c204))

## [1.7.1](https://github.com/adea-ai/control-plane/compare/database-v1.7.0...database-v1.7.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.7.0](https://github.com/0xPlayerOne/control-plane/compare/database-v1.6.0...database-v1.7.0) (2026-08-30)


### Features

* **portability:** add PostgreSQL profile migration storage ([#316](https://github.com/0xPlayerOne/control-plane/pull/316)) ([1ae4b9f](https://github.com/0xPlayerOne/control-plane/commit/1ae4b9f2de1d0c3f0e73255b9db6aeade24b6426))

## [1.6.0](https://github.com/0xPlayerOne/control-plane/compare/database-v1.5.0...database-v1.6.0) (2026-08-29)


### Features

* **catalog:** finalize profile and skill resolution ([#223](https://github.com/0xPlayerOne/control-plane/issues/223)) ([aeff4ff](https://github.com/0xPlayerOne/control-plane/commit/aeff4ff5d78f39cb6a8d5b38e37f05c57354fb6c))
* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/0xPlayerOne/control-plane/issues/222)) ([e6aa0f1](https://github.com/0xPlayerOne/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))
* **control-api:** compose managed cloud startup ([a99ef72](https://github.com/0xPlayerOne/control-plane/commit/a99ef727554463834ee10c7651158da6bc7ce848))
* **database:** persist context packages ([30e3f81](https://github.com/0xPlayerOne/control-plane/commit/30e3f81527de595ad2235fcd5cfa46f5a80d149b))
* **database:** persist execution plans ([233895c](https://github.com/0xPlayerOne/control-plane/commit/233895c96091701cf8d1dd89480a5ee4ec5198b2))
* **database:** persist project state ([659fc9b](https://github.com/0xPlayerOne/control-plane/commit/659fc9b20883267ab9f971c21b9ecfdcce144037))
* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))
* **infrastructure:** wire managed cloud dependencies ([#221](https://github.com/0xPlayerOne/control-plane/issues/221)) ([ff809b0](https://github.com/0xPlayerOne/control-plane/commit/ff809b0445f29fec2c47ce19745b9092ec8fca38))
* **workflow-worker:** persist cloud execution lifecycle ([79b9bfe](https://github.com/0xPlayerOne/control-plane/commit/79b9bfe203a91193c2457c3e3357f6bc100090fd))

## [1.5.0](https://github.com/0xPlayerOne/control-plane/compare/database-v1.4.0...database-v1.5.0) (2026-08-25)


### Features

* **orchestration:** add durable delegated executions ([#182](https://github.com/0xPlayerOne/control-plane/issues/182)) ([a060e43](https://github.com/0xPlayerOne/control-plane/commit/a060e4374f85dcbb50c2c4be9de1d71c28858839))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/database-v1.3.0...database-v1.4.0) (2026-08-25)


### Features

* **memory:** add approved provider writeback ([#177](https://github.com/0xPlayerOne/control-plane/issues/177)) ([001a545](https://github.com/0xPlayerOne/control-plane/commit/001a545acb3335599307e510c92429e7cb7bf498))
* **usage:** add authoritative usage ledger ([#173](https://github.com/0xPlayerOne/control-plane/issues/173)) ([851eda4](https://github.com/0xPlayerOne/control-plane/commit/851eda4d809a0bd8f6c451c316e830e2db5e87a1))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/database-v1.2.0...database-v1.3.0) (2026-08-25)


### Features

* **gateway:** ingest normalized runtime events ([#140](https://github.com/0xPlayerOne/control-plane/issues/140)) ([7542146](https://github.com/0xPlayerOne/control-plane/commit/7542146f8f84fc72061c17d4fc4bc7ec435ddc76))
* **gateway:** persist runtime command delivery ([#139](https://github.com/0xPlayerOne/control-plane/issues/139)) ([1874f27](https://github.com/0xPlayerOne/control-plane/commit/1874f27edbd925b7ba5f9f74d26cc53719758f8b))
* **gateway:** synchronize runtime inventory health ([#141](https://github.com/0xPlayerOne/control-plane/issues/141)) ([656b580](https://github.com/0xPlayerOne/control-plane/commit/656b580e58986b460b10d109cdeed78ba620307f))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/database-v1.1.0...database-v1.2.0) (2026-08-24)


### Features

* **runtime:** ingest health and capability freshness ([#119](https://github.com/0xPlayerOne/control-plane/issues/119)) ([d47445b](https://github.com/0xPlayerOne/control-plane/commit/d47445bbeb0e88e1e65db8cafdff150061b2ca84))
* **runtime:** persist external session references ([#122](https://github.com/0xPlayerOne/control-plane/issues/122)) ([1ef146c](https://github.com/0xPlayerOne/control-plane/commit/1ef146c02b46021b9a13a232ce1b612f608077c7))
* **runtime:** persist runtime connection inventory ([#118](https://github.com/0xPlayerOne/control-plane/issues/118)) ([20fdb11](https://github.com/0xPlayerOne/control-plane/commit/20fdb11db89e75607785734d55057e648c664aac))
* **runtime:** route eligible runtimes deterministically ([#121](https://github.com/0xPlayerOne/control-plane/issues/121)) ([9f7a0fd](https://github.com/0xPlayerOne/control-plane/commit/9f7a0fd74e179dd592d9727ae49bc222b99251d8))


### Bug Fixes

* **test:** stabilize parallel Postgres suites ([#130](https://github.com/0xPlayerOne/control-plane/issues/130)) ([9a0f106](https://github.com/0xPlayerOne/control-plane/commit/9a0f10637c7422e39740c662b70ed0163ef263c6))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/database-v1.0.0...database-v1.1.0) (2026-08-24)


### Features

* **events:** add durable execution event outbox ([#110](https://github.com/0xPlayerOne/control-plane/issues/110)) ([2d6355d](https://github.com/0xPlayerOne/control-plane/commit/2d6355d4a9b82b38ae2c3ba40055eab78a7401f8)), closes [#22](https://github.com/0xPlayerOne/control-plane/issues/22)
* **events:** deliver execution events to Agent HQ ([#113](https://github.com/0xPlayerOne/control-plane/issues/113)) ([641ac7a](https://github.com/0xPlayerOne/control-plane/commit/641ac7aef9bcb05a6fbfc0d5c732dce0233b0b55))
* **execution:** add durable execution lifecycle ([#105](https://github.com/0xPlayerOne/control-plane/issues/105)) ([4429d4d](https://github.com/0xPlayerOne/control-plane/commit/4429d4da040e785ef566db8136d5b21c42ac30d7)), closes [#20](https://github.com/0xPlayerOne/control-plane/issues/20)
* **execution:** add durable interaction lifecycle ([#112](https://github.com/0xPlayerOne/control-plane/issues/112)) ([83a3bb6](https://github.com/0xPlayerOne/control-plane/commit/83a3bb6fcec8969bcb78dfa4bbbc167a5fe767c0))
* **execution:** add idempotent command acceptance ([#109](https://github.com/0xPlayerOne/control-plane/issues/109)) ([bd096fb](https://github.com/0xPlayerOne/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/0xPlayerOne/control-plane/issues/21)
* **reliability:** reconcile unknown execution outcomes ([#114](https://github.com/0xPlayerOne/control-plane/issues/114)) ([2cbd07b](https://github.com/0xPlayerOne/control-plane/commit/2cbd07b8747925560a90fa3eaad057d0ffbdf4ee))

## 1.0.0 (2026-08-24)


### Features

* add PostgreSQL persistence foundation ([2fdfd88](https://github.com/0xPlayerOne/control-plane/commit/2fdfd8856ab7b1d4d7e592e1d998a0e8314f11b9)), closes [#3](https://github.com/0xPlayerOne/control-plane/issues/3)
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
