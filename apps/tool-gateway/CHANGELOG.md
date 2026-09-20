# Changelog

## [1.3.2](https://github.com/adea-ai/control-plane/compare/tool-gateway-v1.3.1...tool-gateway-v1.3.2) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/tool-gateway-v1.3.0...tool-gateway-v1.3.1) (2026-09-20)


### Bug Fixes

* **contracts:** locale-independent canonicalJsonStringify + canonical-JSON divergence audit ([#611](https://github.com/adea-ai/control-plane/issues/611)) ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))


### Maintenance

* **contracts:** add canonicalJsonStringify and consolidate canonical-JSON digests ([549645b](https://github.com/adea-ai/control-plane/commit/549645b1e8295541d22f9d345b482f148a396560))

## [1.3.0](https://github.com/adea-ai/control-plane/compare/tool-gateway-v1.2.5...tool-gateway-v1.3.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.2.5](https://github.com/adea-ai/control-plane/compare/tool-gateway-v1.2.4...tool-gateway-v1.2.5) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.2.4](https://github.com/adea-ai/control-plane/compare/tool-gateway-v1.2.3...tool-gateway-v1.2.4) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.2.3](https://github.com/adea-ai/control-plane/compare/tool-gateway-v1.2.2...tool-gateway-v1.2.3) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.2.2](https://github.com/adea-ai/control-plane/compare/tool-gateway-v1.2.1...tool-gateway-v1.2.2) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.2.1](https://github.com/0xPlayerOne/control-plane/compare/tool-gateway-v1.2.0...tool-gateway-v1.2.1) (2026-08-29)


### Bug Fixes

* **operations:** apply cloud policy defaults at boundaries ([#231](https://github.com/0xPlayerOne/control-plane/issues/231)) ([d95ac2f](https://github.com/0xPlayerOne/control-plane/commit/d95ac2f030a1f791676845b7e15e75d6edcc24e4))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/tool-gateway-v1.1.0...tool-gateway-v1.2.0) (2026-08-25)


### Features

* **policy:** add Cedar decision point ([#168](https://github.com/0xPlayerOne/control-plane/issues/168)) ([5198c9b](https://github.com/0xPlayerOne/control-plane/commit/5198c9b62363edaa4ce7399ebfe14890778e640b))
* **tools:** add canonical tool registry ([#164](https://github.com/0xPlayerOne/control-plane/issues/164)) ([3d4e162](https://github.com/0xPlayerOne/control-plane/commit/3d4e162b2f85769374f011f91c200e6d36d90fd1))
* **tools:** add MCP adapter ([#167](https://github.com/0xPlayerOne/control-plane/issues/167)) ([2f71a95](https://github.com/0xPlayerOne/control-plane/commit/2f71a951bb936d6f2ed3397352e1afedc29d7c03))
* **tools:** enforce durable tool execution policy ([#166](https://github.com/0xPlayerOne/control-plane/issues/166)) ([b11ff94](https://github.com/0xPlayerOne/control-plane/commit/b11ff941e1067dfc0515bda7f509160a561966f4))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/tool-gateway-v1.0.0...tool-gateway-v1.1.0) (2026-08-25)


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
