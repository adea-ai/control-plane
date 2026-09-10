# Changelog

## [1.5.1](https://github.com/adea-ai/control-plane/compare/config-v1.5.0...config-v1.5.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/config-v1.4.0...config-v1.5.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/config-v1.3.2...config-v1.4.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))
* **packages:** publish six stable packages under [@adea-ai](https://github.com/adea-ai) on npm ([#398](https://github.com/adea-ai/control-plane/issues/398)) ([973a8df](https://github.com/adea-ai/control-plane/commit/973a8df4eb4957f1b9ffa92760aff6584cc6605d))

## [1.3.2](https://github.com/adea-ai/control-plane/compare/config-v1.3.1...config-v1.3.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/config-v1.3.0...config-v1.3.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/config-v1.2.0...config-v1.3.0) (2026-08-30)


### Features

* **portability:** add local deployment configuration ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **hosted:** add hosted deployment configuration ([#311](https://github.com/0xPlayerOne/control-plane/pull/311)) ([2a4de56](https://github.com/0xPlayerOne/control-plane/commit/2a4de56d6e352155cf42c0b44302241f1b92442a))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/config-v1.1.1...config-v1.2.0) (2026-08-29)


### Features

* **control-api:** verify signed service credentials ([585777d](https://github.com/0xPlayerOne/control-plane/commit/585777d32f7c8f44c90053236175e35b21c1eef5))
* **infra:** codify Railway project ([#245](https://github.com/0xPlayerOne/control-plane/issues/245)) ([1944f4e](https://github.com/0xPlayerOne/control-plane/commit/1944f4e1d1cdaaef98d2a43762ff1e9395a397bc))
* **infrastructure:** wire managed cloud dependencies ([#221](https://github.com/0xPlayerOne/control-plane/issues/221)) ([ff809b0](https://github.com/0xPlayerOne/control-plane/commit/ff809b0445f29fec2c47ce19745b9092ec8fca38))
* **operations:** centralize managed cloud policy defaults ([#225](https://github.com/0xPlayerOne/control-plane/issues/225)) ([096b17a](https://github.com/0xPlayerOne/control-plane/commit/096b17ab9921784ce6cf4ced34d5f82d0f08c961))
* **workflow-worker:** add cloud certification runtime ([c47e830](https://github.com/0xPlayerOne/control-plane/commit/c47e8309a8ea71342d8dda0cc79c91d9b400b20d))


### Bug Fixes

* **config:** consume Railway deployment metadata ([#237](https://github.com/0xPlayerOne/control-plane/issues/237)) ([dd6079b](https://github.com/0xPlayerOne/control-plane/commit/dd6079be7c2d660e2b15faf8b1b8bdb66ea1c0fa))
* **infra:** secure Restate service boundary ([#247](https://github.com/0xPlayerOne/control-plane/issues/247)) ([667eb58](https://github.com/0xPlayerOne/control-plane/commit/667eb58e95886eca5327367ca083f90c13fd5ff2))

## [1.1.1](https://github.com/0xPlayerOne/control-plane/compare/config-v1.1.0...config-v1.1.1) (2026-08-25)


### Maintenance

* **typescript:** strengthen compiler checks ([#151](https://github.com/0xPlayerOne/control-plane/issues/151)) ([b58dfba](https://github.com/0xPlayerOne/control-plane/commit/b58dfba7d2aa6f4eaf783d89cb8899eb6cffc636))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/config-v1.0.0...config-v1.1.0) (2026-08-25)


### Features

* add PostgreSQL persistence foundation ([2fdfd88](https://github.com/0xPlayerOne/control-plane/commit/2fdfd8856ab7b1d4d7e592e1d998a0e8314f11b9)), closes [#3](https://github.com/0xPlayerOne/control-plane/issues/3)
* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))


### Maintenance

* release main ([d081764](https://github.com/0xPlayerOne/control-plane/commit/d081764aae773a9430e883b675253fbba3d69603))

## 1.0.0 (2026-08-24)


### Features

* add PostgreSQL persistence foundation ([2fdfd88](https://github.com/0xPlayerOne/control-plane/commit/2fdfd8856ab7b1d4d7e592e1d998a0e8314f11b9)), closes [#3](https://github.com/0xPlayerOne/control-plane/issues/3)
* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
