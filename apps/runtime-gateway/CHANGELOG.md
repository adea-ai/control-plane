# Changelog

## [1.2.2](https://github.com/adea-ai/control-plane/compare/runtime-gateway-v1.2.1...runtime-gateway-v1.2.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.2.1](https://github.com/adea-ai/control-plane/compare/runtime-gateway-v1.2.0...runtime-gateway-v1.2.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-gateway-v1.1.1...runtime-gateway-v1.2.0) (2026-08-29)


### Features

* **control-api:** verify signed service credentials ([585777d](https://github.com/0xPlayerOne/control-plane/commit/585777d32f7c8f44c90053236175e35b21c1eef5))


### Bug Fixes

* **bootstrap:** enforce managed cloud startup configuration ([#233](https://github.com/0xPlayerOne/control-plane/issues/233)) ([d186b3a](https://github.com/0xPlayerOne/control-plane/commit/d186b3afa9072d9124168dfc3e15f41dd129a066))
* **operations:** apply cloud policy defaults at boundaries ([#231](https://github.com/0xPlayerOne/control-plane/issues/231)) ([d95ac2f](https://github.com/0xPlayerOne/control-plane/commit/d95ac2f030a1f791676845b7e15e75d6edcc24e4))

## [1.1.1](https://github.com/0xPlayerOne/control-plane/compare/runtime-gateway-v1.1.0...runtime-gateway-v1.1.1) (2026-08-25)


### Bug Fixes

* **gateway:** reject frames after channel revocation ([#147](https://github.com/0xPlayerOne/control-plane/issues/147)) ([1c9ce81](https://github.com/0xPlayerOne/control-plane/commit/1c9ce8155313196e47f3925fbdcda622475cf026))
* **runtime-gateway:** fail closed without production server ([#154](https://github.com/0xPlayerOne/control-plane/issues/154)) ([e6309d7](https://github.com/0xPlayerOne/control-plane/commit/e6309d76a262fae79ee388aebdb22632dd7fdbe6))
* **runtime-gateway:** require explicit reconnect recovery ([#150](https://github.com/0xPlayerOne/control-plane/issues/150)) ([1072dd9](https://github.com/0xPlayerOne/control-plane/commit/1072dd9f991d5d9693e7d4475cc9471cf0e42136))


### Maintenance

* **runtime-gateway:** unify event context types ([#153](https://github.com/0xPlayerOne/control-plane/issues/153)) ([a012e71](https://github.com/0xPlayerOne/control-plane/commit/a012e7156c88354156745dc6fcdb983091c33346))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-gateway-v1.0.0...runtime-gateway-v1.1.0) (2026-08-25)


### Features

* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* **foundation:** add M1 acceptance baseline ([#87](https://github.com/0xPlayerOne/control-plane/issues/87)) ([bba3f0e](https://github.com/0xPlayerOne/control-plane/commit/bba3f0eea1fb77a20c51e468d34bf629a67fdfe2))
* **gateway:** authenticate runtime node channels ([#137](https://github.com/0xPlayerOne/control-plane/issues/137)) ([ddb04b8](https://github.com/0xPlayerOne/control-plane/commit/ddb04b883ddcfaf84fe3b2521118113c267b55aa))
* **gateway:** ingest normalized runtime events ([#140](https://github.com/0xPlayerOne/control-plane/issues/140)) ([7542146](https://github.com/0xPlayerOne/control-plane/commit/7542146f8f84fc72061c17d4fc4bc7ec435ddc76))
* **gateway:** manage scalable websocket channels ([#138](https://github.com/0xPlayerOne/control-plane/issues/138)) ([02a5d48](https://github.com/0xPlayerOne/control-plane/commit/02a5d48b7982097448dddda79d07a3bc6e799e89))
* **gateway:** persist runtime command delivery ([#139](https://github.com/0xPlayerOne/control-plane/issues/139)) ([1874f27](https://github.com/0xPlayerOne/control-plane/commit/1874f27edbd925b7ba5f9f74d26cc53719758f8b))
* **gateway:** reconcile reconnect command state ([#142](https://github.com/0xPlayerOne/control-plane/issues/142)) ([3f897aa](https://github.com/0xPlayerOne/control-plane/commit/3f897aa0b72c5b5e1930342aab7079bf8a12dbae))
* **gateway:** synchronize runtime inventory health ([#141](https://github.com/0xPlayerOne/control-plane/issues/141)) ([656b580](https://github.com/0xPlayerOne/control-plane/commit/656b580e58986b460b10d109cdeed78ba620307f))


### Maintenance

* release main ([d081764](https://github.com/0xPlayerOne/control-plane/commit/d081764aae773a9430e883b675253fbba3d69603))

## 1.0.0 (2026-08-24)


### Features

* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* **foundation:** add M1 acceptance baseline ([#87](https://github.com/0xPlayerOne/control-plane/issues/87)) ([bba3f0e](https://github.com/0xPlayerOne/control-plane/commit/bba3f0eea1fb77a20c51e468d34bf629a67fdfe2))
