# Changelog

## [1.14.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.13.2...local-control-plane-v1.14.0) (2026-09-24)


### Features

* **m11:** catalog version approval decisions as separate version-bound records ([#680](https://github.com/adea-ai/control-plane/issues/680)) ([332fa2b](https://github.com/adea-ai/control-plane/commit/332fa2b06660de0e07e5c4e0993d491cb45b84d0))

## [1.13.2](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.13.1...local-control-plane-v1.13.2) (2026-09-22)


### Bug Fixes

* **retention:** contain unsafe deletion and drain scheduled cleanup ([#636](https://github.com/adea-ai/control-plane/issues/636)) ([7d1703e](https://github.com/adea-ai/control-plane/commit/7d1703e076224ef466086b515ea0c6190cb7ba96))

## [1.13.1](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.13.0...local-control-plane-v1.13.1) (2026-09-21)


### Maintenance

* **deps:** bump the npm-dependencies group with 4 updates ([#595](https://github.com/adea-ai/control-plane/issues/595)) ([d754692](https://github.com/adea-ai/control-plane/commit/d7546929d62c1656047e53af046e0e86bfbc7244))

## [1.13.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.12.1...local-control-plane-v1.13.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))
* **local:** SQLite-backed durable execution without Restate + persistence-profile conformance ([#569](https://github.com/adea-ai/control-plane/issues/569)) ([a6ceaf0](https://github.com/adea-ai/control-plane/commit/a6ceaf0ac5d7544ae5196e58995c9a4d81971c49))


### Bug Fixes

* **hosted:** make /ready fail closed when the database is unreachable ([#565](https://github.com/adea-ai/control-plane/issues/565)) ([1005ac0](https://github.com/adea-ai/control-plane/commit/1005ac00b5398fcd817bddf66b999ad0d8ab6e12))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* consolidate the reconciliation scheduler into packages/deployment ([#568](https://github.com/adea-ai/control-plane/issues/568)) ([5e06e27](https://github.com/adea-ai/control-plane/commit/5e06e270b796a35efc434d8d20e05a56126e6971))
* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.12.1](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.12.0...local-control-plane-v1.12.1) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.12.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.11.0...local-control-plane-v1.12.0) (2026-09-16)


### Features

* **hosted:** wire the retention sweep into the hosted composition ([#547](https://github.com/adea-ai/control-plane/issues/547)) ([e0bba6f](https://github.com/adea-ai/control-plane/commit/e0bba6f4232625ecd85fe3e5629e4e99bafa101e))

## [1.11.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.10.0...local-control-plane-v1.11.0) (2026-09-15)


### Features

* **local:** wire the retention sweep into the local composition ([#528](https://github.com/adea-ai/control-plane/issues/528)) ([ef69e2e](https://github.com/adea-ai/control-plane/commit/ef69e2e795527a311ba20dcd5fd2450706bdf284))

## [1.10.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.9.0...local-control-plane-v1.10.0) (2026-09-15)


### Features

* cprnode025-launch-wiring ([#504](https://github.com/adea-ai/control-plane/issues/504)) ([1c9bab2](https://github.com/adea-ai/control-plane/commit/1c9bab2858e6aa7ee06435edec353d1d7699dce6))

## [1.9.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.8.0...local-control-plane-v1.9.0) (2026-09-13)


### Features

* **domain:** compose the reconciliation observation projection ([#478](https://github.com/adea-ai/control-plane/issues/478)) ([8365442](https://github.com/adea-ai/control-plane/commit/83654422e64f98c25224570f871d8aa33983ca18))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.7.0...local-control-plane-v1.8.0) (2026-09-13)


### Features

* **context:** deliver and reconcile authenticated gateway commands ([#476](https://github.com/adea-ai/control-plane/issues/476)) ([d8d8074](https://github.com/adea-ai/control-plane/commit/d8d8074d1d05aa0523e206e5ffed18fe3452de95))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.6.1...local-control-plane-v1.7.0) (2026-09-12)


### Features

* integrate M11 provider authoring and native build fixes ([#470](https://github.com/adea-ai/control-plane/issues/470)) ([b195736](https://github.com/adea-ai/control-plane/commit/b195736c2fa5154b43dd82deeaa7fc1c26326f71))

## [1.6.1](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.6.0...local-control-plane-v1.6.1) (2026-09-12)


### Bug Fixes

* **local:** isolate standalone Restate test listeners ([#454](https://github.com/adea-ai/control-plane/issues/454)) ([0ef96af](https://github.com/adea-ai/control-plane/commit/0ef96af56caf90fdd370d5875b0cb1ded30bc51d))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.5.3...local-control-plane-v1.6.0) (2026-09-12)


### Features

* local-profile-marketplace-registry ([#448](https://github.com/adea-ai/control-plane/issues/448)) ([87bb3c1](https://github.com/adea-ai/control-plane/commit/87bb3c159626cddfeb36f0024abe64b1e1f3428f))

## [1.5.3](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.5.2...local-control-plane-v1.5.3) (2026-09-10)


### Maintenance

* roll up dependencies and Code Foundry v1.28.6 ([#442](https://github.com/adea-ai/control-plane/issues/442)) ([09a245a](https://github.com/adea-ai/control-plane/commit/09a245abf2ed325d9dfc7f900851389745c83e3e))

## [1.5.2](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.5.1...local-control-plane-v1.5.2) (2026-09-09)


### Bug Fixes

* **acp:** preserve native approval identity across progress replay ([#438](https://github.com/adea-ai/control-plane/issues/438)) ([22e1653](https://github.com/adea-ai/control-plane/commit/22e1653626e724f9e46d44ad388f07729de8d0f7))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.5.0...local-control-plane-v1.5.1) (2026-09-08)


### Bug Fixes

* **local:** close native Codex provider streams on cancellation ([#436](https://github.com/adea-ai/control-plane/issues/436)) ([66b9729](https://github.com/adea-ai/control-plane/commit/66b972947d3d174c35943228285677a6138d0733))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.4.1...local-control-plane-v1.5.0) (2026-09-08)


### Features

* **local:** install and launch pinned Codex ACP runtime ([#434](https://github.com/adea-ai/control-plane/issues/434)) ([5d07c04](https://github.com/adea-ai/control-plane/commit/5d07c044e174e0ea98073b7fd7d154121a4e4d84))

## [1.4.1](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.4.0...local-control-plane-v1.4.1) (2026-09-08)


### Bug Fixes

* **local:** require terminal confirmation before cancellation commit ([#430](https://github.com/adea-ai/control-plane/issues/430)) ([2cccca2](https://github.com/adea-ai/control-plane/commit/2cccca20413d18b804d3cfb9042e786c7078b693))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.3.0...local-control-plane-v1.4.0) (2026-09-08)


### Features

* **local:** persist terminal usage before cancellation cleanup ([#427](https://github.com/adea-ai/control-plane/issues/427)) ([3470d9a](https://github.com/adea-ai/control-plane/commit/3470d9ac5d0f1f32e70f3b8deedf82c3b37a06b4))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.2.0...local-control-plane-v1.3.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.2.0](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.1.2...local-control-plane-v1.2.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))


### Bug Fixes

* **m11:** retain direct-runtime dispatch intent across restart ([#420](https://github.com/adea-ai/control-plane/issues/420)) ([8b85ef7](https://github.com/adea-ai/control-plane/commit/8b85ef7a2231405ec1c9aa4ffa16b0862e0f3044))

## [1.1.2](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.1.1...local-control-plane-v1.1.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.1.1](https://github.com/adea-ai/control-plane/compare/local-control-plane-v1.1.0...local-control-plane-v1.1.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/local-control-plane-v1.0.0...local-control-plane-v1.1.0) (2026-08-30)


### Features

* **portability:** add the all-in-one local control plane ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **hosted:** share hardened private authentication ([#311](https://github.com/0xPlayerOne/control-plane/pull/311)) ([2a4de56](https://github.com/0xPlayerOne/control-plane/commit/2a4de56d6e352155cf42c0b44302241f1b92442a))
* **relay:** integrate encrypted remote control ([#312](https://github.com/0xPlayerOne/control-plane/pull/312)) ([09cebc6](https://github.com/0xPlayerOne/control-plane/commit/09cebc6341dbd8f3768d43d8b1318d2481f3cc85))
* **runtime:** add the direct-local adapter transport chain ([#313](https://github.com/0xPlayerOne/control-plane/pull/313)) ([1fac8e1](https://github.com/0xPlayerOne/control-plane/commit/1fac8e13184ed661f1df4853d63ffde0f56a79b2))
* **remote-control:** complete encrypted relay delivery ([#314](https://github.com/0xPlayerOne/control-plane/pull/314)) ([4d275ca](https://github.com/0xPlayerOne/control-plane/commit/4d275ca711a3bbeb5fdb3ab75cbd6469aab0ff6d))
* **operations:** add checkpoint recovery and readiness ([#317](https://github.com/0xPlayerOne/control-plane/pull/317)) ([af22ead](https://github.com/0xPlayerOne/control-plane/commit/af22eade12e70d5de982f385e0747862f5b39c7c))
