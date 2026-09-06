# Changelog

## [1.8.3](https://github.com/adea-ai/control-plane/compare/workspace-v1.8.2...workspace-v1.8.3) (2026-09-06)


### Maintenance

* brand-adea2 ([#378](https://github.com/adea-ai/control-plane/issues/378)) ([4f7b4fd](https://github.com/adea-ai/control-plane/commit/4f7b4fd3fc60134ebe084954148cb0a3b416a4ac))
* **ci:** bump repository consistency pins to code-foundry v1.0.0 ([79848e6](https://github.com/adea-ai/control-plane/commit/79848e671ff5eccad7f0246682a78d5af9f7c869))
* **ci:** upgrade code-foundry runtime to v1.0.0 ([5a86bfd](https://github.com/adea-ai/control-plane/commit/5a86bfdf6bd7169eace14123d3dd31f98b251e2b))

## [1.8.2](https://github.com/adea-ai/control-plane/compare/workspace-v1.8.1...workspace-v1.8.2) (2026-09-05)


### Maintenance

* **infra:** align Neon branch names with Railway environment names ([#368](https://github.com/adea-ai/control-plane/issues/368)) ([fb698a2](https://github.com/adea-ai/control-plane/commit/fb698a2f86d2cf6a3e5b9ceaf0938c55d573c204))

## [1.8.1](https://github.com/adea-ai/control-plane/compare/workspace-v1.8.0...workspace-v1.8.1) (2026-09-05)


### Bug Fixes

* **ci:** assert live workspace-manifest consistency in audit test ([#363](https://github.com/adea-ai/control-plane/issues/363)) ([7050b92](https://github.com/adea-ai/control-plane/commit/7050b92fe6f51a26eabce1e5fdc757818535d940))
* **ci:** ignore release-owned versions in architecture package drift check ([#361](https://github.com/adea-ai/control-plane/issues/361)) ([11e9f45](https://github.com/adea-ai/control-plane/commit/11e9f45c248313e6b28dfe1c61a0dd59ecf68043))


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.8.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.7.5...workspace-v1.8.0) (2026-08-30)


### Features

* **portability:** add local control plane foundation ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **hosted:** ship Compose deployment profiles ([#311](https://github.com/0xPlayerOne/control-plane/pull/311)) ([2a4de56](https://github.com/0xPlayerOne/control-plane/commit/2a4de56d6e352155cf42c0b44302241f1b92442a))
* **relay:** add encrypted remote control ([#312](https://github.com/0xPlayerOne/control-plane/pull/312)) ([09cebc6](https://github.com/0xPlayerOne/control-plane/commit/09cebc6341dbd8f3768d43d8b1318d2481f3cc85))
* **runtime:** add the direct-local adapter transport chain ([#313](https://github.com/0xPlayerOne/control-plane/pull/313)) ([1fac8e1](https://github.com/0xPlayerOne/control-plane/commit/1fac8e13184ed661f1df4853d63ffde0f56a79b2))
* **remote-control:** complete encrypted relay delivery ([#314](https://github.com/0xPlayerOne/control-plane/pull/314)) ([4d275ca](https://github.com/0xPlayerOne/control-plane/commit/4d275ca711a3bbeb5fdb3ab75cbd6469aab0ff6d))
* **portability:** add profile conformance and migration tooling ([#315](https://github.com/0xPlayerOne/control-plane/pull/315)) ([fefdba2](https://github.com/0xPlayerOne/control-plane/commit/fefdba2c454e99f7bbd73c14f25a08941286342a))
* **portability:** complete the PostgreSQL profile migration adapter ([#316](https://github.com/0xPlayerOne/control-plane/pull/316)) ([1ae4b9f](https://github.com/0xPlayerOne/control-plane/commit/1ae4b9f2de1d0c3f0e73255b9db6aeade24b6426))
* **operations:** complete M10 local and hosted hardening ([#317](https://github.com/0xPlayerOne/control-plane/pull/317)) ([af22ead](https://github.com/0xPlayerOne/control-plane/commit/af22eade12e70d5de982f385e0747862f5b39c7c))

## [1.7.5](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.7.4...workspace-v1.7.5) (2026-08-29)


### Bug Fixes

* **worker:** keep disabled cloud runtime healthy ([#305](https://github.com/0xPlayerOne/control-plane/issues/305)) ([85d32ce](https://github.com/0xPlayerOne/control-plane/commit/85d32ceb58370b2d3158293acc5f93eb64a2c162))

## [1.7.4](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.7.3...workspace-v1.7.4) (2026-08-29)


### Bug Fixes

* **railway:** harden Restate runtime limits ([#300](https://github.com/0xPlayerOne/control-plane/issues/300)) ([8c2c820](https://github.com/0xPlayerOne/control-plane/commit/8c2c820a1a683bb8cb7502723bf4ed2215e0cc8f))

## [1.7.3](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.7.2...workspace-v1.7.3) (2026-08-29)


### Bug Fixes

* **railway:** enforce production topology parity ([#295](https://github.com/0xPlayerOne/control-plane/issues/295)) ([ebc1e26](https://github.com/0xPlayerOne/control-plane/commit/ebc1e26525760f9571c93c751234638bbb270d8b))

## [1.7.2](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.7.1...workspace-v1.7.2) (2026-08-29)


### Bug Fixes

* **ci:** adopt Code Foundry v0.39.0 ([6c21667](https://github.com/0xPlayerOne/control-plane/commit/6c216678e93721da111832c6e2c6b98b08e632f1))
* **ci:** adopt Code Foundry v0.39.3 ([#288](https://github.com/0xPlayerOne/control-plane/issues/288)) ([43baeb9](https://github.com/0xPlayerOne/control-plane/commit/43baeb9049daa76f422d83ce611bd39d4636c6a6))
* **ci:** adopt Code Foundry v0.39.4 ([#290](https://github.com/0xPlayerOne/control-plane/issues/290)) ([60e94d3](https://github.com/0xPlayerOne/control-plane/commit/60e94d35799a716d0d152dd3141ccbcf1dc8794e))


### Maintenance

* release main ([a304ac8](https://github.com/0xPlayerOne/control-plane/commit/a304ac8e1855a59800ebdfdb23cd0e00cee03d44))

## [1.7.1](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.7.0...workspace-v1.7.1) (2026-08-29)


### Bug Fixes

* **ci:** adopt Code Foundry v0.38.2 ([#280](https://github.com/0xPlayerOne/control-plane/issues/280)) ([d1e8917](https://github.com/0xPlayerOne/control-plane/commit/d1e89177446ffd132e868e6860ccddcb1e9c9a8a))
* **ci:** adopt Code Foundry v0.39.0 ([6c21667](https://github.com/0xPlayerOne/control-plane/commit/6c216678e93721da111832c6e2c6b98b08e632f1))
* **ci:** adopt Code Foundry v0.39.3 ([#288](https://github.com/0xPlayerOne/control-plane/issues/288)) ([43baeb9](https://github.com/0xPlayerOne/control-plane/commit/43baeb9049daa76f422d83ce611bd39d4636c6a6))
* **ci:** adopt Code Foundry v0.39.4 ([#290](https://github.com/0xPlayerOne/control-plane/issues/290)) ([60e94d3](https://github.com/0xPlayerOne/control-plane/commit/60e94d35799a716d0d152dd3141ccbcf1dc8794e))


### Maintenance

* release main ([0a9019b](https://github.com/0xPlayerOne/control-plane/commit/0a9019bd9eca95083983a9d246911c9425680145))

## [1.7.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.6.0...workspace-v1.7.0) (2026-08-29)


### Features

* **bootstrap:** expose managed cloud startup config ([#235](https://github.com/0xPlayerOne/control-plane/issues/235)) ([d07654b](https://github.com/0xPlayerOne/control-plane/commit/d07654be42b893a82bbd87ad3a14b848b728191e))
* **catalog:** finalize profile and skill resolution ([#223](https://github.com/0xPlayerOne/control-plane/issues/223)) ([aeff4ff](https://github.com/0xPlayerOne/control-plane/commit/aeff4ff5d78f39cb6a8d5b38e37f05c57354fb6c))
* **context:** finalize deterministic provider selection ([#224](https://github.com/0xPlayerOne/control-plane/issues/224)) ([b0c17d5](https://github.com/0xPlayerOne/control-plane/commit/b0c17d5185b12137c12c8f0a251ebb196b6a9350))
* **context:** finalize provider selection and cache policy ([b0c17d5](https://github.com/0xPlayerOne/control-plane/commit/b0c17d5185b12137c12c8f0a251ebb196b6a9350))
* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/0xPlayerOne/control-plane/issues/222)) ([e6aa0f1](https://github.com/0xPlayerOne/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))
* **control-api:** accept cloud executions ([242f599](https://github.com/0xPlayerOne/control-plane/commit/242f59960b24b7355f88bf1eda6343f14ed5c5f0))
* **control-api:** compose managed cloud startup ([a99ef72](https://github.com/0xPlayerOne/control-plane/commit/a99ef727554463834ee10c7651158da6bc7ce848))
* **control-api:** validate execution requests ([3ab0636](https://github.com/0xPlayerOne/control-plane/commit/3ab0636aeba30f15676fd09c85ca079b25130486))
* **control-api:** verify signed service credentials ([585777d](https://github.com/0xPlayerOne/control-plane/commit/585777d32f7c8f44c90053236175e35b21c1eef5))
* **database:** persist context packages ([30e3f81](https://github.com/0xPlayerOne/control-plane/commit/30e3f81527de595ad2235fcd5cfa46f5a80d149b))
* **database:** persist execution plans ([233895c](https://github.com/0xPlayerOne/control-plane/commit/233895c96091701cf8d1dd89480a5ee4ec5198b2))
* **database:** persist project state ([659fc9b](https://github.com/0xPlayerOne/control-plane/commit/659fc9b20883267ab9f971c21b9ecfdcce144037))
* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))
* **infra:** codify Railway project ([#245](https://github.com/0xPlayerOne/control-plane/issues/245)) ([1944f4e](https://github.com/0xPlayerOne/control-plane/commit/1944f4e1d1cdaaef98d2a43762ff1e9395a397bc))
* **infra:** pin durable Restate runtime ([#241](https://github.com/0xPlayerOne/control-plane/issues/241)) ([adfe83e](https://github.com/0xPlayerOne/control-plane/commit/adfe83e48feb033f318282ad52d4016c11dfbc91))
* **infrastructure:** migrate cloud deployment baseline to Railway ([b4d71ff](https://github.com/0xPlayerOne/control-plane/commit/b4d71ffb6de76ad9bf97775d5de3d387c54325c9))
* **infrastructure:** wire managed cloud dependencies ([#221](https://github.com/0xPlayerOne/control-plane/issues/221)) ([ff809b0](https://github.com/0xPlayerOne/control-plane/commit/ff809b0445f29fec2c47ce19745b9092ec8fca38))
* **operations:** centralize managed cloud policy defaults ([#225](https://github.com/0xPlayerOne/control-plane/issues/225)) ([096b17a](https://github.com/0xPlayerOne/control-plane/commit/096b17ab9921784ce6cf4ced34d5f82d0f08c961))
* **storage:** add Cloudflare R2 ObjectStore ([#239](https://github.com/0xPlayerOne/control-plane/issues/239)) ([3b259ed](https://github.com/0xPlayerOne/control-plane/commit/3b259ed0bbff16177208b45639ab37fc91c6b06c))
* **workflow-worker:** add cloud certification runtime ([c47e830](https://github.com/0xPlayerOne/control-plane/commit/c47e8309a8ea71342d8dda0cc79c91d9b400b20d))
* **workflow-worker:** persist cloud execution lifecycle ([79b9bfe](https://github.com/0xPlayerOne/control-plane/commit/79b9bfe203a91193c2457c3e3357f6bc100090fd))
* **workflows:** migrate managed cloud runtime to Restate ([#220](https://github.com/0xPlayerOne/control-plane/issues/220)) ([99c85ee](https://github.com/0xPlayerOne/control-plane/commit/99c85ee71c382de6f597a7c08b79f9068ba7a5fb))


### Bug Fixes

* **bootstrap:** enforce managed cloud startup configuration ([#233](https://github.com/0xPlayerOne/control-plane/issues/233)) ([d186b3a](https://github.com/0xPlayerOne/control-plane/commit/d186b3afa9072d9124168dfc3e15f41dd129a066))
* **ci:** emit required gate contexts ([0bf1389](https://github.com/0xPlayerOne/control-plane/commit/0bf1389dd0e4f59302946f60c521db5ee9de1e08))
* **config:** consume Railway deployment metadata ([#237](https://github.com/0xPlayerOne/control-plane/issues/237)) ([dd6079b](https://github.com/0xPlayerOne/control-plane/commit/dd6079be7c2d660e2b15faf8b1b8bdb66ea1c0fa))
* **context:** complete deterministic provider ranking ([#229](https://github.com/0xPlayerOne/control-plane/issues/229)) ([528a48d](https://github.com/0xPlayerOne/control-plane/commit/528a48d34eff1099cadba521ba1638d0c581167b))
* **infra:** secure Restate service boundary ([#247](https://github.com/0xPlayerOne/control-plane/issues/247)) ([667eb58](https://github.com/0xPlayerOne/control-plane/commit/667eb58e95886eca5327367ca083f90c13fd5ff2))
* **infrastructure:** make Railway builds dependency-aware ([#227](https://github.com/0xPlayerOne/control-plane/issues/227)) ([54930d0](https://github.com/0xPlayerOne/control-plane/commit/54930d0d81d88932ebe18c780e812486216ed237))
* **operations:** apply cloud policy defaults at boundaries ([#231](https://github.com/0xPlayerOne/control-plane/issues/231)) ([d95ac2f](https://github.com/0xPlayerOne/control-plane/commit/d95ac2f030a1f791676845b7e15e75d6edcc24e4))


### Documentation

* reconcile Railway/Neon/R2/Restate and portable deployment architecture ([a024316](https://github.com/0xPlayerOne/control-plane/commit/a02431649b0ba446466ce47e0ec24a430731cce7))


### Maintenance

* **infra:** shrink Railway cloud topology ([8acf62a](https://github.com/0xPlayerOne/control-plane/commit/8acf62aef616f520b82b1204c2edc47464198720))
* **infra:** shrink Railway Cloud topology ([#243](https://github.com/0xPlayerOne/control-plane/issues/243)) ([8acf62a](https://github.com/0xPlayerOne/control-plane/commit/8acf62aef616f520b82b1204c2edc47464198720))
* promote M9 staging closeout ([f669880](https://github.com/0xPlayerOne/control-plane/commit/f669880d22087cd0dbe8cd1dbe0471a40bb31a11))
* **toolchain:** update to Bun 1.4 ([#199](https://github.com/0xPlayerOne/control-plane/issues/199)) ([e1af2ba](https://github.com/0xPlayerOne/control-plane/commit/e1af2ba1845b2d01649b6ba27cf5b87e7106999f))

## [1.6.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.5.0...workspace-v1.6.0) (2026-08-25)


### Features

* **orchestration:** add durable delegated executions ([#182](https://github.com/0xPlayerOne/control-plane/issues/182)) ([a060e43](https://github.com/0xPlayerOne/control-plane/commit/a060e4374f85dcbb50c2c4be9de1d71c28858839))
* **orchestration:** add LangGraph adapter ([#178](https://github.com/0xPlayerOne/control-plane/issues/178)) ([0335026](https://github.com/0xPlayerOne/control-plane/commit/03350264cdb1a1f46ab7e0c33b2e05b055e7342f))
* **orchestration:** coordinate parallel delegation ([#183](https://github.com/0xPlayerOne/control-plane/issues/183)) ([21e383b](https://github.com/0xPlayerOne/control-plane/commit/21e383ba2492cbd92f72c96adcc1f5ab89c4a2d7))
* **orchestration:** persist versioned graph checkpoints ([#180](https://github.com/0xPlayerOne/control-plane/issues/180)) ([f1f0100](https://github.com/0xPlayerOne/control-plane/commit/f1f0100ab7f8632f405858c86c0aeb0e19941f85))
* **workflows:** bridge Temporal graph segments ([#181](https://github.com/0xPlayerOne/control-plane/issues/181)) ([c590671](https://github.com/0xPlayerOne/control-plane/commit/c590671e5b3cde696e3fc2a2e5d39b4210b55206))


### Tests

* **orchestration:** add M8 acceptance suite ([#184](https://github.com/0xPlayerOne/control-plane/issues/184)) ([4c984a5](https://github.com/0xPlayerOne/control-plane/commit/4c984a5f97d424f122868d1609e7d3556218d4ac))

## [1.5.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.4.0...workspace-v1.5.0) (2026-08-25)


### Features

* **context:** add Cortana-compatible adapter ([#176](https://github.com/0xPlayerOne/control-plane/issues/176)) ([27409c1](https://github.com/0xPlayerOne/control-plane/commit/27409c1b80fdfa45dd644b797f4449e2942e8aef))
* **context:** add optional provider framework ([#175](https://github.com/0xPlayerOne/control-plane/issues/175)) ([efa12ce](https://github.com/0xPlayerOne/control-plane/commit/efa12ce6cb43796809e2df58bf3c04fcb024a53a))
* **credentials:** add scoped credential vault ([#169](https://github.com/0xPlayerOne/control-plane/issues/169)) ([1e613a8](https://github.com/0xPlayerOne/control-plane/commit/1e613a8860f3f133ee66971300d278f03bbf30e0))
* **memory:** add approved provider writeback ([#177](https://github.com/0xPlayerOne/control-plane/issues/177)) ([001a545](https://github.com/0xPlayerOne/control-plane/commit/001a545acb3335599307e510c92429e7cb7bf498))
* **models:** add deterministic routing ([#171](https://github.com/0xPlayerOne/control-plane/issues/171)) ([8488549](https://github.com/0xPlayerOne/control-plane/commit/84885491de46ba990cff8e8a5ebaf0bb70c68c33))
* **models:** add managed model gateway ([#170](https://github.com/0xPlayerOne/control-plane/issues/170)) ([b73fce3](https://github.com/0xPlayerOne/control-plane/commit/b73fce3f48bceaf18ea8e08d2bf17eda152aeabd))
* **policy:** add Cedar decision point ([#168](https://github.com/0xPlayerOne/control-plane/issues/168)) ([5198c9b](https://github.com/0xPlayerOne/control-plane/commit/5198c9b62363edaa4ce7399ebfe14890778e640b))
* **sandbox:** add isolated execution provider ([#172](https://github.com/0xPlayerOne/control-plane/issues/172)) ([25d27db](https://github.com/0xPlayerOne/control-plane/commit/25d27db878f76d8184beb275e533cd84a83a0894))
* **tools:** add canonical tool registry ([#164](https://github.com/0xPlayerOne/control-plane/issues/164)) ([3d4e162](https://github.com/0xPlayerOne/control-plane/commit/3d4e162b2f85769374f011f91c200e6d36d90fd1))
* **tools:** add MCP adapter ([#167](https://github.com/0xPlayerOne/control-plane/issues/167)) ([2f71a95](https://github.com/0xPlayerOne/control-plane/commit/2f71a951bb936d6f2ed3397352e1afedc29d7c03))
* **tools:** enforce durable tool execution policy ([#166](https://github.com/0xPlayerOne/control-plane/issues/166)) ([b11ff94](https://github.com/0xPlayerOne/control-plane/commit/b11ff941e1067dfc0515bda7f509160a561966f4))
* **usage:** add authoritative usage ledger ([#173](https://github.com/0xPlayerOne/control-plane/issues/173)) ([851eda4](https://github.com/0xPlayerOne/control-plane/commit/851eda4d809a0bd8f6c451c316e830e2db5e87a1))


### Tests

* **m7:** add managed capabilities acceptance ([#174](https://github.com/0xPlayerOne/control-plane/issues/174)) ([613bf40](https://github.com/0xPlayerOne/control-plane/commit/613bf40252ebfbf29f53dee1f0b2b86fc0327d17))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.3.1...workspace-v1.4.0) (2026-08-25)


### Features

* **acp:** add protocol-normalizing runtime adapter ([#159](https://github.com/0xPlayerOne/control-plane/issues/159)) ([2d7a249](https://github.com/0xPlayerOne/control-plane/commit/2d7a24901b406e3e88a81567d82230adc268f08e)), closes [#47](https://github.com/0xPlayerOne/control-plane/issues/47)
* **acp:** execute local runtimes through gateway ([#161](https://github.com/0xPlayerOne/control-plane/issues/161)) ([8225703](https://github.com/0xPlayerOne/control-plane/commit/8225703921364ced213a9c2d2cfb7fc2680178d9)), closes [#49](https://github.com/0xPlayerOne/control-plane/issues/49)
* **acp:** manage external session references ([#160](https://github.com/0xPlayerOne/control-plane/issues/160)) ([46ecc7b](https://github.com/0xPlayerOne/control-plane/commit/46ecc7bbb46e8b20943b1688c72d37bdf2d05ae4)), closes [#48](https://github.com/0xPlayerOne/control-plane/issues/48)
* **runtime:** add hosted managed Pi worker ([#158](https://github.com/0xPlayerOne/control-plane/issues/158)) ([39e3943](https://github.com/0xPlayerOne/control-plane/commit/39e39438dcc489b665a388cb918ee843bf2cd8bb))
* **runtime:** add managed Pi adapter ([#155](https://github.com/0xPlayerOne/control-plane/issues/155)) ([60b30e2](https://github.com/0xPlayerOne/control-plane/commit/60b30e29dc88568fa89297807953c7370f41895e))
* **runtime:** certify adapter compatibility ([#162](https://github.com/0xPlayerOne/control-plane/issues/162)) ([14403fd](https://github.com/0xPlayerOne/control-plane/commit/14403fdaa37a40d61f6e6bc7cd9e5a4f72de29bc)), closes [#50](https://github.com/0xPlayerOne/control-plane/issues/50)
* **runtime:** execute managed Pi through gateway ([#157](https://github.com/0xPlayerOne/control-plane/issues/157)) ([c705a8d](https://github.com/0xPlayerOne/control-plane/commit/c705a8da0d7e35720fbd522f3057eba1c67711be))


### Tests

* **runtime:** add cross-adapter acceptance ([#163](https://github.com/0xPlayerOne/control-plane/issues/163)) ([59a6eaa](https://github.com/0xPlayerOne/control-plane/commit/59a6eaa40f96c2a81d0ebe07fb3df4fa4ba17daf)), closes [#51](https://github.com/0xPlayerOne/control-plane/issues/51)

## [1.3.1](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.3.0...workspace-v1.3.1) (2026-08-25)


### Bug Fixes

* **gateway:** reject frames after channel revocation ([#147](https://github.com/0xPlayerOne/control-plane/issues/147)) ([1c9ce81](https://github.com/0xPlayerOne/control-plane/commit/1c9ce8155313196e47f3925fbdcda622475cf026))
* **runtime-gateway:** fail closed without production server ([#154](https://github.com/0xPlayerOne/control-plane/issues/154)) ([e6309d7](https://github.com/0xPlayerOne/control-plane/commit/e6309d76a262fae79ee388aebdb22632dd7fdbe6))
* **runtime-gateway:** reject privileged selector aliases ([#149](https://github.com/0xPlayerOne/control-plane/issues/149)) ([cb524e5](https://github.com/0xPlayerOne/control-plane/commit/cb524e5870798da8de0bd89cd95a3ae89cb59a23))
* **runtime-gateway:** require explicit reconnect recovery ([#150](https://github.com/0xPlayerOne/control-plane/issues/150)) ([1072dd9](https://github.com/0xPlayerOne/control-plane/commit/1072dd9f991d5d9693e7d4475cc9471cf0e42136))


### CI

* **code-foundry:** adopt reversible billing guards ([#152](https://github.com/0xPlayerOne/control-plane/issues/152)) ([1eccc21](https://github.com/0xPlayerOne/control-plane/commit/1eccc219b3c03eb12e10a73ff18c65100adc9019))


### Maintenance

* **runtime-gateway:** unify event context types ([#153](https://github.com/0xPlayerOne/control-plane/issues/153)) ([a012e71](https://github.com/0xPlayerOne/control-plane/commit/a012e7156c88354156745dc6fcdb983091c33346))
* **typescript:** strengthen compiler checks ([#151](https://github.com/0xPlayerOne/control-plane/issues/151)) ([b58dfba](https://github.com/0xPlayerOne/control-plane/commit/b58dfba7d2aa6f4eaf783d89cb8899eb6cffc636))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.2.1...workspace-v1.3.0) (2026-08-25)


### Features

* **gateway:** authenticate runtime node channels ([#137](https://github.com/0xPlayerOne/control-plane/issues/137)) ([ddb04b8](https://github.com/0xPlayerOne/control-plane/commit/ddb04b883ddcfaf84fe3b2521118113c267b55aa))
* **gateway:** define runtime node protocol ([#135](https://github.com/0xPlayerOne/control-plane/issues/135)) ([13a008a](https://github.com/0xPlayerOne/control-plane/commit/13a008a6e18e8c1916cf1be1e82a3032c6ac7f6f))
* **gateway:** ingest normalized runtime events ([#140](https://github.com/0xPlayerOne/control-plane/issues/140)) ([7542146](https://github.com/0xPlayerOne/control-plane/commit/7542146f8f84fc72061c17d4fc4bc7ec435ddc76))
* **gateway:** manage scalable websocket channels ([#138](https://github.com/0xPlayerOne/control-plane/issues/138)) ([02a5d48](https://github.com/0xPlayerOne/control-plane/commit/02a5d48b7982097448dddda79d07a3bc6e799e89))
* **gateway:** persist runtime command delivery ([#139](https://github.com/0xPlayerOne/control-plane/issues/139)) ([1874f27](https://github.com/0xPlayerOne/control-plane/commit/1874f27edbd925b7ba5f9f74d26cc53719758f8b))
* **gateway:** reconcile reconnect command state ([#142](https://github.com/0xPlayerOne/control-plane/issues/142)) ([3f897aa](https://github.com/0xPlayerOne/control-plane/commit/3f897aa0b72c5b5e1930342aab7079bf8a12dbae))
* **gateway:** synchronize runtime inventory health ([#141](https://github.com/0xPlayerOne/control-plane/issues/141)) ([656b580](https://github.com/0xPlayerOne/control-plane/commit/656b580e58986b460b10d109cdeed78ba620307f))


### Bug Fixes

* **test:** honor integration timeout budget ([#144](https://github.com/0xPlayerOne/control-plane/issues/144)) ([7b8cd53](https://github.com/0xPlayerOne/control-plane/commit/7b8cd5322149fea79a9c12bd41c8f596576faac9))
* **test:** serialize integration projects ([#146](https://github.com/0xPlayerOne/control-plane/issues/146)) ([b5028c1](https://github.com/0xPlayerOne/control-plane/commit/b5028c107d1e026c98b688c4524abbe9ccbc0d87))


### Documentation

* **test:** document M1-M5 acceptance ([#145](https://github.com/0xPlayerOne/control-plane/issues/145)) ([c43b3bb](https://github.com/0xPlayerOne/control-plane/commit/c43b3bb9334209c81aa911646f589c0d3a2dada4))


### Tests

* **runtime-gateway:** add M5 acceptance suite ([#143](https://github.com/0xPlayerOne/control-plane/issues/143)) ([1784dfc](https://github.com/0xPlayerOne/control-plane/commit/1784dfc6a4339d0292dc438be23ec5cedd86a76e))

## [1.2.1](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.2.0...workspace-v1.2.1) (2026-08-24)


### Bug Fixes

* **api:** wire runtime discovery at startup ([#134](https://github.com/0xPlayerOne/control-plane/issues/134)) ([997cb29](https://github.com/0xPlayerOne/control-plane/commit/997cb297add20461a6fa90852da935783192fbeb))
* **runtime:** report expired session discovery snapshots ([#133](https://github.com/0xPlayerOne/control-plane/issues/133)) ([cd8834f](https://github.com/0xPlayerOne/control-plane/commit/cd8834fbe98ae5deef501f05e2d9b3c669df1e9b))
* **runtime:** require negotiated capability verification ([#131](https://github.com/0xPlayerOne/control-plane/issues/131)) ([af0423f](https://github.com/0xPlayerOne/control-plane/commit/af0423f87810e7dd9bc0a11fa00836e3fbce9575))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.1.0...workspace-v1.2.0) (2026-08-24)


### Features

* **runtime:** define adapter contract and conformance harness ([#116](https://github.com/0xPlayerOne/control-plane/issues/116)) ([434f688](https://github.com/0xPlayerOne/control-plane/commit/434f6888c9c886c39eab6bb057d0285ecc56f7bd))
* **runtime:** evaluate runtime eligibility deterministically ([#120](https://github.com/0xPlayerOne/control-plane/issues/120)) ([840b9b5](https://github.com/0xPlayerOne/control-plane/commit/840b9b58ea400be3d41388218cc2adbad20202a8))
* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/0xPlayerOne/control-plane/issues/123)) ([cf43141](https://github.com/0xPlayerOne/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))
* **runtime:** ingest health and capability freshness ([#119](https://github.com/0xPlayerOne/control-plane/issues/119)) ([d47445b](https://github.com/0xPlayerOne/control-plane/commit/d47445bbeb0e88e1e65db8cafdff150061b2ca84))
* **runtime:** persist external session references ([#122](https://github.com/0xPlayerOne/control-plane/issues/122)) ([1ef146c](https://github.com/0xPlayerOne/control-plane/commit/1ef146c02b46021b9a13a232ce1b612f608077c7))
* **runtime:** persist runtime connection inventory ([#118](https://github.com/0xPlayerOne/control-plane/issues/118)) ([20fdb11](https://github.com/0xPlayerOne/control-plane/commit/20fdb11db89e75607785734d55057e648c664aac))
* **runtime:** route eligible runtimes deterministically ([#121](https://github.com/0xPlayerOne/control-plane/issues/121)) ([9f7a0fd](https://github.com/0xPlayerOne/control-plane/commit/9f7a0fd74e179dd592d9727ae49bc222b99251d8))


### Bug Fixes

* **test:** stabilize parallel Postgres suites ([#130](https://github.com/0xPlayerOne/control-plane/issues/130)) ([9a0f106](https://github.com/0xPlayerOne/control-plane/commit/9a0f10637c7422e39740c662b70ed0163ef263c6))


### Tests

* **ci:** parallelize Code Foundry suites ([#129](https://github.com/0xPlayerOne/control-plane/issues/129)) ([9836a52](https://github.com/0xPlayerOne/control-plane/commit/9836a5200ce905bb5774bbc7edf7b1ab322d4b90))
* **runtime:** cover runtime fabric acceptance ([#124](https://github.com/0xPlayerOne/control-plane/issues/124)) ([accf185](https://github.com/0xPlayerOne/control-plane/commit/accf185640c1e1e393bc07eb9c9af782e5e221fa))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/workspace-v1.0.0...workspace-v1.1.0) (2026-08-24)


### Features

* **events:** add durable execution event outbox ([#110](https://github.com/0xPlayerOne/control-plane/issues/110)) ([2d6355d](https://github.com/0xPlayerOne/control-plane/commit/2d6355d4a9b82b38ae2c3ba40055eab78a7401f8)), closes [#22](https://github.com/0xPlayerOne/control-plane/issues/22)
* **events:** deliver execution events to Agent HQ ([#113](https://github.com/0xPlayerOne/control-plane/issues/113)) ([641ac7a](https://github.com/0xPlayerOne/control-plane/commit/641ac7aef9bcb05a6fbfc0d5c732dce0233b0b55))
* **execution:** add durable execution lifecycle ([#105](https://github.com/0xPlayerOne/control-plane/issues/105)) ([4429d4d](https://github.com/0xPlayerOne/control-plane/commit/4429d4da040e785ef566db8136d5b21c42ac30d7)), closes [#20](https://github.com/0xPlayerOne/control-plane/issues/20)
* **execution:** add durable interaction lifecycle ([#112](https://github.com/0xPlayerOne/control-plane/issues/112)) ([83a3bb6](https://github.com/0xPlayerOne/control-plane/commit/83a3bb6fcec8969bcb78dfa4bbbc167a5fe767c0))
* **execution:** add idempotent command acceptance ([#109](https://github.com/0xPlayerOne/control-plane/issues/109)) ([bd096fb](https://github.com/0xPlayerOne/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/0xPlayerOne/control-plane/issues/21)
* **reliability:** reconcile unknown execution outcomes ([#114](https://github.com/0xPlayerOne/control-plane/issues/114)) ([2cbd07b](https://github.com/0xPlayerOne/control-plane/commit/2cbd07b8747925560a90fa3eaad057d0ffbdf4ee))
* **workflows:** add Temporal execution lifecycle ([#111](https://github.com/0xPlayerOne/control-plane/issues/111)) ([f70ad1e](https://github.com/0xPlayerOne/control-plane/commit/f70ad1e06c5c87fb349909188ca01cfc4c212aef)), closes [#23](https://github.com/0xPlayerOne/control-plane/issues/23)


### Tests

* **acceptance:** prove durable execution recovery ([#115](https://github.com/0xPlayerOne/control-plane/issues/115)) ([2201902](https://github.com/0xPlayerOne/control-plane/commit/2201902b6a3fdc085462f8481ae473a88454ef6c))


### Maintenance

* **github:** apply live label metadata once ([#107](https://github.com/0xPlayerOne/control-plane/issues/107)) ([3f1a2ad](https://github.com/0xPlayerOne/control-plane/commit/3f1a2ad948450ba7614ad08b757ad023cf996fd4))
* **github:** remove one-time label workflow ([#108](https://github.com/0xPlayerOne/control-plane/issues/108)) ([6e5937b](https://github.com/0xPlayerOne/control-plane/commit/6e5937b2c5e6fd7c557876b2832cf02c2fcd043d))

## 1.0.0 (2026-08-24)


### Features

* add immutable AgentProfile and Skill versions ([#90](https://github.com/0xPlayerOne/control-plane/issues/90)) ([f09d6fd](https://github.com/0xPlayerOne/control-plane/commit/f09d6fded7abad1429b805d7c1248bf4627ca8ae))
* add PostgreSQL persistence foundation ([2fdfd88](https://github.com/0xPlayerOne/control-plane/commit/2fdfd8856ab7b1d4d7e592e1d998a0e8314f11b9)), closes [#3](https://github.com/0xPlayerOne/control-plane/issues/3)
* add revisioned project state ([#93](https://github.com/0xPlayerOne/control-plane/issues/93)) ([4f3e7ac](https://github.com/0xPlayerOne/control-plane/commit/4f3e7ac04b18eed869fbc3d02f8506b676014e62))
* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* add telemetry foundation ([#80](https://github.com/0xPlayerOne/control-plane/issues/80)) ([6ca188e](https://github.com/0xPlayerOne/control-plane/commit/6ca188e1f26cd32cfd05dea005e067f8eff27938))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* compile immutable execution plans ([#95](https://github.com/0xPlayerOne/control-plane/issues/95)) ([88346ef](https://github.com/0xPlayerOne/control-plane/commit/88346efea272bb1ab9441f14a3114869d8e9340b))
* compile reproducible context packages ([#94](https://github.com/0xPlayerOne/control-plane/issues/94)) ([488f5c5](https://github.com/0xPlayerOne/control-plane/commit/488f5c5556fc0a59f7793c01e1be3c3f3ae679d2))
* **contracts:** define Agent HQ service boundary ([#88](https://github.com/0xPlayerOne/control-plane/issues/88)) ([e18468a](https://github.com/0xPlayerOne/control-plane/commit/e18468af35141207971df1b6cd9a8490077da710))
* define execution constraint contracts ([#92](https://github.com/0xPlayerOne/control-plane/issues/92)) ([6945676](https://github.com/0xPlayerOne/control-plane/commit/694567609c5b6b9123622446e528c5298d34e4ad))
* define runtime capability compatibility model ([#91](https://github.com/0xPlayerOne/control-plane/issues/91)) ([6fa2a77](https://github.com/0xPlayerOne/control-plane/commit/6fa2a777692aae1277a5823cb7f52bf56c7df973))
* enforce Agent HQ service authentication ([#89](https://github.com/0xPlayerOne/control-plane/issues/89)) ([09c0554](https://github.com/0xPlayerOne/control-plane/commit/09c0554f832e4bb40229ed0366274ea2b78721fe))
* **foundation:** add M1 acceptance baseline ([#87](https://github.com/0xPlayerOne/control-plane/issues/87)) ([bba3f0e](https://github.com/0xPlayerOne/control-plane/commit/bba3f0eea1fb77a20c51e468d34bf629a67fdfe2))
* **infra:** define deployment and infrastructure baseline ([#85](https://github.com/0xPlayerOne/control-plane/issues/85)) ([813a309](https://github.com/0xPlayerOne/control-plane/commit/813a309de78e269dfccc2d592934c1a3139d564e))
* publish typed Control Plane SDK and contract harness ([#97](https://github.com/0xPlayerOne/control-plane/issues/97)) ([5bcea7c](https://github.com/0xPlayerOne/control-plane/commit/5bcea7c729b8dc79b58dd3bb713251b61adffade))
* scaffold NestJS Fastify Control API ([e99cdde](https://github.com/0xPlayerOne/control-plane/commit/e99cdded89f5c3dad6d6ff0b6d45c06a8b2bee73)), closes [#4](https://github.com/0xPlayerOne/control-plane/issues/4)


### Bug Fixes

* **release:** track every workspace ([#104](https://github.com/0xPlayerOne/control-plane/issues/104)) ([85f2b6d](https://github.com/0xPlayerOne/control-plane/commit/85f2b6dc1d356024d809807c264ed910cb487efc))
* **release:** validate coordinated package versions ([#98](https://github.com/0xPlayerOne/control-plane/issues/98)) ([7771a6f](https://github.com/0xPlayerOne/control-plane/commit/7771a6ff2f577ca2eb1b4de957bea7fed9b31ec0))
* scope bare `bun test` to the repository test root ([3d66f77](https://github.com/0xPlayerOne/control-plane/commit/3d66f77d7ca58d6037e07e43d14317725ada0510))
* **sdk:** accept release-managed package versions ([#99](https://github.com/0xPlayerOne/control-plane/issues/99)) ([27f86e3](https://github.com/0xPlayerOne/control-plane/commit/27f86e3643683eec626f3a337c76dd7061d94055))


### Documentation

* add runtime compatibility data and architecture sources ([#86](https://github.com/0xPlayerOne/control-plane/issues/86)) ([7b88459](https://github.com/0xPlayerOne/control-plane/commit/7b884597ef79c0ed55283c05a9c88e060da886e5))


### Tests

* add shared foundation harness ([#79](https://github.com/0xPlayerOne/control-plane/issues/79)) ([96053ed](https://github.com/0xPlayerOne/control-plane/commit/96053ed7e9a38a3f391168b12906a7165f335fb3))
* prove M2 core-domain acceptance ([#103](https://github.com/0xPlayerOne/control-plane/issues/103)) ([eada793](https://github.com/0xPlayerOne/control-plane/commit/eada793f49e91ba4179e126b592bcb40b77ee88b)), closes [#19](https://github.com/0xPlayerOne/control-plane/issues/19)


### CI

* establish Code Foundry quality gates ([#81](https://github.com/0xPlayerOne/control-plane/issues/81)) ([5d34dc1](https://github.com/0xPlayerOne/control-plane/commit/5d34dc1fad081ba9c437343fff175e87b86faac6))
* restore public repository security gates ([#83](https://github.com/0xPlayerOne/control-plane/issues/83)) ([a8102ea](https://github.com/0xPlayerOne/control-plane/commit/a8102ea30efd3d6336eb1fd815789103033aac5a))
* upgrade Code Foundry to v0.37.4 ([#96](https://github.com/0xPlayerOne/control-plane/issues/96)) ([0d656e3](https://github.com/0xPlayerOne/control-plane/commit/0d656e3ec9d8922a347c2a2b70399bae8332d24d))
* upgrade Code Foundry to v0.37.5 ([#100](https://github.com/0xPlayerOne/control-plane/issues/100)) ([f9a1d99](https://github.com/0xPlayerOne/control-plane/commit/f9a1d990688c544ba393f9f237906ea03ab2e472))


### Maintenance

* **deps:** apply compatible npm dependency updates ([#102](https://github.com/0xPlayerOne/control-plane/issues/102)) ([eaf3e48](https://github.com/0xPlayerOne/control-plane/commit/eaf3e48f5fe6c85c79e6d83874df8af24f079f5c))
* **deps:** bump actions/setup-node from 5.0.0 to 7.0.0 in the github-actions group ([#101](https://github.com/0xPlayerOne/control-plane/issues/101)) ([a7d6c9d](https://github.com/0xPlayerOne/control-plane/commit/a7d6c9d7f05ec596a6c2c058f377f149a4c51df4))
* **deps:** bump actions/setup-node in the github-actions group ([a7d6c9d](https://github.com/0xPlayerOne/control-plane/commit/a7d6c9d7f05ec596a6c2c058f377f149a4c51df4))
* install repo-local agent skills and ignore other harness dirs ([4f51dfb](https://github.com/0xPlayerOne/control-plane/commit/4f51dfbdca2113b439d4bb977e14695251220e99))
* migrate skills to .agents/skills/ for team sharing ([#78](https://github.com/0xPlayerOne/control-plane/issues/78)) ([4c8906f](https://github.com/0xPlayerOne/control-plane/commit/4c8906f337e2ae44f9898df04b16289d642c6954))
* split AGENTS.md into progressive disclosure structure ([90917d6](https://github.com/0xPlayerOne/control-plane/commit/90917d61700c30e58198286a585aba6d2d94a199))
