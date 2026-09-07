# Changelog

## [1.3.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.3.1...control-api-v1.3.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.3.0...control-api-v1.3.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.2.1...control-api-v1.3.0) (2026-08-30)


### Features

* **portability:** compose the local control API ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **hosted:** add private hosted authentication ([#311](https://github.com/0xPlayerOne/control-plane/pull/311)) ([2a4de56](https://github.com/0xPlayerOne/control-plane/commit/2a4de56d6e352155cf42c0b44302241f1b92442a))
* **operations:** report dependency-aware readiness ([#317](https://github.com/0xPlayerOne/control-plane/pull/317)) ([af22ead](https://github.com/0xPlayerOne/control-plane/commit/af22eade12e70d5de982f385e0747862f5b39c7c))

## [1.2.1](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.2.0...control-api-v1.2.1) (2026-08-29)


### Bug Fixes

* **ci:** adopt Code Foundry v0.39.3 ([#288](https://github.com/0xPlayerOne/control-plane/issues/288)) ([43baeb9](https://github.com/0xPlayerOne/control-plane/commit/43baeb9049daa76f422d83ce611bd39d4636c6a6))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.1.2...control-api-v1.2.0) (2026-08-29)


### Features

* **control-api:** accept cloud executions ([242f599](https://github.com/0xPlayerOne/control-plane/commit/242f59960b24b7355f88bf1eda6343f14ed5c5f0))
* **control-api:** compose managed cloud startup ([a99ef72](https://github.com/0xPlayerOne/control-plane/commit/a99ef727554463834ee10c7651158da6bc7ce848))
* **control-api:** validate execution requests ([3ab0636](https://github.com/0xPlayerOne/control-plane/commit/3ab0636aeba30f15676fd09c85ca079b25130486))
* **control-api:** verify signed service credentials ([585777d](https://github.com/0xPlayerOne/control-plane/commit/585777d32f7c8f44c90053236175e35b21c1eef5))
* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))


### Bug Fixes

* **operations:** apply cloud policy defaults at boundaries ([#231](https://github.com/0xPlayerOne/control-plane/issues/231)) ([d95ac2f](https://github.com/0xPlayerOne/control-plane/commit/d95ac2f030a1f791676845b7e15e75d6edcc24e4))

## [1.1.2](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.1.1...control-api-v1.1.2) (2026-08-25)


### Maintenance

* **typescript:** strengthen compiler checks ([#151](https://github.com/0xPlayerOne/control-plane/issues/151)) ([b58dfba](https://github.com/0xPlayerOne/control-plane/commit/b58dfba7d2aa6f4eaf783d89cb8899eb6cffc636))

## [1.1.1](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.1.0...control-api-v1.1.1) (2026-08-24)


### Bug Fixes

* **api:** wire runtime discovery at startup ([#134](https://github.com/0xPlayerOne/control-plane/issues/134)) ([997cb29](https://github.com/0xPlayerOne/control-plane/commit/997cb297add20461a6fa90852da935783192fbeb))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.0.0...control-api-v1.1.0) (2026-08-24)


### Features

* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/0xPlayerOne/control-plane/issues/123)) ([cf43141](https://github.com/0xPlayerOne/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))

## 1.0.0 (2026-08-24)


### Features

* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* add telemetry foundation ([#80](https://github.com/0xPlayerOne/control-plane/issues/80)) ([6ca188e](https://github.com/0xPlayerOne/control-plane/commit/6ca188e1f26cd32cfd05dea005e067f8eff27938))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* enforce Agent HQ service authentication ([#89](https://github.com/0xPlayerOne/control-plane/issues/89)) ([09c0554](https://github.com/0xPlayerOne/control-plane/commit/09c0554f832e4bb40229ed0366274ea2b78721fe))
* scaffold NestJS Fastify Control API ([e99cdde](https://github.com/0xPlayerOne/control-plane/commit/e99cdded89f5c3dad6d6ff0b6d45c06a8b2bee73)), closes [#4](https://github.com/0xPlayerOne/control-plane/issues/4)


### Tests

* add shared foundation harness ([#79](https://github.com/0xPlayerOne/control-plane/issues/79)) ([96053ed](https://github.com/0xPlayerOne/control-plane/commit/96053ed7e9a38a3f391168b12906a7165f335fb3))
* prove M2 core-domain acceptance ([#103](https://github.com/0xPlayerOne/control-plane/issues/103)) ([eada793](https://github.com/0xPlayerOne/control-plane/commit/eada793f49e91ba4179e126b592bcb40b77ee88b)), closes [#19](https://github.com/0xPlayerOne/control-plane/issues/19)


### Maintenance

* **deps:** apply compatible npm dependency updates ([#102](https://github.com/0xPlayerOne/control-plane/issues/102)) ([eaf3e48](https://github.com/0xPlayerOne/control-plane/commit/eaf3e48f5fe6c85c79e6d83874df8af24f079f5c))
