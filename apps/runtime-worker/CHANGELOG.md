# Changelog

## [1.8.3](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.8.2...runtime-worker-v1.8.3) (2026-09-23)


### Bug Fixes

* **m612:** final canonical-JSON sites migrated; no localeCompare remains ([#666](https://github.com/adea-ai/control-plane/issues/666)) ([d7dd600](https://github.com/adea-ai/control-plane/commit/d7dd6001343aa2702f1cfb0f36aa96d79aaeb464))

## [1.8.2](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.8.1...runtime-worker-v1.8.2) (2026-09-21)


### Maintenance

* **runtime-worker:** split hosted-managed-pi.ts into focused modules ([#632](https://github.com/adea-ai/control-plane/issues/632)) ([280ec72](https://github.com/adea-ai/control-plane/commit/280ec729321b11436f169c79ceb8091b2a00b8c9))

## [1.8.1](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.8.0...runtime-worker-v1.8.1) (2026-09-20)


### Bug Fixes

* **contracts:** locale-independent canonicalJsonStringify + canonical-JSON divergence audit ([#611](https://github.com/adea-ai/control-plane/issues/611)) ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))


### Maintenance

* **contracts:** add canonicalJsonStringify and consolidate canonical-JSON digests ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.7.2...runtime-worker-v1.8.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.7.2](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.7.1...runtime-worker-v1.7.2) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.7.1](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.7.0...runtime-worker-v1.7.1) (2026-09-13)


### Bug Fixes

* **runtime-worker:** recover commands whose dispatch lost its channel ([#487](https://github.com/adea-ai/control-plane/issues/487)) ([358857c](https://github.com/adea-ai/control-plane/commit/358857c793c0ef6587ae4945a41cc37aca155574))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.6.1...runtime-worker-v1.7.0) (2026-09-13)


### Features

* **context:** deliver and reconcile authenticated gateway commands ([#476](https://github.com/adea-ai/control-plane/issues/476)) ([d8d8074](https://github.com/adea-ai/control-plane/commit/d8d8074d1d05aa0523e206e5ffed18fe3452de95))

## [1.6.1](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.6.0...runtime-worker-v1.6.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.5.0...runtime-worker-v1.6.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.4.2...runtime-worker-v1.5.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.4.2](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.4.1...runtime-worker-v1.4.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.4.1](https://github.com/adea-ai/control-plane/compare/runtime-worker-v1.4.0...runtime-worker-v1.4.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-worker-v1.3.0...runtime-worker-v1.4.0) (2026-08-30)


### Features

* **runtime:** certify the direct-local adapter transport chain ([#313](https://github.com/0xPlayerOne/control-plane/pull/313)) ([1fac8e1](https://github.com/0xPlayerOne/control-plane/commit/1fac8e13184ed661f1df4853d63ffde0f56a79b2))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-worker-v1.2.0...runtime-worker-v1.3.0) (2026-08-29)


### Features

* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/0xPlayerOne/control-plane/issues/222)) ([e6aa0f1](https://github.com/0xPlayerOne/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-worker-v1.1.0...runtime-worker-v1.2.0) (2026-08-25)


### Features

* **runtime:** add hosted managed Pi worker ([#158](https://github.com/0xPlayerOne/control-plane/issues/158)) ([39e3943](https://github.com/0xPlayerOne/control-plane/commit/39e39438dcc489b665a388cb918ee843bf2cd8bb))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/runtime-worker-v1.0.0...runtime-worker-v1.1.0) (2026-08-25)


### Features

* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* **foundation:** add M1 acceptance baseline ([#87](https://github.com/0xPlayerOne/control-plane/issues/87)) ([bba3f0e](https://github.com/0xPlayerOne/control-plane/commit/bba3f0eea1fb77a20c51e468d34bf629a67fdfe2))


### Maintenance

* release main ([d081764](https://github.com/0xPlayerOne/control-plane/commit/d081764aae773a9430e883b675253fbba3d69603))

## 1.0.0 (2026-08-24)


### Features

* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* **foundation:** add M1 acceptance baseline ([#87](https://github.com/0xPlayerOne/control-plane/issues/87)) ([bba3f0e](https://github.com/0xPlayerOne/control-plane/commit/bba3f0eea1fb77a20c51e468d34bf629a67fdfe2))
