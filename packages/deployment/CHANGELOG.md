# Changelog

## [1.7.3](https://github.com/adea-ai/control-plane/compare/deployment-v1.7.2...deployment-v1.7.3) (2026-09-22)


### Bug Fixes

* **m612:** migrate the write-once digest sites; record insertion-order decisions ([#653](https://github.com/adea-ai/control-plane/issues/653)) ([dd0dc7d](https://github.com/adea-ai/control-plane/commit/dd0dc7d271866f06f53361881a6fc908d6c17f7c))

## [1.7.2](https://github.com/adea-ai/control-plane/compare/deployment-v1.7.1...deployment-v1.7.2) (2026-09-22)


### Bug Fixes

* **retention:** contain unsafe deletion and drain scheduled cleanup ([#636](https://github.com/adea-ai/control-plane/issues/636)) ([7d1703e](https://github.com/adea-ai/control-plane/commit/7d1703e076224ef466086b515ea0c6190cb7ba96))

## [1.7.1](https://github.com/adea-ai/control-plane/compare/deployment-v1.7.0...deployment-v1.7.1) (2026-09-20)


### Bug Fixes

* **contracts:** locale-independent canonicalJsonStringify + canonical-JSON divergence audit ([#611](https://github.com/adea-ai/control-plane/issues/611)) ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))


### Maintenance

* **contracts:** add canonicalJsonStringify and consolidate canonical-JSON digests ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/deployment-v1.6.1...deployment-v1.7.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Bug Fixes

* **audit:** restore fail-closed acceptance gates ([#584](https://github.com/adea-ai/control-plane/issues/584)) ([7dae3e1](https://github.com/adea-ai/control-plane/commit/7dae3e1967fe5d31d52e0b7352dd11651e58105e))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* consolidate child-process RPC plumbing into ProcessRpcLink ([61331fd](https://github.com/adea-ai/control-plane/commit/61331fd6bcccaa2abe07bfaa3a049642d1666d97))
* consolidate the reconciliation scheduler into packages/deployment ([#568](https://github.com/adea-ai/control-plane/issues/568)) ([5e06e27](https://github.com/adea-ai/control-plane/commit/5e06e270b796a35efc434d8d20e05a56126e6971))
* **m13:** consolidate child-process RPC plumbing into ProcessRpcLink ([#583](https://github.com/adea-ai/control-plane/issues/583)) ([61331fd](https://github.com/adea-ai/control-plane/commit/61331fd6bcccaa2abe07bfaa3a049642d1666d97))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.6.1](https://github.com/adea-ai/control-plane/compare/deployment-v1.6.0...deployment-v1.6.1) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/deployment-v1.5.0...deployment-v1.6.0) (2026-09-16)


### Features

* **hosted:** wire the retention sweep into the hosted composition ([#547](https://github.com/adea-ai/control-plane/issues/547)) ([e0bba6f](https://github.com/adea-ai/control-plane/commit/e0bba6f4232625ecd85fe3e5629e4e99bafa101e))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/deployment-v1.4.0...deployment-v1.5.0) (2026-09-15)


### Features

* cprnode025-launch-wiring ([#504](https://github.com/adea-ai/control-plane/issues/504)) ([1c9bab2](https://github.com/adea-ai/control-plane/commit/1c9bab2858e6aa7ee06435edec353d1d7699dce6))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/deployment-v1.3.1...deployment-v1.4.0) (2026-09-13)


### Features

* **events:** escalate stuck deliveries and record terminal disagreements ([#488](https://github.com/adea-ai/control-plane/issues/488)) ([2661fbd](https://github.com/adea-ai/control-plane/commit/2661fbd3a31565218809a12ff9dc4b9e3dfb4437))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/deployment-v1.3.0...deployment-v1.3.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/deployment-v1.2.0...deployment-v1.3.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.2.0](https://github.com/adea-ai/control-plane/compare/deployment-v1.1.1...deployment-v1.2.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.1.1](https://github.com/adea-ai/control-plane/compare/deployment-v1.1.0...deployment-v1.1.1) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/deployment-v1.0.0...deployment-v1.1.0) (2026-08-30)


### Features

* **portability:** add local deployment-profile infrastructure ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **operations:** add verified filesystem checkpoints ([#317](https://github.com/0xPlayerOne/control-plane/pull/317)) ([af22ead](https://github.com/0xPlayerOne/control-plane/commit/af22eade12e70d5de982f385e0747862f5b39c7c))
