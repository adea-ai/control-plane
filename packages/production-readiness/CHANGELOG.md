# Changelog

## [1.3.2](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.3.1...production-readiness-v1.3.2) (2026-09-22)


### Bug Fixes

* **m612:** migrate the write-once digest sites; record insertion-order decisions ([#653](https://github.com/adea-ai/control-plane/issues/653)) ([dd0dc7d](https://github.com/adea-ai/control-plane/commit/dd0dc7d271866f06f53361881a6fc908d6c17f7c))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.3.0...production-readiness-v1.3.1) (2026-09-20)


### Bug Fixes

* **contracts:** locale-independent canonicalJsonStringify + canonical-JSON divergence audit ([#611](https://github.com/adea-ai/control-plane/issues/611)) ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))


### Maintenance

* **contracts:** add canonicalJsonStringify and consolidate canonical-JSON digests ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.2.2...production-readiness-v1.3.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))
* split-eval-verdict-axes ([#570](https://github.com/adea-ai/control-plane/issues/570)) ([ad4f3f3](https://github.com/adea-ai/control-plane/commit/ad4f3f35fbf5e317d2d55dcc4e0bd60f4b4b756b))


### Documentation

* evals-recalibration-kit ([#572](https://github.com/adea-ai/control-plane/issues/572)) ([c7c7f27](https://github.com/adea-ai/control-plane/commit/c7c7f270e3ce87481c559a0df5493e35f6297bd8))
* **evals:** make the C4/SW-07 calibration scope explicitly verify-only ([#571](https://github.com/adea-ai/control-plane/issues/571)) ([017cf5a](https://github.com/adea-ai/control-plane/commit/017cf5a2f9734066aed26892c7f37dadbf52befd))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* acp-adapter-schema-split ([#573](https://github.com/adea-ai/control-plane/issues/573)) ([b7328fc](https://github.com/adea-ai/control-plane/commit/b7328fcce815e4619e9a52d86808f37e7243099a))
* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.2.2](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.2.1...production-readiness-v1.2.2) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.2.1](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.2.0...production-readiness-v1.2.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.2.0](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.1.3...production-readiness-v1.2.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.1.3](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.1.2...production-readiness-v1.1.3) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.1.2](https://github.com/adea-ai/control-plane/compare/production-readiness-v1.1.1...production-readiness-v1.1.2) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.1.1](https://github.com/0xPlayerOne/control-plane/compare/production-readiness-v1.1.0...production-readiness-v1.1.1) (2026-08-29)


### Bug Fixes

* **ci:** adopt Code Foundry v0.39.3 ([#288](https://github.com/0xPlayerOne/control-plane/issues/288)) ([43baeb9](https://github.com/0xPlayerOne/control-plane/commit/43baeb9049daa76f422d83ce611bd39d4636c6a6))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/production-readiness-v1.0.0...production-readiness-v1.1.0) (2026-08-29)


### Features

* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))
* **workflows:** migrate managed cloud runtime to Restate ([#220](https://github.com/0xPlayerOne/control-plane/issues/220)) ([99c85ee](https://github.com/0xPlayerOne/control-plane/commit/99c85ee71c382de6f597a7c08b79f9068ba7a5fb))
