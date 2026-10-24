# Changelog

## [1.6.3](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.6.2...model-gateway-v1.6.3) (2026-10-24)


### Bug Fixes

* reduce dependency closure and preserve budget checks ([#1270](https://github.com/adea-ai/control-plane/issues/1270)) ([01fa230](https://github.com/adea-ai/control-plane/commit/01fa230233cc796b6c7f93d020006212b89631f6))

## [1.6.2](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.6.1...model-gateway-v1.6.2) (2026-10-21)


### Tests

* **model-gateway:** prove the BYO eligibility rules independently ([f1bd75c](https://github.com/adea-ai/control-plane/commit/f1bd75c5877f31b809c42b8aa43e2d5b08e3ad14))
* **model-gateway:** prove the BYO eligibility rules independently (CP [#931](https://github.com/adea-ai/control-plane/issues/931)) ([#1225](https://github.com/adea-ai/control-plane/issues/1225)) ([f1bd75c](https://github.com/adea-ai/control-plane/commit/f1bd75c5877f31b809c42b8aa43e2d5b08e3ad14))

## [1.6.1](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.6.0...model-gateway-v1.6.1) (2026-10-17)


### Maintenance

* **tooling:** replace Control Plane Turbo with Vite+ and Bun checks ([#1170](https://github.com/adea-ai/control-plane/issues/1170)) ([84e12db](https://github.com/adea-ai/control-plane/commit/84e12dbab1b2fea2380e8747a466db9fb1449959))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.5.3...model-gateway-v1.6.0) (2026-10-16)


### Features

* **models:** surface BYO lead model readiness and recheck it at every boundary ([#1159](https://github.com/adea-ai/control-plane/issues/1159)) ([83265a6](https://github.com/adea-ai/control-plane/commit/83265a66057006b0ce44f5b24959f871de84e394))

## [1.5.3](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.5.2...model-gateway-v1.5.3) (2026-10-14)


### Bug Fixes

* **persistence:** fence allocation and recovery metadata read scopes ([#1116](https://github.com/adea-ai/control-plane/issues/1116)) ([082c2c3](https://github.com/adea-ai/control-plane/commit/082c2c33ccd57aeb555c17d5d88b83d9c9e6d3e0))

## [1.5.2](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.5.1...model-gateway-v1.5.2) (2026-10-11)


### Bug Fixes

* **control-api:** pin production BYO model eligibility to the Pi catalog ([#1079](https://github.com/adea-ai/control-plane/issues/1079)) ([fceb920](https://github.com/adea-ai/control-plane/commit/fceb920bc1b7401385f6e1b23b0e4a66f365a740)), refs [#931](https://github.com/adea-ai/control-plane/issues/931) (remaining scope is open)

## [1.5.1](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.5.0...model-gateway-v1.5.1) (2026-10-10)


### Tests

* **models:** qualify confirmed funding at inference boundaries ([#970](https://github.com/adea-ai/control-plane/issues/970)) ([5ee3dbf](https://github.com/adea-ai/control-plane/commit/5ee3dbf06f9a85bcb63ac29bdb13aecfeeac9a4a))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.4.0...model-gateway-v1.5.0) (2026-10-08)


### Features

* **models:** retain Pi lead payer confirmation across send boundaries ([#962](https://github.com/adea-ai/control-plane/issues/962)) ([8135624](https://github.com/adea-ai/control-plane/commit/813562406f26259027154a40e8566ebbe5a797ab))


### Bug Fixes

* **models:** break funding authorization import cycle ([#965](https://github.com/adea-ai/control-plane/issues/965)) ([e7ac922](https://github.com/adea-ai/control-plane/commit/e7ac922b0e42b91b11f5557a9df1195ed6d9c090))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.3.0...model-gateway-v1.4.0) (2026-10-08)


### Features

* **models:** bind current execution authority and recorded payer reads ([#957](https://github.com/adea-ai/control-plane/issues/957)) ([85449ba](https://github.com/adea-ai/control-plane/commit/85449baf3ea9c57997954246bf40a7e4d5589312))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.2.4...model-gateway-v1.3.0) (2026-10-08)


### Features

* **models:** add pinned BYO model connections and selection ([#948](https://github.com/adea-ai/control-plane/issues/948)) ([465aa72](https://github.com/adea-ai/control-plane/commit/465aa72870b5dccdba8adb32b0caeb261f74518c))

## [1.2.4](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.2.3...model-gateway-v1.2.4) (2026-10-08)


### Bug Fixes

* **runtime:** route native Pi through ledger-backed model broker ([#934](https://github.com/adea-ai/control-plane/issues/934)) ([2780e4c](https://github.com/adea-ai/control-plane/commit/2780e4c364dbb634b6196f499d58cbbfdc578fb0))

## [1.2.3](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.2.2...model-gateway-v1.2.3) (2026-10-01)


### Bug Fixes

* **deps:** update external non-major dependencies ([#802](https://github.com/adea-ai/control-plane/issues/802)) ([76aafec](https://github.com/adea-ai/control-plane/commit/76aafec17902426c55e782e210d90d6e5aa7370a))

## [1.2.2](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.2.1...model-gateway-v1.2.2) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.2.1](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.2.0...model-gateway-v1.2.1) (2026-09-20)


### Maintenance

* **m405:** consolidate the duplicated withTimeout race into domain ([#609](https://github.com/adea-ai/control-plane/issues/609)) ([b6af3d5](https://github.com/adea-ai/control-plane/commit/b6af3d5d60546bf094ff015560469bb987b6e5b5))

## [1.2.0](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.1.4...model-gateway-v1.2.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.1.4](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.1.3...model-gateway-v1.1.4) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.1.3](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.1.2...model-gateway-v1.1.3) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.1.2](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.1.1...model-gateway-v1.1.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.1.1](https://github.com/adea-ai/control-plane/compare/model-gateway-v1.1.0...model-gateway-v1.1.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/model-gateway-v1.0.0...model-gateway-v1.1.0) (2026-08-29)


### Features

* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))
* **models:** add deterministic routing ([#171](https://github.com/0xPlayerOne/control-plane/issues/171)) ([8488549](https://github.com/0xPlayerOne/control-plane/commit/84885491de46ba990cff8e8a5ebaf0bb70c68c33))
* **models:** add managed model gateway ([#170](https://github.com/0xPlayerOne/control-plane/issues/170)) ([b73fce3](https://github.com/0xPlayerOne/control-plane/commit/b73fce3f48bceaf18ea8e08d2bf17eda152aeabd))
