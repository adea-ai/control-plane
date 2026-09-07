# Changelog

## [1.5.2](https://github.com/adea-ai/control-plane/compare/contracts-v1.5.1...contracts-v1.5.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.5.1](https://github.com/adea-ai/control-plane/compare/contracts-v1.5.0...contracts-v1.5.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.5.0](https://github.com/0xPlayerOne/control-plane/compare/contracts-v1.4.0...contracts-v1.5.0) (2026-08-29)


### Features

* **context:** finalize deterministic provider selection ([#224](https://github.com/0xPlayerOne/control-plane/issues/224)) ([b0c17d5](https://github.com/0xPlayerOne/control-plane/commit/b0c17d5185b12137c12c8f0a251ebb196b6a9350))
* **context:** finalize provider selection and cache policy ([b0c17d5](https://github.com/0xPlayerOne/control-plane/commit/b0c17d5185b12137c12c8f0a251ebb196b6a9350))
* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/0xPlayerOne/control-plane/issues/222)) ([e6aa0f1](https://github.com/0xPlayerOne/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))


### Bug Fixes

* **context:** complete deterministic provider ranking ([#229](https://github.com/0xPlayerOne/control-plane/issues/229)) ([528a48d](https://github.com/0xPlayerOne/control-plane/commit/528a48d34eff1099cadba521ba1638d0c581167b))

## [1.4.0](https://github.com/0xPlayerOne/control-plane/compare/contracts-v1.3.0...contracts-v1.4.0) (2026-08-25)


### Features

* **orchestration:** add durable delegated executions ([#182](https://github.com/0xPlayerOne/control-plane/issues/182)) ([a060e43](https://github.com/0xPlayerOne/control-plane/commit/a060e4374f85dcbb50c2c4be9de1d71c28858839))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/contracts-v1.2.0...contracts-v1.3.0) (2026-08-25)


### Features

* **context:** add Cortana-compatible adapter ([#176](https://github.com/0xPlayerOne/control-plane/issues/176)) ([27409c1](https://github.com/0xPlayerOne/control-plane/commit/27409c1b80fdfa45dd644b797f4449e2942e8aef))
* **context:** add optional provider framework ([#175](https://github.com/0xPlayerOne/control-plane/issues/175)) ([efa12ce](https://github.com/0xPlayerOne/control-plane/commit/efa12ce6cb43796809e2df58bf3c04fcb024a53a))
* **credentials:** add scoped credential vault ([#169](https://github.com/0xPlayerOne/control-plane/issues/169)) ([1e613a8](https://github.com/0xPlayerOne/control-plane/commit/1e613a8860f3f133ee66971300d278f03bbf30e0))
* **memory:** add approved provider writeback ([#177](https://github.com/0xPlayerOne/control-plane/issues/177)) ([001a545](https://github.com/0xPlayerOne/control-plane/commit/001a545acb3335599307e510c92429e7cb7bf498))
* **models:** add managed model gateway ([#170](https://github.com/0xPlayerOne/control-plane/issues/170)) ([b73fce3](https://github.com/0xPlayerOne/control-plane/commit/b73fce3f48bceaf18ea8e08d2bf17eda152aeabd))
* **tools:** add canonical tool registry ([#164](https://github.com/0xPlayerOne/control-plane/issues/164)) ([3d4e162](https://github.com/0xPlayerOne/control-plane/commit/3d4e162b2f85769374f011f91c200e6d36d90fd1))
* **tools:** enforce durable tool execution policy ([#166](https://github.com/0xPlayerOne/control-plane/issues/166)) ([b11ff94](https://github.com/0xPlayerOne/control-plane/commit/b11ff941e1067dfc0515bda7f509160a561966f4))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/contracts-v1.1.0...contracts-v1.2.0) (2026-08-24)


### Features

* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/0xPlayerOne/control-plane/issues/123)) ([cf43141](https://github.com/0xPlayerOne/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/contracts-v1.0.0...contracts-v1.1.0) (2026-08-24)


### Features

* **events:** deliver execution events to Agent HQ ([#113](https://github.com/0xPlayerOne/control-plane/issues/113)) ([641ac7a](https://github.com/0xPlayerOne/control-plane/commit/641ac7aef9bcb05a6fbfc0d5c732dce0233b0b55))
* **execution:** add idempotent command acceptance ([#109](https://github.com/0xPlayerOne/control-plane/issues/109)) ([bd096fb](https://github.com/0xPlayerOne/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/0xPlayerOne/control-plane/issues/21)

## 1.0.0 (2026-08-24)


### Features

* add immutable AgentProfile and Skill versions ([#90](https://github.com/0xPlayerOne/control-plane/issues/90)) ([f09d6fd](https://github.com/0xPlayerOne/control-plane/commit/f09d6fded7abad1429b805d7c1248bf4627ca8ae))
* add revisioned project state ([#93](https://github.com/0xPlayerOne/control-plane/issues/93)) ([4f3e7ac](https://github.com/0xPlayerOne/control-plane/commit/4f3e7ac04b18eed869fbc3d02f8506b676014e62))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* compile immutable execution plans ([#95](https://github.com/0xPlayerOne/control-plane/issues/95)) ([88346ef](https://github.com/0xPlayerOne/control-plane/commit/88346efea272bb1ab9441f14a3114869d8e9340b))
* compile reproducible context packages ([#94](https://github.com/0xPlayerOne/control-plane/issues/94)) ([488f5c5](https://github.com/0xPlayerOne/control-plane/commit/488f5c5556fc0a59f7793c01e1be3c3f3ae679d2))
* **contracts:** define Agent HQ service boundary ([#88](https://github.com/0xPlayerOne/control-plane/issues/88)) ([e18468a](https://github.com/0xPlayerOne/control-plane/commit/e18468af35141207971df1b6cd9a8490077da710))
* define runtime capability compatibility model ([#91](https://github.com/0xPlayerOne/control-plane/issues/91)) ([6fa2a77](https://github.com/0xPlayerOne/control-plane/commit/6fa2a777692aae1277a5823cb7f52bf56c7df973))
* enforce Agent HQ service authentication ([#89](https://github.com/0xPlayerOne/control-plane/issues/89)) ([09c0554](https://github.com/0xPlayerOne/control-plane/commit/09c0554f832e4bb40229ed0366274ea2b78721fe))
* publish typed Control Plane SDK and contract harness ([#97](https://github.com/0xPlayerOne/control-plane/issues/97)) ([5bcea7c](https://github.com/0xPlayerOne/control-plane/commit/5bcea7c729b8dc79b58dd3bb713251b61adffade))


### Bug Fixes

* **release:** validate coordinated package versions ([#98](https://github.com/0xPlayerOne/control-plane/issues/98)) ([7771a6f](https://github.com/0xPlayerOne/control-plane/commit/7771a6ff2f577ca2eb1b4de957bea7fed9b31ec0))


### Tests

* prove M2 core-domain acceptance ([#103](https://github.com/0xPlayerOne/control-plane/issues/103)) ([eada793](https://github.com/0xPlayerOne/control-plane/commit/eada793f49e91ba4179e126b592bcb40b77ee88b)), closes [#19](https://github.com/0xPlayerOne/control-plane/issues/19)
