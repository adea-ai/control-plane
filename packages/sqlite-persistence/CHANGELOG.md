# Changelog

## [1.20.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.19.0...sqlite-persistence-v1.20.0) (2026-09-25)


### Features

* **retention:** reapply the deletion journal to restored snapshots ([#712](https://github.com/adea-ai/control-plane/issues/712)) ([b491b02](https://github.com/adea-ai/control-plane/commit/b491b02893639343dc85d27a1bb257588bd66963))

## [1.19.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.18.0...sqlite-persistence-v1.19.0) (2026-09-25)


### Features

* **retention:** delete execution events with preserved identity ([#709](https://github.com/adea-ai/control-plane/issues/709)) ([a41dc81](https://github.com/adea-ai/control-plane/commit/a41dc8116387809e4898a39196c9a5bfa62fca6b))

## [1.18.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.17.0...sqlite-persistence-v1.18.0) (2026-09-25)


### Features

* **retention:** operator-invoked deletion for the command inbox ([#706](https://github.com/adea-ai/control-plane/issues/706)) ([5d4ee30](https://github.com/adea-ai/control-plane/commit/5d4ee30d96db9737482d700e1a6e0b3c212fe4c0))

## [1.17.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.16.0...sqlite-persistence-v1.17.0) (2026-09-25)


### Features

* **retention:** assess the execution-events class ([#704](https://github.com/adea-ai/control-plane/issues/704)) ([98d7ac1](https://github.com/adea-ai/control-plane/commit/98d7ac16ee9b6ceeead288cb997161761cdb44f1))

## [1.16.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.15.0...sqlite-persistence-v1.16.0) (2026-09-25)


### Features

* **retention:** authoritative eligibility predicate and assessment ([#702](https://github.com/adea-ai/control-plane/issues/702)) ([393b495](https://github.com/adea-ai/control-plane/commit/393b495f8d1a788402b734e9f1a7793e073eab17))

## [1.15.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.14.0...sqlite-persistence-v1.15.0) (2026-09-24)


### Features

* **retention:** record the decided policy and report retained candidates ([#700](https://github.com/adea-ai/control-plane/issues/700)) ([6f25316](https://github.com/adea-ai/control-plane/commit/6f253167f3a5a5f7e56f5a2b69ed8a5b41861cca))

## [1.14.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.13.0...sqlite-persistence-v1.14.0) (2026-09-24)


### Features

* **m11:** scoped operator CLI for catalog approval records ([#684](https://github.com/adea-ai/control-plane/issues/684)) ([f543722](https://github.com/adea-ai/control-plane/commit/f543722c048175c6b12da36a8619178d62a26dff))

## [1.13.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.12.2...sqlite-persistence-v1.13.0) (2026-09-24)


### Features

* **m11:** catalog version approval decisions as separate version-bound records ([#680](https://github.com/adea-ai/control-plane/issues/680)) ([332fa2b](https://github.com/adea-ai/control-plane/commit/332fa2b06660de0e07e5c4e0993d491cb45b84d0))

## [1.12.2](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.12.1...sqlite-persistence-v1.12.2) (2026-09-23)


### Maintenance

* **discovery:** consolidate the reconciliation projections into one shared implementation ([#677](https://github.com/adea-ai/control-plane/issues/677)) ([ce58d1b](https://github.com/adea-ai/control-plane/commit/ce58d1bd634f6f4424db4c76c56e807b54eff809))

## [1.12.1](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.12.0...sqlite-persistence-v1.12.1) (2026-09-22)


### Bug Fixes

* **m612:** frame hashes are versioned so pre-cutover receipts still replay ([#651](https://github.com/adea-ai/control-plane/issues/651)) ([fa51e8c](https://github.com/adea-ai/control-plane/commit/fa51e8c1bfc7249297a2c5608d103a179392e797))

## [1.12.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.11.3...sqlite-persistence-v1.12.0) (2026-09-22)


### Features

* **sqlite:** index expiry candidates and upgrade legacy backups ([#638](https://github.com/adea-ai/control-plane/issues/638)) ([7dc44bb](https://github.com/adea-ai/control-plane/commit/7dc44bbd247c3d0937fae215a744abafb39724ff))

## [1.11.3](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.11.2...sqlite-persistence-v1.11.3) (2026-09-22)


### Bug Fixes

* **retention:** contain unsafe deletion and drain scheduled cleanup ([#636](https://github.com/adea-ai/control-plane/issues/636)) ([7d1703e](https://github.com/adea-ai/control-plane/commit/7d1703e076224ef466086b515ea0c6190cb7ba96))

## [1.11.2](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.11.1...sqlite-persistence-v1.11.2) (2026-09-22)


### Bug Fixes

* **m612:** event-row payload hashes are now locale-independent; add harness docs ([#635](https://github.com/adea-ai/control-plane/issues/635)) ([62489ae](https://github.com/adea-ai/control-plane/commit/62489ae931c51285099cd3f4396ed7f5d8ecbc90))

## [1.11.1](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.11.0...sqlite-persistence-v1.11.1) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.11.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.10.1...sqlite-persistence-v1.11.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.10.1](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.10.0...sqlite-persistence-v1.10.1) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.10.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.9.1...sqlite-persistence-v1.10.0) (2026-09-16)


### Features

* **persistence:** add retention sweep primitive for evaluation runs ([#541](https://github.com/adea-ai/control-plane/issues/541)) ([89f6237](https://github.com/adea-ai/control-plane/commit/89f6237b969e844484f02d256db866fcb35a599f))

## [1.9.1](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.9.0...sqlite-persistence-v1.9.1) (2026-09-16)


### Maintenance

* reconciliation-command-shells ([#537](https://github.com/adea-ai/control-plane/issues/537)) ([90e25b6](https://github.com/adea-ai/control-plane/commit/90e25b6921d56fd2b23f240ffad828376a5da3cb))

## [1.9.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.8.0...sqlite-persistence-v1.9.0) (2026-09-15)


### Features

* **local:** wire the retention sweep into the local composition ([#528](https://github.com/adea-ai/control-plane/issues/528)) ([ef69e2e](https://github.com/adea-ai/control-plane/commit/ef69e2e795527a311ba20dcd5fd2450706bdf284))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.7.2...sqlite-persistence-v1.8.0) (2026-09-15)


### Features

* **persistence:** add retention sweep primitives for the command inbox ([#526](https://github.com/adea-ai/control-plane/issues/526)) ([03d2491](https://github.com/adea-ai/control-plane/commit/03d24910ef3b0f0bd201029171d6fd4df2c58956))

## [1.7.2](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.7.1...sqlite-persistence-v1.7.2) (2026-09-15)


### Maintenance

* **reconciliation:** share the lifecycle transition retry shells ([#524](https://github.com/adea-ai/control-plane/issues/524)) ([df1054f](https://github.com/adea-ai/control-plane/commit/df1054f794fe8172c728908b91c24289db678d7e))

## [1.7.1](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.7.0...sqlite-persistence-v1.7.1) (2026-09-15)


### Maintenance

* reconciliation-observe-domain ([#522](https://github.com/adea-ai/control-plane/issues/522)) ([3b837a2](https://github.com/adea-ai/control-plane/commit/3b837a2dad8f95fa1abd38cf9ce1cad30f652b08))
* **reconciliation:** extract observeRuntime into the domain module ([3b837a2](https://github.com/adea-ai/control-plane/commit/3b837a2dad8f95fa1abd38cf9ce1cad30f652b08))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.6.0...sqlite-persistence-v1.7.0) (2026-09-13)


### Features

* **events:** classify events and record provider read identity ([#481](https://github.com/adea-ai/control-plane/issues/481)) ([224da04](https://github.com/adea-ai/control-plane/commit/224da048e0b2bd6523abaa508a2862a417b32223))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.5.0...sqlite-persistence-v1.6.0) (2026-09-13)


### Features

* **domain:** compose the reconciliation observation projection ([#478](https://github.com/adea-ai/control-plane/issues/478)) ([8365442](https://github.com/adea-ai/control-plane/commit/83654422e64f98c25224570f871d8aa33983ca18))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.4.0...sqlite-persistence-v1.5.0) (2026-09-13)


### Features

* **context:** deliver and reconcile authenticated gateway commands ([#476](https://github.com/adea-ai/control-plane/issues/476)) ([d8d8074](https://github.com/adea-ai/control-plane/commit/d8d8074d1d05aa0523e206e5ffed18fe3452de95))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.3.1...sqlite-persistence-v1.4.0) (2026-09-12)


### Features

* **context:** add durable SQLite and PostgreSQL command ledgers ([#474](https://github.com/adea-ai/control-plane/issues/474)) ([2d5bff7](https://github.com/adea-ai/control-plane/commit/2d5bff76e5d77f38b56e6de9a3193810094e34fc))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.3.0...sqlite-persistence-v1.3.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.2.0...sqlite-persistence-v1.3.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.2.0](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.1.2...sqlite-persistence-v1.2.0) (2026-09-08)


### Features

* **m11:** add verified SQLite forward migration history ([#414](https://github.com/adea-ai/control-plane/issues/414)) ([293ad41](https://github.com/adea-ai/control-plane/commit/293ad418469ee356f7dbe4523c8bd6896f958f4f))
* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))


### Bug Fixes

* **m11:** preserve SQLite state on rejected migrations and record cloud evidence ([#413](https://github.com/adea-ai/control-plane/issues/413)) ([794e065](https://github.com/adea-ai/control-plane/commit/794e065a8db20af4db25c7f07ef42f67e7129385))

## [1.1.2](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.1.1...sqlite-persistence-v1.1.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.1.1](https://github.com/adea-ai/control-plane/compare/sqlite-persistence-v1.1.0...sqlite-persistence-v1.1.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/sqlite-persistence-v1.0.0...sqlite-persistence-v1.1.0) (2026-08-30)


### Features

* **portability:** add embedded SQLite persistence ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
