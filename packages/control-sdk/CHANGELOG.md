# Changelog

## [1.7.1](https://github.com/adea-ai/control-plane/compare/sdk-v1.7.0...sdk-v1.7.1) (2026-09-21)


### Maintenance

* **m612:** canonical-ordering guard, superseded-gap exemption, marker coverage ([#625](https://github.com/adea-ai/control-plane/issues/625)) ([64df3c5](https://github.com/adea-ai/control-plane/commit/64df3c5bd207683fc8ce3d5b829541126c71b269))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/sdk-v1.6.2...sdk-v1.7.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.6.2](https://github.com/adea-ai/control-plane/compare/sdk-v1.6.1...sdk-v1.6.2) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.6.1](https://github.com/adea-ai/control-plane/compare/sdk-v1.6.0...sdk-v1.6.1) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/sdk-v1.5.0...sdk-v1.6.0) (2026-09-09)


### Features

* add marketplace agent plugin plans ([0441004](https://github.com/adea-ai/control-plane/commit/0441004f34fd4b61b4fa63acd261bdbab9432856))
* add marketplace Agent Plugins plans ([#440](https://github.com/adea-ai/control-plane/issues/440)) ([0441004](https://github.com/adea-ai/control-plane/commit/0441004f34fd4b61b4fa63acd261bdbab9432856))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/sdk-v1.4.0...sdk-v1.5.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/sdk-v1.3.3...sdk-v1.4.0) (2026-09-08)


### Features

* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/adea-ai/control-plane/issues/222)) ([e6aa0f1](https://github.com/adea-ai/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))
* **execution:** add idempotent command acceptance ([#109](https://github.com/adea-ai/control-plane/issues/109)) ([bd096fb](https://github.com/adea-ai/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/adea-ai/control-plane/issues/21)
* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))
* **packages:** publish six stable packages under [@adea-ai](https://github.com/adea-ai) on npm ([#398](https://github.com/adea-ai/control-plane/issues/398)) ([973a8df](https://github.com/adea-ai/control-plane/commit/973a8df4eb4957f1b9ffa92760aff6584cc6605d))
* publish typed Control Plane SDK and contract harness ([#97](https://github.com/adea-ai/control-plane/issues/97)) ([5bcea7c](https://github.com/adea-ai/control-plane/commit/5bcea7c729b8dc79b58dd3bb713251b61adffade))
* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/adea-ai/control-plane/issues/123)) ([cf43141](https://github.com/adea-ai/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))


### Bug Fixes

* **publish:** rewrite workspace specifiers in staged dist and republish SDKs ([6f96903](https://github.com/adea-ai/control-plane/commit/6f96903e65d2b721eb31433742a0e5797ef42d24))
* **publish:** rewrite workspace specifiers in staged dist; republish SDKs ([#402](https://github.com/adea-ai/control-plane/issues/402)) ([6f96903](https://github.com/adea-ai/control-plane/commit/6f96903e65d2b721eb31433742a0e5797ef42d24))
* **sdk:** accept release-managed package versions ([#99](https://github.com/adea-ai/control-plane/issues/99)) ([27f86e3](https://github.com/adea-ai/control-plane/commit/27f86e3643683eec626f3a337c76dd7061d94055))


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))
* release main ([eb6133e](https://github.com/adea-ai/control-plane/commit/eb6133e578f756da1e933bd52c6e8bf3902ad13c))
* release main ([c3df837](https://github.com/adea-ai/control-plane/commit/c3df8370762b4068a010e0de985134db4ffadee9))
* release main ([5e8dcfa](https://github.com/adea-ai/control-plane/commit/5e8dcfa7f75eb7a1e65410f659011e3232ab1a1f))
* release main ([ab2525e](https://github.com/adea-ai/control-plane/commit/ab2525e87de56d705177537adadfed6b0d281ded))
* release main ([a4e38b8](https://github.com/adea-ai/control-plane/commit/a4e38b81a80fe297274e2a60ac0a0ea93ea52701))
* release main ([d081764](https://github.com/adea-ai/control-plane/commit/d081764aae773a9430e883b675253fbba3d69603))
* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.3.2](https://github.com/adea-ai/control-plane/compare/sdk-v1.3.1...sdk-v1.3.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/sdk-v1.3.0...sdk-v1.3.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/sdk-v1.2.0...sdk-v1.3.0) (2026-08-29)


### Features

* **contracts:** freeze managed cloud public boundary ([#222](https://github.com/0xPlayerOne/control-plane/issues/222)) ([e6aa0f1](https://github.com/0xPlayerOne/control-plane/commit/e6aa0f11122eee37aeb2c3116c3a646fc7753333))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/sdk-v1.1.0...sdk-v1.2.0) (2026-08-24)


### Features

* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/0xPlayerOne/control-plane/issues/123)) ([cf43141](https://github.com/0xPlayerOne/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/sdk-v1.0.0...sdk-v1.1.0) (2026-08-24)


### Features

* **execution:** add idempotent command acceptance ([#109](https://github.com/0xPlayerOne/control-plane/issues/109)) ([bd096fb](https://github.com/0xPlayerOne/control-plane/commit/bd096fb54f49110654a3853a268179a69f60e5c2)), closes [#21](https://github.com/0xPlayerOne/control-plane/issues/21)

## 1.0.0 (2026-08-24)


### Features

* publish typed Control Plane SDK and contract harness ([#97](https://github.com/0xPlayerOne/control-plane/issues/97)) ([5bcea7c](https://github.com/0xPlayerOne/control-plane/commit/5bcea7c729b8dc79b58dd3bb713251b61adffade))


### Bug Fixes

* **sdk:** accept release-managed package versions ([#99](https://github.com/0xPlayerOne/control-plane/issues/99)) ([27f86e3](https://github.com/0xPlayerOne/control-plane/commit/27f86e3643683eec626f3a337c76dd7061d94055))
