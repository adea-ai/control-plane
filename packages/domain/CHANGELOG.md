# Changelog

## [1.7.0](https://github.com/adea-ai/control-plane/compare/domain-v1.6.0...domain-v1.7.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/domain-v1.5.2...domain-v1.6.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.5.2](https://github.com/adea-ai/control-plane/compare/domain-v1.5.1...domain-v1.5.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/domain-v1.5.0...domain-v1.5.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.5.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.4.0...domain-v1.5.0) (2026-08-29)


### Features

* **catalog:** finalize profile and skill resolution ([#223](https://github.com/0xPlayerOne/control-plane/issues/223)) ([aeff4ff](https://github.com/0xPlayerOne/control-plane/commit/aeff4ff5d78f39cb6a8d5b38e37f05c57354fb6c))
* **database:** persist project state ([659fc9b](https://github.com/0xPlayerOne/control-plane/commit/659fc9b20883267ab9f971c21b9ecfdcce144037))
* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))
* **workflow-worker:** persist cloud execution lifecycle ([79b9bfe](https://github.com/0xPlayerOne/control-plane/commit/79b9bfe203a91193c2457c3e3357f6bc100090fd))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.3.0...domain-v1.4.0) (2026-08-25)


### Features

* **orchestration:** coordinate parallel delegation ([#183](https://github.com/0xPlayerOne/control-plane/issues/183)) ([21e383b](https://github.com/0xPlayerOne/control-plane/commit/21e383ba2492cbd92f72c96adcc1f5ab89c4a2d7))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.2.0...domain-v1.3.0) (2026-08-25)


### Features

* **gateway:** persist runtime command delivery ([#139](https://github.com/0xPlayerOne/control-plane/issues/139)) ([1874f27](https://github.com/0xPlayerOne/control-plane/commit/1874f27edbd925b7ba5f9f74d26cc53719758f8b))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.1.0...domain-v1.2.0) (2026-08-24)


### Features

* **runtime:** route eligible runtimes deterministically ([#121](https://github.com/0xPlayerOne/control-plane/issues/121)) ([9f7a0fd](https://github.com/0xPlayerOne/control-plane/commit/9f7a0fd74e179dd592d9727ae49bc222b99251d8))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.0.0...domain-v1.1.0) (2026-08-24)


### Features

* **execution:** add durable execution lifecycle ([#105](https://github.com/0xPlayerOne/control-plane/issues/105)) ([4429d4d](https://github.com/0xPlayerOne/control-plane/commit/4429d4da040e785ef566db8136d5b21c42ac30d7)), closes [#20](https://github.com/0xPlayerOne/control-plane/issues/20)
* **execution:** add durable interaction lifecycle ([#112](https://github.com/0xPlayerOne/control-plane/issues/112)) ([83a3bb6](https://github.com/0xPlayerOne/control-plane/commit/83a3bb6fcec8969bcb78dfa4bbbc167a5fe767c0))
* **execution:** add idempotent command acceptance ([#109](https://github.com/0xPlayerOne/control-plane/issues/109)) ([bd096fb](https://github.com/0xPlayerOne/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/0xPlayerOne/control-plane/issues/21)
* **reliability:** reconcile unknown execution outcomes ([#114](https://github.com/0xPlayerOne/control-plane/issues/114)) ([2cbd07b](https://github.com/0xPlayerOne/control-plane/commit/2cbd07b8747925560a90fa3eaad057d0ffbdf4ee))

## 1.0.0 (2026-08-24)


### Features

* add immutable AgentProfile and Skill versions ([#90](https://github.com/0xPlayerOne/control-plane/issues/90)) ([f09d6fd](https://github.com/0xPlayerOne/control-plane/commit/f09d6fded7abad1429b805d7c1248bf4627ca8ae))
* add revisioned project state ([#93](https://github.com/0xPlayerOne/control-plane/issues/93)) ([4f3e7ac](https://github.com/0xPlayerOne/control-plane/commit/4f3e7ac04b18eed869fbc3d02f8506b676014e62))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* define execution constraint contracts ([#92](https://github.com/0xPlayerOne/control-plane/issues/92)) ([6945676](https://github.com/0xPlayerOne/control-plane/commit/694567609c5b6b9123622446e528c5298d34e4ad))
