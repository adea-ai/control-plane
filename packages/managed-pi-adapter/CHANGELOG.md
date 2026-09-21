# Changelog

## [1.5.3](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.5.2...managed-pi-adapter-v1.5.3) (2026-09-21)


### Maintenance

* **managed-pi-adapter:** split gateway.ts into focused gateway modules ([#630](https://github.com/adea-ai/control-plane/issues/630)) ([639acc0](https://github.com/adea-ai/control-plane/commit/639acc00a1f0abedea3e6fccc7e095832bdf9308))

## [1.5.2](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.5.1...managed-pi-adapter-v1.5.2) (2026-09-21)


### Maintenance

* **m612:** canonical-ordering guard, superseded-gap exemption, marker coverage ([#625](https://github.com/adea-ai/control-plane/issues/625)) ([64df3c5](https://github.com/adea-ai/control-plane/commit/64df3c5bd207683fc8ce3d5b829541126c71b269))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.5.0...managed-pi-adapter-v1.5.1) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.4.1...managed-pi-adapter-v1.5.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))
* m194-rpo-rto-events ([#557](https://github.com/adea-ai/control-plane/issues/557)) ([53f7e71](https://github.com/adea-ai/control-plane/commit/53f7e7162f1e3aa5b5dc2d5d05fee0ab1adb8ff8))


### Maintenance

* consolidate child-process RPC plumbing into ProcessRpcLink ([61331fd](https://github.com/adea-ai/control-plane/commit/61331fd6bcccaa2abe07bfaa3a049642d1666d97))
* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* **m13:** backoff consolidation, regression budgets, gateway schema hoist ([#579](https://github.com/adea-ai/control-plane/issues/579)) ([02f53f0](https://github.com/adea-ai/control-plane/commit/02f53f0904bb424bf3f83b0274991db999321b76))
* **m13:** consolidate child-process RPC plumbing into ProcessRpcLink ([#583](https://github.com/adea-ai/control-plane/issues/583)) ([61331fd](https://github.com/adea-ai/control-plane/commit/61331fd6bcccaa2abe07bfaa3a049642d1666d97))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.4.1](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.4.0...managed-pi-adapter-v1.4.1) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.3.2...managed-pi-adapter-v1.4.0) (2026-09-15)


### Features

* cprnode025-launch-wiring ([#504](https://github.com/adea-ai/control-plane/issues/504)) ([1c9bab2](https://github.com/adea-ai/control-plane/commit/1c9bab2858e6aa7ee06435edec353d1d7699dce6))

## [1.3.2](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.3.1...managed-pi-adapter-v1.3.2) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.3.0...managed-pi-adapter-v1.3.1) (2026-09-08)


### Tests

* **local:** certify native Pi cancellation through public API ([#432](https://github.com/adea-ai/control-plane/issues/432)) ([225056c](https://github.com/adea-ai/control-plane/commit/225056c3c3f6c450237453b90d61d4cb9ac73a44))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.2.2...managed-pi-adapter-v1.3.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.2.2](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.2.1...managed-pi-adapter-v1.2.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.2.1](https://github.com/adea-ai/control-plane/compare/managed-pi-adapter-v1.2.0...managed-pi-adapter-v1.2.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/managed-pi-adapter-v1.1.0...managed-pi-adapter-v1.2.0) (2026-08-30)


### Features

* **runtime:** add direct-local adapter transport ([#313](https://github.com/0xPlayerOne/control-plane/pull/313)) ([1fac8e1](https://github.com/0xPlayerOne/control-plane/commit/1fac8e13184ed661f1df4853d63ffde0f56a79b2))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/managed-pi-adapter-v1.0.0...managed-pi-adapter-v1.1.0) (2026-08-29)


### Features

* **runtime:** add managed Pi adapter ([#155](https://github.com/0xPlayerOne/control-plane/issues/155)) ([60b30e2](https://github.com/0xPlayerOne/control-plane/commit/60b30e29dc88568fa89297807953c7370f41895e))
* **runtime:** certify adapter compatibility ([#162](https://github.com/0xPlayerOne/control-plane/issues/162)) ([14403fd](https://github.com/0xPlayerOne/control-plane/commit/14403fdaa37a40d61f6e6bc7cd9e5a4f72de29bc)), closes [#50](https://github.com/0xPlayerOne/control-plane/issues/50)
* **runtime:** execute managed Pi through gateway ([#157](https://github.com/0xPlayerOne/control-plane/issues/157)) ([c705a8d](https://github.com/0xPlayerOne/control-plane/commit/c705a8da0d7e35720fbd522f3057eba1c67711be))
