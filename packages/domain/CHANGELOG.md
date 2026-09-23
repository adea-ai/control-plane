# Changelog

## [1.11.7](https://github.com/adea-ai/control-plane/compare/domain-v1.11.6...domain-v1.11.7) (2026-09-23)


### Maintenance

* **discovery:** consolidate the reconciliation projections into one shared implementation ([#677](https://github.com/adea-ai/control-plane/issues/677)) ([ce58d1b](https://github.com/adea-ai/control-plane/commit/ce58d1bd634f6f4424db4c76c56e807b54eff809))

## [1.11.6](https://github.com/adea-ai/control-plane/compare/domain-v1.11.5...domain-v1.11.6) (2026-09-23)


### Bug Fixes

* **m612:** final canonical-JSON sites migrated; no localeCompare remains ([#666](https://github.com/adea-ai/control-plane/issues/666)) ([d7dd600](https://github.com/adea-ai/control-plane/commit/d7dd6001343aa2702f1cfb0f36aa96d79aaeb464))

## [1.11.5](https://github.com/adea-ai/control-plane/compare/domain-v1.11.4...domain-v1.11.5) (2026-09-22)


### Bug Fixes

* **m612:** project-state and delegation digests dual-accept both canonical forms ([#659](https://github.com/adea-ai/control-plane/issues/659)) ([97a8612](https://github.com/adea-ai/control-plane/commit/97a86123929f972ea87ba5d9dbafa198b407cb41))

## [1.11.4](https://github.com/adea-ai/control-plane/compare/domain-v1.11.3...domain-v1.11.4) (2026-09-22)


### Bug Fixes

* **m612:** context command envelopes verify under both canonical forms ([#655](https://github.com/adea-ai/control-plane/issues/655)) ([15a786d](https://github.com/adea-ai/control-plane/commit/15a786de538c38bc4799008f7207559093b026c0))

## [1.11.3](https://github.com/adea-ai/control-plane/compare/domain-v1.11.2...domain-v1.11.3) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.11.2](https://github.com/adea-ai/control-plane/compare/domain-v1.11.1...domain-v1.11.2) (2026-09-20)


### Bug Fixes

* **contracts:** locale-independent canonicalJsonStringify + canonical-JSON divergence audit ([#611](https://github.com/adea-ai/control-plane/issues/611)) ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))


### Maintenance

* **contracts:** add canonicalJsonStringify and consolidate canonical-JSON digests ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))

## [1.11.1](https://github.com/adea-ai/control-plane/compare/domain-v1.11.0...domain-v1.11.1) (2026-09-20)


### Maintenance

* **m405:** consolidate the duplicated withTimeout race into domain ([#609](https://github.com/adea-ai/control-plane/issues/609)) ([b6af3d5](https://github.com/adea-ai/control-plane/commit/b6af3d5d60546bf094ff015560469bb987b6e5b5))

## [1.11.0](https://github.com/adea-ai/control-plane/compare/domain-v1.10.4...domain-v1.11.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* **m13:** backoff consolidation, regression budgets, gateway schema hoist ([#579](https://github.com/adea-ai/control-plane/issues/579)) ([02f53f0](https://github.com/adea-ai/control-plane/commit/02f53f0904bb424bf3f83b0274991db999321b76))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.10.4](https://github.com/adea-ai/control-plane/compare/domain-v1.10.3...domain-v1.10.4) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.10.3](https://github.com/adea-ai/control-plane/compare/domain-v1.10.2...domain-v1.10.3) (2026-09-16)


### Maintenance

* reconciliation-command-shells ([#537](https://github.com/adea-ai/control-plane/issues/537)) ([90e25b6](https://github.com/adea-ai/control-plane/commit/90e25b6921d56fd2b23f240ffad828376a5da3cb))

## [1.10.2](https://github.com/adea-ai/control-plane/compare/domain-v1.10.1...domain-v1.10.2) (2026-09-15)


### Maintenance

* **reconciliation:** share the lifecycle transition retry shells ([#524](https://github.com/adea-ai/control-plane/issues/524)) ([df1054f](https://github.com/adea-ai/control-plane/commit/df1054f794fe8172c728908b91c24289db678d7e))

## [1.10.1](https://github.com/adea-ai/control-plane/compare/domain-v1.10.0...domain-v1.10.1) (2026-09-15)


### Maintenance

* reconciliation-observe-domain ([#522](https://github.com/adea-ai/control-plane/issues/522)) ([3b837a2](https://github.com/adea-ai/control-plane/commit/3b837a2dad8f95fa1abd38cf9ce1cad30f652b08))
* **reconciliation:** extract observeRuntime into the domain module ([3b837a2](https://github.com/adea-ai/control-plane/commit/3b837a2dad8f95fa1abd38cf9ce1cad30f652b08))

## [1.10.0](https://github.com/adea-ai/control-plane/compare/domain-v1.9.0...domain-v1.10.0) (2026-09-13)


### Features

* **domain:** carry correlation on runtime command records ([#484](https://github.com/adea-ai/control-plane/issues/484)) ([03c74da](https://github.com/adea-ai/control-plane/commit/03c74dadae2dd26a3a8b030fcc5f0a1595bb7b46))

## [1.9.0](https://github.com/adea-ai/control-plane/compare/domain-v1.8.0...domain-v1.9.0) (2026-09-13)


### Features

* **context:** deliver and reconcile authenticated gateway commands ([#476](https://github.com/adea-ai/control-plane/issues/476)) ([d8d8074](https://github.com/adea-ai/control-plane/commit/d8d8074d1d05aa0523e206e5ffed18fe3452de95))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/domain-v1.7.1...domain-v1.8.0) (2026-09-12)


### Features

* **context:** add durable SQLite and PostgreSQL command ledgers ([#474](https://github.com/adea-ai/control-plane/issues/474)) ([2d5bff7](https://github.com/adea-ai/control-plane/commit/2d5bff76e5d77f38b56e6de9a3193810094e34fc))

## [1.7.1](https://github.com/adea-ai/control-plane/compare/domain-v1.7.0...domain-v1.7.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/domain-v1.6.0...domain-v1.7.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/domain-v1.5.2...domain-v1.6.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))

## [1.5.2](https://github.com/adea-ai/control-plane/compare/domain-v1.5.1...domain-v1.5.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/domain-v1.5.0...domain-v1.5.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.5.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.4.0...domain-v1.5.0) (2026-08-29)


### Features

* **catalog:** finalize profile and skill resolution ([#223](https://github.com/0xPlayerOne/control-plane/issues/223)) ([aeff4ff](https://github.com/0xPlayerOne/control-plane/commit/aeff4ff5d78f39cb6a8d5b38e37f05c57354fb6c))
* **database:** persist project state ([659fc9b](https://github.com/0xPlayerOne/control-plane/commit/659fc9b20883267ab9f971c21b9ecfdcce144037))
* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))
* **workflow-worker:** persist cloud execution lifecycle ([79b9bfe](https://github.com/0xPlayerOne/control-plane/commit/79b9bfe203a91193c2457c3e3357f6bc100090fd))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.3.0...domain-v1.4.0) (2026-08-25)


### Features

* **orchestration:** coordinate parallel delegation ([#183](https://github.com/0xPlayerOne/control-plane/issues/183)) ([21e383b](https://github.com/0xPlayerOne/control-plane/commit/21e383ba2492cbd92f72c96adcc1f5ab89c4a2d7))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.2.0...domain-v1.3.0) (2026-08-25)


### Features

* **gateway:** persist runtime command delivery ([#139](https://github.com/0xPlayerOne/control-plane/issues/139)) ([1874f27](https://github.com/0xPlayerOne/control-plane/commit/1874f27edbd925b7ba5f9f74d26cc53719758f8b))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.1.0...domain-v1.2.0) (2026-08-24)


### Features

* **runtime:** route eligible runtimes deterministically ([#121](https://github.com/0xPlayerOne/control-plane/issues/121)) ([9f7a0fd](https://github.com/0xPlayerOne/control-plane/commit/9f7a0fd74e179dd592d9727ae49bc222b99251d8))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/domain-v1.0.0...domain-v1.1.0) (2026-08-24)


### Features

* **execution:** add durable execution lifecycle ([#105](https://github.com/0xPlayerOne/control-plane/issues/105)) ([4429d4d](https://github.com/0xPlayerOne/control-plane/commit/4429d4da040e785ef566db8136d5b21c42ac30d7)), closes [#20](https://github.com/0xPlayerOne/control-plane/issues/20)
* **execution:** add durable interaction lifecycle ([#112](https://github.com/0xPlayerOne/control-plane/issues/112)) ([83a3bb6](https://github.com/0xPlayerOne/control-plane/commit/83a3bb6fcec8969bcb78dfa4bbbc167a5fe767c0))
* **execution:** add idempotent command acceptance ([#109](https://github.com/0xPlayerOne/control-plane/issues/109)) ([bd096fb](https://github.com/0xPlayerOne/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/0xPlayerOne/control-plane/issues/21)
* **reliability:** reconcile unknown execution outcomes ([#114](https://github.com/0xPlayerOne/control-plane/issues/114)) ([2cbd07b](https://github.com/0xPlayerOne/control-plane/commit/2cbd07b8747925560a90fa3eaad057d0ffbdf4ee))

## 1.0.0 (2026-08-24)


### Features

* add immutable AgentProfile and Skill versions ([#90](https://github.com/0xPlayerOne/control-plane/issues/90)) ([f09d6fd](https://github.com/0xPlayerOne/control-plane/commit/f09d6fded7abad1429b805d7c1248bf4627ca8ae))
* add revisioned project state ([#93](https://github.com/0xPlayerOne/control-plane/issues/93)) ([4f3e7ac](https://github.com/0xPlayerOne/control-plane/commit/4f3e7ac04b18eed869fbc3d02f8506b676014e62))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* define execution constraint contracts ([#92](https://github.com/0xPlayerOne/control-plane/issues/92)) ([6945676](https://github.com/0xPlayerOne/control-plane/commit/694567609c5b6b9123622446e528c5298d34e4ad))
