# Changelog

## [1.4.2](https://github.com/adea-ai/control-plane/compare/workflow-worker-v1.4.1...workflow-worker-v1.4.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.4.1](https://github.com/adea-ai/control-plane/compare/workflow-worker-v1.4.0...workflow-worker-v1.4.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/workflow-worker-v1.3.1...workflow-worker-v1.4.0) (2026-08-30)


### Features

* **portability:** support the local Restate execution path ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **hosted:** support hosted composition startup ([#311](https://github.com/0xPlayerOne/control-plane/pull/311)) ([2a4de56](https://github.com/0xPlayerOne/control-plane/commit/2a4de56d6e352155cf42c0b44302241f1b92442a))

## [1.3.1](https://github.com/0xPlayerOne/control-plane/compare/workflow-worker-v1.3.0...workflow-worker-v1.3.1) (2026-08-29)


### Bug Fixes

* **worker:** keep disabled cloud runtime healthy ([#305](https://github.com/0xPlayerOne/control-plane/issues/305)) ([85d32ce](https://github.com/0xPlayerOne/control-plane/commit/85d32ceb58370b2d3158293acc5f93eb64a2c162))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/workflow-worker-v1.2.0...workflow-worker-v1.3.0) (2026-08-29)


### Features

* **control-api:** accept cloud executions ([242f599](https://github.com/0xPlayerOne/control-plane/commit/242f59960b24b7355f88bf1eda6343f14ed5c5f0))
* **operations:** centralize managed cloud policy defaults ([#225](https://github.com/0xPlayerOne/control-plane/issues/225)) ([096b17a](https://github.com/0xPlayerOne/control-plane/commit/096b17ab9921784ce6cf4ced34d5f82d0f08c961))
* **workflow-worker:** add cloud certification runtime ([c47e830](https://github.com/0xPlayerOne/control-plane/commit/c47e8309a8ea71342d8dda0cc79c91d9b400b20d))
* **workflow-worker:** persist cloud execution lifecycle ([79b9bfe](https://github.com/0xPlayerOne/control-plane/commit/79b9bfe203a91193c2457c3e3357f6bc100090fd))
* **workflows:** migrate managed cloud runtime to Restate ([#220](https://github.com/0xPlayerOne/control-plane/issues/220)) ([99c85ee](https://github.com/0xPlayerOne/control-plane/commit/99c85ee71c382de6f597a7c08b79f9068ba7a5fb))


### Bug Fixes

* **infra:** secure Restate service boundary ([#247](https://github.com/0xPlayerOne/control-plane/issues/247)) ([667eb58](https://github.com/0xPlayerOne/control-plane/commit/667eb58e95886eca5327367ca083f90c13fd5ff2))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/workflow-worker-v1.1.0...workflow-worker-v1.2.0) (2026-08-25)


### Features

* **workflows:** bridge Temporal graph segments ([#181](https://github.com/0xPlayerOne/control-plane/issues/181)) ([c590671](https://github.com/0xPlayerOne/control-plane/commit/c590671e5b3cde696e3fc2a2e5d39b4210b55206))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/workflow-worker-v1.0.0...workflow-worker-v1.1.0) (2026-08-24)


### Features

* **execution:** add durable interaction lifecycle ([#112](https://github.com/0xPlayerOne/control-plane/issues/112)) ([83a3bb6](https://github.com/0xPlayerOne/control-plane/commit/83a3bb6fcec8969bcb78dfa4bbbc167a5fe767c0))
* **workflows:** add Temporal execution lifecycle ([#111](https://github.com/0xPlayerOne/control-plane/issues/111)) ([f70ad1e](https://github.com/0xPlayerOne/control-plane/commit/f70ad1e06c5c87fb349909188ca01cfc4c212aef)), closes [#23](https://github.com/0xPlayerOne/control-plane/issues/23)

## 1.0.0 (2026-08-24)


### Features

* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* add telemetry foundation ([#80](https://github.com/0xPlayerOne/control-plane/issues/80)) ([6ca188e](https://github.com/0xPlayerOne/control-plane/commit/6ca188e1f26cd32cfd05dea005e067f8eff27938))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
