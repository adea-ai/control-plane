# Changelog

## [1.8.1](https://github.com/adea-ai/control-plane/compare/runtime-sdk-v1.8.0...runtime-sdk-v1.8.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/runtime-sdk-v1.7.0...runtime-sdk-v1.8.0) (2026-09-09)


### Features

* add marketplace agent plugin plans ([0441004](https://github.com/adea-ai/control-plane/commit/0441004f34fd4b61b4fa63acd261bdbab9432856))
* add marketplace Agent Plugins plans ([#440](https://github.com/adea-ai/control-plane/issues/440)) ([0441004](https://github.com/adea-ai/control-plane/commit/0441004f34fd4b61b4fa63acd261bdbab9432856))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/runtime-sdk-v1.6.0...runtime-sdk-v1.7.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/runtime-sdk-v1.5.3...runtime-sdk-v1.6.0) (2026-09-08)


### Features

* **acp:** manage external session references ([#160](https://github.com/adea-ai/control-plane/issues/160)) ([46ecc7b](https://github.com/adea-ai/control-plane/commit/46ecc7bbb46e8b20943b1688c72d37bdf2d05ae4)), closes [#48](https://github.com/adea-ai/control-plane/issues/48)
* bootstrap the platform monorepo ([3a745cd](https://github.com/adea-ai/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/adea-ai/control-plane/issues/222)) ([e6aa0f1](https://github.com/adea-ai/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))
* define runtime capability compatibility model ([#91](https://github.com/adea-ai/control-plane/issues/91)) ([6fa2a77](https://github.com/adea-ai/control-plane/commit/6fa2a777692aae1277a5823cb7f52bf56c7df973))
* **gateway:** synchronize runtime inventory health ([#141](https://github.com/adea-ai/control-plane/issues/141)) ([656b580](https://github.com/adea-ai/control-plane/commit/656b580e58986b460b10d109cdeed78ba620307f))
* **operations:** complete M10 local and hosted hardening ([#317](https://github.com/adea-ai/control-plane/issues/317)) ([af22ead](https://github.com/adea-ai/control-plane/commit/af22eade12e70d5de982f385e0747862f5b39c7c))
* **packages:** publish six stable packages under [@adea-ai](https://github.com/adea-ai) on npm ([#398](https://github.com/adea-ai/control-plane/issues/398)) ([973a8df](https://github.com/adea-ai/control-plane/commit/973a8df4eb4957f1b9ffa92760aff6584cc6605d))
* **runtime:** certify adapter compatibility ([#162](https://github.com/adea-ai/control-plane/issues/162)) ([14403fd](https://github.com/adea-ai/control-plane/commit/14403fdaa37a40d61f6e6bc7cd9e5a4f72de29bc)), closes [#50](https://github.com/adea-ai/control-plane/issues/50)
* **runtime:** define adapter contract and conformance harness ([#116](https://github.com/adea-ai/control-plane/issues/116)) ([434f688](https://github.com/adea-ai/control-plane/commit/434f6888c9c886c39eab6bb057d0285ecc56f7bd))
* **runtime:** evaluate runtime eligibility deterministically ([#120](https://github.com/adea-ai/control-plane/issues/120)) ([840b9b5](https://github.com/adea-ai/control-plane/commit/840b9b58ea400be3d41388218cc2adbad20202a8))
* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/adea-ai/control-plane/issues/123)) ([cf43141](https://github.com/adea-ai/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))
* **runtime:** ingest health and capability freshness ([#119](https://github.com/adea-ai/control-plane/issues/119)) ([d47445b](https://github.com/adea-ai/control-plane/commit/d47445bbeb0e88e1e65db8cafdff150061b2ca84))
* **runtime:** persist external session references ([#122](https://github.com/adea-ai/control-plane/issues/122)) ([1ef146c](https://github.com/adea-ai/control-plane/commit/1ef146c02b46021b9a13a232ce1b612f608077c7))
* **runtime:** persist runtime connection inventory ([#118](https://github.com/adea-ai/control-plane/issues/118)) ([20fdb11](https://github.com/adea-ai/control-plane/commit/20fdb11db89e75607785734d55057e648c664aac))
* **runtime:** route eligible runtimes deterministically ([#121](https://github.com/adea-ai/control-plane/issues/121)) ([9f7a0fd](https://github.com/adea-ai/control-plane/commit/9f7a0fd74e179dd592d9727ae49bc222b99251d8))


### Bug Fixes

* **publish:** rewrite workspace specifiers in staged dist and republish SDKs ([6f96903](https://github.com/adea-ai/control-plane/commit/6f96903e65d2b721eb31433742a0e5797ef42d24))
* **publish:** rewrite workspace specifiers in staged dist; republish SDKs ([#402](https://github.com/adea-ai/control-plane/issues/402)) ([6f96903](https://github.com/adea-ai/control-plane/commit/6f96903e65d2b721eb31433742a0e5797ef42d24))
* **runtime:** report expired session discovery snapshots ([#133](https://github.com/adea-ai/control-plane/issues/133)) ([cd8834f](https://github.com/adea-ai/control-plane/commit/cd8834fbe98ae5deef501f05e2d9b3c669df1e9b))
* **runtime:** require negotiated capability verification ([#131](https://github.com/adea-ai/control-plane/issues/131)) ([af0423f](https://github.com/adea-ai/control-plane/commit/af0423f87810e7dd9bc0a11fa00836e3fbce9575))


### Documentation

* **release:** restore complete M10 changelogs ([0734271](https://github.com/adea-ai/control-plane/commit/073427125e6255d66e5fd6a0dbcc39aacf1e83ae))


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))
* release main ([eb6133e](https://github.com/adea-ai/control-plane/commit/eb6133e578f756da1e933bd52c6e8bf3902ad13c))
* release main ([c3df837](https://github.com/adea-ai/control-plane/commit/c3df8370762b4068a010e0de985134db4ffadee9))
* release main ([949c8a6](https://github.com/adea-ai/control-plane/commit/949c8a6dad24173499ac8cae332d10fa28ab3b16))
* release main ([5e8dcfa](https://github.com/adea-ai/control-plane/commit/5e8dcfa7f75eb7a1e65410f659011e3232ab1a1f))
* release main ([712ab95](https://github.com/adea-ai/control-plane/commit/712ab95211dc2fc9c9f5afcf44c9fd040d8258bb))
* release main ([a82b25f](https://github.com/adea-ai/control-plane/commit/a82b25f528be5aff68ec7120463c477e5184fc15))
* release main ([ab2525e](https://github.com/adea-ai/control-plane/commit/ab2525e87de56d705177537adadfed6b0d281ded))
* release main ([d081764](https://github.com/adea-ai/control-plane/commit/d081764aae773a9430e883b675253fbba3d69603))
* release main ([#156](https://github.com/adea-ai/control-plane/issues/156)) ([863d18e](https://github.com/adea-ai/control-plane/commit/863d18eca31922dac839c70999a30f4c2e84359e))
* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.5.2](https://github.com/adea-ai/control-plane/compare/runtime-sdk-v1.5.1...runtime-sdk-v1.5.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/runtime-sdk-v1.5.0...runtime-sdk-v1.5.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.5.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-sdk-v1.4.0...runtime-sdk-v1.5.0) (2026-08-30)


### Features

* **portability:** add direct local runtime transport ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **runtime:** add direct-local adapter transport ([#313](https://github.com/0xPlayerOne/control-plane/pull/313)) ([1fac8e1](https://github.com/0xPlayerOne/control-plane/commit/1fac8e13184ed661f1df4853d63ffde0f56a79b2))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-sdk-v1.3.0...runtime-sdk-v1.4.0) (2026-08-29)


### Features

* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/0xPlayerOne/control-plane/issues/222)) ([e6aa0f1](https://github.com/0xPlayerOne/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-sdk-v1.2.0...runtime-sdk-v1.3.0) (2026-08-25)


### Features

* **acp:** manage external session references ([#160](https://github.com/0xPlayerOne/control-plane/issues/160)) ([46ecc7b](https://github.com/0xPlayerOne/control-plane/commit/46ecc7bbb46e8b20943b1688c72d37bdf2d05ae4)), closes [#48](https://github.com/0xPlayerOne/control-plane/issues/48)
* **runtime:** certify adapter compatibility ([#162](https://github.com/0xPlayerOne/control-plane/issues/162)) ([14403fd](https://github.com/0xPlayerOne/control-plane/commit/14403fdaa37a40d61f6e6bc7cd9e5a4f72de29bc)), closes [#50](https://github.com/0xPlayerOne/control-plane/issues/50)

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-sdk-v1.1.1...runtime-sdk-v1.2.0) (2026-08-25)


### Features

* **gateway:** synchronize runtime inventory health ([#141](https://github.com/0xPlayerOne/control-plane/issues/141)) ([656b580](https://github.com/0xPlayerOne/control-plane/commit/656b580e58986b460b10d109cdeed78ba620307f))

## [1.1.1](https://github.com/0xPlayerOne/control-plane/compare/runtime-sdk-v1.1.0...runtime-sdk-v1.1.1) (2026-08-24)


### Bug Fixes

* **runtime:** report expired session discovery snapshots ([#133](https://github.com/0xPlayerOne/control-plane/issues/133)) ([cd8834f](https://github.com/0xPlayerOne/control-plane/commit/cd8834fbe98ae5deef501f05e2d9b3c669df1e9b))
* **runtime:** require negotiated capability verification ([#131](https://github.com/0xPlayerOne/control-plane/issues/131)) ([af0423f](https://github.com/0xPlayerOne/control-plane/commit/af0423f87810e7dd9bc0a11fa00836e3fbce9575))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-sdk-v1.0.0...runtime-sdk-v1.1.0) (2026-08-24)


### Features

* **runtime:** define adapter contract and conformance harness ([#116](https://github.com/0xPlayerOne/control-plane/issues/116)) ([434f688](https://github.com/0xPlayerOne/control-plane/commit/434f6888c9c886c39eab6bb057d0285ecc56f7bd))
* **runtime:** evaluate runtime eligibility deterministically ([#120](https://github.com/0xPlayerOne/control-plane/issues/120)) ([840b9b5](https://github.com/0xPlayerOne/control-plane/commit/840b9b58ea400be3d41388218cc2adbad20202a8))
* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/0xPlayerOne/control-plane/issues/123)) ([cf43141](https://github.com/0xPlayerOne/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))
* **runtime:** ingest health and capability freshness ([#119](https://github.com/0xPlayerOne/control-plane/issues/119)) ([d47445b](https://github.com/0xPlayerOne/control-plane/commit/d47445bbeb0e88e1e65db8cafdff150061b2ca84))
* **runtime:** persist external session references ([#122](https://github.com/0xPlayerOne/control-plane/issues/122)) ([1ef146c](https://github.com/0xPlayerOne/control-plane/commit/1ef146c02b46021b9a13a232ce1b612f608077c7))
* **runtime:** persist runtime connection inventory ([#118](https://github.com/0xPlayerOne/control-plane/issues/118)) ([20fdb11](https://github.com/0xPlayerOne/control-plane/commit/20fdb11db89e75607785734d55057e648c664aac))
* **runtime:** route eligible runtimes deterministically ([#121](https://github.com/0xPlayerOne/control-plane/issues/121)) ([9f7a0fd](https://github.com/0xPlayerOne/control-plane/commit/9f7a0fd74e179dd592d9727ae49bc222b99251d8))

## 1.0.0 (2026-08-24)


### Features

* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* define runtime capability compatibility model ([#91](https://github.com/0xPlayerOne/control-plane/issues/91)) ([6fa2a77](https://github.com/0xPlayerOne/control-plane/commit/6fa2a777692aae1277a5823cb7f52bf56c7df973))
