# Changelog

## [1.9.3](https://github.com/adea-ai/control-plane/compare/context-v1.9.2...context-v1.9.3) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.9.2](https://github.com/adea-ai/control-plane/compare/context-v1.9.1...context-v1.9.2) (2026-09-20)


### Bug Fixes

* **contracts:** locale-independent canonicalJsonStringify + canonical-JSON divergence audit ([#611](https://github.com/adea-ai/control-plane/issues/611)) ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))


### Maintenance

* **contracts:** add canonicalJsonStringify and consolidate canonical-JSON digests ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))

## [1.9.1](https://github.com/adea-ai/control-plane/compare/context-v1.9.0...context-v1.9.1) (2026-09-20)


### Maintenance

* **m405:** consolidate the duplicated withTimeout race into domain ([#609](https://github.com/adea-ai/control-plane/issues/609)) ([b6af3d5](https://github.com/adea-ai/control-plane/commit/b6af3d5d60546bf094ff015560469bb987b6e5b5))

## [1.9.0](https://github.com/adea-ai/control-plane/compare/context-v1.8.1...context-v1.9.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.8.1](https://github.com/adea-ai/control-plane/compare/context-v1.8.0...context-v1.8.1) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/context-v1.7.0...context-v1.8.0) (2026-09-13)


### Features

* **context:** add bounded failure metadata to provider errors ([#489](https://github.com/adea-ai/control-plane/issues/489)) ([264aac6](https://github.com/adea-ai/control-plane/commit/264aac617dd35acbd19f8307596c9e1bd306b1d0))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/context-v1.6.0...context-v1.7.0) (2026-09-13)


### Features

* **events:** classify events and record provider read identity ([#481](https://github.com/adea-ai/control-plane/issues/481)) ([224da04](https://github.com/adea-ai/control-plane/commit/224da048e0b2bd6523abaa508a2862a417b32223))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/context-v1.5.1...context-v1.6.0) (2026-09-13)


### Features

* **context:** deliver and reconcile authenticated gateway commands ([#476](https://github.com/adea-ai/control-plane/issues/476)) ([d8d8074](https://github.com/adea-ai/control-plane/commit/d8d8074d1d05aa0523e206e5ffed18fe3452de95))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/context-v1.5.0...context-v1.5.1) (2026-09-12)


### Bug Fixes

* **context:** require authorized RuntimeNode read bindings ([#472](https://github.com/adea-ai/control-plane/issues/472)) ([b553821](https://github.com/adea-ai/control-plane/commit/b553821e06a4a52367120be5913bddbee3c06798))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/context-v1.4.2...context-v1.5.0) (2026-09-12)


### Features

* integrate M11 provider authoring and native build fixes ([#470](https://github.com/adea-ai/control-plane/issues/470)) ([b195736](https://github.com/adea-ai/control-plane/commit/b195736c2fa5154b43dd82deeaa7fc1c26326f71))

## [1.4.2](https://github.com/adea-ai/control-plane/compare/context-v1.4.1...context-v1.4.2) (2026-09-12)


### Bug Fixes

* **context:** bind contribution cache to execution location ([#460](https://github.com/adea-ai/control-plane/issues/460)) ([5191016](https://github.com/adea-ai/control-plane/commit/51910164c8dd63761243d899042ba05fed424b7a))

## [1.4.1](https://github.com/adea-ai/control-plane/compare/context-v1.4.0...context-v1.4.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/context-v1.3.2...context-v1.4.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.3.2](https://github.com/adea-ai/control-plane/compare/context-v1.3.1...context-v1.3.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/context-v1.3.0...context-v1.3.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/context-v1.2.0...context-v1.3.0) (2026-08-29)


### Features

* **context:** finalize deterministic provider selection ([#224](https://github.com/0xPlayerOne/control-plane/issues/224)) ([b0c17d5](https://github.com/0xPlayerOne/control-plane/commit/b0c17d5185b12137c12c8f0a251ebb196b6a9350))
* **context:** finalize provider selection and cache policy ([b0c17d5](https://github.com/0xPlayerOne/control-plane/commit/b0c17d5185b12137c12c8f0a251ebb196b6a9350))
* **database:** persist context packages ([30e3f81](https://github.com/0xPlayerOne/control-plane/commit/30e3f81527de595ad2235fcd5cfa46f5a80d149b))


### Bug Fixes

* **context:** complete deterministic provider ranking ([#229](https://github.com/0xPlayerOne/control-plane/issues/229)) ([528a48d](https://github.com/0xPlayerOne/control-plane/commit/528a48d34eff1099cadba521ba1638d0c581167b))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/context-v1.1.0...context-v1.2.0) (2026-08-25)


### Features

* **context:** add Cortana-compatible adapter ([#176](https://github.com/0xPlayerOne/control-plane/issues/176)) ([27409c1](https://github.com/0xPlayerOne/control-plane/commit/27409c1b80fdfa45dd644b797f4449e2942e8aef))
* **context:** add optional provider framework ([#175](https://github.com/0xPlayerOne/control-plane/issues/175)) ([efa12ce](https://github.com/0xPlayerOne/control-plane/commit/efa12ce6cb43796809e2df58bf3c04fcb024a53a))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/context-v1.0.0...context-v1.1.0) (2026-08-25)


### Features

* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* compile reproducible context packages ([#94](https://github.com/0xPlayerOne/control-plane/issues/94)) ([488f5c5](https://github.com/0xPlayerOne/control-plane/commit/488f5c5556fc0a59f7793c01e1be3c3f3ae679d2))


### Maintenance

* release main ([d081764](https://github.com/0xPlayerOne/control-plane/commit/d081764aae773a9430e883b675253fbba3d69603))

## 1.0.0 (2026-08-24)


### Features

* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* compile reproducible context packages ([#94](https://github.com/0xPlayerOne/control-plane/issues/94)) ([488f5c5](https://github.com/0xPlayerOne/control-plane/commit/488f5c5556fc0a59f7793c01e1be3c3f3ae679d2))
