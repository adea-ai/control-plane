# Changelog

## [1.9.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.8.1...hosted-control-plane-v1.9.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))
* **hosted:** make the retention sweep cadence configurable ([#562](https://github.com/adea-ai/control-plane/issues/562)) ([fae3fdc](https://github.com/adea-ai/control-plane/commit/fae3fdc081a7f77caa2bdf684691af6d5884a6e8))


### Bug Fixes

* **control-api:** wire database readiness and the retention sweep into the cloud composition ([#566](https://github.com/adea-ai/control-plane/issues/566)) ([a692613](https://github.com/adea-ai/control-plane/commit/a692613ffc5c3a45f4d24c2a23b2fdb3f46a537d))
* **hosted:** make /ready fail closed when the database is unreachable ([#565](https://github.com/adea-ai/control-plane/issues/565)) ([1005ac0](https://github.com/adea-ai/control-plane/commit/1005ac00b5398fcd817bddf66b999ad0d8ab6e12))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* consolidate the reconciliation scheduler into packages/deployment ([#568](https://github.com/adea-ai/control-plane/issues/568)) ([5e06e27](https://github.com/adea-ai/control-plane/commit/5e06e270b796a35efc434d8d20e05a56126e6971))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.8.1](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.8.0...hosted-control-plane-v1.8.1) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.7.0...hosted-control-plane-v1.8.0) (2026-09-16)


### Features

* **hosted:** wire the retention sweep into the hosted composition ([#547](https://github.com/adea-ai/control-plane/issues/547)) ([e0bba6f](https://github.com/adea-ai/control-plane/commit/e0bba6f4232625ecd85fe3e5629e4e99bafa101e))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.6.0...hosted-control-plane-v1.7.0) (2026-09-15)


### Features

* cprnode025-launch-wiring ([#504](https://github.com/adea-ai/control-plane/issues/504)) ([1c9bab2](https://github.com/adea-ai/control-plane/commit/1c9bab2858e6aa7ee06435edec353d1d7699dce6))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.5.0...hosted-control-plane-v1.6.0) (2026-09-13)


### Features

* **domain:** compose the reconciliation observation projection ([#478](https://github.com/adea-ai/control-plane/issues/478)) ([8365442](https://github.com/adea-ai/control-plane/commit/83654422e64f98c25224570f871d8aa33983ca18))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.4.0...hosted-control-plane-v1.5.0) (2026-09-13)


### Features

* **context:** deliver and reconcile authenticated gateway commands ([#476](https://github.com/adea-ai/control-plane/issues/476)) ([d8d8074](https://github.com/adea-ai/control-plane/commit/d8d8074d1d05aa0523e206e5ffed18fe3452de95))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.3.1...hosted-control-plane-v1.4.0) (2026-09-12)


### Features

* integrate M11 provider authoring and native build fixes ([#470](https://github.com/adea-ai/control-plane/issues/470)) ([b195736](https://github.com/adea-ai/control-plane/commit/b195736c2fa5154b43dd82deeaa7fc1c26326f71))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.3.0...hosted-control-plane-v1.3.1) (2026-09-10)


### Maintenance

* roll up dependencies and Code Foundry v1.28.6 ([#442](https://github.com/adea-ai/control-plane/issues/442)) ([09a245a](https://github.com/adea-ai/control-plane/commit/09a245abf2ed325d9dfc7f900851389745c83e3e))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.2.0...hosted-control-plane-v1.3.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.2.0](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.1.2...hosted-control-plane-v1.2.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.1.2](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.1.1...hosted-control-plane-v1.1.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.1.1](https://github.com/adea-ai/control-plane/compare/hosted-control-plane-v1.1.0...hosted-control-plane-v1.1.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/hosted-control-plane-v1.0.0...hosted-control-plane-v1.1.0) (2026-08-30)


### Features

* **hosted:** ship Compose deployment profiles ([#311](https://github.com/0xPlayerOne/control-plane/pull/311)) ([2a4de56](https://github.com/0xPlayerOne/control-plane/commit/2a4de56d6e352155cf42c0b44302241f1b92442a))
* **relay:** integrate encrypted remote control ([#312](https://github.com/0xPlayerOne/control-plane/pull/312)) ([09cebc6](https://github.com/0xPlayerOne/control-plane/commit/09cebc6341dbd8f3768d43d8b1318d2481f3cc85))
* **portability:** publish hosted profile conformance ([#315](https://github.com/0xPlayerOne/control-plane/pull/315)) ([fefdba2](https://github.com/0xPlayerOne/control-plane/commit/fefdba2c454e99f7bbd73c14f25a08941286342a))
* **operations:** add replaceable S3 storage and dependency readiness ([#317](https://github.com/0xPlayerOne/control-plane/pull/317)) ([af22ead](https://github.com/0xPlayerOne/control-plane/commit/af22eade12e70d5de982f385e0747862f5b39c7c))
